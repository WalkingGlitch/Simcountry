// ==UserScript==
// @name         Simcountry Corporation Toolbox
// @namespace    https://simcountry.com/userscripts/corp-toolbox
// @version      2.4.1
// @description  Unified sort/filter/select/apply toolbox for Simcountry corporation list and strategy forms.
// @author       TheWalkingGlitch
// @match        https://*.simcountry.com/cgi-bin/*
// @match        http://*.simcountry.com/cgi-bin/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

/*
 *  INSTALL: Tampermonkey → New script → paste → save.
 *  Disable the older separate Salary Toolbox if both would run.
 *
 *  Pages:
 *    - ownedcompanies
 *    - statecmpsalaries
 *    - statecmptradestrat
 *    - Quality of Supplies
 *    - Profit / Cash / Debt
 *    - Offer / retract production
 *    - Production contracts
 *    - Retract material orders
 *    - Review / cancel corporation contracts (tradecorpcontracts)
 *    - other statecmp* corp tables with numeric fields
 *    Country/world trading pages belong in Simcountry Trading Toolbox.
 *
 *  Selection = checkbox left of the product icon.
 *  Sort/filter only hide/reorder live rows.
 *  Apply fills the form; save with the site button.
 */

(function () {
  'use strict';

  const SETTINGS_KEY = 'scCorpToolbox.v1';
  const REVISIONS_KEY = 'scOstSalaryRevisions.v1';
  const BOOKMARKS_KEY = 'scCorpBookmarks.v1';
  const REVISION_FORMAT = 1;
  const INIT_FLAG = 'scCorpToolboxInit';

  const ICON_GROUP = {
    offensive: 'military',
    defensive: 'military',
    strategic: 'military',
    industry: 'industry',
    mining: 'industry',
    hightech: 'industry',
    construction: 'industry',
    spaceindustry: 'industry',
    food: 'civilian',
    agriculture: 'civilian',
    recreation: 'civilian',
    services: 'civilian',
    utilities: 'civilian',
    government: 'civilian'
  };

  const FIELD_META = {
    miSala: { label: 'Salary increase %', kind: 'number' },
    miSalaTarget: { label: 'Salary target index', kind: 'number' },
    miSaleMPPlus: { label: 'Sell start %', kind: 'number' },
    miSaleTDec: { label: 'Sell time discount %', kind: 'number' },
    miBuyMPMinus: { label: 'Buy start %', kind: 'number' },
    miBuyTInc: { label: 'Buy time raise %', kind: 'number' },
    miT: { label: 'Low-water months', kind: 'number' },
    miQ: { label: 'Order quantity months', kind: 'number' },
    miL: { label: 'Requested quality', kind: 'number' },
    miTcash: { label: 'Transfer cash', kind: 'number' },
    miQuantityCA: { label: 'Contract / offer quantity', kind: 'number' },
    miSaleFollowQ: { label: 'Follow quality when selling', kind: 'checkbox' },
    miCSEL: { label: 'Include in order-strategy copy', kind: 'checkbox' },
    miQSEL: { label: 'Include in quality copy', kind: 'checkbox' },
    miSalaStrat: { label: 'Salary strategy', kind: 'radio' },
    miSaleStrat: { label: 'Sell strategy', kind: 'radio' },
    miBuyStrat: { label: 'Buy strategy', kind: 'radio' },
    miOS: { label: 'Order strategy on/off', kind: 'radio' },
    miQS: { label: 'Quality any/fixed', kind: 'radio' },
    miActionCA: { label: 'Offer / retract action', kind: 'radio' },
    miOrderID: { label: 'Retract this material order', kind: 'checkbox' },
    miContractID: { label: 'Cancel this contract', kind: 'checkbox' }
  };

  const DEFAULTS = {
    panelOpen: true,
    target: 300,
    increase: 0,
    mode: '1',
    sortKey: 'original',
    sortDir: 'asc',
    filterCategory: 'any',
    filterProduct: 'any',
    filterMode: 'any',
    filterUnsold: 'any',
    filterSupplies: 'any',
    filterCurMin: '',
    filterCurMax: '',
    filterTgtMin: '',
    filterTgtMax: '',
    filterWelMin: '',
    filterWelMax: '',
    filterHireMin: '',
    filterHireMax: '',
    filterProdMin: '',
    filterProdMax: '',
    filterValMin: '',
    filterValMax: ''
  };

  function pageWin() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow.document) return unsafeWindow;
    } catch (e) { /* isolated */ }
    return window;
  }

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (e) { /* ignore */ }
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) { /* ignore */ }
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  const settings = Object.assign({}, DEFAULTS, gmGet(SETTINGS_KEY, null) || {});

  function saveSettings() {
    gmSet(SETTINGS_KEY, settings);
  }

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const el = document.createElement('style');
      el.textContent = css;
      document.documentElement.appendChild(el);
    }
  }

  addStyle(`
  #sc-corp-root {
  position: fixed; top: 64px; right: 8px; z-index: 2147483000;
  width: 256px; max-height: calc(100vh - 76px); overflow: auto;
  font: 11px/1.3 Arial, Helvetica, sans-serif; color: #111;
  background: #f3f6ff; border: 1px solid #2a3a7a;
  box-shadow: 0 6px 18px rgba(0,0,0,.25); border-radius: 4px;
  }
  #sc-corp-root.sc-corp-collapsed { width: auto; max-height: none; overflow: visible; }
  #sc-corp-root.sc-corp-collapsed .sc-corp-body { display: none; }
  #sc-corp-root * { box-sizing: border-box; }
  #sc-corp-root h3, #sc-corp-root h4 { margin: 0; }
  .sc-corp-head {
    display: flex; align-items: center; justify-content: space-between;
    background: #1d4f9c; color: #fff; padding: 4px 6px; cursor: move; user-select: none;
  }
  .sc-corp-head h3 { font-size: 11px; font-weight: 700; }
  .sc-corp-head button {
    background: #0f2f66; color: #fff; border: 1px solid #9bb6e6;
    border-radius: 2px; cursor: pointer; padding: 0 5px; font-size: 12px;
  }
  .sc-corp-body { padding: 6px 7px 8px; }
  .sc-corp-help { color: #445; font-size: 10px; margin: 0 0 5px; }
  .sc-corp-row { display: flex; gap: 4px; align-items: center; margin: 3px 0; flex-wrap: wrap; }
  .sc-corp-row label { display: flex; align-items: center; gap: 3px; white-space: nowrap; }
  #sc-corp-root input[type="number"],
  #sc-corp-root input[type="text"],
  #sc-corp-root select {
  font-size: 11px; padding: 1px 3px; border: 1px solid #7a88b0; border-radius: 2px;
  }
  #sc-corp-root input[type="number"] { width: 52px; }
  #sc-corp-root input.sc-corp-mini { width: 40px; }
  #sc-corp-root select { max-width: 160px; }
  #sc-corp-root select.sc-corp-wide,
  #sc-corp-root select#sc-corp-revlist,
  #sc-corp-root select#sc-corp-fcat,
  #sc-corp-root select#sc-corp-fprod { width: 100%; max-width: none; }
  #sc-corp-root input[type="text"]#sc-corp-search,
  #sc-corp-root input[type="text"]#sc-corp-revname { width: 100%; }
  .sc-corp-actions { display: flex; flex-wrap: wrap; gap: 3px; margin: 4px 0; }
  #sc-corp-root button.sc-btn {
  background: #2d6bcd; color: #fff; border: 0; border-radius: 2px;
  padding: 3px 6px; cursor: pointer; font-size: 10px;
  }
  #sc-corp-root button.sc-btn:hover { background: #1d4f9c; }
  #sc-corp-root button.sc-btn.alt { background: #4b5d99; }
  #sc-corp-root button.sc-btn.ok { background: #2a7a3a; }
  .sc-corp-section { border-top: 1px solid #c5cbe0; margin-top: 6px; padding-top: 5px; }
  .sc-corp-section h4 { font-size: 11px; color: #1d4f9c; margin-bottom: 3px; }
  .sc-corp-status { background: #e7edff; border: 1px dashed #7a88b0; padding: 3px 5px; margin-top: 5px; }
  td.sc-corp-iconcell { white-space: nowrap !important; vertical-align: middle; }
  input.sc-corp-pick {
    width: 13px; height: 13px; margin: 0 4px 0 0; padding: 0; vertical-align: middle;
  }
  button.sc-corp-bm, button.sc-corp-bm-remove {
    width: 16px; height: 16px; margin: 0 4px 0 0; padding: 0;
    border: 1px solid #7a88b0; background: #fff; color: #1d4f9c;
    cursor: pointer; font-size: 12px; line-height: 14px; vertical-align: middle;
  }
  button.sc-corp-bm.on { background: #f3d36b; border-color: #8a6a12; }
  td.sc-corp-iconcell img { vertical-align: middle; display: inline; }
  tr.sc-corp-selected > td { background-color: #d4e4ff !important; }
  tr.sc-corp-hide { display: none !important; }
  `);

  function num(text) {
    const v = parseFloat(String(text == null ? '' : text).replace(/,/g, '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(v) ? v : 0;
  }

  function parseMoney(text) {
    const s = String(text == null ? '' : text).replace(/,/g, '').replace(/\u00a0/g, ' ').trim();
    const m = s.match(/(-?[\d.]+)\s*([KMBT])?/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    const mul = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    const u = (m[2] || '').toUpperCase();
    return n * (mul[u] || 1);
  }

  function emptyToNull(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    const n = num(s);
    return Number.isFinite(n) ? n : null;
  }

  function dataNum(tr, index) {
    const cells = numericDataCells(tr);
    return cells[index] != null ? cells[index] : 0;
  }

  function numericDataCells(tr) {
    const cells = [];
    Array.prototype.forEach.call(tr.cells || tr.querySelectorAll('td, th'), function (td) {
      if (td.querySelector('input, select, textarea, a[href*="miCorpNumber"]')) return;
      const t = (td.textContent || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
      if (!t) return;
      if (!/^[-+]?\d[\d,]*(?:\.\d+)?%?$/.test(t)) return;
      cells.push(num(t));
    });
    return cells;
  }

  function tableBody(table) {
    if (!table) return null;
    if (table.tBodies && table.tBodies.length) return table.tBodies[0];
    if (table.createTBody) return table.createTBody();
    return table;
  }

  function adoptRow(parent, tr) {
    if (!parent || !tr) return;
    try { parent.appendChild(tr); } catch (e) { /* ignore */ }
  }

  function fieldLabel(key) {
    return (FIELD_META[key] && FIELD_META[key].label) || key;
  }

  function fieldKind(key, el) {
    if (FIELD_META[key]) return FIELD_META[key].kind;
    if (el && (el.type === 'checkbox' || el.type === 'radio')) return el.type;
    return 'text';
  }

  function inRange(value, minV, maxV) {
    if (minV != null && value < minV) return false;
    if (maxV != null && value > maxV) return false;
    return true;
  }

  function normName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function iconKey(src) {
    const m = String(src || '').match(/\/([a-z]+)(?:16|32)\.(?:gif|png)/i);
    return m ? m[1].toLowerCase() : 'other';
  }

  function categoryLabel(key) {
    const names = {
      offensive: 'Offensive', defensive: 'Defensive', strategic: 'Strategic',
 industry: 'Industry', mining: 'Mining', hightech: 'High Tech',
 construction: 'Construction', spaceindustry: 'Space', food: 'Food',
 agriculture: 'Agriculture', recreation: 'Recreation', services: 'Services',
 utilities: 'Utilities', government: 'Government'
    };
    return names[key] || key;
  }

  function sectionFromLabel(label) {
    const t = String(label || '');
    if (/Enterprise Controlled/i.test(t)) return 'Enterprise Public Corporations';
    if (/Country Controlled/i.test(t)) return 'Country Public Corporations';
    if (/Privately Held/i.test(t)) return 'Privately Held Corporations';
    if (/Public Corporations/i.test(t)) return 'Public Corporations';
    if (/National Industries/i.test(t)) return 'National Industries';
    if (/State Corporations/i.test(t)) return 'State Corporations';
    return null;
  }

  function detectMode() {
    if (document.querySelector('input[name^="miSalaStrat"]')) return 'salary';
    if (document.querySelector('input[name^="miSaleStrat"], form[name="corpstrats"]')) return 'trade';
    if (document.querySelector('input[name^="miTcash"]') && document.querySelector('a[href*="miCorpNumber"]')) return 'funds';
    if (document.querySelector('input[name^="miCSEL"]') && document.querySelector('input[name^="miL"]') && document.querySelector('a[href*="miCorpNumber"]')) return 'quality';
    if (document.querySelector('input[name^="miActionCA"], form[name="offerproducts"]')) return 'offers';
    if (document.querySelector('form[name="prodcontracts"]') || document.querySelector('input[name="SN_METHOD"][value="stateCmpProdContractsSubmit"]') || /statecmpprodcontracts/i.test(location.href || '')) return 'contracts';
    if (document.querySelector('input[name="miOrderID"], form[name="ordersform"]') || /statecmpretractorders/i.test(location.href || '')) return 'retract';
    if ((/tradecorpcontracts/i.test(location.href || '') || document.title.indexOf('corporation contracts') !== -1)
      && document.querySelector('input[name="miContractID"], form[name="contractform"]')) return 'cancel';
    if (/tradeworldmarket|tradeownstockcorps|supplyownstockcorps|tradeprices|tradereq|stockorderstrategies|productutil|tradecontracts|tradebycontract|tradecontractsign/i.test(location.href || '')) return null;
    if (hasEditableCorpRows()) return 'form';
    const href = String(location.href || '') + String(location.search || '');
    if (/ownedcompanies|statecmp/i.test(href) || document.getElementById('corplist')) {
      if (document.querySelector('a[href*="miCorpNumber"]')) return 'list';
    }
    if (document.querySelector('table.data a[href*="miCorpNumber"]')) return 'list';
    return null;
  }

  function hasEditableCorpRows() {
    const tables = document.querySelectorAll('#corplist table.data, table.data');
    for (let i = 0; i < tables.length; i++) {
      const rows = tables[i].rows || [];
      for (let r = 0; r < rows.length; r++) {
        if (!rows[r].querySelector('a[href*="miCorpNumber"]')) continue;
        if (rows[r].querySelector('input:not([type="hidden"]):not(.sc-corp-pick), select, textarea')) return true;
      }
    }
    return false;
  }

  function findWorkForm(mode) {
    const forms = document.querySelectorAll('form');
    for (let i = 0; i < forms.length; i++) {
      const m = forms[i].querySelector('input[name="SN_METHOD"]');
      const method = m ? m.value : '';
      if (mode === 'salary' && /stateCmpSalariesSubmit/i.test(method)) return forms[i];
      if (mode === 'trade' && /stateCmpTradeStratSubmit/i.test(method)) return forms[i];
      if (forms[i].getAttribute('name') === 'corpstrats' && mode === 'trade') return forms[i];
      if (mode === 'quality' && (/stateCmpBuyQualitySubmit/i.test(method) || forms[i].getAttribute('name') === 'fSOS')) return forms[i];
      if (mode === 'funds' && /stateCmpTransferFundsSubmit/i.test(method)) return forms[i];
      if (mode === 'offers' && (/stateCmpOfferProductsSubmit/i.test(method) || forms[i].getAttribute('name') === 'offerproducts')) return forms[i];
      if (mode === 'contracts' && (/stateCmpProdContractsSubmit/i.test(method) || forms[i].getAttribute('name') === 'prodcontracts')) return forms[i];
      if (mode === 'retract' && (forms[i].getAttribute('name') === 'ordersform' || /RetractOrders/i.test(method))) return forms[i];
      if (mode === 'cancel' && (forms[i].getAttribute('name') === 'contractform' || /tradecontractscancel/i.test(method))) return forms[i];
      if (mode === 'form' && /stateCmp/i.test(method) && /Submit/i.test(method)) return forms[i];
    }
    if (mode === 'salary') {
      const named = document.querySelector('form input[name^="miSalaStrat"]');
      return named ? named.closest('form') : null;
    }
    if (mode === 'trade') {
      const named = document.querySelector('form[name="corpstrats"], form input[name^="miSaleStrat"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    if (mode === 'quality') {
      const named = document.querySelector('form[name="fSOS"], form input[name^="miCSEL"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    if (mode === 'funds') {
      const named = document.querySelector('form input[name^="miTcash"]');
      return named ? named.closest('form') : null;
    }
    if (mode === 'offers') {
      const named = document.querySelector('form[name="offerproducts"], form input[name^="miActionCA"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    if (mode === 'contracts') {
      const named = document.querySelector('form[name="prodcontracts"], form input[name^="miQuantityCA"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    if (mode === 'retract') {
      const named = document.querySelector('form[name="ordersform"], form input[name="miOrderID"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    if (mode === 'cancel') {
      const named = document.querySelector('form[name="contractform"], form input[name="miContractID"]');
      return named ? (named.tagName === 'FORM' ? named : named.closest('form')) : null;
    }
    const any = document.querySelector('form input[name^="mi"], form select[name^="mi"]');
    return any ? any.closest('form') : null;
  }

  function corpIdFromHref(href) {
    const m = String(href || '').match(/miCorpNumber=(\d+)/i);
    return m ? m[1] : null;
  }

  function corpIdFromName(name) {
    const m = String(name || '').match(/(\d+)$/);
    return m ? m[1] : null;
  }

  function salaryStrat(id) {
    const w = pageWin();
    try {
      if (w.SalaryStrats && w.SalaryStrats['' + id]) return w.SalaryStrats['' + id];
    } catch (e) { /* ignore */ }
    return null;
  }

  function statusText(td) {
    if (!td) return '';
    return (td.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function checkedRadio(form, name) {
    const root = form || document;
    const el = root.querySelector('input[name="' + name + '"]:checked');
    return el ? String(el.value) : '';
  }

  function setRadio(form, name, value) {
    const root = form || document;
    const el = root.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) {
      el.checked = true;
      try { el.dispatchEvent(new Event('click', { bubbles: true })); } catch (e) { /* ignore */ }
    }
    return el;
  }

  function sellObj(id) {
    const w = pageWin();
    try { if (w.SellStrats && w.SellStrats['' + id]) return w.SellStrats['' + id]; } catch (e) { /* ignore */ }
    return null;
  }

  function buyObj(id) {
    const w = pageWin();
    try { if (w.BuyStrats && w.BuyStrats['' + id]) return w.BuyStrats['' + id]; } catch (e) { /* ignore */ }
    return null;
  }

  function snapshotFields(c) {
    const out = {};
    Object.keys(c.fields || {}).forEach(function (key) {
      out[key] = (c.fields[key] || []).map(function (el) {
        return {
          type: el.type || el.tagName,
          value: el.type === 'checkbox' || el.type === 'radio' ? el.value : el.value,
          checked: !!el.checked,
          disabled: !!el.disabled
        };
      });
    });
    return out;
  }

  function applyFieldSnapshot(c, snapFields) {
    if (!snapFields) return;
    Object.keys(snapFields).forEach(function (key) {
      const els = (c.fields && c.fields[key]) || [];
      const saved = snapFields[key] || [];
      saved.forEach(function (item, i) {
        const el = els[i];
        if (!el || !item) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = !!item.checked;
        } else {
          writeInput(el, item.value);
        }
        if (item.disabled) enableField(el, false);
        else enableField(el, true);
      });
    });
  }

  function applyTrade(c, form, spec) {
    if (spec.sellMode) {
      setRadio(form, 'miSaleStrat' + c.id, spec.sellMode);
      const time = String(spec.sellMode) !== '3';
      const startEl = form.querySelector('input[name="miSaleMPPlus' + c.id + '"]');
      const lowerEl = form.querySelector('input[name="miSaleTDec' + c.id + '"]');
      const followEl = form.querySelector('input[name="miSaleFollowQ' + c.id + '"]');
      const so = sellObj(c.id);
      if (time) {
        writeInput(startEl, spec.sellStart);
        writeInput(lowerEl, spec.sellLower);
        if (followEl) followEl.checked = !!spec.sellFollowQ;
        if (so) {
          so.strategy = 6;
          so.start = num(spec.sellStart);
          so.lower = num(spec.sellLower);
        }
      } else {
        if (startEl) { startEl.value = '100'; enableField(startEl, false); }
        if (lowerEl) { lowerEl.value = '0'; enableField(lowerEl, false); }
        if (followEl) { followEl.checked = false; enableField(followEl, false); }
        if (so) so.strategy = 3;
      }
    }
    if (spec.buyMode) {
      setRadio(form, 'miBuyStrat' + c.id, spec.buyMode);
      const time = String(spec.buyMode) !== '3';
      const startEl = form.querySelector('input[name="miBuyMPMinus' + c.id + '"]');
      const raiseEl = form.querySelector('input[name="miBuyTInc' + c.id + '"]');
      const bo = buyObj(c.id);
      if (time) {
        writeInput(startEl, spec.buyStart);
        writeInput(raiseEl, spec.buyRaise);
        if (bo) {
          bo.strategy = 6;
          bo.start = num(spec.buyStart);
          bo.raise = num(spec.buyRaise);
        }
      } else {
        if (startEl) { startEl.value = '100'; enableField(startEl, false); }
        if (raiseEl) { raiseEl.value = '0'; enableField(raiseEl, false); }
        if (bo) bo.strategy = 3;
      }
    }
  }

  function clampQ(v) {
    const n = num(v);
    if (n < 120) return 120;
    if (n > 330) return 330;
    return n;
  }

  function stockObj(id) {
    const w = pageWin();
    try {
      if (w.stockstrategies && w.stockstrategies['' + id]) return w.stockstrategies['' + id];
    } catch (e) { /* ignore */ }
    return null;
  }

  function applyQuality(c, form, spec) {
    const scope = form || document;
    if (spec.os != null) {
      setRadio(scope, 'miOS' + c.id, String(spec.os));
      try {
        const w = pageWin();
        if (String(spec.os) === '0' && typeof w.disableOS === 'function') w.disableOS(c.id, '0');
        if (String(spec.os) === '1' && typeof w.enableOS === 'function') w.enableOS(c.id, '1');
      } catch (e) { /* ignore */ }
    }
    const tEl = scope.querySelector('input[name="miT' + c.id + '"]');
    const qEl = scope.querySelector('input[name="miQ' + c.id + '"]');
    if (spec.lw != null) writeInput(tEl, spec.lw);
    if (spec.oq != null) writeInput(qEl, spec.oq);
    if (spec.qs != null) {
      setRadio(scope, 'miQS' + c.id, String(spec.qs));
      try {
        const w = pageWin();
        if (String(spec.qs) === '1' && typeof w.anyQS === 'function') w.anyQS(c.id);
        if (String(spec.qs) === '2' && typeof w.requestQS === 'function') w.requestQS(c.id);
      } catch (e) { /* ignore */ }
    }
    const lEl = scope.querySelector('input[name="miL' + c.id + '"]');
    if (spec.quality != null) writeInput(lEl, clampQ(spec.quality));
    const st = stockObj(c.id);
    if (st) {
      if (spec.lw != null) st.lowWaterMonths = num(spec.lw);
      if (spec.oq != null) st.orderQuantityMonths = num(spec.oq);
      if (spec.quality != null) st.orderQuality = clampQ(spec.quality);
    }
  }

  function applyFunds(c, amount) {
    if (c.transfer) writeInput(c.transfer, amount);
    else {
      const el = document.querySelector('input[name="miTcash' + c.id + '"]');
      writeInput(el, amount);
    }
  }

  function applyOffers(c, form, spec) {
    const scope = form || document;
    if (spec.action != null) setRadio(scope, 'miActionCA' + c.id, String(spec.action));
    try {
      const w = pageWin();
      if (typeof w.toggleOfferInput === 'function') {
        w.toggleOfferInput(c.id, String(spec.action) === '0' ? 0 : 1);
      }
    } catch (e) { /* ignore */ }
    const qty = scope.querySelector('input[name="miQuantityCA' + c.id + '"]');
    if (qty && spec.qty != null && String(spec.action) === '2') writeInput(qty, spec.qty);
  }

  function applyContracts(c, spec) {
    const el = c.qtyEl || document.querySelector('input[name="miQuantityCA' + c.id + '"]');
    const w = pageWin();
    if (spec.max) {
      try { if (typeof w.maxContractField === 'function') { w.maxContractField(c.id); return; } } catch (e) { /* ignore */ }
    }
    if (spec.clear) {
      try { if (typeof w.clearContractField === 'function') { w.clearContractField(c.id); return; } } catch (e) { /* ignore */ }
      writeInput(el, 0);
      return;
    }
    if (spec.qty != null) writeInput(el, spec.qty);
  }

  function collectListTables() {
    const root = document.getElementById('corplist') || document;
    const tables = root.querySelectorAll('table.data');
    const out = [];
    Array.prototype.forEach.call(tables, function (table) {
      if (table.getAttribute('data-sc-bookmark') === '1') return;
      if (table.closest && table.closest('#sc-corp-bookmarks')) return;
      if (table.querySelector('a[href*="miCorpNumber"]')) out.push(table);
    });
      return out;
  }

  function tableHasCorpWork(table) {
    return !!(table && table.querySelector('a[href*="miCorpNumber"], input[name^="miSalaStrat"], input[name^="miSaleStrat"], input[name^="miTcash"], input[name^="miCSEL"], input[name^="miActionCA"], input[name^="miQuantityCA"], input[name="miOrderID"], input[name="miContractID"]'));
  }

  function collectFormTables(form) {
    const root = form || document.getElementById('corplist') || document;
    const prefer = root.querySelectorAll('table.data');
    const out = [];
    Array.prototype.forEach.call(prefer, function (table) {
      if (tableHasCorpWork(table)) out.push(table);
    });
      if (out.length) return out;
      const fallback = [];
    Array.prototype.forEach.call(root.querySelectorAll('table'), function (table) {
      if (!tableHasCorpWork(table)) return;
      for (let i = fallback.length - 1; i >= 0; i--) {
        if (fallback[i].contains(table)) return;
        if (table.contains(fallback[i])) fallback.splice(i, 1);
      }
      fallback.push(table);
    });
    return fallback;
  }

  function rowHomeTable(tr) {
    let p = tr && tr.parentElement;
    while (p && p.tagName !== 'TABLE') p = p.parentElement;
    return p || null;
  }

  function cellQuery(tr, selector) {
    const cells = tr.cells || [];
    for (let i = 0; i < cells.length; i++) {
      const hit = cells[i].querySelector(selector);
      if (hit) return hit;
    }
    return null;
  }

  function collectChecklistTables(form) {
    const root = form || document;
    const boxes = root.querySelectorAll('input[name="miOrderID"], input[name="miContractID"]');
    const out = [];
    const seen = [];
    Array.prototype.forEach.call(boxes, function (box) {
      const tr = box.closest('tr');
      const table = rowHomeTable(tr);
      if (!table) return;
      if (seen.indexOf(table) !== -1) return;
      seen.push(table);
      out.push(table);
    });
    return out;
  }

  function collectRowFields(tr, id) {
    const fields = {};
    Array.prototype.forEach.call(tr.querySelectorAll('input, select, textarea'), function (el) {
      const n = el.getAttribute('name') || '';
      if (!n) return;
      if (el.classList && el.classList.contains('sc-corp-pick')) return;
      let key = n;
      if (id && n.slice(-String(id).length) === String(id)) key = n.slice(0, n.length - String(id).length);
      if (!fields[key]) fields[key] = [];
      fields[key].push(el);
    });
    return fields;
  }

  function collectCorps(mode) {
    const map = new Map();
    let index = 0;
    const form = (mode === 'list') ? null : findWorkForm(mode);
    const tables = (mode === 'list')
    ? collectListTables()
    : (mode === 'retract' || mode === 'cancel')
    ? collectChecklistTables(form)
    : collectFormTables(form);
    map._tables = tables;
    map._origRowsByTable = tables.map(function (table) {
      return Array.prototype.slice.call(table.rows || []);
    });
    map._form = form;
    map._mode = mode;

    tables.forEach(function (table) {
      let section = 'State Corporations';
      let headerName = '';
      let headerProduct = '';
      let headerIcon = '';
      let headerId = '';
      Array.prototype.forEach.call(table.rows || [], function (tr) {
        if (rowHomeTable(tr) !== table) return;
        const nameLink = (mode === 'retract' || mode === 'cancel')
        ? (cellQuery(tr, 'a[href*="miCorpNumber"]') || cellQuery(tr, 'a[title*="Corporation page"]'))
        : tr.querySelector('a[href*="miCorpNumber"], a[title*="Corporation page"]');
        const strat = cellQuery(tr, 'input[name^="miSalaStrat"]') ||
        cellQuery(tr, 'input[name^="miSaleStrat"]') ||
        cellQuery(tr, 'input[name^="miActionCA"]') ||
        cellQuery(tr, 'input[name^="miQuantityCA"]') ||
        cellQuery(tr, 'input[name^="miTcash"]');
        const listBox = cellQuery(tr, 'input[name="miOrderID"]') || cellQuery(tr, 'input[name="miContractID"]');
        if (nameLink && (mode === 'retract' || mode === 'cancel') && !listBox) {
          headerId = corpIdFromHref(nameLink.getAttribute('href')) || headerId;
          headerName = nameLink.textContent.replace(/\s+/g, ' ').trim();
          const typeLink = tr.querySelector('a.popup.gadgetlink[title], a[onclick*="productinfo"]');
          headerProduct = typeLink ? (typeLink.getAttribute('title') || '').trim() : headerProduct;
          const icon = tr.querySelector('img[src*="16."], img[src*="32."]');
          headerIcon = icon ? icon.getAttribute('src') : headerIcon;
          const detected = sectionFromLabel(tr.textContent);
          if (detected) section = detected;
          tr.setAttribute('data-sc-corp-chrome', '1');
          return;
        }
        if (!nameLink && !strat && !listBox) {
          const detected = sectionFromLabel(tr.textContent);
          if (detected) section = detected;
          tr.setAttribute('data-sc-corp-chrome', '1');
          return;
        }
        let id = null;
        if (listBox) {
          id = listBox.value || ('row-' + index);
        } else if (strat) {
          id = corpIdFromName(strat.name);
        } else {
          id = corpIdFromHref(nameLink && nameLink.getAttribute('href'));
        }
        if (!id) {
          tr.setAttribute('data-sc-corp-chrome', '1');
          return;
        }
        const typeLink = tr.querySelector('a.popup.gadgetlink[title], a[onclick*="productinfo"]');
        const icon = tr.querySelector('img[src*="16."], img[src*="32."]');
        const tds = tr.querySelectorAll('td');
        let product = typeLink ? (typeLink.getAttribute('title') || typeLink.textContent || '').trim() : '';
        const ikeySrc = icon ? icon.getAttribute('src') : ((mode === 'retract' || mode === 'cancel') ? headerIcon : '');
        const ikey = iconKey(ikeySrc);
        const rec = {
          id: id,
          origIndex: index++,
          row: tr,
          table: table,
          section: section,
          name: nameLink ? nameLink.textContent.replace(/\s+/g, ' ').trim() : (headerName || ('Corp ' + id)),
                                   product: product || headerProduct,
                                   iconKey: ikey,
                                   group: ICON_GROUP[ikey] || 'other',
                                   value: 0,
                                   production: 0,
                                   hiring: 0,
                                   welfare: 0,
                                   current: 0,
                                   unsold: '',
                                   supplies: '',
                                   pick: null,
                                   strat0: null,
                                   strat1: null,
                                   change: null,
                                   target: null,
                                   fields: {},
                                   sellMode: '',
                                   buyMode: '',
                                   sellStart: 0,
                                   sellLower: 0,
                                   sellFollowQ: false,
                                   buyStart: 0,
                                   buyRaise: 0,
                                   quality: 0
        };

        rec.fields = collectRowFields(tr, id);

        const scope = form || document;
        if (mode === 'salary') {
          const dataTds = tr.querySelectorAll('td.data');
          rec.welfare = dataTds[3] ? num(dataTds[3].textContent) : 0;
          rec.hiring = dataTds[4] ? num(dataTds[4].textContent) : 0;
          rec.current = dataTds[6] ? num(dataTds[6].textContent) : 0;
          rec.strat0 = scope.querySelector('input[name="miSalaStrat' + id + '"][value="0"]');
          rec.strat1 = scope.querySelector('input[name="miSalaStrat' + id + '"][value="1"]');
          rec.change = scope.querySelector('input[name="miSala' + id + '"]');
          rec.target = scope.querySelector('input[name="miSalaTarget' + id + '"]');
        } else if (mode === 'trade') {
          const dataTds = tr.querySelectorAll('td.data');
          rec.quality = dataTds[3] ? num(dataTds[3].textContent) : 0;
          rec.sellMode = checkedRadio(scope, 'miSaleStrat' + id) || '6';
          rec.buyMode = checkedRadio(scope, 'miBuyStrat' + id) || '6';
          rec.sellStart = num((scope.querySelector('input[name="miSaleMPPlus' + id + '"]') || {}).value);
          rec.sellLower = num((scope.querySelector('input[name="miSaleTDec' + id + '"]') || {}).value);
          rec.sellFollowQ = !!(scope.querySelector('input[name="miSaleFollowQ' + id + '"]') || {}).checked;
          rec.buyStart = num((scope.querySelector('input[name="miBuyMPMinus' + id + '"]') || {}).value);
          rec.buyRaise = num((scope.querySelector('input[name="miBuyTInc' + id + '"]') || {}).value);
        } else if (mode === 'quality') {
          rec.os = checkedRadio(scope, 'miOS' + id) || '1';
          rec.qs = checkedRadio(scope, 'miQS' + id) || '2';
          rec.lw = num((scope.querySelector('input[name="miT' + id + '"]') || {}).value);
          rec.oq = num((scope.querySelector('input[name="miQ' + id + '"]') || {}).value);
          rec.quality = num((scope.querySelector('input[name="miL' + id + '"]') || {}).value);
        } else if (mode === 'funds') {
          rec.profit = tds[3] ? parseMoney(tds[3].textContent) : 0;
          rec.cash = tds[5] ? parseMoney(tds[5].textContent) : 0;
          rec.debt = tds[9] ? parseMoney(tds[9].textContent) : 0;
          rec.tax = tds[13] ? num(tds[13].textContent) : 0;
          rec.transfer = scope.querySelector('input[name="miTcash' + id + '"]');
        } else if (mode === 'offers') {
          rec.stock = dataNum(tr, 0);
          rec.offered = dataNum(tr, 1);
          rec.action = checkedRadio(scope, 'miActionCA' + id) || '0';
          rec.qtyEl = scope.querySelector('input[name="miQuantityCA' + id + '"]');
          rec.qty = rec.qtyEl ? num(rec.qtyEl.value) : 0;
        } else if (mode === 'contracts') {
          const nums = numericDataCells(tr);
          rec.capacity = nums[0] || 0;
          rec.lastProd = nums[1] || 0;
          rec.proposed = nums[2] || 0;
          rec.contracted = nums[3] || 0;
          rec.pct = nums[4] || 0;
          rec.qtyEl = scope.querySelector('input[name="miQuantityCA' + id + '"]') || cellQuery(tr, 'input[name^="miQuantityCA"]');
          rec.qty = rec.qtyEl ? num(rec.qtyEl.value) : 0;
        } else if (mode === 'retract' || mode === 'cancel') {
          rec.pick = listBox;
          const cells = Array.prototype.map.call(tr.cells || [], function (td) {
            return (td.textContent || '').replace(/\s+/g, ' ').trim();
          });
          rec.amount = 0;
          rec.price = 0;
          rec.surplus = 0;
          rec.date = '';
          rec.units = '';
          cells.forEach(function (txt) {
            if (/SC\$/i.test(txt) && !rec.price) rec.price = parseMoney(txt);
            else if (/[A-Za-z]+\s+\d{1,2}\s+\d{4}/.test(txt) && !rec.date) rec.date = txt;
            else if (/^(units|tons|systems|kwhs|wind turbines|missiles)/i.test(txt) && !rec.units) rec.units = txt;
          });
            const fonts = tr.querySelectorAll('font.coloreddata');
            if (fonts.length) rec.surplus = parseMoney(fonts[fonts.length - 1].textContent);
            if (!rec.amount) {
              const amtCell = Array.prototype.filter.call(tr.cells || [], function (td) {
                return /^\s*-?[\d,]+(\.\d+)?\s*$/.test(td.textContent || '');
              })[0];
              rec.amount = amtCell ? num(amtCell.textContent) : dataNum(tr, 0);
            }
            rec.detail = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        } else if (mode === 'list') {
          rec.value = tds[3] ? parseMoney(tds[3].textContent) : 0;
          rec.unsold = statusText(tds[5]);
          rec.supplies = statusText(tds[6]);
          rec.production = tds[7] ? num(tds[7].textContent) : 0;
          rec.hiring = tds[8] ? num(tds[8].textContent) : 0;
        }

        map.set(id, rec);
        tr.setAttribute('data-sc-corp-id', id);
      });
    });
    return map;
  }

  function installPickboxes(corps) {
    corps.forEach(function (c) {
      const existing = c.row.querySelector('input[name="miOrderID"], input[name="miContractID"]');
      if (existing) {
        existing.classList.add('sc-corp-pick');
        c.pick = existing;
        return;
      }
      if (c.row.querySelector('input.sc-corp-pick')) {
        c.pick = c.row.querySelector('input.sc-corp-pick');
        return;
      }
      const td = c.row.querySelector('td');
      if (!td) return;
      td.classList.add('sc-corp-iconcell');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'sc-corp-pick';
      box.value = '1';
      box.title = 'Select ' + c.name;
      box.setAttribute('data-sc-corp-id', c.id);
      td.insertBefore(box, td.firstChild);
      c.pick = box;
    });
  }

  function ownerScope() {
    const w = pageWin();
    let kind = '';
    let id = '';
    try {
      kind = String(w.dtDesktopOwnerKind || '').toLowerCase();
      if (kind === 'e') id = String(w.ckLoginEnterprise || w.dtDesktopOwnerID || '');
      else if (kind === 'c') id = String(w.ckLoginCountry || w.dtDesktopOwnerID || '');
      if (!kind) {
        if (w.ckLoginEnterprise && !w.ckLoginCountry) {
          kind = 'e';
          id = String(w.ckLoginEnterprise);
        } else if (w.ckLoginCountry) {
          kind = 'c';
          id = String(w.ckLoginCountry);
        }
      }
    } catch (e) { /* isolated window */ }
    const addrEl = document.querySelector('input[name="SN_ADDRESS"]');
    const addr = (addrEl && addrEl.value) || '';
    const href = String(location.href || '') + ' ' + addr;
    if (!kind) kind = /wwwEnterprise|miEnterpriseName/i.test(href) ? 'e' : 'c';
    if (!id) {
      const named = href.match(/mi(?:Country|Enterprise)Name=([^&]+)/i);
      id = named ? decodeURIComponent(named[1]) : 'unknown';
    }
    let name = '';
    const header = document.querySelector('.paragrapheader, .paragraphheader');
    if (header) {
      const hm = String(header.textContent || '').match(/Corporations in\s+(.+)/i);
      if (hm) name = hm[1].replace(/\s+/g, ' ').trim();
    }
    if (!name) {
      const link = document.querySelector('a[href*="miEnterpriseName="], a[href*="miCountryName="]');
      const linkHref = link ? (link.getAttribute('href') || '') : '';
      const ent = linkHref.match(/miEnterpriseName=([^&]+)/i);
      const ctry = linkHref.match(/miCountryName=([^&]+)/i);
      const raw = kind === 'e' && ent ? ent[1] : (ctry ? ctry[1] : (ent ? ent[1] : ''));
      if (raw) name = decodeURIComponent(raw.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
    }
    const who = kind === 'e' ? 'Enterprise' : 'Country';
    return {
      kind: kind,
      id: id,
      key: kind + ':' + id,
      name: name,
      label: name ? (name + ' (' + id + ')') : (who + ' ' + id)
    };
  }

  function loadBookmarks() {
    const raw = gmGet(BOOKMARKS_KEY, null);
    if (!raw || typeof raw !== 'object') return { format: 1, owners: {} };
    return { format: 1, owners: raw.owners && typeof raw.owners === 'object' ? raw.owners : {} };
  }

  function storeBookmarks(pack) {
    gmSet(BOOKMARKS_KEY, { format: 1, owners: pack.owners || {} });
  }

  function bookmarksForOwner() {
    const pack = loadBookmarks();
    const key = ownerScope().key;
    const list = pack.owners[key];
    return Array.isArray(list) ? list : [];
  }

  function isBookmarked(id) {
    const sid = String(id);
    return bookmarksForOwner().some(function (b) { return String(b.id) === sid; });
  }

  function setBookmarks(list) {
    const pack = loadBookmarks();
    pack.owners[ownerScope().key] = list;
    storeBookmarks(pack);
  }

  function bookmarkRecord(c) {
    return {
      id: String(c.id),
 name: c.name,
 product: c.product || '',
 section: c.section || ''
    };
  }

  function addBookmarks(corps, records) {
    const list = bookmarksForOwner().slice();
    const seen = {};
    list.forEach(function (b) { seen[String(b.id)] = true; });
    records.forEach(function (rec) {
      if (!rec || !rec.id || seen[String(rec.id)]) return;
      seen[String(rec.id)] = true;
      list.push(rec);
    });
    setBookmarks(list);
    paintBookmarkButtons(corps);
    renderBookmarkBlock(corps);
  }

  function removeBookmarks(corps, ids) {
    const drop = {};
    ids.forEach(function (id) { drop[String(id)] = true; });
    setBookmarks(bookmarksForOwner().filter(function (b) { return !drop[String(b.id)]; }));
    paintBookmarkButtons(corps);
    renderBookmarkBlock(corps);
  }

  function paintBookmarkButtons(corps) {
    if (!corps) return;
    corps.forEach(function (c) {
      const btn = c.row && c.row.querySelector('button.sc-corp-bm');
      if (!btn) return;
      const on = isBookmarked(c.id);
      btn.classList.toggle('on', on);
      btn.textContent = on ? '★' : '☆';
      btn.title = on ? 'Remove bookmark' : 'Bookmark ' + c.name;
    });
  }

  function bookmarkCell(tr) {
    const cells = tr.cells || [];
    if (cells.length >= 6) return cells[4];
    return cells[0] || null;
  }

  function markBookmarkHeaders() {
    const rows = document.querySelectorAll('#corplist table.data tr.entlistheader');
    Array.prototype.forEach.call(rows, function (tr) {
      if (tr.closest && tr.closest('#sc-corp-bookmarks')) return;
      const cells = tr.cells || [];
      for (let i = 0; i < cells.length; i++) {
        if (!/Unsold Products/i.test(cells[i].textContent || '')) continue;
        const slot = cells[i - 1];
        if (!slot || slot.getAttribute('data-sc-bm-head') === '1') return;
        slot.textContent = '★';
        slot.title = 'Bookmark';
        slot.setAttribute('align', 'center');
        slot.setAttribute('data-sc-bm-head', '1');
        return;
      }
    });
  }

  function installBookmarkButtons(corps) {
    if (corps._mode !== 'list') return;
    markBookmarkHeaders();
    corps.forEach(function (c) {
      if (!c.row || c.row.querySelector('button.sc-corp-bm')) return;
      const td = bookmarkCell(c.row);
      if (!td) return;
      td.classList.add('sc-corp-iconcell');
      td.setAttribute('align', 'center');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sc-corp-bm';
      btn.setAttribute('data-sc-corp-id', c.id);
      td.insertBefore(btn, td.firstChild);
    });
    paintBookmarkButtons(corps);
    if (!document.documentElement.getAttribute('data-sc-bm-wired')) {
      document.documentElement.setAttribute('data-sc-bm-wired', '1');
      document.addEventListener('click', function (ev) {
        const btn = ev.target.closest && ev.target.closest('button.sc-corp-bm, button.sc-corp-bm-remove');
        if (!btn) return;
        ev.preventDefault();
        const live = document._scCorpList;
        if (!live) return;
        const id = btn.getAttribute('data-sc-corp-id');
        if (btn.classList.contains('sc-corp-bm-remove') || btn.classList.contains('sc-corp-bm')) {
          const rec = live.get(id);
          if (btn.classList.contains('sc-corp-bm-remove') || isBookmarked(id)) {
            removeBookmarks(live, [id]);
            say('Removed bookmark.');
            return;
          }
          if (rec) addBookmarks(live, [bookmarkRecord(rec)]);
        }
      });
    }
  }

  function renderBookmarkBlock(corps) {
    const host = document.getElementById('corplist');
    if (!host || !corps || corps._mode !== 'list') return;
    const old = document.getElementById('sc-corp-bookmarks');
    if (old) old.parentNode.removeChild(old);
    markBookmarkHeaders();
    const saved = bookmarksForOwner();
    const scope = ownerScope();
    const wrap = document.createElement('div');
    wrap.id = 'sc-corp-bookmarks';
    const table = document.createElement('table');
    table.className = 'data';
    table.setAttribute('width', '100%');
    table.setAttribute('cellspacing', '0');
    table.setAttribute('cellpadding', '2');
    table.setAttribute('border', '0');
    table.setAttribute('data-sc-bookmark', '1');
    const title = document.createElement('tr');
    title.className = 'entlistheader';
    const th = document.createElement('th');
    th.className = 'datacolheader entlistheader';
    th.colSpan = 999;
    th.setAttribute('align', 'left');
    th.textContent = 'Bookmarks — ' + scope.label + (saved.length ? ' (' + saved.length + ')' : '');
    title.appendChild(th);
    table.appendChild(title);
    const sample = corps._tables && corps._tables[0];
    if (sample) {
      const headers = sample.querySelectorAll('tr.entlistheader');
      if (headers.length > 1) table.appendChild(headers[headers.length - 1].cloneNode(true));
    }
    if (!saved.length) {
      const empty = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'data';
      td.colSpan = 999;
      td.textContent = 'No bookmarks for this ' + (scope.kind === 'e' ? 'enterprise' : 'country') + '. Use ☆ on a row, or bookmark the checked corporations.';
      empty.appendChild(td);
      table.appendChild(empty);
    }
    saved.forEach(function (b) {
      const rec = corps.get(String(b.id));
      if (!rec || !rec.row) {
        const missing = document.createElement('tr');
        const td = document.createElement('td');
        td.className = 'data';
        td.colSpan = 999;
        td.textContent = (b.name || ('Corporation ' + b.id)) + ' is bookmarked but not on this page.';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'sc-corp-bm-remove';
        rm.textContent = '×';
        rm.title = 'Remove bookmark';
        rm.setAttribute('data-sc-corp-id', b.id);
        td.insertBefore(rm, td.firstChild);
        missing.appendChild(td);
        table.appendChild(missing);
        return;
      }
      const clone = rec.row.cloneNode(true);
      clone.removeAttribute('data-sc-corp-id');
      clone.classList.remove('sc-corp-hide');
      clone.classList.toggle('sc-corp-selected', isSelected(rec));
      Array.prototype.forEach.call(clone.querySelectorAll('input.sc-corp-pick, button.sc-corp-bm'), function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
        const first = clone.cells && clone.cells[0];
        if (first) {
          const alias = document.createElement('input');
          alias.type = 'checkbox';
          alias.className = 'sc-corp-pick-alias';
          alias.checked = isSelected(rec);
          alias.title = 'Select ' + rec.name;
          alias.setAttribute('data-sc-corp-id', b.id);
          first.insertBefore(alias, first.firstChild);
        }
        const slot = bookmarkCell(clone);
        if (slot) {
          const star = document.createElement('button');
          star.type = 'button';
          star.className = 'sc-corp-bm-remove';
          star.textContent = '★';
          star.title = 'Remove bookmark';
          star.setAttribute('data-sc-corp-id', b.id);
          slot.insertBefore(star, slot.firstChild);
        }
        table.appendChild(clone);
    });
    wrap.appendChild(table);
    const gap = document.createElement('br');
    wrap.appendChild(gap);
    host.insertBefore(wrap, host.firstChild);
  }

  function isSelected(c) {
    return !!(c.pick && c.pick.checked);
  }

  function setSelected(c, on) {
    if (c.pick) c.pick.checked = !!on;
    if (c.row) c.row.classList.toggle('sc-corp-selected', !!on);
    const aliases = document.querySelectorAll('#sc-corp-bookmarks input.sc-corp-pick-alias[data-sc-corp-id="' + c.id + '"]');
    Array.prototype.forEach.call(aliases, function (box) {
      box.checked = !!on;
      const row = box.closest('tr');
      if (row) row.classList.toggle('sc-corp-selected', !!on);
    });
  }

  function selectedList(corps) {
    const out = [];
    corps.forEach(function (c) { if (isSelected(c)) out.push(c); });
    return out;
  }

  function currentMode(c) {
    if (c.strat1 && c.strat1.checked) return '1';
    if (c.strat0 && c.strat0.checked) return '0';
    return '1';
  }

  function fieldTarget(c) {
    return c.target ? num(c.target.value) : 0;
  }

  function fieldIncrease(c) {
    return c.change ? num(c.change.value) : 0;
  }

  function enableField(el, on) {
    if (!el) return;
    el.disabled = !on;
    if (on) el.removeAttribute('disabled');
    else el.setAttribute('disabled', 'disabled');
  }

  function writeInput(el, value) {
    if (!el) return;
    enableField(el, true);
    el.value = String(value);
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { /* ignore */ }
  }

  function applySalary(c, mode, increase, target) {
    const use = String(mode) === '0' ? '0' : '1';
    if (use === '0' && c.strat0) c.strat0.checked = true;
    if (use === '1' && c.strat1) c.strat1.checked = true;
    const inc = Math.max(0, num(increase));
    const tgt = Math.max(0, num(target));
    const st = salaryStrat(c.id);
    if (st) {
      st.salaryStrategy = parseInt(use, 10);
      st.salaryChange = inc;
      st.salaryTarget = tgt;
    }
    if (use === '0') {
      writeInput(c.change, inc);
      if (c.target) {
        c.target.value = '';
        enableField(c.target, false);
      }
    } else {
      writeInput(c.target, tgt);
      if (c.change) {
        c.change.value = '';
        enableField(c.change, false);
      }
    }
  }

  function snapshotCorp(c) {
    return {
      id: String(c.id),
 name: c.name,
 nameKey: normName(c.name),
 product: c.product,
 productKey: normName(c.product),
 section: c.section,
 mode: currentMode(c),
 increase: fieldIncrease(c),
 target: fieldTarget(c),
 current: c.current,
 sellMode: checkedRadio(c.table && c.table.closest('form'), 'miSaleStrat' + c.id) || c.sellMode,
 buyMode: checkedRadio(c.table && c.table.closest('form'), 'miBuyStrat' + c.id) || c.buyMode,
 sellStart: c.sellStart,
 sellLower: c.sellLower,
 sellFollowQ: c.sellFollowQ,
 buyStart: c.buyStart,
 buyRaise: c.buyRaise,
 os: c.os,
 qs: c.qs,
 lw: c.lw,
 oq: c.oq,
 quality: c.quality,
 fields: snapshotFields(c)
    };
  }

  function loadRevisions() {
    const raw = gmGet(REVISIONS_KEY, null);
    if (!raw || typeof raw !== 'object') return { format: REVISION_FORMAT, items: [] };
    return { format: REVISION_FORMAT, items: Array.isArray(raw.items) ? raw.items : [] };
  }

  function storeRevisions(pack) {
    gmSet(REVISIONS_KEY, { format: REVISION_FORMAT, items: pack.items || [] });
  }

  function buildIndexes(corps) {
    const byId = new Map();
    const byNameProd = new Map();
    const byName = new Map();
    corps.forEach(function (c) {
      byId.set(String(c.id), c);
      const nk = normName(c.name);
      byNameProd.set(nk + '\t' + normName(c.product), c);
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(c);
    });
    return { byId: byId, byNameProd: byNameProd, byName: byName };
  }

  function matchSnapshot(snap, indexes) {
    if (!snap) return null;
    if (snap.id != null && indexes.byId.has(String(snap.id))) return indexes.byId.get(String(snap.id));
    const nk = snap.nameKey || normName(snap.name);
    const pk = snap.productKey || normName(snap.product);
    if (nk && pk && indexes.byNameProd.has(nk + '\t' + pk)) return indexes.byNameProd.get(nk + '\t' + pk);
    if (nk && indexes.byName.has(nk)) {
      const hits = indexes.byName.get(nk);
      if (hits.length === 1) return hits[0];
    }
    return null;
  }

  function matchesCategory(c, token) {
    if (!token || token === 'any') return true;
    if (token.indexOf('group:') === 0) return c.group === token.slice(6);
    if (token.indexOf('icon:') === 0) return c.iconKey === token.slice(5);
    if (token.indexOf('section:') === 0) return c.section === token.slice(8);
    return c.iconKey === token || c.group === token || c.section === token;
  }

  function matchesView(c, root) {
    const q = ((root.querySelector('#sc-corp-search') || {}).value || '').trim().toLowerCase();
    if (q && (c.name + ' ' + c.product + ' ' + c.section + ' ' + c.id).toLowerCase().indexOf(q) === -1) return false;
    const cat = (root.querySelector('#sc-corp-fcat') || {}).value || 'any';
    if (!matchesCategory(c, cat)) return false;
    const prod = (root.querySelector('#sc-corp-fprod') || {}).value || 'any';
    if (prod !== 'any' && c.product !== prod) return false;
    const hireMin = emptyToNull(valOf(root, '#sc-corp-fhmin'));
    const hireMax = emptyToNull(valOf(root, '#sc-corp-fhmax'));
    if (!inRange(c.hiring, hireMin, hireMax)) return false;
    if (c.fields && c.fields.miSaleStrat) {
      const sellF = valOf(root, '#sc-corp-fsell') || 'any';
      if (sellF !== 'any') {
        const cur = checkedRadio(c.table && c.table.closest('form'), 'miSaleStrat' + c.id) || c.sellMode;
        if (cur !== sellF) return false;
      }
      const buyF = valOf(root, '#sc-corp-fbuy') || 'any';
      if (buyF !== 'any') {
        const cur = checkedRadio(c.table && c.table.closest('form'), 'miBuyStrat' + c.id) || c.buyMode;
        if (cur !== buyF) return false;
      }
      if (!inRange(c.quality, emptyToNull(valOf(root, '#sc-corp-fqmin')), emptyToNull(valOf(root, '#sc-corp-fqmax')))) return false;
    }
    if (c.fields && c.fields.miL) {
      if (!inRange(c.quality || 0, emptyToNull(valOf(root, '#sc-corp-fqmin')), emptyToNull(valOf(root, '#sc-corp-fqmax')))) return false;
      if (!inRange(c.lw || 0, emptyToNull(valOf(root, '#sc-corp-flwmin')), emptyToNull(valOf(root, '#sc-corp-flwmax')))) return false;
      if (!inRange(c.oq || 0, emptyToNull(valOf(root, '#sc-corp-foqmin')), emptyToNull(valOf(root, '#sc-corp-foqmax')))) return false;
    }
    if (c.pick && (c.pick.name === 'miOrderID' || c.pick.name === 'miContractID')) {
      if (!inRange(c.amount || 0, emptyToNull(valOf(root, '#sc-corp-famtmin')), emptyToNull(valOf(root, '#sc-corp-famtmax')))) return false;
      if (!inRange(c.surplus || 0, emptyToNull(valOf(root, '#sc-corp-fsurmin')), emptyToNull(valOf(root, '#sc-corp-fsurmax')))) return false;
    }
    if (c.qtyEl || (c.fields && c.fields.miQuantityCA && !c.fields.miActionCA)) {
      if (!inRange(c.capacity || 0, emptyToNull(valOf(root, '#sc-corp-fcapmin')), emptyToNull(valOf(root, '#sc-corp-fcapmax')))) return false;
      if (!inRange(c.qty || 0, emptyToNull(valOf(root, '#sc-corp-fqtymin')), emptyToNull(valOf(root, '#sc-corp-fqtymax')))) return false;
    }
    if (c.fields && c.fields.miTcash) {
      if (!inRange((c.profit || 0) / 1e9, emptyToNull(valOf(root, '#sc-corp-fprofitmin')), emptyToNull(valOf(root, '#sc-corp-fprofitmax')))) return false;
      if (!inRange((c.cash || 0) / 1e9, emptyToNull(valOf(root, '#sc-corp-fcashmin')), emptyToNull(valOf(root, '#sc-corp-fcashmax')))) return false;
      if (!inRange((c.debt || 0) / 1e9, emptyToNull(valOf(root, '#sc-corp-fdebtmin')), emptyToNull(valOf(root, '#sc-corp-fdebtmax')))) return false;
    }
    if (c.table && c.strat0) {
      const modeF = valOf(root, '#sc-corp-fmode') || 'any';
      if (modeF !== 'any' && currentMode(c) !== modeF) return false;
      if (!inRange(c.current, emptyToNull(valOf(root, '#sc-corp-fcmin')), emptyToNull(valOf(root, '#sc-corp-fcmax')))) return false;
      const tgtMin = emptyToNull(valOf(root, '#sc-corp-ftmin'));
      const tgtMax = emptyToNull(valOf(root, '#sc-corp-ftmax'));
      if (tgtMin != null || tgtMax != null) {
        if (!inRange(fieldTarget(c), tgtMin, tgtMax)) return false;
      }
      if (!inRange(c.welfare, emptyToNull(valOf(root, '#sc-corp-fwmin')), emptyToNull(valOf(root, '#sc-corp-fwmax')))) return false;
    } else if (root.querySelector('#sc-corp-fpmin, #sc-corp-fvmin, #sc-corp-funsold, #sc-corp-fsup')) {
      if (!inRange(c.production, emptyToNull(valOf(root, '#sc-corp-fpmin')), emptyToNull(valOf(root, '#sc-corp-fpmax')))) return false;
      const vmin = emptyToNull(valOf(root, '#sc-corp-fvmin'));
      const vmax = emptyToNull(valOf(root, '#sc-corp-fvmax'));
      if (vmin != null || vmax != null) {
        const unit = 1e9;
        if (!inRange(c.value / unit, vmin, vmax)) return false;
      }
      const unsold = valOf(root, '#sc-corp-funsold') || 'any';
      if (unsold !== 'any' && normName(c.unsold) !== normName(unsold)) return false;
      const supplies = valOf(root, '#sc-corp-fsup') || 'any';
      if (supplies !== 'any' && normName(c.supplies) !== normName(supplies)) return false;
    }
    return true;
  }

  function valOf(root, sel) {
    const el = root.querySelector(sel);
    return el ? el.value : '';
  }

  function sortCorps(items, key, dir, mode) {
    items.sort(function (a, b) {
      let cmp = 0;
      if (key === 'original') cmp = a.origIndex - b.origIndex;
      else if (key === 'name') cmp = a.name.localeCompare(b.name);
      else if (key === 'product') cmp = a.product.localeCompare(b.product) || a.name.localeCompare(b.name);
      else if (key === 'section') cmp = a.section.localeCompare(b.section) || a.name.localeCompare(b.name);
      else if (key === 'current') cmp = a.current - b.current;
      else if (key === 'target') cmp = fieldTarget(a) - fieldTarget(b);
      else if (key === 'increase') cmp = fieldIncrease(a) - fieldIncrease(b);
      else if (key === 'welfare') cmp = a.welfare - b.welfare;
      else if (key === 'hiring') cmp = a.hiring - b.hiring;
      else if (key === 'value') cmp = a.value - b.value;
      else if (key === 'production') cmp = a.production - b.production;
      else if (key === 'unsold') cmp = String(a.unsold).localeCompare(String(b.unsold));
      else if (key === 'quality') cmp = a.quality - b.quality;
      else if (key === 'sellStart') cmp = a.sellStart - b.sellStart;
      else if (key === 'buyStart') cmp = a.buyStart - b.buyStart;
      else if (key === 'lw') cmp = (a.lw || 0) - (b.lw || 0);
      else if (key === 'oq') cmp = (a.oq || 0) - (b.oq || 0);
      else if (key === 'profit') cmp = (a.profit || 0) - (b.profit || 0);
      else if (key === 'cash') cmp = (a.cash || 0) - (b.cash || 0);
      else if (key === 'debt') cmp = (a.debt || 0) - (b.debt || 0);
      else if (key === 'tax') cmp = (a.tax || 0) - (b.tax || 0);
      else if (key === 'qty') cmp = (a.qty || 0) - (b.qty || 0);
      else if (key === 'stock') cmp = (a.stock || 0) - (b.stock || 0);
      else if (key === 'offered') cmp = (a.offered || 0) - (b.offered || 0);
      else if (key === 'capacity') cmp = (a.capacity || 0) - (b.capacity || 0);
      else if (key === 'lastProd') cmp = (a.lastProd || 0) - (b.lastProd || 0);
      else if (key === 'proposed') cmp = (a.proposed || 0) - (b.proposed || 0);
      else if (key === 'contracted') cmp = (a.contracted || 0) - (b.contracted || 0);
      else if (key === 'pct') cmp = (a.pct || 0) - (b.pct || 0);
      else if (key === 'amount') cmp = (a.amount || 0) - (b.amount || 0);
      else if (key === 'surplus') cmp = (a.surplus || 0) - (b.surplus || 0);
      else if (key === 'price') cmp = (a.price || 0) - (b.price || 0);
      else if (key === 'date') cmp = String(a.date || '').localeCompare(String(b.date || ''));
      else cmp = a.origIndex - b.origIndex;
      if (key === 'original') return cmp;
      return cmp * dir || (a.origIndex - b.origIndex);
    });
  }

  function flowPageList(corps, root) {
    const sel = root.querySelector('#sc-corp-sort');
    let key = valOf(root, '#sc-corp-sort') || settings.sortKey || 'original';
    if (sel) {
      const valid = {};
      Array.prototype.forEach.call(sel.options, function (o) { valid[o.value] = true; });
      if (!valid[key]) {
        key = 'original';
        sel.value = 'original';
      }
    }
    const dir = (valOf(root, '#sc-corp-dir') || settings.sortDir) === 'desc' ? -1 : 1;
    const tables = corps._tables || [];
    const items = [];
    corps.forEach(function (c) {
      c.row.classList.toggle('sc-corp-hide', !matchesView(c, root));
      items.push(c);
    });

    function tableChrome(table) {
      const parent = tableBody(table);
      const chrome = [];
      Array.prototype.forEach.call((parent && (parent.rows || parent.children)) || [], function (tr) {
        if (tr.getAttribute && tr.getAttribute('data-sc-corp-chrome') === '1') chrome.push(tr);
      });
        return chrome;
    }

    if (key === 'original') {
      tables.forEach(function (table, idx) {
        tableChrome(table).forEach(function (tr) { tr.classList.remove('sc-corp-hide'); });
        const home = tableBody(table);
        const orig = (corps._origRowsByTable && corps._origRowsByTable[idx]) || [];
        orig.forEach(function (tr) { adoptRow(home, tr); });
      });
      return;
    }

    sortCorps(items, key, dir, corps._mode);
    tables.forEach(function (table) {
      tableChrome(table).forEach(function (tr) { tr.classList.add('sc-corp-hide'); });
    });
    const host = tableBody(tables[0] || (items[0] && items[0].table));
    items.forEach(function (c) { adoptRow(host || tableBody(c.table), c.row); });
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + label + '</option>';
  }

  function uniqueStatuses(corps, field) {
    const set = {};
    corps.forEach(function (c) {
      const v = (c[field] || '').trim();
      if (v) set[v] = true;
    });
      return Object.keys(set).sort();
  }

  function buildPanel(corps) {
    if (document.getElementById('sc-corp-root')) return;
    const mode = corps._mode;
    const root = document.createElement('div');
    root.id = 'sc-corp-root';
    if (!settings.panelOpen) root.classList.add('sc-corp-collapsed');

    const sortOpts = mode === 'salary'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('current', 'Current index', settings.sortKey) +
    opt('target', 'Target', settings.sortKey) +
    opt('increase', 'Increase %', settings.sortKey) +
    opt('welfare', 'Welfare', settings.sortKey) +
    opt('hiring', 'Hiring', settings.sortKey)
    : mode === 'trade'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('quality', 'Quality', settings.sortKey) +
    opt('sellStart', 'Sell start %', settings.sortKey) +
    opt('buyStart', 'Buy start %', settings.sortKey)
    : mode === 'quality'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('quality', 'Quality', settings.sortKey) +
    opt('lw', 'Low-water months', settings.sortKey) +
    opt('oq', 'Order months', settings.sortKey)
    : mode === 'funds'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('profit', 'Profit', settings.sortKey) +
    opt('cash', 'Cash', settings.sortKey) +
    opt('debt', 'Debt', settings.sortKey) +
    opt('tax', 'Tax %', settings.sortKey)
    : mode === 'offers'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('stock', 'In stock', settings.sortKey) +
    opt('offered', 'Offered', settings.sortKey) +
    opt('qty', 'Offer quantity', settings.sortKey)
    : mode === 'contracts'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('capacity', 'Production capacity', settings.sortKey) +
    opt('lastProd', 'Production last month', settings.sortKey) +
    opt('proposed', 'Proposed quantity', settings.sortKey) +
    opt('contracted', 'Accepted contracts', settings.sortKey) +
    opt('pct', '% contracted', settings.sortKey) +
    opt('qty', 'Contract now', settings.sortKey)
    : mode === 'retract' || mode === 'cancel'
    ? opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Corporation', settings.sortKey) +
    opt('product', 'Product', settings.sortKey) +
    opt('amount', 'Amount', settings.sortKey) +
    opt('price', 'Requested price', settings.sortKey) +
    opt('date', 'Date ordered', settings.sortKey) +
    opt('surplus', 'Surplus', settings.sortKey)
    : opt('original', 'Original order', settings.sortKey) +
    opt('name', 'Name', settings.sortKey) +
    opt('product', 'Product type', settings.sortKey) +
    opt('section', 'Section', settings.sortKey) +
    opt('value', 'Value', settings.sortKey) +
    opt('production', 'Production', settings.sortKey) +
    opt('hiring', 'Hiring', settings.sortKey) +
    opt('unsold', 'Unsold products', settings.sortKey);

    const extraFilters = mode === 'trade'
    ? '<div class="sc-corp-row">' +
    '<label>Q <input class="sc-corp-mini" type="number" id="sc-corp-fqmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fqmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row"><label>Sell <select id="sc-corp-fsell">' +
    opt('any', 'Any sell', 'any') +
    opt('3', 'Best price', 'any') +
    opt('6', 'Time based', 'any') +
    '</select></label></div>' +
    '<div class="sc-corp-row"><label>Buy <select id="sc-corp-fbuy">' +
    opt('any', 'Any buy', 'any') +
    opt('3', 'Best price', 'any') +
    opt('6', 'Time based', 'any') +
    '</select></label></div>'
    : mode === 'quality'
    ? '<div class="sc-corp-row">' +
    '<label>Q <input class="sc-corp-mini" type="number" id="sc-corp-fqmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fqmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>LW <input class="sc-corp-mini" type="number" id="sc-corp-flwmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-flwmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Ord <input class="sc-corp-mini" type="number" id="sc-corp-foqmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-foqmax" placeholder="max"></label>' +
    '</div>'
    : mode === 'funds'
    ? '<div class="sc-corp-row">' +
    '<label>Pft B <input class="sc-corp-mini" type="number" id="sc-corp-fprofitmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fprofitmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Cash B <input class="sc-corp-mini" type="number" id="sc-corp-fcashmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fcashmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Debt B <input class="sc-corp-mini" type="number" id="sc-corp-fdebtmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fdebtmax" placeholder="max"></label>' +
    '</div>'
    : (mode === 'retract' || mode === 'cancel')
    ? '<div class="sc-corp-row">' +
    '<label>Amt <input class="sc-corp-mini" type="number" id="sc-corp-famtmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-famtmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Surp <input class="sc-corp-mini" type="number" id="sc-corp-fsurmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fsurmax" placeholder="max"></label>' +
    '</div>'
    : mode === 'contracts'
    ? '<div class="sc-corp-row">' +
    '<label>Cap <input class="sc-corp-mini" type="number" id="sc-corp-fcapmin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fcapmax" placeholder="max"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Qty <input class="sc-corp-mini" type="number" id="sc-corp-fqtymin" placeholder="min"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fqtymax" placeholder="max"></label>' +
    '</div>'
    : mode === 'offers'
    ? ''
    : mode === 'salary'
    ? '<div class="sc-corp-row">' +
    '<label>Cur <input class="sc-corp-mini" type="number" id="sc-corp-fcmin" placeholder="min" value="' + settings.filterCurMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fcmax" placeholder="max" value="' + settings.filterCurMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Tgt <input class="sc-corp-mini" type="number" id="sc-corp-ftmin" placeholder="min" value="' + settings.filterTgtMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-ftmax" placeholder="max" value="' + settings.filterTgtMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Wel <input class="sc-corp-mini" type="number" id="sc-corp-fwmin" placeholder="min" value="' + settings.filterWelMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fwmax" placeholder="max" value="' + settings.filterWelMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Hire <input class="sc-corp-mini" type="number" id="sc-corp-fhmin" placeholder="min" value="' + settings.filterHireMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fhmax" placeholder="max" value="' + settings.filterHireMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row"><label>Mode <select id="sc-corp-fmode">' +
    opt('any', 'Any strategy', settings.filterMode) +
    opt('1', 'Target index', settings.filterMode) +
    opt('0', 'Increase %', settings.filterMode) +
    '</select></label></div>'
    : '<div class="sc-corp-row">' +
    '<label>Val B <input class="sc-corp-mini" type="number" id="sc-corp-fvmin" placeholder="min" value="' + settings.filterValMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fvmax" placeholder="max" value="' + settings.filterValMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Prod <input class="sc-corp-mini" type="number" id="sc-corp-fpmin" placeholder="min" value="' + settings.filterProdMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fpmax" placeholder="max" value="' + settings.filterProdMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row">' +
    '<label>Hire <input class="sc-corp-mini" type="number" id="sc-corp-fhmin" placeholder="min" value="' + settings.filterHireMin + '"></label>' +
    '<label>– <input class="sc-corp-mini" type="number" id="sc-corp-fhmax" placeholder="max" value="' + settings.filterHireMax + '"></label>' +
    '</div>' +
    '<div class="sc-corp-row"><label>Unsold <select id="sc-corp-funsold">' +
    opt('any', 'Any unsold', settings.filterUnsold) +
    uniqueStatuses(corps, 'unsold').map(function (s) { return opt(s, s, settings.filterUnsold); }).join('') +
    '</select></label></div>' +
    '<div class="sc-corp-row"><label>Supplies <select id="sc-corp-fsup">' +
    opt('any', 'Any supplies', settings.filterSupplies) +
    uniqueStatuses(corps, 'supplies').map(function (s) { return opt(s, s, settings.filterSupplies); }).join('') +
    '</select></label></div>';

    const fieldKeys = {};
    if (mode === 'form') {
      corps.forEach(function (c) {
        Object.keys(c.fields || {}).forEach(function (k) {
          const el = (c.fields[k] || [])[0];
          const kind = fieldKind(k, el);
          if (kind === 'number' || kind === 'text') fieldKeys[k] = true;
        });
      });
    }
    const fieldOpts = Object.keys(fieldKeys).sort().map(function (k) {
      return opt(k, fieldLabel(k), '');
    }).join('');

    const tradeBlock = mode !== 'trade' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set trade strategies</h4>' +
    '<div class="sc-corp-row"><label>Sell <select id="sc-corp-sellmode">' +
    opt('6', 'Time based', '6') +
    opt('3', 'Best price', '3') +
    '</select></label></div>' +
    '<div class="sc-corp-row">' +
    '<label>Start % <input type="number" id="sc-corp-sellstart" min="0" max="999" value="400"></label>' +
    '<label>Lower % <input type="number" id="sc-corp-selllower" min="0" max="99" value="8"></label>' +
    '</div>' +
    '<div class="sc-corp-row"><label><input type="checkbox" id="sc-corp-followq" checked> Follow quality</label></div>' +
    '<div class="sc-corp-actions"><button type="button" class="sc-btn ok" data-act="apply-sell">Apply sell to checked</button></div>' +
    '<div class="sc-corp-row"><label>Buy <select id="sc-corp-buymode">' +
    opt('6', 'Time based', '6') +
    opt('3', 'Best price', '3') +
    '</select></label></div>' +
    '<div class="sc-corp-row">' +
    '<label>Start % <input type="number" id="sc-corp-buystart" min="0" max="999" value="62"></label>' +
    '<label>Raise % <input type="number" id="sc-corp-buyraise" min="0" max="99" value="6"></label>' +
    '</div>' +
    '<div class="sc-corp-actions"><button type="button" class="sc-btn ok" data-act="apply-buy">Apply buy to checked</button></div>' +
    '</div>';

    const qualityBlock = mode !== 'quality' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set supply quality / months</h4>' +
    '<div class="sc-corp-row"><label>Orders <select id="sc-corp-os">' +
    opt('1', 'On (months)', '1') +
    opt('0', 'Off', '0') +
    '</select></label></div>' +
    '<div class="sc-corp-row">' +
    '<label>LW <input type="number" id="sc-corp-lw" min="0" value="14"></label>' +
    '<label>Ord <input type="number" id="sc-corp-oq" min="0" value="16"></label>' +
    '</div>' +
    '<div class="sc-corp-row"><label>Quality mode <select id="sc-corp-qs">' +
    opt('2', 'Fixed quality', '2') +
    opt('1', 'Any quality', '1') +
    '</select></label></div>' +
    '<div class="sc-corp-row"><label>Quality <input type="number" id="sc-corp-qval" min="120" max="330" value="160"></label></div>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn ok" data-act="apply-quality">Apply to checked</button>' +
    '<button type="button" class="sc-btn" data-act="quality-months">Months only</button>' +
    '<button type="button" class="sc-btn" data-act="quality-only">Quality only</button>' +
    '</div>' +
    '</div>';

    const fundsBlock = mode !== 'funds' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set cash transfers</h4>' +
    '<div class="sc-corp-help">Fills the Transfer Cash box on checked rows. Units are the same as the page field. Save with Transfer Funds.</div>' +
    '<div class="sc-corp-row"><label>Amount <input type="number" id="sc-corp-tamt" step="1" value=""></label></div>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn ok" data-act="apply-funds">Apply amount</button>' +
    '<button type="button" class="sc-btn alt" data-act="clear-funds">Clear amounts</button>' +
    '</div>' +
    '</div>';

    const offersBlock = mode !== 'offers' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set offer / retract</h4>' +
    '<div class="sc-corp-row"><label>Action <select id="sc-corp-oact">' +
    opt('0', 'No change', '0') +
    opt('1', 'Retract offers', '1') +
    opt('2', 'Offer quantity', '2') +
    '</select></label></div>' +
    '<div class="sc-corp-row"><label>Qty <input type="number" id="sc-corp-oqty" min="0" value="0"></label></div>' +
    '<div class="sc-corp-actions"><button type="button" class="sc-btn ok" data-act="apply-offers">Apply to checked</button></div>' +
    '</div>';

    const contractsBlock = mode !== 'contracts' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set contract quantity</h4>' +
    '<div class="sc-corp-row"><label>Qty <input type="number" id="sc-corp-cqty" min="0" value="0"></label></div>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn ok" data-act="apply-contracts">Set quantity</button>' +
    '<button type="button" class="sc-btn" data-act="max-contracts">Max</button>' +
    '<button type="button" class="sc-btn alt" data-act="clear-contracts">Clear</button>' +
    '</div>' +
    '</div>';

    const formBlock = mode !== 'form' || !fieldOpts ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set form fields</h4>' +
    '<div class="sc-corp-help">Works on any numeric or text input in the checked rows. Use this on upgrades, hiring, offers, and similar pages.</div>' +
    '<div class="sc-corp-row"><label style="width:100%;">Field <select class="sc-corp-wide" id="sc-corp-ffield">' + fieldOpts + '</select></label></div>' +
    '<div class="sc-corp-row">' +
    '<label>Set <input type="number" id="sc-corp-fset" step="0.1"></label>' +
    '<label>or +/− <input type="number" id="sc-corp-foff" step="0.1" value="0"></label>' +
    '</div>' +
    '<div class="sc-corp-actions"><button type="button" class="sc-btn ok" data-act="apply-field">Apply field to checked</button></div>' +
    '</div>';

    const salaryBlock = mode !== 'salary' ? '' :
    '<div class="sc-corp-section">' +
    '<h4>Set salaries</h4>' +
    '<div class="sc-corp-row"><label>Mode <select id="sc-corp-mode">' +
    opt('1', 'Target index', settings.mode) +
    opt('0', 'Increase %', settings.mode) +
    '</select></label></div>' +
    '<div class="sc-corp-row">' +
    '<label>Target <input type="number" id="sc-corp-target" min="0" max="999" step="0.1" value="' + settings.target + '"></label>' +
    '<label>Inc % <input type="number" id="sc-corp-inc" min="0" max="999" step="0.1" value="' + settings.increase + '"></label>' +
    '</div>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn ok" data-act="apply">Apply to checked</button>' +
    '<button type="button" class="sc-btn" data-act="target-300">Target 300</button>' +
    '<button type="button" class="sc-btn" data-act="target-current">Target = current</button>' +
    '</div>' +
    '</div>';

    root.innerHTML =
    '<div class="sc-corp-head" id="sc-corp-drag">' +
    '<h3>' + (mode === 'salary' ? 'Salary Toolbox'
    : mode === 'trade' ? 'Trade Toolbox'
    : mode === 'quality' ? 'Supply Quality Toolbox'
    : mode === 'funds' ? 'Cash Transfer Toolbox'
    : mode === 'offers' ? 'Offer / Retract Toolbox'
    : mode === 'contracts' ? 'Production Contracts Toolbox'
    : mode === 'retract' ? 'Retract Orders Toolbox'
    : mode === 'cancel' ? 'Cancel Contracts Toolbox'
    : mode === 'form' ? 'Corp Form Toolbox'
    : 'Corp List Toolbox') + '</h3>' +
    '<button type="button" id="sc-corp-toggle">' + (settings.panelOpen ? '–' : '+') + '</button>' +
    '</div>' +
    '<div class="sc-corp-body">' +
    '<div class="sc-corp-help">Checkbox selects a corporation. Category and product type filters apply to every list on this page, including public and enterprise corps.</div>' +
    '<div class="sc-corp-section">' +
    '<h4>Sort / filter list</h4>' +
    '<div class="sc-corp-row">' +
    '<select id="sc-corp-sort">' + sortOpts + '</select>' +
    '<select id="sc-corp-dir">' +
    opt('asc', 'Asc', settings.sortDir) +
    opt('desc', 'Desc', settings.sortDir) +
    '</select>' +
    '</div>' +
    '<input type="text" id="sc-corp-search" placeholder="Filter by corporation name…" autocomplete="off">' +
    '<div class="sc-corp-row"><label style="width:100%;">Category<select class="sc-corp-wide" id="sc-corp-fcat"></select></label></div>' +
    '<div class="sc-corp-row"><label style="width:100%;">Product type<select class="sc-corp-wide" id="sc-corp-fprod"></select></label></div>' +
    extraFilters +
    '</div>' +
    '<div class="sc-corp-section">' +
    '<h4>Selection</h4>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn" data-sel="all">Check visible</button>' +
    '<button type="button" class="sc-btn alt" data-sel="none">Uncheck all</button>' +
    '<button type="button" class="sc-btn alt" data-sel="invert">Invert visible</button>' +
    '<button type="button" class="sc-btn" data-sel="military">Check military</button>' +
    '<button type="button" class="sc-btn" data-sel="industry">Check industry</button>' +
    '<button type="button" class="sc-btn" data-sel="civilian">Check civilian</button>' +
    '</div>' +
    '<div class="sc-corp-status" id="sc-corp-count"></div>' +
    '</div>' +
    (mode === 'list'
    ? '<div class="sc-corp-section"><h4>Bookmarks</h4>' +
    '<div class="sc-corp-help">Saved for ' + ownerScope().label + ' only. Country and enterprise lists stay separate. ★ sits between Value and Unsold. The bookmark checkbox selects the same corporation as the list checkbox.</div>' +
    '<div class="sc-corp-actions">' +
    '<button type="button" class="sc-btn ok" data-bm="add">Bookmark checked</button>' +
    '<button type="button" class="sc-btn alt" data-bm="remove">Remove checked</button>' +
    '<button type="button" class="sc-btn alt" data-bm="clear">Clear this ' + (ownerScope().kind === 'e' ? 'enterprise' : 'country') + '</button>' +
    '</div></div>'
    : '') +
    tradeBlock +
    salaryBlock +
    qualityBlock +
    fundsBlock +
    offersBlock +
    contractsBlock +
    formBlock +
      (mode === 'list' ? '' :
      '<div class="sc-corp-section">' +
      '<h4>Named revisions</h4>' +
      '<div class="sc-corp-help">Stores current field values. New corporations added later stay unchanged on restore.</div>' +
      '<input type="text" id="sc-corp-revname" placeholder="Revision name…" autocomplete="off">' +
      '<div class="sc-corp-actions">' +
      '<button type="button" class="sc-btn ok" data-rev="save">Save all</button>' +
      '<button type="button" class="sc-btn" data-rev="save-checked">Save checked</button>' +
      '</div>' +
      '<select id="sc-corp-revlist"></select>' +
      '<div class="sc-corp-actions">' +
      '<button type="button" class="sc-btn ok" data-rev="restore">Restore</button>' +
      '<button type="button" class="sc-btn alt" data-rev="rename">Rename</button>' +
      '<button type="button" class="sc-btn alt" data-rev="delete">Delete</button>' +
      '</div>' +
      '</div>') +
      '<div class="sc-corp-status" id="sc-corp-msg">' +
      (mode === 'salary' ? 'Ready. Use Set Salary Changes on the page to save.'
      : mode === 'trade' ? 'Ready. Use the site save button after applying trade strategies.'
      : mode === 'quality' ? 'Ready. Use Save Order Quantities and Quality after applying.'
      : mode === 'funds' ? 'Ready. Use Transfer Funds after filling amounts.'
      : mode === 'offers' ? 'Ready. Use Offer and/or Retract Products after applying.'
      : mode === 'contracts' ? 'Ready. Use the site Submit button after setting quantities.'
      : mode === 'retract' ? 'Ready. Check orders here, then Cancel the Selected Orders on the page.'
      : mode === 'cancel' ? 'Ready. Check contracts here, then cancel marked contracts on the page.'
      : mode === 'form' ? 'Ready. Apply fields, then use the site submit button.'
      : 'Ready. Filters apply to every corporation table on this page.') +
      '</div>' +
      '</div>';

      document.body.appendChild(root);
      root.setAttribute('data-sc-mode', mode);
      fillCategorySelect(root, corps);
      fillProductSelect(root, corps);
      if (mode !== 'list') fillRevisionSelect(root);
      wirePanel(root, corps);
    makeDraggable(root, root.querySelector('#sc-corp-drag'));
    flowPageList(corps, root);
    refreshCount(corps);
  }

  function refreshCount(corps) {
    const root = document.getElementById('sc-corp-root');
    if (!root) return;
    let vis = 0;
    corps.forEach(function (c) { if (matchesView(c, root)) vis += 1; });
    const el = root.querySelector('#sc-corp-count');
    if (el) el.textContent = selectedList(corps).length + ' checked · ' + vis + ' listed · ' + corps.size + ' total';
  }

  function persist(root) {
    settings.sortKey = valOf(root, '#sc-corp-sort');
    settings.sortDir = valOf(root, '#sc-corp-dir');
    settings.filterCategory = valOf(root, '#sc-corp-fcat') || 'any';
    settings.filterProduct = valOf(root, '#sc-corp-fprod') || 'any';
    settings.filterMode = valOf(root, '#sc-corp-fmode') || settings.filterMode;
    settings.filterUnsold = valOf(root, '#sc-corp-funsold') || settings.filterUnsold;
    settings.filterSupplies = valOf(root, '#sc-corp-fsup') || settings.filterSupplies;
    settings.filterCurMin = valOf(root, '#sc-corp-fcmin');
    settings.filterCurMax = valOf(root, '#sc-corp-fcmax');
    settings.filterTgtMin = valOf(root, '#sc-corp-ftmin');
    settings.filterTgtMax = valOf(root, '#sc-corp-ftmax');
    settings.filterWelMin = valOf(root, '#sc-corp-fwmin');
    settings.filterWelMax = valOf(root, '#sc-corp-fwmax');
    settings.filterHireMin = valOf(root, '#sc-corp-fhmin');
    settings.filterHireMax = valOf(root, '#sc-corp-fhmax');
    settings.filterProdMin = valOf(root, '#sc-corp-fpmin');
    settings.filterProdMax = valOf(root, '#sc-corp-fpmax');
    settings.filterValMin = valOf(root, '#sc-corp-fvmin');
    settings.filterValMax = valOf(root, '#sc-corp-fvmax');
    if (root.querySelector('#sc-corp-target')) settings.target = num(valOf(root, '#sc-corp-target'));
    if (root.querySelector('#sc-corp-inc')) settings.increase = num(valOf(root, '#sc-corp-inc'));
    if (root.querySelector('#sc-corp-mode')) settings.mode = valOf(root, '#sc-corp-mode');
    saveSettings();
  }

  function say(text) {
    const el = document.querySelector('#sc-corp-msg');
    if (el) el.textContent = text;
  }

  function fillCategorySelect(root, corps) {
    const sel = root.querySelector('#sc-corp-fcat');
    if (!sel) return;
    const icons = {};
    const secs = {};
    const groups = {};
    corps.forEach(function (c) {
      icons[c.iconKey] = (icons[c.iconKey] || 0) + 1;
      secs[c.section] = (secs[c.section] || 0) + 1;
      groups[c.group] = (groups[c.group] || 0) + 1;
    });
    function add(parent, value, label) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      parent.appendChild(o);
    }
    sel.innerHTML = '';
    add(sel, 'any', 'All categories');
    const g1 = document.createElement('optgroup');
    g1.label = 'Groups';
    ['military', 'industry', 'civilian'].forEach(function (k) {
      if (groups[k]) add(g1, 'group:' + k, k.charAt(0).toUpperCase() + k.slice(1) + ' (' + groups[k] + ')');
    });
      sel.appendChild(g1);
      const g2 = document.createElement('optgroup');
      g2.label = 'Product categories';
      Object.keys(icons).sort().forEach(function (k) {
        add(g2, 'icon:' + k, categoryLabel(k) + ' (' + icons[k] + ')');
      });
      sel.appendChild(g2);
      const g3 = document.createElement('optgroup');
      g3.label = 'Lists';
      Object.keys(secs).forEach(function (s) {
        add(g3, 'section:' + s, s + ' (' + secs[s] + ')');
      });
      sel.appendChild(g3);
      try { if (settings.filterCategory) sel.value = settings.filterCategory; } catch (e) { /* ignore */ }
  }

  function fillProductSelect(root, corps) {
    const sel = root.querySelector('#sc-corp-fprod');
    if (!sel) return;
    const keep = sel.value || settings.filterProduct || 'any';
    const cat = (root.querySelector('#sc-corp-fcat') || {}).value || 'any';
    const counts = {};
    corps.forEach(function (c) {
      if (!matchesCategory(c, cat)) return;
      counts[c.product] = (counts[c.product] || 0) + 1;
    });
    const names = Object.keys(counts).sort();
    sel.innerHTML = '';
    const any = document.createElement('option');
    any.value = 'any';
    let total = 0;
    names.forEach(function (n) { total += counts[n]; });
    any.textContent = 'All product types (' + total + ')';
    sel.appendChild(any);
    names.forEach(function (name) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + ' (' + counts[name] + ')';
      sel.appendChild(o);
    });
    sel.value = keep && sel.querySelector('option[value="' + keep.replace(/"/g, '\\"') + '"]') ? keep : 'any';
  }

  function fillRevisionSelect(root, keepId) {
    const sel = root.querySelector('#sc-corp-revlist');
    if (!sel) return;
    const pack = loadRevisions();
    const pageKind = root.getAttribute('data-sc-mode') || '';
    const items = pack.items.filter(function (rev) {
      if (!rev.kind) return pageKind === 'salary' || pageKind === '';
      return rev.kind === pageKind;
    }).sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    const current = keepId || sel.value;
    sel.innerHTML = '';
    if (!items.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(no revisions saved)';
      sel.appendChild(o);
      return;
    }
    items.forEach(function (rev) {
      const o = document.createElement('option');
      o.value = rev.id;
      const n = (rev.corps && rev.corps.length) || 0;
      const when = rev.savedAt ? String(rev.savedAt).replace('T', ' ').slice(0, 16) : '';
      o.textContent = rev.name + ' · ' + n + ' corps' + (when ? ' · ' + when : '');
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function selectedRevision(root) {
    const id = valOf(root, '#sc-corp-revlist');
    if (!id) return null;
    const pack = loadRevisions();
    for (let i = 0; i < pack.items.length; i++) {
      if (pack.items[i].id === id) return pack.items[i];
    }
    return null;
  }

  function newRevisionId() {
    return 'sal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function wirePanel(root, corps) {
    root.querySelector('#sc-corp-toggle').addEventListener('click', function () {
      settings.panelOpen = !settings.panelOpen;
      root.classList.toggle('sc-corp-collapsed', !settings.panelOpen);
      root.querySelector('#sc-corp-toggle').textContent = settings.panelOpen ? '–' : '+';
      saveSettings();
    });

    function relist() {
      persist(root);
      flowPageList(corps, root);
      refreshCount(corps);
    }

    root.querySelectorAll('select, input').forEach(function (el) {
      if (el.id === 'sc-corp-fcat') return;
      if (el.id === 'sc-corp-revname' || el.id === 'sc-corp-revlist') return;
      el.addEventListener('input', relist);
      el.addEventListener('change', relist);
    });

    const catSel = root.querySelector('#sc-corp-fcat');
    if (catSel) {
      catSel.addEventListener('change', function () {
        fillProductSelect(root, corps);
        relist();
      });
    }

    document.addEventListener('change', function (ev) {
      const t = ev.target;
      if (!t || !t.classList) return;
      if (t.classList.contains('sc-corp-pick-alias')) {
        const id = t.getAttribute('data-sc-corp-id');
        const rec = corps.get(id);
        if (rec) setSelected(rec, t.checked);
        refreshCount(corps);
        return;
      }
      if (t.classList.contains('sc-corp-pick')) {
        const row = t.closest('tr');
        if (row) row.classList.toggle('sc-corp-selected', t.checked);
        const id = t.getAttribute('data-sc-corp-id') || (row && row.getAttribute('data-sc-corp-id'));
        const rec = id ? corps.get(id) : null;
        if (rec) setSelected(rec, t.checked);
        refreshCount(corps);
      }
    });

    root.addEventListener('click', function (ev) {
      const selBtn = ev.target.closest('[data-sel]');
      if (selBtn) {
        runSelection(selBtn.getAttribute('data-sel'), corps, root);
        refreshCount(corps);
        return;
      }
      const bmBtn = ev.target.closest('[data-bm]');
      if (bmBtn) {
        runBookmarks(bmBtn.getAttribute('data-bm'), corps);
        return;
      }
      const revBtn = ev.target.closest('[data-rev]');
      if (revBtn) {
        persist(root);
        runRevision(revBtn.getAttribute('data-rev'), corps, root);
        flowPageList(corps, root);
        refreshCount(corps);
        return;
      }
      const actBtn = ev.target.closest('[data-act]');
      if (actBtn) {
        persist(root);
        runAction(actBtn.getAttribute('data-act'), corps, root);
        flowPageList(corps, root);
        refreshCount(corps);
      }
    });
  }

  function runBookmarks(kind, corps) {
    if (corps._mode !== 'list') return;
    if (kind === 'clear') {
      const scope = ownerScope();
      if (!window.confirm('Clear all bookmarks for ' + scope.label + '? Other countries and enterprises are not affected.')) return;
      setBookmarks([]);
      paintBookmarkButtons(corps);
      renderBookmarkBlock(corps);
      say('Cleared bookmarks for ' + scope.label + '.');
      return;
    }
    const list = selectedList(corps);
    if (!list.length) {
      say('Check one or more corporations first.');
      return;
    }
    if (kind === 'add') {
      addBookmarks(corps, list.map(bookmarkRecord));
      say('Bookmarked ' + list.length + ' for ' + ownerScope().label + '.');
      return;
    }
    if (kind === 'remove') {
      removeBookmarks(corps, list.map(function (c) { return c.id; }));
      say('Removed ' + list.length + ' bookmark' + (list.length === 1 ? '' : 's') + '.');
    }
  }

  function runSelection(kind, corps, root) {
    corps.forEach(function (c) {
      const listed = matchesView(c, root);
      let on = isSelected(c);
      if (kind === 'all') on = listed;
      else if (kind === 'none') on = false;
      else if (kind === 'invert') on = listed ? !on : on;
      else if (kind === 'military' || kind === 'industry' || kind === 'civilian') on = listed && c.group === kind;
      setSelected(c, on);
    });
  }

  function runAction(act, corps, root) {
    const list = selectedList(corps);
    if (!list.length) {
      say('Check one or more corporations first.');
      return;
    }
    const form = corps._form || findWorkForm(corps._mode);
    if (act === 'apply-sell' || act === 'apply-buy') {
      const spec = {};
      if (act === 'apply-sell') {
        spec.sellMode = valOf(root, '#sc-corp-sellmode') || '6';
        spec.sellStart = num(valOf(root, '#sc-corp-sellstart'));
        spec.sellLower = num(valOf(root, '#sc-corp-selllower'));
        spec.sellFollowQ = !!(root.querySelector('#sc-corp-followq') && root.querySelector('#sc-corp-followq').checked);
      } else {
        spec.buyMode = valOf(root, '#sc-corp-buymode') || '6';
        spec.buyStart = num(valOf(root, '#sc-corp-buystart'));
        spec.buyRaise = num(valOf(root, '#sc-corp-buyraise'));
      }
      const summary = act === 'apply-sell'
      ? ('Apply SELL ' + (spec.sellMode === '3' ? 'Best price' : ('Time start ' + spec.sellStart + '% lower ' + spec.sellLower + '%')) + '.')
      : ('Apply BUY ' + (spec.buyMode === '3' ? 'Best price' : ('Time start ' + spec.buyStart + '% raise ' + spec.buyRaise + '%')) + '.');
      if (!window.confirm(summary + '\n\n' + list.length + ' corporation' + (list.length === 1 ? '' : 's') +
        ' will be updated in the form.\nSave with the site button when ready.')) {
        say('Cancelled.');
      return;
        }
        list.forEach(function (c) { applyTrade(c, form, spec); });
        say('Updated trade strategy on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
        return;
    }
    if (act === 'apply-field') {
      const key = valOf(root, '#sc-corp-ffield');
      const setRaw = valOf(root, '#sc-corp-fset');
      const off = num(valOf(root, '#sc-corp-foff'));
      if (!key) {
        say('Pick a field name.');
        return;
      }
      const useSet = String(setRaw).trim() !== '';
      if (!window.confirm((useSet ? ('Set ' + key + ' to ' + setRaw) : ('Offset ' + key + ' by ' + off)) +
        ' on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '?\nSave with the site button when ready.')) {
        say('Cancelled.');
      return;
        }
        list.forEach(function (c) {
          (c.fields[key] || []).forEach(function (el) {
            if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'hidden') return;
            if (useSet) writeInput(el, setRaw);
            else writeInput(el, num(el.value) + off);
          });
        });
        say('Updated field ' + key + ' on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
        return;
    }
    if (act === 'apply-quality' || act === 'quality-months' || act === 'quality-only') {
      const spec = {};
      if (act !== 'quality-only') {
        spec.os = valOf(root, '#sc-corp-os') || '1';
        spec.lw = num(valOf(root, '#sc-corp-lw'));
        spec.oq = num(valOf(root, '#sc-corp-oq'));
      }
      if (act !== 'quality-months') {
        spec.qs = valOf(root, '#sc-corp-qs') || '2';
        spec.quality = clampQ(valOf(root, '#sc-corp-qval'));
      }
      const bits = [];
      if (spec.os != null) bits.push('orders ' + (spec.os === '0' ? 'off' : 'on'));
      if (spec.lw != null) bits.push('LW ' + spec.lw);
      if (spec.oq != null) bits.push('Ord ' + spec.oq);
      if (spec.qs === '1') bits.push('any quality');
      if (spec.qs === '2') bits.push('quality ' + spec.quality);
      if (!window.confirm('Apply ' + bits.join(', ') + ' to ' + list.length +
        ' corporation' + (list.length === 1 ? '' : 's') + '?\nSave with the site button when ready.')) {
        say('Cancelled.');
      return;
        }
        list.forEach(function (c) { applyQuality(c, form, spec); });
        say('Updated supply settings on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
        return;
    }
    if (act === 'apply-funds' || act === 'clear-funds') {
      const amt = act === 'clear-funds' ? '' : valOf(root, '#sc-corp-tamt');
      if (act === 'apply-funds' && String(amt).trim() === '') {
        say('Enter a transfer amount first.');
        return;
      }
      if (!window.confirm((act === 'clear-funds' ? 'Clear transfer amounts' : ('Set transfer amount to ' + amt)) +
        ' on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '?\nUse Transfer Funds to submit.')) {
        say('Cancelled.');
      return;
        }
        list.forEach(function (c) { applyFunds(c, amt); });
        say((act === 'clear-funds' ? 'Cleared' : 'Filled') + ' transfer amounts on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
        return;
    }
    if (act === 'apply-offers') {
      const spec = {
        action: valOf(root, '#sc-corp-oact') || '0',
 qty: num(valOf(root, '#sc-corp-oqty'))
      };
      const label = spec.action === '1' ? 'Retract offers' : spec.action === '2' ? ('Offer quantity ' + spec.qty) : 'No change';
      if (!window.confirm('Apply "' + label + '" to ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '?\nSave with the site button when ready.')) {
        say('Cancelled.');
        return;
      }
      list.forEach(function (c) { applyOffers(c, form, spec); });
      say('Updated offer action on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
      return;
    }
    if (act === 'apply-contracts' || act === 'max-contracts' || act === 'clear-contracts') {
      const spec = {
        qty: num(valOf(root, '#sc-corp-cqty')),
 max: act === 'max-contracts',
 clear: act === 'clear-contracts'
      };
      const label = spec.max ? 'Maximize contract quantity' : spec.clear ? 'Clear contract quantity' : ('Set quantity to ' + spec.qty);
      if (!window.confirm(label + ' on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '?\nSave with the site Submit button when ready.')) {
        say('Cancelled.');
        return;
      }
      list.forEach(function (c) { applyContracts(c, spec); });
      say('Updated contract quantities on ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '.');
      return;
    }
    const mode = valOf(root, '#sc-corp-mode') || '1';
    const tgt = num(valOf(root, '#sc-corp-target'));
    const inc = num(valOf(root, '#sc-corp-inc'));
    let summary = '';
    if (act === 'apply') {
      summary = mode === '0'
      ? 'Set checked corps to Increase By ' + inc + '%.'
      : 'Set checked corps to Target salary index ' + tgt + '.';
    } else if (act === 'target-300') summary = 'Set checked corps to Target 300.';
    else if (act === 'target-current') summary = 'Set each checked corp target equal to its current index.';
    else return;
    if (!window.confirm(summary + '\n\n' + list.length + ' corporation' + (list.length === 1 ? '' : 's') +
      ' will be updated in the form.\nNothing is saved until you click the site save button.\n\nContinue?')) {
      say('Cancelled.');
    return;
      }
      list.forEach(function (c) {
        if (act === 'apply') applySalary(c, mode, inc, tgt);
        else if (act === 'target-300') applySalary(c, '1', 0, 300);
        else if (act === 'target-current') applySalary(c, '1', 0, c.current);
      });
        say('Updated ' + list.length + ' corporation' + (list.length === 1 ? '' : 's') + '. Review, then use the site save button.');
  }

  function runRevision(kind, corps, root) {
    const pack = loadRevisions();
    const nameBox = root.querySelector('#sc-corp-revname');
    if (kind === 'save' || kind === 'save-checked') {
      const name = String(nameBox && nameBox.value || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        say('Enter a revision name first.');
        return;
      }
      const source = kind === 'save-checked' ? selectedList(corps) : [];
      if (kind === 'save-checked' && !source.length) {
        say('Check corporations to include, or Save all.');
        return;
      }
      const snaps = [];
      if (kind === 'save') corps.forEach(function (c) { snaps.push(snapshotCorp(c)); });
      else source.forEach(function (c) { snaps.push(snapshotCorp(c)); });
      const existing = pack.items.filter(function (r) { return normName(r.name) === normName(name); })[0];
      if (existing) {
        if (!window.confirm('Overwrite revision "' + existing.name + '"?')) {
          say('Save cancelled.');
          return;
        }
        existing.savedAt = new Date().toISOString();
        existing.corps = snaps;
        existing.format = REVISION_FORMAT;
        existing.kind = corps._mode;
        existing.scope = kind === 'save-checked' ? 'checked' : 'all';
      } else {
        pack.items.push({
          id: newRevisionId(),
                        format: REVISION_FORMAT,
                          name: name,
                          savedAt: new Date().toISOString(),
                        kind: corps._mode,
                        scope: kind === 'save-checked' ? 'checked' : 'all',
                        corps: snaps
        });
      }
      storeRevisions(pack);
      fillRevisionSelect(root, existing ? existing.id : pack.items[pack.items.length - 1].id);
      say('Saved "' + name + '" (' + snaps.length + ' corps).');
      return;
    }
    const rev = selectedRevision(root);
    if (!rev) {
      say('Pick a saved revision first.');
      return;
    }
    if (kind === 'delete') {
      if (!window.confirm('Delete revision "' + rev.name + '"?')) return;
      pack.items = pack.items.filter(function (r) { return r.id !== rev.id; });
      storeRevisions(pack);
      fillRevisionSelect(root);
      say('Deleted "' + rev.name + '".');
      return;
    }
    if (kind === 'rename') {
      const name = String(nameBox && nameBox.value || '').replace(/\s+/g, ' ').trim();
      if (!name) {
        say('Type the new name in the revision name box.');
        return;
      }
      rev.name = name;
      storeRevisions(pack);
      fillRevisionSelect(root, rev.id);
      say('Renamed revision to "' + name + '".');
      return;
    }
    if (kind === 'restore') {
      const snaps = Array.isArray(rev.corps) ? rev.corps : [];
      const indexes = buildIndexes(corps);
      const matched = [];
      let missing = 0;
      snaps.forEach(function (snap) {
        const c = matchSnapshot(snap, indexes);
        if (c) matched.push({ c: c, snap: snap });
        else missing += 1;
      });
        let unmatchedNew = 0;
        const used = {};
        matched.forEach(function (m) { used[m.c.id] = true; });
        corps.forEach(function (c) { if (!used[c.id]) unmatchedNew += 1; });
        if (!window.confirm(
          'Restore "' + rev.name + '"?\n\n' +
          matched.length + ' current corporations will be updated.\n' +
          missing + ' saved items are gone and will be skipped.\n' +
          unmatchedNew + ' newer corporations have no snapshot and stay as they are.\n\n' +
          'This only fills the form. Click "Set Salary Changes" to save.'
        )) {
          say('Restore cancelled.');
          return;
        }
        const form = corps._form || findWorkForm(corps._mode);
        matched.forEach(function (m) {
          if (corps._mode === 'salary') applySalary(m.c, m.snap.mode, m.snap.increase, m.snap.target);
          if (corps._mode === 'trade') {
            applyTrade(m.c, form, {
              sellMode: m.snap.sellMode,
              sellStart: m.snap.sellStart,
              sellLower: m.snap.sellLower,
              sellFollowQ: m.snap.sellFollowQ,
              buyMode: m.snap.buyMode,
              buyStart: m.snap.buyStart,
              buyRaise: m.snap.buyRaise
            });
          }
          if (corps._mode === 'quality') {
            applyQuality(m.c, form, {
              os: m.snap.os,
              lw: m.snap.lw,
              oq: m.snap.oq,
              qs: m.snap.qs,
              quality: m.snap.quality
            });
          }
          if (m.snap.fields) applyFieldSnapshot(m.c, m.snap.fields);
        });
          say('Restored "' + rev.name + '": ' + matched.length + ' updated, ' + missing + ' skipped, ' + unmatchedNew + ' new untouched.');
    }
  }

  function makeDraggable(box, handle) {
    let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target.closest('button')) return;
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

  function init() {
    const mode = detectMode();
    if (!mode) return;
    if (document.documentElement.getAttribute(INIT_FLAG) === '1' && document.getElementById('sc-corp-root')) return;
    const corps = collectCorps(mode);
    if (!corps.size) return;
    document.documentElement.setAttribute(INIT_FLAG, '1');
    installPickboxes(corps);
    if (mode === 'list') {
      document._scCorpList = corps;
      installBookmarkButtons(corps);
      renderBookmarkBlock(corps);
    }
    buildPanel(corps);
  }

  function start() {
    init();
    const obs = new MutationObserver(function () {
      if (detectMode() && !document.getElementById('sc-corp-root')) {
        document.documentElement.removeAttribute(INIT_FLAG);
        init();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
