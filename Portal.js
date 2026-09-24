// ==UserScript==
// @name         Simcountry Desktop Enhancer
// @namespace    https://simcountry.com/userscripts
// @version      1.3.0
// @description  Drag-reorder My Countries / My Enterprises, custom sort dropdowns, and a physics-based draggable ticker on every Simcountry page that has one.
// @author       TheWalkingGlitch
// @match        https://simcountry.com/*
// @match        https://www.simcountry.com/*
// @match        https://*.simcountry.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const NS = 'scEnhancer.v1';
  const WIDGETS = [
    { id: 'mycountries', bodyId: 'gbodymycountries', label: 'Countries', kind: 'c' },
    { id: 'myenterprises', bodyId: 'gbodymyenterprises', label: 'Enterprises', kind: 'e' },
  ];

  const WORLD_FROM_HOST = {
    sim01: 'Kebir Blue',
    sim02: 'Fearless Blue',
    sim03: 'White Giant',
    sim04: 'Golden Rainbow',
    sim05: 'Little Upsilon',
    sim06: 'Tiny Atlas',
  };

  const SORT_MODES = [
    { id: 'custom', label: 'Custom (drag order)' },
    { id: 'name-asc', label: 'Name A → Z' },
    { id: 'name-desc', label: 'Name Z → A' },
    { id: 'world-name', label: 'World, then name' },
    { id: 'world-desc-name', label: 'World Z → A, then name' },
    { id: 'default', label: 'Page default' },
  ];

  const DEFAULTS = {
    widget: {
      mycountries: { mode: 'custom', order: [] },
      myenterprises: { mode: 'custom', order: [] },
    },
    ticker: {
      enabled: true,
      acceleration: 1.35,
      motionFactor: 1.8,
      friction: 0.94,
      maxSpeed: 42,
      resumeAutoAfterMs: 1600,
      invertDrag: false,
    },
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(NS);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      const parsed = JSON.parse(raw);
      return {
        widget: {
          mycountries: Object.assign({}, DEFAULTS.widget.mycountries, parsed.widget && parsed.widget.mycountries),
          myenterprises: Object.assign({}, DEFAULTS.widget.myenterprises, parsed.widget && parsed.widget.myenterprises),
        },
        ticker: Object.assign({}, DEFAULTS.ticker, parsed.ticker),
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveState(state) {
    try { localStorage.setItem(NS, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  const state = loadState();

  function injectStyles() {
    if (document.getElementById('sc-enhancer-css')) return;
    const css = document.createElement('style');
    css.id = 'sc-enhancer-css';
    css.textContent = `
      .sc-enh-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        justify-content: center;
        flex-wrap: wrap;
        padding: 4px 2px 2px;
        font: 11px/1.2 Arial, sans-serif;
        background: transparent;
        color: inherit;
      }
      .sc-enh-toolbar select {
        font: 11px Arial, sans-serif;
        max-width: 150px;
        background: #1b1b1b;
        color: #f2f2f2;
        border: 1px solid #888;
        border-radius: 3px;
        padding: 1px 2px;
      }
      .sc-enh-toolbar button {
        font: 11px Arial, sans-serif;
        background: #333;
        color: #fff;
        border: 1px solid #777;
        border-radius: 3px;
        padding: 1px 6px;
        cursor: pointer;
      }
      .sc-enh-toolbar button:hover { filter: brightness(1.15); }
      td.group.sc-enh-item {
        cursor: grab;
        position: relative;
        vertical-align: top;
      }
      td.group.sc-enh-item.sc-enh-dragging { opacity: .42; cursor: grabbing; }
      td.group.sc-enh-item.sc-enh-drop-target {
        outline: 2px dashed gold;
        outline-offset: -2px;
      }
      .sc-enh-ghost {
        position: fixed;
        pointer-events: none;
        z-index: 2147483000;
        opacity: .9;
        filter: drop-shadow(0 6px 10px rgba(0,0,0,.55));
      }
      .sc-enh-ticker-hint {
        position: absolute;
        right: 4px;
        top: 3px;
        z-index: 30;
        pointer-events: auto;
      }
      .sc-enh-ticker-hint button {
        font: 10px/1 Arial, sans-serif;
        background: rgba(20,20,20,.75);
        color: #ffe58a;
        border: 1px solid #666;
        border-radius: 3px;
        padding: 1px 5px;
        cursor: pointer;
      }
      .sc-enh-panel {
        position: fixed;
        z-index: 2147483646;
        min-width: 280px;
        max-width: 360px;
        background: #1c2330;
        color: #eee;
        border: 1px solid #889;
        border-radius: 6px;
        box-shadow: 0 10px 28px rgba(0,0,0,.45);
        padding: 10px 12px 12px;
        font: 12px/1.4 Arial, sans-serif;
      }
      .sc-enh-panel h3 { margin: 0 0 8px; font-size: 13px; color: gold; }
      .sc-enh-panel label {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        margin: 6px 0;
      }
      .sc-enh-panel input[type="range"] { width: 140px; }
      .sc-enh-panel .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
      .sc-enh-panel button {
        background: #3a4560;
        color: #fff;
        border: 1px solid #99a;
        border-radius: 3px;
        padding: 3px 8px;
        cursor: pointer;
      }
      #memdivinner.sc-enh-grabbing, #iemarquee.sc-enh-grabbing { cursor: grabbing; }
    `;
    document.head.appendChild(css);
  }

  /* ------------------------------------------------------------------ */
  /* Widget helpers                                                      */
  /* ------------------------------------------------------------------ */

  function worldFromHref(href) {
    try {
      const host = new URL(href, location.href).hostname.split('.')[0];
      return WORLD_FROM_HOST[host] || '';
    } catch (e) {
      return '';
    }
  }

  function worldFromTitle(title) {
    const m = String(title || '').match(/\bon\s+(.+)$/i);
    return m ? m[1].trim() : '';
  }

  function itemKey(node) {
    const link = node.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const eid = href.match(/miEID=([^&]+)/i);
      if (eid) return eid[1];
    }
    const titled = node.querySelector('[title]');
    const title = (titled && titled.getAttribute('title')) || node.textContent;
    return String(title || '').replace(/\s+/g, ' ').trim();
  }

  function itemMeta(node) {
    const link = node.querySelector('a[title], a[href]');
    const title = (link && (link.getAttribute('title') || link.textContent)) || node.textContent || '';
    const clean = title.replace(/\s+/g, ' ').trim();
    const name = clean.replace(/\s+on\s+.+$/i, '').trim() || clean;
    const href = link ? link.getAttribute('href') : '';
    return {
      key: itemKey(node),
      name,
      world: worldFromTitle(clean) || worldFromHref(href),
      title: clean,
    };
  }

  function findEntityCells(root) {
    const cells = [];
    root.querySelectorAll('td.group').forEach((td) => {
      if (td.querySelector('.enticonbg, .enticonfg')) cells.push(td);
    });
    return cells;
  }

  function findEntityTable(root) {
    const cells = findEntityCells(root);
    return cells.length ? cells[0].closest('table') : null;
  }

  function sortItems(items, mode, customOrder) {
    const rank = new Map((customOrder || []).map((k, i) => [k, i]));
    const copy = items.slice();
    const byName = (a, b) => a.meta.name.localeCompare(b.meta.name, undefined, { sensitivity: 'base' });
    const byWorld = (a, b) => a.meta.world.localeCompare(b.meta.world, undefined, { sensitivity: 'base' });
    switch (mode) {
      case 'name-asc': return copy.sort(byName);
      case 'name-desc': return copy.sort((a, b) => byName(b, a));
      case 'world-name': return copy.sort((a, b) => byWorld(a, b) || byName(a, b));
      case 'world-desc-name': return copy.sort((a, b) => byWorld(b, a) || byName(a, b));
      case 'default': return copy.sort((a, b) => a.defaultIndex - b.defaultIndex);
      case 'custom':
      default:
        return copy.sort((a, b) => {
          const ra = rank.has(a.meta.key) ? rank.get(a.meta.key) : 1e9 + a.defaultIndex;
          const rb = rank.has(b.meta.key) ? rank.get(b.meta.key) : 1e9 + b.defaultIndex;
          return ra - rb;
        });
    }
  }

  function mergeUnknownKeys(saved, live) {
    const have = new Set(saved);
    const out = saved.slice();
    live.forEach((k) => {
      if (!have.has(k)) {
        out.push(k);
        have.add(k);
      }
    });
    return out.filter((k) => live.includes(k));
  }

  function columnsForTable(table) {
    const first = table.querySelector('tr');
    const n = first ? first.querySelectorAll('td.group').length : 2;
    return Math.max(1, n || 2);
  }

  function paintTable(table, items, cols) {
    while (table.firstChild) table.removeChild(table.firstChild);
    let tr = null;
    items.forEach((it, i) => {
      if (i % cols === 0) {
        tr = document.createElement('tr');
        table.appendChild(tr);
      }
      tr.appendChild(it.node);
    });
  }

  function enableItemDrag(table, widgetKey, getItems, apply) {
    let dragging = null;
    let ghost = null;
    let startX = 0;
    let startY = 0;
    let armed = false;
    let moved = false;

    function cleanup() {
      if (dragging) dragging.classList.remove('sc-enh-dragging');
      table.querySelectorAll('.sc-enh-drop-target').forEach((n) => n.classList.remove('sc-enh-drop-target'));
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      dragging = null;
      ghost = null;
      armed = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    function targetFromPoint(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const item = el.closest('td.sc-enh-item');
      if (!item || !table.contains(item) || item === dragging) return null;
      return item;
    }

    function onDown(ev) {
      if (ev.button !== 0) return;
      const item = ev.target.closest('td.sc-enh-item');
      if (!item || !table.contains(item)) return;

      if (state.widget[widgetKey].mode !== 'custom') {
        state.widget[widgetKey].mode = 'custom';
        const root = table.parentNode;
        const sel = root && root.querySelector('.sc-enh-sort');
        if (sel) sel.value = 'custom';
        saveState(state);
      }

      dragging = item;
      startX = ev.clientX;
      startY = ev.clientY;
      armed = true;
      moved = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function onMove(ev) {
      if (!armed || !dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) {
        moved = true;
        dragging.classList.add('sc-enh-dragging');
        ghost = dragging.cloneNode(true);
        ghost.classList.add('sc-enh-ghost');
        const r = dragging.getBoundingClientRect();
        ghost.style.width = r.width + 'px';
        document.body.appendChild(ghost);
        ev.preventDefault();
      }
      ghost.style.left = ev.clientX + 8 + 'px';
      ghost.style.top = ev.clientY + 8 + 'px';
      table.querySelectorAll('.sc-enh-drop-target').forEach((n) => n.classList.remove('sc-enh-drop-target'));
      const over = targetFromPoint(ev.clientX, ev.clientY);
      if (over) over.classList.add('sc-enh-drop-target');
    }

    function onUp(ev) {
      if (moved && dragging) {
        const over = targetFromPoint(ev.clientX, ev.clientY);
        const items = getItems();
        const from = items.findIndex((it) => it.node === dragging);
        const to = over ? items.findIndex((it) => it.node === over) : -1;
        if (from >= 0 && to >= 0 && from !== to) {
          const next = items.slice();
          const [movedItem] = next.splice(from, 1);
          next.splice(to, 0, movedItem);
          state.widget[widgetKey].mode = 'custom';
          state.widget[widgetKey].order = next.map((it) => it.meta.key);
          saveState(state);
          apply();
        }
      }
      cleanup();
    }

    table.addEventListener('mousedown', onDown);
    table.addEventListener('click', (ev) => {
      if (moved) {
        ev.preventDefault();
        ev.stopPropagation();
        moved = false;
      }
    }, true);
    table.addEventListener('dragstart', (ev) => ev.preventDefault());
  }

  const enhancedTables = new WeakSet();

  function enhanceWidget(def, root) {
    if (!root) return;
    const table = findEntityTable(root);
    if (!table || enhancedTables.has(table)) return;
    enhancedTables.add(table);

    const rawCells = findEntityCells(root);
    if (!rawCells.length) return;
    const cols = columnsForTable(table);

    const items = rawCells.map((td, idx) => {
      td.classList.add('sc-enh-item');
      const meta = itemMeta(td);
      td.dataset.scKey = meta.key;
      return { node: td, meta, defaultIndex: idx };
    });

    const liveKeys = items.map((it) => it.meta.key);
    state.widget[def.id].order = mergeUnknownKeys(state.widget[def.id].order || [], liveKeys);
    saveState(state);

    if (!table.parentNode.querySelector('.sc-enh-toolbar[data-sc-widget="' + def.id + '"]')) {
      const toolbar = document.createElement('div');
      toolbar.className = 'sc-enh-toolbar';
      toolbar.dataset.scWidget = def.id;
      toolbar.innerHTML = '<span>Sort</span><select class="sc-enh-sort"></select><button type="button" class="sc-enh-reset" title="Restore page default order">Reset</button>';
      const select = toolbar.querySelector('select');
      SORT_MODES.forEach((mode) => {
        const opt = document.createElement('option');
        opt.value = mode.id;
        opt.textContent = mode.label;
        select.appendChild(opt);
      });
      select.value = state.widget[def.id].mode || 'custom';
      select.addEventListener('change', () => {
        state.widget[def.id].mode = select.value;
        saveState(state);
        render();
      });
      toolbar.querySelector('.sc-enh-reset').addEventListener('click', () => {
        state.widget[def.id].mode = 'default';
        state.widget[def.id].order = items.map((it) => it.meta.key);
        select.value = 'default';
        saveState(state);
        render();
      });
      table.parentNode.insertBefore(toolbar, table);
    }

    function render() {
      const mode = state.widget[def.id].mode || 'custom';
      const sorted = sortItems(items, mode, state.widget[def.id].order);
      paintTable(table, sorted, cols);
    }

    enableItemDrag(table, def.id, () => {
      return Array.from(table.querySelectorAll('td.sc-enh-item')).map((node) => {
        return items.find((it) => it.node === node);
      }).filter(Boolean);
    }, render);

    render();
  }

  function scanWidgets() {
    WIDGETS.forEach((def) => {
      const named = document.getElementById(def.bodyId);
      if (named) enhanceWidget(def, named);

      const max = document.getElementById('dm_contents');
      if (max) {
        const hasC = max.querySelector('.enticonbgMYCOUNTRIES');
        const hasE = max.querySelector('.enticonbgMYENTERPRISES');
        if (hasC && def.id === 'mycountries') enhanceWidget(def, max);
        if (hasE && def.id === 'myenterprises') enhanceWidget(def, max);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ticker — drive the same style.left that scrollmarquee() uses        */
  /* ------------------------------------------------------------------ */

  let tickerRaf = 0;
  let tickerVelocity = 0;
  let tickerDragging = false;
  let tickerLastX = 0;
  let tickerLastT = 0;
  let tickerResumeTimer = 0;
  let savedCopySpeed = null;
  let hookedScroll = false;

  function tickerEl() {
    if (window.cross_marquee && window.cross_marquee.style) return window.cross_marquee;
    return document.getElementById('iemarquee');
  }

  function tickerHost() {
    return document.getElementById('memdivinner') ||
      document.getElementById('memdivouter') ||
      (tickerEl() && tickerEl().parentElement);
  }

  function pauseNativeTicker() {
    try {
      if (savedCopySpeed === null && typeof window.copyspeed === 'number') {
        savedCopySpeed = window.copyspeed;
      }
      if (typeof window.copyspeed !== 'undefined') window.copyspeed = 0;
      if (typeof window.pauseit !== 'undefined') window.pauseit = 1;
    } catch (e) { /* ignore */ }
  }

  function resumeNativeTicker() {
    tickerVelocity = 0;
    try {
      const restore = (typeof window.marqueespeed === 'number')
        ? window.marqueespeed
        : (savedCopySpeed === null ? 1 : savedCopySpeed);
      if (typeof window.copyspeed !== 'undefined') window.copyspeed = restore;
    } catch (e) { /* ignore */ }
  }

  function wrapLeft(left) {
    const el = tickerEl();
    const view = parseInt(window.marqueewidth, 10) ||
      (document.getElementById('memdivinner') && document.getElementById('memdivinner').offsetWidth) ||
      (el && el.parentElement && el.parentElement.offsetWidth) ||
      800;
    let textW = (typeof window.actualwidth === 'number' && window.actualwidth > 16)
      ? window.actualwidth
      : (el ? Math.max(el.scrollWidth, el.offsetWidth, 16) : 16);
    const min = -textW + 8;
    const max = view + 8;
    const span = max - min;
    if (span <= 0) return left;
    while (left < min) left += span;
    while (left > max) left -= span;
    return left;
  }

  function readLeft() {
    const el = tickerEl();
    if (!el) return 0;
    const raw = parseInt(el.style.left, 10);
    if (!isNaN(raw)) return raw;
    return el.offsetLeft || 0;
  }

  function writeLeft(px) {
    const el = tickerEl();
    if (!el) return;
    el.style.left = Math.round(wrapLeft(px)) + 'px';
    el.style.transform = '';
  }

  function hookNativeScroll() {
    if (hookedScroll || typeof window.scrollmarquee !== 'function') return;
    hookedScroll = true;
    const orig = window.scrollmarquee;
    window.scrollmarquee = function () {
      if (tickerDragging || Math.abs(tickerVelocity) > 0.05) return;
      return orig.apply(this, arguments);
    };
  }

  function tickerFrame() {
    tickerRaf = 0;
    if (tickerDragging) return;
    if (Math.abs(tickerVelocity) < 0.08) {
      tickerVelocity = 0;
      if (!tickerResumeTimer) {
        tickerResumeTimer = setTimeout(() => {
          tickerResumeTimer = 0;
          if (!tickerDragging) resumeNativeTicker();
        }, state.ticker.resumeAutoAfterMs);
      }
      return;
    }
    writeLeft(readLeft() + tickerVelocity);
    tickerVelocity *= state.ticker.friction;
    tickerRaf = requestAnimationFrame(tickerFrame);
  }

  function bindTicker() {
    const host = tickerHost();
    const el = tickerEl();
    if (!host || !el || host.dataset.scTickerBound) return;
    host.dataset.scTickerBound = '1';
    host.style.cursor = 'grab';
    hookNativeScroll();

    host.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || !state.ticker.enabled) return;
      if (ev.target.closest('.sc-enh-ticker-hint, .sc-enh-panel')) return;

      tickerDragging = true;
      tickerVelocity = 0;
      tickerLastX = ev.clientX;
      tickerLastT = performance.now();
      if (tickerResumeTimer) {
        clearTimeout(tickerResumeTimer);
        tickerResumeTimer = 0;
      }
      pauseNativeTicker();
      host.classList.add('sc-enh-grabbing');
      el.classList.add('sc-enh-grabbing');
      ev.preventDefault();

      function move(e) {
        const now = performance.now();
        const dt = Math.max(now - tickerLastT, 1);
        let dx = e.clientX - tickerLastX;
        if (state.ticker.invertDrag) dx = -dx;
        writeLeft(readLeft() + dx * state.ticker.acceleration);
        const rawV = (dx / dt) * 16.67 * state.ticker.acceleration;
        tickerVelocity = Math.max(-state.ticker.maxSpeed, Math.min(state.ticker.maxSpeed, rawV));
        tickerLastX = e.clientX;
        tickerLastT = now;
      }

      function up() {
        tickerDragging = false;
        host.classList.remove('sc-enh-grabbing');
        el.classList.remove('sc-enh-grabbing');
        tickerVelocity *= state.ticker.motionFactor;
        tickerVelocity = Math.max(-state.ticker.maxSpeed, Math.min(state.ticker.maxSpeed, tickerVelocity));
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!tickerRaf) tickerRaf = requestAnimationFrame(tickerFrame);
      }

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function addTickerControls() {
    const outer = document.getElementById('memdivouter');
    const wrap = (outer && outer.closest('div')) || outer;
    if (!wrap || wrap.querySelector('.sc-enh-ticker-hint')) return;
    const pos = window.getComputedStyle(wrap).position;
    if (pos === 'static') wrap.style.position = 'relative';

    const bar = document.createElement('div');
    bar.className = 'sc-enh-ticker-hint';
    bar.innerHTML = '<button type="button" title="Ticker motion settings">Ticker</button>';
    bar.querySelector('button').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openTickerPanel(ev.currentTarget);
    });
    wrap.appendChild(bar);
  }

  function openTickerPanel(anchor) {
    const old = document.getElementById('sc-enh-ticker-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'sc-enh-ticker-panel';
    panel.className = 'sc-enh-panel';
    panel.innerHTML =
      '<h3>Ticker motion</h3>' +
      '<label>Enabled <input type="checkbox" data-k="enabled"' + (state.ticker.enabled ? ' checked' : '') + '></label>' +
      '<label>Acceleration <span><span data-v="acceleration">' + state.ticker.acceleration.toFixed(2) + '</span> ' +
      '<input type="range" data-k="acceleration" min="0.4" max="3" step="0.05" value="' + state.ticker.acceleration + '"></span></label>' +
      '<label>Motion factor <span><span data-v="motionFactor">' + state.ticker.motionFactor.toFixed(2) + '</span> ' +
      '<input type="range" data-k="motionFactor" min="0.4" max="4" step="0.05" value="' + state.ticker.motionFactor + '"></span></label>' +
      '<label>Friction <span><span data-v="friction">' + state.ticker.friction.toFixed(2) + '</span> ' +
      '<input type="range" data-k="friction" min="0.80" max="0.99" step="0.01" value="' + state.ticker.friction + '"></span></label>' +
      '<label>Max speed <span><span data-v="maxSpeed">' + state.ticker.maxSpeed + '</span> ' +
      '<input type="range" data-k="maxSpeed" min="8" max="80" step="1" value="' + state.ticker.maxSpeed + '"></span></label>' +
      '<label>Invert drag <input type="checkbox" data-k="invertDrag"' + (state.ticker.invertDrag ? ' checked' : '') + '></label>' +
      '<div class="row"><button type="button" data-act="reset">Defaults</button><button type="button" data-act="close">Close</button></div>';

    const rect = anchor.getBoundingClientRect();
    panel.style.top = Math.min(rect.bottom + 6, window.innerHeight - 280) + 'px';
    panel.style.left = Math.max(8, rect.right - 320) + 'px';
    document.body.appendChild(panel);

    panel.addEventListener('input', (ev) => {
      const input = ev.target;
      const key = input.getAttribute('data-k');
      if (!key) return;
      if (input.type === 'checkbox') state.ticker[key] = input.checked;
      else state.ticker[key] = parseFloat(input.value);
      const label = panel.querySelector('[data-v="' + key + '"]');
      if (label) {
        const n = state.ticker[key];
        label.textContent = Number.isInteger(n) ? String(n) : Number(n).toFixed(2);
      }
      saveState(state);
    });

    panel.addEventListener('click', (ev) => {
      const act = ev.target.getAttribute('data-act');
      if (act === 'close') panel.remove();
      if (act === 'reset') {
        state.ticker = Object.assign({}, DEFAULTS.ticker);
        saveState(state);
        panel.remove();
        openTickerPanel(anchor);
      }
    });

    setTimeout(() => {
      const closer = (ev) => {
        if (!panel.contains(ev.target)) {
          panel.remove();
          document.removeEventListener('mousedown', closer);
        }
      };
      document.addEventListener('mousedown', closer);
    }, 0);
  }

  function scanTicker() {
    if (!document.getElementById('iemarquee') && !document.getElementById('memdivinner')) return;
    bindTicker();
    addTickerControls();
    hookNativeScroll();
  }

  function boot() {
    injectStyles();
    scanWidgets();
    scanTicker();
  }

  boot();
  setTimeout(boot, 400);
  setTimeout(boot, 1500);

  const obs = new MutationObserver(() => {
    window.clearTimeout(obs._t);
    obs._t = window.setTimeout(() => {
      scanWidgets();
      scanTicker();
    }, 250);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.scEnhancer = {
    get state() { return state; },
    reset() {
      localStorage.removeItem(NS);
      location.reload();
    },
  };
})();
