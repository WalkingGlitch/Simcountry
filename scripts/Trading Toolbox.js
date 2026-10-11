// ==UserScript==
// @name         Simcountry Trading Toolbox
// @namespace    https://simcountry.com/userscripts/trading-toolbox
// @version      1.2.5
// @description  Sort, filter, select, and bulk-edit Simcountry country and enterprise trading pages.
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
  INSTALL: Tampermonkey → New script → paste → save.
  Disable the old stock-order-strategies script if both would run.
  Corporation pages stay in Simcountry Corporation Toolbox.

  Pages (country + enterprise equivalents):
    tradeworldmarket / tradeownstockcorps / supplyownstockcorps
    tradeprices
    tradereq
    stockorderstrategies
    productutil
    tradecontracts / tradecontractscancel
    tradebycontract
    tradecontractsign

  If a selector breaks after a site restyle, start with
  table#tradelist table.group tr and a[onclick*="miProduct"].
*/

(function () {
  'use strict';

  const SETTINGS_KEY = 'scTradeToolbox.v1';
  const REVISIONS_KEY = 'scTradeRevisions.v1';
  const ORDER_MEMORY_KEY = 'scTradeOrderMemory.v1';
  const REVISION_FORMAT = 1;
  const INIT_FLAG = 'scTradeToolboxInit';
  const QMIN = 120;
  const QMAX = 330;

  const ICON_GROUP = {
    offensive: 'military', defensive: 'military', strategic: 'military', war: 'military',
    industry: 'industry', mining: 'industry', hightech: 'industry',
    construction: 'industry', spaceindustry: 'industry',
    food: 'civilian', agriculture: 'civilian', recreation: 'civilian',
    services: 'civilian', utilities: 'civilian', government: 'civilian'
  };

  const CATEGORY_LABEL = {
    offensive: 'Offensive', defensive: 'Defensive', strategic: 'Strategic', war: 'War',
    industry: 'Industry', mining: 'Mining', hightech: 'High Tech',
    construction: 'Construction', spaceindustry: 'Space',
    food: 'Food', agriculture: 'Agriculture', recreation: 'Recreation',
    services: 'Services', utilities: 'Utilities', government: 'Government'
  };

  const DEFAULTS = {
    panelOpen: true,
    sortKey: 'original',
    sortDir: 'asc',
    filterCategory: 'any',
    filterProduct: 'any',
    qualityMode: 'set',
    quality: 160,
    qualityOff: 0,
    months: 36,
    qtyMonths: 48,
    osMode: '1',
    qsMode: '2',
    commonAction: '0'
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

  let settings = Object.assign({}, DEFAULTS, gmGet(SETTINGS_KEY, {}) || {});
  function saveSettings() { gmSet(SETTINGS_KEY, settings); }

  gmStyle(`
    #sc-trd-root {
      position: fixed; top: 72px; right: 12px; z-index: 2147483000;
      width: 252px; background: #f4f6fb; color: #1b1f2a;
      border: 1px solid #7a88b0; box-shadow: 0 8px 24px rgba(0,0,0,.18);
      font: 12px/1.35 Arial, sans-serif; border-radius: 4px;
    }
    #sc-trd-root.sc-trd-collapsed { width: 168px; }
    #sc-trd-root.sc-trd-collapsed .sc-trd-body { display: none; }
    #sc-trd-drag {
      background: #2c3f73; color: #fff; padding: 5px 8px; cursor: move;
      display: flex; justify-content: space-between; align-items: center;
      border-radius: 3px 3px 0 0; font-weight: bold;
    }
    #sc-trd-root .sc-trd-body { padding: 7px 8px 8px; max-height: calc(100vh - 120px); overflow: auto; }
    #sc-trd-root label { display: block; margin: 3px 0 2px; color: #31406a; }
    #sc-trd-root select, #sc-trd-root input[type="text"], #sc-trd-root input[type="number"] {
      width: 100%; box-sizing: border-box; font-size: 12px; padding: 2px 4px;
    }
    #sc-trd-root .sc-trd-row { display: flex; gap: 4px; align-items: center; }
    #sc-trd-root .sc-trd-row > * { flex: 1; }
    #sc-trd-root .sc-trd-mini { width: 100%; }
    #sc-trd-root .sc-trd-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
    #sc-trd-root button.sc-btn {
      background: #2c3f73; color: #fff; border: 0; padding: 3px 6px; cursor: pointer; font-size: 11px;
    }
    #sc-trd-root button.sc-btn.ok { background: #2a7a3a; }
    #sc-trd-root button.sc-btn.alt { background: #4b5d99; }
    #sc-trd-root .sc-trd-section { border-top: 1px solid #c5cbe0; margin-top: 6px; padding-top: 5px; }
    #sc-trd-root .sc-trd-section h4 { font-size: 11px; color: #1d4f9c; margin: 0 0 3px; }
    #sc-trd-root .sc-trd-status { background: #e7edff; border: 1px dashed #7a88b0; padding: 3px 5px; margin-top: 5px; }
    td.sc-trd-iconcell { white-space: nowrap !important; vertical-align: middle; }
    input.sc-trd-pick { width: 13px; height: 13px; margin: 0 4px 0 0; padding: 0; vertical-align: middle; }
    button.sc-trd-fill {
      margin-left: 4px; padding: 1px 6px; font: 11px Arial, sans-serif;
      border: 1px solid #7a88b0; background: #e7edff; color: #1d4f9c; cursor: pointer;
    }
    button.sc-trd-fill:hover { background: #d4e4ff; }
    span.sc-trd-fillnote { display: block; margin-top: 3px; color: #445; font: 10px Arial, sans-serif; }
    tr.sc-trd-selected > td { background-color: #d4e4ff !important; }
    tr.sc-trd-hide { display: none !important; }
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
    return n * (mul[(m[2] || '').toUpperCase()] || 1);
  }

  function emptyToNull(v) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    const n = num(s);
    return Number.isFinite(n) ? n : null;
  }

  function inRange(value, minV, maxV) {
    if (minV != null && value < minV) return false;
    if (maxV != null && value > maxV) return false;
    return true;
  }

  function clampQ(v) {
    const n = num(v);
    if (!Number.isFinite(n)) return QMIN;
    return Math.max(QMIN, Math.min(QMAX, Math.round(n)));
  }

  function normName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function hrefBag() {
    const hidden = document.querySelector('input[name="SN_METHOD"]');
    return [
      location.href || '',
      location.search || '',
      hidden ? hidden.value : '',
      document.title || ''
    ].join(' ');
  }

  function detectMode() {
    const bag = hrefBag();
    if (/statecmp|ownedcompanies|statecmpsalaries|statecmptradestrat|statecmpbuyquality|statecmpprofit|statecmpoffer|statecmpprodcontracts|statecmpretract|tradecorpcontracts/i.test(bag)
        && !/stockorderstrategies|tradeworldmarket|tradeownstockcorps|tradeprices|tradereq|productutil|tradecontracts|tradebycontract|tradecontractsign/i.test(bag)) {
      return null;
    }
    if (document.querySelector('form[name="fSOS"], input[name^="miOS"]') && document.querySelector('input[name^="miL"]') && !document.querySelector('a[href*="miCorpNumber"]')) return 'strategies';
    if (/stockorderstrategies/i.test(bag)) return 'strategies';
    if (document.querySelector('input[name^="miActionCO"]') || /tradecontractsign/i.test(bag)) return 'common';
    if ((document.querySelector('input[name="miContractID"]') || /tradecontractscancel|cgiw\?tradecontracts/i.test(bag))
        && !/tradecorpcontracts/i.test(bag)) return 'cancel';
    if (/tradebycontract/i.test(bag)) return 'review';
    if (/productutil/i.test(bag)) return 'util';
    if (/tradereq/i.test(bag) || (document.querySelector('#tradelist') && /Waiting for Offers/i.test(document.body.textContent || ''))) return 'orders';
    if (/tradeprices/i.test(bag) || (document.querySelector('#tradelist') && /vTradeSupplyVolume/.test(document.body.innerHTML || ''))) return 'market';
    if (/tradeworldmarket|tradeownstockcorps|supplyownstockcorps/i.test(bag)) return 'stock';
    if (document.querySelector('#tradelist a[href*="tradenew"], #tradelist a[href*="tradebuystock"], #tradelist a[href*="tradeofferstock"]')) return 'stock';
    return null;
  }

  function orderOwner() {
    const w = pageWin();
    let kind = '';
    let id = '';
    try {
      kind = String(w.dtDesktopOwnerKind || '').toLowerCase();
      if (kind === 'e') id = String(w.ckLoginEnterprise || w.dtDesktopOwnerID || '');
      else if (kind === 'c') id = String(w.ckLoginCountry || w.dtDesktopOwnerID || '');
      if (!kind) {
        if (w.ckLoginEnterprise && !w.ckLoginCountry) { kind = 'e'; id = String(w.ckLoginEnterprise); }
        else if (w.ckLoginCountry) { kind = 'c'; id = String(w.ckLoginCountry); }
      }
    } catch (e) { /* isolated */ }
    if (!kind) kind = /wwwEnterprise|miEnterpriseName/i.test(location.href || '') ? 'e' : 'c';
    if (!id) id = 'unknown';
    return kind + ':' + id;
  }

  function findOrderForm() {
    const forms = document.querySelectorAll('form');
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      const methodEl = form.querySelector('input[name="SN_METHOD"]');
      const method = methodEl ? methodEl.value : '';
      const qty = form.querySelector('input[name="miQuantity"]');
      const product = form.querySelector('input[name="miProduct"]');
      if (!qty || !product) continue;
      if (/tradeproducts|tradesell|tradeoffer|sellstock|offerstock/i.test(method) || form.getAttribute('name') === 'tradenew') return form;
    }
    return null;
  }

  function orderSide(form) {
    const methodEl = form.querySelector('input[name="SN_METHOD"]');
    const method = methodEl ? methodEl.value : '';
    const bag = (document.title || '') + ' ' + method + ' ' + (document.body ? document.body.textContent.slice(0, 2500) : '');
    return /sell|offer stock|selling/i.test(bag) && !/ordering|buy /i.test(document.title || '') ? 'sell' : 'buy';
  }

  function orderProductId(form) {
    const el = form.querySelector('input[name="miProduct"]');
    return el && el.value ? String(el.value) : '';
  }

  function loadOrderMemory() {
    const raw = gmGet(ORDER_MEMORY_KEY, null);
    if (!raw || typeof raw !== 'object') return { format: 1, owners: {} };
    return { format: 1, owners: raw.owners && typeof raw.owners === 'object' ? raw.owners : {} };
  }

  function saveOrderMemory(pack) {
    gmSet(ORDER_MEMORY_KEY, { format: 1, owners: pack.owners || {} });
  }

  function orderMemoryKey(form) {
    return orderSide(form) + ':' + orderProductId(form);
  }

  function readOrderMemory(form) {
    const pack = loadOrderMemory();
    const owner = pack.owners[orderOwner()] || {};
    return owner[orderMemoryKey(form)] || null;
  }

  function writeOrderMemory(form) {
    const id = orderProductId(form);
    if (!id) return;
    const pack = loadOrderMemory();
    const ownerKey = orderOwner();
    if (!pack.owners[ownerKey]) pack.owners[ownerKey] = {};
    const qty = form.querySelector('input[name="miQuantity"]');
    const quality = form.querySelector('input[name="miQuality"]');
    const price = form.querySelector('input[name="miPricePerUnit"]');
    const inc = form.querySelector('input[name="miIncrease"]');
    const ask = form.querySelector('input[name="miAskQuality"]:checked');
    const strat = form.querySelector('input[name="miTradeStrategy"]:checked');
    pack.owners[ownerKey][orderMemoryKey(form)] = {
      qty: qty ? qty.value : '',
      quality: quality ? quality.value : '',
      ask: ask ? ask.value : '',
      price: price ? price.value : '',
      increase: inc ? inc.value : '',
      strategy: strat ? strat.value : '',
      savedAt: new Date().toISOString()
    };
    saveOrderMemory(pack);
  }

  function amountNearLabel(labelRe) {
    const nodes = document.querySelectorAll('a, th, td');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.querySelector && el.querySelector('table, tr')) continue;
      const label = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const title = el.getAttribute ? (el.getAttribute('title') || '') : '';
      if (!labelRe.test(label) && !labelRe.test(title.replace(/\+/g, ' '))) continue;
      const row = el.closest ? el.closest('tr') : null;
      if (!row || row.querySelector('table')) continue;
      const cells = row.cells || row.querySelectorAll('td');
      for (let c = cells.length - 1; c >= 0; c--) {
        const m = (cells[c].textContent || '').replace(/\s+/g, ' ').match(/(-?[\d,]+(?:\.\d+)?)/);
        if (m) return m[1].replace(/,/g, '');
      }
    }
    return '';
  }

  function warningQuantity() {
    const nodes = document.querySelectorAll('.note_txt, .error, .warning, .modal_text, font[color="red"], font[color="#ff0000"], p, td');
    const patterns = [
      /(?:maximum|max\.?|up to|no more than|cannot (?:buy|sell|order|offer) more than|allotment(?: is| of)?|limited to|only (?:buy|sell|order|offer)|monthly (?:allotment|maximum|limit|production)(?: is| of)?)[:\s]+([\d,]+)/i,
      /([\d,]+)\s+(?:is the maximum|is the monthly|units? (?:this|per) month)/i
    ];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.closest && el.closest('#sc-trd-root, form[name="tradenew"] input')) continue;
      if (el.querySelector && el.querySelector('table, form')) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 12 || text.length > 500) continue;
      if (!/maximum|allotment|exceed|too high|too many|cannot|can only|monthly/i.test(text)) continue;
      for (let p = 0; p < patterns.length; p++) {
        const m = text.match(patterns[p]);
        if (m && m[1]) return m[1].replace(/,/g, '');
      }
    }
    return '';
  }

  function maxOrderQuantity(form) {
    const warned = warningQuantity();
    if (warned) return warned;
    const side = orderSide(form);
    if (side === 'buy') return amountNearLabel(/^This will buy$/i);
    return amountNearLabel(/^This will sell$/i) || amountNearLabel(/Currently in Stock|Available to sell/i);
  }

  function fillButton(label, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-trd-fill';
    btn.textContent = label;
    btn.title = title;
    return btn;
  }

  function pageCall(fnName, args) {
    const w = pageWin();
    try {
      if (typeof w[fnName] === 'function') {
        w[fnName].apply(w, args);
        return;
      }
    } catch (e) { /* fall through */ }
    const s = document.createElement('script');
    s.textContent = 'try{' + fnName + '(' + args.map(function (a) { return JSON.stringify(a); }).join(',') + ');}catch(e){}';
    (document.documentElement || document.body).appendChild(s);
    s.remove();
  }

  function setOrderRadio(form, name, value) {
    const wanted = String(value);
    const formName = form.getAttribute('name') || form.name || 'tradenew';
    const w = pageWin();
    const live = (w.document && w.document.forms && w.document.forms[formName]) || form;
    const fromForm = live.elements ? live.elements[name] : null;
    const radios = fromForm && fromForm.length != null ? fromForm : form.querySelectorAll('input[type="radio"][name="' + name + '"]');
    let chosen = null;
    for (let i = 0; i < radios.length; i++) {
      const on = String(radios[i].value) === wanted;
      radios[i].checked = on;
      if (on) chosen = radios[i];
    }
    pageCall('selectRadioButtonByValue', [formName, name, wanted]);
    if (chosen) {
      try { chosen.click(); } catch (e) { /* ignore */ }
    }
    if (name === 'miAskQuality') {
      pageCall('greyoutTextOnRadioValue', [formName, 'miAskQuality', '0', 'miQuality']);
      const field = form.querySelector('input[name="miQuality"]');
      if (field) {
        field.disabled = wanted !== '1';
        if (wanted === '1') field.removeAttribute('disabled');
      }
    }
    if (name === 'miTradeStrategy') {
      pageCall('greyoutTextOnRadioValue', [formName, 'miTradeStrategy', '3', 'miPricePerUnit']);
      const field = form.querySelector('input[name="miPricePerUnit"]');
      if (field) {
        field.disabled = wanted !== '1';
        if (wanted === '1') field.removeAttribute('disabled');
      }
    }
  }

  function bindFieldRadio(field, form, name, value) {
    if (!field) return;
    const cell = field.closest ? field.closest('td') : field.parentNode;
    function choose(ev) {
      if (ev && ev.target && ev.target.closest && ev.target.closest('button')) return;
      setOrderRadio(form, name, value);
    }
    field.addEventListener('focus', choose);
    field.addEventListener('click', choose);
    if (cell) cell.addEventListener('click', choose, true);
  }

  function applyOrderRadios(form, ask, strategy) {
    if (ask === '0' || ask === '1') setOrderRadio(form, 'miAskQuality', ask);
    if (strategy === '1' || strategy === '3') setOrderRadio(form, 'miTradeStrategy', strategy);
  }

  function installOrderForm() {
    const form = findOrderForm();
    if (!form || form.getAttribute('data-sc-order') === '1') return;
    const qty = form.querySelector('input[name="miQuantity"]');
    const quality = form.querySelector('input[name="miQuality"]');
    if (!qty) return;
    form.setAttribute('data-sc-order', '1');
    const side = orderSide(form);
    const maxQty = maxOrderQuantity(form);
    const remembered = readOrderMemory(form);

    const qtyBtn = fillButton('Max', 'Fill the spending-space or stock maximum');
    qtyBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      const n = maxOrderQuantity(form);
      if (!n) return;
      qty.value = n;
      writeOrderMemory(form);
    });
    qty.insertAdjacentElement('afterend', qtyBtn);

    if (quality) {
      const minBtn = fillButton('Min', 'Set quality to ' + QMIN);
      const maxBtn = fillButton('Max', 'Set quality to ' + QMAX);
      minBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        quality.value = String(QMIN);
        applyOrderRadios(form, '1', null);
        writeOrderMemory(form);
      });
      maxBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        quality.value = String(QMAX);
        applyOrderRadios(form, '1', null);
        writeOrderMemory(form);
      });
      quality.insertAdjacentElement('afterend', maxBtn);
      quality.insertAdjacentElement('afterend', minBtn);
      const anyBtn = fillButton('Any', 'Use Any Quality');
      anyBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        applyOrderRadios(form, '0', null);
        writeOrderMemory(form);
      });
      quality.insertAdjacentElement('afterend', anyBtn);
      bindFieldRadio(quality, form, 'miAskQuality', '1');
    }

    const price = form.querySelector('input[name="miPricePerUnit"]');
    if (price) {
      const bestBtn = fillButton('Best', 'Use Best Price');
      const fixedBtn = fillButton('Fixed', 'Use Fixed Price');
      bestBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        applyOrderRadios(form, null, '3');
        writeOrderMemory(form);
      });
      fixedBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        applyOrderRadios(form, null, '1');
        price.focus();
        writeOrderMemory(form);
      });
      price.insertAdjacentElement('afterend', fixedBtn);
      price.insertAdjacentElement('afterend', bestBtn);
      bindFieldRadio(price, form, 'miTradeStrategy', '1');
    }

    function restoreOrder() {
      const warned = warningQuantity();
      if (warned) qty.value = warned;
      else if (remembered && remembered.qty) qty.value = remembered.qty;
      if (!remembered) return;
      if (quality && remembered.quality) quality.value = remembered.quality;
      if (price && remembered.price) price.value = remembered.price;
      const inc = form.querySelector('input[name="miIncrease"]');
      if (inc && remembered.increase) inc.value = remembered.increase;
      const ask = remembered.quality ? (remembered.ask === '0' ? '0' : '1') : remembered.ask;
      const strategy = remembered.price ? (remembered.strategy === '3' ? '3' : '1') : remembered.strategy;
      applyOrderRadios(form, ask, strategy);
    }
    restoreOrder();
    window.addEventListener('load', restoreOrder);
    setTimeout(restoreOrder, 0);
    setTimeout(restoreOrder, 400);

    if (warned) {
      const note = document.createElement('span');
      note.className = 'sc-trd-fillnote';
      note.textContent = 'Quantity set from the allotment warning: ' + Number(warned).toLocaleString() + '.';
      qty.parentNode.appendChild(note);
    } else if (remembered) {
      const note = document.createElement('span');
      note.className = 'sc-trd-fillnote';
      note.textContent = 'Last ' + side + ' for this product restored' + (maxQty ? ('. Max now ' + Number(maxQty).toLocaleString()) : '') + '.';
      qty.parentNode.appendChild(note);
    } else if (maxQty) {
      const note = document.createElement('span');
      note.className = 'sc-trd-fillnote';
      note.textContent = 'Max ' + Number(maxQty).toLocaleString() + '. Saved per product after you edit or use a fill button.';
      qty.parentNode.appendChild(note);
    }

    form.addEventListener('input', function () { writeOrderMemory(form); });
    form.addEventListener('change', function () { writeOrderMemory(form); });
    form.addEventListener('submit', function () { writeOrderMemory(form); });
  }

  function parseMarketBar(tr) {
    const out = { kind: '', pct: 0, score: 0 };
    const cells = tr.cells || [];
    for (let i = cells.length - 1; i >= Math.max(0, cells.length - 4); i--) {
      const colored = cells[i].querySelectorAll('td[bgcolor]');
      if (!colored.length) continue;
      const left = colored[0];
      const color = String(left.getAttribute('bgcolor') || '').toLowerCase();
      const img = left.querySelector('img[alt]') || cells[i].querySelector('img[alt]');
      const pct = Math.max(0, Math.min(100, num(img && img.getAttribute('alt'))));
      if (/#?90ee90|green/.test(color)) {
        out.kind = 'surplus';
        out.pct = pct;
        out.score = pct;
      } else if (color === 'red') {
        out.kind = 'shortage';
        out.pct = pct;
        out.score = -pct;
      } else {
        out.kind = 'balanced';
        out.pct = pct;
        out.score = 0;
      }
      return out;
    }
    return out;
  }

  function iconKey(src) {
    const s = String(src || '');
    const m = s.match(/\/([a-z]+)(?:16|32)\.(?:gif|png)/i) || s.match(/^([a-z]+)$/i);
    const key = m ? m[1].toLowerCase() : '';
    return CATEGORY_LABEL[key] || ICON_GROUP[key] ? key : '';
  }

  function rowIndustryKey(tr) {
    if (!tr) return '';
    const imgs = tr.querySelectorAll('img[alt], img[src]');
    for (let i = 0; i < imgs.length; i++) {
      const key = iconKey(imgs[i].getAttribute('src')) || iconKey(imgs[i].getAttribute('alt'));
      if (key) return key;
    }
    return '';
  }

  function productIdFrom(tr) {
    const html = tr.innerHTML || '';
    let m = html.match(/miProduct=(\d+)/);
    if (m) return m[1];
    const inp = tr.querySelector('input[name^="miOS"], input[name^="miL"], input[name^="miActionCO"], input[name^="miT"], input[name^="miQ"]');
    if (inp && inp.name) {
      m = inp.name.match(/(\d+)$/);
      if (m) return m[1];
    }
    const box = tr.querySelector('input[name="miContractID"]');
    if (box && box.value) return String(box.value).split(':')[0];
    return '';
  }

  function cellQuery(tr, selector) {
    const cells = tr.cells || [];
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].querySelector('table')) continue;
      const hit = cells[i].querySelector(selector);
      if (hit) return hit;
    }
    return null;
  }

  function isWrapperRow(tr) {
    const cells = tr.cells || [];
    for (let i = 0; i < cells.length; i++) {
      const tables = cells[i].getElementsByTagName('table');
      for (let j = 0; j < tables.length; j++) {
        if (tables[j].querySelector('a[onclick*="miProduct"], input[name^="miOS"], input[name^="miActionCO"], input[name="miContractID"], a.popup.gadgetlink')) {
          return true;
        }
      }
    }
    return false;
  }

  function isProductRow(tr) {
    if (!tr || isWrapperRow(tr)) return false;
    return !!(cellQuery(tr, 'a[onclick*="miProduct"]') ||
      cellQuery(tr, 'a.popup.gadgetlink') ||
      cellQuery(tr, 'input[name^="miOS"]') ||
      cellQuery(tr, 'input[name^="miActionCO"]') ||
      cellQuery(tr, 'input[name^="miL"]') ||
      cellQuery(tr, 'input[name="miContractID"]'));
  }

  function rowHomeTable(tr) {
    let p = tr && tr.parentElement;
    while (p && p.tagName !== 'TABLE') p = p.parentElement;
    return p || null;
  }

  function tableBody(table) {
    if (!table) return null;
    if (table.tBodies && table.tBodies.length) return table.tBodies[0];
    if (table.createTBody) return table.createTBody();
    return table;
  }

  function adoptRow(parent, tr) {
    if (!parent || !tr) return;
    try { parent.appendChild(tr); } catch (e) { /* */ }
  }

  function workTables() {
    const out = [];
    const seen = [];
    function add(table) {
      if (!table || seen.indexOf(table) !== -1) return;
      seen.push(table);
      out.push(table);
    }
    const named = document.querySelector('#tradelist table.group, #tradelist table.data, form[name="fSOS"] table, form[name="contractform"] table.group');
    if (named) add(named);
    Array.prototype.forEach.call(document.querySelectorAll('a[onclick*="miProduct"], input[name^="miOS"], input[name^="miActionCO"], input[name="miContractID"]'), function (el) {
      const tr = el.closest('tr');
      add(rowHomeTable(tr));
    });
    return out.filter(function (table) {
      return table && Array.prototype.some.call(table.rows || [], function (tr) {
        return rowHomeTable(tr) === table && isProductRow(tr);
      });
    });
  }

  function textCells(tr) {
    return Array.prototype.map.call(tr.cells || [], function (td) {
      return (td.textContent || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
    });
  }

  function moneyFromRow(tr) {
    const m = (tr.textContent || '').match(/(-?[\d,]+(?:\.\d+)?[KMBT]?)\s*SC\$/i);
    return m ? parseMoney(m[1] + ' ' + (m[0].indexOf('SC') !== -1 ? '' : '')) : parseMoney((tr.textContent.match(/[\d,.]+\s*[KMBT]?\s*SC\$/i) || [''])[0]);
  }

  function collectProducts(mode) {
    const map = new Map();
    const tables = workTables();
    map._tables = tables;
    map._origRowsByTable = tables.map(function (table) {
      return Array.prototype.slice.call(table.rows || []);
    });
    map._mode = mode;
    let index = 0;

    tables.forEach(function (table) {
      let lastIcon = '';
      Array.prototype.forEach.call(table.rows || [], function (tr) {
        if (rowHomeTable(tr) !== table) return;
        const seenIcon = rowIndustryKey(tr);
        if (seenIcon) lastIcon = seenIcon;
        if (isWrapperRow(tr)) {
          tr.setAttribute('data-sc-trd-chrome', '1');
          return;
        }
        const prodLink = cellQuery(tr, 'a[onclick*="miProduct"]') || cellQuery(tr, 'a.popup.gadgetlink');
        const box = cellQuery(tr, 'input[name="miContractID"]');
        const strat = cellQuery(tr, 'input[name^="miOS"]') || cellQuery(tr, 'input[name^="miActionCO"]') || cellQuery(tr, 'input[name^="miL"]');
        if (!isProductRow(tr) || (!prodLink && !box && !strat)) {
          tr.setAttribute('data-sc-trd-chrome', '1');
          return;
        }
        const id = productIdFrom(tr) || ('row-' + index);
        const headerIcon = rowIndustryKey(tr);
        if (headerIcon) lastIcon = headerIcon;
        const ikey = headerIcon || lastIcon;
        const name = prodLink ? (prodLink.getAttribute('title') || prodLink.textContent || '').replace(/\s+/g, ' ').trim() : ('Product ' + id);
        const corpLink = cellQuery(tr, 'a[href*="miCorpNumber"]');
        const cells = textCells(tr);
        const rec = {
          id: String(id),
          origIndex: index++,
          row: tr,
          table: table,
          name: name,
          product: name,
          corp: corpLink ? corpLink.textContent.replace(/\s+/g, ' ').trim() : '',
          iconKey: ikey,
          group: ICON_GROUP[ikey] || 'other',
          pick: box || null,
          price: 0,
          unit: '',
          quality: 0,
          stock: 0,
          use: 0,
          amount: 0,
          supply: 0,
          demand: 0,
          surplus: 0,
          pct: 0,
          corps: 0,
          date: '',
          canBuy: !!tr.querySelector('a[href*="tradenew"], a[href*="tradebuystock"], a[title*="Ordering"], a[title*="buy" i]'),
          canSell: !!tr.querySelector('a[href*="tradeofferstock"], a[href*="tradesellstock"], a[title*="Selling"], a[title*="sell" i]'),
          marketKind: '',
          marketPct: 0,
          marketScore: 0,
          os: '',
          qs: '',
          lw: 0,
          oq: 0,
          action: '',
          detail: cells.join(' | ')
        };

        const market = parseMarketBar(tr);
        rec.marketKind = market.kind;
        rec.marketPct = market.pct;
        rec.marketScore = market.score;

        if (mode === 'stock') {
          rec.price = moneyFromRow(tr);
          rec.unit = (cells.filter(function (t) { return /^per /i.test(t); })[0] || '');
          const nums = cells.filter(function (t) { return /^[-+]?\d[\d,]*$/.test(t); }).map(num);
          rec.quality = nums[0] || 0;
          rec.use = nums[1] || 0;
          rec.stock = nums[2] || 0;
        } else if (mode === 'orders') {
          rec.amount = num(cells.filter(function (t) { return /^\d[\d,]*$/.test(t); })[0]);
          rec.unit = cells.filter(function (t) { return /^(units|tons|systems|grams|ecars|hospitals|kwhs)/i.test(t); })[0] || '';
          rec.price = /best price/i.test(tr.textContent || '') ? 0 : moneyFromRow(tr);
          rec.quality = num((cells.filter(function (t) { return /^(1[2-9]\d|2\d\d|3[0-3]\d)$/.test(t); })[0]) || 0);
          const dm = (tr.textContent || '').match(/[A-Za-z]+\s+\d{1,2}\s+\d{4}/);
          rec.date = dm ? dm[0] : '';
          const fonts = tr.querySelectorAll('font.coloreddata');
          rec.surplus = fonts.length ? parseMoney(fonts[fonts.length - 1].textContent) : 0;
        } else if (mode === 'market') {
          rec.price = moneyFromRow(tr);
          rec.unit = (cells.filter(function (t) { return /^per /i.test(t); })[0] || '');
          const nums = [];
          Array.prototype.forEach.call(tr.cells || [], function (td) {
            if (td.querySelector('a[onclick*="graph_window"], img[src*="history"]')) return;
            const t = (td.textContent || '').replace(/\s+/g, ' ').trim();
            if (/SC\$/i.test(t) || /^per /i.test(t) || !t) return;
            if (/^[-+]?\d/.test(t)) nums.push(/SC\$|M\s*SC/i.test(t) ? parseMoney(t) : parseMoney(t) || num(t));
          });
          rec.supply = nums[0] || 0;
          rec.demand = nums[1] || 0;
          rec.surplus = nums[2] || 0;
          const font = tr.querySelector('font.coloreddata');
          if (font) rec.surplus = parseMoney(font.textContent);
        } else if (mode === 'util') {
          const nums = [];
          Array.prototype.forEach.call(tr.cells || [], function (td) {
            if (td.querySelector('img[src*="history"]')) return;
            const t = (td.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || !/^[-+]?\d/.test(t)) return;
            nums.push(/%/.test(t) ? num(t) : num(t));
          });
          rec.corps = nums[0] || 0;
          rec.capacity = nums[1] || 0;
          rec.supply = nums[2] || 0;
          rec.pct = nums[3] || 0;
          rec.demand = nums[4] || 0;
          rec.surplus = nums[5] || 0;
          const font = tr.querySelector('font.coloreddata');
          if (font) rec.surplus = parseMoney(font.textContent);
        } else if (mode === 'strategies') {
          rec.os = checkedRadio(document, 'miOS' + rec.id) || '0';
          rec.qs = checkedRadio(document, 'miQS' + rec.id) || '2';
          rec.lw = num((document.querySelector('input[name="miT' + rec.id + '"]') || {}).value);
          rec.oq = num((document.querySelector('input[name="miQ' + rec.id + '"]') || {}).value);
          rec.quality = num((document.querySelector('input[name="miL' + rec.id + '"]') || {}).value);
          const stockCell = tr.querySelector('td[title]');
          rec.stock = stockCell ? num(stockCell.textContent) : 0;
        } else if (mode === 'cancel' || mode === 'review') {
          rec.pick = box;
          rec.price = moneyFromRow(tr);
          rec.amount = num((tr.textContent.match(/\((?:\+|±|&plusmn;)?\s*([\d,]+)/) || [])[1]);
          rec.undelivered = !!(tr.querySelector('font[color="red"]') && /<\/font><\/b>/.test(tr.innerHTML) || (tr.cells[0] && /\*/.test(tr.cells[0].textContent || '')));
        } else if (mode === 'common') {
          rec.action = checkedRadio(document, 'miActionCO' + rec.id) || '0';
          const monies = [];
          Array.prototype.forEach.call(tr.cells || [], function (td) {
            const t = (td.textContent || '').trim();
            if (/SC\$/.test(t) || /M\s*SC\$/.test(t)) monies.push(parseMoney(t));
          });
          rec.price = monies[0] || 0;
          rec.supply = monies[1] || 0;
          rec.demand = monies[2] || 0;
          rec.pct = num((tr.textContent.match(/\((\d+)%\)/) || [])[1]);
        }

        map.set(rec.id + ':' + rec.origIndex, rec);
        tr.setAttribute('data-sc-trd-id', rec.id);
      });
    });
    return map;
  }

  function checkedRadio(root, name) {
    const el = (root || document).querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  function writeInput(el, value) {
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setRadio(name, value) {
    const el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (!el) return;
    el.checked = true;
    el.click();
  }

  function installPickboxes(items) {
    items.forEach(function (c) {
      if (c.pick) {
        c.pick.classList.add('sc-trd-pick');
        return;
      }
      if (c.row.querySelector('input.sc-trd-pick')) {
        c.pick = c.row.querySelector('input.sc-trd-pick');
        return;
      }
      const td = c.row.querySelector('td');
      if (!td) return;
      td.classList.add('sc-trd-iconcell');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'sc-trd-pick';
      box.value = '1';
      box.title = 'Select ' + c.name;
      td.insertBefore(box, td.firstChild);
      c.pick = box;
    });
  }

  function isSelected(c) { return !!(c.pick && c.pick.checked); }
  function setSelected(c, on) {
    if (c.pick) c.pick.checked = !!on;
    if (c.row) c.row.classList.toggle('sc-trd-selected', !!on);
  }
  function selectedList(items) {
    const out = [];
    items.forEach(function (c) { if (isSelected(c)) out.push(c); });
    return out;
  }

  function matchesCategory(c, token) {
    if (!token || token === 'any') return true;
    if (token.indexOf('group:') === 0) return c.group === token.slice(6);
    if (token.indexOf('icon:') === 0) return c.iconKey === token.slice(5);
    return c.iconKey === token || c.group === token;
  }

  function matchesView(c, root) {
    const q = ((root.querySelector('#sc-trd-search') || {}).value || '').trim().toLowerCase();
    if (q && (c.name + ' ' + c.corp + ' ' + c.id + ' ' + c.detail).toLowerCase().indexOf(q) === -1) return false;
    const cat = (root.querySelector('#sc-trd-fcat') || {}).value || 'any';
    if (!matchesCategory(c, cat)) return false;
    const prod = (root.querySelector('#sc-trd-fprod') || {}).value || 'any';
    if (prod && prod !== 'any' && c.product !== prod) return false;
    if (!inRange(c.quality || 0, emptyToNull(valOf(root, '#sc-trd-fqmin')), emptyToNull(valOf(root, '#sc-trd-fqmax')))) return false;
    if (!inRange(c.stock || 0, emptyToNull(valOf(root, '#sc-trd-fstmin')), emptyToNull(valOf(root, '#sc-trd-fstmax')))) return false;
    if (!inRange(c.surplus || 0, emptyToNull(valOf(root, '#sc-trd-fsurmin')), emptyToNull(valOf(root, '#sc-trd-fsurmax')))) return false;
    if (!inRange(c.amount || 0, emptyToNull(valOf(root, '#sc-trd-famtmin')), emptyToNull(valOf(root, '#sc-trd-famtmax')))) return false;
    const tradeF = valOf(root, '#sc-trd-ftrade') || 'any';
    if (tradeF === 'buy' && !c.canBuy) return false;
    if (tradeF === 'sell' && !c.canSell) return false;
    if (tradeF === 'both' && !(c.canBuy && c.canSell)) return false;
    if (tradeF === 'none' && (c.canBuy || c.canSell)) return false;
    const mktF = valOf(root, '#sc-trd-fmkt') || 'any';
    if (mktF === 'shortage' && c.marketKind !== 'shortage') return false;
    if (mktF === 'surplus' && c.marketKind !== 'surplus') return false;
    if (mktF === 'balanced' && c.marketKind !== 'balanced') return false;
    if (mktF === 'split' && !(c.marketKind && c.marketPct > 0 && c.marketPct < 100)) return false;
    if (mktF === 'short80' && !(c.marketKind === 'shortage' && c.marketPct >= 80)) return false;
    if (mktF === 'surp80' && !(c.marketKind === 'surplus' && c.marketPct >= 80)) return false;
    if (!inRange(c.marketScore || 0, emptyToNull(valOf(root, '#sc-trd-fmktmin')), emptyToNull(valOf(root, '#sc-trd-fmktmax')))) return false;
    const osF = valOf(root, '#sc-trd-fos') || 'any';
    if (osF !== 'any' && String(c.os) !== osF) return false;
    const actF = valOf(root, '#sc-trd-fact') || 'any';
    if (actF !== 'any' && String(c.action) !== actF) return false;
    return true;
  }

  function valOf(root, sel) {
    const el = root.querySelector(sel);
    return el ? el.value : '';
  }

  function sortItems(items, key, dir) {
    items.sort(function (a, b) {
      let cmp = 0;
      if (key === 'original') cmp = a.origIndex - b.origIndex;
      else if (key === 'name' || key === 'product') cmp = a.name.localeCompare(b.name);
      else if (key === 'corp') cmp = String(a.corp).localeCompare(String(b.corp));
      else if (key === 'price') cmp = (a.price || 0) - (b.price || 0);
      else if (key === 'quality') cmp = (a.quality || 0) - (b.quality || 0);
      else if (key === 'stock') cmp = (a.stock || 0) - (b.stock || 0);
      else if (key === 'use') cmp = (a.use || 0) - (b.use || 0);
      else if (key === 'amount') cmp = (a.amount || 0) - (b.amount || 0);
      else if (key === 'supply') cmp = (a.supply || 0) - (b.supply || 0);
      else if (key === 'demand') cmp = (a.demand || 0) - (b.demand || 0);
      else if (key === 'surplus') cmp = (a.surplus || 0) - (b.surplus || 0);
      else if (key === 'pct') cmp = (a.pct || 0) - (b.pct || 0);
      else if (key === 'corps') cmp = (a.corps || 0) - (b.corps || 0);
      else if (key === 'capacity') cmp = (a.capacity || 0) - (b.capacity || 0);
      else if (key === 'date') cmp = String(a.date).localeCompare(String(b.date));
      else if (key === 'lw') cmp = (a.lw || 0) - (b.lw || 0);
      else if (key === 'oq') cmp = (a.oq || 0) - (b.oq || 0);
      else if (key === 'market') cmp = (a.marketScore || 0) - (b.marketScore || 0);
      else cmp = a.origIndex - b.origIndex;
      if (key === 'original') return cmp;
      return cmp * dir || (a.origIndex - b.origIndex);
    });
  }

  function flowPageList(items, root) {
    const sel = root.querySelector('#sc-trd-sort');
    let key = valOf(root, '#sc-trd-sort') || settings.sortKey || 'original';
    if (sel) {
      const valid = {};
      Array.prototype.forEach.call(sel.options, function (o) { valid[o.value] = true; });
      if (!valid[key]) { key = 'original'; sel.value = 'original'; }
    }
    const dir = (valOf(root, '#sc-trd-dir') || settings.sortDir) === 'desc' ? -1 : 1;
    const tables = items._tables || [];
    const list = [];
    items.forEach(function (c) {
      if (isWrapperRow(c.row)) {
        c.row.classList.remove('sc-trd-hide');
        return;
      }
      c.row.classList.toggle('sc-trd-hide', !matchesView(c, root));
      list.push(c);
    });
    function chromeOf(table) {
      const parent = tableBody(table);
      const chrome = [];
      Array.prototype.forEach.call((parent && (parent.rows || parent.children)) || [], function (tr) {
        if (tr.getAttribute && tr.getAttribute('data-sc-trd-chrome') === '1') chrome.push(tr);
      });
      return chrome;
    }
    if (key === 'original') {
      tables.forEach(function (table, idx) {
        chromeOf(table).forEach(function (tr) { tr.classList.remove('sc-trd-hide'); });
        const home = tableBody(table);
        ((items._origRowsByTable && items._origRowsByTable[idx]) || []).forEach(function (tr) { adoptRow(home, tr); });
      });
      return;
    }
    sortItems(list, key, dir);
    tables.forEach(function (table) {
      chromeOf(table).forEach(function (tr) { tr.classList.add('sc-trd-hide'); });
    });
    const host = tableBody(tables[0] || (list[0] && list[0].table));
    list.forEach(function (c) { adoptRow(host || tableBody(c.table), c.row); });
  }

  function opt(val, label, cur) {
    return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + label + '</option>';
  }

  function fillCategorySelect(root, items) {
    const sel = root.querySelector('#sc-trd-fcat');
    if (!sel) return;
    const icons = {};
    const groups = {};
    items.forEach(function (c) {
      if (c.group && c.group !== 'other') groups[c.group] = (groups[c.group] || 0) + 1;
      if (c.iconKey) icons[c.iconKey] = (icons[c.iconKey] || 0) + 1;
    });
    function add(parent, value, label) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      parent.appendChild(o);
    }
    sel.innerHTML = '';
    add(sel, 'any', 'Any category');
    const g1 = document.createElement('optgroup');
    g1.label = 'Groups';
    ['military', 'industry', 'civilian'].forEach(function (k) {
      add(g1, 'group:' + k, k.charAt(0).toUpperCase() + k.slice(1) + (groups[k] ? ' (' + groups[k] + ')' : ''));
    });
    sel.appendChild(g1);
    const g2 = document.createElement('optgroup');
    g2.label = 'Industries';
    Object.keys(icons).sort().forEach(function (k) {
      add(g2, 'icon:' + k, (CATEGORY_LABEL[k] || k) + ' (' + icons[k] + ')');
    });
    sel.appendChild(g2);
    const cur = settings.filterCategory || 'any';
    try { sel.value = cur; } catch (e) { /* */ }
    if (sel.value !== cur) sel.value = 'any';
  }

  function fillProductSelect(root, items) {
    const sel = root.querySelector('#sc-trd-fprod');
    if (!sel) return;
    const cat = (root.querySelector('#sc-trd-fcat') || {}).value || 'any';
    const names = {};
    items.forEach(function (c) {
      if (!matchesCategory(c, cat)) return;
      if (c.product) names[c.product] = true;
    });
    let cur = settings.filterProduct || 'any';
    if (cur !== 'any' && !names[cur]) cur = 'any';
    sel.innerHTML = '';
    const any = document.createElement('option');
    any.value = 'any';
    any.textContent = 'Any product';
    sel.appendChild(any);
    Object.keys(names).sort().forEach(function (n) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = cur;
    settings.filterProduct = cur;
  }

  function titles(mode) {
    return {
      stock: 'Stock Buy / Sell Toolbox',
      orders: 'Open Buy Orders Toolbox',
      market: 'World Market Toolbox',
      strategies: 'Order Strategies Toolbox',
      util: 'Factory Utilization Toolbox',
      cancel: 'Country Contracts Toolbox',
      review: 'Country Contracts Toolbox',
      common: 'Common Market Contracts Toolbox'
    }[mode] || 'Trading Toolbox';
  }

  function sortOpts(mode) {
    const k = settings.sortKey;
    let html = opt('original', 'Original order', k) + opt('name', 'Product', k);
    if (mode === 'stock') html += opt('price', 'Market price', k) + opt('quality', 'Quality', k) + opt('use', 'Monthly use', k) + opt('stock', 'Stock', k) + opt('market', 'Market situation', k);
    if (mode === 'orders') html += opt('amount', 'Amount', k) + opt('quality', 'Quality', k) + opt('date', 'Date ordered', k) + opt('surplus', 'Surplus', k);
    if (mode === 'market') html += opt('price', 'Market price', k) + opt('supply', 'Supply', k) + opt('demand', 'Demand', k) + opt('surplus', 'Surplus', k);
    if (mode === 'util') html += opt('corps', 'Corporations', k) + opt('capacity', 'Capacity', k) + opt('supply', 'Produced', k) + opt('pct', 'Utilization %', k) + opt('demand', 'Demand', k) + opt('surplus', 'Surplus', k);
    if (mode === 'strategies') html += opt('stock', 'In stock', k) + opt('quality', 'Requested quality', k) + opt('lw', 'Low-water months', k) + opt('oq', 'Order months', k);
    if (mode === 'cancel' || mode === 'review') html += opt('corp', 'Corporation', k) + opt('price', 'Price', k);
    if (mode === 'common') html += opt('price', 'Consumption value', k) + opt('supply', 'Local contracts', k) + opt('demand', 'Common contracts', k) + opt('pct', '% contracted', k);
    return html;
  }

  function extraFilters(mode) {
    let html = '';
    if (mode === 'stock' || mode === 'strategies' || mode === 'orders') {
      html += '<div class="sc-trd-row"><label>Q <input class="sc-trd-mini" type="number" id="sc-trd-fqmin" placeholder="min"></label><label>– <input class="sc-trd-mini" type="number" id="sc-trd-fqmax" placeholder="max"></label></div>';
    }
    if (mode === 'stock' || mode === 'strategies') {
      html += '<div class="sc-trd-row"><label>Stk <input class="sc-trd-mini" type="number" id="sc-trd-fstmin" placeholder="min"></label><label>– <input class="sc-trd-mini" type="number" id="sc-trd-fstmax" placeholder="max"></label></div>';
    }
    if (mode === 'stock') {
      html += '<div class="sc-trd-row"><label>Trade <select id="sc-trd-ftrade">' +
        opt('any', 'Buy or sell', 'any') + opt('buy', 'Has buy', 'any') + opt('sell', 'Has sell', 'any') +
        opt('both', 'Buy and sell', 'any') + opt('none', 'No trade link', 'any') + '</select></label></div>';
      html += '<label>Market <select id="sc-trd-fmkt">' +
        opt('any', 'Any situation', 'any') +
        opt('shortage', 'Shortage (red)', 'any') +
        opt('surplus', 'Surplus (green)', 'any') +
        opt('balanced', 'Balanced', 'any') +
        opt('split', 'Split bar (not 100%)', 'any') +
        opt('short80', 'Shortage ≥ 80%', 'any') +
        opt('surp80', 'Surplus ≥ 80%', 'any') +
        '</select></label>';
      html += '<div class="sc-trd-row"><label>Sit <input class="sc-trd-mini" type="number" id="sc-trd-fmktmin" placeholder="-100"></label><label>– <input class="sc-trd-mini" type="number" id="sc-trd-fmktmax" placeholder="100"></label></div>';
    }
    if (mode === 'orders' || mode === 'market' || mode === 'util') {
      html += '<div class="sc-trd-row"><label>Surp <input class="sc-trd-mini" type="number" id="sc-trd-fsurmin" placeholder="min"></label><label>– <input class="sc-trd-mini" type="number" id="sc-trd-fsurmax" placeholder="max"></label></div>';
    }
    if (mode === 'orders') {
      html += '<div class="sc-trd-row"><label>Amt <input class="sc-trd-mini" type="number" id="sc-trd-famtmin" placeholder="min"></label><label>– <input class="sc-trd-mini" type="number" id="sc-trd-famtmax" placeholder="max"></label></div>';
    }
    if (mode === 'strategies') {
      html += '<div class="sc-trd-row"><label>Orders <select id="sc-trd-fos">' +
        opt('any', 'Any strategy', 'any') + opt('0', 'Off', 'any') + opt('1', 'Keep stock', 'any') + opt('2', 'Always order', 'any') +
        '</select></label></div>';
    }
    if (mode === 'common') {
      html += '<div class="sc-trd-row"><label>Action <select id="sc-trd-fact">' +
        opt('any', 'Any action', 'any') + opt('0', 'Skip', 'any') + opt('1', 'Local only', 'any') +
        opt('2', 'Common only', 'any') + opt('3', 'Local + common', 'any') + opt('4', 'Cancel all', 'any') +
        '</select></label></div>';
    }
    return html;
  }

  function applyBlock(mode) {
    if (mode === 'strategies') {
      return '<div class="sc-trd-section"><h4>Set order strategy</h4>' +
        '<label>Quality <select id="sc-trd-qmode">' +
          opt('set', 'Set to value', settings.qualityMode) +
          opt('off', 'Offset selected', settings.qualityMode) +
        '</select></label>' +
        '<div class="sc-trd-row">' +
          '<label>Q <input class="sc-trd-mini" type="number" id="sc-trd-qval" min="120" max="330" value="' + settings.quality + '"></label>' +
          '<label>Off <input class="sc-trd-mini" type="number" id="sc-trd-qoff" value="' + settings.qualityOff + '"></label>' +
        '</div>' +
        '<div class="sc-trd-row">' +
          '<label>LW mo <input class="sc-trd-mini" type="number" id="sc-trd-lw" value="' + settings.months + '"></label>' +
          '<label>Ord mo <input class="sc-trd-mini" type="number" id="sc-trd-oq" value="' + settings.qtyMonths + '"></label>' +
        '</div>' +
        '<label>Order mode <select id="sc-trd-os">' +
          opt('0', 'Off', settings.osMode) +
          opt('1', 'Keep stock / low water', settings.osMode) +
          opt('2', 'Always order', settings.osMode) +
        '</select></label>' +
        '<label>Quality mode <select id="sc-trd-qs">' +
          opt('1', 'Any quality', settings.qsMode) +
          opt('2', 'Request quality', settings.qsMode) +
        '</select></label>' +
        '<div class="sc-trd-actions">' +
          '<button type="button" class="sc-btn ok" data-act="apply-strat">Apply to checked</button>' +
        '</div></div>';
    }
    if (mode === 'common') {
      return '<div class="sc-trd-section"><h4>Set contract action</h4>' +
        '<label>Action <select id="sc-trd-cact">' +
          opt('0', 'Skip', settings.commonAction) +
          opt('1', 'Local market only', settings.commonAction) +
          opt('2', 'Common market only', settings.commonAction) +
          opt('3', 'Local and common', settings.commonAction) +
          opt('4', 'Cancel all contracts', settings.commonAction) +
        '</select></label>' +
        '<div class="sc-trd-actions">' +
          '<button type="button" class="sc-btn ok" data-act="apply-common">Apply to checked</button>' +
        '</div></div>';
    }
    return '';
  }

  function buildPanel(items) {
    if (document.getElementById('sc-trd-root')) return;
    const mode = items._mode;
    const root = document.createElement('div');
    root.id = 'sc-trd-root';
    if (!settings.panelOpen) root.classList.add('sc-trd-collapsed');
    root.innerHTML =
      '<div id="sc-trd-drag"><span>' + titles(mode) + '</span>' +
        '<button type="button" class="sc-btn alt" id="sc-trd-toggle">' + (settings.panelOpen ? '–' : '+') + '</button></div>' +
      '<div class="sc-trd-body">' +
        '<input type="text" id="sc-trd-search" placeholder="Filter name / id">' +
        '<label>Category <select id="sc-trd-fcat"></select></label>' +
        '<label>Product <select id="sc-trd-fprod"></select></label>' +
        extraFilters(mode) +
        '<div class="sc-trd-row">' +
          '<label>Sort <select id="sc-trd-sort">' + sortOpts(mode) + '</select></label>' +
          '<label>Dir <select id="sc-trd-dir">' + opt('asc', 'Asc', settings.sortDir) + opt('desc', 'Desc', settings.sortDir) + '</select></label>' +
        '</div>' +
        '<div class="sc-trd-actions">' +
          '<button type="button" class="sc-btn" data-sel="all">All visible</button>' +
          '<button type="button" class="sc-btn" data-sel="none">None</button>' +
          '<button type="button" class="sc-btn alt" data-sel="invert">Invert</button>' +
        '</div>' +
        '<div class="sc-trd-actions">' +
          '<button type="button" class="sc-btn alt" data-sel="military">Military</button>' +
          '<button type="button" class="sc-btn alt" data-sel="industry">Industry</button>' +
          '<button type="button" class="sc-btn alt" data-sel="civilian">Civilian</button>' +
        '</div>' +
        applyBlock(mode) +
        ((mode === 'strategies' || mode === 'common')
          ? '<div class="sc-trd-section"><h4>Revisions</h4>' +
            '<input type="text" id="sc-trd-revname" placeholder="Revision name">' +
            '<select id="sc-trd-revlist"></select>' +
            '<div class="sc-trd-actions">' +
              '<button type="button" class="sc-btn" data-rev="save">Save</button>' +
              '<button type="button" class="sc-btn ok" data-rev="restore">Restore</button>' +
              '<button type="button" class="sc-btn alt" data-rev="delete">Delete</button>' +
            '</div></div>'
          : '') +
        '<div class="sc-trd-status" id="sc-trd-count"></div>' +
        '<div class="sc-trd-status" id="sc-trd-msg">' +
          (mode === 'strategies' ? 'Apply fills the form. Save with the site button.'
            : mode === 'common' ? 'Apply sets radios. Confirm with the site button.'
            : mode === 'cancel' ? 'Check contracts, then cancel marked contracts on the page.'
            : 'Sort and filter only. Follow the page buy/sell/details links.') +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.setAttribute('data-sc-mode', mode);
    fillCategorySelect(root, items);
    fillProductSelect(root, items);
    if (mode === 'strategies' || mode === 'common') fillRevisionSelect(root);
    wirePanel(root, items);
    makeDraggable(root, root.querySelector('#sc-trd-drag'));
    flowPageList(items, root);
    refreshCount(items);
  }

  function say(msg) {
    const el = document.querySelector('#sc-trd-msg');
    if (el) el.textContent = msg;
  }

  function refreshCount(items) {
    const root = document.getElementById('sc-trd-root');
    if (!root) return;
    let vis = 0;
    items.forEach(function (c) { if (matchesView(c, root)) vis += 1; });
    const el = root.querySelector('#sc-trd-count');
    if (el) el.textContent = selectedList(items).length + ' checked · ' + vis + ' listed · ' + items.size + ' total';
  }

  function persist(root) {
    settings.sortKey = valOf(root, '#sc-trd-sort') || settings.sortKey;
    settings.sortDir = valOf(root, '#sc-trd-dir') || settings.sortDir;
    settings.filterCategory = valOf(root, '#sc-trd-fcat') || 'any';
    settings.filterProduct = valOf(root, '#sc-trd-fprod') || 'any';
    settings.qualityMode = valOf(root, '#sc-trd-qmode') || settings.qualityMode;
    settings.quality = num(valOf(root, '#sc-trd-qval')) || settings.quality;
    settings.qualityOff = num(valOf(root, '#sc-trd-qoff'));
    settings.months = num(valOf(root, '#sc-trd-lw')) || settings.months;
    settings.qtyMonths = num(valOf(root, '#sc-trd-oq')) || settings.qtyMonths;
    settings.osMode = valOf(root, '#sc-trd-os') || settings.osMode;
    settings.qsMode = valOf(root, '#sc-trd-qs') || settings.qsMode;
    settings.commonAction = valOf(root, '#sc-trd-cact') || settings.commonAction;
    saveSettings();
  }

  function wirePanel(root, items) {
    root.querySelector('#sc-trd-toggle').addEventListener('click', function () {
      settings.panelOpen = !settings.panelOpen;
      root.classList.toggle('sc-trd-collapsed', !settings.panelOpen);
      root.querySelector('#sc-trd-toggle').textContent = settings.panelOpen ? '–' : '+';
      saveSettings();
    });
    function relist() {
      persist(root);
      flowPageList(items, root);
      refreshCount(items);
    }
    root.querySelectorAll('select, input').forEach(function (el) {
      if (el.id === 'sc-trd-fcat' || el.id === 'sc-trd-revname' || el.id === 'sc-trd-revlist') return;
      el.addEventListener('input', relist);
      el.addEventListener('change', relist);
    });
    const catSel = root.querySelector('#sc-trd-fcat');
    if (catSel) {
      catSel.addEventListener('change', function () {
        settings.filterCategory = catSel.value || 'any';
        settings.filterProduct = 'any';
        fillProductSelect(root, items);
        relist();
      });
    }
    document.addEventListener('change', function (ev) {
      if (ev.target && ev.target.classList && ev.target.classList.contains('sc-trd-pick')) {
        const row = ev.target.closest('tr');
        if (row) row.classList.toggle('sc-trd-selected', ev.target.checked);
        refreshCount(items);
      }
    });
    root.addEventListener('click', function (ev) {
      const selBtn = ev.target.closest('[data-sel]');
      if (selBtn) {
        runSelection(selBtn.getAttribute('data-sel'), items, root);
        refreshCount(items);
        return;
      }
      const revBtn = ev.target.closest('[data-rev]');
      if (revBtn) {
        persist(root);
        runRevision(revBtn.getAttribute('data-rev'), items, root);
        flowPageList(items, root);
        refreshCount(items);
        return;
      }
      const actBtn = ev.target.closest('[data-act]');
      if (actBtn) {
        persist(root);
        runAction(actBtn.getAttribute('data-act'), items, root);
        flowPageList(items, root);
        refreshCount(items);
      }
    });
  }

  function runSelection(kind, items, root) {
    items.forEach(function (c) {
      const listed = matchesView(c, root);
      let on = isSelected(c);
      if (kind === 'all') on = listed;
      else if (kind === 'none') on = false;
      else if (kind === 'invert') on = listed ? !on : on;
      else if (kind === 'military' || kind === 'industry' || kind === 'civilian') on = listed && c.group === kind;
      setSelected(c, on);
    });
  }

  function applyStrategy(c, spec) {
    const id = c.id;
    const w = pageWin();
    if (spec.os != null) {
      try {
        if (String(spec.os) === '0' && typeof w.disableOS === 'function') w.disableOS(id, '0');
        else if (typeof w.enableOS === 'function') w.enableOS(id, String(spec.os));
      } catch (e) { /* */ }
      const radio = document.querySelector('input[name="miOS' + id + '"][value="' + spec.os + '"]');
      if (radio) { radio.checked = true; }
    }
    if (spec.lw != null) writeInput(document.querySelector('input[name="miT' + id + '"]'), spec.lw);
    if (spec.oq != null) writeInput(document.querySelector('input[name="miQ' + id + '"]'), spec.oq);
    if (spec.qs != null) {
      try {
        if (String(spec.qs) === '1' && typeof w.anyQS === 'function') w.anyQS(id);
        else if (typeof w.requestQS === 'function') w.requestQS(id);
      } catch (e2) { /* */ }
      const qsr = document.querySelector('input[name="miQS' + id + '"][value="' + spec.qs + '"]');
      if (qsr) qsr.checked = true;
    }
    if (spec.quality != null) writeInput(document.querySelector('input[name="miL' + id + '"]'), clampQ(spec.quality));
    try {
      if (w.StockStrategy && typeof w.StockStrategy === 'function') {
        /* page object may already exist; DOM write is enough for submit */
      }
    } catch (e3) { /* */ }
  }

  function runAction(act, items, root) {
    const list = selectedList(items);
    if (!list.length) { say('Check one or more products first.'); return; }
    if (act === 'apply-strat') {
      const modeQ = valOf(root, '#sc-trd-qmode') || 'set';
      const qVal = num(valOf(root, '#sc-trd-qval'));
      const qOff = num(valOf(root, '#sc-trd-qoff'));
      const specBase = {
        os: valOf(root, '#sc-trd-os'),
        qs: valOf(root, '#sc-trd-qs'),
        lw: num(valOf(root, '#sc-trd-lw')),
        oq: num(valOf(root, '#sc-trd-oq'))
      };
      if (!window.confirm('Apply order strategy to ' + list.length + ' product(s)? The site Save button still submits.')) return;
      list.forEach(function (c) {
        const q = modeQ === 'off' ? clampQ((c.quality || QMIN) + qOff) : clampQ(qVal);
        applyStrategy(c, Object.assign({}, specBase, { quality: q }));
        c.quality = q;
        c.os = specBase.os;
        c.qs = specBase.qs;
        c.lw = specBase.lw;
        c.oq = specBase.oq;
      });
      say('Applied strategy to ' + list.length + ' products. Save on the page.');
      return;
    }
    if (act === 'apply-common') {
      const action = valOf(root, '#sc-trd-cact') || '0';
      if (!window.confirm('Set common-market action on ' + list.length + ' product(s)? Confirm on the page afterwards.')) return;
      list.forEach(function (c) {
        setRadio('miActionCO' + c.id, action);
        c.action = action;
      });
      say('Set action on ' + list.length + ' products. Use Confirm on the page.');
    }
  }

  function loadRevisions() {
    const raw = gmGet(REVISIONS_KEY, null);
    if (!raw || typeof raw !== 'object') return { format: REVISION_FORMAT, items: [] };
    return { format: REVISION_FORMAT, items: Array.isArray(raw.items) ? raw.items : [] };
  }

  function storeRevisions(pack) {
    gmSet(REVISIONS_KEY, { format: REVISION_FORMAT, items: pack.items || [] });
  }

  function fillRevisionSelect(root) {
    const sel = root.querySelector('#sc-trd-revlist');
    if (!sel) return;
    const kind = root.getAttribute('data-sc-mode') || '';
    const items = loadRevisions().items.filter(function (rev) { return !rev.kind || rev.kind === kind; });
    sel.innerHTML = '';
    if (!items.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(no revisions saved)';
      sel.appendChild(o);
      return;
    }
    items.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    items.forEach(function (rev) {
      const o = document.createElement('option');
      o.value = rev.id;
      o.textContent = rev.name + ' · ' + ((rev.products && rev.products.length) || 0);
      sel.appendChild(o);
    });
  }

  function snapshotProduct(c) {
    return {
      id: c.id,
      name: c.name,
      nameKey: normName(c.name),
      quality: c.quality,
      os: c.os,
      qs: c.qs,
      lw: c.lw,
      oq: c.oq,
      action: c.action
    };
  }

  function runRevision(kind, items, root) {
    const pack = loadRevisions();
    const pageKind = root.getAttribute('data-sc-mode') || '';
    if (kind === 'save') {
      const name = (valOf(root, '#sc-trd-revname') || '').trim() || ('Rev ' + new Date().toISOString().slice(0, 16));
      const products = [];
      items.forEach(function (c) { products.push(snapshotProduct(c)); });
      pack.items.push({
        id: 'trd-' + Date.now().toString(36),
        name: name,
        kind: pageKind,
        savedAt: new Date().toISOString(),
        products: products
      });
      storeRevisions(pack);
      fillRevisionSelect(root);
      say('Saved "' + name + '" (' + products.length + ' products). New products later stay untouched.');
      return;
    }
    const id = valOf(root, '#sc-trd-revlist');
    const rev = pack.items.filter(function (r) { return r.id === id; })[0];
    if (!rev) { say('Pick a revision first.'); return; }
    if (kind === 'delete') {
      if (!window.confirm('Delete revision "' + rev.name + '"?')) return;
      pack.items = pack.items.filter(function (r) { return r.id !== id; });
      storeRevisions(pack);
      fillRevisionSelect(root);
      say('Deleted.');
      return;
    }
    if (kind === 'restore') {
      if (!window.confirm('Restore "' + rev.name + '" onto matching products?')) return;
      const byId = new Map();
      const byName = new Map();
      items.forEach(function (c) {
        byId.set(String(c.id), c);
        byName.set(normName(c.name), c);
      });
      let n = 0;
      (rev.products || []).forEach(function (snap) {
        const c = byId.get(String(snap.id)) || byName.get(snap.nameKey || normName(snap.name));
        if (!c) return;
        if (pageKind === 'strategies') applyStrategy(c, snap);
        if (pageKind === 'common' && snap.action != null) setRadio('miActionCO' + c.id, snap.action);
        n += 1;
      });
      say('Restored ' + n + ' products. New products were left alone.');
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
    installOrderForm();
    const mode = detectMode();
    if (!mode) return;
    if (document.documentElement.getAttribute(INIT_FLAG) === '1' && document.getElementById('sc-trd-root')) return;
    const items = collectProducts(mode);
    if (!items.size) return;
    document.documentElement.setAttribute(INIT_FLAG, '1');
    installPickboxes(items);
    buildPanel(items);
  }

  function start() {
    init();
    const obs = new MutationObserver(function () {
      installOrderForm();
      if (detectMode() && !document.getElementById('sc-trd-root')) {
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
