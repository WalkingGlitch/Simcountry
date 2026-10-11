// ==UserScript==
// @name         Simcountry Profession Toolbox
// @namespace    https://simcountry.com/userscripts/profession-toolbox
// @version      1.5.0
// @description  Prefill profession changes, merge employment tabs, and expose a conflict-free export for a later graph scraper.
// @author       TheWalkingGlitch
// @match        https://*.simcountry.com/cgi-bin/*
// @match        http://*.simcountry.com/cgi-bin/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      simcountry.com
// @connect      *.simcountry.com
// @run-at       document-end
// ==/UserScript==

/*
  INSTALL: Tampermonkey → New script → paste → save. Open Change profession (cgiw?cexchworkers).

  This script only activates on the change-profession form. It fetches the other labor tabs
  itself. Injected nodes are marked data-sc-prof-ui="1". A later graph/CSV companion should
  ignore those nodes and read unsafeWindow.scProfessionExport (or the sc-profession-export
  event). Do not reuse the storage key scProfessionPresets.v1.

  Export shape: { format:1, page, fetchedAt, rows, tabs:{id:{label,url,ok,rows,graphs,tables}} }
  Graph entries keep the page onclick/href so the companion can open them. This script never
  clicks graph links.
*/

(function () {
  'use strict';

  const PRESET_KEY = 'scProfessionPresets.v1';
  const ARM_KEY = 'scProfessionOneClick.v1';
  const PENDING_KEY = 'scProfessionPending.v1';
  const ALLOC_KEY = 'scProfessionAlloc.v1';
  const MONTH_KEY = 'scProfessionMonthCap.v1';
  const STEP_AMOUNTS = [1000, 5000, 10000, 25000, 100000];
  const INIT_FLAG = 'data-sc-prof-init';
  const TABS = [
    { id: 'coccupation', label: 'Employment and Income' },
    { id: 'cunemployed', label: 'Unemployed Workers' },
    { id: 'cretired', label: 'Retired Workers' },
    { id: 'cdisabled', label: 'Disabled Workers' },
    { id: 'cexchcontracts', label: 'Exchange Professionals' }
  ];
  const FROM_VALUES = {
    'low level managers': 'LowLevelManager',
    'medium level managers': 'MediumLevelManager',
    'high level managers': 'HighLevelManager',
    'teachers': 'Teacher',
    'university teachers': 'UnivTeacher',
    'nurses': 'Nurse',
    'doctors': 'Doctor',
    'senior doctors': 'SeniorDoctor',
    'high tech engineers': 'HighTechEngineer',
    'high tech seniors': 'HighTechSenior'
  };
  const TO_VALUES = {
    'low level workers': 'LowLevelWorker',
    'medium level workers': 'MediumLevelWorker',
    'high level workers': 'HighLevelWorker'
  };
  const GROUPS = {
    workers: ['low level workers', 'medium level workers', 'high level workers'],
    managers: ['low level managers', 'medium level managers', 'high level managers'],
    education: ['teachers', 'university teachers'],
    health: ['nurses', 'doctors', 'senior doctors'],
    hightech: ['high tech engineers', 'high tech seniors']
  };

  function pageWin() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.document) return unsafeWindow;
    } catch (e) { /* isolated */ }
    return window;
  }

  function gmGet(key, fallback) {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (e) { /* */ }
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e2) { return fallback; }
  }

  function gmSet(key, val) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; } } catch (e) { /* */ }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e2) { /* */ }
  }

  function gmStyle(css) {
    try { if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; } } catch (e) { /* */ }
    const s = document.createElement('style');
    s.textContent = css;
    document.documentElement.appendChild(s);
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function num(text) {
    const s = String(text == null ? '' : text).replace(/,/g, '').replace(/[^\d.-]/g, '');
    if (!s || s === '-' || s === '.') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(n) {
    if (n == null || !Number.isFinite(n)) return '–';
    return Math.round(n).toLocaleString();
  }

  function confirmForm() {
    const method = document.querySelector('form input[name="SN_METHOD"][value="cexchworkers"]');
    if (!method || !method.form) return null;
    const form = method.form;
    const confirmed = form.querySelector('input[name="miActionConfirmed"]');
    if (!confirmed || String(confirmed.value) !== '1') return null;
    if (form.querySelector('select[name="miProfessionFrom"]')) return null;
    return form;
  }

  function changePageUrl() {
    return new URL('cgiw?cexchworkers', location.href).href;
  }

  function loadPending() {
    const raw = gmGet(PENDING_KEY, null);
    if (!raw || !raw.at || Date.now() - raw.at > 120000) return null;
    return raw;
  }

  function savePending(entry) {
    gmSet(PENDING_KEY, entry);
  }

  function isProfessionPage() {
    const method = document.querySelector('input[name="SN_METHOD"]');
    const bag = (location.href || '') + ' ' + (method ? method.value : '') + ' ' + (document.title || '');
    return /cexchworkers/i.test(bag) && !!document.querySelector('select[name="miProfessionFrom"]');
  }

  function formOf() {
    return document.querySelector('form input[name="SN_METHOD"][value="cexchworkers"]')
      ? document.querySelector('form input[name="SN_METHOD"][value="cexchworkers"]').form
      : document.querySelector('select[name="miProfessionFrom"]') && document.querySelector('select[name="miProfessionFrom"]').form;
  }

  gmStyle(`
    #sc-prof-root {
      position: fixed; top: 72px; right: 12px; z-index: 2147483000;
      width: 280px; background: #f4f6fb; color: #1b1f2a;
      border: 1px solid #7a88b0; box-shadow: 0 8px 24px rgba(0,0,0,.18);
      font: 12px/1.35 Arial, sans-serif; border-radius: 4px;
    }
    #sc-prof-root.sc-prof-collapsed { width: 188px; }
    #sc-prof-root.sc-prof-collapsed .sc-prof-body { display: none; }
    #sc-prof-drag {
      background: #2c3f73; color: #fff; padding: 5px 8px; cursor: move;
      display: flex; justify-content: space-between; align-items: center;
      border-radius: 3px 3px 0 0; font-weight: bold;
    }
    #sc-prof-root .sc-prof-body { padding: 7px 8px 8px; max-height: calc(100vh - 120px); overflow: auto; }
    #sc-prof-root label { display: block; margin: 3px 0 2px; color: #31406a; }
    #sc-prof-root select, #sc-prof-root input[type="text"], #sc-prof-root input[type="number"] {
      width: 100%; box-sizing: border-box; font-size: 12px; padding: 2px 4px;
    }
    #sc-prof-root .sc-prof-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    #sc-prof-root button.sc-btn {
      background: #2c3f73; color: #fff; border: 0; padding: 3px 6px; cursor: pointer; font-size: 11px;
    }
    #sc-prof-root button.sc-btn.ok { background: #2a7a3a; }
    #sc-prof-root button.sc-btn.alt { background: #4b5d99; }
    #sc-prof-root .sc-prof-section { border-top: 1px solid #c5cbe0; margin-top: 6px; padding-top: 5px; }
    #sc-prof-root .sc-prof-section h4 { font-size: 11px; color: #1d4f9c; margin: 0 0 3px; }
    #sc-prof-root .sc-prof-arm { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
    #sc-prof-root .sc-prof-arm input { width: auto; }
    td.sc-prof-armed { box-shadow: inset 3px 0 0 #2a7a3a; }
    #sc-prof-page[data-sc-prof-ui="1"] { margin: 8px 0 14px; }
    #sc-prof-page button.sc-prof-act {
      font: 12px Arial, sans-serif; margin: 0 6px 6px 0; padding: 3px 8px; cursor: pointer;
    }
    td.sc-prof-num { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    td.sc-prof-num:hover { background: #d4e4ff !important; }
    tr.sc-prof-short td { background: #fde8e4 !important; }
    tr.sc-prof-surplus td { background: #e7f6ea !important; }
    #sc-prof-page .sc-prof-help { color: #445; font: 11px Arial, sans-serif; margin: 0 0 8px; }
  `);

  function loadPresets() {
    const raw = gmGet(PRESET_KEY, null);
    const custom = raw && Array.isArray(raw.custom) ? raw.custom : [];
    return builtins().concat(custom);
  }

  function saveCustom(list) {
    gmSet(PRESET_KEY, { format: 1, custom: list });
  }

  function builtins() {
    return [
      { id: 'cover-gap', builtin: true, name: 'Cover largest worker gap', fromMode: 'largest-surplus', fromGroup: 'any', toMode: 'most-needed', qtyMode: 'gap' },
      { id: 'managers', builtin: true, name: 'Surplus managers to workers', fromMode: 'largest-surplus', fromGroup: 'managers', toMode: 'most-needed', qtyMode: 'available' },
      { id: 'hightech', builtin: true, name: 'High-tech surplus to workers', fromMode: 'largest-surplus', fromGroup: 'hightech', toMode: 'most-needed', qtyMode: 'available' },
      { id: 'education', builtin: true, name: 'Education surplus to workers', fromMode: 'largest-surplus', fromGroup: 'education', toMode: 'most-needed', qtyMode: 'unemployed' },
      { id: 'health', builtin: true, name: 'Health surplus to workers', fromMode: 'largest-surplus', fromGroup: 'health', toMode: 'most-needed', qtyMode: 'unemployed' }
    ];
  }

  function parseTable(table) {
    const rows = Array.prototype.filter.call(table.rows || [], function (tr) {
      return tr.cells && tr.cells.length > 1 && !tr.querySelector('table');
    });
    if (rows.length < 2) return null;
    let header = null;
    let start = 0;
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      const text = norm(rows[i].textContent);
      if (/profession|worker|unemployed|salary|retired|disabled/.test(text)) {
        header = Array.prototype.map.call(rows[i].cells, function (cell) { return cell.textContent.replace(/\s+/g, ' ').trim(); });
        start = i + 1;
        break;
      }
    }
    if (!header) return null;
    const out = [];
    for (let r = start; r < rows.length; r++) {
      const cells = rows[r].cells;
      const name = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
      if (!name || /total|profession/i.test(name)) continue;
      const values = {};
      const graphs = [];
      for (let c = 0; c < cells.length; c++) {
        const key = header[c] || ('col' + c);
        const value = num(cells[c].textContent);
        if (c > 0 && value != null) values[key] = value;
        const link = cells[c].querySelector('a[onclick*="graph"], a[href*="w3graph"]');
        if (link) graphs.push({ column: key, onclick: link.getAttribute('onclick') || '', href: link.getAttribute('href') || '' });
      }
      out.push({ name: name, key: norm(name), values: values, graphs: graphs });
    }
    return out.length ? { headers: header, rows: out } : null;
  }

  function parseDocument(doc) {
    const tables = [];
    const graphs = [];
    Array.prototype.forEach.call(doc.querySelectorAll('a[onclick*="graph_window"], a[href*="w3graph"]'), function (a) {
      graphs.push({ text: (a.textContent || '').replace(/\s+/g, ' ').trim(), onclick: a.getAttribute('onclick') || '', href: a.getAttribute('href') || '' });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('table'), function (table) {
      if (table.querySelector('table') && table.rows.length < 3) return;
      const parsed = parseTable(table);
      if (parsed) tables.push(parsed);
    });
    return { tables: tables, graphs: graphs };
  }

  function localRows() {
    const anchor = document.querySelector('a[name="current_situation"]');
    const scope = anchor && anchor.parentNode ? anchor.parentNode : document;
    const tables = scope.querySelectorAll('table.group, table');
    for (let i = 0; i < tables.length; i++) {
      if (tables[i].closest && tables[i].closest('#sc-prof-page, #sc-prof-root')) continue;
      const parsed = parseTable(tables[i]);
      if (parsed) return parsed.rows;
    }
    return [];
  }

  function valueOf(row, re) {
    const values = row.values || {};
    const keys = Object.keys(values);
    for (let i = 0; i < keys.length; i++) {
      if (re.test(keys[i])) return values[keys[i]];
    }
    return null;
  }

  function enrich(row) {
    const unemployed = valueOf(row, /^unemployed$/i);
    const employed = valueOf(row, /^employed$/i);
    const total = valueOf(row, /^total$/i);
    const reserved = valueOf(row, /reserved/i);
    const needed = valueOf(row, /needed/i);
    const available = unemployed == null ? null : Math.max(0, unemployed - (reserved || 0));
    const gap = needed == null || available == null ? null : needed - available;
    const afterFull = available == null ? null : available - (needed || 0);
    const availPct = needed > 0 && available != null ? (available / needed) * 100 : null;
    return Object.assign({}, row, {
      unemployed: unemployed,
      employed: employed,
      total: total,
      reserved: reserved,
      needed: needed,
      available: available,
      afterFull: afterFull,
      availPct: availPct,
      gap: gap,
      group: groupOf(row.key),
      fromValue: FROM_VALUES[row.key] || '',
      toValue: TO_VALUES[row.key] || ''
    });
  }

  function groupOf(key) {
    const names = Object.keys(GROUPS);
    for (let i = 0; i < names.length; i++) {
      if (GROUPS[names[i]].indexOf(key) !== -1) return names[i];
    }
    return 'other';
  }

  function mostNeeded(rows) {
    const workers = rows.filter(function (r) { return r.toValue; });
    let best = null;
    workers.forEach(function (r) {
      const score = r.gap == null ? -Infinity : r.gap;
      if (!best || score > best.gap) best = r;
    });
    return best;
  }

  function loadAlloc() {
    const raw = gmGet(ALLOC_KEY, {});
    return {
      matchWorkerPct: !!(raw && raw.matchWorkerPct),
      workerPct: raw && raw.workerPct === 'lowest' ? 'lowest' : 'highest'
    };
  }

  function saveAlloc(next) {
    gmSet(ALLOC_KEY, next);
  }

  function workerAvailabilityFloor(rows) {
    const settings = loadAlloc();
    const pcts = rows.filter(function (r) {
      return r.toValue && r.availPct != null && Number.isFinite(r.availPct);
    }).map(function (r) { return r.availPct; });
    if (!pcts.length) return null;
    return settings.workerPct === 'lowest' ? Math.min.apply(null, pcts) : Math.max.apply(null, pcts);
  }

  function sourceRemainder(row, rows) {
    const available = row.available || 0;
    const settings = loadAlloc();
    if (!settings.matchWorkerPct) {
      if (row.needed == null) return available;
      return Math.max(0, available - row.needed);
    }
    const floor = workerAvailabilityFloor(rows);
    if (floor == null || !(row.needed > 0)) return available;
    const keep = row.needed * (floor / 100);
    return Math.max(0, Math.min(available, available - keep));
  }

  function surplusSource(rows, group) {
    const pool = rows.filter(function (r) {
      if (!r.fromValue) return false;
      if (group && group !== 'any' && r.group !== group) return false;
      return sourceRemainder(r, rows) > 0;
    });
    pool.sort(function (a, b) { return sourceRemainder(b, rows) - sourceRemainder(a, rows); });
    return pool[0] || null;
  }

  function tabUrl(method) {
    return new URL('cgiw?' + method, location.href).href;
  }

  function fetchText(url) {
    return new Promise(function (resolve) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        resolve({ ok: false, error: 'GM_xmlhttpRequest unavailable' });
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        anonymous: false,
        onload: function (res) { resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, text: res.responseText || '' }); },
        onerror: function () { resolve({ ok: false, error: 'request failed' }); },
        ontimeout: function () { resolve({ ok: false, error: 'timeout' }); }
      });
    });
  }

  function mergeFetched(base, tabs) {
    const byName = {};
    base.forEach(function (row) { byName[row.key] = Object.assign({}, row, { extra: {} }); });
    tabs.forEach(function (tab) {
      (tab.rows || []).forEach(function (row) {
        if (!byName[row.key]) byName[row.key] = enrich(row);
        if (!byName[row.key].extra) byName[row.key].extra = {};
        Object.keys(row.values || {}).forEach(function (col) {
          byName[row.key].extra[tab.id + ': ' + col] = row.values[col];
        });
      });
    });
    return Object.keys(byName).map(function (k) { return byName[k]; });
  }

  function publishExport(model) {
    const payload = {
      format: 1,
      page: 'cexchworkers',
      fetchedAt: new Date().toISOString(),
      rows: model.rows,
      tabs: model.tabs
    };
    try { pageWin().scProfessionExport = payload; } catch (e) { /* sandbox */ }
    document.documentElement.setAttribute('data-sc-prof-export', '1');
    document.dispatchEvent(new CustomEvent('sc-profession-export', { detail: payload }));
  }

  function monthQuota() {
    const text = document.body ? document.body.textContent : '';
    const capMatch = text.match(/change the profession of\s+([\d,]+)\s+workers each month/i);
    const usedMatch = text.match(/(?:already changed|have changed) the profession of\s+([\d,]+)\s+workers/i);
    const cap = capMatch ? num(capMatch[1]) : gmGet(MONTH_KEY, 700000);
    const used = usedMatch ? num(usedMatch[1]) : 0;
    if (capMatch && cap != null) gmSet(MONTH_KEY, cap);
    const left = Math.max(0, (cap || 0) - (used || 0));
    return { cap: cap || 0, used: used || 0, left: left };
  }

  function capQty(qty) {
    const left = monthQuota().left;
    const n = Math.max(0, Math.round(num(qty) || 0));
    return Math.min(n, left);
  }

  function setField(form, name, value) {
    const el = form.querySelector('[name="' + name + '"]');
    if (!el) return;
    el.value = value == null ? '' : String(value);
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
  }

  function prefill(form, qty, fromValue, toValue) {
    if (qty != null) setField(form, 'miQuantity', capQty(qty));
    if (fromValue) setField(form, 'miProfessionFrom', fromValue);
    if (toValue) setField(form, 'miProfessionTo', toValue);
    const note = document.getElementById('sc-prof-choice');
    if (note) {
      note.textContent = 'Quantity ' + fmt(num(form.miQuantity && form.miQuantity.value)) +
        ' · from ' + ((form.miProfessionFrom && form.miProfessionFrom.value) || 'unset') +
        ' · to ' + ((form.miProfessionTo && form.miProfessionTo.value) || 'unset');
    }
  }

  function applyPreset(preset, rows, form) {
    const target = preset.toMode === 'fixed'
      ? rows.filter(function (r) { return r.toValue === preset.to; })[0]
      : mostNeeded(rows);
    const source = preset.fromMode === 'fixed'
      ? rows.filter(function (r) { return r.fromValue === preset.from; })[0]
      : surplusSource(rows, preset.fromGroup || 'any');
    if (!source || !target) return 'No matching source or worker shortage for this preset.';
    const cap = sourceRemainder(source, rows);
    let qty = 0;
    if (preset.qtyMode === 'fixed') qty = num(preset.qty) || 0;
    else if (preset.qtyMode === 'percent') qty = Math.round((source.unemployed || 0) * ((num(preset.percent) || 0) / 100));
    else if (preset.qtyMode === 'unemployed') qty = source.unemployed || 0;
    else if (preset.qtyMode === 'gap') qty = Math.max(0, target.gap || 0);
    else qty = cap;
    if (preset.qtyMode !== 'fixed' && target.gap != null) qty = Math.min(qty, Math.max(0, target.gap));
    qty = Math.min(qty, cap);
    if (qty <= 0) return 'No remainder left in ' + source.name + ' after keeping positions filled.';
    prefill(form, qty, source.fromValue, target.toValue);
    return 'Applied “' + preset.name + '”: ' + fmt(qty) + ' ' + source.name + ' → ' + target.name + ' (cap ' + fmt(cap) + ').';
  }

  function extractTabBody(doc) {
    const root = doc.querySelector('#pw_contents') || doc.querySelector('.desktop_tabmargin') || doc.body;
    const clone = root.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('script, style, #sc-prof-page, #sc-prof-root, .desktop_tabgroup'), function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    return clone.innerHTML;
  }

  function changeBlock() {
    const anchor = document.querySelector('a[name="change_profession"]');
    const form = formOf();
    if (!anchor || !form) return null;
    const header = anchor.nextElementSibling && /change profession/i.test(anchor.nextElementSibling.textContent || '')
      ? anchor.nextElementSibling
      : null;
    return { anchor: anchor, header: header, form: form };
  }

  function hoistChangeProfession() {
    const block = changeBlock();
    const margin = document.querySelector('.desktop_tabmargin') || document.querySelector('#pw_contents');
    if (!block || !margin) return;
    const holder = margin.querySelector('div[align="left"]') || margin;
    holder.insertBefore(block.form, holder.firstChild);
    if (block.header) holder.insertBefore(block.header, block.form);
    holder.insertBefore(block.anchor, block.header || block.form);
  }

  function mountAfterForm() {
    const form = formOf();
    let host = document.getElementById('sc-prof-page');
    if (!host) {
      host = document.createElement('div');
      host.id = 'sc-prof-page';
      host.setAttribute('data-sc-prof-ui', '1');
    }
    if (form && form.parentNode) form.parentNode.insertBefore(host, form.nextSibling);
    return host;
  }
  function renderPage(model, form) {
    hoistChangeProfession();
    installFormActions(form, model);
    const wrap = mountAfterForm();
    wrap.innerHTML = '';
    const choice = document.createElement('p');
    choice.id = 'sc-prof-choice';
    choice.className = 'paragraphtext applettext';
    const quota = monthQuota();
    choice.textContent = 'Changed this month: ' + fmt(quota.used) + ' of ' + fmt(quota.cap) + '. Remaining: ' + fmt(quota.left) + '. Step buttons add to the quantity and stop at the monthly remainder.';
    wrap.appendChild(choice);
    const head = document.createElement('div');
    head.className = 'paragrapheader applettext';
    head.textContent = 'Combined employment picture';
    wrap.appendChild(head);
    wrap.appendChild(buildTable(model));
    model.tabs.forEach(function (tab) {
      const h = document.createElement('div');
      h.className = 'paragrapheader applettext';
      h.textContent = tab.label;
      wrap.appendChild(h);
      const body = document.createElement('div');
      body.setAttribute('data-sc-prof-ui', '1');
      body.setAttribute('data-sc-prof-tab', tab.id);
      if (tab.html) body.innerHTML = tab.html;
      else {
        const note = document.createElement('p');
        note.className = 'paragraphtext applettext';
        note.textContent = tab.ok ? 'No content found on this tab.' : ('Could not load this tab' + (tab.error ? ': ' + tab.error : '.'));
        body.appendChild(note);
      }
      wrap.appendChild(body);
    });
    wrap.addEventListener('click', function (ev) {
      const cell = ev.target.closest ? ev.target.closest('td') : null;
      if (!cell || !wrap.contains(cell)) return;
      const value = num(cell.textContent);
      if (value == null) return;
      const tr = cell.parentNode;
      const name = tr && tr.cells && tr.cells[0] ? tr.cells[0].textContent : '';
      const row = model.rows.filter(function (r) { return r.key === norm(name); })[0];
      if (!row) return;
      clickNumber(model, form, row, value);
    });
  }

  function installFormActions(form, model) {
    if (!form) return;
    const existing = form.querySelector('#sc-prof-form-actions');
    if (existing) existing.parentNode.removeChild(existing);
    const bar = document.createElement('div');
    bar.id = 'sc-prof-form-actions';
    bar.setAttribute('data-sc-prof-ui', '1');
    function act(label, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deskbutton';
      b.style.margin = '4px';
      b.textContent = label;
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        fn();
      });
      bar.appendChild(b);
    }
    STEP_AMOUNTS.forEach(function (step) {
      act('+' + fmt(step), function () {
        const current = num(form.miQuantity && form.miQuantity.value) || 0;
        prefill(form, current + step, form.miProfessionFrom && form.miProfessionFrom.value, form.miProfessionTo && form.miProfessionTo.value);
        say('Quantity ' + fmt(num(form.miQuantity.value)) + '. Remaining this month: ' + fmt(monthQuota().left) + '.');
      });
    });
    act('Most needed', function () {
      const target = mostNeeded(model.rows);
      const source = surplusSource(model.rows, 'any');
      if (!target || !source) return;
      prefill(form, Math.min(sourceRemainder(source, model.rows), Math.max(0, target.gap || 0)), source.fromValue, target.toValue);
    });
    loadPresets().forEach(function (preset) {
      act(preset.name, function () {
        const msg = applyPreset(preset, model.rows, form);
        const status = document.getElementById('sc-prof-status');
        if (status) status.textContent = msg;
      });
    });
    const submit = form.querySelector('input[type="submit"]');
    if (submit && submit.parentNode) submit.parentNode.insertBefore(bar, submit);
    else form.appendChild(bar);
  }

  function visibleRows(model) {
    const root = document.getElementById('sc-prof-root');
    const q = root ? norm((root.querySelector('#sc-prof-search') || {}).value) : '';
    const group = root ? (root.querySelector('#sc-prof-group') || {}).value : 'any';
    const only = root ? (root.querySelector('#sc-prof-only') || {}).value : 'any';
    return model.rows.filter(function (r) {
      if (q && norm(r.name).indexOf(q) === -1) return false;
      if (group && group !== 'any' && r.group !== group) return false;
      if (only === 'short' && !(r.gap > 0)) return false;
      if (only === 'surplus' && !(r.available > 0 && r.fromValue)) return false;
      if (only === 'from' && !r.fromValue) return false;
      if (only === 'to' && !r.toValue) return false;
      return true;
    });
  }

  function sortRows(rows) {
    const root = document.getElementById('sc-prof-root');
    const key = root ? (root.querySelector('#sc-prof-sort') || {}).value : 'gap';
    const dir = root && (root.querySelector('#sc-prof-dir') || {}).value === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      const av = a[key];
      const bv = b[key];
      if (key === 'name') return dir * String(a.name).localeCompare(String(b.name));
      return dir * ((av || 0) - (bv || 0));
    });
  }

  function buildTable(model) {
    const table = document.createElement('table');
    table.className = 'group';
    table.setAttribute('data-sc-prof-ui', '1');
    table.cellSpacing = '0';
    table.cellPadding = '2';
    const headers = ['Profession', 'Unemployed', 'Employed', 'Total', 'Reserved', 'Needed', 'Available', 'Avail %', 'Gap'];
    const keys = ['name', 'unemployed', 'employed', 'total', 'reserved', 'needed', 'afterFull', 'availPct', 'gap'];
    const extraKeys = [];
    model.rows.forEach(function (r) {
      Object.keys(r.extra || {}).forEach(function (k) {
        if (extraKeys.indexOf(k) === -1) extraKeys.push(k);
      });
    });
    const hr = document.createElement('tr');
    headers.concat(extraKeys).forEach(function (label) {
      const th = document.createElement('th');
      th.className = 'datacolheader';
      th.textContent = label;
      hr.appendChild(th);
    });
    table.appendChild(hr);
    sortRows(visibleRows(model)).forEach(function (row) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-sc-prof-ui', '1');
      if (row.fromValue && armed(row.fromValue)) tr.classList.add('sc-prof-armed');
      else if (row.available > 0 && row.fromValue) tr.className = 'sc-prof-surplus';
      keys.concat(extraKeys).forEach(function (key, idx) {
        const td = document.createElement('td');
        td.className = 'data';
        const value = idx < keys.length ? row[key] : (row.extra || {})[key];
        if (key === 'name') {
          td.textContent = row.name;
          td.align = 'left';
        } else {
          td.textContent = key === 'availPct' && value != null ? Math.round(value) + '%' : fmt(value);
          td.align = 'right';
          td.classList.add('sc-prof-num');
          td.title = 'Prefill this number';
          td.addEventListener('click', function () {
            clickNumber(model, formOf(), row, value);
          });
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    return table;
  }

  function buildRawTable(parsed, tabId) {
    const table = document.createElement('table');
    table.className = 'group';
    table.setAttribute('data-sc-prof-ui', '1');
    table.setAttribute('data-sc-prof-tab', tabId);
    const hr = document.createElement('tr');
    parsed.headers.forEach(function (label) {
      const th = document.createElement('th');
      th.className = 'datacolheader';
      th.textContent = label || '';
      hr.appendChild(th);
    });
    table.appendChild(hr);
    parsed.rows.forEach(function (row) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-sc-prof-ui', '1');
      const td0 = document.createElement('td');
      td0.className = 'data';
      td0.textContent = row.name;
      tr.appendChild(td0);
      parsed.headers.slice(1).forEach(function (label) {
        const td = document.createElement('td');
        td.className = 'data';
        td.align = 'right';
        td.textContent = row.values[label] == null ? '' : fmt(row.values[label]);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    return table;
  }

  function loadArms() {
    const raw = gmGet(ARM_KEY, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  function saveArms(map) {
    gmSet(ARM_KEY, map);
  }

  function armed(fromValue) {
    return !!(fromValue && loadArms()[fromValue]);
  }

  function clickNumber(model, form, row, value) {
    if (!form || value == null || !row) return;
    const target = mostNeeded(model.rows);
    if (row.fromValue && armed(row.fromValue)) {
      if (!target || !target.toValue) {
        say('No worker type is short of its production need.');
        return;
      }
      const cap = sourceRemainder(row, model.rows);
      const qty = Math.min(value, cap);
      if (qty <= 0) {
        say(row.name + ' has no remainder after keeping positions filled.');
        return;
      }
      prefill(form, qty, row.fromValue, target.toValue);
      savePending({ step: 'confirm', from: row.fromValue, to: target.toValue, qty: Math.round(qty), at: Date.now() });
      say('Converting ' + fmt(qty) + ' ' + row.name + ' → ' + target.name + '.');
      form.submit();
      return;
    }
    if (row.fromValue) prefill(form, value, row.fromValue, target ? target.toValue : '');
    else if (row.toValue) {
      const source = surplusSource(model.rows, 'any');
      prefill(form, value, source ? source.fromValue : '', row.toValue);
    } else prefill(form, value, '', target ? target.toValue : '');
  }

  function wireOriginal(model) {
    const anchor = document.querySelector('a[name="current_situation"]');
    const table = anchor && anchor.parentNode ? anchor.parentNode.querySelector('table.group') : null;
    if (!table || table.getAttribute('data-sc-prof-wired')) return;
    table.setAttribute('data-sc-prof-wired', '1');
    table.addEventListener('click', function (ev) {
      const cell = ev.target.closest ? ev.target.closest('td') : null;
      if (!cell || !table.contains(cell)) return;
      const value = num(cell.textContent);
      if (value == null) return;
      const tr = cell.parentNode;
      const name = tr && tr.cells && tr.cells[0] ? tr.cells[0].textContent : '';
      const row = model.rows.filter(function (r) { return r.key === norm(name); })[0];
      if (!row) return;
      cell.classList.add('sc-prof-num');
      clickNumber(model, formOf(), row, value);
    });
  }

  function buildPanel(model) {
    const old = document.getElementById('sc-prof-root');
    if (old) old.parentNode.removeChild(old);
    const root = document.createElement('div');
    root.id = 'sc-prof-root';
    root.setAttribute('data-sc-prof-ui', '1');
    root.innerHTML =
      '<div id="sc-prof-drag"><span>Profession Toolbox</span><button type="button" id="sc-prof-collapse" class="sc-btn alt">Hide</button></div>' +
      '<div class="sc-prof-body">' +
        '<div class="sc-prof-section"><h4>View</h4>' +
          '<label>Search</label><input id="sc-prof-search" type="text" placeholder="Profession…">' +
          '<label>Group</label><select id="sc-prof-group"><option value="any">Any</option><option value="workers">Workers</option><option value="managers">Managers</option><option value="education">Education</option><option value="health">Health</option><option value="hightech">High tech</option></select>' +
          '<label>Show</label><select id="sc-prof-only"><option value="any">All rows</option><option value="short">Worker shortages</option><option value="surplus">Convertible surplus</option><option value="from">From professions</option><option value="to">To professions</option></select>' +
          '<label>Sort</label><select id="sc-prof-sort"><option value="gap">Gap</option><option value="afterFull">Available</option><option value="unemployed">Unemployed</option><option value="needed">Needed</option><option value="name">Name</option></select>' +
          '<select id="sc-prof-dir"><option value="desc">Descending</option><option value="asc">Ascending</option></select>' +
        '</div>' +
        '<div class="sc-prof-section"><h4>Presets</h4>' +
          '<select id="sc-prof-preset"></select>' +
          '<div class="sc-prof-actions"><button type="button" class="sc-btn ok" id="sc-prof-apply">Apply preset</button></div>' +
          '<label>New preset name</label><input id="sc-prof-newname" type="text" placeholder="Name…">' +
          '<label>From group</label><select id="sc-prof-pgroup"><option value="any">Any convertible</option><option value="managers">Managers</option><option value="education">Education</option><option value="health">Health</option><option value="hightech">High tech</option></select>' +
          '<label>Quantity</label><select id="sc-prof-pqty"><option value="gap">Target gap</option><option value="available">Source available</option><option value="unemployed">Source unemployed</option><option value="percent">Percent of unemployed</option><option value="fixed">Fixed number</option></select>' +
          '<input id="sc-prof-pamount" type="number" placeholder="Percent or fixed amount">' +
          '<div class="sc-prof-actions"><button type="button" class="sc-btn" id="sc-prof-save">Save preset</button><button type="button" class="sc-btn alt" id="sc-prof-delete">Delete custom</button></div>' +
        '</div>' +
        '<div class="sc-prof-section"><h4>Allocation</h4>' +
          '<label class="sc-prof-arm"><input id="sc-prof-matchpct" type="checkbox"> Match worker availability %</label>' +
          '<label>Floor</label><select id="sc-prof-pctfloor"><option value="highest">Highest worker availability</option><option value="lowest">Lowest worker availability</option></select>' +
          '<p class="sc-prof-help">Off: leave enough to fill this profession’s own 100% need. On: convert down to the chosen worker availability percentage. Availability can exceed 100%.</p>' +
        '</div>' +
        '<div class="sc-prof-section"><h4>One-click convert</h4>' +
          '<p class="sc-prof-help">Armed professions submit the clicked number into the worker type most in demand.</p>' +
          '<div id="sc-prof-arms"></div>' +
        '</div>' +
        '<div class="sc-prof-status" id="sc-prof-status">Loading other labor tabs…</div>' +
      '</div>';
    document.body.appendChild(root);
    fillPresetSelect(root);
    fillArmList(root);
    const alloc = loadAlloc();
    root.querySelector('#sc-prof-matchpct').checked = alloc.matchWorkerPct;
    root.querySelector('#sc-prof-pctfloor').value = alloc.workerPct;
    function storeAlloc() {
      saveAlloc({
        matchWorkerPct: root.querySelector('#sc-prof-matchpct').checked,
        workerPct: root.querySelector('#sc-prof-pctfloor').value
      });
      say(root.querySelector('#sc-prof-matchpct').checked
        ? 'Allocation floor set to the ' + root.querySelector('#sc-prof-pctfloor').value + ' worker availability.'
        : 'Allocation stops after each profession’s own positions are filled.');
      renderPage(model, formOf());
    }
    root.querySelector('#sc-prof-matchpct').addEventListener('change', storeAlloc);
    root.querySelector('#sc-prof-pctfloor').addEventListener('change', storeAlloc);
    root.querySelector('#sc-prof-collapse').addEventListener('click', function () {
      root.classList.toggle('sc-prof-collapsed');
    });
    ['#sc-prof-search', '#sc-prof-group', '#sc-prof-only', '#sc-prof-sort', '#sc-prof-dir'].forEach(function (sel) {
      root.querySelector(sel).addEventListener('input', function () { renderPage(model, formOf()); });
      root.querySelector(sel).addEventListener('change', function () { renderPage(model, formOf()); });
    });
    root.querySelector('#sc-prof-apply').addEventListener('click', function () {
      const id = root.querySelector('#sc-prof-preset').value;
      const preset = loadPresets().filter(function (p) { return p.id === id; })[0];
      const status = root.querySelector('#sc-prof-status');
      status.textContent = preset ? applyPreset(preset, model.rows, formOf()) : 'Choose a preset.';
    });
    root.querySelector('#sc-prof-save').addEventListener('click', function () {
      const name = root.querySelector('#sc-prof-newname').value.trim();
      if (!name) return;
      const custom = loadPresets().filter(function (p) { return !p.builtin; });
      custom.push({
        id: 'custom-' + Date.now(),
        name: name,
        fromMode: 'largest-surplus',
        fromGroup: root.querySelector('#sc-prof-pgroup').value,
        toMode: 'most-needed',
        qtyMode: root.querySelector('#sc-prof-pqty').value,
        percent: root.querySelector('#sc-prof-pamount').value,
        qty: root.querySelector('#sc-prof-pamount').value
      });
      saveCustom(custom);
      fillPresetSelect(root);
      renderPage(model, formOf());
      root.querySelector('#sc-prof-status').textContent = 'Saved preset “' + name + '”.';
    });
    root.querySelector('#sc-prof-delete').addEventListener('click', function () {
      const id = root.querySelector('#sc-prof-preset').value;
      saveCustom(loadPresets().filter(function (p) { return !p.builtin && p.id !== id; }));
      fillPresetSelect(root);
      renderPage(model, formOf());
    });
    makeDraggable(root, root.querySelector('#sc-prof-drag'));
  }

  function fillArmList(root) {
    const box = root.querySelector('#sc-prof-arms');
    if (!box) return;
    const arms = loadArms();
    box.innerHTML = '';
    Object.keys(FROM_VALUES).forEach(function (name) {
      const value = FROM_VALUES[name];
      const label = document.createElement('label');
      label.className = 'sc-prof-arm';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!arms[value];
      input.addEventListener('change', function () {
        const next = loadArms();
        next[value] = input.checked;
        saveArms(next);
        say((input.checked ? 'Armed ' : 'Disarmed ') + name + '.');
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(name));
      box.appendChild(label);
    });
  }

  function fillPresetSelect(root) {
    const sel = root.querySelector('#sc-prof-preset');
    const current = sel.value;
    sel.innerHTML = '';
    loadPresets().forEach(function (p) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.builtin ? '' : 'Custom: ') + p.name;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  function makeDraggable(box, handle) {
    let drag = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target.closest && ev.target.closest('button')) return;
      drag = true;
      sx = ev.clientX;
      sy = ev.clientY;
      const rect = box.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) {
      if (!drag) return;
      box.style.left = Math.max(0, ox + ev.clientX - sx) + 'px';
      box.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
      box.style.right = 'auto';
    });
    window.addEventListener('mouseup', function () { drag = false; });
  }

  function say(text) {
    const el = document.getElementById('sc-prof-status');
    if (el) el.textContent = text;
  }

  function finishOneClick() {
    const pending = loadPending();
    const confirm = confirmForm();
    if (confirm && pending && pending.step === 'confirm') {
      savePending({ step: 'return', at: Date.now() });
      const yes = confirm.querySelector('input[type="submit"], button[type="submit"]');
      if (yes) yes.click();
      else confirm.submit();
      return true;
    }
    if (pending && pending.step === 'return') {
      savePending(null);
      if (!isProfessionPage()) {
        location.replace(changePageUrl());
        return true;
      }
    }
    return false;
  }

  async function start() {
    if (finishOneClick()) return;
    if (!isProfessionPage()) return;
    if (document.documentElement.getAttribute(INIT_FLAG) === '1') return;
    document.documentElement.setAttribute(INIT_FLAG, '1');
    const form = formOf();
    const model = { rows: localRows().map(enrich), tabs: [] };
    buildPanel(model);
    renderPage(model, form);
    wireOriginal(model);
    publishExport(model);
    const fetched = [];
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i];
      say('Loading ' + tab.label + '…');
      const res = await fetchText(tabUrl(tab.id));
      const entry = { id: tab.id, label: tab.label, url: tabUrl(tab.id), ok: !!res.ok, rows: [], tables: [], graphs: [], html: '' };
      if (res.ok) {
        const doc = new DOMParser().parseFromString(res.text, 'text/html');
        const parsed = parseDocument(doc);
        entry.html = extractTabBody(doc);
        entry.graphs = parsed.graphs;
        entry.tables = parsed.tables;
        parsed.tables.forEach(function (table) {
          table.rows.forEach(function (row) {
            if (FROM_VALUES[row.key] || TO_VALUES[row.key] || groupOf(row.key) !== 'other') entry.rows.push(row);
          });
        });
      } else entry.error = res.error || ('HTTP ' + res.status);
      fetched.push(entry);
      model.tabs = fetched;
      model.rows = mergeFetched(localRows().map(enrich), fetched);
      renderPage(model, form);
      wireOriginal(model);
      publishExport(model);
    }
    const failed = fetched.filter(function (t) { return !t.ok; }).map(function (t) { return t.label; });
    say(failed.length ? ('Loaded with missing tabs: ' + failed.join(', ')) : 'Employment, unemployed, retired, disabled, and exchange tabs loaded.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
