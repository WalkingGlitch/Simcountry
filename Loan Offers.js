// ==UserScript==
// @name         SimCountry Loan Offers Toolkit
// @namespace    sc.qol.loanoffers
// @version      1.5.0
// @description  Sort/filter Offered Loans, totals, and native-looking repeat submit for country + enterprise loan-offer pages.
// @author       TheWalkingGlitch
// @match        https://*.simcountry.com/*
// @match        http://*.simcountry.com/*
// @match        https://simcountry.com/*
// @match        http://simcountry.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  var SCRIPT_ID = 'sc-loan-offers-toolkit';
  var PREF_KEY = 'sc.loanOffers.prefs.v1';
  var JOB_KEY = 'sc.loanOffers.repeatJob.v1';
  var MAX_REPEAT = 50;
  var REPEAT_DELAY_MS = 1600;
  var MARK = 'data-' + SCRIPT_ID;
  var repeatCancel = false;

  var DEFAULT_PREFS = {
    lastAmount: '',
    lastPeriod: '120',
    lastRepeat: '1',
    sortKey: 'amount',
    sortDir: 'desc',
    filter: '',
    delayMs: REPEAT_DELAY_MS,
    highlightOn: true,
    highlightColor: '#b8860b',
    highlightThresholdText: '1T'
  };

  /* ------------------------------------------------------------------ */
  /* Storage                                                             */
  /* ------------------------------------------------------------------ */

  function parseStored(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function storageGet(key, fallback) {
    try {
      var ss = window.sessionStorage.getItem(key);
      if (ss) return parseStored(ss, fallback);
    } catch (e0) { /* ignore */ }
    try {
      if (typeof GM_getValue === 'function') {
        var raw = GM_getValue(key, null);
        var parsed = parseStored(raw, null);
        if (parsed != null) return parsed;
      }
    } catch (e) { /* fall through */ }
    try {
      return parseStored(window.localStorage.getItem(key), fallback);
    } catch (e2) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    var payload = JSON.stringify(value);
    try { window.sessionStorage.setItem(key, payload); } catch (e0) { /* ignore */ }
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, payload);
    } catch (e) { /* ignore */ }
    try { window.localStorage.setItem(key, payload); } catch (e2) { /* ignore */ }
  }

  function storageDel(key) {
    try { window.sessionStorage.removeItem(key); } catch (e0) { /* ignore */ }
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
    } catch (e) { /* ignore */ }
    try { window.localStorage.removeItem(key); } catch (e2) { /* ignore */ }
  }

  function loadPrefs() {
    var p = storageGet(PREF_KEY, null) || {};
    var out = {};
    for (var k in DEFAULT_PREFS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, k)) {
        out[k] = p[k] != null ? p[k] : DEFAULT_PREFS[k];
      }
    }
    return out;
  }

  function savePrefs(p) {
    storageSet(PREF_KEY, p);
  }

  function loadJob() {
    return storageGet(JOB_KEY, null);
  }

  function saveJob(job) {
    storageSet(JOB_KEY, job);
  }

  function clearJob() {
    storageDel(JOB_KEY);
  }

  /* ------------------------------------------------------------------ */
  /* Numbers                                                             */
  /* ------------------------------------------------------------------ */

  var SUFFIX = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, Q: 1e15 };

  function parseSCNumber(text) {
    if (text == null) return NaN;
    var s = String(text).replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
    if (!s || /^[\s.\-–—]*$/.test(s)) return NaN;
    s = s.replace(/\s*SC\$\s*/gi, ' ').replace(/\s*%\s*/g, ' ').replace(/months?/gi, ' ').trim();
    var m = s.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*([KMBTQ]))?/i);
    if (!m) {
      var n0 = parseFloat(s);
      return isFinite(n0) ? n0 : NaN;
    }
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return NaN;
    if (m[2]) n *= SUFFIX[m[2].toUpperCase()] || 1;
    return n;
  }

  function formatSCCompact(n) {
    if (!isFinite(n)) return '';
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    function fmt(v, suf) {
      var t = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      t = t.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
      return sign + t + suf;
    }
    if (abs >= 1e12) return fmt(n / 1e12, 'T') + ' SC$';
    if (abs >= 1e9) return fmt(n / 1e9, 'B') + ' SC$';
    if (abs >= 1e6) return fmt(n / 1e6, 'M') + ' SC$';
    if (abs >= 1e3) return fmt(n / 1e3, 'K') + ' SC$';
    return sign + String(Math.round(n)) + ' SC$';
  }

  function billionsFromRaw(raw) {
    if (!isFinite(raw)) return NaN;
    return raw / 1e9;
  }

  function parseThreshold(text) {
    var s = String(text == null ? '' : text).replace(/\u00a0/g, ' ').trim();
    if (!s) return 1e12;
    var n = parseSCNumber(s);
    if (!isFinite(n) || n < 0) return 1e12;
    if (!/[KMBTQkmbtq]/.test(s) && n <= 9999) return n * 1e9;
    return n;
  }

  function validHexColor(c) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c || '')) ? String(c) : '#b8860b';
  }

  function rawFromFormBillions(b) {
    return Math.round(b * 1e9);
  }

  /* ------------------------------------------------------------------ */
  /* Page detection                                                      */
  /* ------------------------------------------------------------------ */

  function qs(root, sel) {
    return (root || document).querySelector(sel);
  }

  function qsa(root, sel) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function paramMap(search) {
    var out = {};
    var s = search || '';
    if (s.charAt(0) === '?') s = s.slice(1);
    s.split('&').forEach(function (part) {
      if (!part) return;
      var i = part.indexOf('=');
      var k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
      var v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    });
    return out;
  }

  function getUrlParams() {
    var p = paramMap(location.search);
    if (!p.SN_METHOD && location.pathname) {
      var m = location.pathname.match(/cgiw\/?$/i) || location.href.match(/cgiw\?([a-z0-9_]+)/i);
      if (m && m[1]) p.SN_METHOD = m[1];
      var short = location.search.match(/^\?([a-z0-9_]+)(?:&|$)/i);
      if (short && !p.SN_METHOD) p.SN_METHOD = short[1];
    }
    return p;
  }

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function isLoanOfferFamily(doc) {
    var p = getUrlParams();
    var method = (p.SN_METHOD || '').toLowerCase();
    var methodHit = /^(loanmyoff|eloanmyoff|cloanmyoff|loanoffer|loanoff)$/.test(method);

    var form = findOfferForm(doc);
    var table = findOfferTable(doc);
    var titleHit = false;
    try {
      var t = (doc.title || '') + ' ' + textOf(qs(doc, '#pw_title, h1, .paragrapheader, .paragraphheader'));
      titleHit = /new loan offer|offered loans|loan offer/i.test(t);
    } catch (e) { /* ignore */ }

    var fieldHit = !!(form && form.querySelector('input[name="miMaxAmount"]') && form.querySelector('input[name="miPeriod"]'));
    var actionHit = !!(form && form.querySelector('input[name="miActionOffer"]'));
    var tableHit = !!(table && /offered loans/i.test(textOf(table.querySelector('caption')) + ' ' + textOf(table)));

    return {
      match: methodHit || fieldHit || actionHit || tableHit || (titleHit && (fieldHit || tableHit)),
      method: method,
      form: form,
      table: table,
      params: p
    };
  }

  function findOfferForm(doc) {
    var forms = qsa(doc, 'form');
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      var method = (f.querySelector('input[name="SN_METHOD"]') || {}).value || '';
      if (/loanmyoff|eloanmyoff|cloanmyoff|loanoffer/i.test(method) &&
          f.querySelector('input[name="miMaxAmount"]')) {
        return f;
      }
      if (f.querySelector('input[name="miActionOffer"]') &&
          f.querySelector('input[name="miMaxAmount"]') &&
          f.querySelector('input[name="miPeriod"]')) {
        return f;
      }
    }
    var byName = doc.querySelector('input[name="miMaxAmount"]');
    return byName ? byName.form : null;
  }

  function findOfferTable(doc) {
    var byId = qs(doc, '#loanlist');
    if (byId) return byId;
    var caps = qsa(doc, 'table caption');
    for (var i = 0; i < caps.length; i++) {
      if (/offered loans/i.test(textOf(caps[i]))) return caps[i].closest('table') || caps[i].parentNode;
    }
    var ths = qsa(doc, 'th.datacolheader, th');
    for (var j = 0; j < ths.length; j++) {
      if (/maximum amount/i.test(textOf(ths[j]))) {
        var inner = ths[j].closest('table');
        return inner && inner.closest('table#loanlist, table.datagroup, table.entlistborder') || inner;
      }
    }
    return null;
  }

  function detectEntity(form, params) {
    var addr = '';
    if (form) {
      var hid = form.querySelector('input[name="SN_ADDRESS"]');
      if (hid) addr = hid.value || '';
    }
    addr = addr || (params && params.SN_ADDRESS) || '';
    if (/enterprise/i.test(addr)) return 'enterprise';
    if (/country/i.test(addr)) return 'country';
    try {
      if (typeof ckLoginEnterprise === 'string' && ckLoginEnterprise) return 'enterprise';
      if (typeof ckLoginCountry === 'string' && ckLoginCountry) return 'country';
    } catch (e) { /* ignore */ }
    try {
      if (typeof dtDesktopOwnerKind === 'string') {
        if (dtDesktopOwnerKind === 'e') return 'enterprise';
        if (dtDesktopOwnerKind === 'c') return 'country';
      }
    } catch (e2) { /* ignore */ }
    return 'unknown';
  }

  /* ------------------------------------------------------------------ */
  /* Table model                                                         */
  /* ------------------------------------------------------------------ */

  function innerDataTable(outer) {
    if (!outer) return null;
    var inner = outer.querySelector('table.group, table');
    if (inner && inner !== outer) return inner;
    return outer;
  }

  function headerCells(row) {
    return qsa(row, 'th, td');
  }

  function buildColumnMap(headRow) {
    var map = { amount: -1, period: -1, rate: -1, retract: -1, cells: [] };
    var cells = headerCells(headRow);
    map.cells = cells;
    cells.forEach(function (cell, idx) {
      var t = textOf(cell).toLowerCase();
      if (!t || /^[\s\u00a0]*$/.test(t)) return;
      if (/maximum amount|max\.?\s*amount|amount/i.test(t) && map.amount < 0) map.amount = idx;
      else if (/^period|term|months/i.test(t) && map.period < 0) map.period = idx;
      else if (/interest/i.test(t) && map.rate < 0) map.rate = idx;
      else if (/retract/i.test(t) && map.retract < 0) map.retract = idx;
    });
    return map;
  }

  function parseRetractParams(href) {
    if (!href) return {};
    var q = href.split('?')[1] || '';
    return paramMap(q);
  }

  function collectRows(inner, map) {
    var rows = [];
    var trs = qsa(inner, 'tr');
    trs.forEach(function (tr, i) {
      if (i === 0) return;
      if (tr.querySelector('th')) return;
      var cells = qsa(tr, 'td');
      if (!cells.length) return;
      var amountText = map.amount >= 0 ? textOf(cells[map.amount]) : '';
      var periodText = map.period >= 0 ? textOf(cells[map.period]) : '';
      var rateText = map.rate >= 0 ? textOf(cells[map.rate]) : '';
      if (!amountText && !periodText && !rateText) return;
      if (/you have no|no existing|no offered/i.test(amountText + periodText)) return;

      var retractA = map.retract >= 0 ? cells[map.retract] && cells[map.retract].querySelector('a[href]') : tr.querySelector('a[href*="miActionRetract"]');
      var rp = parseRetractParams(retractA ? retractA.getAttribute('href') : '');

      var amount = parseSCNumber(amountText);
      if ((!isFinite(amount) || amount === 0) && rp.miMaxAmount) {
        amount = parseSCNumber(rp.miMaxAmount);
      }
      var period = parseSCNumber(periodText);
      if (!isFinite(period) && rp.miPeriod) period = parseSCNumber(rp.miPeriod);
      var rate = parseSCNumber(rateText);
      if (!isFinite(rate) && rp.miInterestRate) rate = parseSCNumber(rp.miInterestRate);

      rows.push({
        tr: tr,
        amount: amount,
        period: period,
        rate: rate,
        amountText: amountText,
        periodText: periodText,
        rateText: rateText,
        retractHref: retractA ? retractA.href : '',
        retractParams: rp,
        search: (amountText + ' ' + periodText + ' ' + rateText).toLowerCase()
      });
    });
    return rows;
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers                                                          */
  /* ------------------------------------------------------------------ */

  function injectCss(doc) {
    if (qs(doc, '#' + SCRIPT_ID + '-css')) return;
    var css = doc.createElement('style');
    css.id = SCRIPT_ID + '-css';
    css.textContent = [
      '#' + SCRIPT_ID + '-bar, .' + SCRIPT_ID + '-native { font: inherit; }',
      '.' + SCRIPT_ID + '-toolbar { margin: 6px 0 10px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
      '.' + SCRIPT_ID + '-toolbar input[type="search"], .' + SCRIPT_ID + '-toolbar input[type="text"] { font: inherit; }',
      '.' + SCRIPT_ID + '-sum { margin: 4px 0 8px 0; font-size: 0.95em; }',
      '.' + SCRIPT_ID + '-th { cursor: pointer; user-select: none; white-space: nowrap; }',
      '.' + SCRIPT_ID + '-th:focus { outline: 2px solid #036; outline-offset: 1px; }',
      '.' + SCRIPT_ID + '-ind { font-size: 0.85em; margin-left: 4px; }',
      'tr.' + SCRIPT_ID + '-hi > td.data { box-shadow: inset 3px 0 0 var(--sc-hi-color, #b8860b); }',
      'tr.' + SCRIPT_ID + '-hide { display: none !important; }',
      '.' + SCRIPT_ID + '-stock-submit { position: absolute !important; left: -9999px !important; width: 1px !important; height: 1px !important; overflow: hidden !important; }',
      '.' + SCRIPT_ID + '-toolbar label { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }',
      '.' + SCRIPT_ID + '-toolbar input[type="color"] { width: 28px; height: 22px; padding: 0; border: 1px solid #666; background: #fff; }',
      '.' + SCRIPT_ID + '-hi-mark { margin-left: 6px; font-size: 0.85em; }',
      '.' + SCRIPT_ID + '-banner { margin: 8px 0 12px 0; padding: 8px 10px; border: 1px solid #666; background: #f4f4e8; }',
      '.' + SCRIPT_ID + '-banner[data-state="run"] { background: #e8f0f8; }',
      '.' + SCRIPT_ID + '-banner[data-state="done"] { background: #e8f8ea; }',
      '.' + SCRIPT_ID + '-banner[data-state="err"] { background: #f8e8e8; }',
      '.' + SCRIPT_ID + '-hint { font-size: 0.9em; opacity: 0.85; }',
      'table.' + SCRIPT_ID + '-sticky thead th, table.' + SCRIPT_ID + '-sticky tr:first-child th { position: sticky; top: 0; background: #dce0fd; z-index: 2; }'
    ].join('\n');
    (doc.head || doc.documentElement).appendChild(css);
  }

  function makeButton(doc, className, value) {
    var btn = doc.createElement('input');
    btn.type = 'button';
    btn.className = className || 'deskbutton savebutton';
    btn.value = value;
    return btn;
  }

  /* ------------------------------------------------------------------ */
  /* Enhance form                                                        */
  /* ------------------------------------------------------------------ */

  function enhanceForm(doc, form, prefs, ctx) {
    if (!form || form.getAttribute(MARK + '-form')) return;
    form.setAttribute(MARK + '-form', '1');

    var amountInp = form.querySelector('input[name="miMaxAmount"]');
    var periodInp = form.querySelector('input[name="miPeriod"]');
    if (!amountInp || !periodInp) return;

    if (!amountInp.value && prefs.lastAmount) amountInp.value = prefs.lastAmount;
    if (!periodInp.value && prefs.lastPeriod) periodInp.value = prefs.lastPeriod;

    var inner = form.querySelector('table.group') || form.querySelector('table');
    if (!inner) return;

    var submitRow = null;
    var submits = qsa(form, 'input[type="submit"], button[type="submit"]');
    if (submits.length) submitRow = submits[0].closest('tr');

    var repeatRow = doc.createElement('tr');
    repeatRow.setAttribute(MARK + '-repeat-row', '1');
    repeatRow.innerHTML =
      '<td class="data">Repeat:</td>' +
      '<td class="data"></td>';
    var repeatCell = repeatRow.cells[1];
    var repeatInp = doc.createElement('input');
    repeatInp.type = 'text';
    repeatInp.size = 3;
    repeatInp.maxLength = 2;
    repeatInp.value = prefs.lastRepeat || '1';
    repeatInp.setAttribute('inputmode', 'numeric');
    repeatInp.setAttribute('autocomplete', 'off');
    repeatInp.setAttribute('aria-label', 'Number of identical offers to submit');
    repeatInp.id = SCRIPT_ID + '-repeat';
    /* no name attribute — must not ride along on native GET */
    repeatCell.appendChild(repeatInp);
    repeatCell.appendChild(doc.createTextNode(' times (max. ' + MAX_REPEAT + ')'));

    var hintRow = doc.createElement('tr');
    hintRow.innerHTML =
      '<td class="data" colspan="2"><span class="' + SCRIPT_ID + '-hint">' +
      'Repeat 1 sends a single offer. Repeat 2+ reloads the page once per offer. Interest is set by the world.' +
      '</span></td>';

    if (submitRow && submitRow.parentNode) {
      submitRow.parentNode.insertBefore(repeatRow, submitRow);
      submitRow.parentNode.insertBefore(hintRow, submitRow);
    } else {
      inner.appendChild(repeatRow);
      inner.appendChild(hintRow);
    }

    submits.forEach(function (btn) {
      btn.classList.add(SCRIPT_ID + '-stock-submit');
      btn.setAttribute('aria-hidden', 'true');
      btn.tabIndex = -1;
    });

    if (submitRow) {
      var cell = submitRow.querySelector('td[colspan], td[align="center"]') ||
        submitRow.cells[submitRow.cells.length - 1];
      if (cell && !qs(form, '#' + SCRIPT_ID + '-go')) {
        var goBtn = makeButton(doc, 'deskbutton savebutton', 'Submit Offer');
        goBtn.id = SCRIPT_ID + '-go';
        goBtn.setAttribute('aria-label', 'Submit loan offer');
        cell.appendChild(goBtn);
        function syncGoLabel() {
          var n = parseInt(repeatInp.value, 10);
          goBtn.value = (isFinite(n) && n > 1) ? 'Submit Offers' : 'Submit Offer';
        }
        syncGoLabel();
        repeatInp.addEventListener('input', syncGoLabel);
        goBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          startRepeatJob(doc, form, amountInp, periodInp, repeatInp, prefs, ctx);
        });
      }
    }

    form.addEventListener('submit', function (ev) {
      var job = loadJob();
      if (job && job.running) return;
      var times = parseInt(repeatInp.value, 10);
      if (!isFinite(times) || times < 2) {
        persistFormPrefs(prefs, amountInp, periodInp, repeatInp);
        return;
      }
      ev.preventDefault();
      startRepeatJob(doc, form, amountInp, periodInp, repeatInp, prefs, ctx);
    });
  }

  function persistFormPrefs(prefs, amountInp, periodInp, repeatInp) {
    prefs.lastAmount = amountInp.value || '';
    prefs.lastPeriod = periodInp.value || '';
    prefs.lastRepeat = repeatInp.value || '1';
    savePrefs(prefs);
  }

  function validateOffer(amountInp, periodInp, times) {
    var amount = parseSCNumber(amountInp.value);
    var period = parseSCNumber(periodInp.value);
    var errs = [];
    if (!isFinite(amount) || amount <= 0) errs.push('Enter a Max. Amount between 1 and 9999 B SC$.');
    else if (amount > 9999) errs.push('Max. Amount cannot exceed 9999 B SC$.');
    if (!isFinite(period) || period <= 0) errs.push('Enter a Period between 1 and 120 months.');
    else if (period > 120) errs.push('Period cannot exceed 120 months.');
    if (!isFinite(times) || times < 1) errs.push('Repeat must be at least 1.');
    if (times > MAX_REPEAT) errs.push('Repeat is capped at ' + MAX_REPEAT + ' to avoid flooding the server.');
    return { amount: amount, period: period, times: times, errors: errs };
  }

  function formControlValue(el) {
    if (!el || !el.name) return null;
    var type = (el.type || el.tagName || '').toLowerCase();
    if (type === 'file' || type === 'reset' || type === 'button') return null;
    if ((type === 'checkbox' || type === 'radio') && !el.checked) return null;
    if (el.disabled) return null;
    return el.value == null ? '' : String(el.value);
  }

  function serializeOfferForm(form) {
    var params = [];
    var els = form.elements ? Array.prototype.slice.call(form.elements) : [];
    var seenSubmit = false;
    els.forEach(function (el) {
      if (!el.name) return;
      var type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'image') {
        if (seenSubmit) return;
        seenSubmit = true;
      }
      var val = formControlValue(el);
      if (val == null) return;
      params.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(val));
    });
    if (!seenSubmit && form.querySelector('input[name="submit"]')) {
      params.push('submit=' + encodeURIComponent('Submit Offer'));
    }
    return params.join('&');
  }

  function formActionUrl(form) {
    var action = form.getAttribute('action') || location.pathname || '/cgi-bin/cgi2nova';
    try {
      return new URL(action, location.href).href.split('#')[0].split('?')[0];
    } catch (e) {
      return action;
    }
  }

  function offerPostUrl(form) {
    var base = formActionUrl(form);
    var q = serializeOfferForm(form);
    return q ? (base + '?' + q) : base;
  }

  function offerViewUrl(form) {
    var base = formActionUrl(form);
    var addr = form.querySelector('input[name="SN_ADDRESS"]');
    var method = form.querySelector('input[name="SN_METHOD"]');
    var parts = [];
    if (addr && addr.value) parts.push('SN_ADDRESS=' + encodeURIComponent(addr.value));
    if (method && method.value) parts.push('SN_METHOD=' + encodeURIComponent(method.value));
    return parts.length ? (base + '?' + parts.join('&')) : base;
  }

  /* Named <input name="submit"> shadows HTMLFormElement.submit on this page. */
  function nativeSubmit(form) {
    if (!form) return;
    var btn = form.querySelector('input[type="submit"], button[type="submit"]');
    try {
      if (btn && typeof form.requestSubmit === 'function') {
        form.requestSubmit(btn);
        return;
      }
    } catch (e0) { /* fall through */ }
    try {
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return;
      }
    } catch (e1) { /* fall through */ }
    try {
      var proto = window.HTMLFormElement && HTMLFormElement.prototype && HTMLFormElement.prototype.submit;
      if (typeof proto === 'function') {
        proto.call(form);
        return;
      }
    } catch (e2) { /* fall through */ }
    location.assign(offerPostUrl(form));
  }

  function countOfferRows(doc) {
    var n = qsa(doc, 'a[href*="miActionRetract"]').length;
    if (n) return n;
    var table = findOfferTable(doc);
    if (!table) return 0;
    var inner = innerDataTable(table);
    if (!inner) return 0;
    var rows = 0;
    qsa(inner, 'tr').forEach(function (tr, i) {
      if (i === 0 || tr.querySelector('th')) return;
      if (/retract/i.test(textOf(tr)) || parseSCNumber(textOf(tr))) rows += 1;
    });
    return rows;
  }

  function paddedAmount(amount, attempt) {
    var raw = String(Math.round(amount));
    if (raw.length >= 4) return raw;
    if (attempt % 2 === 1) return ('0000' + raw).slice(-4);
    return raw;
  }

  function startRepeatJob(doc, form, amountInp, periodInp, repeatInp, prefs, ctx) {
    var times = parseInt(String(repeatInp.value || '1').replace(/[^\d]/g, ''), 10) || 1;
    var v = validateOffer(amountInp, periodInp, times);
    if (v.errors.length) {
      window.alert(v.errors.join('\n'));
      return;
    }
    persistFormPrefs(prefs, amountInp, periodInp, repeatInp);
    amountInp.value = paddedAmount(v.amount, 1);
    periodInp.value = String(Math.round(v.period));
    var startBtn = form.querySelector('input[type="submit"], button[type="submit"]');
    if (startBtn) startBtn.value = 'Submit Offer';

    if (v.times === 1) {
      nativeSubmit(form);
      return;
    }

    var msg = 'Submit ' + v.times + ' offers of ' + Math.round(v.amount) +
      ' B SC$ for ' + Math.round(v.period) + ' months?\n\n' +
      'The page will reload once per offer (same as clicking Submit Offer). You can cancel between reloads.';
    if (!window.confirm(msg)) return;

    var job = {
      v: 3,
      amount: String(Math.round(v.amount)),
      period: String(Math.round(v.period)),
      left: v.times - 1,
      total: v.times,
      sent: 1,
      startCount: countOfferRows(doc),
      href: location.href.split('#')[0],
      viewUrl: offerViewUrl(form),
      method: ctx.method || '',
      entity: ctx.entity || '',
      started: Date.now(),
      running: true
    };
    repeatCancel = false;
    saveJob(job);
    showJobBanner(doc, job, 'Submitting offer 1 of ' + v.times + '…', 'run');
    window.setTimeout(function () { nativeSubmit(form); }, 200);
  }

  /* ------------------------------------------------------------------ */
  /* Repeat job continuation                                             */
  /* ------------------------------------------------------------------ */

  function jobBelongsHere(job, ctx) {
    if (!job || job.left < 1) return false;
    if (Date.now() - (job.started || 0) > 30 * 60 * 1000) return false;
    if (job.entity && ctx.entity && job.entity !== 'unknown' && ctx.entity !== 'unknown' && job.entity !== ctx.entity) {
      return false;
    }
    return true;
  }

  function continueRepeatJob(doc, form, prefs, ctx) {
    var job = loadJob();
    if (!job) return;
    var amountInp = form.querySelector('input[name="miMaxAmount"]');
    var periodInp = form.querySelector('input[name="miPeriod"]');
    var nowCount = countOfferRows(doc);
    var grown = (typeof job.startCount === 'number') ? (nowCount - job.startCount) : job.sent;

    if (!jobBelongsHere(job, ctx)) {
      if (job && job.sent && job.left < 1) {
        showJobBanner(doc, job,
          'Finished. Posted ' + job.sent + ' page submit' + (job.sent === 1 ? '' : 's') +
          '; list grew by ' + Math.max(0, grown) + ' row' + (grown === 1 ? '' : 's') + '.',
          grown >= job.total ? 'done' : 'err');
      }
      if (job && job.left < 1) clearJob();
      return;
    }

    if (repeatCancel) {
      showJobBanner(doc, job, 'Cancelled. List grew by ' + Math.max(0, grown) + '.', 'done');
      clearJob();
      return;
    }

    if (amountInp) amountInp.value = paddedAmount(parseSCNumber(job.amount), job.sent + 1);
    if (periodInp) periodInp.value = job.period;
    var contBtn = form.querySelector('input[type="submit"], button[type="submit"]');
    if (contBtn) contBtn.value = (job.sent % 2) ? 'Submit Offer' : 'Submit Offer ';

    var delay = Math.max(800, parseInt(prefs.delayMs, 10) || REPEAT_DELAY_MS);
    var next = job.sent + 1;
    showJobBanner(doc, job,
      'Offer page loaded (' + nowCount + ' listed, +' + Math.max(0, grown) + '). Submitting ' + next + ' of ' + job.total + '…',
      'run');

    job.sent = next;
    job.left = Math.max(0, job.total - job.sent);
    job.lastCount = nowCount;
    saveJob(job);

    window.setTimeout(function () {
      if (repeatCancel) {
        clearJob();
        return;
      }
      nativeSubmit(form);
    }, delay);
  }

  function showJobBanner(doc, job, text, state) {
    var host = findBannerHost(doc);
    if (!host) return;
    var el = qs(doc, '#' + SCRIPT_ID + '-banner');
    if (!el) {
      el = doc.createElement('div');
      el.id = SCRIPT_ID + '-banner';
      el.className = SCRIPT_ID + '-banner';
      el.setAttribute('role', 'status');
      host.insertBefore(el, host.firstChild);
    }
    var left = job ? job.left : 0;
    var running = !!(job && job.running && left > 0 && !repeatCancel);
    el.setAttribute('data-state', state || (running ? 'run' : 'done'));
    el.innerHTML = '';
    var p = doc.createElement('div');
    p.textContent = text || (running
      ? ('Repeat job: ' + (job.sent || 0) + ' / ' + job.total)
      : 'Repeat job finished.');
    el.appendChild(p);
    if (job && job.amount) {
      var d = doc.createElement('div');
      d.className = SCRIPT_ID + '-hint';
      d.textContent = job.amount + ' B SC$  ·  ' + job.period + ' months' +
        (job.sent != null ? ' · sent ' + job.sent : '');
      el.appendChild(d);
    }
    var cancel = makeButton(doc, 'deskbutton', running ? 'Cancel remaining' : 'Dismiss');
    cancel.addEventListener('click', function () {
      repeatCancel = true;
      if (running) {
        showJobBanner(doc, job, 'Cancelling after the current request…', 'err');
        return;
      }
      clearJob();
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    el.appendChild(cancel);
  }

  function findBannerHost(doc) {
    return qs(doc, '#pw_contents .desktop_tabmargin, .desktop_tabpage, a[name="new_loan_offer"]') &&
      (qs(doc, 'a[name="new_loan_offer"]') || qs(doc, '#pw_contents') || qs(doc, '.desktop_tabmargin')) ||
      qs(doc, '#pw_contents') ||
      qs(doc, '.appletbody') ||
      doc.body;
  }

  /* ------------------------------------------------------------------ */
  /* Enhance table                                                       */
  /* ------------------------------------------------------------------ */

  function enhanceTable(doc, table, prefs, form) {
    if (!table || table.getAttribute(MARK + '-table')) return;
    table.setAttribute(MARK + '-table', '1');

    var inner = innerDataTable(table);
    if (!inner) return;
    var headRow = inner.querySelector('tr');
    if (!headRow) return;
    var map = buildColumnMap(headRow);
    var rows = collectRows(inner, map);
    if (!rows.length) {
      decorateToolbar(doc, table, inner, map, rows, prefs, form);
      return;
    }

    inner.classList.add(SCRIPT_ID + '-sticky');

    ['amount', 'period', 'rate'].forEach(function (key) {
      var idx = map[key];
      if (idx < 0 || !map.cells[idx]) return;
      var th = map.cells[idx];
      th.classList.add(SCRIPT_ID + '-th');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      th.setAttribute('aria-label', 'Sort by ' + textOf(th));
      if (!th.querySelector('.' + SCRIPT_ID + '-ind')) {
        var ind = doc.createElement('span');
        ind.className = SCRIPT_ID + '-ind';
        ind.setAttribute('aria-hidden', 'true');
        th.appendChild(ind);
      }
      function toggle() {
        if (prefs.sortKey === key) prefs.sortDir = prefs.sortDir === 'asc' ? 'desc' : 'asc';
        else {
          prefs.sortKey = key;
          prefs.sortDir = key === 'amount' ? 'desc' : 'asc';
        }
        savePrefs(prefs);
        applyView(doc, inner, map, collectRows(inner, map), prefs);
      }
      th.addEventListener('click', toggle);
      th.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          toggle();
        }
      });
    });

    rows.forEach(function (r) {
      if (isFinite(r.amount)) {
        r.tr.title = (r.tr.title ? r.tr.title + ' · ' : '') +
          'Parsed: ' + formatSCCompact(r.amount) +
          ' (' + String(r.amount) + ')' +
          (isFinite(r.period) ? ', ' + r.period + ' months' : '') +
          (isFinite(r.rate) ? ', ' + r.rate + '%' : '');
      }
      if (form && isFinite(r.amount)) {
        r.tr.style.cursor = 'pointer';
        r.tr.addEventListener('click', function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest('a')) return;
          var amountInp = form.querySelector('input[name="miMaxAmount"]');
          var periodInp = form.querySelector('input[name="miPeriod"]');
          if (!amountInp || !periodInp) return;
          var b = billionsFromRaw(r.amount);
          if (!isFinite(b)) b = r.amount;
          if (b > 9999 && r.amount >= 1e9) b = r.amount / 1e9;
          amountInp.value = String(Math.max(1, Math.min(9999, Math.round(b))));
          if (isFinite(r.period)) periodInp.value = String(Math.max(1, Math.min(120, Math.round(r.period))));
          amountInp.focus();
        });
      }
    });

    decorateToolbar(doc, table, inner, map, rows, prefs, form);
    applyView(doc, inner, map, rows, prefs);
  }

  function decorateToolbar(doc, outer, inner, map, rows, prefs, form) {
    if (qs(doc, '#' + SCRIPT_ID + '-tools')) return;
    var bar = doc.createElement('div');
    bar.id = SCRIPT_ID + '-tools';
    bar.className = SCRIPT_ID + '-toolbar';

    var lab = doc.createElement('label');
    lab.textContent = 'Filter: ';
    lab.setAttribute('for', SCRIPT_ID + '-filter');
    var filt = doc.createElement('input');
    filt.type = 'search';
    filt.id = SCRIPT_ID + '-filter';
    filt.size = 24;
    filt.placeholder = 'amount, period, rate…';
    filt.value = prefs.filter || '';
    filt.setAttribute('aria-label', 'Filter offered loans');
    lab.appendChild(filt);
    bar.appendChild(lab);

    var hiLab = doc.createElement('label');
    var hiChk = doc.createElement('input');
    hiChk.type = 'checkbox';
    hiChk.id = SCRIPT_ID + '-hi-on';
    hiChk.checked = prefs.highlightOn !== false;
    hiLab.appendChild(hiChk);
    hiLab.appendChild(doc.createTextNode(' Highlight'));
    hiLab.setAttribute('title', 'Draw an edge on offers at or above the threshold');
    bar.appendChild(hiLab);

    var colLab = doc.createElement('label');
    colLab.appendChild(doc.createTextNode('Color '));
    var colInp = doc.createElement('input');
    colInp.type = 'color';
    colInp.id = SCRIPT_ID + '-hi-color';
    colInp.value = validHexColor(prefs.highlightColor);
    colInp.setAttribute('aria-label', 'Highlight color');
    colLab.appendChild(colInp);
    bar.appendChild(colLab);

    var thrLab = doc.createElement('label');
    thrLab.appendChild(doc.createTextNode('Min '));
    var thrInp = doc.createElement('input');
    thrInp.type = 'text';
    thrInp.id = SCRIPT_ID + '-hi-thr';
    thrInp.size = 6;
    thrInp.value = prefs.highlightThresholdText || '1T';
    thrInp.title = 'Threshold with suffix: 500B, 1T, 2.5T. A bare 1–9999 is billions.';
    thrInp.setAttribute('aria-label', 'Highlight threshold');
    thrLab.appendChild(thrInp);
    bar.appendChild(thrLab);

    var reset = makeButton(doc, 'deskbutton', 'Reset view');
    reset.addEventListener('click', function () {
      prefs.filter = '';
      prefs.sortKey = 'amount';
      prefs.sortDir = 'desc';
      prefs.highlightOn = true;
      prefs.highlightColor = '#b8860b';
      prefs.highlightThresholdText = '1T';
      filt.value = '';
      hiChk.checked = true;
      colInp.value = '#b8860b';
      thrInp.value = '1T';
      savePrefs(prefs);
      applyView(doc, inner, map, collectRows(inner, map), prefs);
    });
    bar.appendChild(reset);

    var csv = makeButton(doc, 'deskbutton', 'Copy CSV');
    csv.addEventListener('click', function () {
      copyCsv(collectRows(inner, map).filter(function (r) {
        return r.tr.className.indexOf(SCRIPT_ID + '-hide') < 0 && r.tr.style.display !== 'none';
      }));
    });
    bar.appendChild(csv);

    var sum = doc.createElement('div');
    sum.id = SCRIPT_ID + '-sum';
    sum.className = SCRIPT_ID + '-sum';
    sum.setAttribute('aria-live', 'polite');

    var parent = outer.parentNode;
    if (parent) {
      parent.insertBefore(bar, outer);
      parent.insertBefore(sum, outer);
    } else {
      outer.insertBefore(bar, outer.firstChild);
    }

    function refreshHi() {
      prefs.filter = filt.value || '';
      prefs.highlightOn = !!hiChk.checked;
      prefs.highlightColor = validHexColor(colInp.value);
      prefs.highlightThresholdText = thrInp.value || '1T';
      savePrefs(prefs);
      applyView(doc, inner, map, collectRows(inner, map), prefs);
    }
    filt.addEventListener('input', refreshHi);
    hiChk.addEventListener('change', refreshHi);
    colInp.addEventListener('input', refreshHi);
    thrInp.addEventListener('change', refreshHi);
    thrInp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); refreshHi(); }
    });
  }

  function applyView(doc, inner, map, rows, prefs) {
    var color = validHexColor(prefs.highlightColor);
    if (inner && inner.style && inner.style.setProperty) {
      inner.style.setProperty('--sc-hi-color', color);
    }
    if (doc.documentElement && doc.documentElement.style && doc.documentElement.style.setProperty) {
      doc.documentElement.style.setProperty('--sc-hi-color', color);
    }
    var q = (prefs.filter || '').toLowerCase().trim();
    var visible = [];
    rows.forEach(function (r) {
      var show = !q || r.search.indexOf(q) >= 0 ||
        (isFinite(r.amount) && formatSCCompact(r.amount).toLowerCase().indexOf(q) >= 0);
      if (show) {
        r.tr.classList.remove(SCRIPT_ID + '-hide');
        visible.push(r);
      } else {
        r.tr.classList.add(SCRIPT_ID + '-hide');
      }
      var thr = parseThreshold(prefs.highlightThresholdText);
      var mark = r.tr.querySelector('.' + SCRIPT_ID + '-hi-mark');
      if (prefs.highlightOn !== false && isFinite(r.amount) && isFinite(thr) && r.amount >= thr) {
        r.tr.classList.add(SCRIPT_ID + '-hi');
        if (!mark) {
          mark = r.tr.ownerDocument.createElement('span');
          mark.className = SCRIPT_ID + '-hi-mark';
          mark.setAttribute('aria-label', 'At or above highlight threshold');
          var lastTd = r.tr.cells[r.tr.cells.length - 1];
          if (lastTd) lastTd.appendChild(mark);
        }
        mark.textContent = ' ●';
        mark.style.color = validHexColor(prefs.highlightColor);
      } else {
        r.tr.classList.remove(SCRIPT_ID + '-hi');
        if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
      }
    });

    var key = prefs.sortKey || 'amount';
    var dir = prefs.sortDir === 'asc' ? 1 : -1;
    visible.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      var aN = isFinite(av);
      var bN = isFinite(bv);
      if (!aN && !bN) return 0;
      if (!aN) return 1;
      if (!bN) return -1;
      if (av === bv) return (a.amount - b.amount) * dir;
      return av > bv ? dir : -dir;
    });

    var parent = inner.tBodies[0] || inner;
    visible.forEach(function (r) {
      parent.appendChild(r.tr);
    });
    rows.forEach(function (r) {
      if (r.tr.classList.contains(SCRIPT_ID + '-hide')) parent.appendChild(r.tr);
    });

    qsa(inner, '.' + SCRIPT_ID + '-ind').forEach(function (el) { el.textContent = ''; });
    var idx = map[key];
    if (idx >= 0 && map.cells[idx]) {
      var ind = map.cells[idx].querySelector('.' + SCRIPT_ID + '-ind');
      if (ind) ind.textContent = prefs.sortDir === 'asc' ? ' ▲' : ' ▼';
      map.cells[idx].setAttribute('aria-sort', prefs.sortDir === 'asc' ? 'ascending' : 'descending');
    }

    var sumEl = qs(doc, '#' + SCRIPT_ID + '-sum');
    if (sumEl) {
      var totalAmt = 0;
      var rates = {};
      visible.forEach(function (r) {
        if (isFinite(r.amount)) totalAmt += r.amount;
        if (isFinite(r.rate)) rates[String(r.rate)] = (rates[String(r.rate)] || 0) + 1;
      });
      var rateBits = Object.keys(rates).map(function (k) { return k + '% ×' + rates[k]; }).join(', ');
      sumEl.textContent = visible.length + ' offer' + (visible.length === 1 ? '' : 's') +
        (q ? ' matching filter' : '') +
        ' · booked max ' + formatSCCompact(totalAmt) +
        (rateBits ? ' · rates ' + rateBits : '') +
        (prefs.highlightOn !== false
          ? ' · marked rows are ≥ ' + (prefs.highlightThresholdText || '1T')
          : '') +
        ' · click a row to copy amount/period into the form';
    }
  }

  function copyCsv(rows) {
    var lines = ['Maximum Amount,Amount Raw,Period Months,Interest Rate %,Retract URL'];
    rows.forEach(function (r) {
      lines.push([
        csvEscape(r.amountText),
        isFinite(r.amount) ? String(r.amount) : '',
        isFinite(r.period) ? String(r.period) : csvEscape(r.periodText),
        isFinite(r.rate) ? String(r.rate) : csvEscape(r.rateText),
        csvEscape(r.retractHref)
      ].join(','));
    });
    var text = lines.join('\n');
    function fallback() {
      window.prompt('Copy CSV:', text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        window.alert('Copied ' + rows.length + ' row(s) to the clipboard.');
      }).catch(fallback);
    } else fallback();
  }

  function csvEscape(s) {
    s = s == null ? '' : String(s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function enhance(doc) {
    if (!doc || !doc.body) return false;
    var det = isLoanOfferFamily(doc);
    if (!det.match) return false;
    if (doc.documentElement.getAttribute(MARK)) return true;
    doc.documentElement.setAttribute(MARK, '1');

    injectCss(doc);
    var prefs = loadPrefs();
    var entity = detectEntity(det.form, det.params);
    var ctx = { method: det.method, entity: entity, params: det.params };

    try { if (det.form) enhanceForm(doc, det.form, prefs, ctx); }
    catch (e1) { console.warn(SCRIPT_ID, 'form', e1); }
    try { if (det.table) enhanceTable(doc, det.table, prefs, det.form); }
    catch (e2) { console.warn(SCRIPT_ID, 'table', e2); }

    try {
      var job = loadJob();
      if (job && det.form && job.left > 0 && jobBelongsHere(job, ctx)) {
        continueRepeatJob(doc, det.form, prefs, ctx);
      } else if (job && job.sent) {
        var grown = countOfferRows(doc) - (job.startCount || 0);
        showJobBanner(doc, job,
          'Finished. Posted ' + job.sent + ' page submit' + (job.sent === 1 ? '' : 's') +
          '; list grew by ' + Math.max(0, grown) + '.',
          grown >= (job.total || job.sent) ? 'done' : 'err');
        clearJob();
      }
    } catch (e3) { console.warn(SCRIPT_ID, 'job', e3); }

    return true;
  }

  function boot() {
    var docs = [document];
    try {
      if (window.top && window.top.document && window.top.document !== document) {
        /* stay in the document that actually has the table */
      }
    } catch (e) { /* cross-origin frame */ }

    if (enhance(document)) return;

    var obs = new MutationObserver(function () {
      if (enhance(document)) obs.disconnect();
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    window.setTimeout(function () { try { obs.disconnect(); } catch (e2) { /* ignore */ } }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
