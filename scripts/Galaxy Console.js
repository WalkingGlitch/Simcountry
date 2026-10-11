// ==UserScript==
// @name         Simcountry Galaxy Console
// @namespace    https://simcountry.com/galaxy-plus
// @version      3.1.6
// @description  Galaxy Console (formerly Galaxy+): CentauDos viewer and console. Shuttle register + event log (IndexedDB, CSV in/out), shuttle/station/market/docking lists, shuttle flights, rename and bulk rename, transport requests (writes OFF by default, each confirmed).
// @author       TheWalkingGlitch
// @match        https://www.simcountry.com/cgi-bin/cgi2nova*
// @match        https://*.simcountry.com/cgi-bin/cgiw*
// @match        https://*.simcountry.com/cgi-bin/cgip*
// @grant        none
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  const VERSION = '3.1.6';
  const W = window;

  /* ===================================================================
   * SETTINGS BLOCK: every list-length limit and cadence lives here.
   * Generous by default (desktop); tighten here if ever needed.
   * =================================================================== */
  const LIMITS = Object.freeze(Object.assign({
    DEBUG_RING: 15000,           // debug log entries kept in memory (both channels)
    EVENT_RING_UI: 20000,        // newest shuttle events kept in memory for the Events tab
    NET_LOG_RING: 2000,          // request log entries inside the RequestClient
    PAGE_CACHE_LRU: 60,          // parsed server pages (station info, docks...) kept in memory
    SHIP_LOGBOOK_LINES: 200,     // logbook lines parsed per shuttle detail read
    SHIP_LOGBOOK_KEEP: 10000000, /* 3.1.6: keep all lines (global logbook budget is the only limit) */     // accumulated logbook lines kept per shuttle in the register (union of all reads)
    VTABLE_OVERSCAN: 30,         // extra rows rendered above/below the visible window
    VTABLE_ROW_PX: 22,           // fixed row height of virtual tables
    IDB_BATCH: 500,              // max records per IndexedDB write transaction
    TRANSPORT_QUEUE_MAX: 200,    // staged transport requests
  }, W.__GXP_TEST__ && W.__GXP_LIMITS__ || {})); // tests may shrink limits to reach saturation quickly
  const CADENCE = Object.freeze({
    LAYER_FAST_MS: 20000, LAYER_MID_MS: 30000, LAYER_SLOW_MS: 60000, // same back-off as the game (gxscript l.50096)
    ERROR_MAX_MS: 120000, HIDDEN_MS: 5000,
    ACTIVE_REFRESH_MS: 20000,    // shuttles in flight / changing: same cadence as the game's map refresh
    IDLE_REFRESH_MS: 600000,     // idle shuttles: every 10 min
    STALE_REFRESH_MS: 3600000,   // not seen on map or list: hourly
    DETAIL_GAP_MS: 250,          // politeness gap between detail requests (concurrency 2 in the client)
    DETAIL_ERROR_RETRY_MS: 120000,
    SESSION_KEEPALIVE_MS: 600000,// read-only session probe while signed in
    COOKIE_WATCH_MS: 5000,       // detect sign-in in another tab via the portal cookie (value is hashed, never stored/logged)
    MARKET_STATION_REFRESH_MS: 1800000, // each station's market re-read (one station page at a time) when older than this
    MARKET_TIMER_MS: 60000,      // how often the slow market timer looks for one stale station
    MARKET_EVENT_DEBOUNCE_MS: 60000, // min gap between shuttle-triggered refreshes of the same station
    EVICT_DAYS: 30, EVICT_SESSIONS: 60, // evict only if BOTH exceeded
  });
  const DEFAULT_SETTINGS = Object.freeze({ meOverride: '', meExtra: '', colModes: {}, /* old 0.2.x key 'me' is ignored */ tuSeconds: 4, writesEnabled: false, writeRename: false, writeFlights: false, writeCargo: false, writeDocking: false, writeTrade: false, devTools: false, dryRun: false, formCapture: false, executeNow: true, gameDayTu: 24, notifyArrivals: false, notifyMineOnly: true, notifyTransports: false, notifyDesktop: true, notifySound: true, shortcuts: {}, layoutMemory: true, keepAliveMin: 10, mapMissTolerance: 3, linkNames: true, linkNamesTables: true, stopOnError: true, autoDetails: true, debugLevel: 'info' });

  const GXP_HASH = '#galaxyplus';
  const GXP_URL = 'https://www.simcountry.com/cgi-bin/cgi2nova?SN_ADDRESS=wwwPortal&SN_METHOD=gxRoot&miZoomLevel=0' + GXP_HASH;
  const IMG = 'https://images.simcountry.com/';
  const ZOOM_FACTOR = 5 / 3;
  /* ===================================================================
   * DEBUG LOG: two channels (net, script), ring buffer, level filter.
   * =================================================================== */
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  /* ---------- 3.1.5 memory safeguards: size estimates, per-entry caps, byte budgets (see ARCHITECTURE §0f) ---------- */
  const MEM = Object.freeze({
    DEBUG_BYTES: 500 * 1048576, DEBUG_BYTES_MIN: 5 * 1048576, DEBUG_BYTES_MAX: 4096 * 1048576, /* 3.1.6: generous last-resort caps */   // debug log byte budget (Developer settings)
    ENTRY_MSG: 65536, ENTRY_DATA: 262144,                                                          // per debug entry: message / data text (chars)
    EVENT_BYTES: 2048 * 1048576, EVENT_BYTES_MIN: 20 * 1048576, EVENT_BYTES_MAX: 8192 * 1048576, // events in memory byte budget
    EVENT_FIELD: 16384,                                                                           // per event string field (chars)
    LOGBOOK_BYTES: 1024 * 1048576,                                                                 // all shuttles' accumulated logbooks in the register
    LOGBOOK_MIN_KEEP: 100,                                                                       // logbook lines per shuttle never trimmed below this
    PAGE_CACHE_BYTES: 256 * 1048576,                                                              // parsed-page LRU
    SHIPLOG_CACHE: 2000,                                                                          // shuttles whose parsed logbook tab rows are cached
    MKHIST_POINTS: 1000000,                                                                        // market quantity history points (all products × stations)
    CAPTURE_ITEM: 1048576,                                                                         // one form-capture item (chars of JSON)
    TREND_KEYS: 50000,                                                                            // keys per trends hour bucket and dimension
    WATCH_MS: 60000, HEAP_WARN: 0.9                                                             // watchdog period; JS heap share that triggers trimming
  });
  /** rough size in bytes of a JS value (UTF-16 strings, 8-byte numbers, object/array overhead); bounded walk */
  function estBytes(v, budget) {
    let n = 0, nodes = 0; const max = budget || 20000, seen = new Set();
    const walk = x => { if (++nodes > max) return; if (x == null) { n += 8; return; } const t = typeof x;
      if (t === 'string') { n += 40 + 2 * x.length; return; } if (t === 'number' || t === 'boolean') { n += 8; return; } if (t !== 'object' || seen.has(x)) return; seen.add(x);
      if (Array.isArray(x)) { n += 32 + 8 * x.length; for (const y of x) walk(y); return; } if (x instanceof Map) { n += 64 + 40 * x.size; for (const [k, y] of x) { walk(k); walk(y); } return; }
      const ks = Object.keys(x); n += 48 + 16 * ks.length; for (const k of ks) walk(x[k]); };
    walk(v); return n;
  }
  const capStr = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n) + `…[truncated ${s.length - n} chars]` : s; };
  function createDebug() {
    const ring = []; let seq = 0; let cap = LIMITS.DEBUG_RING; /* 3.0.8: adjustable (Settings > Developer) */ const subs = new Set(); let minLevel = 'debug';
    let bytes = 0, budget = MEM.DEBUG_BYTES, trimmedBytes = 0, truncated = 0, warned = false, onBudget = null;
    /* 3.1.5: entries keep TEXT only (message ≤ 4 KB, data as JSON ≤ 16 KB, truncated with a marker) so no response body or live object is pinned;
     * trimming is by row count AND by estimated bytes (budget), amortised (batch of ≥ 5 %). */
    const entryBytes = e => 120 + 2 * (e.msg.length + (e.dataText ? e.dataText.length : 0));
    const trim = force => { let drop = 0; if (ring.length - cap >= (force ? 1 : Math.max(200, cap * 0.05))) drop = ring.length - cap;
      if (bytes > budget) { let b = bytes, i = 0; const goal = budget * 0.9; while (i < ring.length && b > goal) { b -= ring[i].b; i++; } drop = Math.max(drop, i);
        if (!warned) { warned = true; if (onBudget) try { onBudget(); } catch (e) { /* */ } } }
      if (drop > 0) { const gone = ring.splice(0, drop); let gb = 0; for (const g of gone) gb += g.b; bytes -= gb; trimmedBytes += gb; } };
    const add = (channel, level, msg, data) => {
      if (LEVELS[level] < LEVELS[minLevel]) return;
      let m = String(msg), dt; if (m.length > MEM.ENTRY_MSG) { m = capStr(m, MEM.ENTRY_MSG); truncated++; }
      if (data !== undefined) { dt = typeof data === 'string' ? JSON.stringify(data.length > MEM.ENTRY_DATA ? capStr(data, MEM.ENTRY_DATA) : data) : safeJson(data, MEM.ENTRY_DATA); if (dt.length > MEM.ENTRY_DATA) { dt = capStr(dt, MEM.ENTRY_DATA); truncated++; } }
      const e = { n: ++seq, t: Date.now(), channel, level, msg: m, dataText: dt }; e.b = entryBytes(e); bytes += e.b;
      ring.push(e); trim(false); // 3.0.9: batch trim (amortised O(1)); 3.1.5: + byte budget
      for (const f of subs) { try { f(); } catch (e) { /* */ } }
    };
    const api = {
      setLimit: n => { cap = Math.max(1000, Math.min(100000, Math.round(+n) || LIMITS.DEBUG_RING)); trim(true); for (const f of subs) { try { f(); } catch (e) { /* */ } } return cap; },
      limit: () => cap, size: () => Math.min(ring.length, cap),
      setByteBudget: n => { budget = Math.max(MEM.DEBUG_BYTES_MIN, Math.min(MEM.DEBUG_BYTES_MAX, Math.round(+n) || MEM.DEBUG_BYTES)); warned = false; trim(true); return budget; },
      byteBudget: () => budget, bytes: () => bytes, onBudget: f => { onBudget = f; }, minLevel: () => minLevel,
      stats: () => ({ rows: ring.length, bytes, budget, trimmedBytes, truncated, minLevel }),
      trimTo: frac => { const goal = budget * frac; let i = 0, b = bytes; while (i < ring.length && b > goal) { b -= ring[i].b; i++; } if (i) { const gone = ring.splice(0, i); for (const g of gone) { bytes -= g.b; trimmedBytes += g.b; } } return i; },
      reset: () => { const n = ring.length; ring.length = 0; bytes = 0; warned = false; for (const f of subs) { try { f(); } catch (e) { /* */ } } add('script', 'info', `debug log reset (${n} rows cleared)`); return n; },
      net: (level, msg, data) => add('net', level, msg, data),
      script: (level, msg, data) => add('script', level, msg, data),
      entries: (channel, level) => (ring.length > cap ? ring.slice(-cap) : ring).filter(e => (!channel || channel === 'all' || e.channel === channel) && LEVELS[e.level] >= LEVELS[level || 'debug']),
      setMinLevel: l => { minLevel = l; }, subscribe: f => { subs.add(f); return () => subs.delete(f); },
      toText: (channel, level) => api.entries(channel, level).map(dbgLine).join('\n'),
      /** 3.1.5: streamed text (chunks of ≤ 2,000 lines) for copy/export without one giant intermediate array of strings */
      textChunks: function* (channel, level, last) { let L = api.entries(channel, level); if (last) L = L.slice(-last); for (let i = 0; i < L.length; i += 2000) yield L.slice(i, i + 2000).map(dbgLine).join('\n'); },
    };
    return api;
  }
  const dbgLine = e => `${new Date(e.t).toISOString()} [${e.channel}] ${e.level.toUpperCase()} ${e.msg}${e.dataText !== undefined ? ' ' + e.dataText : ''}`;
  /** JSON text; with max: never builds more than ~max chars for big strings inside (they are cut first) */
  const safeJson = (v, max) => { try { if (!max) return JSON.stringify(v); return JSON.stringify(v, (k, x) => typeof x === 'string' && x.length > max ? capStr(x, Math.max(256, max >> 2)) : x); } catch (e) { return String(v); } };

  /* ===================================================================
   * STRICT ALLOWLISTS
   * READ: probed public views + login-only picker lists (see EXPLORE-GALAXY-BRIEF.md).
   * WRITE: exactly one method, gated (setting OFF by default + live form capture must match).
   * =================================================================== */
  const SORT = ['miObjectID', 'miObjectView', 'miObjectSort', 'miObjectOrder'];
  const READ_METHODS = Object.freeze({
    gxGetShipsLayer:        { script: 'cgigx', params: ['miTimeStamp', 'miZoomLevel'] },
    gxQuerySpaceShips:      { script: 'cgip', params: SORT },
    gxQuerySpaceStations:   { script: 'cgip', params: SORT },
    gxQueryDockingStations: { script: 'cgip', params: SORT },
    gxQuerySpaceMarkets:    { script: 'cgip', params: SORT },
    gxTransportRequests:    { script: 'cgip', params: [] },
    gxShipInfo:             { script: 'cgip', params: ['miShipID'] },
    // gxGetTransportInfo(id) opens /cgi-bin/cgip?gxTransportInfo&miKey=<id> (gxscript l.52773): read-only info popup.
    // gxDelTransportRequest (red X "Cancel Transport") is a gated WRITE (see WRITE_METHODS), never a read.
    gxTransportInfo:        { script: 'cgip', params: ['miKey'], login: true },
    gxInfo:                 { script: 'cgip', params: ['miKey', 'miObjectKind', 'miObjectView', 'miObjectSort'] },
    gxProductInfo:          { script: 'cgip', params: ['miProduct'] },
    // 0.2.5 read-only tab fragments, exactly what the game's sortable tabs load via deskmenu_gxsort(id,view,cur,next,order,method,target)
    // -> GET /cgi-bin/cgip?<method>&miObjectID&miObjectView&miObjectSort&miObjectOrder (gxscript l.51280, gxObjectFrame -> jxGetObjectContent)
    gxShipCargo:            { script: 'cgip', params: SORT },   // shuttle details: cargo tab
    gxShipLogs:             { script: 'cgip', params: SORT },   // shuttle details: logbook tab
    gxUserInventory:        { script: 'cgip', params: SORT },   // station: Products Stored (yours)
    gxUserLogs:             { script: 'cgip', params: SORT },   // station: Activities (yours)
    gxDockingStations:      { script: 'cgip', params: SORT },   // station: docking list, view 2 = free
    // 0.2.6 reads used by the form-capture scan (the game's own views; they only DISPLAY data or an unsubmitted form)
    gxFlightPlan:           { script: 'cgip', params: ['miObjectID'] },              // gxShuttleAction('gxFlightPlan',id,'tsFlightPlan') l.51526
    gxTradeDocking:         { script: 'cgip', params: ['miObjectID', 'miDockID'] },  // dock detail + offers, l.51371
    gxTradeProduct:         { script: 'cgip', params: ['miObjectID', 'miProduct'] }, // market trade form (not submitted), l.51421
    // login-only picker lists used by the original transport form (gxscript l.52249-52580)
    // gxNewTransportRequest: client code (gxscript l.52015) only loads the empty form markup into the modal (pure form fetch).
    // Galaxy Console builds the form client-side; this read is only used to log whether the live form's field set matches the code-derived one.
    gxNewTransportRequest:  { script: 'cgip', params: [], login: true },
    gxGetTransportOrigins:  { script: 'cgip', params: [], login: true },
    gxGetTransportTargets:  { script: 'cgip', params: [], login: true },
    gxGetTransportProducts: { script: 'cgip', login: true, params: ['miSrcWorldID', 'miSrcEntityKind', 'miSrcEntityID', 'miSrcTargetKind', 'miSrcTargetID', 'miSrcStationID', 'miDstTargetKind', 'miObjectSort', 'miObjectOrder'] },
  });
  // The ONLY write. Field list = everything the original form posts via deskform_getpostlist(f,'mi')
  // as far as the client code reveals (gxSelTransportOrigin/Target/Product, gxCheckNewTransportRequest).
  const TRANSPORT_FIELDS = Object.freeze(['miOrigin', 'miSrcTargetKind', 'miSrcWorldID', 'miSrcEntityKind', 'miSrcEntityID', 'miSrcTargetID', 'miSrcStationID',
    'miTarget', 'miDstTargetKind', 'miDstWorldID', 'miDstEntityKind', 'miDstEntityID', 'miDstTargetID', 'miDstStationID',
    'miProductName', 'miProduct', 'miQuantity']);
  const WRITE_METHODS = Object.freeze({
    gxAddTransportRequest: { script: 'cgip', fields: TRANSPORT_FIELDS, form: 'gx_transport' },
    // Cancel, mirrored from gxDelTransportRequest(m,'gx_modal_contents',id) -> gxTransportForm('Abort this Transport?', '/cgi-bin/cgip?gxDelTransportRequest&miKey='+id)
    // (gxscript l.52022, 52138): step 1 loads the confirmation modal; step 2 = the modal's own form submitted via gxSendTransportForm(f,'gxDelTransportRequest',…).
    gxDelTransportRequest: { script: 'cgip', fields: ['miKey'] },
    // 0.2.6 rename (gxStoreShuttleName l.51941: cgip?jxShipRename&miShipID=<id>&miObjectName=<name>; the game sends the name UNencoded, we escape() it)
    jxShipRename:          { script: 'cgip', fields: ['miShipID', 'miObjectName'], family: 'rename' },
  });
  const ID_RE = /^\d{1,30}$/;
  /* 3.0.5: transport keys are alphanumeric in the live game (e.g. 26 chars), not numeric: the old ID_RE check blocked every cancel. */
  const TR_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
  /** Step 1 of cancel: exactly the URL the red X loads. */
  function cancelStep1Url(id) { if (!TR_KEY_RE.test(String(id))) throw new ForbiddenRequestError('bad transport id'); return '/cgi-bin/cgip?gxDelTransportRequest&miKey=' + id; }
  /** Step 2 of cancel: the confirmation form returned by step 1, serialized like deskform_getpostlist (DOM order, 'mi' fields, unchecked boxes skipped). */
  function cancelStep2Url(template, id) {
    if (!template || template.method !== 'gxDelTransportRequest') throw new ForbiddenRequestError('confirmation form does not submit gxDelTransportRequest');
    const key = template.fields.find(f => f.name === 'miKey');
    if (key && String(key.value) !== String(id)) throw new ForbiddenRequestError('confirmation form is for transport ' + key.value + ', not ' + id);
    let url = '/cgi-bin/cgip?gxDelTransportRequest';
    for (const f of template.fields) { if (f.name.indexOf('mi') < 0) continue; if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue; url += '&' + f.name + '=' + gameEscape(f.value == null ? '' : f.value); }
    return url;
  }

  /* ---------- 0.2.6 rename ---------- */
  const RENAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._'-]{0,28}[A-Za-z0-9._'-])?$/; // safe ASCII, 1-30 chars, no leading/trailing space
  function renameProblem(name) { name = String(name == null ? '' : name);
    if (!name) return 'Enter a name.'; if (name.length > 30) return 'At most 30 characters.'; if (/\s{2,}/.test(name)) return 'No double spaces.';
    if (!RENAME_RE.test(name)) return "Only letters A-Z, digits, space and . _ ' - are allowed (must start with a letter or digit, no trailing space)."; return ''; }
  function buildRenameUrl(shipId, name) {
    if (!ID_RE.test(String(shipId))) throw new ForbiddenRequestError('bad shuttle id');
    const p = renameProblem(name); if (p) throw new ForbiddenRequestError('rename refused: ' + p);
    return '/cgi-bin/cgip?jxShipRename&miShipID=' + shipId + '&miObjectName=' + gameEscape(name);
  }
  /** Core gate for an action family (always applies): master switch + family switch + ownership. */
  function actionGate(settings, family, owned) {
    const key = { rename: 'writeRename', flights: 'writeFlights', cargo: 'writeCargo', docking: 'writeDocking', trade: 'writeTrade' }[family];
    if (!settings.writesEnabled) return { ok: false, why: 'Writes are OFF (Settings).' };
    if (!key || !settings[key]) return { ok: false, why: `"${family}" actions are OFF (Settings).` };
    if (!owned) return { ok: false, why: 'Not one of your shuttles/stations (owner check).' };
    return { ok: true, why: family + ' enabled' };
  }

  /* ---------- 0.2.6 FORM CAPTURE (read-only discovery of owner action forms; nothing is ever submitted) ----------
   * LOADERS: functions that only OPEN a form via gxShipCompleteForm (gxscript l.51536-51589). Their URL is rebuilt exactly as the game does.
   * RECORD_ONLY: functions that ACT (accept/retract/dock-now/rename/form submits). Their calls are recorded, never requested. */
  const CAPTURE_LOADERS = Object.freeze({
    gxShip2Center: { idx: [1, 2, 3, 4, 5], url: a => `&miShipID=${a[1]}&miWorldNumber=${a[2]}&miEntityKind=${a[3]}&miEntityNumber=${a[4]}&miTargetId=${a[5]}`, title: 'Fly to Space Center', family: 'flights' },
    gxShip2Station: { idx: [1, 2], url: a => `&miShipID=${a[1]}&miStationID=${a[2]}`, title: 'Fly to Space Station', family: 'flights' },
    gxShipManageCargo: { idx: [1, 2], url: a => `&miObjectID=${a[1]}&miProduct=${a[2]}`, title: 'Manage Cargo', family: 'cargo' },
    gxShipDocking: { idx: [1], url: a => `&miObjectID=${a[1]}`, title: 'Dock / Undock', family: 'docking' },
  });
  const CAPTURE_RECORD_ONLY = Object.freeze(['gxShipDockNow', 'gxTradeAction', 'gxTradeAction2Front', 'gxTradeAccept', 'gxTradeCancel', 'gxTradeDocks', 'gxTradeDocksCancel',
    'gxSendShipForm', 'gxSendForm', 'gxSendTransportForm', 'gxShuttleRename', 'gxSaveShuttleName', 'gxTradeSpaceShips']);
  const LOADER_METHOD_RE = /^gx[A-Za-z0-9]{2,40}$/;
  const LOADER_DENY_RE = /(accept|retract|cancel|delete|deltransport|^gxdel|buy|sell|rename|docknow|addtransport)|^gxShipDock$/i;
  function buildLoaderUrl(fn, args) {
    const L = CAPTURE_LOADERS[fn]; if (!L) throw new ForbiddenRequestError(fn + ' is not a form loader');
    const m = String(args[0] || ''); if (!LOADER_METHOD_RE.test(m) || LOADER_DENY_RE.test(m)) throw new ForbiddenRequestError('loader method "' + m + '" refused');
    for (const i of L.idx) if (!SAFE_VAL.test(String(args[i] == null ? '' : args[i]))) throw new ForbiddenRequestError('bad loader argument');
    return '/cgi-bin/cgip?' + m + L.url(args);
  }

  /* ---------- 0.2.7 FLIGHTS: the submit of the live "Fly to ..." form, mirrored exactly like gxSendShipForm (gxscript l.51650) ----------
   * href = '/cgi-bin/cgip?' + <method from the form's own submit button> + deskform_getpostlist(form, 'mi')
   * The method name is not known in advance (it only appears in the live form), so it is checked by shape instead of a fixed list. */
  const FLIGHT_SUBMIT_RE = /^gx[A-Za-z0-9]{2,40}$/;
  const FLIGHT_SUBMIT_DENY_RE = /(accept|retract|cancel|delete|deltransport|^gxdel|buy|sell|rename|dock|cargo|load|trade|transport|offer)/i;
  function flightSubmitProblem(method) { if (!FLIGHT_SUBMIT_RE.test(String(method || ''))) return 'submit method "' + method + '" has an unexpected shape';
    if (FLIGHT_SUBMIT_DENY_RE.test(method)) return 'submit method "' + method + '" does not look like a flight'; return ''; }
  /** Form-shape check + URL. expect: { shipId, stationId?, worldNumber?, entityNumber? } must match the form's own hidden values when present. */
  function buildFlightUrl(method, form, expect) {
    const p = flightSubmitProblem(method); if (p) throw new ForbiddenRequestError(p);
    if (!form || !form.fields || !form.fields.length) throw new ForbiddenRequestError('live flight form has no fields');
    const val = n => { const f = form.fields.find(x => x.name === n); return f ? String(f.value) : null; };
    const sid = val('miShipID') != null ? val('miShipID') : val('miObjectID');
    if (sid !== String(expect.shipId)) throw new ForbiddenRequestError(`form is for shuttle ${sid}, not ${expect.shipId}`);
    for (const [k, n] of [['stationId', 'miStationID'], ['worldNumber', 'miWorldNumber'], ['entityNumber', 'miEntityNumber'], ['targetId', 'miTargetId']])
      if (expect[k] != null && val(n) != null && val(n) !== String(expect[k])) throw new ForbiddenRequestError(`form ${n}=${val(n)} does not match the chosen destination (${expect[k]})`);
    let url = '/cgi-bin/cgip?' + method;
    for (const f of form.fields) { if (f.name.indexOf('mi') < 0) continue; if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
      url += '&' + f.name + '=' + gameEscape(f.value == null ? '' : f.value); }
    return url;
  }

  /** 0.2.7.1: dry run (developer tools only): the write was built and checked but NOT sent. */
  class DryRunError extends Error { constructor(method, url) { super('dry run — not sent: ' + url); this.name = 'DryRunError'; this.method = method; this.url = url; } }
  class ForbiddenRequestError extends Error { constructor(m) { super('Galaxy Console blocked request: ' + m); this.name = 'ForbiddenRequestError'; } }
  class StaleResponseError extends Error { constructor() { super('stale'); this.name = 'StaleResponseError'; } }
  class HttpError extends Error { constructor(s) { super('HTTP ' + s); this.name = 'HttpError'; this.status = s; } }
  class SessionExpiredError extends Error { constructor() { super('not signed in / session expired'); this.name = 'SessionExpiredError'; } }

  const SAFE_VAL = /^-?[0-9A-Za-z_.]{0,40}$/; // entity kinds are letters ('c', 'e')
  function buildUrl(method, params) {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(READ_METHODS, method))
      throw new ForbiddenRequestError('method "' + method + '" is not on the read-only allowlist');
    const spec = READ_METHODS[method];
    let url = '/cgi-bin/' + spec.script + '?' + method;
    for (const [k, v] of Object.entries(params || {})) {
      if (spec.params.indexOf(k) < 0) throw new ForbiddenRequestError('parameter "' + k + '" not allowed for ' + method);
      const s = String(v);
      if (!SAFE_VAL.test(s)) throw new ForbiddenRequestError('bad value for ' + k);
      url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(s);
    }
    return url;
  }
  // escape() exactly like the original (deskform_getpostlist uses escape(), not encodeURIComponent)
  const gameEscape = s => (typeof W.escape === 'function' ? W.escape(String(s)) : encodeURIComponent(String(s)));
  /**
   * Builds the single write request EXACTLY like gxSendTransportForm -> deskform_getpostlist(f,'mi') (gxscript l.6778):
   * every element of the LIVE form (template fetched via gxNewTransportRequest) whose name contains 'mi', in DOM order,
   * unchecked checkboxes/radios skipped, value escape()d:  POST /cgi-bin/cgip?gxAddTransportRequest&name=value&...  (empty body)
   * Our values replace only the TRANSPORT_FIELDS; every other field (e.g. miActionConfirmed) keeps the template's own value/checked state.
   */
  function buildWriteUrl(method, values, template) {
    if (!Object.prototype.hasOwnProperty.call(WRITE_METHODS, method)) throw new ForbiddenRequestError('write method "' + method + '" is not allowlisted');
    for (const k of Object.keys(values)) if (TRANSPORT_FIELDS.indexOf(k) < 0) throw new ForbiddenRequestError('field "' + k + '" not allowed for ' + method);
    if (!template || !template.fields || !template.fields.length) throw new ForbiddenRequestError('live form template not loaded');
    let url = '/cgi-bin/' + WRITE_METHODS[method].script + '?' + method;
    for (const f of template.fields) {
      if (f.name.indexOf('mi') < 0) continue;
      if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) continue;
      const v = Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : f.value;
      url += '&' + f.name + '=' + gameEscape(v == null ? '' : v);
    }
    return url;
  }
  /** Gate: setting ON + live form template whose submit is gxAddTransportRequest and which contains every code-derived field.
   *  Extra live fields (e.g. miActionConfirmed) are not a problem: they are always sent as the form has them. */
  function writeGate(settings, template) {
    if (!settings.writesEnabled) return { ok: false, why: 'Writes are OFF (Settings).' };
    if (!template) return { ok: false, why: 'Live transport form not loaded yet (gxNewTransportRequest).' };
    if (template.method && template.method !== 'gxAddTransportRequest') return { ok: false, why: 'Live form submits "' + template.method + '", not gxAddTransportRequest.' };
    const names = template.fields.map(f => f.name), missing = TRANSPORT_FIELDS.filter(f => names.indexOf(f) < 0);
    if (missing.length) return { ok: false, why: 'Live form lacks fields: ' + missing.join(', ') };
    const extra = names.filter(n => n.indexOf('mi') >= 0 && TRANSPORT_FIELDS.indexOf(n) < 0);
    return { ok: true, why: `live form ${new Date(template.at).toLocaleTimeString()}: ${names.length} fields` + (extra.length ? `, extras sent as the form has them: ${extra.join(', ')}` : '') };
  }
  const isLoginPage = html => /Please login or join/i.test(html || '') && !/gxpu_/.test(html || '');
  /* ===================================================================
   * REQUEST CLIENT (reads): queue, concurrency, AbortController, timeout,
   * retry+backoff, per-channel stale protection, session detection.
   * Writes use client.write(): no queue reorder, no channel, NEVER retried.
   * =================================================================== */
  class RequestClient {
    constructor(o) {
      o = o || {};
      this.concurrency = o.concurrency || 2; this.timeoutMs = o.timeoutMs || 20000;
      this.retries = o.retries == null ? 3 : o.retries; this.backoffMs = o.backoffMs || 800;
      this.minGapMs = o.minGapMs == null ? 120 : o.minGapMs;
      this.fetchImpl = o.fetchImpl || ((u, i) => W.fetch(u, i));
      this.dbg = o.debug || createDebug(); this.onSession = o.onSession || (() => {});
      this.seq = 0; this.queue = []; this.active = new Map(); this.latest = new Map(); this.lastStart = 0;
      this.stats = { done: 0, failed: 0, stale: 0, retried: 0, writes: 0 }; this.log = []; this.listeners = new Set();
      this.paused = false;
    }
    onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
    _emit() { for (const f of this.listeners) { try { f(this); } catch (e) { /* */ } } }
    get pending() { return this.queue.length + this.active.size; }
    request(method, params, o) {
      o = o || {};
      const url = buildUrl(method, params);
      const id = ++this.seq;
      const job = { id, method, params: params || {}, url, channel: o.channel || null, priority: o.priority == null ? 5 : o.priority,
        timeoutMs: o.timeoutMs || this.timeoutMs, retries: o.retries == null ? this.retries : o.retries, attempt: 0, aborted: false, ctrl: null };
      if (job.channel) {
        for (const j of this.queue) if (j.channel === job.channel) { j.aborted = true; j.reject(new StaleResponseError()); }
        this.queue = this.queue.filter(j => !j.aborted);
        for (const j of this.active.values()) if (j.channel === job.channel) { j.aborted = true; if (j.ctrl) j.ctrl.abort(); }
        this.latest.set(job.channel, id);
      }
      job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; }); job.promise.catch(() => {});
      this.queue.push(job); this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
      this._pump(); this._emit();
      return { id, promise: job.promise, abort: () => this.abort(id) };
    }
    abort(id) {
      const q = this.queue.find(j => j.id === id);
      if (q) { q.aborted = true; this.queue = this.queue.filter(j => j !== q); q.reject(new StaleResponseError()); }
      const a = this.active.get(id); if (a) { a.aborted = true; if (a.ctrl) a.ctrl.abort(); }
      this._emit();
    }
    abortAll() { for (const j of [...this.queue, ...this.active.values()]) this.abort(j.id); }
    _pump() {
      while (this.active.size < this.concurrency && this.queue.length) {
        const wait = this.lastStart + this.minGapMs - Date.now();
        if (wait > 0) { clearTimeout(this._gapT); this._gapT = setTimeout(() => this._pump(), wait); return; }
        const job = this.queue.shift(); this.lastStart = Date.now(); this.active.set(job.id, job); this._run(job);
      }
    }
    async _once(url, timeoutMs, job) {
      const ctrl = new AbortController(); if (job) job.ctrl = ctrl;
      let timedOut = false; const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
      const t0 = Date.now();
      try {
        const r = await this.fetchImpl(url, { method: 'POST', body: '', credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal }); // like the original XHR: params in URL, empty body
        const body = await r.text();
        return { status: r.status, ok: r.ok, body, ms: Date.now() - t0 };
      } catch (e) {
        if (timedOut) throw Object.assign(new Error('timeout after ' + timeoutMs + ' ms'), { name: 'TimeoutError' });
        throw e;
      } finally { clearTimeout(t); }
    }
    async _run(job) {
      let result, error;
      for (;;) {
        const t0 = Date.now();
        try {
          const r = await this._once(job.url, job.timeoutMs, job);
          this.dbg.net(r.ok ? 'debug' : 'warn', `${job.method} #${job.id} ${r.status} ${r.ms}ms ${r.body.length}B`, { params: job.params, attempt: job.attempt + 1 });
          if (!r.ok) throw new HttpError(r.status);
          if (READ_METHODS[job.method].login && isLoginPage(r.body)) { this.onSession('expired', job.method); throw new SessionExpiredError(); }
          if (READ_METHODS[job.method].login) this.onSession('ok', job.method);
          result = r.body; error = null;
        } catch (e) {
          error = e;
          if (!job.aborted) this.dbg.net(e.name === 'HttpError' ? 'warn' : 'warn', `${job.method} #${job.id} failed: ${e.message} (${Date.now() - t0}ms)`, { params: job.params, attempt: job.attempt + 1 });
        }
        if (!error || job.aborted) break;
        const retryable = error.name === 'TimeoutError' || error.name === 'TypeError' || (error.status && (error.status >= 500 || error.status === 429));
        if (!retryable || job.attempt >= job.retries) break;
        job.attempt++; this.stats.retried++;
        await new Promise(r => setTimeout(r, this.backoffMs * Math.pow(2, job.attempt - 1) * (0.75 + Math.random() * 0.5)));
        if (job.aborted) break;
      }
      this.active.delete(job.id);
      this.log.push({ id: job.id, method: job.method, ok: !error, attempts: job.attempt + 1, at: Date.now() });
      if (this.log.length > LIMITS.NET_LOG_RING) this.log.splice(0, this.log.length - LIMITS.NET_LOG_RING);
      if (job.aborted || (job.channel && this.latest.get(job.channel) !== job.id)) { this.stats.stale++; job.reject(new StaleResponseError()); }
      else if (error) { this.stats.failed++; job.reject(error); } else { this.stats.done++; job.resolve(result); }
      this._pump(); this._emit();
    }
    /** 0.2.6 form capture: GET-equivalent of the game's own form loader (opens a form; never a submit). Not retried. */
    async loadForm(fn, args) {
      const url = buildLoaderUrl(fn, args); this.stats.formLoads = (this.stats.formLoads || 0) + 1;
      const r = await this._once(url, 30000, null);
      this.dbg.net(r.ok ? 'info' : 'warn', `FORMLOAD ${fn} ${r.status} ${r.ms}ms ${r.body.length}B (not submitted)`, { url });
      if (!r.ok) throw new HttpError(r.status); if (isLoginPage(r.body)) { this.onSession('expired', fn); throw new SessionExpiredError(); }
      return { url, body: r.body };
    }
    /** Write path (POST, empty body). Only allowlisted write methods; the caller passes an open gate. Never retried. */
    async write(method, values, template, gate) { return this.writeUrl(method, buildWriteUrl(method, values, template), gate); }
    async writeUrl(method, url, gate, note) {
      if (!gate || !gate.ok) throw new ForbiddenRequestError('write gate closed: ' + (gate ? gate.why : 'no gate'));
      const dyn = gate.flightMethod && gate.flightMethod === method && !flightSubmitProblem(method) && url.indexOf('/cgi-bin/cgip?' + method + '&') === 0; // 0.2.7 live flight form submit
      if (!dyn && (!Object.prototype.hasOwnProperty.call(WRITE_METHODS, method) || url.indexOf('/cgi-bin/' + WRITE_METHODS[method].script + '?' + method + '&') !== 0)) throw new ForbiddenRequestError('write URL does not match allowlisted method ' + method);
      if (typeof this.dryRun === 'function' && this.dryRun()) { this.stats.dryRuns = (this.stats.dryRuns || 0) + 1; this.dbg.net('info', `DRY RUN ${method}${note ? ' (' + note + ')' : ''}: not sent`, { url }); if (typeof this.onWrite === 'function') try { this.onWrite({ method, note, url, dryRun: true }); } catch (x) { /* */ } throw new DryRunError(method, url); }
      this.stats.writes++;
      const sent = url.split('&').slice(1).map(p => p.split('=')[0]);
      try {
        const r = await this._once(url, 30000, null);
        const summary = writeResponseSummary(r.body);
        // full response kept in the debug entry (export it from the Debug tab for analysis)
        if (typeof this.onWrite === 'function') try { this.onWrite({ method, note, url, status: r.status, ms: r.ms, response: r.body }); } catch (x) { /* capture must never break a write */ }
        this.dbg.net(r.ok ? 'info' : 'error', `WRITE ${method}${note ? ' (' + note + ')' : ''} ${r.status} ${r.ms}ms ${r.body.length}B: ${summary}`, { fieldsSent: sent, url, response: r.body });
        if (!r.ok) throw new HttpError(r.status);
        if (isLoginPage(r.body)) { this.onSession('expired', method); throw new SessionExpiredError(); }
        return r.body;
      } catch (e) {
        if (e.name !== 'HttpError' && e.name !== 'SessionExpiredError') { this.dbg.net('error', `WRITE ${method} failed: ${e.message}`, { fieldsSent: sent, url }); if (typeof this.onWrite === 'function') try { this.onWrite({ method, note, url, error: e.message }); } catch (x) { /* */ } }
        throw e;
      } finally { this._emit(); }
    }
  }
  /* ===================================================================
   * PARSERS: server HTML -> plain objects
   * =================================================================== */
  const txt = el => (el ? el.textContent : '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const num = s => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  const parseDoc = html => new DOMParser().parseFromString('<!doctype html><html><body>' + html + '</body></html>', 'text/html');
  const tdsOf = tr => [...tr.children].filter(e => e.tagName === 'TD');
  const headingFromIcon = src => { const m = /galaxyship0.([A-Z]+)\.gif/.exec(src || ''); return m ? m[1] : null; };
  /** Split a JS call's argument list: 'a', 12, "b c" -> ['a', 12, 'b c'] */
  function parseArgs(s) {
    const out = []; const re = /\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,]*?))\s*(?:,|$)/g; let m;
    while ((m = re.exec(s)) && m[0] !== '') {
      if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, '$1')); else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, '$1'));
      else { const v = m[3].trim(); out.push(/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v); }
      if (re.lastIndex >= s.length) break;
    }
    return out;
  }
  function callArgs(code, fn) { const m = new RegExp(fn + '\\s*\\(([^)]*)\\)').exec(code || ''); return m ? parseArgs(m[1]) : null; }

  function parseShipsLayer(raw) {
    const s = (raw || '').trim();
    if (s === '') return { status: 'empty' };
    if (/^\d{3}$/.test(s)) return { status: s === '204' ? 'unchanged' : 'error', code: Number(s) };
    if (isLoginPage(s)) return { status: 'error', code: 'login-page' };
    const m = /<!JXtimestamp:([^:]*):JXtimestamp>/.exec(s.slice(0, 200));
    const out = { status: 'ok', ts: m ? m[1] : null, ships: [], stations: [], globes: [] };
    const re = /<DIV\b([^>]*)\bID="(gs[ivs])_([^"]+)"([^>]*)>\s*<IMG\b([^>]*)>/gi; let r;
    while ((r = re.exec(s))) {
      const attrs = r[1] + r[4], img = r[5], st = (/STYLE="([^"]*)"/i.exec(attrs) || [])[1] || '';
      const g = k => num((new RegExp('(?:^|;)\\s*' + k + '\\s*:\\s*(-?\\d+)', 'i').exec(st) || [])[1]);
      const left = g('left'), top = g('top'), w = g('width') || 0, h = g('height') || 0;
      const o = { id: r[3], name: (/title="([^"]*)"/i.exec(img) || [])[1] || '', icon: (/src="([^"]*)"/i.exec(img) || [])[1] || '', left, top, w, h, x: left + w / 2, y: top + h / 2 };
      const k = r[2].toLowerCase();
      if (k === 'gsv') { o.heading = headingFromIcon(o.icon); out.ships.push(o); } else if (k === 'gss') out.stations.push(o); else out.globes.push(o);
    }
    if (!out.ships.length && !out.stations.length && !out.globes.length) out.status = 'unrecognised';
    return out;
  }
  function parseShipList(html) {
    const rows = [];
    for (const tr of parseDoc(html).querySelectorAll('tr')) {
      const a = tr.querySelector('a[onclick*="gxGetShipInfo"]'); if (!a) continue;
      const tds = tdsOf(tr); if (tds.length < 12) continue;
      const id = (/gxGetShipInfo\('(\d+)'/.exec(a.getAttribute('onclick')) || [])[1]; if (!id) continue;
      const z = callArgs(tr.innerHTML, 'gxGSVzoomGalaxyPosition') || [];
      const icon = (tds[0].querySelector('img') || {}).src || '';
      rows.push({ id, name: txt(tds[1]), owner: txt(tds[3]), ownerKey: profileKey(tds[3]), location: txt(tds[5]), destination: txt(tds[7]) === '-' ? '' : txt(tds[7]),
        cargo: num(txt(tds[9])), missions: num(txt(tds[11])), x: z[2] == null ? null : z[2], y: z[3] == null ? null : z[3], heading: headingFromIcon(icon) });
    }
    return rows;
  }
  const PROP_KEYS = ['Function', 'Name', 'Position', 'Destination', 'Owner', 'Life Expectancy', 'Capacity', 'Used', 'Use%'];
  function parseShipInfo(html) {
    const doc = parseDoc(html), p = {};
    for (const tr of doc.querySelectorAll('tr')) { const tds = tdsOf(tr); if (tds.length < 5) continue; const k = txt(tds[2]); if (PROP_KEYS.indexOf(k) >= 0 && !(k in p)) { p[k] = txt(tds[4]); if (k === 'Owner') p._ownerKey = profileKey(tds[4]); if (k === 'Position' || k === 'Destination') { const c = callArgs(tds[4].innerHTML, 'gxCountryMapByHostName'); if (c) p['_c' + k] = [String(c[0]), String(c[1])]; } } }
    if (!p.Name && !p.Function) return null;
    const d = { name: p.Name || '', owner: p.Owner || '', ownerKey: p._ownerKey || '', location: p.Position || '', destination: p.Destination && p.Destination !== '-' ? p.Destination : '',
      missions: num(p['Life Expectancy']), capacity: num(p.Capacity), cargo: num(p.Used), usePct: num(p['Use%']), type: p.Function || '', locCountry: p._cPosition || null, destCountry: p._cDestination || null, flight: null, flightNote: '', noFlight: false, logs: [] };
    const th = [...doc.querySelectorAll('th')].find(t => txt(t) === 'Since Departure');
    if (th) {
      const row = th.parentElement.nextElementSibling, tds = row ? tdsOf(row) : [];
      if (tds.length >= 10 && /tu$/.test(txt(tds[5]))) {
        d.flight = { target: txt(tds[1]), distanceMiles: num(txt(tds[3])), sinceTu: num(txt(tds[5])), arrivalTu: num(txt(tds[7])), docks: txt(tds[9]) };
        const note = row.nextElementSibling; if (note && note.querySelector('i')) d.flightNote = txt(note);
      }
    }
    d.noFlight = /There is currently no flight scheduled/.test(doc.body.textContent);
    d.retiring = /about to retire/i.test(doc.body.textContent); // 'about to retire. Please offload its cargo'
    for (const tr of doc.querySelectorAll('tr[onclick*="loglist"]')) {
      const tds = tdsOf(tr); if (tds.length >= 5) d.logs.push({ when: txt(tds[2]), text: txt(tds[4]) });
      if (d.logs.length >= LIMITS.SHIP_LOGBOOK_LINES) break;
    }
    return d;
  }
  /** "Interceptor Missiles : Loaded 2,000 missiles from X" -> {product, qty} */
  function parseLoadLine(text) {
    const m = /^(.+?)\s*:\s*Loaded\s+([\d,]+)\s+(\S+)/.exec(text || ''); return m ? { product: m[1].trim(), qty: num(m[2]), unit: m[3] } : null;
  }
  /** Classify one shuttle logbook line (live 2026-10-10 wording):
   *  "Scheduled a flight to X" | "Arrived at X" | "P: Loaded N unit from X" | "P: Offloaded N unit at X" -> {kind, product, qty, unit, place} */
  function classifyLogLine(text) {
    text = text || ''; let m;
    if ((m = /^(.+?)\s*:\s*(Loaded|Offloaded|Unloaded)\s+([\d,]+)\s+(\S+)\s+(?:from|at|to|on)\s+(.+)$/i.exec(text))) return { kind: /^loaded$/i.test(m[2]) ? 'cargo_load' : 'cargo_unload', product: m[1].trim(), qty: num(m[3]), unit: m[4], place: m[5].trim() };
    if ((m = /^Scheduled a flight to\s+(.+)$/i.exec(text))) return { kind: 'trip_start', place: m[1].trim() };
    if ((m = /^Arrived at\s+(.+)$/i.exec(text))) return { kind: 'arrived', place: m[1].trim() };
    return { kind: 'log' };
  }
  /** 0.2.5: game server clock zone. Logbook stamps are CET/CEST wall time (Europe/Amsterdam rules). Offset in ms for a wall-clock-as-UTC value. */
  const SERVER_TZ = 'Europe/Amsterdam';
  function serverTzOffsetMs(wallAsUtc) {
    try { const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: SERVER_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(wallAsUtc - 3600000))) p[x.type] = +x.value;
      const off = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - (wallAsUtc - 3600000); return Math.round(off / 900000) * 900000; }
    catch (e) { // EU rule fallback: CEST between last Sunday of March 01:00 UTC and last Sunday of October 01:00 UTC
      const y = new Date(wallAsUtc).getUTCFullYear(), last = mo => { const d = new Date(Date.UTC(y, mo + 1, 0)); return Date.UTC(y, mo, d.getUTCDate() - d.getUTCDay(), 1); };
      const u = wallAsUtc - 3600000; return u >= last(2) && u < last(9) ? 7200000 : 3600000; }
  }
  /** Server logbook stamp "Oct 11 00:30" (no year) -> ms, year taken from the observation time (Dec/Jan wrap handled). */
  function serverStamp(when, obsT) {
    const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(when || ''); if (!m) return null;
    const mo = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3; if (mo < 0) return null;
    const y = new Date(obsT || Date.now()).getUTCFullYear(); let t = Date.UTC(y, mo, +m[2], +m[3], +m[4]);
    if (t - (obsT || Date.now()) > 180 * 86400000) t = Date.UTC(y - 1, mo, +m[2], +m[3], +m[4]);
    return t - serverTzOffsetMs(t); // 0.2.5: wall clock -> true UTC instant (was stored as if the server clock were UTC)
  }
  /** Player profile key from an owner cell link (…SN_METHOD=ppview&miKey=<key>) */
  function profileKey(el) { const a = el && el.querySelector && el.querySelector('a[href*="miKey="]'); const m = a && /miKey=(\d+)/.exec(a.getAttribute('href')); return m ? m[1] : ''; }
  /** Owner name normalisation for 'mine' matching: entities already decoded by the DOM; NFKC, nbsp/zero-width, whitespace, case. */
  const normName = v => String(v == null ? '' : v).normalize('NFKC').replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  function parseStations(html) {
    const out = [];
    for (const tr of parseDoc(html).querySelectorAll('tr')) {
      const code = tr.innerHTML; if (!/gxGetMarketInfo\(/.test(code)) continue; const tds = tdsOf(tr); if (tds.length < 11) continue;
      const z = callArgs(code, 'gxGSSzoomGalaxyPosition') || [];
      out.push({ id: String((callArgs(code, 'gxGetMarketInfo') || [])[0]), name: txt(tds[1]), owner: txt(tds[3]), position: txt(tds[6]),
        x: z[2], y: z[3], storage: num(txt(tds[8])), usePct: num(txt(tds[10])) });
    }
    return out;
  }
  function parseMarkets(html) {
    const out = [];
    for (const tr of parseDoc(html).querySelectorAll('tr')) {
      const code = tr.innerHTML; if (!/gxProductInfo\(/.test(code) || !/gxGetMarketInfo\(/.test(code)) continue; const tds = tdsOf(tr); if (tds.length < 12) continue;
      out.push({ product: txt(tds[2]), productId: (callArgs(code, 'gxProductInfo') || [])[0], station: txt(tds[5]), stationId: String((callArgs(code, 'gxGetMarketInfo') || [])[0]),
        offered: num(txt(tds[7])), requested: num(txt(tds[10])), unit: txt(tds[8]) || txt(tds[11]) });
    }
    return out;
  }
  /** "Markets on <station>" table inside gxInfo (station page): rows tr[onclick*=marketlist] with gxProductInfo(id). */
  function parseStationMarket(html, stationId, stationName) {
    const out = [];
    for (const tr of parseDoc(html).querySelectorAll('tr[onclick*="marketlist"]')) {
      const code = tr.innerHTML, tds = tdsOf(tr); if (!/gxProductInfo\(/.test(code) || tds.length < 9) continue;
      out.push({ product: txt(tds[2]), productId: (callArgs(code, 'gxProductInfo') || [])[0], station: stationName || '', stationId: String(stationId), offered: num(txt(tds[4])), requested: num(txt(tds[7])), unit: txt(tds[5]) || txt(tds[8]) });
    }
    return out;
  }
  /** Docking stations table inside gxInfo (station page): Name / Owned By / Used By / Use% */
  /** 0.2.6: owner cell may also hold a 'Buy for N GC' link after a <br>; keep only the name. */
  const ownerTxt = td => { const c = td.cloneNode(true); for (const a of c.querySelectorAll('a')) a.remove(); return txt(c); };
  function parseStationDocks(html, stationId, stationName) {
    const out = [];
    for (const tr of parseDoc(html).querySelectorAll('tr')) {
      const a = callArgs(tr.innerHTML, 'gxTradeDocking'); if (!a) continue; const tds = tdsOf(tr); if (tds.length < 9) continue;
      out.push({ stationId: String(stationId), station: stationName || '', dockNo: a[1], dock: txt(tds[2]), owner: ownerTxt(tds[4]), usedBy: txt(tds[6]), usePct: num(txt(tds[8])) });
    }
    return out;
  }
  /** Generic: header labels + non-empty cells in order (used where the live structure is not yet seen: my docks, transport list). */
  function parseGenericTable(html, mustHaveHeader) {
    const doc = parseDoc(html); const rows = [];
    const hdr = [...doc.querySelectorAll('tr')].find(tr => [...tr.children].some(c => c.tagName === 'TH') && txt(tr).indexOf(mustHaveHeader) >= 0);
    if (!hdr) return { labels: [], rows };
    const labels = [...hdr.querySelectorAll('th')].map(txt).filter(Boolean);
    for (let tr = hdr.nextElementSibling; tr; tr = tr.nextElementSibling) {
      const tds = tdsOf(tr); if (tds.length < 2 || tds.some(t => +t.getAttribute('colspan') > 3)) continue;
      const cells = tds.map(txt).filter(v => v !== ''); if (!cells.length) continue;
      const o = { _cells: cells, _html: tr.innerHTML }; labels.forEach((l, i) => { o[l] = cells[i] == null ? '' : cells[i]; }); rows.push(o);
    }
    return { labels, rows };
  }
  function parseMyDocks(html) {
    return parseGenericTable(html, 'Space Station').rows.map(r => ({ station: r['Space Station'], dock: r.Dock, owner: r['Owned By'], usedBy: r['Used By'], storage: num(r.Storage), usePct: num(r['Use%']) }));
  }
  /** Transport status from the row markup (live 2026-10-10):
   *  'Scheduled' + alert16.gif 'Transport still not started! Do you own enough space ships?' -> waiting
   *  'Scheduled' + star 'Transport Scheduled' -> new;  '<n>%' + 'In Transport' -> transit;  'Finished' / 'Transport Finished';  'Aborted' / 'Transport Aborted' */
  const TR_STATUS = Object.freeze({
    waiting:  { label: 'Waiting for shuttles', color: '#b00000', icon: '⚠', active: true },
    new:      { label: 'New',                  color: '#8a6d00', icon: '★', active: true },
    transit:  { label: 'In transport',         color: '#0a6b16', icon: '➜', active: true },
    finished: { label: 'Finished',             color: '#333',    icon: '✔', active: false },
    aborted:  { label: 'Aborted',              color: '#7a0000', icon: '✖', active: false },
    unknown:  { label: 'Unknown',              color: '#555',    icon: '?', active: true },
  });
  function classifyTransportRow(h) {
    const pct = (/title="(\d{1,3})\s*%"/i.exec(h) || [])[1];
    if (/Transport Aborted/i.test(h) || /title="Aborted"/i.test(h)) return { kind: 'aborted' };
    if (/Transport Finished/i.test(h) || /title="Finished"/i.test(h)) return { kind: 'finished', pct: 100 };
    if (/In Transport/i.test(h) || pct != null) return { kind: 'transit', pct: pct == null ? null : +pct };
    if (/still not started/i.test(h) || /alert16\.gif/i.test(h)) return { kind: 'waiting' };
    if (/Transport Scheduled/i.test(h) || /title="Scheduled"/i.test(h)) return { kind: 'new' };
    return { kind: 'unknown' };
  }
  /** Live transport list. Columns: Product Name, Quantity, Origin (From), Target (To), Loaded / Delivered, Status.
   *  The first icon's tooltip is wrong in the game (always 'Missile Interceptors'); the product name comes from the text cell. */
  function parseTransportList(html) {
    if (isLoginPage(html)) return { expired: true, rows: [] };
    const t = parseGenericTable(html, 'Product Name');
    return { expired: false, rows: t.rows.map(r => {
      const h = r._html, st = classifyTransportRow(h), ld = /([\d,]+)\s*\/\s*([\d,]+)/.exec(r['Loaded / Delivered'] || '') || [];
      const id = (callArgs(h, 'gxGetTransportInfo') || [])[0];
      return { id: id == null ? null : String(id), key: id == null ? null : String(id), product: r['Product Name'] || '', productId: (callArgs(h, 'gxProductInfo') || [])[0],
        quantity: num(r.Quantity), origin: r['Origin (From)'] || '', target: r['Target (To)'] || '', loaded: num(ld[1]), delivered: num(ld[2]), loadedText: r['Loaded / Delivered'] || '',
        status: st.kind, pct: st.pct == null ? null : st.pct, statusLabel: TR_STATUS[st.kind].label + (st.kind === 'transit' && st.pct != null ? ' ' + st.pct + '%' : ''),
        cancelable: /gxDelTransportRequest/.test(h),
        /* 3.0.5: the red X's own key (3rd argument of gxDelTransportRequest) is what the game sends as miKey */
        cancelKey: (() => { const a = callArgs(h, 'gxDelTransportRequest'); return a && a[2] != null && String(a[2]) !== '' ? String(a[2]) : (id == null ? null : String(id)); })(),
        productIcon: (() => { const m = /<img[^>]+src=["']([^"']+\.(?:gif|png|jpe?g|webp))["']/i.exec(h); if (!m) return ''; const u = m[1].replace(/&amp;/g, '&'); return /^(https:\/\/[a-z0-9.-]*simcountry\.com\/|\/)/i.test(u) ? (u[0] === '/' ? 'https://www.simcountry.com' + u : u) : ''; })() };
    }) };
  }
  /** gxTransportInfo popup: label/value pairs + logbook rows. */
  const TR_INFO_KEYS = ['Product', 'Quantity', 'Owner', 'Origin', 'Target', 'Loaded', 'Offloaded', 'Progress'];
  function parseTransportInfo(html) {
    if (isLoginPage(html)) return { expired: true };
    const doc = parseDoc(html), info = {}, logs = []; let inLog = false;
    for (const tr of doc.querySelectorAll('tr')) {
      if ([...tr.children].some(c => c.tagName === 'TR')) continue;
      const cells = tdsOf(tr).map(txt).filter(Boolean), all = txt(tr);
      if (!cells.length) { if (/Logbook/i.test(all)) inLog = true; continue; }
      if (/^Logbook$/i.test(cells[0]) && cells.length === 1) { inLog = true; continue; }
      if (!inLog && TR_INFO_KEYS.indexOf(cells[0].replace(/:$/, '')) >= 0 && cells.length >= 2 && !(cells[0].replace(/:$/, '') in info)) { info[cells[0].replace(/:$/, '')] = cells.slice(1).join(' '); continue; }
      if (inLog && cells.length >= 2) logs.push({ when: cells[0], text: cells.slice(1).join(' ') });
    }
    for (const tr of doc.querySelectorAll('tr')) { const tds = tdsOf(tr); if (tds.length >= 2 && /^Owner:?$/.test(txt(tds[0]))) { info._ownerKey = profileKey(tr); break; } }
    return { expired: false, info, logs: logs.slice(0, 200) };
  }
  const routeKey = (product, origin, target) => [product, origin, target].map((s, i) => { s = String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); return i ? s.replace(/\s+on\s+\S+$/, '') : s; }).join(' | '); // 'CenterA on GR' == 'CenterA'
  /** Picker lists: whatever markup, the clickable rows carry the original select calls with all ids. */
  function parsePicker(html, fn) {
    const out = []; const doc = parseDoc(html);
    for (const el of doc.querySelectorAll('[onclick], a[href^="javascript:"]')) {
      const code = (el.getAttribute('onclick') || '') + ' ' + (el.getAttribute('href') || '');
      const a = callArgs(code, fn); if (!a) continue;
      const tr = el.closest('tr'); const cells = tr ? tdsOf(tr).map(txt).filter(Boolean) : [txt(el)];
      if (fn === 'gxSelTransportProduct') out.push({ img: a[0], product: String(a[1]), name: a[2], stock: num(a[3]), cells });
      else out.push({ kind: a[0], name: a[1], stationId: String(a[2] == null ? '0' : a[2]), world: String(a[3] == null ? '0' : a[3]), entityKind: String(a[4] == null ? '0' : a[4]),
        entityId: String(a[5] == null ? '0' : a[5]), target: String(a[6] == null ? '0' : a[6]), cells });
    }
    const seen = new Set(); return out.filter(o => { const k = JSON.stringify([o.name, o.product, o.stationId, o.entityId]); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  /** The game's message text in a write response (error/message boxes, red font). */
  function parseGameMessage(html) {
    const doc = parseDoc(html); const parts = [];
    for (const el of doc.querySelectorAll('div.error, td.error, div.message, td.message, p.gxpu_message, font[color="red"], #gtr_error_txt')) { const t = txt(el); if (t && parts.indexOf(t) < 0) parts.push(t); }
    if (!parts.length) { const m = /Sorry\.[^<>]{0,300}/.exec(doc.body.textContent.replace(/\s+/g, ' ')); if (m) parts.push(m[0].trim()); }
    return parts.join(' / ');
  }
  /** Live form template (gxNewTransportRequest answer, or a confirmation page carrying the form again). DOM order like form.elements. */
  function parseFormTemplate(html, formName) {
    const doc = parseDoc(html), f = doc.querySelector('form[name="' + (formName || 'gx_transport') + '"]'); if (!f) return null;
    const fields = [];
    for (const el of f.querySelectorAll('input, select, textarea, button')) {
      const name = el.getAttribute('name'); if (!name) continue;
      const type = (el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase()).toLowerCase();
      let value = el.tagName === 'SELECT' ? ((el.querySelector('option[selected]') || el.querySelector('option') || {}).value || '') : el.tagName === 'TEXTAREA' ? el.textContent : (el.getAttribute('value') || (type === 'checkbox' || type === 'radio' ? 'on' : ''));
      const lab = el.closest('label') || el.closest('td');
      fields.push({ name, type, value, checked: el.hasAttribute('checked'), label: lab ? txt(lab).slice(0, 200) : '' });
    }
    const sub = [...doc.querySelectorAll('[onclick*="gxSendTransportForm"], a[href*="gxSendTransportForm"]')].map(e => callArgs((e.getAttribute('onclick') || '') + (e.getAttribute('href') || ''), 'gxSendTransportForm')).find(a => a && a[0] === (formName || 'gx_transport'));
    return { at: Date.now(), method: sub ? sub[1] : null, fields, text: txt(f).slice(0, 500) };
  }
  /** Find the form whose submit calls gxSendTransportForm(<form>, method, …) and parse it. */
  function findSubmitForm(html, method) {
    const re = /gxSendTransportForm\s*\(([^)]*)\)/g; let m;
    while ((m = re.exec(html || ''))) { const a = parseArgs(m[1]); if (a[1] === method) { const t = parseFormTemplate(html, a[0]); if (t) return Object.assign(t, { method }); } }
    return null;
  }
  /** Short text for the log: first error / confirmation text, or what kind of page came back. */
  function writeResponseSummary(html) {
    const m = parseGameMessage(html); if (m) return m.slice(0, 200);
    if (/miActionConfirmed/.test(html)) { const t = parseFormTemplate(html); return 'form returned with miActionConfirmed' + (t ? ': ' + t.text.slice(0, 160) : ''); }
    if (/Product Name/.test(html) && /Origin \(From\)/.test(html)) return 'transport list returned';
    return 'no message; text starts: ' + txt(parseDoc(html).body).slice(0, 160);
  }
  /** Observed: 'Sorry. Missile Interceptors is already in transport from CenterA to CenterB' */
  const DUP_RE = /is already in transport from/i;
  /** A response that carries the transport form again with miActionConfirmed = the server wants a confirmation. */
  function isConfirmationPage(html) { const t = /miActionConfirmed/.test(html || '') ? parseFormTemplate(html) : null; return !!(t && t.fields.some(f => f.name === 'miActionConfirmed')); }
  function classifyWriteMessage(msg) { if (!msg) return 'none'; if (DUP_RE.test(msg)) return 'duplicate'; if (/^Sorry\./i.test(msg)) return 'rejected'; return 'message'; }

  /* ===================================================================
   * SMALL UTILITIES: LRU, CSV
   * =================================================================== */
  class LRU {
    constructor(max, maxBytes) { this.max = max; this.m = new Map(); this.maxBytes = maxBytes || 0; this.bytes = 0; this.b = new Map(); } // 3.1.5: optional byte budget
    get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
    _del(k) { this.bytes -= this.b.get(k) || 0; this.b.delete(k); this.m.delete(k); }
    set(k, v) { if (this.m.has(k)) this._del(k); this.m.set(k, v); if (this.maxBytes) { const n = estBytes(v, 50000); this.b.set(k, n); this.bytes += n; }
      while (this.m.size > this.max || (this.maxBytes && this.bytes > this.maxBytes && this.m.size > 1)) this._del(this.m.keys().next().value); return v; }
    get size() { return this.m.size; } clear() { this.m.clear(); this.b.clear(); this.bytes = 0; }
  }
  const CSV_COLUMNS = Object.freeze(['record_type', 'ship_id', 'name', 'owner', 'location', 'destination', 'cargo', 'missions', 'since_tu', 'arrival_tu', 'status',
    'x', 'y', 'on_map', 'first_seen', 'last_seen', 'last_seen_session', 'detail_at', 'event_time', 'field', 'old_value', 'new_value', 'source']);
  const SHIP_CSV_COLUMNS = Object.freeze(['record_type', 'ship_id', 'name', 'owner', 'owner_key', 'location', 'destination', 'cargo', 'capacity', 'use_pct', 'missions', 'since_tu', 'arrival_tu', 'status', 'retiring',
    'flight_target', 'flight_distance', 'flight_docks', 'flight_note', 'x', 'y', 'on_map', 'first_seen', 'last_seen', 'last_seen_session', 'detail_at', 'first_detail_at', 'logbook_lines', 'logbook_json', 'cargo_at', 'cargo_json']);
  const EVENT_CSV_COLUMNS = Object.freeze(['record_type', 'ship_id', 'name', 'owner', 'event_time', 'field', 'old_value', 'new_value', 'source', 'server_time', 'server_ts', 'seq',
    'product', 'quantity', 'unit', 'place', 'loaded', 'offloaded', 'note', 'log_key', 'server_tz']);
  const csvCell = v => { if (v == null) return ''; const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function csvParse(text) {
    text = text.replace(/^\uFEFF/, ''); const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== '');
  }
  const iso = t => (t ? new Date(t).toISOString() : '');
  const unIso = s => (s ? Date.parse(s) || null : null);
  /* ===================================================================
   * 0.2.5 PARSERS (read-only tab fragments). Header-driven: columns are located by their <th> label, so a re-ordered
   * or extra column does not shift values. Verified against the tables embedded in saved gxShipInfo / gxInfo pages;
   * the standalone fragment responses of gxShipCargo/gxShipLogs/gxUserInventory/gxUserLogs/gxDockingStations were NOT saved.
   * =================================================================== */
  /** Find the header row containing `label`; return {hdr, idx(label)} where idx maps a label to the column index in data rows. */
  function headerMap(root, label) {
    const hdr = [...root.querySelectorAll('tr')].find(tr => [...tr.children].some(c => c.tagName === 'TH' && txt(c) === label));
    if (!hdr) return null; const cells = [...hdr.children], at = {};
    let col = 0; for (const c of cells) { const t = txt(c); if (t && !(t in at)) at[t] = col; col += +c.getAttribute('colspan') || 1; }
    return { hdr, idx: l => (l in at ? at[l] : -1) };
  }
  const scopeOf = (doc, id) => (id && doc.getElementById(id)) || doc;
  const emptyNote = root => { const p = [...root.querySelectorAll('td[colspan] p, td[colspan]')].map(txt).find(t => /empty|nothing|did not|no /i.test(t)); return p || ''; };
  /** Cargo-like table (shuttle cargo, station Products Stored): Product Name / Quantity / Avg Quality [/ Dock]. */
  function parseInventoryTable(html, scopeId) {
    const doc = parseDoc(html), root = scopeOf(doc, scopeId), h = headerMap(root, 'Product Name'), out = { rows: [], empty: '', ok: !!h };
    if (!h) return out;
    const iP = h.idx('Product Name'), iQ = h.idx('Quantity'), iA = h.idx('Avg Quality'), iD = h.idx('Dock');
    for (const tr of root.querySelectorAll('tr[onclick*="inventorylist"]')) {
      const tds = tdsOf(tr); if (tds.length < 4 || tds.some(t => +t.getAttribute('colspan') > 3)) continue;
      const qRaw = iQ >= 0 && tds[iQ] ? txt(tds[iQ]) : '', qm = /^([\d,.]+)\s*(.*)$/.exec(qRaw) || [];
      const r = { product: iP >= 0 && tds[iP] ? txt(tds[iP]) : '', productId: String((callArgs(tr.innerHTML, 'gxProductInfo') || [])[0] || ''), qty: num(qm[1] || qRaw), unit: (qm[2] || '').trim(),
        quality: iA >= 0 && tds[iA] ? num(txt(tds[iA])) : null, dock: iD >= 0 && tds[iD] ? txt(tds[iD]) : '' };
      if (r.product) out.rows.push(r);
    }
    if (!out.rows.length) out.empty = emptyNote(root);
    return out;
  }
  /** Logbook-like table (shuttle logbook, station Activities): Kind (icon) / Date / Description. */
  function parseLogTable(html, scopeId) {
    const doc = parseDoc(html), root = scopeOf(doc, scopeId), h = headerMap(root, 'Description'), out = { rows: [], empty: '', ok: !!h };
    if (!h) return out;
    const iK = Math.max(0, h.idx('Kind')), iW = h.idx('Date'), iT = h.idx('Description');
    for (const tr of root.querySelectorAll('tr[onclick*="loglist"]')) {
      const tds = tdsOf(tr); if (tds.length < 5 || tds.some(t => +t.getAttribute('colspan') > 3)) continue;
      const img = tds[iK] && tds[iK].querySelector('img'), kind = img ? ((img.getAttribute('title') || '') || (img.getAttribute('src') || '').replace(/^.*\//, '').replace(/\.\w+$/, '')) : '';
      const text = tds[iT] ? txt(tds[iT]) : ''; if (!text) continue;
      out.rows.push({ kind, when: tds[iW] ? txt(tds[iW]) : '', text });
    }
    if (!out.rows.length) out.empty = emptyNote(root);
    return out;
  }
  /** gxProductInfo: property rows (spaceobjectprops) + any market rows (gxGetMarketInfo) the page carries. */
  function parseProductInfo(html) {
    const doc = parseDoc(html), props = [];
    for (const tr of doc.querySelectorAll('tr[onclick*="spaceobjectprops"]')) { const tds = tdsOf(tr); if (tds.length >= 5) { const k = txt(tds[2]), v = txt(tds[4]); if (k) props.push([k, v]); } }
    const head = doc.querySelector('.gxpu_header'), img = doc.querySelector('img[width="75"]');
    const markets = []; for (const tr of doc.querySelectorAll('#gx_product_markets tr')) { const a = callArgs(tr.innerHTML, 'gxGetMarketInfo'); if (!a) continue; const cells = tdsOf(tr).map(txt).filter(Boolean); markets.push({ stationId: String(a[0]), cells }); }
    return { name: head ? txt(head) : ((props.find(p => p[0] === 'Product') || [])[1] || ''), image: img ? img.getAttribute('src') : '', props, markets, signedOut: /gxLogin\(\)/.test(html) };
  }
  /** gxInfo&miKey=<world number>: world (globe) page: name, blurb, "today" stats, host (world map link), galaxy position. */
  function parseWorldInfo(html) {
    const doc = parseDoc(html), stats = [];
    for (const tr of doc.querySelectorAll('tr')) { const c = [...tr.children].map(txt).filter(Boolean); if (c.length === 2 && /^[\d,.]+$/.test(c[1]) && !stats.some(s => s[0] === c[0])) stats.push(c); }
    const host = (callArgs(html, 'gxWorldMapByHostName') || [])[0] || '', pos = callArgs(html, 'gxGSIzoomGalaxyPosition');
    const head = doc.querySelector('.gxpu_header, h1, h2, b'); const body = txt(doc.body);
    const name = head ? txt(head) : ''; const blurb = (new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (runs .*?)(?:Try Now|Free Membership|Sign In|$)').exec(body) || [])[1] || '';
    return { name, blurb: blurb.trim(), stats, host, worldId: pos ? String(pos[0]) : '', gx: pos ? { x: pos[2], y: pos[3] } : null };
  }
  /** Game world map URL (what gxWorldMapByHostName opens): '/<host>/cgi-bin/cgiw?gxWorldMap' on the portal host. Navigation only. */
  /** 0.2.8.3: country/world map pages open in the console's own viewer (the game's endpoints return text/plain fragments). */
  const MAPVIEW_HASH = '#gxc-map=';
  function mapViewUrl(host, kind, n) {
    if (!/^sim\d{2}\.simcountry\.com$/i.test(host || '') || ['country', 'world', 'continent', 'region'].indexOf(kind) < 0 || (kind !== 'world' && !/^\d{1,8}$/.test(String(n)))) return '';
    return 'https://www.simcountry.com/cgi-bin/cgi2nova?SN_ADDRESS=wwwPortal&SN_METHOD=gxRoot' + MAPVIEW_HASH + host.toLowerCase() + '/' + kind + (kind === 'world' ? '' : '/' + n);
  }
  /** Same-origin proxy path the game itself uses (gxscript gxCountryMapByHostName / gxWorldMap). */
  function mapFragmentPath(host, kind, n) {
    const m = { country: 'gxCountryMap&miCountryNumber=' + n, world: 'gxWorldMap', continent: 'gxContinentMap&miContinentNumber=' + n, region: 'gxRegionMap&miRegionNumber=' + n }[kind];
    return '/' + host.toLowerCase() + '/cgi-bin/cgiw?' + m;
  }
  const worldMapUrl = host => mapViewUrl(host, 'world');
  /** "CenterA on GR" -> "GR"; world initials from globe names ("Golden Rainbow" -> "GR"). */
  const worldCode = place => (/\bon\s+([A-Z]{2,3})\b\s*$/.exec(place || '') || [])[1] || '';
  const initials = name => String(name || '').split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('');
  /* ===================================================================
   * 0.2.6 FORM-CAPTURE PARSERS: find the game's owner-action calls in a page and describe every <form> it contains.
   * =================================================================== */
  const CAPTURE_FNS = Object.keys(CAPTURE_LOADERS).concat(CAPTURE_RECORD_ONLY);
  /** All calls to known action functions in onclick/href code: [{fn, args, loader, title, family, label}] (deduplicated). */
  function scanActions(html) {
    const out = [], seen = new Set(), doc = parseDoc(html || '');
    for (const el of doc.querySelectorAll('[onclick], a[href^="javascript:"]')) {
      const code = (el.getAttribute('onclick') || '') + ' ' + (el.getAttribute('href') || '');
      for (const fn of CAPTURE_FNS) {
        const re = new RegExp('\\b' + fn + '\\s*\\(([^)]*)\\)', 'g'); let m;
        while ((m = re.exec(code))) { const args = parseArgs(m[1]), k = fn + JSON.stringify(args); if (seen.has(k)) continue; seen.add(k);
          const L = CAPTURE_LOADERS[fn];
          out.push({ fn, args, loader: !!L, title: L ? L.title : '', family: L ? L.family : '', label: (txt(el) || el.getAttribute('title') || '').slice(0, 80) }); }
      }
    }
    return out;
  }
  /** Every <form>: name, fields (like deskform_getpostlist would see them), options of selects, and the submit calls that name it. */
  function captureForms(html) {
    const doc = parseDoc(html || ''), forms = [];
    for (const f of doc.querySelectorAll('form')) {
      const name = f.getAttribute('name') || f.getAttribute('id') || '';
      const fields = [...f.querySelectorAll('input, select, textarea, button')].filter(el => el.getAttribute('name')).map(el => {
        const type = (el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : el.tagName.toLowerCase()).toLowerCase();
        const o = { name: el.getAttribute('name'), type, value: el.tagName === 'TEXTAREA' ? el.textContent : el.tagName === 'SELECT' ? (((el.querySelector('option[selected]') || el.querySelector('option')) || { getAttribute: () => '' }).getAttribute('value') || '') : (el.getAttribute('value') || (type === 'checkbox' || type === 'radio' ? 'on' : '')), checked: el.hasAttribute('checked'), maxlength: el.getAttribute('maxlength') || '' };
        if (el.tagName === 'SELECT') o.options = [...el.querySelectorAll('option')].slice(0, 60).map(op => [op.getAttribute('value') || '', txt(op).slice(0, 60), op.hasAttribute('selected')]);
        return o; });
      forms.push({ name, action: f.getAttribute('action') || '', method: f.getAttribute('method') || '', fields, text: txt(f).slice(0, 400) });
    }
    const submits = [];
    for (const fn of ['gxSendShipForm', 'gxSendForm', 'gxSendTransportForm']) { const re = new RegExp('\\b' + fn + '\\s*\\(([^)]*)\\)', 'g'); let m; while ((m = re.exec(html || ''))) { const a = parseArgs(m[1]); submits.push({ fn, form: a[0], method: a[1] }); } }
    for (const f of forms) f.submits = submits.filter(s => s.form === f.name);
    return { forms, submits, message: parseGameMessage(html || ''), title: txt(doc.querySelector('.gxpu_header, h1, h2, h3')).slice(0, 120) };
  }
  /* ===================================================================
   * 0.2.7 FLIGHT PLAN parser (tsFlightPlan / gxFlightPlan, see live/probe/v2.html):
   * "Current Destination" block + "Available Destinations" rows, each with a Schedule button. The button calls
   * gxShip2Station/gxShip2Center when the game offers the flight; a disabled button has onclick="void(0)".
   * =================================================================== */
  function parseFlightPlan(html) {
    const doc = parseDoc(html || ''), out = { current: null, notes: [], dests: [] };
    const scope = doc.querySelector('#gx_gfp_content, #tsFlightPlan') || doc; for (const i of scope.querySelectorAll('td > i')) { const t = txt(i); if (t) out.notes.push(t); }
    const curTh = [...doc.querySelectorAll('th')].find(t => /Current Destination/.test(txt(t)));
    if (curTh) { const tr = curTh.closest('tr').nextElementSibling; if (tr) { const a = tr.querySelector('a[title]'), tds = tdsOf(tr).map(txt);
      const tus = tds.filter(x => /tu$/.test(x)); out.current = { name: a ? a.getAttribute('title') : '', sinceTu: tus[0] ? num(tus[0]) : null, arrivalTu: tus[1] ? num(tus[1]) : null }; } }
    const avTh = [...doc.querySelectorAll('th')].find(t => /Available Destinations/.test(txt(t)));
    const table = avTh && avTh.closest('table'); if (!table) return out;
    for (const tr of table.querySelectorAll('tr')) {
      const btn = tr.querySelector('td.gxpu_button'); if (!btn) continue;
      const html2 = tr.innerHTML, st = callArgs(html2, 'gxGSSzoomGalaxyPosition'), ce = callArgs(html2, 'gxGSIzoomGalaxyPosition');
      const named = [...tr.querySelectorAll('a[title]')].find(a => !/zoom/i.test(a.getAttribute('onclick') || '')), cells = tdsOf(tr).map(txt).filter(x => x && x !== '\u00a0');
      const acts = scanActions('<table>' + tr.outerHTML + '</table>').filter(a => a.fn === 'gxShip2Station' || a.fn === 'gxShip2Center');
      const call = acts[0] || null, dist = cells.find(x => /miles/.test(x)) || '';
      out.dests.push({ name: named ? named.getAttribute('title') : (cells[0] || ''), kind: st ? 'station' : ce ? 'center' : (call && call.fn === 'gxShip2Station' ? 'station' : 'center'),
        stationId: st ? String(st[0]) : (call && call.fn === 'gxShip2Station' ? String(call.args[2]) : null), distance: dist, miles: num(dist),
        docks: cells[cells.indexOf(dist) + 1] || '', call, enabled: !!call, buttonTitle: (btn.querySelector('[title]') || { getAttribute: () => '' }).getAttribute('title') || '' });
    }
    return out;
  }
  /* ===================================================================
   * STORAGE: IndexedDB (cursor reads, batched writes) with in-memory fallback
   * stores: ships{id}, events{dk = dedupe key; index t}, meta{key}, queue{qid}, dict{c} (3.1.0, DB version 2)
   * 3.1.0 compact event records: repeated strings are interned into 'dict' ({ c: <number>, s: <string> });
   * a compact record carries v:2 and short keys (see packEvent). Old records (no v) stay readable, so the
   * migration can run in the background, resumably, and a half-migrated store is always valid.
   * =================================================================== */
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('tx abort')); });
  class GxDB {
    constructor(idb, name) { this.idb = idb; this.name = name || 'galaxyplus'; this.db = null; }
    async open() {
      const r = this.idb.open(this.name, 2);
      r.onupgradeneeded = ev => {
        const d = r.result, old = ev.oldVersion || 0;
        if (old < 1) {
          d.createObjectStore('ships', { keyPath: 'id' });
          d.createObjectStore('events', { keyPath: 'dk' }).createIndex('t', 't');
          d.createObjectStore('meta', { keyPath: 'key' });
          d.createObjectStore('queue', { keyPath: 'qid' });
        }
        if (old < 2 && !d.objectStoreNames.contains('dict')) d.createObjectStore('dict', { keyPath: 'c' }); // 3.1.0: string dictionary
      };
      this.db = await reqP(r); return this;
    }
    close() { if (this.db) this.db.close(); this.db = null; }
    async eachRecord(store, cb, opts) {
      opts = opts || {};
      const tx = this.db.transaction(store, 'readonly'); const src = opts.index ? tx.objectStore(store).index(opts.index) : tx.objectStore(store);
      await new Promise((res, rej) => {
        const c = src.openCursor(opts.range || null, opts.dir || 'next'); let n = 0;
        c.onsuccess = () => { const cur = c.result; if (!cur || (opts.limit && n >= opts.limit)) return res(); n++; if (cb(cur.value) === false) return res(); cur.continue(); };
        c.onerror = () => rej(c.error);
      });
    }
    /** 3.1.0: read 'events' in time order in batches; each batch in its own short transaction, so `cb` may await.
     *  `from` = { t, dks } resume point (records with t === from.t whose dk is in dks were already handed out). */
    async eachBatch(store, size, cb, from) {
      let lastT = from ? from.t : null, seen = new Set(from ? from.dks || [] : []);
      for (;;) {
        const batch = []; const tx = this.db.transaction(store, 'readonly'); const ix = tx.objectStore(store).index('t');
        await new Promise((res, rej) => {
          const c = ix.openCursor(lastT == null ? null : (this.KeyRange || W.IDBKeyRange || IDBKeyRange).lowerBound(lastT));
          c.onsuccess = () => { const cur = c.result; if (!cur || batch.length >= size) return res(); const v = cur.value; if (!(v.t === lastT && seen.has(v.dk))) batch.push(v); cur.continue(); };
          c.onerror = () => rej(c.error);
        });
        if (!batch.length) return;
        const lt = batch[batch.length - 1].t; if (lt !== lastT) seen = new Set(); lastT = lt; for (const v of batch) if (v.t === lt) seen.add(v.dk);
        if ((await cb(batch, { t: lastT, dks: [...seen] })) === false) return;
        if (batch.length < size) return;
      }
    }
    async putMany(store, items) {
      for (let i = 0; i < items.length; i += LIMITS.IDB_BATCH) {
        const tx = this.db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
        for (const it of items.slice(i, i + LIMITS.IDB_BATCH)) os.put(it);
        await txDone(tx);
      }
    }
    async deleteMany(store, keys) {
      for (let i = 0; i < keys.length; i += LIMITS.IDB_BATCH) { const tx = this.db.transaction(store, 'readwrite'); for (const k of keys.slice(i, i + LIMITS.IDB_BATCH)) tx.objectStore(store).delete(k); await txDone(tx); }
    }
    async get(store, key) { return reqP(this.db.transaction(store, 'readonly').objectStore(store).get(key)); }
    async count(store) { return reqP(this.db.transaction(store, 'readonly').objectStore(store).count()); }
    async clear(store) { const tx = this.db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); await txDone(tx); }
    async getMeta(key, dflt) { const r = await this.get('meta', key); return r ? r.value : dflt; }
    async setMeta(key, value) { await this.putMany('meta', [{ key, value }]); }
  }
  class MemDB { // fallback when IndexedDB is unavailable (nothing persists)
    constructor() { this.s = { ships: new Map(), events: new Map(), meta: new Map(), queue: new Map(), dict: new Map() }; this.kp = { ships: 'id', events: 'dk', meta: 'key', queue: 'qid', dict: 'c' }; }
    async eachBatch(store, size, cb, from) { const v = [...this.s[store].values()].sort((a, b) => (a.t - b.t) || (a.dk < b.dk ? -1 : a.dk > b.dk ? 1 : 0));
      let i = 0; if (from) { while (i < v.length && (v[i].t < from.t || (v[i].t === from.t && (from.dks || []).indexOf(v[i].dk) >= 0))) i++; }
      for (; i < v.length; i += size) { const b = v.slice(i, i + size).map(x => JSON.parse(JSON.stringify(x))); const lt = b[b.length - 1].t; if ((await cb(b, { t: lt, dks: b.filter(x => x.t === lt).map(x => x.dk) })) === false) return; } }
    async open() { return this; } close() {}
    async eachRecord(store, cb, o) { let v = [...this.s[store].values()]; if (o && o.index === 't') v.sort((a, b) => a.t - b.t); if (o && o.dir === 'prev') v.reverse(); let n = 0; for (const x of v) { if (o && o.limit && n++ >= o.limit) break; if (cb(x) === false) break; } }
    async putMany(store, items) { for (const it of items) this.s[store].set(it[this.kp[store]], JSON.parse(JSON.stringify(it))); }
    async deleteMany(store, keys) { for (const k of keys) this.s[store].delete(k); }
    async get(store, key) { return this.s[store].get(key); } async count(store) { return this.s[store].size; } async clear(store) { this.s[store].clear(); }
    async getMeta(k, d) { const r = this.s.meta.get(k); return r ? r.value : d; } async setMeta(k, v) { this.s.meta.set(k, { key: k, value: v }); }
  }

  /* ===================================================================
   * TRACKER: shuttle register + per-tick diff events + CSV in/out
   * =================================================================== */
  const TRACKED = Object.freeze(['location', 'destination', 'cargo', 'missions', 'sinceTu', 'arrivalTu', 'status', 'onMap']);
  const SHIP_FIELDS = ['id', 'name', 'owner', 'ownerKey', 'location', 'destination', 'cargo', 'missions', 'sinceTu', 'arrivalTu', 'status', 'x', 'y', 'onMap', 'heading',
    'firstSeen', 'lastSeen', 'lastSeenSession', 'detailAt', 'inList', 'stale', 'firstDetailAt', 'logSeq', 'cargoItems', 'cargoAt'];
  function statusOf(s) {
    if (s.missions === 0 || (s.detail && s.detail.retiring)) return 'retired'; // 0 missions left = retired ('about to retire. Please offload its cargo')
    if (s.detail) return s.detail.flight ? 'flight' : (s.detail.noFlight ? 'idle' : 'unknown');
    if (s.destination) return 'flight';
    if (s.heading) return s.heading === 'C' ? 'idle' : 'flight';
    return s.status || 'unknown';
  }
  const worldOf = loc => { if (!loc) return ''; const m = / on (\S+)$/.exec(loc); if (m) return m[1]; if (/^GDS\./.test(loc)) return 'in space'; return loc; };
  const norm = v => (v === undefined || v === '' ? null : v);

  function createTracker(o) {
    const db = o.db, dbg = o.dbg, now = o.now || (() => Date.now());
    const T = { ships: new Map(), events: [], session: 0, capacity: new Map(), dirty: new Set(), pendingEvents: [], listeners: new Set(), lastTickSeen: new Set(), lastListIds: new Set(), eventHooks: new Set() };
    T.subscribe = f => { T.listeners.add(f); return () => T.listeners.delete(f); };
    const emit = () => { for (const f of T.listeners) { try { f(); } catch (e) { dbg.script('error', 'listener: ' + e.message); } } };
    function blank(id) { return { id, name: '', owner: '', location: '', destination: '', cargo: null, missions: null, sinceTu: null, arrivalTu: null, status: 'unknown', x: null, y: null, ownerKey: '', firstDetailAt: 0, logSeq: 0, logbook: [],
      onMap: false, heading: null, firstSeen: now(), lastSeen: 0, lastSeenSession: 0, detailAt: 0, inList: false, stale: false, detail: null, detailError: null, nextDueAt: 0, snap: null }; }
    /* 3.0.8: optional per-type filter (Settings > Events). Unchecked types are not recorded from now on; ship data,
     * logbooks and already stored events are untouched. */
    T.eventFilter = null;
    /* 3.0.8: rows kept in the in-memory events log (Events tab, trends, notifications). The IndexedDB register itself is not trimmed. */
    T.eventLimit = LIMITS.EVENT_RING_UI;
    /* 3.0.9: amortised trimming. Before, every add past the limit did splice(0, 1) on a 20,000-element array (O(n) per
     * add). Now the oldest rows are dropped in one batch once the log is a margin (5 %, >= 200) over the limit, so the
     * cost per add is O(1) amortised; the newest rows are always kept. */
    /* 3.1.1: with auto-export on, the margin is the export batch (1,000 when the limit is <= 10,000, else 10,000): the log may hold
     * limit + batch rows, and each trim drops exactly one batch, which is exactly what gets exported. */
    T.autoExport = false; T.rollBatch = () => (T.eventLimit <= 10000 ? 1000 : 10000);
    const evMargin = () => (T.autoExport ? T.rollBatch() : Math.max(200, Math.round(T.eventLimit * 0.05)));
    /* 3.1.5: byte budget for the in-memory events (estimated; string fields capped at MEM.EVENT_FIELD chars on add) */
    T.eventBytes = MEM.EVENT_BYTES; T.evBytes = 0; T.evByteTrims = 0; T.onBudget = null;
    const evB = e => { let n = 160; for (const k in e) { const v = e[k]; n += 16 + (typeof v === 'string' ? 2 * v.length : 8); } return n; };
    const capEv = e => { for (const k in e) { const v = e[k]; if (typeof v === 'string' && v.length > MEM.EVENT_FIELD && k !== 'dk') e[k] = capStr(v, MEM.EVENT_FIELD); } return e; };
    /* 3.1.5: accumulated logbooks of all shuttles: estimated bytes and a global trim (oldest lines of the longest logbooks first, never below MEM.LOGBOOK_MIN_KEEP lines) */
    const lbB = l => 120 + 2 * ((l.text || '').length + (l.when || '').length);
    T.logbookBytes = () => { let n = 0; for (const s of T.ships.values()) for (const l of s.logbook || []) n += lbB(l); return n; };
    T.trimLogbooks = budget => { let total = T.logbookBytes(); if (total <= budget) return 0; let cut = 0; const goal = budget * 0.9;
      const list = [...T.ships.values()].filter(s => s.logbook && s.logbook.length > MEM.LOGBOOK_MIN_KEEP).sort((a, b) => b.logbook.length - a.logbook.length);
      for (let round = 0; round < 8 && total > goal && list.length; round++) for (const s of list) { if (total <= goal) break; const L = s.logbook, keep = Math.max(MEM.LOGBOOK_MIN_KEEP, Math.floor(L.length * 0.75)); if (L.length <= keep) continue;
        const gone = L.splice(0, L.length - keep); for (const g of gone) total -= lbB(g); cut += gone.length; }
      return cut; };
    T.recountEvents = () => { let n = 0; for (const e of T.events) n += evB(e); T.evBytes = n; return n; };
    function addEv(e) { capEv(e); T.evBytes += evB(e); T.events.push(e); }
    function trimEvents(force) {
      if (force) T.recountEvents();
      let over = T.events.length - T.eventLimit; if (!(over > 0 && (force || over >= evMargin()))) over = 0;
      if (T.evBytes > T.eventBytes) { let b = T.evBytes, i = 0; const goal = T.eventBytes * 0.9; while (i < T.events.length && b > goal) { b -= evB(T.events[i]); i++; } if (i > over) { over = i; T.evByteTrims++; if (T.onBudget) { try { T.onBudget(i); } catch (x) { /* */ } } } }
      if (over > 0) { const gone = T.events.splice(0, over); let gb = 0; for (const g of gone) gb += evB(g); T.evBytes = Math.max(0, T.evBytes - gb); if (T.onTrim) { try { T.onTrim(gone); } catch (e) { dbg.script('error', 'trim hook: ' + e.message); } } } }
    /* 3.1.0: T.onTrim(rows) is called with exactly the rows dropped from the in-memory log (oldest first) — used by the
     * auto-export on rollover, so consecutive files neither overlap nor leave gaps. */
    T.onTrim = null;
    T.trimEvents = trimEvents;
    /** 3.0.9: clear the in-memory events log (Events tab view). The stored register / events CSV history is NOT deleted. */
    T.resetEvents = () => { const n = T.events.length; T.events.length = 0; T.evBytes = 0; dbg.script('info', `events log view reset (${n} rows cleared from memory; saved history kept)`); emit(); return n; };
    T.setEventLimit = n => { T.eventLimit = Math.max(1000, Math.min(200000, Math.round(+n) || LIMITS.EVENT_RING_UI)); trimEvents(true); emit(); return T.eventLimit; };
    /* 3.1.0 events logging mode: 'standard' (per-type selection) or 'compact' (trip/cargo facts only: departure with
     * origin + destination, arrival, cargo type/quantity, real time + the game's tu counter; for all shuttles). */
    T.mode = 'standard'; T.loggingOn = true;
    const COMPACT_FIELDS = new Set(['trip_start', 'arrived', 'cargo_load', 'cargo_unload']);
    const lastPlace = new Map(); // ship -> last arrival place (origin of the next departure)
    function pushEvent(s, field, from, to, source, t, extra) {
      if (field === 'arrived' && extra && extra.place) lastPlace.set(s.id, extra.place);
      const off = !T.loggingOn || (T.mode === 'compact' ? !COMPACT_FIELDS.has(field) : (T.eventFilter && !T.eventFilter(field)));
      if (off) { if (field !== 'registered' && field !== 'onMap') s.lastChangeAt = t || now(); return; }
      if (T.mode === 'compact') {
        const x = extra || {}, e = { t: t || now(), ship: s.id, name: s.name, owner: s.owner, field, from: field === 'trip_start' ? (lastPlace.get(s.id) || '') : '', to: field === 'trip_start' ? (x.place || '') : '', source, compact: 1,
          lk: x.lk, server: x.server, st: x.st, seq: x.seq, product: x.product || '', qty: x.qty == null ? '' : x.qty, unit: x.unit || '', place: x.place || '', tu: s.sinceTu == null ? '' : s.sinceTu };
        e.dk = e.lk ? ['L', e.ship, e.lk].join('|') : [e.t, e.ship, e.field, e.from, e.to].join('|');
        s.lastChangeAt = e.t; addEv(e); trimEvents(); T.pendingEvents.push(e);
        for (const f of T.eventHooks) { try { f(e); } catch (x2) { dbg.script('error', 'event hook: ' + x2.message); } }
        return;
      }
      if (T.eventFilter && !T.eventFilter(field)) { if (field !== 'registered' && field !== 'onMap') s.lastChangeAt = t || now(); return; } // 3.0.10: filtered changes still mark the shuttle active (refresh cadence)
      const e = { t: t || now(), ship: s.id, name: s.name, owner: s.owner, field, from: from == null ? '' : String(from), to: to == null ? '' : String(to), source };
      if (extra) Object.assign(e, extra);
      e.dk = e.lk ? ['L', e.ship, e.lk].join('|') : [e.t, e.ship, e.field, e.from, e.to].join('|');
      if (field !== 'registered' && field !== 'onMap') s.lastChangeAt = e.t;
      addEv(e); trimEvents();
      T.pendingEvents.push(e);
      for (const f of T.eventHooks) { try { f(e); } catch (x) { dbg.script('error', 'event hook: ' + x.message); } }
    }
    /** Merge a logbook read into the shuttle's own logbook (persisted) and log each NEW line once as an event:
     *  trip_start / arrived / cargo_load / cargo_unload / log.
     *  The game stamps recent lines "Oct 11 00:30" but older ones only "Oct 10", so the same line changes its stamp as it ages;
     *  new lines are therefore found by aligning the read (oldest first) against the end of the stored logbook on day + text,
     *  not by stamp. Line key = day | text | n-th identical line that day (stable across machines, used for import dedupe). */
    const dayOf = w => (/^([A-Z][a-z]{2}\s+\d{1,2})/.exec(w || '') || [])[1] || String(w || '');
    function recordLogbook(s, logs, o) {
      o = o || {}; if (!s.logbook) s.logbook = [];
      const inc = logs.filter(l => l && l.text).slice().reverse(), L = s.logbook, same = (a, b) => a.text === b.text && dayOf(a.when) === dayOf(b.when);
      let k = 0;
      for (let m = Math.min(L.length, inc.length); m > 0; m--) { let okm = true; for (let i = 0; i < m; i++) if (!same(inc[i], L[L.length - m + i])) { okm = false; break; } if (okm) { k = m; break; } }
      if (!k && L.length && inc.length) { // maybe the whole read lies inside what we have (no new lines)
        const txt = L.map(l => dayOf(l.when) + '|' + l.text).join('\n'), q = inc.map(l => dayOf(l.when) + '|' + l.text).join('\n'); if (txt.indexOf(q) >= 0) k = inc.length;
        else dbg.script('debug', `logbook ${s.name}#${s.id.slice(-6)}: no overlap with the stored logbook (gap: lines may have been missed between reads)`); }
      for (let i = 0; i < k; i++) { const st = L[L.length - k + i]; if (inc[i].when.length > st.when.length) { st.when = inc[i].when; st.st = serverStamp(inc[i].when, st.seenAt); } }
      const fresh = inc.slice(k);
      for (const l of fresh) {
        const at = o.at || now(), st = serverStamp(l.when, at), c = classifyLogLine(l.text), seq = ++s.logSeq, day = dayOf(l.when);
        const nSame = L.filter(x => dayOf(x.when) === day && x.text === l.text).length, key = `${day}|${l.text}|${nSame}`;
        L.push({ k: key, when: l.when, st, tz: 1, text: l.text, seq, seenAt: at });
        if (!o.quiet) pushEvent(s, c.kind, '', l.text, 'logbook', at, { lk: key, server: l.when, st, seq, product: c.product || '', qty: c.qty == null ? '' : c.qty, unit: c.unit || '', place: c.place || '' });
      }
      if (L.length > LIMITS.SHIP_LOGBOOK_KEEP) L.splice(0, L.length - LIMITS.SHIP_LOGBOOK_KEEP);
      if (fresh.length) dbg.script('debug', `logbook ${s.name}#${s.id.slice(-6)}: +${fresh.length} new lines (${L.length} kept)`);
      return fresh.length;
    }
    T.recordLogbook = recordLogbook;
    /** 0.2.6: every Galaxy Console write lands in the event register (and so in the events CSV). */
    T.addWriteEvent = (s, action, from, to, outcome, url) => { pushEvent(s, 'write_' + action, from, to, 'galaxyplus-write', null, { note: outcome + ' ' + url }); T.dirty.add(s.id); };
    /** 3.0.4: transport cancel writes go to the events log/CSV (pseudo ship id "transport:<id>"). */
    T.addTransportWriteEvent = (row, id, outcome, msg) => { pushEvent({ id: 'transport:' + id, name: row ? `${row.quantity} ${row.product} ${row.origin} -> ${row.target}` : '', owner: '' }, 'write_cancel_transport', row ? row.statusLabel : '', outcome, 'galaxyplus-write', null, { note: outcome + (msg ? ': ' + msg : '') + ' /cgi-bin/cgip?gxDelTransportRequest&miKey=' + id }); };
    /** Apply data from a source; diff tracked fields; append events. */
    T.observe = (id, patch, source) => {
      let s = T.ships.get(id), isNew = false;
      if (!s) { s = blank(id); T.ships.set(id, s); isNew = true; }
      const prevDetail = s.detail, prevAt = s.detailAt;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'detail' || k === 'cargoItems') continue;
        if (v === undefined) continue;
        if ((k === 'name' || k === 'owner' || k === 'ownerKey' || k === 'location') && (v === '' || v == null)) continue;
        s[k] = v;
      }
      if (patch.cargoItems) { const sig = l => (l || []).map(x => x.product + ':' + x.qty).sort().join('|'), before = sig(s.cargoItems), after = sig(patch.cargoItems);
        if (s.cargoItems && before !== after) pushEvent(s, 'cargo_items', before, after, source, null, {});
        s.cargoItems = patch.cargoItems; s.cargoAt = now(); }
      if (patch.detail) {
        const d = patch.detail; s.detail = d; s.detailAt = now(); s.detailError = null; if (!s.firstDetailAt) s.firstDetailAt = s.detailAt;
        s.name = d.name || s.name; s.owner = d.owner || s.owner; s.ownerKey = d.ownerKey || s.ownerKey; s.location = d.location || s.location; s.destination = d.destination;
        s.cargo = d.cargo; s.missions = d.missions; s.sinceTu = d.flight ? d.flight.sinceTu : null; s.arrivalTu = d.flight ? d.flight.arrivalTu : null;
        for (const l of d.logs) { const p = parseLoadLine(l.text); if (p && p.qty && (!T.capacity.has(p.product) || T.capacity.get(p.product).qty < p.qty)) { T.capacity.set(p.product, { qty: p.qty, unit: p.unit, ship: s.id, at: now() }); T.capacityDirty = true; } }
        recordLogbook(s, d.logs || []);
        if (d.flight && (!prevDetail || !prevDetail.flight || prevDetail.flight.target !== d.flight.target)) pushEvent(s, 'flight', s.location, d.flight.target, 'detail', null, { qty: d.flight.distanceMiles, unit: 'miles', place: d.flight.target, note: d.flightNote || '' });
        if (prevDetail && prevDetail.flight && d.flight && prevDetail.flight.target === d.flight.target && d.flight.sinceTu > prevDetail.flight.sinceTu) {
          const dtu = d.flight.sinceTu - prevDetail.flight.sinceTu, dt = (now() - prevAt) / 1000;
          dbg.script('debug', `tu-rate ${s.name}#${id.slice(-6)}: +${dtu} tu in ${dt.toFixed(1)} s = ${(dt / dtu).toFixed(2)} s/tu (passive, display rounding applies)`);
        }
      }
      s.status = statusOf(s);
      if (source === 'layer' || source === 'list' || source === 'detail') { s.lastSeen = now(); s.lastSeenSession = T.session; }
      if (source === 'list') { s.inList = true; if (patch.location) s.listLocation = patch.location; } // 3.0.1: planet name as the list shows it (location normalisation)
      s.stale = !(s.onMap || s.inList);
      const snap = {}; for (const k of TRACKED) snap[k] = norm(s[k]);
      if (isNew || !s.snap) { if (source !== 'import') pushEvent(s, 'registered', '', source, source); }
      else for (const k of TRACKED) { if (String(s.snap[k]) !== String(snap[k])) pushEvent(s, k, s.snap[k], snap[k], source); }
      s.snap = snap; T.dirty.add(id);
      return s;
    };
    /** After a full layer tick: shuttles not in the layer drop off the map (event) and may become stale. */
    /** 0.2.8.0: a shuttle missing from a layer answer keeps its last position (mapMiss counts the misses, the map dims it)
     *  and only leaves the map after more than `tolerance` consecutive misses. applyRemovals=false: suspicious answer, nobody is dropped. */
    T.layerTick = (seenIds, tolerance, applyRemovals) => {
      const tol = tolerance == null ? 0 : tolerance;
      for (const s of T.ships.values()) { if (seenIds.has(s.id)) { s.mapMiss = 0; continue; } if (!s.onMap || applyRemovals === false) continue;
        s.mapMiss = (s.mapMiss || 0) + 1; if (s.mapMiss > tol) { s.mapMiss = 0; T.observe(s.id, { onMap: false }, 'layer-missing'); } }
      T.lastTickSeen = seenIds;
    };
    T.listLoaded = ids => { for (const s of T.ships.values()) if (s.inList && !ids.has(s.id)) T.observe(s.id, { inList: false }, 'list-missing'); T.lastListIds = ids; };
    /* ---------- 3.1.0 compact stored events (string dictionary) ---------- */
    const dict = { s2c: new Map(), c2s: [], pending: [] };
    const intern = v => { if (v == null || v === '') return v; v = String(v); let c = dict.s2c.get(v); if (c == null) { c = dict.c2s.length; dict.c2s.push(v); dict.s2c.set(v, c); dict.pending.push({ c, s: v }); } return c; };
    const deref = c => (c == null || c === '' ? '' : typeof c === 'number' ? (dict.c2s[c] == null ? '' : dict.c2s[c]) : c);
    const INTERN_FT = new Set(['location', 'destination', 'status', 'trip_start']); // from/to values that repeat
    /** stored form: v:2, short keys, interned strings. t, dk, ship, lk, seq, st, qty, server, tu stay as they are. */
    function packEvent(e) {
      if (e.v === 2) return e;
      const r = { v: 2, dk: e.dk, t: e.t, ship: e.ship, f: intern(e.field), so: intern(e.source) };
      if (e.name) r.n = intern(e.name); if (e.owner) r.o = intern(e.owner);
      if (e.from) r.a = INTERN_FT.has(e.field) ? intern(e.from) : e.from; if (e.to) r.b = INTERN_FT.has(e.field) ? intern(e.to) : e.to;
      if (e.place) r.p = intern(e.place); if (e.product) r.pr = intern(e.product); if (e.unit) r.u = intern(e.unit);
      for (const k of ['lk', 'server', 'st', 'seq', 'note', 'tu', 'compact']) if (e[k] != null && e[k] !== '') r[k] = e[k];
      if (e.qty != null && e.qty !== '') r.q = e.qty;
      return r;
    }
    function unpackEvent(r) {
      if (!r || r.v !== 2) return r;
      const e = { t: r.t, dk: r.dk, ship: r.ship, field: deref(r.f), source: deref(r.so), name: deref(r.n), owner: deref(r.o), from: deref(r.a), to: deref(r.b), place: deref(r.p), product: deref(r.pr), unit: deref(r.u), qty: r.q == null ? '' : r.q };
      for (const k of ['lk', 'server', 'st', 'seq', 'note', 'tu', 'compact']) if (r[k] != null) e[k] = r[k];
      return e;
    }
    T.packEvent = packEvent; T.unpackEvent = unpackEvent; T.dictSize = () => dict.c2s.length;
    const flushDict = async () => { if (!dict.pending.length) return; const p = dict.pending.splice(0); try { await db.putMany('dict', p); } catch (e) { dict.pending.unshift(...p); throw e; } };
    /** 3.1.0 migration of stored events to the compact form: batches of 500 in time order, progress saved after every batch
     *  (meta 'migV2'), so it resumes after a reload; packing an already-compact record is a no-op (idempotent). */
    T.migration = { state: 'idle', done: 0, total: 0 };
    T.migrateV2 = async (opts) => {
      opts = opts || {}; const st = await db.getMeta('migV2', null); if (st && st.done) { T.migration = { state: 'done', done: st.n || 0, total: st.n || 0 }; return T.migration; }
      if (!db.eachBatch) return T.migration;
      T.migration = { state: 'running', done: st ? st.n || 0 : 0, total: await db.count('events') }; emit();
      let n = st ? st.n || 0 : 0, from = st ? st.from : null;
      await db.eachBatch('events', opts.batch || 500, async (batch, pos) => {
        const todo = batch.filter(r => r.v !== 2).map(packEvent);
        await flushDict(); if (todo.length) await db.putMany('events', todo);
        n += batch.length; from = pos; await db.setMeta('migV2', { done: false, n, from });
        T.migration.done = n; emit(); if (opts.onProgress) opts.onProgress(T.migration);
        if (opts.stopAfter && n >= opts.stopAfter) return false; // tests: simulate an interrupted run
      }, from);
      if (opts.stopAfter && n >= opts.stopAfter && n < T.migration.total) { T.migration.state = 'paused'; return T.migration; }
      await db.setMeta('migV2', { done: true, n }); T.migration = { state: 'done', done: n, total: n }; dbg.script('info', `events storage: ${n} records in compact form`); emit(); return T.migration;
    };
    const toRecord = s => { const r = {}; for (const k of SHIP_FIELDS) r[k] = s[k]; r.snap = s.snap; r.detailLite = s.detail ? Object.assign({}, s.detail) : null; r.logbook = s.logbook || []; return r; };
    T.flush = async () => {
      const ids = [...T.dirty]; T.dirty.clear(); const ev = T.pendingEvents.splice(0);
      try {
        if (ids.length) await db.putMany('ships', ids.map(id => T.ships.get(id)).filter(Boolean).map(toRecord));
        if (ev.length) { const packed = ev.map(packEvent); await flushDict(); await db.putMany('events', packed); }
        if (T.capacityDirty) { T.capacityDirty = false; await db.setMeta('capacity', [...T.capacity.entries()]); }
        if (ids.length || ev.length) dbg.script('debug', `cache flush: ${ids.length} ships, ${ev.length} events`);
      } catch (e) { dbg.script('error', 'cache flush failed: ' + e.message); for (const id of ids) T.dirty.add(id); T.pendingEvents.unshift(...ev); }
    };
    T.init = async () => {
      T.session = (await db.getMeta('sessionCount', 0)) + 1; await db.setMeta('sessionCount', T.session);
      T.capacity = new Map(await db.getMeta('capacity', []));
      let n = 0;
      await db.eachRecord('ships', r => { const s = Object.assign(blank(r.id), r); s.detail = r.detailLite ? Object.assign({ logs: [] }, r.detailLite) : null; s.logbook = r.logbook || []; for (const l of s.logbook) if (!l.tz) { l.st = serverStamp(l.when, l.seenAt) || l.st; l.tz = 1; } s.logSeq = r.logSeq || s.logbook.length; s.onMap = false; s.inList = false; s.stale = true; s.snap = r.snap || null; T.ships.set(r.id, s); n++; });
      { try { await db.eachRecord('dict', r => { dict.c2s[r.c] = r.s; dict.s2c.set(r.s, r.c); }); } catch (e) { dbg.script('warn', 'dictionary load: ' + e.message); } }
      const recent = []; await db.eachRecord('events', e => { recent.push(unpackEvent(e)); }, { index: 't', dir: 'prev', limit: T.eventLimit });
      T.events = recent.reverse(); for (const e of T.events) capEv(e); trimEvents(true);
      dbg.script('info', `register loaded: ${n} shuttles, ${T.events.length} recent events, session #${T.session}`);
      await T.evict();
    };
    /** Evict only when BOTH: unseen > EVICT_DAYS and unseen across >= EVICT_SESSIONS sessions. */
    T.evict = async () => {
      const cutoff = now() - CADENCE.EVICT_DAYS * 86400000, gone = [];
      for (const s of T.ships.values()) if (s.lastSeen && s.lastSeen < cutoff && T.session - (s.lastSeenSession || 0) >= CADENCE.EVICT_SESSIONS) gone.push(s.id);
      if (gone.length) { for (const id of gone) T.ships.delete(id); await db.deleteMany('ships', gone); dbg.script('info', `evicted ${gone.length} shuttles (>${CADENCE.EVICT_DAYS} d and >=${CADENCE.EVICT_SESSIONS} sessions unseen)`); }
      return gone.length;
    };
    /* ---------- CSV: two separate files ----------
     * shuttles CSV (format galaxyplus-shuttles-1): one 'ship' row per shuttle with full details, cargo, flight and the accumulated
     *   logbook (JSON column), plus 'capacity' rows (largest load seen per product) and meta rows.
     * events CSV (format galaxyplus-events-1): every observed change / logbook line as 'event' rows (incl. cargo_load / cargo_unload
     *   with product, quantity, place) plus derived 'trip' rows (departure -> arrival with the cargo carried). Trip rows are
     *   rebuilt from the logbook events, so import ignores them.
     * Import accepts either file (and the old combined 0.2.x CSV) and merges: newer data wins, missing parts are filled,
     * events dedupe on their key, logbook lines dedupe on server stamp + text. */
    const evRow = e => ({ record_type: 'event', ship_id: e.ship, name: e.name, owner: e.owner, event_time: iso(e.t), field: e.field, old_value: e.from, new_value: e.to, source: e.source,
      server_time: e.server || '', server_ts: iso(e.server ? (serverStamp(e.server, e.t) || e.st) : e.st), server_tz: e.server ? SERVER_TZ : '', seq: e.seq == null ? '' : e.seq, product: e.product || '', quantity: e.qty == null ? '' : e.qty, unit: e.unit || '', place: e.place || '', note: e.note || '', log_key: e.lk || '' });
    const toCsv = (cols, rows) => '\uFEFF' + [cols.join(',')].concat(rows.map(o => cols.map(c => csvCell(o[c])).join(','))).join('\r\n') + '\r\n';
    T.exportShipsCSV = async () => {
      await T.flush();
      const rows = [{ record_type: 'meta', name: 'format', status: 'galaxyplus-shuttles-1', owner: 'Galaxy Console ' + VERSION, last_seen: iso(now()) }, { record_type: 'meta', name: 'session_count', status: T.session }];
      for (const [p, c] of T.capacity) rows.push({ record_type: 'capacity', name: p, cargo: c.qty, status: c.unit, ship_id: c.ship, last_seen: iso(c.at) });
      for (const s of T.ships.values()) { const d = s.detail || {}, f = d.flight || {};
        rows.push({ record_type: 'ship', ship_id: s.id, name: s.name, owner: s.owner, owner_key: s.ownerKey, location: s.location, destination: s.destination, cargo: s.cargo, capacity: d.capacity, use_pct: d.usePct,
          missions: s.missions, since_tu: s.sinceTu, arrival_tu: s.arrivalTu, status: s.status, retiring: d.retiring ? 1 : 0, flight_target: f.target, flight_distance: f.distanceMiles, flight_docks: f.docks, flight_note: d.flightNote,
          x: s.x, y: s.y, on_map: s.onMap ? 1 : 0, first_seen: iso(s.firstSeen), last_seen: iso(s.lastSeen), last_seen_session: s.lastSeenSession, detail_at: iso(s.detailAt), first_detail_at: iso(s.firstDetailAt),
          logbook_lines: (s.logbook || []).length, logbook_json: JSON.stringify((s.logbook || []).map(l => [l.when, l.text, l.seq, iso(l.seenAt)])), cargo_at: iso(s.cargoAt), cargo_json: s.cargoItems ? JSON.stringify(s.cargoItems.map(x => [x.product, x.qty, x.unit || '', x.quality == null ? '' : x.quality, x.productId || ''])) : '' }); }
      return toCsv(SHIP_CSV_COLUMNS, rows);
    };
    /** Rebuild trips from logbook events: arrived/loaded at A, scheduled to B, arrived at B, offloaded at B. */
    T.buildTrips = evs => {
      const by = new Map(); for (const e of evs) if (e.source === 'logbook' || e.lk) { if (!by.has(e.ship)) by.set(e.ship, []); by.get(e.ship).push(e); }
      const trips = [];
      for (const [ship, list] of by) {
        list.sort((a, b) => ((a.seq || 0) - (b.seq || 0)) || ((a.st || 0) - (b.st || 0)));
        let place = '', loads = [], cur = null;
        const close = (arrE) => { if (!cur) return; cur.arrived = arrE ? arrE.server : ''; cur.arrived_ts = arrE ? arrE.st : null; trips.push(cur); cur = null; };
        for (const e of list) {
          if (e.field === 'arrived') { if (cur && (!cur.to || cur.to === e.place)) { close(e); place = e.place; loads = []; const t = trips[trips.length - 1]; t.unloads = []; t._open = true; continue; } place = e.place; loads = []; }
          else if (e.field === 'cargo_load') loads.push(e);
          else if (e.field === 'cargo_unload') { const t = trips[trips.length - 1]; if (t && t.ship === ship && t._open && t.to === e.place) t.unloads.push(e); }
          else if (e.field === 'trip_start') { if (cur) close(null); for (const t of trips) if (t.ship === ship) t._open = false;
            cur = { ship, name: e.name, owner: e.owner, from: place, to: e.place, scheduled: e.server, scheduled_ts: e.st, loads: loads.slice(), unloads: [] }; loads = []; }
        }
        if (cur) trips.push(Object.assign(cur, { arrived: '', arrived_ts: null }));
      }
      return trips.map(tripRow);
    };
    const tripSum = l => l.map(x => `${x.product} ${x.qty}${x.unit ? ' ' + x.unit : ''}`).join('; ');
    const tripRow = t => { const sum = tripSum; return ({ record_type: 'trip', ship_id: t.ship, name: t.name, owner: t.owner, old_value: t.from, new_value: t.to, server_time: t.scheduled, server_ts: iso(t.scheduled_ts), server_tz: t.scheduled ? SERVER_TZ : '', field: 'trip',
        note: t.arrived ? 'arrived ' + t.arrived + (t.arrived_ts && t.scheduled_ts ? ` (${Math.round((t.arrived_ts - t.scheduled_ts) / 60000)} min)` : '') : 'in flight / unknown arrival',
        product: [...new Set(t.loads.map(x => x.product))].join('; '), quantity: t.loads.reduce((a, x) => a + (+x.qty || 0), 0) || '', unit: (t.loads[0] || {}).unit || '',
        place: t.to, source: 'derived', old_value_detail: sum(t.loads), new_value_detail: sum(t.unloads) }); };
    /** 3.1.0 single-pass trip derivation (same rules as buildTrips) for events arriving in time order. Keeps only each
     *  shuttle's state (place, pending loads, open trip, last closed trip still collecting unloads, and the events of the
     *  current time stamp, which are ordered by logbook seq before use). `out(row)` gets each trip row once it is final. */
    function tripDeriver(out) {
      const S = new Map();
      const st = ship => S.get(ship) || (S.set(ship, { place: '', loads: [], cur: null, last: null, pt: null, pend: [] }), S.get(ship));
      const fin = t => { if (t) out(tripRow(t)); };
      const step = (x, ship, e) => {
        if (e.field === 'arrived') { if (x.cur && (!x.cur.to || x.cur.to === e.place)) { fin(x.last); x.cur.arrived = e.server; x.cur.arrived_ts = e.st; x.last = x.cur; x.last.unloads = []; x.cur = null; x.place = e.place; x.loads = []; return; } x.place = e.place; x.loads = []; }
        else if (e.field === 'cargo_load') x.loads.push(e);
        else if (e.field === 'cargo_unload') { if (x.last && x.last.to === e.place) x.last.unloads.push(e); }
        else if (e.field === 'trip_start') { if (x.cur) { x.cur.arrived = ''; x.cur.arrived_ts = null; fin(x.last); x.last = null; fin(x.cur); x.cur = null; } else { fin(x.last); x.last = null; }
          x.cur = { ship, name: e.name, owner: e.owner, from: x.place, to: e.place, scheduled: e.server, scheduled_ts: e.st, loads: x.loads.slice(), unloads: [] }; x.loads = []; }
      };
      const drain = (x, ship) => { x.pend.sort((a, b) => ((a.seq || 0) - (b.seq || 0)) || ((a.st || 0) - (b.st || 0))); for (const e of x.pend) step(x, ship, e); x.pend = []; };
      return {
        push(e) { if (!(e.source === 'logbook' || e.lk)) return; const x = st(e.ship); if (x.pt !== e.t) { drain(x, e.ship); x.pt = e.t; } x.pend.push(e); },
        end() { for (const [ship, x] of S) { drain(x, ship); fin(x.last); if (x.cur) { x.cur.arrived = ''; x.cur.arrived_ts = null; fin(x.cur); } } S.clear(); },
        size: () => S.size };
    }
    T.tripDeriver = tripDeriver;
    /** events CSV. 3.0.10: optional `list` = export just these events (e.g. the in-memory log) instead of the stored history. */
    /** 3.1.0 streaming events CSV: reads the store in batches (cursor), converts each batch to CSV text and hands back
     *  a list of chunks (Blob parts in the browser), never one giant array or string. Trips are derived in the same
     *  pass (tripDeriver) and written as they become final. Same columns and format id as before. `list` = export
     *  just these events (in-memory log / rollover). */
    T.exportEventsParts = async (list, o) => {
      o = o || {}; await T.flush();
      const parts = [], B = (typeof Blob !== 'undefined' && !o.strings) ? s => new Blob([s]) : s => s, trips = [];
      const line = r => EVENT_CSV_COLUMNS.map(c => csvCell(r[c])).join(',') + '\r\n';
      parts.push(B('\uFEFF' + EVENT_CSV_COLUMNS.join(',') + '\r\n' + line({ record_type: 'meta', field: 'format', new_value: 'galaxyplus-events-1', source: 'Galaxy Console ' + VERSION, event_time: iso(now()) })));
      const td = tripDeriver(t => trips.push(line(Object.assign(t, { loaded: t.old_value_detail, offloaded: t.new_value_detail }))));
      const take = batch => { let s = ''; for (const e of batch) { s += line(evRow(e)); td.push(e); } if (trips.length) { s += trips.join(''); trips.length = 0; } if (s) parts.push(B(s)); };
      let n = 0;
      if (Array.isArray(list)) { const l = list.slice().sort((a, b) => a.t - b.t); for (let i = 0; i < l.length; i += 1000) { take(l.slice(i, i + 1000)); } n = l.length; }
      else if (db.eachBatch) await db.eachBatch('events', o.batch || 1000, b => { take(b.map(unpackEvent)); n += b.length; if (o.onProgress) o.onProgress(n); });
      else { const all = []; await db.eachRecord('events', e => { all.push(unpackEvent(e)); }, { index: 't' }); take(all); n = all.length; }
      td.end(); if (trips.length) parts.push(B(trips.join('')));
      T.lastExport = { events: n, parts: parts.length }; return parts;
    };
    T.exportEventsCSV = async list => { const p = await T.exportEventsParts(list, { strings: true }); return p.join(''); }; // string form (tests, small exports)
    T.exportCSV = T.exportShipsCSV; // 0.2.3 API name
    /** Merge either CSV (or the old combined one). Never overwrite newer data; fill missing parts. Returns counts. */
    T.importCSV = async text => {
      const rows = csvParse(text); if (!rows.length) throw new Error('empty CSV');
      const h = rows[0].map(x => x.trim()); const ix = c => h.indexOf(c);
      for (const c of ['record_type', 'ship_id']) if (ix(c) < 0) throw new Error('not a Galaxy Console CSV (missing column ' + c + ')');
      const res = { kind: ix('logbook_json') >= 0 ? 'shuttles' : ix('log_key') >= 0 ? 'events' : 'combined-0.2', ships_new: 0, ships_updated: 0, ships_filled: 0, logbook_lines_new: 0, events_new: 0, events_dup: 0, trips_ignored: 0, capacity: 0, skipped: 0 };
      const evs = [];
      const existingEv = new Set(); await db.eachRecord('events', e => { existingEv.add(e.dk); });
      for (const r of rows.slice(1)) {
        const g = c => { const i = ix(c); return i < 0 ? '' : (r[i] || ''); };
        const type = g('record_type');
        if (type === 'meta') { const k = g('field') || g('name'), v = g('field') ? g('new_value') : g('status'); if (k === 'session_count') { const n = +v || 0; if (n > T.session) { T.session = n; await db.setMeta('sessionCount', n); } } continue; }
        if (type === 'capacity') { const old = ix('logbook_json') < 0; const p = old ? g('field') : g('name'), q = +(old ? g('new_value') : g('cargo')), u = old ? g('old_value') : g('status'), at = unIso(old ? g('event_time') : g('last_seen'));
          if (p && q && (!T.capacity.has(p) || T.capacity.get(p).qty < q)) { T.capacity.set(p, { qty: q, unit: u, ship: g('ship_id'), at: at || now() }); T.capacityDirty = true; res.capacity++; } continue; }
        if (type === 'trip') { res.trips_ignored++; continue; }
        if (type === 'event') {
          const e = { t: unIso(g('event_time')), ship: g('ship_id'), name: g('name'), owner: g('owner'), field: g('field'), from: g('old_value'), to: g('new_value'), source: g('source') || 'import' };
          if (!e.t || !e.ship) { res.skipped++; continue; }
          if (g('log_key')) Object.assign(e, { lk: g('log_key'), server: g('server_time'), st: ix('server_tz') >= 0 ? unIso(g('server_ts')) : (serverStamp(g('server_time'), unIso(g('event_time'))) || unIso(g('server_ts'))), seq: g('seq') === '' ? null : +g('seq'), product: g('product'), qty: g('quantity') === '' ? '' : +g('quantity'), unit: g('unit'), place: g('place') });
          if (g('note')) e.note = g('note');
          e.dk = e.lk ? ['L', e.ship, e.lk].join('|') : [e.t, e.ship, e.field, e.from, e.to].join('|'); if (existingEv.has(e.dk)) { res.events_dup++; continue; }
          existingEv.add(e.dk); evs.push(e); res.events_new++;
          continue;
        }
        if (type !== 'ship' || !g('ship_id')) { res.skipped++; continue; }
        const id = g('ship_id'), inc = { name: g('name'), owner: g('owner'), ownerKey: g('owner_key'), location: g('location'), destination: g('destination'), cargo: num(g('cargo')), missions: num(g('missions')),
          sinceTu: num(g('since_tu')), arrivalTu: num(g('arrival_tu')), status: g('status') || null, x: num(g('x')), y: num(g('y')), lastSeen: unIso(g('last_seen')) || 0,
          firstSeen: unIso(g('first_seen')) || 0, lastSeenSession: +g('last_seen_session') || 0, detailAt: unIso(g('detail_at')) || 0, firstDetailAt: unIso(g('first_detail_at')) || 0 };
        let s = T.ships.get(id);
        if (!s) { s = Object.assign(blank(id), inc, { firstSeen: inc.firstSeen || inc.lastSeen || now(), stale: true }); s.snap = {}; for (const k of TRACKED) s.snap[k] = norm(s[k]); T.ships.set(id, s); res.ships_new++; }
        else if (inc.lastSeen > (s.lastSeen || 0)) { for (const [k, v] of Object.entries(inc)) if (v !== null && v !== '' && v !== 0) s[k] = v; res.ships_updated++; }
        else { let filled = false; for (const [k, v] of Object.entries(inc)) if ((s[k] === null || s[k] === '' || s[k] === undefined) && v !== null && v !== '') { s[k] = v; filled = true; }
          if (inc.firstSeen && inc.firstSeen < s.firstSeen) { s.firstSeen = inc.firstSeen; filled = true; } if (filled) res.ships_filled++; }
        if (g('flight_target') || g('capacity') !== '' || g('retiring') === '1') { const newer = !s.detail || (inc.detailAt && inc.detailAt >= (s.detailAt || 0));
          if (newer) s.detail = Object.assign({ logs: [], noFlight: !g('flight_target') }, s.detail || {}, { capacity: num(g('capacity')), usePct: num(g('use_pct')), retiring: g('retiring') === '1', flightNote: g('flight_note'),
            flight: g('flight_target') ? { target: g('flight_target'), distanceMiles: num(g('flight_distance')), sinceTu: inc.sinceTu, arrivalTu: inc.arrivalTu, docks: g('flight_docks') } : null }); }
        if (g('cargo_json') && (unIso(g('cargo_at')) || 0) >= (s.cargoAt || 0)) { try { s.cargoItems = JSON.parse(g('cargo_json')).map(([product, qty, unit, quality, productId]) => ({ product, qty: qty === '' ? null : +qty, unit, quality: quality === '' ? null : +quality, productId: productId || '' })); s.cargoAt = unIso(g('cargo_at')) || now(); } catch (x) { res.skipped++; } }
        if (g('logbook_json')) { let lb = []; try { lb = JSON.parse(g('logbook_json')); } catch (x) { res.skipped++; }
          const at0 = unIso(g('detail_at')) || now(); res.logbook_lines_new += recordLogbook(s, lb.map(([when, text]) => ({ when, text })).reverse(), { quiet: true, at: at0 }); }
        T.dirty.add(id);
      }
      evs.sort((a, b) => a.t - b.t);
      for (const e of evs) { addEv(e); T.pendingEvents.push(e); }
      T.events.sort((a, b) => a.t - b.t); trimEvents(true);
      await T.flush(); dbg.script('info', 'CSV import merged', res); emit();
      return res;
    };
    T.emit = emit;
    return T;
  }
  /* ===================================================================
   * 0.2.8.0 TRIGGER API (basic, extensible). Persisted in the db meta store under 'triggers' (survives sessions).
   *
   *   const T = createTriggers({ db, now, tuSeconds, gameDayTu, onLog });
   *   await T.load();
   *   T.registerConditionType(name, { label, available, next(trigger, ctx) -> ms timestamp | null, due?(trigger, ctx) -> bool });
   *   T.registerTrigger({ id?, name, condition: { type, every, unit }, action: { kind, ... }, enabled }) -> trigger (saved)
   *   T.evaluate(ctx?) -> triggers that are due now (enabled, condition met)
   *   T.markRun(id, outcome)   -> lastRun = now, nextDue = next period (from now)
   *   T.skip(id)               -> no run, nextDue = next period from now
   *   T.overdue()              -> triggers whose nextDue had passed when the session started (see sessionStart)
   *   T.registerAction(kind, async (trigger) => outcome)   (the console registers 'transport')
   * Built-in condition types:
   *   time-real : every N minutes | hours | days (real time)
   *   time-game : every N tu | game-days. Real length = N * tuSeconds (Settings "seconds per tu", approximate);
   *               a game day = gameDayTu tu (default 24; UNVERIFIED, adjustable).
   * Hooks for later (registered, not available yet, never fire): stock-below, stock-above, quality-below, usage-months-below.
   * Never auto-runs overdue triggers on session start: sessionStart() only collects them; the UI must ask the user.
   * =================================================================== */
  function createTriggers(o) {
    const now = o.now || (() => Date.now()), log = o.onLog || (() => {});
    const X = { list: [], types: new Map(), actions: new Map(), overdueAtStart: [] };
    const REAL = { minutes: 60000, hours: 3600000, days: 86400000 };
    X.registerConditionType = (name, def) => { X.types.set(name, Object.assign({ available: true, label: name }, def)); };
    X.registerAction = (kind, fn) => { X.actions.set(kind, fn); };
    X.periodMs = c => { if (!c) return null; const n = Math.max(0, +c.every || 0); if (!n) return null;
      if (c.type === 'time-real') return REAL[c.unit] ? n * REAL[c.unit] : null;
      if (c.type === 'time-game') { const tu = (typeof o.tuSeconds === 'function' ? o.tuSeconds() : o.tuSeconds) || 4, day = (typeof o.gameDayTu === 'function' ? o.gameDayTu() : o.gameDayTu) || 24;
        return c.unit === 'tu' ? n * tu * 1000 : c.unit === 'game-days' ? n * day * tu * 1000 : null; }
      return null; };
    X.registerConditionType('time-real', { label: 'real time', next: (t, ctx) => { const p = X.periodMs(t.condition); return p ? (ctx.from || now()) + p : null; } });
    X.registerConditionType('time-game', { label: 'game time', next: (t, ctx) => { const p = X.periodMs(t.condition); return p ? (ctx.from || now()) + p : null; } });
    for (const h of ['stock-below', 'stock-above', 'quality-below', 'usage-months-below'])
      X.registerConditionType(h, { label: h + ' (planned)', available: false, next: () => null, due: () => false });
    const save = async () => { if (o.db) await o.db.setMeta('triggers', X.list); };
    X.load = async () => { X.list = (o.db ? await o.db.getMeta('triggers', []) : []) || []; return X.list; };
    X.sessionStart = async () => { await X.load(); const t = now(); X.overdueAtStart = X.list.filter(x => x.enabled && x.nextDue != null && x.nextDue <= t && (X.types.get(x.condition.type) || {}).available !== false); return X.overdueAtStart.slice(); };
    X.registerTrigger = async def => {
      const ty = X.types.get(def.condition && def.condition.type); if (!ty) throw new Error('unknown condition type ' + (def.condition && def.condition.type));
      const t = Object.assign({ id: 'tr' + now().toString(36) + Math.random().toString(36).slice(2, 6), enabled: true, created: now(), lastRun: null, lastOutcome: '' }, def);
      if (t.nextDue == null) t.nextDue = ty.available === false ? null : ty.next(t, { from: now() });
      const i = X.list.findIndex(x => x.id === t.id); if (i >= 0) X.list[i] = t; else X.list.push(t); await save(); log('info', `trigger saved: ${t.name || t.id} (${t.condition.type} every ${t.condition.every} ${t.condition.unit || ''}), next ${t.nextDue ? new Date(t.nextDue).toISOString() : '-'}`); return t; };
    X.remove = async id => { X.list = X.list.filter(x => x.id !== id); await save(); };
    X.setEnabled = async (id, on) => { const t = X.list.find(x => x.id === id); if (!t) return; t.enabled = !!on; if (on && (t.nextDue == null || t.nextDue < now())) t.nextDue = X.types.get(t.condition.type).next(t, { from: now() }); await save(); };
    X.evaluate = (ctx) => { const t = now(); ctx = ctx || {};
      return X.list.filter(x => { if (!x.enabled) return false; const ty = X.types.get(x.condition.type); if (!ty || ty.available === false) return false;
        if (ty.due) return !!ty.due(x, Object.assign({ now: t }, ctx)); return x.nextDue != null && x.nextDue <= t; }); };
    X.markRun = async (id, outcome) => { const t = X.list.find(x => x.id === id); if (!t) return; t.lastRun = now(); t.lastOutcome = String(outcome || ''); t.nextDue = X.types.get(t.condition.type).next(t, { from: now() }); await save(); };
    X.skip = async id => { const t = X.list.find(x => x.id === id); if (!t) return; t.lastOutcome = 'skipped ' + new Date(now()).toISOString(); t.nextDue = X.types.get(t.condition.type).next(t, { from: now() }); await save(); };
    X.run = async t => { const fn = X.actions.get(t.action && t.action.kind); if (!fn) { await X.markRun(t.id, 'no action handler'); return 'no action handler'; }
      let out; try { out = await fn(t); } catch (e) { out = 'failed: ' + e.message; } await X.markRun(t.id, out); log('info', `trigger ran: ${t.name || t.id}: ${out}`); return out; };
    return X;
  }
  /* ===================================================================
   * SESSION: detect expiry (login-only reads answer with the portal sign-in page),
   * keepalive read, and pick up a new sign-in from other tabs without closing anything.
   * =================================================================== */
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  function readPortalCookieHash(doc) { // value is hashed immediately; never stored or logged
    const m = /(?:^|;\s*)ckLoginPassport=([^;]*)/.exec(doc.cookie || ''); return m && m[1] ? hashStr(m[1]) : '';
  }
  function createSession(o) {
    const S = { state: 'unknown', since: Date.now(), lastProbe: 0, listeners: new Set(), cookieHash: null, timers: [] };
    const dbg = o.dbg;
    S.subscribe = f => { S.listeners.add(f); return () => S.listeners.delete(f); };
    S.set = (state, why) => {
      if (state === S.state) return; dbg.script(state === 'expired' ? 'warn' : 'info', `session: ${S.state} -> ${state} (${why})`);
      S.state = state; S.since = Date.now(); for (const f of S.listeners) { try { f(state); } catch (e) { /* */ } }
    };
    S.probe = async why => {
      S.lastProbe = Date.now();
      try { const html = await o.client.request('gxGetTransportOrigins', {}, { channel: 'session', priority: 2, retries: 1 }).promise; S.set('ok', why || 'probe'); return html; }
      catch (e) { if (e.name === 'SessionExpiredError') S.set('expired', why || 'probe'); else if (e.name !== 'StaleResponseError') dbg.script('warn', 'session probe failed: ' + e.message); return null; }
    };
    S.start = () => {
      S.cookieHash = o.cookieHash();
      S.timers.push(setInterval(() => {
        const h = o.cookieHash();
        if (h !== S.cookieHash) { S.cookieHash = h; dbg.script('info', 'portal cookie changed (' + (h ? 'signed-in value' : 'empty') + '), re-checking session'); S.probe('cookie change'); }
      }, CADENCE.COOKIE_WATCH_MS));
      S.timers.push(setInterval(async () => { if (S.state !== 'ok') return; const okSince = S.since; const r = await S.probe('keepalive');
        dbg.script('info', `keepalive: ${r ? 'still signed in' : 'NOT signed in'} (signed in since ${new Date(okSince).toLocaleTimeString()}, ${Math.round((Date.now() - okSince) / 60000)} min)`); }, CADENCE.SESSION_KEEPALIVE_MS));
      if (o.channel) { S.onMsg = ev => { if (ev && ev.data && ev.data.type === 'gxp-signin') S.probe('sign-in seen in another tab'); }; o.channel.addEventListener('message', S.onMsg); }
      S.onStorage = ev => { if (ev.key === 'gxp.signin') S.probe('sign-in seen in another tab (storage)'); };
      o.win.addEventListener('storage', S.onStorage);
      S.probe('startup');
    };
    S.stop = () => { for (const t of S.timers) clearInterval(t); S.timers = []; if (o.channel && S.onMsg) o.channel.removeEventListener('message', S.onMsg); o.win.removeEventListener('storage', S.onStorage); };
    return S;
  }

  /* ===================================================================
   * TRANSPORT QUEUE: pickers, local queue, validation, gated sequential submit
   * =================================================================== */
  const KIND = { UNKNOWN: 0, SPACE: 1, CENTER: 2, STATION: 3, DOCK: 4, DEPOT: 5 }; // GSVlocation* (gxscript l.50073)
  const isCenterKind = k => +k === KIND.CENTER || +k === KIND.DEPOT;
  /** Products request exactly as observed live:
   *  gxGetTransportProducts&miSrcWorldID=4&miSrcEntityKind=e&miSrcEntityID=19144&miSrcTargetKind=2&miSrcTargetID=747922&miSrcStationID=0&miDstTargetKind=2 */
  function originParams(o, dstKind) {
    const c = isCenterKind(o.kind);
    return { miSrcWorldID: c ? o.world : '0', miSrcEntityKind: c ? o.entityKind : '', miSrcEntityID: c ? o.entityId : '', miSrcTargetKind: String(o.kind),
      miSrcTargetID: c ? o.target : '', miSrcStationID: c ? '0' : o.stationId, miDstTargetKind: String(dstKind) };
  }
  /** Positional picker args -> form fields, exactly as gxSelTransportOrigin/Target/Product set them (gxscript l.52375-52620):
   *  gxSelTransportOrigin(kind, name, gssID, gscWorld, gscEntityKind, gscEntityID, gscTarget)
   *    miOrigin=name, miSrcTargetKind=kind; center/depot: miSrcWorldID=gscWorld, miSrcEntityKind, miSrcEntityID, miSrcTargetID=gscTarget, miSrcStationID=0;
   *    station: miSrcWorldID=0, miSrcStationID=gssID (entity fields untouched = empty in a fresh form). Same for Target -> miTarget/miDst*.
   *  gxSelTransportProduct(img, productId, name, max): miProductName=name, miProduct=productId, miQuantity=max (user may lower it). */
  function transportValues(item) {
    const v = { miOrigin: item.origin.name, miTarget: item.target.name, miProductName: item.product.name, miProduct: String(item.product.product), miQuantity: String(item.quantity) };
    const side = (p, o) => {
      v[p + 'TargetKind'] = String(o.kind);
      if (isCenterKind(o.kind)) Object.assign(v, { [p + 'WorldID']: String(o.world), [p + 'EntityKind']: String(o.entityKind), [p + 'EntityID']: String(o.entityId), [p + 'TargetID']: String(o.target), [p + 'StationID']: '0' });
      else Object.assign(v, { [p + 'WorldID']: '0', [p + 'EntityKind']: '', [p + 'EntityID']: '', [p + 'TargetID']: '', [p + 'StationID']: String(o.stationId) });
    };
    side('miSrc', item.origin); side('miDst', item.target);
    return v;
  }
  /* ---------- diagnostics & route overview (pure, testable) ---------- */
  const placeBase = n => String(n || '').toLowerCase().replace(/\s+on\s+\S+$/, '').trim();
  const toNameSet = me => me && typeof me.has === 'function' ? new Set([...me].map(x => String(x).trim().toLowerCase())) : new Set(me ? [String(me).trim().toLowerCase()] : []);
  const mineFilter = (ships, me) => { const set = toNameSet(me), all = [...ships]; return set.size ? all.filter(s => set.has(String(s.owner || '').trim().toLowerCase())) : all; };
  /** Why is a request still 'Waiting for shuttles'? Looks at the user's own shuttles. */
  function shipDiagnostics(ships, row, me) {
    const o = placeBase(row.origin), mine = mineFilter(ships, me);
    const at = mine.filter(s => placeBase(s.location) === o && !s.destination), to = mine.filter(s => s.destination && placeBase(s.destination) === o);
    const idle = at.filter(s => s.status !== 'retired' && s.status !== 'flight'), retired = at.filter(s => s.status === 'retired'), enroute = to.filter(s => s.status !== 'retired');
    let hint;
    if (idle.length) hint = `${idle.length} idle shuttle(s) of yours at ${row.origin}. The game assigns shuttles on its own tick; if this stays stuck, check they are not reserved by another transport.`;
    else if (enroute.length) hint = `${enroute.length} shuttle(s) of yours on the way to ${row.origin}; the transport should start when one arrives.`;
    else if (retired.length) hint = `Only retired shuttles at ${row.origin} (${retired.length}). Retired shuttles cannot fly: buy new ones or bring active ones here.`;
    else hint = `None of your shuttles is at or heading to ${row.origin}. Bring an empty shuttle there or buy one ("Do you own enough space ships?").`;
    return { idle, enroute, retired: retired.length, hint, known: mine.length };
  }
  /** Per origin->target route: active requests and the user's shuttles serving it. */
  function routeOverview(ships, live, me) {
    const mine = mineFilter(ships, me), routes = new Map();
    const get = (o, t) => { const k = placeBase(o) + '→' + placeBase(t); if (!routes.has(k)) routes.set(k, { origin: o, target: t, requests: 0, waiting: 0, products: new Set(), loadedEnRoute: 0, emptyToOrigin: 0, idleAtOrigin: 0, retiredAtOrigin: 0 }); return routes.get(k); };
    for (const r of live) if (TR_STATUS[r.status].active) { const x = get(r.origin, r.target); x.requests++; if (r.status === 'waiting') x.waiting++; x.products.add(r.product); }
    for (const x of routes.values()) {
      const o = placeBase(x.origin), t = placeBase(x.target);
      for (const s of mine) {
        if (s.destination && placeBase(s.destination) === t && s.cargo > 0) x.loadedEnRoute++;
        else if (s.destination && placeBase(s.destination) === o && !(s.cargo > 0)) x.emptyToOrigin++;
        else if (!s.destination && placeBase(s.location) === o) { if (s.status === 'retired') x.retiredAtOrigin++; else x.idleAtOrigin++; }
      }
    }
    return [...routes.values()].map(x => Object.assign(x, { products: [...x.products] }));
  }

  /** Confirmation form returned by the server: re-post it as-is, with miActionConfirmed ticked/set (the user pressed Confirm). */
  function confirmTemplateFor(t) {
    return Object.assign({}, t, { fields: t.fields.map(f => f.name !== 'miActionConfirmed' ? f : (f.type === 'checkbox' || f.type === 'radio' ? Object.assign({}, f, { checked: true }) : Object.assign({}, f, { value: f.value && f.value !== '0' ? f.value : '1' }))) });
  }
  function createTransport(o) {
    const { client, dbg, db, tracker } = o;
    const X = { origins: [], targets: [], products: [], productsFor: null, queue: [], live: [], liveAt: 0, results: [], running: false, listeners: new Set() };
    X.subscribe = f => { X.listeners.add(f); return () => X.listeners.delete(f); };
    const emit = () => { for (const f of X.listeners) { try { f(); } catch (e) { /* */ } } };
    X.load = async () => { const q = []; await db.eachRecord('queue', r => { q.push(r); }); X.queue = q.sort((a, b) => a.at - b.at); X.results = await db.getMeta('transportResults', []); emit(); };
    const save = async () => { await db.clear('queue'); await db.putMany('queue', X.queue); await db.setMeta('transportResults', X.results.slice(-LIMITS.TRANSPORT_QUEUE_MAX * 5)); };
    X.loadOrigins = async () => { X.origins = parsePicker(await client.request('gxGetTransportOrigins', {}, { channel: 'origins', priority: 3 }).promise, 'gxSelTransportOrigin'); emit(); return X.origins; };
    X.loadTargets = async () => { X.targets = parsePicker(await client.request('gxGetTransportTargets', {}, { channel: 'targets', priority: 3 }).promise, 'gxSelTransportTarget'); emit(); return X.targets; };
    X.loadProducts = async (origin, target) => {
      const html = await client.request('gxGetTransportProducts', originParams(origin, target.kind), { channel: 'products', priority: 3 }).promise;
      X.products = parsePicker(html, 'gxSelTransportProduct'); X.productsFor = routeKey('', origin.name, target.name); emit(); return X.products;
    };
    /** Live form template = what the original modal holds (gxNewTransportRequest). Logged in full (types, defaults) for analysis. */
    X.loadTemplate = async () => {
      const html = await client.request('gxNewTransportRequest', {}, { channel: 'newform', priority: 2, retries: 0 }).promise;
      const t = parseFormTemplate(html);
      if (!t) { dbg.script('warn', 'form template: no gx_transport form in gxNewTransportRequest answer', { response: html }); X.template = null; emit(); return null; }
      const names = t.fields.map(f => f.name), missing = TRANSPORT_FIELDS.filter(n => names.indexOf(n) < 0), extra = names.filter(n => n.indexOf('mi') >= 0 && TRANSPORT_FIELDS.indexOf(n) < 0);
      X.template = t; X.formCheck = { names, missing, extra, at: t.at };
      dbg.script(missing.length ? 'warn' : 'info', `form template: ${names.length} fields, submit=${t.method}; missing vs code: [${missing}]; extra (sent as the form has them): [${extra.map(n => { const f = t.fields.find(x => x.name === n); return `${n} ${f.type}=${JSON.stringify(f.value)}${f.type === 'checkbox' ? (f.checked ? ' checked' : ' unchecked') : ''}`; })}]`, { fields: t.fields });
      emit(); return t;
    };
    X.checkForm = () => X.loadTemplate().catch(e => dbg.script('debug', 'form template skipped: ' + e.message));
    X.loadInfo = async id => parseTransportInfo(await client.request('gxTransportInfo', { miKey: id }, { channel: 'trinfo', priority: 2 }).promise);
    X.readLive = async () => {
      const r = parseTransportList(await client.request('gxTransportRequests', {}, { channel: 'transports', priority: 2 }).promise);
      if (r.expired) throw new SessionExpiredError(); X.live = r.rows; X.liveAt = Date.now(); emit(); return r.rows;
    };
    X.estimate = (productName, qty) => {
      const c = tracker.capacity.get(productName);
      if (!c || !c.qty || !qty) return { flights: null, basis: 'unknown: no shuttle has been seen carrying ' + productName + ' yet' };
      return { flights: Math.ceil(qty / c.qty), basis: `≈ ${c.qty.toLocaleString('en-US')} ${c.unit || ''} per flight (largest load seen)` };
    };
    /** 0.2.8.0: amount of a product at an origin still reserved by ACTIVE live requests (requested minus already loaded).
     *  Assumption (unverified): the picker's stock does not already subtract scheduled amounts. */
    X.reserved = (originName, productName) => X.live.filter(r => (TR_STATUS[r.status] ? TR_STATUS[r.status].active : true) && normName(r.origin) === normName(originName) && normName(r.product) === normName(productName))
      .reduce((a, r) => a + Math.max(0, (+r.quantity || 0) - (+r.loaded || 0)), 0);
    X.available = (origin, product) => product.stock == null ? null : Math.max(0, product.stock - X.reserved(origin.name, product.name));
    X.validate = () => {
      const seen = new Map(), draw = new Map();
      for (const it of X.queue) {
        if (['submitted', 'skipped-duplicate'].indexOf(it.status) >= 0) continue;
        it.issues = [];
        const k = routeKey(it.product.name, it.origin.name, it.target.name);
        if (!(it.quantity > 0) || Math.floor(it.quantity) !== it.quantity) it.issues.push('quantity must be a whole number above 0');
        const avail = X.available(it.origin, it.product), resv = X.reserved(it.origin.name, it.product.name);
        if (avail != null && it.quantity > avail) it.issues.push(`only ${avail.toLocaleString('en-US')} available (${it.product.stock.toLocaleString('en-US')} in stock${resv ? ', ' + resv.toLocaleString('en-US') + ' already scheduled' : ''})`);
        if (routeKey('', it.origin.name, '') === routeKey('', it.target.name, '')) it.issues.push('origin and target are the same');
        if (seen.has(k)) it.issues.push('duplicate of another queued request (one request per product per route)'); else seen.set(k, it.qid);
        const dk = it.origin.name + '|' + it.product.name; draw.set(dk, (draw.get(dk) || 0) + it.quantity);
        if (avail != null && draw.get(dk) > avail) it.issues.push('queued total for this product at this origin exceeds what is available');
        it.status = it.issues.length ? 'invalid' : 'valid';
      }
      emit();
    };
    X.add = async (origin, target, product, quantity) => {
      if (X.queue.length >= LIMITS.TRANSPORT_QUEUE_MAX) throw new Error('queue is full (' + LIMITS.TRANSPORT_QUEUE_MAX + ')');
      const av = X.available(origin, product); if (av === 0) throw new Error(`nothing left to send: ${product.name} at ${origin.name} is fully scheduled`);
      const q = Math.max(1, Math.min(Math.floor(+quantity || 0), av == null ? Infinity : av));
      const it = { qid: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), origin, target, product, quantity: q, status: 'draft', issues: [], message: '' };
      X.queue.push(it); X.validate(); await save(); dbg.script('info', `queued transport: ${q} ${product.name} ${origin.name} -> ${target.name}`); return it;
    };
    /* 3.0.6: removal updates memory and notifies synchronously (UI redraws at once); persistence follows. */
    X.remove = async qid => { const n = X.queue.length; X.queue = X.queue.filter(i => i.qid !== qid); if (X.queue.length !== n) dbg.script('info', 'queue item removed: ' + qid); X.validate(); emit(); await save(); };
    X.isDone = i => ['submitted', 'skipped-duplicate'].indexOf(i.status) >= 0;
    X.clearDone = async () => { X.queue = X.queue.filter(i => !X.isDone(i)); emit(); await save(); };
    /* 3.0.6: finished items leave the queue shortly after the send completes (results stay in the Results log). */
    X.autoClearMs = 3000; let acT = null;
    const scheduleAutoClear = () => { if (acT) clearTimeout(acT); if (!X.queue.some(X.isDone) || !(X.autoClearMs >= 0)) return; acT = setTimeout(() => { acT = null; if (!X.running) X.clearDone(); else scheduleAutoClear(); }, X.autoClearMs); };
    X.preview = it => buildWriteUrl('gxAddTransportRequest', transportValues(it), it.confirmTemplate || X.template);
    /** The server answered with a confirmation form: the user confirms explicitly; the item is re-sent only by the next user-pressed Submit all. */
    X.confirmItem = async qid => { const it = X.queue.find(i => i.qid === qid); if (!it || it.status !== 'needs-confirm') return; it.status = 'valid'; it.confirmed = true; it.message = 'confirmed by you: will be re-sent with the confirmation form on the next Submit all'; await save(); emit(); };
    /** Sequential submit. Re-reads the live list before each item. Never retries a write. */
    X.submitAll = async only => { // 0.2.8.0: optional list of qids (Execute now / recurring)
      if (X.running) return;
      try { await X.loadTemplate(); } catch (e) { throw new Error('could not load the live transport form: ' + e.message); } // fresh template per run
      const gate = writeGate(o.settings(), X.template);
      if (!gate.ok) throw new ForbiddenRequestError(gate.why);
      X.running = true; emit(); const log = (it, outcome, msg) => { it.message = msg || ''; X.results.push({ t: Date.now(), qid: it.qid, product: it.product.name, quantity: it.quantity, origin: it.origin.name, target: it.target.name, outcome, message: it.message }); dbg.script(outcome === 'submitted' ? 'info' : 'warn', `transport ${outcome}: ${it.quantity} ${it.product.name} ${it.origin.name} -> ${it.target.name} ${msg || ''}`); };
      try {
        for (const it of X.queue) {
          if (it.status !== 'valid' || (only && only.indexOf(it.qid) < 0)) continue;
          const k = routeKey(it.product.name, it.origin.name, it.target.name);
          let live;
          try { live = await X.readLive(); } catch (e) { it.status = 'failed'; log(it, 'failed', 'could not re-read transport list: ' + e.message); if (o.settings().stopOnError) break; else continue; }
          const before = live.filter(r => routeKey(r.product, r.origin, r.target) === k && TR_STATUS[r.status].active).length; // 0.2.8.0: a second request on a live route is allowed (the game decides)
          it.status = 'submitting'; emit();
          let body;
          const tpl = it.confirmed && it.confirmTemplate ? confirmTemplateFor(it.confirmTemplate) : X.template;
          try { body = await client.write('gxAddTransportRequest', transportValues(it), tpl, writeGate(o.settings(), tpl)); }
          catch (e) { if (e.name === 'DryRunError') { it.status = 'dry-run'; log(it, 'dry-run', e.message); emit(); continue; } it.status = 'failed'; log(it, 'failed', e.name === 'SessionExpiredError' ? 'session expired: sign in again in another tab, then resume' : e.name === 'TimeoutError' ? 'no answer within 30 s: outcome UNKNOWN, check the transport list before resubmitting' : e.message); if (o.settings().stopOnError || e.name === 'TimeoutError') break; else continue; }
          // Success = popup returns to the transport list with the new row (no message). Always confirmed by a fresh re-read.
          X.lastResponse = { t: Date.now(), qid: it.qid, body };
          const msg = parseGameMessage(body), cls = classifyWriteMessage(msg);
          if (!it.confirmed && isConfirmationPage(body) && cls !== 'duplicate') {
            it.confirmTemplate = parseFormTemplate(body); it.status = 'needs-confirm';
            log(it, 'confirmation-required', (msg || parseDoc(body).body.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)) + ' — press "Confirm" on this item, then Submit all again.'); emit(); continue;
          }
          let after = []; try { after = await X.readLive(); } catch (e) { after = parseTransportList(body).rows; }
          const present = after.filter(r => routeKey(r.product, r.origin, r.target) === k && TR_STATUS[r.status].active).length > before; if (!present) dbg.script('warn', 'after write: route not in re-read list', { key: k, live: after.map(r => routeKey(r.product, r.origin, r.target) + ' [' + r.status + ']') });
          if (cls === 'duplicate') { it.status = 'failed'; it.errorKind = 'duplicate'; log(it, 'rejected-duplicate', msg); if (o.settings().stopOnError) break; }
          else if (present && cls !== 'rejected') { it.status = 'submitted'; log(it, 'submitted', msg); }
          else { it.status = 'failed'; it.errorKind = cls === 'rejected' ? 'rejected' : 'unconfirmed'; log(it, 'failed', msg || 'no message, and the request did not appear in the re-read transport list'); if (o.settings().stopOnError) break; }
          emit();
        }
      } finally { X.running = false; await save(); emit(); scheduleAutoClear(); }
    };
    /* ---------- cancel (second gated write) ---------- */
    X.cancelGate = () => o.settings().writesEnabled ? { ok: true, why: 'cancel flow from gxDelTransportRequest/gxTransportForm code' } : { ok: false, why: 'Writes are OFF (Settings).' };
    X.cancelResults = [];
    const isCancelable = r => r && r.cancelable && TR_STATUS[r.status].active;
    /* 3.0.4: own active transports may be cancelled even when the game shows no red X (already underway): the request is
     * sent once and the game's reply is shown verbatim. Finished / aborted rows are skipped. The batch always stops at the
     * first failure (user-approved design), whatever the general stop-on-error setting. */
    X.canTryCancel = r => !!(r && r.id && TR_STATUS[r.status] && TR_STATUS[r.status].active);
    const replyText = body => { try { const m = parseGameMessage(body); if (m) return m; return txt(parseDoc(body)).replace(/\s+/g, ' ').trim().slice(0, 400); } catch (e) { return ''; } };
    X.cancelSelected = async (ids, onItem) => {
      if (X.running) return; const gate = X.cancelGate(); if (!gate.ok) throw new ForbiddenRequestError(gate.why);
      X.running = true; emit(); const out = [];
      const done = (id, row, outcome, msg) => { const r = { t: Date.now(), id, product: row ? row.product : '', quantity: row ? row.quantity : null, origin: row ? row.origin : '', target: row ? row.target : '', outcome, message: msg || '' };
        out.push(r); X.cancelResults.push(r); X.results.push(Object.assign({ qid: 'cancel:' + id }, r)); dbg.script(outcome === 'cancelled' ? 'info' : 'warn', `cancel ${id} ${outcome}: ${msg || ''}`); if (outcome !== 'dry-run' && tracker.addTransportWriteEvent) tracker.addTransportWriteEvent(row, id, outcome, msg); if (onItem) onItem(r); emit(); return r; };
      try {
        for (const id of ids) {
          let live; try { live = await X.readLive(); } catch (e) { const r = done(id, null, 'failed', 'could not re-read transport list: ' + e.message); break; }
          const row = live.find(r => r.id === String(id));
          if (!row) { done(id, null, 'skipped-gone', 'no longer in the transport list'); continue; }
          if (!X.canTryCancel(row)) { done(id, row, 'skipped-not-cancelable', 'status is ' + row.statusLabel + ': nothing to cancel'); continue; }
          const underway = !isCancelable(row);
          let body, msg;
          try {
            const ck = row.cancelKey || row.id;
            body = await client.writeUrl('gxDelTransportRequest', cancelStep1Url(ck), X.cancelGate(), 'step 1: open confirmation');
            msg = replyText(body);
            const form = findSubmitForm(body, 'gxDelTransportRequest');
            if (form && !/^Sorry\./i.test(msg || '')) { // the game's modal asks "Abort this Transport?": the user already confirmed in our review dialog
              body = await client.writeUrl('gxDelTransportRequest', cancelStep2Url(confirmTemplateFor(form), ck), X.cancelGate(), 'step 2: confirm'); msg = replyText(body);
            }
          } catch (e) { if (e.name === 'DryRunError') { done(id, row, 'dry-run', e.message); continue; }
            if (e.name === 'ForbiddenRequestError' && client.onWrite) client.onWrite({ method: 'gxDelTransportRequest', note: 'blocked before sending (transport ' + id + ')', blocked: e.message, row }); done(id, row, 'failed', e.name === 'TimeoutError' ? 'no answer within 30 s: outcome UNKNOWN, check the list' : e.message); break; }
          let after = null; try { after = await X.readLive(); } catch (e) { after = null; }
          const now = after && after.find(r => r.id === String(id));
          if (after && (!now || now.status === 'aborted')) done(id, row, 'cancelled', msg || (now ? 'status now Aborted' : 'row gone from the list'));
          else { done(id, row, 'failed', (underway ? 'already underway; game replied: ' : '') + (msg || (after ? 'row still present as ' + now.statusLabel : 'could not re-read the list to confirm'))); break; }
        }
      } finally { X.running = false; await save(); emit(); }
      return out;
    };
    X.emit = emit;
    return X;
  }
  /* ===================================================================
   * UI HELPERS: escaping, formatting, virtual table, sort/filter
   * =================================================================== */
  /** 0.2.5: update a <select>'s options in place, only when the option set changed; never while it is focused/open; keeps the value.
   *  (0.2.4 compared innerHTML strings that never matched the browser's serialisation, so every refresh rebuilt the open dropdown.) */
  function syncOptions(sel, items, value) {
    if (!sel) return false; const doc = sel.ownerDocument;
    if (doc && doc.activeElement === sel) return false;
    const cur = [...sel.options].map(o => o.value + '\u0001' + o.textContent), want = items.map(([v, l]) => v + '\u0001' + l);
    if (cur.length === want.length && cur.every((x, i) => x === want[i])) { if (value != null && sel.value !== value && items.some(([v]) => v === value)) sel.value = value; return false; }
    const keep = value != null ? value : sel.value; sel.textContent = '';
    for (const [v, l] of items) { const o = doc.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
    sel.value = items.some(([v]) => v === keep) ? keep : (items[0] || [''])[0]; sel.dataset.gxpRebuilds = String((+sel.dataset.gxpRebuilds || 0) + 1); return true;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = n => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US'));
  const fmtDur = sec => { if (sec == null) return ''; sec = Math.round(sec); const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`; };
  const fmtTime = t => (t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
  function cmpVals(a, b, numeric) {
    const ea = a == null || a === '', eb = b == null || b === '';
    if (ea || eb) return ea === eb ? 0 : (ea ? 1 : -1);
    return numeric ? a - b : String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }
  function sortRows(rows, col, dir) {
    if (!col) return rows; const get = col.sortVal || (r => r[col.key]);
    return rows.slice().sort((a, b) => { const va = get(a), vb = get(b); const ea = va == null || va === '', eb = vb == null || vb === '';
      if (ea || eb) return ea === eb ? 0 : (ea ? 1 : -1); return cmpVals(va, vb, col.num) * dir; });
  }
  const textMatch = (q, vals) => !q || vals.some(v => String(v == null ? '' : v).toLowerCase().indexOf(q) >= 0);

  /** Virtual table: renders only the visible rows (+ overscan). One scroll container. */
  function VTable(doc, host, cols, o) {
    o = o || {}; const R = LIMITS.VTABLE_ROW_PX;
    const t = { cols, rows: [], sort: o.sort || { key: cols[0].key, dir: 1 }, onSort: o.onSort, selectedKey: null };
    host.classList.add('gxp-vt');
    /* 0.2.4 column widths: 'auto' = share of the visible width (from c.w %), clamped to [min, max] px, spare width goes to
     * name-like columns (c.grow); 'fixed' = user widths (drag the header edge), persisted per table in localStorage.
     * If the columns need more than the visible width, the table scrolls horizontally instead of squashing. */
    for (const c of cols) { c.weight = parseFloat(c.w) || 10; if (c.min == null) c.min = c.num ? 48 : 70; if (c.max == null) c.max = c.num ? 130 : (c.grow ? 2000 : 320); }
    const LSK = o.id ? 'gxp.cols.' + o.id : null; let lay = { mode: 'auto', w: {}, hidden: [] };
    try { if (LSK) lay = Object.assign(lay, JSON.parse(W.localStorage.getItem(LSK) || '{}')); } catch (e) { /* */ }
    /* 3.1.3: the sort column / direction is persisted with the layout (lay.sort) */
    if (lay.sort && lay.sort.key && cols.some(c => c.key === lay.sort.key)) t.sort = { key: lay.sort.key, dir: lay.sort.dir < 0 ? -1 : 1 };
    const saveLay = () => { try { if (LSK) W.localStorage.setItem(LSK, JSON.stringify(lay)); } catch (e) { /* */ } };
    if (!Array.isArray(lay.hidden)) lay.hidden = [];
    const hid = k => lay.hidden.indexOf(k) >= 0;
    const colg = cols.map(c => `<col data-c="${c.key}">`).join('');
    host.innerHTML = `<div class="gxp-vt-hw"><table class="gxp-vt-h"><colgroup>${colg}</colgroup><thead><tr class="gxpu_rc0">${cols.map(c => `<th class="gxpu_datarowheader" tabindex="0" data-key="${c.key}" title="${esc(c.tip || c.label)}: click to sort (again to reverse); drag the right edge to resize"><span class="gxp-thl"></span><span class="gxp-rz" data-rz="${c.key}" title="Drag to resize (switches this table to fixed widths)"></span></th>`).join('')}</tr></thead></table></div>
      ${LSK ? '<span class="gxp-vt-colbtn" role="button" tabindex="0" title="Choose columns">&#8942;</span>' : ''}<div class="gxp-vt-s"><div class="gxp-vt-sp"><table class="gxp-vt-b"><colgroup>${colg}</colgroup><tbody></tbody></table></div><div class="gxp-vt-empty"></div></div>`;
    const hw = host.querySelector('.gxp-vt-hw'), head = host.querySelector('thead tr'), sc = host.querySelector('.gxp-vt-s'), sp = host.querySelector('.gxp-vt-sp'), tb = host.querySelector('tbody'), tbl = host.querySelector('.gxp-vt-b'), empty = host.querySelector('.gxp-vt-empty');
    const sortBy = k => { t.sort = t.sort.key === k ? { key: k, dir: -t.sort.dir } : { key: k, dir: 1 }; lay.sort = t.sort; saveLay(); if (t.onSort) t.onSort(t.sort); };
    t.resetSort = () => { delete lay.sort; saveLay(); t.sort = o.sort || { key: cols[0].key, dir: 1 }; if (t.onSort) t.onSort(t.sort); };
    let widths = {}, lastAvail = -1;
    function layout(force) {
      const avail = Math.max(0, sc.clientWidth || host.clientWidth || 0); if (!force && avail === lastAvail) return; lastAvail = avail;
      /* 3.0.5: shares are normalised over the VISIBLE columns (weights summing to more than 100 % made tables wider than the pane) */
      const wsum = cols.reduce((a, c) => a + (hid(c.key) ? 0 : c.weight), 0) || 100;
      const w = {}; for (const c of cols) w[c.key] = hid(c.key) ? 0 : Math.round(Math.max(c.min, Math.min(c.max, avail * c.weight / wsum)));
      if (lay.mode === 'fixed') { for (const c of cols) if (lay.w[c.key] && !hid(c.key)) w[c.key] = lay.w[c.key]; }
      else { let spare = avail - cols.reduce((a, c) => a + w[c.key], 0); if (spare > 0) { const vc = cols.filter(c => !hid(c.key)), g = vc.filter(c => c.grow).length ? vc.filter(c => c.grow) : vc.filter(c => !c.num).length ? vc.filter(c => !c.num) : vc; const tw = g.reduce((a, c) => a + c.weight, 0) || 1;
        for (const c of g) w[c.key] += Math.floor(spare * c.weight / tw); } }
      widths = w; const total = cols.reduce((a, c) => a + w[c.key], 0);
      for (const cg of host.querySelectorAll('col[data-c]')) cg.style.width = w[cg.dataset.c] + 'px';
      for (const tb of host.querySelectorAll('table')) tb.style.width = total + 'px';
      sp.style.width = total + 'px';
    }
    t.layout = layout; t.mode = () => lay.mode; t.widths = () => Object.assign({}, widths);
    t.setMode = m => { lay.mode = m === 'fixed' ? 'fixed' : 'auto'; if (lay.mode === 'fixed') for (const c of cols) if (!lay.w[c.key]) lay.w[c.key] = widths[c.key] || c.min; saveLay(); layout(true); draw(); };
    t.resetWidths = () => { lay = { mode: 'auto', w: {}, hidden: lay.hidden || [] }; saveLay(); layout(true); draw(); };
    /* 0.2.8.0 column chooser (persisted with the widths). Hidden columns get width 0 and empty cells, so the table structure stays intact. */
    t.hiddenCols = () => lay.hidden.slice();
    t.setHidden = keys => { lay.hidden = cols.map(c => c.key).filter(k => keys.indexOf(k) >= 0); if (lay.hidden.length >= cols.length) lay.hidden = lay.hidden.slice(1); saveLay(); layout(true); draw(); };
    const colBtn = host.querySelector('.gxp-vt-colbtn');
    const openColMenu = () => { let m = host.querySelector('.gxp-vt-colmenu'); if (m) { m.remove(); return; }
      m = doc.createElement('div'); m.className = 'gxp-vt-colmenu'; m.innerHTML = '<b>Columns</b>' + cols.map(c => `<label><input type="checkbox" data-colk="${esc(c.key)}" ${hid(c.key) ? '' : 'checked'}> ${esc(c.label || c.key)}</label>`).join('') + '<span class="gxbutton gxp-btn" data-colclose role="button" tabindex="0">Close</span>';
      host.appendChild(m);
      m.addEventListener('change', e => { const k = e.target.dataset.colk; if (!k) return; const h = lay.hidden.filter(x => x !== k); if (!e.target.checked) h.push(k); t.setHidden(h); for (const cb of m.querySelectorAll('[data-colk]')) cb.checked = !hid(cb.dataset.colk); });
      m.querySelector('[data-colclose]').addEventListener('click', () => m.remove()); };
    if (colBtn) { colBtn.addEventListener('click', openColMenu); colBtn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openColMenu(); } }); }
    t.openColumnMenu = openColMenu;
    t.setWidth = (k, px) => { if (lay.mode !== 'fixed') { lay.mode = 'fixed'; for (const c of cols) lay.w[c.key] = widths[c.key] || c.min; } lay.w[k] = Math.max(30, Math.round(px)); saveLay(); layout(true); if (o.onLayout) o.onLayout(lay.mode); };
    const onRz = e => { const h = e.target.closest('[data-rz]'); if (!h) return; e.preventDefault(); e.stopPropagation(); const k = h.dataset.rz, x0 = e.clientX, w0 = widths[k] || 80;
      const mv = ev => t.setWidth(k, w0 + ev.clientX - x0); const up = () => { W.removeEventListener('pointermove', mv); W.removeEventListener('pointerup', up); };
      W.addEventListener('pointermove', mv); W.addEventListener('pointerup', up); };
    const onHeadClick = e => { if (e.target.closest('[data-rz]')) return; const th = e.target.closest('th'); if (th) sortBy(th.dataset.key); };
    const onHeadKey = e => { const th = e.target.closest('th'); if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(th.dataset.key); } };
    /* 0.2.8.0 click fix. Root cause: draw() replaces the tbody HTML on every refresh. When that happens between mousedown
     * and mouseup, the pressed <tr> is detached, the browser has no common target and fires NO click, so the first click is
     * lost. Rows are now selected on pointerdown (mouse/pen), a click only acts when pointerdown did not already, touch
     * keeps click semantics but remembers the pressed key, and draw() skips identical re-renders. */
    let pressed = null;
    const onDown = e => { if (e.button !== 0 || !o.onRowClick) return; const tr = e.target.closest('tr[data-k]'); if (!tr || e.target.closest('input,select,textarea,a,label,button')) return;
      if (e.pointerType === 'touch') { pressed = { k: tr.dataset.k, t: Date.now(), done: false }; return; }
      pressed = { k: tr.dataset.k, t: Date.now(), done: true }; o.onRowClick(tr.dataset.k, e); };
    const onClick = e => { if (!o.onRowClick) return; const tr = e.target.closest && e.target.closest('tr[data-k]'); const k = tr ? tr.dataset.k : (pressed && Date.now() - pressed.t < 1500 ? pressed.k : null);
      if (!k) return; if (pressed && pressed.done && pressed.k === k && Date.now() - pressed.t < 1500) { pressed = null; return; } pressed = null; o.onRowClick(k, e); };
    const onKey = e => { const tr = e.target.closest('tr[data-k]'); if (!tr) return;
      if (e.key === 'Enter' && o.onRowClick) o.onRowClick(tr.dataset.k, e);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const i = +tr.dataset.i + (e.key === 'ArrowDown' ? 1 : -1); t.scrollToIndex(i); requestAnimationFrame(() => { const n = tb.querySelector(`tr[data-i="${i}"]`); if (n) n.focus(); }); } };
    let raf = 0; const onScroll = () => { hw.scrollLeft = sc.scrollLeft; if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const onResize = () => { layout(); }; W.addEventListener('resize', onResize);
    let ro = null; try { if (W.ResizeObserver) { ro = new W.ResizeObserver(() => layout()); ro.observe(sc); } } catch (e) { /* */ }
    head.addEventListener('pointerdown', onRz); head.addEventListener('click', onHeadClick); head.addEventListener('keydown', onHeadKey); tb.addEventListener('pointerdown', onDown); tb.addEventListener('click', onClick); sp.addEventListener('click', e => { if (e.target === sp || e.target === tbl || e.target === tb) onClick(e); }); tb.addEventListener('keydown', onKey); sc.addEventListener('scroll', onScroll);
    let lastHtml = null;
    function draw() {
      for (const th of head.children) { const c = cols.find(x => x.key === th.dataset.key), on = t.sort.key === c.key;
        th.classList.toggle('gxp-hidc', hid(c.key)); th.firstChild.textContent = c.label + (on ? (t.sort.dir > 0 ? ' \u25B2' : ' \u25BC') : ''); th.setAttribute('aria-sort', on ? (t.sort.dir > 0 ? 'ascending' : 'descending') : 'none'); }
      layout(); const n = t.rows.length; sp.style.height = (n * R) + 'px';
      empty.style.display = n ? 'none' : 'block'; empty.innerHTML = n ? '' : (o.emptyHtml ? o.emptyHtml() : 'Nothing to show.');
      const first = Math.max(0, Math.floor(sc.scrollTop / R) - LIMITS.VTABLE_OVERSCAN), last = Math.min(n, Math.ceil((sc.scrollTop + sc.clientHeight) / R) + LIMITS.VTABLE_OVERSCAN);
      tbl.style.transform = `translateY(${first * R}px)`;
      const focusK = doc.activeElement && doc.activeElement.dataset && doc.activeElement.dataset.k;
      let h = '';
      /* 3.0.2: one broken cell must not stop the whole table from redrawing */
      const cellHtml = (c, r) => { try { return c.html ? c.html(r) : esc(r[c.key]); } catch (e) { if (!cellHtml.warned) { cellHtml.warned = 1; try { console.warn('cell ' + c.key + ': ' + e.message); } catch (x) { /* */ } } return ''; } };
      for (let i = first; i < last; i++) { const r = t.rows[i], k = o.rowKey(r);
        h += `<tr data-k="${esc(k)}" data-i="${i}" tabindex="0" class="gxpu_rc${i % 2}${k === t.selectedKey ? ' sel' : ''}${o.rowClass ? ' ' + o.rowClass(r) : ''}" style="height:${R}px">` +
          cols.map(c => hid(c.key) ? '<td class="gxp-hidc"></td>' : `<td class="gxpu_data${c.num ? ' n' : ''}" title="${esc(c.title ? c.title(r) : '')}">${cellHtml(c, r)}</td>`).join('') + '</tr>'; }
      if (h === lastHtml && tb.childElementCount) return; lastHtml = h; tb.innerHTML = h;
      if (focusK) { const f = tb.querySelector(`tr[data-k="${(W.CSS && W.CSS.escape ? W.CSS.escape(focusK) : String(focusK).replace(/["\\]/g, '\\$&'))}"]`); if (f) f.focus({ preventScroll: true }); }
    }
    t.setRows = rows => { t.rows = rows; draw(); };
    t.redraw = draw;
    t.renderedCount = () => tb.children.length;
    t.scrollToIndex = i => { if (i < 0 || i >= t.rows.length) return; const top = i * R; if (top < sc.scrollTop || top + R > sc.scrollTop + sc.clientHeight) sc.scrollTop = top - sc.clientHeight / 2; draw(); };
    t.scrollToKey = k => { const i = t.rows.findIndex(r => o.rowKey(r) === k); t.scrollToIndex(i); };
    t.destroy = () => { W.removeEventListener('resize', onResize); if (ro) ro.disconnect(); head.removeEventListener('pointerdown', onRz); head.removeEventListener('click', onHeadClick); head.removeEventListener('keydown', onHeadKey); tb.removeEventListener('pointerdown', onDown); tb.removeEventListener('click', onClick); tb.removeEventListener('keydown', onKey); sc.removeEventListener('scroll', onScroll); host.innerHTML = ''; };
    return t;
  }
  /** Clipboard: async Clipboard API -> GM_setClipboard (if the manager provides it) -> hidden textarea + execCommand. Returns the method used or ''. */
  async function copyText(doc, text) {
    try { if (W.navigator.clipboard && W.navigator.clipboard.writeText) { await W.navigator.clipboard.writeText(text); return 'clipboard'; } } catch (e) { /* fall through */ }
    try { if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return 'GM_setClipboard'; } } catch (e) { /* */ } // eslint-disable-line no-undef
    try { const ta = doc.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; doc.body.appendChild(ta); ta.select(); const ok = doc.execCommand && doc.execCommand('copy'); ta.remove(); if (ok) return 'execCommand'; } catch (e) { /* */ }
    return '';
  }
  /** Download text as a file; the object URL is revoked right after use. */
  /** 3.1.0: download from a list of Blob parts / strings (streamed exports) without joining them into one string. */
  function downloadParts(doc, name, parts, mime) {
    const url = URL.createObjectURL(new Blob(parts, { type: mime || 'text/plain;charset=utf-8' }));
    const a = doc.createElement('a'); a.href = url; a.download = name; doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function downloadText(doc, name, text, mime) {
    const url = URL.createObjectURL(new Blob(Array.isArray(text) ? text : [text], { /* 3.1.5: parts (streamed chunks) accepted */ type: mime || 'text/plain;charset=utf-8' }));
    const a = doc.createElement('a'); a.href = url; a.download = name; doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const CSS_TEXT = `
    html,body{height:100%;margin:0;overflow:hidden}
    #gxp-app{position:fixed;inset:0;display:flex;flex-direction:column;font:10pt arial,helvetica,sans-serif;color:#000;background:#000 url(${IMG}gxn0.jpg)}
    #gxp-head{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:4px 8px;border-bottom:1px solid gold}
    #gxp-head .gxpu_h{padding:2px 10px}
    #gxp-status{flex:1 1 200px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gxp-badge{padding:1px 6px;border:1px solid #59624f;border-radius:3px;background:#ceceb5;white-space:nowrap}
    .gxp-badge.bad{background:#f3c0b0}.gxp-badge.ok{background:#cfe8c0}
    #gxp-main{flex:1 1 auto;display:flex;min-height:0}
    .gxp-pane{display:flex;flex-direction:column;min-width:0;min-height:0;background:#949a8c}
    #gxp-left{flex:0 0 60%}
    #gxp-tabs{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:2px;padding:4px 4px 0;background:#59624f}
    #gxp-tabs [role=tab]{padding:3px 10px;cursor:pointer;background:#949a8c;border:1px solid #59624f;border-bottom:none}
    #gxp-tabs [role=tab][aria-selected=true]{background:#ceceb5;font-weight:bold}
    .gxp-tabpanel{flex:1 1 auto;display:none;flex-direction:column;min-height:0}
    .gxp-tabpanel.on{display:flex}
    .gxp-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:4px 8px;padding:5px 6px;align-items:center;background:#ceceb5;border-bottom:1px solid #59624f}
    .gxp-bar input,.gxp-bar select,.gxp-bar button{font:10pt arial,sans-serif}
    .gxp-vt{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
    .gxp-vt table{table-layout:fixed;border-collapse:collapse}
    .gxp-vt-hw{flex:0 0 auto;overflow:hidden;padding-right:15px;background:#949a8c}
    .gxp-vt-h th{position:relative}
    .gxp-rz{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;border-right:1px solid #59624f}
    .gxp-rz:hover{background:#59624f}
    .gxp-vt-h th{background:#949a8c;cursor:pointer;text-align:left;padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gxp-vt-h th:focus,.gxp-vt tr:focus,[role=tab]:focus,.gxp-btn:focus{outline:2px solid #15c;outline-offset:-2px}
    .gxp-vt-h{flex:0 0 auto}
    .gxp-vt-s{flex:1 1 auto;overflow-y:scroll;overflow-x:auto;min-height:0;position:relative}
    .gxp-vt-sp{position:relative}
    .gxp-vt-b{position:absolute;top:0;left:0}
    .gxp-vt td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;box-sizing:border-box}
    .gxp-vt td.n{text-align:right}
    .gxp-vt tr.sel{background:#fff6c0 !important}
    .gxp-vt tr.stale td{color:#555;font-style:italic}
    .gxp-vt tr.retired td{color:#6b6b6b;background:#c4c4bc}
    .gxp-retired-chip,[data-chip]{cursor:pointer;text-decoration:underline dotted}
    .gxp-bar-pct{display:inline-block;width:36px;height:9px;border:1px solid #59624f;background:#e9e9dc;vertical-align:middle;margin-right:4px}
    .gxp-bar-pct>i{display:block;height:100%;background:#2f7d32}
    .gxp-st{font-weight:bold;white-space:nowrap}
    .gxp-host-fixed{height:260px;display:flex;flex-direction:column}
    .gxp-pn,.gxp-pn a,.gxp-pn a:link,.gxp-pn a:visited{color:#000!important;font-weight:bold}.gxp-pi{width:16px;height:16px;vertical-align:-3px;margin-right:4px;border:0}
    .gxp-hh-host{position:relative}.gxp-host-fixed>.gxp-vt,.gxp-tr-grid .gxp-host>.gxp-vt{flex:1 1 auto;min-height:0}.gxp-tr-grid .gxp-host{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}.gxp-hh{position:absolute;left:0;right:0;bottom:-5px;height:5px;cursor:row-resize;z-index:4;background:linear-gradient(transparent 2px,rgba(89,98,79,.18) 2px,rgba(89,98,79,.18) 3px,transparent 3px)}
    .gxp-hh:hover,.gxp-hh.on{background:linear-gradient(transparent 2px,rgba(89,98,79,.55) 2px,rgba(89,98,79,.55) 3px,transparent 3px)}
    .gxp-mini{width:100%;border-collapse:collapse}.gxp-mini td,.gxp-mini th{padding:2px 4px;text-align:left}
    .gxp-vt tbody tr{cursor:pointer}
    .gxp-vt-empty{padding:20px;color:#333}
    .gxp-id{color:#555;font-size:8pt}
    .gxp-approx{color:#444;font-size:8pt}
    .gxp-skel{display:inline-block;height:9px;width:60%;border-radius:3px;background:linear-gradient(90deg,#b8bca9,#d8dccb,#b8bca9);background-size:200% 100%;animation:gxpsk 1.2s infinite linear}
    @keyframes gxpsk{to{background-position:-200% 0}}
    .gxp-split-v{flex:0 0 6px;cursor:col-resize;background:#59624f}.gxp-split-h{flex:0 0 6px;cursor:row-resize;background:#59624f}
    #gxp-side{flex:1 1 0;display:flex;flex-direction:column;min-width:240px}
    #gxp-details{flex:0 0 45%;padding:6px 10px;box-sizing:border-box;overflow-y:auto;overflow-x:hidden}
    #gxp-details table{width:100%;border-collapse:collapse}
    #gxp-details h3{margin:4px 0 6px;font-size:12pt}
    .gxp-warn{color:#700}.gxp-ok{color:#060}
    #gxp-mapframe{flex:1 1 0;position:relative;min-height:80px;display:flex;overflow:hidden}
    #gxp-mapwrap{flex:1 1 auto;position:relative;overflow:hidden;min-height:80px;background:#000;cursor:grab}
    #gxp-map{position:absolute;left:0;top:0;width:8192px;height:1080px;background:url(${IMG}gxn0.jpg) no-repeat;background-size:100% 100%;transform-origin:0 0}
    .gxp-hidc{padding:0!important;border:0!important;overflow:hidden;font-size:0!important;width:0;max-width:0}.gxp-vt{position:relative}.gxp-vt-colbtn{position:absolute;top:1px;right:2px;z-index:3;cursor:pointer;padding:0 5px;background:#e8e8d8;border:1px solid #bbb;font-weight:bold}.gxp-vt-colmenu{position:absolute;top:20px;right:2px;z-index:30;background:#fff;border:1px solid #888;padding:6px;display:flex;flex-direction:column;gap:2px;max-height:320px;overflow:auto;box-shadow:2px 2px 6px rgba(0,0,0,.3)}.gxp-pbar{display:inline-block;width:100%;height:9px;background:#e4e4d8;border:1px solid #bbb;vertical-align:middle}.gxp-pbar>i{display:block;height:100%;background:#7aa35a}.gxp-toast{position:fixed;right:12px;bottom:28px;z-index:9999;background:#333;color:#fff;padding:6px 10px;border-radius:4px;max-width:360px;font:9pt arial,sans-serif;opacity:.95}#gxp-mapframe.gxp-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:5000;background:#000}#gxp-fsbtn{position:absolute;top:6px;left:6px;z-index:30;box-sizing:border-box;width:18px;height:18px;padding:0;margin:0;display:flex;align-items:center;justify-content:center;background:#f2f2f2;border:1px solid #000;border-radius:2px;box-shadow:0 0 0 1px #fff,0 1px 4px rgba(0,0,0,.8);cursor:pointer;line-height:0;font-size:0}#gxp-fsbtn::before,#gxp-fsbtn::after{content:none!important}#gxp-fsbtn:focus-visible{outline:2px solid #e0a000}#gxp-fsctl{position:absolute;top:6px;left:44px;z-index:30;display:none;background:#f2f2f2;border:2px solid #000;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.8);padding:3px;border-radius:3px}#gxp-mapframe.gxp-fs #gxp-fsctl{display:grid;grid-template-columns:repeat(3,26px);gap:2px}#gxp-fsctl span{text-align:center;padding:1px 0}.gxp-subtabs span{display:inline-block;padding:2px 8px;margin-right:2px;border:1px solid #bbb;cursor:pointer;background:#eee}.gxp-subtabs span.on{background:#fff;font-weight:bold}.gxp-chip{display:inline-block;margin:1px 3px;padding:1px 6px;border:1px solid #999;border-radius:9px;cursor:pointer;background:#f6f6ea}.gxp-pick-on{outline:2px solid #e0a000}
    a.gxp-ext,a.gxp-ext:link,a.gxp-ext:visited,a.gxp-ext:hover,a.gxp-ext:active{color:inherit!important;text-decoration:none!important;cursor:pointer;font:inherit;background:none;display:inline!important;padding:0!important;margin:0!important;width:auto!important}#gxp-map img{position:absolute}#gxp-map img.ship,#gxp-map img.globe,#gxp-map img.station{cursor:pointer}#gxp-map img.globe:hover,#gxp-map img.station:hover{outline:2px solid #ffd54a;outline-offset:1px;border-radius:50%}
    /* 3.0.7: every link in the console is black + underlined (game-provided links, world codes, product links…), incl. any
     * colour the game puts on inner elements. Country/owner name links (a.gxp-ext) are excluded while #gxp-app carries the
     * class gxp-extplain (default) — remove that ONE class (EXT_PLAIN in 70-app.js) to give them the same black underline. */
    #gxp-app a:not(.gxp-ext),#gxp-app a:not(.gxp-ext):link,#gxp-app a:not(.gxp-ext):visited,#gxp-app a:not(.gxp-ext):hover,#gxp-app a:not(.gxp-ext):active{color:#000!important;text-decoration:underline!important}
    #gxp-app a:not(.gxp-ext) *{color:inherit!important}
    /* 3.0.7: plain-colour country/owner links are underlined while "Clickable names" + "also in tables" are on (class gxp-extul) */
    #gxp-app.gxp-extul a.gxp-ext,#gxp-app.gxp-extul a.gxp-ext:link,#gxp-app.gxp-extul a.gxp-ext:visited,#gxp-app.gxp-extul a.gxp-ext:hover,#gxp-app.gxp-extul a.gxp-ext:active{text-decoration:underline!important}
    #gxp-app:not(.gxp-extplain) a.gxp-ext,#gxp-app:not(.gxp-extplain) a.gxp-ext:link,#gxp-app:not(.gxp-extplain) a.gxp-ext:visited,#gxp-app:not(.gxp-extplain) a.gxp-ext:hover,#gxp-app:not(.gxp-extplain) a.gxp-ext:active{color:#000!important;text-decoration:underline!important}
    #gxp-marker{position:absolute;display:none;pointer-events:none;width:20px;height:32px;z-index:10}
    #gxp-maptools{position:absolute;right:6px;top:6px;z-index:20;display:flex;gap:4px}
    #gxp-foot{flex:0 0 auto;padding:2px 8px;color:#ceceb5;font-size:8pt;border-top:1px solid gold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gxp-btn{display:inline-block;padding:2px 8px;cursor:pointer}
    .gxp-scrollbox{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;min-height:0;padding:6px}
    .gxp-tr-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;min-height:220px;flex:0 0 260px}
    .gxp-tr-grid>div{display:flex;flex-direction:column;min-height:0;border:1px solid #59624f;background:#949a8c}
    .gxp-tr-grid h4{margin:0;padding:3px 6px;background:#59624f;color:#ceceb5;font-size:9pt}
    .gxp-dialog{position:absolute;top:40px;right:20px;z-index:100;background:#ceceb5;border:1px solid #59624f;padding:10px 14px;box-shadow:0 4px 18px #000;max-width:520px}
    .gxp-dialog label{display:block;margin:4px 0}
  `;
  /* ===================================================================
   * APP
   * =================================================================== */
  function loadSettings() { let s = {}; try { s = JSON.parse(W.localStorage.getItem('gxp.settings') || '{}'); } catch (e) { /* */ } return Object.assign({}, DEFAULT_SETTINGS, s); }
  function loadCapture() { try { return JSON.parse(W.localStorage.getItem('gxp.formCapture') || 'null'); } catch (e) { return null; } }

  async function mount(opts) {
    opts = opts || {};
    const doc = W.document, C = Object.assign({}, CADENCE, opts.cadence || {});
    const dbg = createDebug();
    const settings = loadSettings(); dbg.setMinLevel(settings.debugLevel === 'debug' ? 'debug' : 'debug');
    const saveSettings = () => { try { W.localStorage.setItem('gxp.settings', JSON.stringify(settings)); } catch (e) { /* */ } };
    const idb = opts.indexedDB || W.indexedDB;
    let db; if (opts.db) db = opts.db; else try { db = idb ? await new GxDB(idb, opts.dbName).open() : await new MemDB().open(); } catch (e) { dbg.script('error', 'IndexedDB unavailable, using memory only: ' + e.message); db = await new MemDB().open(); }
    const app = { dbg, settings, db, timers: new Set(), cleanups: [] };
    /* owner ("mine"), 0.2.4: an identity = set of normalised names + player profile keys (miKey of the ppview link).
     * Sources, all merged: Settings override list (replaces auto names), Settings extra names, owner of your own transports
     * (gxTransportInfo, probed at start-up as soon as signed in), owner of shuttles in your transports' logbooks, your docking stations.
     * The page-header guess is only a candidate: it is used only if at least one shuttle owner matches it.
     * Root cause of 0.2.3 'mine shows nothing': one name, taken from the page header regex (absent or wrong on the gxRoot page)
     * or from a transport info read that only ran after the Transport tab had loaded its list; a wrong/empty name blocked
     * everything else, and an empty set silently matched nothing. */
    const owner = { names: new Map(), keys: new Map(), hint: opts.ownerHint || '', hintSource: opts.ownerSource || 'page header' };
    const splitNames = v => String(v || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    const meSet = () => { const o = splitNames(settings.meOverride); const base = o.length ? o : [...owner.names.keys()].map(k => owner.names.get(k).name);
      return new Set(base.concat(splitNames(settings.meExtra)).map(normName).filter(Boolean)); };
    const meKeys = () => splitNames(settings.meOverride).length ? new Set() : new Set(owner.keys.keys());
    const isMine = (o, key) => { if (o && typeof o === 'object') { key = o.ownerKey; o = o.owner; } return (!!key && meKeys().has(key)) || meSet().has(normName(o)); };
    const meLabel = () => { const n = [...meSet()]; const ov = splitNames(settings.meOverride).length;
      return n.length || meKeys().size ? `${[...(ov ? splitNames(settings.meOverride) : [...owner.names.values()].map(x => x.name)), ...splitNames(settings.meExtra)].join(', ')}${meKeys().size ? ` (+${meKeys().size} profile key)` : ''} (${ov ? 'set in Settings' : [...new Set([...owner.names.values()].map(x => x.source))].join(', ') || 'Settings'})` : 'unknown — set it in Settings'; };
    app.owner = owner; app.meSet = meSet; app.isMine = isMine;
    const logMine = why => { if (!tracker) return; const all = [...tracker.ships.values()]; const m = all.filter(s => isMine(s)).length;
      const owners = new Map(); for (const s of all) if (s.owner) owners.set(s.owner, (owners.get(s.owner) || 0) + 1);
      dbg.script(m || !meSet().size ? 'info' : 'warn', `mine (${why}): names [${[...meSet()].join(', ')}], profile keys [${[...meKeys()].join(', ')}] -> ${m} of ${all.length} shuttles match`,
        m ? undefined : { topOwners: [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15) }); };
    const learnOwner = (name, source, key) => { let ch = false; name = (name || '').trim();
      if (name && !owner.names.has(normName(name))) { owner.names.set(normName(name), { name, source }); ch = true; }
      if (key && !owner.keys.has(key)) { owner.keys.set(key, source); ch = true; }
      if (ch) { dbg.script('info', `owner detected: "${name}"${key ? ' key ' + key : ''} from ${source}`); try { W.localStorage.setItem('gxp.owner', JSON.stringify({ names: [...owner.names.values()], keys: [...owner.keys.entries()] })); } catch (e) { /* */ } logMine('owner learned'); renderAll(); } };
    try { const c = JSON.parse(W.localStorage.getItem('gxp.owner') || 'null'); if (c) { for (const n of c.names || []) owner.names.set(normName(n.name), { name: n.name, source: n.source + ' (saved)' }); for (const [k, v] of c.keys || []) owner.keys.set(k, v + ' (saved)'); } } catch (e) { /* */ }
    if (owner.hint) dbg.script('info', `owner candidate from ${owner.hintSource}: "${owner.hint}" (used only if a shuttle owner matches)`);
    let tracker;
    let session;
    const client = new RequestClient({ fetchImpl: opts.fetchImpl, concurrency: 2, minGapMs: opts.minGapMs, backoffMs: opts.backoffMs, timeoutMs: opts.timeoutMs, debug: dbg,
      onSession: (state, why) => session && session.set(state, why) });
    tracker = createTracker({ db, dbg }); if (settings.eventRows) tracker.eventLimit = Math.max(1000, Math.min(200000, +settings.eventRows || LIMITS.EVENT_RING_UI)); await tracker.init();
    const capture = () => opts.capture !== undefined ? opts.capture : loadCapture();
    const transport = createTransport({ client, dbg, db, tracker, settings: () => settings, capture }); await transport.load();
    let bc = null; try { bc = new BroadcastChannel('galaxyplus'); } catch (e) { /* */ }
    session = createSession({ client, dbg, win: W, channel: bc, cookieHash: opts.cookieHash || (() => readPortalCookieHash(doc)) });
    Object.assign(app, { client, tracker, transport, session });
    const later = (fn, ms) => { if (app.stopped) return null; const t = setTimeout(() => { app.timers.delete(t); fn(); }, ms); app.timers.add(t); return t; };
    const every = (fn, ms) => { if (app.stopped) return null; const t = setInterval(fn, ms); app.timers.add(t); return t; };
    const on = (target, ev, fn, o) => { target.addEventListener(ev, fn, o); app.cleanups.push(() => target.removeEventListener(ev, fn, o)); };

    /* ---------- DOM skeleton ---------- */
    const style = doc.createElement('style'); style.textContent = CSS_TEXT; doc.head.appendChild(style);
    const root = doc.createElement('div'); root.id = 'gxp-app'; const EXT_PLAIN = true; /* 3.0.7: country/owner name links plain (no underline) while true */ if (EXT_PLAIN) root.classList.add('gxp-extplain');
    const TABS = [['ships', 'Shuttles'], ['stations', 'Stations'], ['centers', 'Space Centers'], ['markets', 'Markets'], ['docks', 'Docking'], ['transport', 'Transport'], ['trends', 'Trends'], ['events', 'Events'], ['debug', 'Debug']];
    root.innerHTML = `
      <div id="gxp-head" class="gxpanel_bar">
        <span class="gxpu_h" style="background-image:url(${IMG}put.gif)">Galaxy Console ${VERSION}</span>
        <span class="gxbutton gxp-btn" id="gxp-refresh" role="button" tabindex="0" title="Reload lists and map now">Refresh</span>
        <span class="gxbutton gxp-btn" id="gxp-settings-btn" role="button" tabindex="0">Settings</span>
        <span id="gxp-session" class="gxp-badge" title="Sign-in state for login-only pages (transport pickers)">session: checking…</span>
        <span id="gxp-mem" class="gxp-badge" style="display:none;background:#fff0c0;color:#7a3d00;cursor:help" title=""></span>
        <span id="gxp-status" aria-live="polite"></span>
      </div>
      <div id="gxp-main">
        <section id="gxp-left" class="gxp-pane">
          <div id="gxp-tabs" role="tablist">${TABS.map(([k, l], i) => `<span role="tab" tabindex="0" id="gxp-tab-${k}" data-tab="${k}" aria-selected="${i === 0}">${l}</span>`).join('')}</div>
          ${TABS.map(([k], i) => `<div class="gxp-tabpanel${i === 0 ? ' on' : ''}" id="gxp-panel-${k}" role="tabpanel"></div>`).join('')}
        </section>
        <div class="gxp-split-v" id="gxp-sv" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
        <div id="gxp-side">
          <section id="gxp-details" class="gxp-pane" aria-label="Details"><p class="gxpu_text">Select a shuttle.</p></section>
          <div class="gxp-split-h" id="gxp-sh" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
          <div id="gxp-mapframe"><section id="gxp-mapwrap" aria-label="Galaxy map"><div id="gxp-map"><img id="gxp-marker" src="${IMG}mapmark.gif" alt=""></div></section>
            <div id="gxp-maptools"><span class="gxbutton gxp-btn" id="gxp-zin" role="button" tabindex="0" title="Zoom in">+</span><span class="gxbutton gxp-btn" id="gxp-zout" role="button" tabindex="0" title="Zoom out">&minus;</span></div></div>
        </div>
      </div>
      <div id="gxp-foot"></div>`;
    doc.body.appendChild(root);
    const $ = id => doc.getElementById(id), P = k => $('gxp-panel-' + k);
    const onBtn = (el, fn) => { on(el, 'click', fn); on(el, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }); };
    let activeTab = 'ships'; const tabOpeners = {};
    const showTab = k => { activeTab = k; for (const [t] of TABS) { $('gxp-tab-' + t).setAttribute('aria-selected', t === k); P(t).classList.toggle('on', t === k); } if (tabOpeners[k]) tabOpeners[k](); renderAll(); };
    for (const [k] of TABS) onBtn($('gxp-tab-' + k), () => showTab(k));
    const foot = () => { $('gxp-foot').textContent = settings.writesEnabled ? `Writes ENABLED (transport requests${settings.writeRename ? ', shuttle rename' : ''}${settings.writeFlights ? ', flights' : ''}).${settings.devTools && settings.dryRun ? ' DRY RUN: nothing is sent.' : ''}` : 'Read-only: writes are OFF. Nothing is ordered, scheduled, docked or traded.'; };
    foot();

    /* ---------- generic list tab builder ---------- */
    const tuApprox = n => n == null ? '' : `${fmtN(n)} <span class="gxp-approx">≈${fmtDur(n * settings.tuSeconds)}</span>`;
    function listTab(key, barHtml, cols, o) {
      P(key).innerHTML = `<div class="gxp-bar">${barHtml}<label title="auto: widths follow the window; fixed: your widths (drag a header edge), saved for this table">columns <select data-colmode title="auto: column widths follow the window; fixed: your own widths (drag a header edge), saved per table"><option value="auto">auto</option><option value="fixed">fixed</option></select></label><span class="gxbutton gxp-btn" data-colreset role="button" tabindex="0" title="Back to automatic widths">reset widths</span><span class="gxp-count"></span></div><div class="gxp-host"></div>`;
      const msel = P(key).querySelector('[data-colmode]');
      const vt = VTable(doc, P(key).querySelector('.gxp-host'), cols, Object.assign({ id: key, onSort: () => renderAll(), onLayout: m => { msel.value = m; } }, o));
      msel.value = vt.mode(); on(msel, 'change', e => { e.stopPropagation(); vt.setMode(msel.value); dbg.script('info', `columns of ${key}: ${msel.value}`); });
      onBtn(P(key).querySelector('[data-colreset]'), () => { vt.resetWidths(); msel.value = 'auto'; });
      app.cleanups.push(() => vt.destroy()); (app.vts || (app.vts = {}))[key] = vt; // 3.1.3: per-tab reset of the sort
      return { vt, bar: P(key).querySelector('.gxp-bar'), count: P(key).querySelector('.gxp-count') };
    }

    /* ---------- Shuttles ---------- */
    const SHIP_COLS = [
      { key: 'name', label: 'Name', w: '15%', grow: true, min: 120, html: s => `<img src="${IMG}galaxyship01${esc(s.heading || 'C')}.gif" width="9" height="9" alt=""> ${esc(s.name || '?')}${dupNames.get(s.name) > 1 ? ` <span class="gxp-id">#${s.id.slice(-6)}</span>` : ''}`, title: s => 'ID ' + s.id },
      { key: 'owner', label: 'Owner', w: '11%', grow: true, min: 100, html: s => s.owner ? ownerLinkT(s.owner, s.ownerKey) : (s.detailAt ? '' : '<span class="gxp-skel"></span>') },
      { key: 'location', label: 'Location', w: '14%', grow: true, min: 120, html: s => s.location ? placeLinkT(s.location, aliasHtml(s.location)) : (s.detailAt ? '' : '<span class="gxp-skel"></span>'), title: s => s.location },
      { key: 'destination', label: 'Destination', w: '14%', grow: true, min: 120, html: s => placeLinkT(s.destination, aliasHtml(s.destination)), title: s => s.destination },
      { key: 'cargo', label: 'Cargo', w: '8%', num: true, max: 90, html: s => fmtN(s.cargo) },
      { key: 'missions', label: 'Missions', w: '7%', num: true, max: 75, html: s => fmtN(s.missions) },
      { key: 'sinceTu', label: 'Since (tu)', w: '10%', num: true, min: 70, max: 120, html: s => tuApprox(s.sinceTu), title: () => 'approximate real time at ' + settings.tuSeconds + ' s per tu' },
      { key: 'arrivalTu', label: 'Arrival (tu)', w: '10%', num: true, min: 70, max: 120, html: s => tuApprox(s.arrivalTu), title: () => 'approximate real time at ' + settings.tuSeconds + ' s per tu' },
      { key: 'status', label: 'Status', w: '6%', min: 60, max: 130, html: s => s.status === 'retired' ? (s.cargo > 0 ? '<b class="gxp-warn" title="Retired with cargo: offload it">retired · offload</b>' : 'retired') : esc(s.status) },
      { key: 'lastSeen', label: 'Seen', w: '5%', num: true, max: 70, html: s => s.lastSeen ? fmtDur((Date.now() - s.lastSeen) / 1000) : '' , title: s => fmtTime(s.lastSeen) },
    ];
    let dupNames = new Map();
    const shipsTab = listTab('ships', `<input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter name, owner, place, ID" size="20" aria-label="Text filter">
      <select data-f="owner" title="Show only rows from this owner" aria-label="Owner"><option value="all">all owners</option><option value="mine">mine</option></select> <span class="gxp-approx" id="gxp-me-lbl"></span>
      <select data-f="status" title="Show only shuttles with this status" aria-label="Status"><option value="all">any status</option><option value="flight">in flight</option><option value="idle">idle</option><option value="unknown">unknown</option><option value="retired">retired</option><option value="active">all but retired</option><option value="offload">retired, needs offload</option></select>
      <select data-f="world" title="Show only rows on this world" aria-label="Location"><option value="all">any location</option></select>
      <label><input type="checkbox" data-f="stale" checked> include stale</label> <label title="Show shuttles with 0 missions left (retired)"><input type="checkbox" data-f="retired" checked> retired</label>`, SHIP_COLS,
      { sort: { key: 'name', dir: 1 }, rowKey: s => s.id, rowClass: s => (s.status === 'retired' ? 'retired' : s.stale ? 'stale' : ''), onRowClick: id => select(id, true),
        emptyHtml: () => tracker.ships.size ? (sf.owner === 'mine' && !meSet().size && !meKeys().size ? 'Your owner name is not known yet. Open Settings and enter your player name (as shown in the Owner column), or sign in so Galaxy Console can read it from one of your transports.' : 'No shuttle matches the filters.') : '<span class="gxp-skel"></span> loading shuttles…' });
    const sf = { q: '', owner: 'all', status: 'all', world: 'all', stale: true, retired: true };
    // 0.2.5: the 'stale' and 'retired' checkboxes persist across sessions
    try { const p = JSON.parse(W.localStorage.getItem('gxp.shipFilters') || '{}'); for (const k of ['stale', 'retired']) if (typeof p[k] === 'boolean') { sf[k] = p[k]; const cb = shipsTab.bar.querySelector(`[data-f=${k}]`); if (cb) cb.checked = p[k]; } } catch (e) { /* */ }
    const saveShipFilters = () => { try { W.localStorage.setItem('gxp.shipFilters', JSON.stringify({ stale: sf.stale, retired: sf.retired })); } catch (e) { /* */ } };
    on(shipsTab.bar, 'change', e => { const f = e.target.dataset.f; if (f === 'stale' || f === 'retired') { sf[f] = e.target.checked; saveShipFilters(); } });
    on(shipsTab.bar, 'input', e => { const f = e.target.dataset.f; if (!f) return; sf[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderAll(); });
    on(shipsTab.bar, 'click', e => { const c = e.target.closest('[data-chip]'); if (!c) return; sf.status = sf.status === c.dataset.chip ? 'all' : c.dataset.chip; shipsTab.bar.querySelector('[data-f=status]').value = sf.status; renderAll(); });
    on(shipsTab.bar, 'change', e => { const f = e.target.dataset.f; if (!f) return; if (f === 'owner' && e.target.value === 'mine') logMine('filter selected'); sf[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderAll(); });
    /** 0.2.7: the shuttle-list filters, shared by the list and the map. */
    /* 3.0.1 location normalisation. Root cause of duplicates / centers in the Location dropdown: the shuttle list gives the
     * PLANET name ("Kebir Blue") while the shuttle info page gives the SPACE CENTER ("Center on KB"); both write s.location,
     * and the old worldOf() turned one into "KB" and kept the other as "Kebir Blue" (two entries for one planet) and kept any
     * name without " on XX" (stations, some centers) raw. Now every place maps to one stable key:
     *   "<center> on XX" -> planet with initials XX (full name when known), known planet name -> that planet,
     *   known station name -> station, GDS coordinates -> in space; names compared after whitespace/case/NFKC normalisation. */
    const nk = v => normName(v).toLowerCase();
    let locCache = { at: 0 };
    function locIndex() {
      if (Date.now() - locCache.at < 2000) return locCache;
      const planets = new Map(), byInit = new Map(), stations = new Set();
      const addPlanet = n => { const k = nk(n); if (!k || / on [a-z]{2,3}$/.test(k) || /^gds\./.test(k)) return; const disp = String(n).replace(/[\s\u00a0]+/g, ' ').trim(); if (!planets.has(k)) planets.set(k, disp); const i = initials(disp); if (i.length >= 2 && !byInit.has(i)) byInit.set(i, disp); };
      try { for (const g of (typeof globes !== 'undefined' ? globes : [])) addPlanet(g.name); } catch (e) { /* map not ready */ }
      for (const st of (data.stations || [])) if (st && st.name) stations.add(nk(st.name));
      for (const s of tracker.ships.values()) { if (s.listLocation) addPlanet(s.listLocation); }
      locCache = { at: Date.now(), planets, byInit, stations }; return locCache;
    }
    function locKeyOf(loc) {
      const raw = normName(loc); if (!raw || raw === '-') return null; const k = raw.toLowerCase(), L = locIndex();
      if (/^gds\./.test(k) || /in space/.test(k)) return { key: 'sp', label: 'in space' };
      const m = / on ([a-z]{2,3})$/i.exec(raw); if (m) { const code = m[1].toUpperCase(), full = L.byInit.get(code); return { key: 'p:' + code, label: full ? `${full} (${code})` : code }; }
      if (L.stations.has(k)) return { key: 's:' + k, label: raw + ' (station)' };
      if (L.planets.has(k)) { const i = initials(L.planets.get(k)); return { key: 'p:' + (i.length >= 2 ? i : k), label: `${L.planets.get(k)}${i.length >= 2 ? ' (' + i + ')' : ''}` }; }
      return { key: 'o:' + k, label: raw };
    }
    const shipLocKeys = s => [s.location, s.destination].map(locKeyOf).filter(Boolean).map(x => x.key);
    /** Ships that count for the dropdown: same stale/retired visibility as the list (retired/stale only when those filters show them). */
    const locEligible = s => (sf.stale || !s.stale) && (sf.retired || s.status !== 'retired' || sf.status === 'retired' || sf.status === 'offload');
    app.locKeyOf = locKeyOf; app.locIndexReset = () => { locCache = { at: 0 }; };
    function filteredShips() { const q = sf.q.trim().toLowerCase();
      return [...tracker.ships.values()].filter(s => (sf.stale || !s.stale) && (sf.retired || s.status !== 'retired' || sf.status === 'retired' || sf.status === 'offload') && textMatch(q, [s.name, s.owner, s.location, s.destination, s.id, aliasOf(s.location), aliasOf(s.destination)])
        && (sf.owner !== 'mine' || isMine(s)) && (sf.status === 'all' || s.status === sf.status || (sf.status === 'active' && s.status !== 'retired') || (sf.status === 'offload' && s.status === 'retired' && s.cargo > 0)) && (sf.world === 'all' || shipLocKeys(s).indexOf(sf.world) >= 0));
    }
    /** Shuttles to draw on the map: same set as the list, in reverse list order so the top rows are drawn on top. */
    function mapShips() { const vt = shipsTab.vt; return sortRows(filteredShips(), SHIP_COLS.find(c => c.key === vt.sort.key), vt.sort.dir).filter(s => s.onMap && s.mapObj).reverse(); }
    /* 3.1.4: shuttles that are not on the game's map layer (idle / docked at a planet, station or center: the layer only carries
     * shuttles in flight) but have a position from the shuttle list (gxGSVzoomGalaxyPosition) are drawn at that position
     * with their own marker, so a filtered list of idle shuttles is no longer an empty map. Setting mapShowDocked (default on). */
    function mapDocked() { if (settings.mapShowDocked === false) return []; const vt = shipsTab.vt;
      return sortRows(filteredShips(), SHIP_COLS.find(c => c.key === vt.sort.key), vt.sort.dir).filter(s => !(s.onMap && s.mapObj) && s.x != null && s.y != null && isFinite(s.x) && isFinite(s.y)).reverse(); }
    app.filteredShips = filteredShips; app.mapShips = mapShips; app.mapDocked = mapDocked;
    function renderShips() {
      dupNames = new Map(); for (const s of tracker.ships.values()) dupNames.set(s.name, (dupNames.get(s.name) || 0) + 1);
      const q = sf.q.trim().toLowerCase(); $('gxp-me-lbl').textContent = 'mine = ' + meLabel();
      let rows = filteredShips();
      const vt = shipsTab.vt; rows = sortRows(rows, SHIP_COLS.find(c => c.key === vt.sort.key), vt.sort.dir);
      vt.selectedKey = selected; vt.setRows(rows);

      const all = tracker.ships.size, det = [...tracker.ships.values()].filter(s => s.detailAt).length, stale = [...tracker.ships.values()].filter(s => s.stale).length;
      const vals = [...tracker.ships.values()], ret = vals.filter(s => s.status === 'retired'), off = ret.filter(s => s.cargo > 0).length;
      const idle = vals.filter(s => s.status === 'idle').length, fl = vals.filter(s => s.status === 'flight').length;
      shipsTab.count.innerHTML = `${rows.length} of ${all} shown · <span title="idle, not retired">${idle} idle</span> · ${fl} in flight · <span class="gxp-retired-chip" data-chip="retired" role="button" tabindex="0" title="Show retired (0 missions left)">${ret.length} retired</span>${off ? ` · <span class="gxp-warn" data-chip="offload" role="button" tabindex="0" title="Retired shuttles still holding cargo">${off} need offload</span>` : ''} · ${stale} stale · details ${det}/${all}`;
      const sel = shipsTab.bar.querySelector('[data-f=world]'); const locs = new Map();
      for (const s of tracker.ships.values()) { if (!locEligible(s)) continue; for (const x of [s.location, s.destination].map(locKeyOf)) if (x && !locs.has(x.key)) locs.set(x.key, x.label); }
      if (sf.world !== 'all' && !locs.has(sf.world)) sf.world = 'all';
      syncOptions(sel, [['all', 'any location']].concat([...locs].sort((a, b) => a[1].localeCompare(b[1]))), sf.world);
    }

    /* ---------- Stations / Markets / Docking ---------- */
    const cache = new LRU(LIMITS.PAGE_CACHE_LRU, MEM.PAGE_CACHE_BYTES); app.pageCache = cache;
    // 0.2.4: in-flight requests are shared per key. Before, every tab re-open / render that called a loader while the first read was
    // still running issued a NEW request on the same channel, and the client's stale guard aborted the slow one -> markets restarted.
    const inflight = new Map(), loading = {};
    async function cachedRead(key, method, params, maxAgeMs) {
      const c = cache.get(key); if (c && Date.now() - c.at < maxAgeMs) return c.html;
      if (inflight.has(key)) return inflight.get(key);
      const t0 = Date.now(); loading[key] = t0;
      const p = client.request(method, params, { channel: key, priority: 4 }).promise.finally(() => { inflight.delete(key); delete loading[key]; });
      inflight.set(key, p); const html = await p; dbg.script('debug', `read ${key}: ${html.length} B in ${Date.now() - t0} ms`); cache.set(key, { at: Date.now(), html }); dbg.script('debug', 'page cache store ' + key + ' (' + cache.size + ' entries)'); return html;
    }
    const data = { stations: null, markets: null, myDocks: null, stationDocks: new Map(), errors: {} };
    const ST_COLS = [{ key: 'name', label: 'Station', w: '22%', grow: true }, { key: 'owner', label: 'Owner', w: '20%', html: r => ownerLinkT(r.owner) }, { key: 'position', label: 'Position', w: '20%' },
      { key: 'storage', label: 'Storage used', w: '20%', num: true, html: r => fmtN(r.storage) }, { key: 'usePct', label: 'Use%', w: '18%', num: true, max: 80, html: r => r.usePct == null ? '' : r.usePct.toFixed(2) + '%' }];
    const stTab = listTab('stations', `<input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter station or owner" aria-label="Text filter"> <label>max use% <input data-f="maxUse" title="Hide stations whose storage use is above this percentage" type="number" min="0" max="100" style="width:60px"></label>`, ST_COLS,
      { sort: { key: 'name', dir: 1 }, rowKey: r => r.id, onRowClick: id => { const r = data.stations.find(x => x.id === id); if (r && r.x != null) centerOn(r.x, r.y); showStation(r); }, emptyHtml: () => data.errors.stations ? esc(data.errors.stations) : '<span class="gxp-skel"></span> loading…' });
    const stf = { q: '', maxUse: '' };
    on(stTab.bar, 'input', e => { if (e.target.dataset.f) { stf[e.target.dataset.f] = e.target.value; renderAll(); } });
    const MK_COLS = [{ key: 'product', label: 'Product', w: '30%', grow: true, min: 140 }, { key: 'station', label: 'Station', w: '20%', grow: true, min: 100 }, { key: 'offered', label: 'Offered', w: '17%', num: true, html: r => fmtN(r.offered) },
      { key: 'requested', label: 'Requested', w: '17%', num: true, html: r => fmtN(r.requested) }, { key: 'unit', label: 'Unit', w: '16%', max: 110 }];
    const mkTab = listTab('markets', `<input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter product or station" aria-label="Text filter"> <select data-f="station" title="Show only this station" aria-label="Station"><option value="all">all stations</option></select> <label title="Hide rows where both Offered and Requested are 0. Ignored when one station is chosen; rows whose counts could not be read are always shown."><input type="checkbox" data-f="hideZero"> Hide markets with nothing offered or requested</label> <span class="gxbutton gxp-btn" data-act="mkReload" role="button" tabindex="0" title="Read the market list again from the server">reload</span>`, MK_COLS,
      { sort: { key: 'product', dir: 1 }, rowKey: r => r.stationId + ':' + r.productId, onRowClick: k => { const r = (data.markets || []).find(m => m.stationId + ':' + m.productId === k); if (r) showProduct(String(r.productId), r.product); }, emptyHtml: () => data.errors.markets ? esc(data.errors.markets) : (data.markets ? 'No market matches (most markets offer and request 0; untick "Hide markets with nothing offered or requested").' : '<span class="gxp-skel"></span> loading…') });
    const mkf = { q: '', station: 'all', hideZero: false };
    // 0.2.6: a row is 'empty' only when BOTH counts parsed as numbers and are 0; unparsed (null) counts are unknown -> shown
    const mkEmpty = m => m.offered === 0 && m.requested === 0 && m.offered !== null;
    const mkHides = () => mkf.hideZero && mkf.station === 'all';
    on(P('markets'), 'click', e => { if (e.target.closest('[data-act=mkShowHidden]')) { mkf.hideZero = false; const cb = mkTab.bar.querySelector('[data-f=hideZero]'); if (cb) cb.checked = false; renderAll(); } });
    const mkIn = e => { const f = e.target.dataset.f; if (f) { mkf[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderAll(); } };
    on(mkTab.bar, 'input', mkIn); on(mkTab.bar, 'change', mkIn); onBtn(mkTab.bar.querySelector('[data-act=mkReload]'), () => loadMarkets(true));
    const DK_COLS = [{ key: 'station', label: 'Station', w: '20%' }, { key: 'dock', label: 'Dock', w: '15%' }, { key: 'owner', label: 'Owner', w: '22%', html: r => ownerLinkT(r.owner) }, { key: 'usedBy', label: 'Used by', w: '22%', html: r => ownerLinkT(r.usedBy) },
      { key: 'usePct', label: 'Use%', w: '21%', num: true, max: 80, html: r => r.usePct == null ? '' : r.usePct.toFixed(2) + '%' }];
    const dkTab = listTab('docks', `<select data-f="src" title="Choose which markets are listed" aria-label="Source"><option value="mine">my docking stations</option><option value="all">all stations (loaded)</option></select>
      <span class="gxbutton gxp-btn" data-act="loadAll" role="button" tabindex="0" title="Read every station page once (20 requests, sequential)">load all stations' docks</span>
      <input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter" aria-label="Text filter"> <label><input type="checkbox" data-f="free"> free only</label>`, DK_COLS,
      { sort: { key: 'station', dir: 1 }, rowKey: r => r.station + ':' + r.dock, emptyHtml: () => data.errors.docks ? esc(data.errors.docks) : (dkf.src === 'mine' ? (data.myDocks ? 'You do not own a docking station (or not signed in).' : '<span class="gxp-skel"></span> loading…') : 'Load stations\' docks first.') });
    const dkf = { src: 'mine', q: '', free: false };
    const dkIn = e => { const f = e.target.dataset.f; if (f) { dkf[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderAll(); } };
    on(dkTab.bar, 'input', dkIn); on(dkTab.bar, 'change', dkIn);
    onBtn(dkTab.bar.querySelector('[data-act=loadAll]'), () => loadAllDocks());
    async function loadStations() { try { data.stations = parseStations(await cachedRead('stations', 'gxQuerySpaceStations', {}, 300000)); data.errors.stations = null; } catch (e) { if (e.name !== 'StaleResponseError') data.errors.stations = 'Could not load: ' + e.message; } renderAll(); }
    /* Markets (0.2.4). Root cause of 'All only fills after opening one station': the bulk read was sent as a bare
     * gxQuerySpaceMarkets, while the game's own list links always send miObjectID=-1 (= all of CentauDos) + view/sort/order;
     * the server answers a bare query from the session's current object context. Galaxy Console now sends the explicit 'all'
     * parameters, checks coverage against the station list, and fills any station still missing from its own station page
     * (gxInfo, the same read the Docking tab uses), two at a time, rendering each station as it arrives.
     * Per-station results are kept in IndexedDB (meta 'marketsCache') and shown immediately on the next start. */
    data.mkStations = new Map(); // stationId -> { at, name, rows, src }
    const mkFlatten = () => { data.markets = [].concat(...[...data.mkStations.values()].map(x => x.rows)); };
    const mkPersist = () => db.setMeta('marketsCache', { v: 2, stations: [...data.mkStations.entries()] }).catch(() => {});
    const mkProg = { total: 0, done: 0, running: false, t0: 0 };
    async function mkCacheLoad() { if (data.mkCacheTried) return; data.mkCacheTried = true;
      try { const c = await db.getMeta('marketsCache', null); if (c && c.v === 2 && !data.mkStations.size) { for (const [id, v] of c.stations) data.mkStations.set(id, Object.assign(v, { cached: true })); mkFlatten(); renderAll();
        dbg.script('info', `markets: ${data.mkStations.size} stations from cache shown while refreshing`); } } catch (e) { /* */ } }
    async function mkStation(st, why) {
      const html = await cachedRead('gxInfo:' + st.id, 'gxInfo', { miKey: st.id }, 30000); const rows = parseStationMarket(html, st.id, st.name);
      data.mkStations.set(String(st.id), { at: Date.now(), name: st.name, rows, src: 'station page' }); mkFlatten(); mkPersist(); renderAll();
      dbg.script('debug', `market ${st.name}: ${rows.length} rows (${why})`); return rows;
    }
    async function loadMarkets(force) {
      data.marketsWanted = true; await mkCacheLoad();
      if (mkProg.running || (!force && data.marketsAt && Date.now() - data.marketsAt < C.MARKET_STATION_REFRESH_MS)) return;
      mkProg.running = true; mkProg.t0 = Date.now(); mkProg.done = 0; mkProg.total = 1;
      const tick = every(() => { if (activeTab === 'markets') renderLists(); }, 1000);
      try {
        if (!data.stations) await loadStations();
        try { const html = await cachedRead('markets', 'gxQuerySpaceMarkets', { miObjectID: -1, miObjectView: 0, miObjectSort: 1, miObjectOrder: 1 }, force ? 0 : 300000);
          const rows = parseMarkets(html), by = new Map(); for (const r of rows) { if (!by.has(r.stationId)) by.set(r.stationId, []); by.get(r.stationId).push(r); }
          for (const [id, rs] of by) data.mkStations.set(id, { at: Date.now(), name: rs[0].station, rows: rs, src: 'market list' });
          mkFlatten(); mkPersist(); renderAll(); dbg.script('info', `markets: bulk list ${rows.length} rows from ${by.size} stations in ${Date.now() - mkProg.t0} ms`);
        } catch (e) { if (e.name === 'StaleResponseError') return; dbg.script('warn', 'markets bulk list failed: ' + e.message + ' (falling back to station pages)'); }
        mkProg.done = 1;
        const missing = (data.stations || []).filter(st => { const m = data.mkStations.get(String(st.id)); return !m || m.cached; });
        if (missing.length) { dbg.script(data.stations && missing.length === data.stations.length ? 'warn' : 'info', `markets: ${missing.length} of ${(data.stations || []).length} stations not in the bulk list, reading their station pages`);
          mkProg.total += missing.length; let i = 0;
          const worker = async () => { while (i < missing.length) { const st = missing[i++]; try { await mkStation(st, 'fill'); } catch (e) { if (e.name !== 'StaleResponseError') dbg.script('warn', `market ${st.name}: ${e.message}`); } mkProg.done++; } };
          await Promise.all([worker(), worker()]); }
        data.marketsAt = Date.now(); data.errors.markets = data.mkStations.size ? null : 'Could not load any market.';
        dbg.script('info', `markets: ${data.markets ? data.markets.length : 0} rows, ${data.mkStations.size} of ${(data.stations || []).length} stations, ${Date.now() - mkProg.t0} ms`);
      } finally { mkProg.running = false; clearInterval(tick); app.timers.delete(tick); renderAll(); }
    }
    // slow timer: one stale station per tick
    every(() => { if (!data.marketsWanted || mkProg.running || !data.stations || session.state === 'expired') return;
      const st = data.stations.map(s => [s, data.mkStations.get(String(s.id))]).filter(([, m]) => !m || Date.now() - m.at > C.MARKET_STATION_REFRESH_MS).sort((a, b) => ((a[1] || {}).at || 0) - ((b[1] || {}).at || 0))[0];
      if (st) mkStation(st[0], 'timer').catch(() => {}); }, C.MARKET_TIMER_MS);
    // shuttle arriving at / departing from a station -> refresh that station's market now (debounced)
    const mkLastTrig = new Map();
    const placeStation = p => { if (!p || !data.stations) return null; const b = normName(String(p).replace(/^GDS\.\s*/, '')); return data.stations.find(s => normName(s.name) === b || b.startsWith(normName(s.name) + ' ')) || null; };
    tracker.eventHooks.add(e => {
      if (!data.marketsWanted || !/^(arrived|trip_start|cargo_load|cargo_unload|location|destination)$/.test(e.field)) return;
      for (const p of [e.place, e.field === 'location' ? e.from : '', e.field === 'location' || e.field === 'destination' ? e.to : '']) { const st = placeStation(p); if (!st) continue;
        const last = mkLastTrig.get(st.id) || 0; if (Date.now() - last < C.MARKET_EVENT_DEBOUNCE_MS) continue; mkLastTrig.set(st.id, Date.now());
        dbg.script('info', `market ${st.name}: refresh (shuttle ${e.name} ${e.field})`); mkStation(st, 'shuttle ' + e.field).catch(() => {}); } });
    async function loadMyDocks() { try { data.myDocks = parseMyDocks(await cachedRead('mydocks', 'gxQueryDockingStations', {}, 120000)); data.errors.docks = null; dbg.script('debug', 'my docks owners: ' + [...new Set(data.myDocks.map(d => d.owner))].join(', ')); } catch (e) { if (e.name !== 'StaleResponseError') data.errors.docks = 'Could not load: ' + e.message; } renderAll(); }
    async function loadAllDocks() {
      if (!data.stations) await loadStations(); dkf.src = 'all'; dkTab.bar.querySelector('[data-f=src]').value = 'all';
      // two at a time (client concurrency 2 + politeness gap), progressive render
      const list = (data.stations || []).slice(); let i = 0;
      const worker = async () => { while (i < list.length) { const s = list[i++]; try { data.stationDocks.set(s.id, parseStationDocks(await cachedRead('gxInfo:' + s.id, 'gxInfo', { miKey: s.id }, 600000), s.id, s.name)); renderAll(); } catch (e) { dbg.script('warn', 'docks of ' + s.name + ': ' + e.message); } } };
      await Promise.all([worker(), worker()]);
    }
    tabOpeners.stations = () => { if (!data.stations) loadStations(); };
    tabOpeners.markets = () => { loadMarkets(); if (!data.stations) loadStations(); };
    tabOpeners.docks = () => { if (!data.myDocks) loadMyDocks(); };
    function renderLists() {
      if (activeTab === 'stations') { const q = stf.q.toLowerCase(); let r = (data.stations || []).filter(s => textMatch(q, [s.name, s.owner]) && (stf.maxUse === '' || s.usePct <= +stf.maxUse));
        r = sortRows(r, ST_COLS.find(c => c.key === stTab.vt.sort.key), stTab.vt.sort.dir); stTab.vt.setRows(r); stTab.count.textContent = data.stations ? `${r.length} of ${data.stations.length} stations` : ''; }
      if (activeTab === 'markets') { const q = mkf.q.toLowerCase(); const all = data.markets || [];
        let r = all.filter(m => textMatch(q, [m.product, m.station]) && (mkf.station === 'all' || m.station === mkf.station) && !(mkHides() && mkEmpty(m)));
        const nHidden = mkHides() ? all.filter(m => textMatch(q, [m.product, m.station]) && mkEmpty(m)).length : 0;
        r = sortRows(r, MK_COLS.find(c => c.key === mkTab.vt.sort.key), mkTab.vt.sort.dir); mkTab.vt.setRows(r); const nSt = data.mkStations.size, cached = [...data.mkStations.values()].filter(x => x.cached).length, oldest = Math.min(...[...data.mkStations.values()].map(x => x.at));
        mkTab.count.innerHTML = esc((data.markets ? `${r.length} of ${all.length} market rows · ${nSt} stations${data.stations ? ' of ' + data.stations.length : ''}${cached ? ` (${cached} from cache)` : ''}${nSt ? ' · oldest ' + fmtDur((Date.now() - oldest) / 1000) : ''}` : '')
          + (mkProg.running ? ` · ⟳ loading ${mkProg.done}/${mkProg.total}${loading.markets ? ' (market list, ' + Math.round((Date.now() - loading.markets) / 1000) + ' s)' : ''}` : ''))
          + (nHidden ? ` · <span class="gxp-hidden-cnt">${nHidden} hidden (nothing offered or requested)</span> <a href="#" data-act="mkShowHidden">show</a>` : '');
        const sel = mkTab.bar.querySelector('[data-f=station]'), names = [...new Set(all.map(m => m.station))].sort();
        syncOptions(sel, [['all', 'all stations']].concat(names.map(n => [n, n])), mkf.station); }
      if (activeTab === 'docks') { const q = dkf.q.toLowerCase(); const all = dkf.src === 'mine' ? (data.myDocks || []) : [].concat(...data.stationDocks.values());
        let r = all.filter(d => textMatch(q, [d.station, d.dock, d.owner, d.usedBy]) && (!dkf.free || !d.usedBy || d.usedBy === '-'));
        r = sortRows(r, DK_COLS.find(c => c.key === dkTab.vt.sort.key), dkTab.vt.sort.dir); dkTab.vt.setRows(r); dkTab.count.textContent = `${r.length} of ${all.length} docks` + (dkf.src === 'all' ? ` (${data.stationDocks.size} stations loaded)` : ''); }
    }
    function showStation(r) { if (!r) return; selected = null; const fresh = !X25.view || X25.view.kind !== 'station' || X25.view.r.id !== r.id; X25.view = { kind: 'station', r }; $('gxp-details').innerHTML = `<h3>${esc(r.name)} <span class="gxp-id">station ${esc(r.id)}</span></h3><table>` +
      [['Owner', r.owner], ['Position', r.position], ['Storage used', fmtN(r.storage) + ' units'], ['Use%', r.usePct + '%']].map((p, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(p[0])}</td><td class="gxpu_data">${i === 0 ? ownerLinkHtml(p[1]) : esc(p[1])}</td></tr>`).join('') + '</table>' + stationExtraHtml(r) + stationWriteHtml(r);
      if (fresh || !X25.station || X25.station.id !== r.id) loadStationExtras(r); }
    /* ---------- Transport ---------- */
    P('transport').innerHTML = `
      <div class="gxp-bar"><b>Transport products between space centers / stations</b>
        <span class="gxbutton gxp-btn" data-act="pick" role="button" tabindex="0">Load origins &amp; targets</span>
        <span id="gxp-gate" class="gxp-badge"></span></div>
      <div class="gxp-scrollbox">
        <div class="gxp-tr-grid">
          <div><h4>1. Origin (From)</h4><div class="gxp-bar"><input type="search" data-tf="o" title="Filter the origin list" placeholder="filter" size="10"></div><div class="gxp-host" data-h="o"></div></div>
          <div><h4>2. Target (To)</h4><div class="gxp-bar"><input type="search" data-tf="t" title="Filter the target list" placeholder="filter" size="10"></div><div class="gxp-host" data-h="t"></div></div>
          <div><h4>3. Product (stock at origin)</h4><div class="gxp-bar"><input type="search" data-tf="p" title="Filter the product list" placeholder="filter" size="10"></div><div class="gxp-host" data-h="p"></div></div>
        </div>
        <div class="gxp-bar" id="gxp-tr-form">
          <span id="gxp-tr-sel">Pick origin, target and product.</span>
          <label>Quantity <input id="gxp-tr-qty" title="Quantity to transport (limited to what is still available at the origin)" type="number" min="1" step="1" style="width:110px"></label>
          <span class="gxbutton gxp-btn" data-act="max" role="button" tabindex="0" title="Stock minus what active transports still have to load">max</span>
          <span class="gxbutton gxp-btn" data-act="execNow" role="button" tabindex="0" title="Send this transport request now, no confirmation (one-click; Settings)"><b>Execute now</b></span>
          <span class="gxbutton gxp-btn" data-act="add" role="button" tabindex="0">Add to queue</span>
          <span id="gxp-tr-est" class="gxp-approx"></span>
        </div>
        <div class="gxp-bar" id="gxp-tr-presets"></div>
        <div class="gxp-bar" id="gxp-tr-recur" style="display:none">
        </div>
        <h4>Queue (local, not sent)</h4>
        <div id="gxp-tr-queue"></div>
        <div class="gxp-bar">
          <span class="gxbutton gxp-btn" data-act="validate" role="button" tabindex="0" title="Re-read the live transport list and check every queued item">Validate</span>
          <span class="gxbutton gxp-btn" data-act="submit" role="button" tabindex="0">Submit all</span>
          <label><input type="checkbox" id="gxp-stop" ${settings.stopOnError ? 'checked' : ''}> stop on first error</label>
          <span class="gxbutton gxp-btn" data-act="clearDone" role="button" tabindex="0">Clear finished</span>
          <span class="gxbutton gxp-btn" data-act="saveResp" data-dev="1" role="button" tabindex="0" title="Download the last raw write response (also in the Debug export)">Save last response</span>
          <span id="gxp-tr-msg"></span>
        </div>
        <h4>Live transport list <span class="gxp-approx" id="gxp-tr-liveat"></span></h4>
        <div class="gxp-bar"><select id="gxp-trl-st" title="Show only transports with this status" aria-label="Status filter"><option value="all">all statuses</option><option value="activeonly">active only</option>${Object.entries(TR_STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
          <input type="search" id="gxp-trl-q" title="Filter the live transport list" placeholder="Filter product or route" aria-label="Filter"> <span class="gxbutton gxp-btn" data-act="validate" role="button" tabindex="0">Re-read</span>
          <span id="gxp-trl-sum"></span><span class="gxbutton gxp-btn" data-act="selVisible" role="button" tabindex="0" title="Select every cancellable row that matches the current filters">select all visible</span>
          <span class="gxbutton gxp-btn" data-act="selNone" role="button" tabindex="0">clear selection</span>
          <span class="gxbutton gxp-btn" data-act="cancelSel" role="button" tabindex="0" id="gxp-cancel-btn">Cancel selected (0)</span></div>
        <div class="gxp-host gxp-host-fixed" id="gxp-trl-host"></div>
        <h4>Routes (your shuttles)</h4><div id="gxp-tr-routes"></div>
        <h4>Results log</h4><div id="gxp-tr-results"></div>
      </div>`;
    const TP = P('transport'), trSel = { o: null, t: null, p: null }, trf = { o: '', t: '', p: '' };
    const pickCols = k => k === 'p' ? [{ key: 'name', label: 'Product', w: '62%', grow: true, html: r => prodCell(r.name, null, r.img) }, { key: 'stock', label: 'Stock', w: '38%', num: true, html: r => fmtN(r.stock) }]
      : [{ key: 'name', label: 'Name', w: '70%', html: r => aliasHtml(r.name), title: r => r.cells.join(' · ') }, { key: 'kind', label: 'Kind', w: '30%', html: r => ({ 2: 'center', 3: 'station', 4: 'dock', 5: 'depot' }[r.kind] || r.kind) }];
    const pickKey = r => r.product ? 'p' + r.product : r.kind + ':' + r.stationId + ':' + r.entityId + ':' + r.target + ':' + r.name;
    const pickers = {};
    for (const k of ['o', 't', 'p']) {
      pickers[k] = VTable(doc, TP.querySelector(`[data-h=${k}]`), pickCols(k), { id: 'pick' + k, sort: { key: 'name', dir: 1 }, rowKey: pickKey, onSort: () => renderTransport(),
        emptyHtml: () => k === 'p' ? (trSel.o && trSel.t ? '<span class="gxp-skel"></span>' : 'Pick origin and target first.') : (session.state === 'expired' ? 'Sign in to Simcountry in another tab; Galaxy Console picks the session up automatically.' : 'Press "Load origins & targets".'),
        onRowClick: key => { const list = k === 'o' ? transport.origins : k === 't' ? transport.targets : transport.products; trSel[k] = list.find(r => pickKey(r) === key) || null;
          if (k !== 'p') { trSel.p = null; transport.products = []; if (trSel.o && trSel.t) transport.loadProducts(trSel.o, trSel.t).catch(e => trMsg('Products: ' + e.message, true)); }
          if (k === 'p' && trSel.p) $('gxp-tr-qty').value = trSel.p.stock || ''; renderTransport(); } });
      app.cleanups.push(() => pickers[k].destroy());
    }
    on(TP, 'input', e => { if (e.target.dataset.tf) { trf[e.target.dataset.tf] = e.target.value.toLowerCase(); renderTransport(); } if (e.target.id === 'gxp-tr-qty') renderTransport(); });
    on(TP, 'change', e => { if (e.target.id === 'gxp-stop') { settings.stopOnError = e.target.checked; saveSettings(); } });
    const trMsg = (m, bad) => { const el = $('gxp-tr-msg'); el.textContent = m; el.className = bad ? 'gxp-warn' : 'gxp-ok'; };
    const act = async a => {
      try {
        if (a === 'pick') { await Promise.all([transport.loadOrigins(), transport.loadTargets()]); if (!transport.formCheck) transport.checkForm(); trMsg(`${transport.origins.length} origins, ${transport.targets.length} targets loaded`); }
        if (a === 'max' && trSel.p) $('gxp-tr-qty').value = trSel.o ? (transport.available(trSel.o, trSel.p) ?? trSel.p.stock ?? '') : (trSel.p.stock || '');
        if (a === 'execNow') return await executeNow();
        if (a === 'add') { if (!(trSel.o && trSel.t && trSel.p)) return trMsg('Pick origin, target and product first.', true);
          const q = Math.floor(+$('gxp-tr-qty').value || 0); if (q < 1) return trMsg('Enter a quantity.', true);
          const it = await transport.add(trSel.o, trSel.t, trSel.p, q); trMsg(it.quantity !== q ? `Quantity clamped to what is available (${fmtN(it.quantity)}).` : 'Queued.'); clearPicks(); }
        if (a === 'validate') { await transport.readLive(); transport.validate(); trMsg('Validated against a fresh transport list.'); }
        if (a === 'submit') { const n = transport.queue.filter(i => i.status === 'valid').length; if (!n) return trMsg('Nothing valid to submit. Validate first.', true);
          const vq = transport.queue.filter(i => i.status === 'valid');
          if (!(await confirmWrite({ title: 'Submit transport requests', lead: `Submit ${n} transport request(s) to Simcountry, one by one:`, okLabel: `Submit ${n}`,
            items: { head: ['From', 'To', 'Product', 'Quantity'], rows: vq.map(i => { const nm = x => (x && x.name) || ''; return [aliasOf(nm(i.origin)) || nm(i.origin), aliasOf(nm(i.target)) || nm(i.target), nm(i.product), fmtN(i.quantity)]; }) },
            debug: [{ method: 'gxAddTransportRequest', note: 'built from the live game form (gxNewTransportRequest) per request', fields: ((transport.template || {}).fields || []).map(f => [f.name + ' [' + f.type + ']', f.value]) }] }))) return;
          await transport.readLive(); transport.validate(); await transport.submitAll(); trMsg('Submit finished: see statuses and results log.'); }
        if (a === 'clearDone') await transport.clearDone();
        if (a === 'saveResp') { if (!transport.lastResponse) return trMsg('No write response yet.', true); downloadText(doc, 'galaxyplus-write-response-' + transport.lastResponse.t + '.html', transport.lastResponse.body, 'text/html;charset=utf-8'); }
        if (a === 'selVisible') { for (const r of trl.rows) if (r.cancelable && TR_STATUS[r.status].active && r.id) cancelSel.add(r.id); }
        if (a === 'selNone') cancelSel.clear();
        if (a === 'cancelSel') openCancelDialog();
      } catch (e) { trMsg(e.message, true); dbg.script('warn', 'transport action ' + a + ': ' + e.message); }
      renderTransport();
    };
    for (const el of TP.querySelectorAll('[data-act]')) onBtn(el, () => act(el.dataset.act));
    app.transportAction = act; app.trSel = trSel;
    const ST_LABEL = { draft: 'draft', valid: 'ready', invalid: 'invalid', submitting: 'sending…', 'needs-confirm': 'CONFIRMATION REQUIRED', 'dry-run': 'dry run — not sent', submitted: 'submitted', 'skipped-duplicate': 'skipped (duplicate)', failed: 'FAILED' };
    function renderTransport() { try { fitPrimary(); } catch (e) { /* before init */ }
      if (activeTab !== 'transport') return;
      const gate = writeGate(settings, transport.template);
      const g = $('gxp-gate'); g.textContent = gate.ok ? 'writes: enabled' : 'writes: off'; g.title = gate.why; g.className = 'gxp-badge ' + (gate.ok ? 'ok' : 'bad');
      const sub = TP.querySelector('[data-act=submit]'); sub.style.opacity = gate.ok && !transport.running ? 1 : 0.45; sub.title = gate.ok ? 'Send all valid queued requests, one at a time' : gate.why;
      for (const [k, list] of [['o', transport.origins], ['t', transport.targets], ['p', transport.products]]) {
        const pk = pickers[k]; let r = list.filter(x => textMatch(trf[k], [x.name, aliasOf(x.name)].concat(x.cells || [])));
        r = sortRows(r, pickCols(k).find(c => c.key === pk.sort.key), pk.sort.dir); pk.selectedKey = trSel[k] ? pickKey(trSel[k]) : null; pk.setRows(r);
      }
      $('gxp-tr-sel').innerHTML = (trSel.o || trSel.t || trSel.p) ? `<b>${trSel.o ? aliasHtml(trSel.o.name) : '?'}</b> → <b>${trSel.t ? aliasHtml(trSel.t.name) : '?'}</b>: ${esc(trSel.p ? trSel.p.name : 'pick a product')}${trSel.p ? ` (stock ${fmtN(trSel.p.stock)}${trSel.o && transport.reserved(trSel.o.name, trSel.p.name) ? `, ${fmtN(transport.reserved(trSel.o.name, trSel.p.name))} already scheduled, ${fmtN(transport.available(trSel.o, trSel.p))} available` : ''})` : ''}` : 'Pick origin, target and product.';
      const q = Math.floor(+$('gxp-tr-qty').value || 0);
      { const av = trSel.o && trSel.p ? transport.available(trSel.o, trSel.p) : null; if (av != null && q > av) $('gxp-tr-qty').value = av; }
      const est = trSel.p && q ? transport.estimate(trSel.p.name, q) : null;
      $('gxp-tr-est').textContent = est ? (est.flights ? `≈ ${est.flights} shuttle flight(s), ${est.basis}` : 'flights: ' + est.basis) : '';
      const qh = transport.queue.length ? '<table style="width:100%;border-collapse:collapse">' + transport.queue.map((it, i) => { const e = transport.estimate(it.product.name, it.quantity);
        return `<tr class="gxpu_rc${i % 2}"><td class="gxpu_data">${fmtN(it.quantity)} ${esc(it.product.name)}</td><td class="gxpu_data">${aliasHtml(it.origin.name)} → ${aliasHtml(it.target.name)}</td>
          <td class="gxpu_data">${e.flights ? '≈' + e.flights + ' flights' : 'flights unknown'}</td><td class="gxpu_data ${it.status === 'failed' || it.status === 'invalid' ? 'gxp-warn' : ''}"><b>${ST_LABEL[it.status] || it.status}</b> ${esc(it.issues.join('; '))} ${esc(it.message || '')}</td>
          <td class="gxpu_data"><span class="gxbutton gxp-btn" data-rm="${it.qid}" role="button" tabindex="0">remove</span> <span class="gxbutton gxp-btn" data-pv="${it.qid}" role="button" tabindex="0" title="Show the exact request">request</span>${it.status === 'needs-confirm' ? ` <span class="gxbutton gxp-btn" data-cf="${it.qid}" role="button" tabindex="0" title="The game asked for a confirmation. Confirm, then press Submit all again.">Confirm</span>` : ''}</td></tr>`; }).join('') + '</table>' : '<p class="gxpu_text">Queue is empty.</p>';
      /* 3.0.6: the queue was rebuilt via innerHTML on every redraw (~3×/s while shuttle details load), so a click whose
       * mousedown and mouseup straddled a rebuild was lost. Rebuild only when the markup changed; buttons act on pointerdown. */
      { const qe = $('gxp-tr-queue'); if (qe._gxpH !== qh) { qe._gxpH = qh; qe.innerHTML = qh; } }
      renderLive(); /* old: */ if (0) $('gxp-tr-live').innerHTML = transport.live.length ? '<table style="width:100%">' + transport.live.map((r, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_data">${esc(r.product)}</td><td class="gxpu_data n">${fmtN(r.quantity)}</td><td class="gxpu_data">${esc(r.origin)} → ${esc(r.target)}</td><td class="gxpu_data">${esc(r.loaded)}</td><td class="gxpu_data">${esc(r.status)}</td></tr>`).join('') + '</table>' : '<p class="gxpu_text">' + (transport.liveAt ? 'No transports running.' : 'Not read yet (Validate reads it).') + '</p>';
      $('gxp-tr-liveat').textContent = transport.liveAt ? 'read ' + fmtTime(transport.liveAt) : '';
      $('gxp-tr-results').innerHTML = transport.results.length ? '<table style="width:100%">' + transport.results.slice(-50).reverse().map((r, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_data">${fmtTime(r.t)}</td><td class="gxpu_data">${esc(r.outcome)}</td><td class="gxpu_data">${fmtN(r.quantity)} ${esc(r.product)} ${esc(r.origin)} → ${esc(r.target)}</td><td class="gxpu_data">${esc(r.message)}</td></tr>`).join('') + '</table>' : '<p class="gxpu_text">No submissions yet.</p>';
    }
    /* 3.0.2: barOnly was referenced by the Loaded % / Delivered % columns since 0.2.8.0 but never defined, so the
     * Transport table threw "barOnly is not defined" as soon as the live list had rows and never redrew. */
    const barOnly = (v, of) => v == null || !of ? '' : `<span class="gxp-pbar"><i style="width:${Math.max(0, Math.min(100, Math.round(v / of * 100)))}%"></i></span>`;
    const pbar = (v, of) => v == null ? '' : `<span class="gxp-bar-pct" title="${fmtN(v)} of ${fmtN(of)}"><i style="width:${of ? Math.min(100, Math.round(v / of * 100)) : 0}%"></i></span>${fmtN(v)}`;
    const cancelSel = new Set();
    const TRL_COLS = [
      { key: 'sel', label: '✓', w: '3%', min: 24, max: 30, sortVal: r => (cancelSel.has(r.id) ? 0 : 1), html: r => transport.canTryCancel(r) ? `<input type="checkbox" title="Select for Cancel selected" data-cx="${esc(r.id)}" ${cancelSel.has(r.id) ? 'checked' : ''} aria-label="select for cancel">` : '' },
      { key: 'status', label: 'Status', w: '13%', min: 90, max: 170, sortVal: r => ['waiting', 'new', 'transit', 'unknown', 'finished', 'aborted'].indexOf(r.status) * 1000 - (r.pct || 0),
        html: r => `<span class="gxp-st" style="color:${TR_STATUS[r.status].color}">${TR_STATUS[r.status].icon} ${esc(r.statusLabel)}</span>`, title: r => ({ waiting: 'Transport still not started: no shuttle available at the origin. Click for diagnosis.', new: 'Transport scheduled, waiting for the next game tick', transit: 'In transport', finished: 'Transport finished', aborted: 'Transport aborted' }[r.status] || '') },
      { key: 'product', label: 'Product', w: '20%', grow: true, html: r => prodCell(r.product, r.productId, r.productIcon), title: r => r.product + (r.productId != null ? ' (product ' + r.productId + ')' : '') },
      { key: 'quantity', label: 'Qty', w: '7%', num: true, max: 90, html: r => fmtN(r.quantity) },
      { key: 'route', label: 'Route', w: '27%', grow: true, sortVal: r => r.origin + '→' + r.target, html: r => `${aliasHtml(r.origin)} → ${aliasHtml(r.target)}`, title: r => r.origin + ' → ' + r.target },
      { key: 'loaded', label: 'Loaded', w: '6%', num: true, max: 80, html: r => fmtN(r.loaded) },
      { key: 'loadedBar', label: 'Loaded %', w: '5%', min: 40, max: 70, sortVal: r => r.quantity ? r.loaded / r.quantity : 0, html: r => barOnly(r.loaded, r.quantity), title: r => r.quantity ? Math.round(100 * (r.loaded || 0) / r.quantity) + '% loaded' : '' },
      { key: 'delivered', label: 'Delivered', w: '6%', num: true, max: 80, html: r => fmtN(r.delivered) },
      { key: 'deliveredBar', label: 'Delivered %', w: '5%', min: 40, max: 70, sortVal: r => r.quantity ? r.delivered / r.quantity : 0, html: r => barOnly(r.delivered, r.quantity), title: r => r.quantity ? Math.round(100 * (r.delivered || 0) / r.quantity) + '% delivered' : '' },
      { key: 'cancelable', label: 'Cancel', w: '8%', min: 56, max: 80, sortVal: r => transport.canTryCancel(r) ? (r.cancelable ? 0 : 1) : 2,
        html: r => transport.canTryCancel(r) ? `<span class="gxbutton gxp-btn gxp-cx1" data-cx1="${esc(r.id)}" role="button" tabindex="0" title="${r.cancelable ? 'Cancel this transport (asks for confirmation)' : 'Already underway (no red X in the game): the request is sent once and the game\'s reply shown'}">Cancel${r.cancelable ? '' : '*'}</span>` : '<span class="gxp-approx">—</span>' } ];
    const trl = VTable(doc, $('gxp-trl-host'), TRL_COLS, { id: 'trlist', sort: { key: 'status', dir: 1 }, rowKey: r => r.id || routeKey(r.product, r.origin, r.target), onSort: () => renderTransport(),
      emptyHtml: () => transport.liveAt ? 'No transport matches.' : 'Not read yet.', rowClass: r => TR_STATUS[r.status].active ? '' : 'stale', onRowClick: (k, e) => { const b1 = e && e.target && e.target.closest && e.target.closest('[data-cx1]'); if (b1) { openCancelDialog([b1.dataset.cx1]); return; } if (e && e.target && e.target.matches && e.target.matches('input[data-cx]')) { const id = e.target.dataset.cx; if (e.target.checked) cancelSel.add(id); else cancelSel.delete(id); renderTransport(); return; }
        showTransport(transport.live.find(r => (r.id || routeKey(r.product, r.origin, r.target)) === k)); } });
    (app.vts || (app.vts = {})).transport = { list: () => [trl, ...Object.values(pickers)] }; // 3.1.3: Reset filters resets these sorts
    /* 3.0.4: cancel uses the normal confirmation dialog ALWAYS (also when "Execute now" is on); one-by-one, stops at the
     * first failure, list re-read after each to verify; dry run respected (client.writeUrl). */
    async function openCancelDialog(only) {
      const ids = only || [...cancelSel], items = transport.live.filter(r => ids.indexOf(r.id) >= 0 && transport.canTryCancel(r));
      if (!items.length) return trMsg('Select transports to cancel first (checkboxes in the list).', true);
      const g = transport.cancelGate(); if (!g.ok) return trMsg(g.why, true);
      if (transport.running) return trMsg('Busy: another send is running.', true);
      const under = items.filter(r => !r.cancelable).length;
      const ok = await confirmWrite({ title: items.length > 1 ? `Cancel ${items.length} transports` : 'Cancel transport', okLabel: items.length > 1 ? `Cancel ${items.length}` : 'Cancel transport',
        lead: `Cancel ${items.length} transport request(s), one by one, stopping at the first problem:`,
        items: { head: ['Status', 'Product', 'Qty', 'Route', 'Loaded / delivered'], rows: items.map(r => [r.statusLabel + (r.cancelable ? '' : ' (underway)'), r.product, fmtN(r.quantity), r.origin + ' → ' + r.target, fmtN(r.loaded) + ' / ' + fmtN(r.delivered)]) },
        notes: ['Same as the game\'s red X + "Abort this Transport?". The list is re-read before and after each to verify. Nothing is retried.'].concat(under ? [`${under} already underway (no red X in the game): the request is sent once and the game's reply is shown as-is.`] : []),
        debug: items.map(r => ({ method: 'GET /cgi-bin/cgip?gxDelTransportRequest&miKey=' + r.id, note: 'step 1; step 2 = the game\'s confirm form, if it shows one' })) });
      if (!ok) return trMsg('Cancel not sent.');
      trMsg('cancelling…');
      try {
        const res = await transport.cancelSelected(items.map(r => r.id));
        for (const r of res) if (r.outcome === 'cancelled' || r.outcome === 'skipped-gone') cancelSel.delete(r.id);
        const bad = res.find(r => r.outcome === 'failed'), dry = res.filter(r => r.outcome === 'dry-run');
        trMsg(dry.length ? `dry run — not sent: ${dry.map(r => r.message).join(' | ')}` : `cancel: ${res.filter(r => r.outcome === 'cancelled').length} cancelled, ${res.filter(r => /^skipped/.test(r.outcome)).length} skipped, ${res.filter(r => r.outcome === 'failed').length} failed${bad ? ' — stopped. Game reply: ' + bad.message : ''}`, !!bad);
        app.lastCancel = res;
      } catch (e) { trMsg(e.message, true); }
      renderTransport();
    }
    app.openCancelDialog = openCancelDialog; app.cancelSel = cancelSel; app.trlVT = trl;
    app.cleanups.push(() => trl.destroy());
    const trlf = { st: 'all', q: '' };
    on($('gxp-trl-st'), 'change', e => { trlf.st = e.target.value; renderTransport(); }); on($('gxp-trl-q'), 'input', e => { trlf.q = e.target.value.toLowerCase(); renderTransport(); });
    function renderLive() {
      const rows = sortRows(transport.live.filter(r => (trlf.st === 'all' || r.status === trlf.st || (trlf.st === 'activeonly' && TR_STATUS[r.status].active)) && textMatch(trlf.q, [r.product, r.origin, r.target, r.statusLabel])), TRL_COLS.find(c => c.key === trl.sort.key), trl.sort.dir);
      trl.setRows(rows);
      const cnt = {}; for (const r of transport.live) cnt[r.status] = (cnt[r.status] || 0) + 1;
      { const b = $('gxp-cancel-btn'); const live = new Set(transport.live.map(r => r.id)); for (const id of [...cancelSel]) if (!live.has(id)) cancelSel.delete(id); b.textContent = `Cancel selected (${cancelSel.size})`; b.style.opacity = cancelSel.size ? 1 : 0.45; }
      $('gxp-trl-sum').innerHTML = Object.keys(TR_STATUS).filter(k => cnt[k]).map(k => `<span class="gxp-st" style="color:${TR_STATUS[k].color}">${TR_STATUS[k].icon} ${cnt[k]} ${TR_STATUS[k].label}</span>`).join(' · ');
      const routes = routeOverview(tracker.ships.values(), transport.live, meSet());
      $('gxp-tr-routes').innerHTML = routes.length ? '<table class="gxp-mini"><tr class="gxpu_rc0"><th>Route</th><th>Active requests</th><th>Loaded en route</th><th>Empty to origin</th><th>Idle at origin</th><th>Retired at origin</th></tr>' +
        routes.map((x, i) => `<tr class="gxpu_rc${(i + 1) % 2}"><td title="${esc(x.products.join(', '))}">${esc(x.origin)} → ${esc(x.target)}</td><td>${x.requests}${x.waiting ? ` <span class="gxp-warn">(${x.waiting} waiting)</span>` : ''}</td><td>${x.loadedEnRoute}</td><td>${x.emptyToOrigin}</td><td>${x.idleAtOrigin}</td><td>${x.retiredAtOrigin}</td></tr>`).join('') + '</table>'
        : '<p class="gxpu_text">No active transport routes.</p>';
    }
    async function showTransport(r) {
      if (!r) return; selected = null;
      const box = $('gxp-details'), diag = r.status === 'waiting' ? shipDiagnostics(tracker.ships.values(), r, meSet()) : null;
      const shipList = l => l.map(s => `${esc(s.name)} <span class="gxp-id">#${s.id.slice(-6)}</span>`).join(', ');
      const head = `<h3 style="color:${TR_STATUS[r.status].color}">${TR_STATUS[r.status].icon} ${esc(r.statusLabel)}: ${fmtN(r.quantity)} ${esc(r.product)}</h3><p class="gxpu_text">${esc(r.origin)} → ${esc(r.target)} · loaded ${pbar(r.loaded, r.quantity)} · delivered ${pbar(r.delivered, r.quantity)}</p>` +
        (diag ? `<div class="gxp-dialog" style="position:static;box-shadow:none;max-width:none"><b>Why is it waiting?</b><br>${esc(diag.hint)}<br>
          Idle at origin: ${diag.idle.length ? shipList(diag.idle) : 'none'}<br>On the way to origin: ${diag.enroute.length ? shipList(diag.enroute) : 'none'}<br>Retired at origin: ${diag.retired}
          <br><span class="gxp-approx">Based on ${diag.known} shuttles of yours that Galaxy Console has seen.</span></div>` : '') +
        (transport.canTryCancel(r) ? '<p class="gxp-approx">Cancel: use the Cancel button in the list row (asks for confirmation).</p>' : '');
      box.innerHTML = head + (r.id ? '<p><span class="gxp-skel"></span> loading transport info…</p>' : '');
      if (!r.id) return;
      try { const inf = await transport.loadInfo(r.id); if (inf.expired) throw new Error('not signed in'); learnOwner(inf.info.Owner, 'your transport info', inf.info._ownerKey);
        box.innerHTML = head + '<table class="gxp-mini">' + Object.entries(inf.info).map(([k, v], i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(k)}</td><td class="gxpu_data">${esc(v)}</td></tr>`).join('') + '</table>' +
          (inf.logs.length ? '<p class="gxpu_text"><b>Logbook</b></p><table class="gxp-mini">' + inf.logs.map((l, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_data">${esc(l.when)}</td><td class="gxpu_data">${esc(l.text)}</td></tr>`).join('') + '</table>' : '');
      } catch (e) { if (e.name !== 'StaleResponseError') box.insertAdjacentHTML('beforeend', `<p class="gxp-warn">Transport info failed: ${esc(e.message)}</p>`); }
    }
    app.showTransport = showTransport;
    // learn the owner name once from one of the user's own transports (one read-only info request)
    transport.subscribe(() => { if (!owner.names.size && !app._ownerProbe && transport.live.some(r => r.id)) { app._ownerProbe = true;
      transport.loadInfo(transport.live.find(r => r.id).id).then(i => { if (i && i.info) learnOwner(i.info.Owner, 'your transport info', i.info._ownerKey); else dbg.script('info', 'owner probe: transport info had no Owner'); }).catch(e => { app._ownerProbe = false; dbg.script('debug', 'owner probe failed: ' + e.message); }); } });
    // 0.2.4: probe at start-up (read-only transport list) instead of waiting for the Transport tab
    session.subscribe(state => { if (state === 'ok' && !owner.names.size && !app._ownerListRead) { app._ownerListRead = true; dbg.script('info', 'owner unknown: reading your transport list once to learn it');
      transport.readLive().then(() => { if (!transport.live.some(r => r.id)) dbg.script('info', 'owner probe: no transports in your list; set your name in Settings if "mine" stays empty'); }).catch(e => { app._ownerListRead = false; dbg.script('debug', 'owner probe list failed: ' + e.message); }); } });
    every(() => { if (activeTab === 'transport' && session.state === 'ok' && !transport.running && Date.now() - transport.liveAt > 60000) transport.readLive().catch(() => {}); }, 15000);
    const queueAct = async (rm, cf) => { if (cf) { await transport.confirmItem(cf.dataset.cf); renderTransport(); } if (rm) { const p = transport.remove(rm.dataset.rm); renderTransport(); await p; } };
    on(TP, 'pointerdown', e => { if (e.button) return; const rm = e.target.closest('[data-rm]'), cf = e.target.closest('[data-cf]'); if (!rm && !cf) return; e.preventDefault(); queueAct(rm, cf); });
    on(TP, 'keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const rm = e.target.closest('[data-rm]'), cf = e.target.closest('[data-cf]'); if (!rm && !cf) return; e.preventDefault(); queueAct(rm, cf); });
    on(TP, 'click', async e => { const pv = e.target.closest('[data-pv]');
      if (!e.detail) { const rm = e.target.closest('[data-rm]'), cf = e.target.closest('[data-cf]'); if (rm || cf) await queueAct(rm, cf); } // keyboard activation (Enter/Space) only; mouse handled on pointerdown
      if (pv) { const it = transport.queue.find(i => i.qid === pv.dataset.pv); let u; try { u = transport.preview(it); } catch (x) { u = x.message; }
        $('gxp-details').innerHTML = `<h3>Request that "Submit all" would send</h3><p class="gxpu_text">XHR <b>POST</b> (empty body), like the original gxSendTransportForm → gxObjectFrame:</p><pre style="white-space:pre-wrap;word-break:break-all">${esc(u)}</pre><p class="gxpu_text">${esc(writeGate(settings, transport.template).why)}</p>`; } });
    transport.subscribe(() => renderTransport());
    tabOpeners.transport = () => { if (!transport.origins.length && session.state !== 'expired') act('pick'); /* 3.0.2: Refresh on this tab re-reads the live transport list */ if (session.state !== 'expired' && !transport.running) transport.readLive().then(() => renderTransport()).catch(e => dbg.script('debug', 'transport list refresh: ' + e.message)); };

    /* ---------- Events ---------- */
    const EV_COLS = [{ key: 't', label: 'Time', w: '15%', num: true, min: 110, max: 130, html: e => fmtTime(e.t) }, { key: 'name', label: 'Shuttle', w: '15%', grow: true, min: 110, title: e => 'ID ' + e.ship }, { key: 'owner', label: 'Owner', w: '13%', html: e => ownerLinkT(e.owner) },
      { key: 'field', label: 'Change', w: '12%' }, { key: 'from', label: 'From', w: '18%', grow: true }, { key: 'to', label: 'To', w: '18%', grow: true, min: 140 }, { key: 'source', label: 'Source', w: '9%' }];
    const evTab = listTab('events', `<input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter shuttle, owner, value" aria-label="Text filter">
      <select data-f="field" title="Show only events of this kind" aria-label="Change"><option value="all">all changes</option>${TRACKED.concat(['registered', 'flight', 'trip_start', 'arrived', 'cargo_load', 'cargo_unload', 'log']).map(f => `<option>${f}</option>`).join('')}</select>
      <select data-f="owner" title="Show only rows from this owner"><option value="all">all owners</option><option value="mine">mine</option></select>
      <span class="gxbutton gxp-btn" data-act="expShips" role="button" tabindex="0" title="Shuttle register: details, cargo, flight, full logbook per shuttle">Export shuttles CSV</span>
      <span class="gxbutton gxp-btn" data-act="exp" role="button" tabindex="0" title="Full saved history from the browser database: every recorded change, logbook line, cargo load/offload, derived trips">Export events CSV</span> <span class="gxbutton gxp-btn" data-act="expMem" role="button" tabindex="0" title="Export only the events currently in memory (the rows this tab can show, up to the Events log rows limit; ignores the filter), same CSV format">Export in-memory events</span>
      <label class="gxbutton gxp-btn" title="Either CSV (or an old 0.2.x one); merged, duplicates skipped">Import CSV <input type="file" accept=".csv,text/csv" data-act="imp" title="Import a Galaxy Console shuttles or events CSV" style="display:none"></label>`, EV_COLS,
      { sort: { key: 't', dir: -1 }, rowKey: e => e.dk, onRowClick: k => { const e = tracker.events.find(x => x.dk === k); if (e) select(e.ship, true); }, emptyHtml: () => 'No events yet. Every poll compares each shuttle with its previous state.' });
    const evf = { q: '', field: 'all', owner: 'all' };
    const evIn = e => { const f = e.target.dataset.f; if (f) { evf[f] = e.target.value; renderAll(); } };
    on(evTab.bar, 'input', evIn); on(evTab.bar, 'change', evIn);
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    onBtn(evTab.bar.querySelector('[data-act=expMem]'), async () => { const mem = tracker.events.length > tracker.eventLimit ? tracker.events.slice(-tracker.eventLimit) : tracker.events.slice();
      const parts = await tracker.exportEventsParts(mem); downloadParts(doc, 'galaxyplus-events-memory-' + stamp() + '.csv', parts, 'text/csv;charset=utf-8'); dbg.script('info', `events export (in memory): ${mem.length} events`); }); // 3.0.10
    onBtn(evTab.bar.querySelector('[data-act=exp]'), async () => { evTab.count.textContent = 'exporting…'; const parts = await tracker.exportEventsParts(null, { onProgress: n => { evTab.count.textContent = `exporting… ${fmtN(n)} events`; } }); downloadParts(doc, 'galaxyplus-events-' + stamp() + '.csv', parts, 'text/csv;charset=utf-8'); dbg.script('info', `events CSV exported (streamed: ${tracker.lastExport.events} events in ${parts.length} parts)`); }); // 3.1.0 streaming
    onBtn(evTab.bar.querySelector('[data-act=expShips]'), async () => { const csv = await tracker.exportShipsCSV(); downloadText(doc, 'galaxyplus-shuttles-' + stamp() + '.csv', csv, 'text/csv;charset=utf-8'); dbg.script('info', 'shuttles CSV exported (' + csv.length + ' chars)'); });
    on(evTab.bar.querySelector('[data-act=imp]'), 'change', async e => { const f = e.target.files[0]; if (!f) return; try { const r = await tracker.importCSV(await f.text()); evTab.count.textContent = 'Imported: ' + safeJson(r); } catch (x) { evTab.count.textContent = 'Import failed: ' + x.message; } e.target.value = ''; renderAll(); });
    function renderEvents() {
      const q = evf.q.toLowerCase();
      const evAll = tracker.events.length > tracker.eventLimit ? tracker.events.slice(-tracker.eventLimit) : tracker.events; // 3.0.9: view = newest <limit> rows
      let r = evAll.filter(e => (evf.field === 'all' || e.field === evf.field) && (evf.owner === 'all' || isMine(e.owner, e.ownerKey)) && textMatch(q, [e.name, e.owner, e.from, e.to, e.ship]));
      r = sortRows(r, EV_COLS.find(c => c.key === evTab.vt.sort.key), evTab.vt.sort.dir); evTab.vt.setRows(r);
      if (!/^Imported|^Import failed/.test(evTab.count.textContent)) evTab.count.textContent = `${r.length} of ${evAll.length} events in memory (all are in IndexedDB)`;
    }

    /* ---------- Debug ---------- */
    const DB_COLS = [{ key: 'n', label: '#', w: '6%', num: true, max: 60 }, { key: 't', label: 'Time', w: '14%', num: true, min: 110, max: 130, html: e => fmtTime(e.t) }, { key: 'channel', label: 'Channel', w: '8%' }, { key: 'level', label: 'Level', w: '7%' },
      { key: 'msg', label: 'Message', w: '65%', grow: true, min: 300, html: e => esc(e.msg) + (e.dataText !== undefined ? ' <span class="gxp-id">' + esc(e.dataText.length > 2000 ? e.dataText.slice(0, 2000) + '…' : e.dataText) + '</span>' : ''), title: e => e.msg }];
    const dbTab = listTab('debug', `<select data-f="channel" title="Debug log source"><option value="all">both channels</option><option value="net">network</option><option value="script">script</option></select>
      <select data-f="level" title="Minimum debug level to show"><option value="debug">debug+</option><option value="info">info+</option><option value="warn">warn+</option><option value="error">error</option></select>
      <span class="gxbutton gxp-btn" data-act="exp" role="button" tabindex="0">Export text</span>
      <span class="gxbutton gxp-btn" data-act="copyAll" role="button" tabindex="0" title="Copy the whole debug log (all channels and levels) to the clipboard">Copy all</span>
      <span class="gxbutton gxp-btn" data-act="copy500" role="button" tabindex="0" title="Copy the newest 500 lines (all channels and levels) to the clipboard">Copy last 500</span> <span class="gxbutton gxp-btn" data-act="exp500" role="button" tabindex="0" title="Download the newest 500 lines (all channels and levels) as a .txt file">Export last 500</span>`, DB_COLS, { sort: { key: 'n', dir: -1 }, rowKey: e => String(e.n) });
    const dbf = { channel: 'all', level: settings.debugLevel || 'info' }; dbTab.bar.querySelector('[data-f=level]').value = dbf.level;
    on(dbTab.bar, 'change', e => { const f = e.target.dataset.f; if (f) { dbf[f] = e.target.value; if (f === 'level') { settings.debugLevel = dbf.level; saveSettings(); } renderAll(); } });
    const chunkParts = (ch, lv, last) => { const p = []; for (const c of dbg.textChunks(ch, lv, last)) { if (p.length) p.push('\n'); p.push(c); } return p; }; // 3.1.5: no single giant string
    onBtn(dbTab.bar.querySelector('[data-act=exp]'), () => downloadText(doc, 'galaxyplus-debug.txt', chunkParts(dbf.channel, dbf.level)));
    const copyLog = async n => { const lines = n ? dbg.entries('all', 'debug').slice(-n) : dbg.entries('all', 'debug'); const text = chunkParts('all', 'debug', n || 0).join('');
      const how = await copyText(doc, text); dbTab.count.textContent = how ? `copied ${lines.length} lines (${how})` : 'copy failed: use Export text'; dbg.script(how ? 'info' : 'warn', `debug log copy: ${lines.length} lines via ${how || 'nothing'}`); };
    onBtn(dbTab.bar.querySelector('[data-act=copyAll]'), () => copyLog(0)); onBtn(dbTab.bar.querySelector('[data-act=copy500]'), () => copyLog(500));
    onBtn(dbTab.bar.querySelector('[data-act=exp500]'), () => { const lines = dbg.entries('all', 'debug').slice(-500); downloadText(doc, `galaxy-console-debug-last500-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`, chunkParts('all', 'debug', 500), 'text/plain'); dbg.script('info', `debug log export: last ${lines.length} lines`); }); // 3.0.6
    /* 3.0.9: reset buttons (in-memory views only), each with a simple confirm */
    const askOk = m => (typeof opts.confirm === 'function' ? !!opts.confirm(m) : W.confirm(m));
    dbTab.bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="dbgReset" role="button" tabindex="0" title="Clear the debug log kept in memory (export it first if you need it)">Reset log</span>');
    onBtn(dbTab.bar.querySelector('[data-act=dbgReset]'), () => { if (askOk('Clear the debug log in memory?')) { dbg.reset(); renderAll(); } });
    evTab.bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="evReset" role="button" tabindex="0" title="Clear the events list kept in memory (this view). Saved history in the browser database and the events CSV export is NOT deleted.">Reset view</span>');
    onBtn(evTab.bar.querySelector('[data-act=evReset]'), () => { if (askOk('Clear the events list in memory? Saved history is kept.')) { tracker.resetEvents(); renderAll(); } });
    let dbgDirty = false; app.cleanups.push(dbg.subscribe(() => { dbgDirty = true; }));
    function renderDebug() { const r = sortRows(dbg.entries(dbf.channel, dbf.level), DB_COLS.find(c => c.key === dbTab.vt.sort.key), dbTab.vt.sort.dir); dbTab.vt.setRows(r); if (!/^cop/.test(dbTab.count.textContent) || Date.now() - (dbTab._ct || 0) > 4000) { dbTab.count.textContent = `${r.length} of ${dbg.size()} entries (ring of ${LIMITS.DEBUG_RING})`; } }
    every(() => { if (dbgDirty && activeTab === 'debug') { dbgDirty = false; renderDebug(); } }, 1000);

    /* ---------- details ---------- */
    let selected = null;
    function renderDetails() {
      const s = tracker.ships.get(selected); if (!s) return;
      { const ae = doc.activeElement; if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) && $('gxp-details').contains(ae) && !renderDetails.force) return; } // 0.2.6: never re-render under the user's typing
      const d = s.detail, row = (k, v, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(k)}</td><td class="gxpu_data">${v}</td></tr>`;
      let h = `<h3 class="gxpu_header">${esc(s.name)} <span class="gxp-id">ID ${s.id}</span></h3>`;
      if (!d) h += s.detailError ? `<p class="gxp-warn">Details failed: ${esc(s.detailError)}. Will retry.</p>` : '<p><span class="gxp-skel"></span></p>';
      h += '<table>' + [['Owner', ownerLinkHtml(s.owner, s.ownerKey)], ['Position', worldLinks(s.location)], ['Destination', s.destination ? worldLinks(s.destination) : '-'], ['Status', esc(s.status) + (s.stale ? ' (stale: not on map or list)' : '')],
        ['Cargo', s.cargo != null ? fmtN(s.cargo) + ' units' + (d && d.capacity ? ' of ' + fmtN(d.capacity) : '') : ''], ['Life expectancy', s.missions != null ? fmtN(s.missions) + ' missions' : ''],
        ['Map position', s.x != null ? `GDS ${Math.round(s.x)}, ${Math.round(s.y)}${s.onMap ? '' : ' (not on current map layer)'}` : 'unknown'],
        ['First / last seen', fmtTime(s.firstSeen) + ' / ' + fmtTime(s.lastSeen)], ['Details read', s.detailAt ? fmtTime(s.detailAt) + ', next ≈ ' + fmtDur(Math.max(0, (s.nextDueAt - Date.now()) / 1000)) : '']].map((p, i) => row(p[0], p[1], i)).join('') + '</table>';
      if (d && d.flight) h += `<p class="gxpu_text"><b>Flight:</b> to ${esc(d.flight.target)}, ${fmtN(d.flight.distanceMiles)} miles, ${tuApprox(d.flight.sinceTu)} since departure, arrival in ${tuApprox(d.flight.arrivalTu)}. <span class="gxp-approx">(real times approximate, ${settings.tuSeconds} s/tu)</span> ${esc(d.flightNote || '')}</p>`;
      else if (d && d.noFlight) h += '<p class="gxpu_text">No flight scheduled.</p>';
      if (d && d.logs && d.logs.length) h += '<p class="gxpu_text"><b>Logbook</b> (server time)</p><table>' + d.logs.map((l, i) => row(l.when, esc(l.text), i)).join('') + '</table>';
      const evs = tracker.events.filter(e => e.ship === s.id).slice(-15).reverse();
      if (evs.length) h += '<p class="gxpu_text"><b>Recent changes seen by Galaxy Console</b></p><table>' + evs.map((e, i) => row(fmtTime(e.t), esc(e.field) + ': ' + esc(e.from) + ' → ' + esc(e.to), i)).join('') + '</table>';
      h += shipExtraHtml(s) + shipWriteHtml(s); X25.view = null;
      $('gxp-details').innerHTML = h;
    }

    /* ---------- map ---------- */
    const mapEl = $('gxp-map'), wrap = $('gxp-mapwrap'), marker = $('gxp-marker');
    let scale = 1, drawnVer = -1, mapVer = 0, globes = [], stationsL = [];
    const DOCKED_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.6" fill="#ffd54a" stroke="#3a2c00" stroke-width="1.2"/></svg>');
    function renderMap() {
      const ms = mapShips(), md = mapDocked(), msKey = ms.map(s => s.id + ':' + s.mapObj.left + ',' + s.mapObj.top + (s.mapMiss ? 'm' : '')).join('|') + '#' + md.map(s => s.id + ':' + Math.round(s.x) + ',' + Math.round(s.y)).join('|'); // 0.2.7: list filters drive the map; 3.1.4: + idle/docked
      if (msKey !== renderMap.key) { renderMap.key = msKey; mapVer++; }
      if (drawnVer !== mapVer) { drawnVer = mapVer;
        for (const n of [...mapEl.querySelectorAll('img.obj')]) n.remove();
        const frag = doc.createDocumentFragment();
        const add = (o, cls, z, title, id) => { const i = doc.createElement('img'); i.className = 'obj ' + cls; i.src = o.icon; i.alt = title; i.title = title;
          i.style.cssText = `left:${o.left}px;top:${o.top}px;width:${o.w}px;height:${o.h}px;z-index:${z}`; if (id) i.dataset.id = id; frag.appendChild(i); };
        for (const g of globes) add(g, 'globe', 3, g.name + ' (click: world info)', g.id); for (const s of stationsL) add(s, 'station', 4, s.name + ' (click: station details)', s.id);
        for (const s of md) add({ icon: DOCKED_ICON, left: s.x - 5, top: s.y - 5, w: 10, h: 10 }, 'shipd', 5, s.name + ' (' + s.owner + ') — ' + (s.status || 'idle') + (s.location ? ' at ' + s.location : '') + ' (not on the map layer: position from the shuttle list)', s.id);
        for (const s of ms) { add(s.mapObj, 'ship', 6, s.name + ' (' + s.owner + ')' + (s.mapMiss ? ` — last known position (missing from ${s.mapMiss} map refresh${s.mapMiss > 1 ? 'es' : ''})` : ''), s.id); if (s.mapMiss) frag.lastChild.style.opacity = '0.45'; }
        mapEl.appendChild(frag); }
      const s = tracker.ships.get(selected);
      if (!s || s.x == null) marker.style.display = 'none'; else marker.style.cssText = `display:block;left:${s.x - 10}px;top:${s.y - 34}px`;
    }
    function centerOn(x, y) { wrap.scrollLeft = Math.max(0, x * scale - wrap.clientWidth / 2); wrap.scrollTop = Math.max(0, y * scale - wrap.clientHeight / 2); }
    function setScale(k) { const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / scale, cy = (wrap.scrollTop + wrap.clientHeight / 2) / scale; scale = Math.max(0.25, Math.min(6, k)); mapEl.style.transform = `scale(${scale})`; centerOn(cx, cy); }
    app.setScale = setScale; app.getScale = () => scale;
    let drag = null;
    on(wrap, 'pointerdown', e => { if (e.target.closest('#gxp-maptools')) return; drag = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false }; });
    on(W, 'pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; wrap.scrollLeft = drag.sl - dx; wrap.scrollTop = drag.st - dy; });
    on(W, 'pointerup', e => { if (drag && !drag.moved) { const t = e.target.closest && e.target.closest('img.ship,img.shipd'); if (t) select(t.dataset.id, false, true); const gl = e.target.closest && e.target.closest('img.globe'); if (gl && gl.dataset.id) showWorld(gl.dataset.id); const st = e.target.closest && e.target.closest('img.station'); if (st && st.dataset.id) openStationFromMap(st.dataset.id, st.title.replace(/ \(click.*$/, '')); } drag = null; });
    on(wrap, 'wheel', e => { e.preventDefault(); setScale(scale * (e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)); }, { passive: false });
    onBtn($('gxp-zin'), () => setScale(scale * ZOOM_FACTOR)); onBtn($('gxp-zout'), () => setScale(scale / ZOOM_FACTOR));

    function select(id, center, fromMap) {
      selected = id; const s = tracker.ships.get(id); if (!s) return;
      if (s.x != null && (center || fromMap)) centerOn(s.x, s.y);
      if (fromMap) { if (activeTab !== 'ships') showTab('ships'); shipsTab.vt.selectedKey = id; shipsTab.vt.scrollToKey(id); }
      s.nextDueAt = 0; pumpDetails(); renderAll();
    }
    app.select = select; app.centerOn = centerOn;

    /* 3.0.7: underline country/owner name links while clickable names + 'also in tables' are on (live) */
    function applyExtUl() { root.classList.toggle('gxp-extul', settings.linkNames !== false && settings.linkNamesTables !== false); }
    applyExtUl(); app.applyExtUl = applyExtUl;
    /* ---------- splitters ---------- */
    /** Pane splitter. 3.0.3: optional o = { min, max, set(px) } so the same drag code also sizes stacked lists (height). */
    function splitter(bar, target, axis, o) {
      on(bar, 'pointerdown', e => { e.preventDefault(); const start = axis === 'x' ? e.clientX : e.clientY, r = target.getBoundingClientRect(), size = axis === 'x' ? r.width : r.height;
        const total = o ? 0 : axis === 'x' ? $('gxp-main').clientWidth : $('gxp-side').clientHeight;
        const lo = o ? o.min : 120, hi = o ? Math.max(o.min, typeof o.max === 'function' ? o.max() : o.max) : total - 160;
        const mv = ev => { const px = Math.max(lo, Math.min(hi, size + (axis === 'x' ? ev.clientX : ev.clientY) - start)); if (o) o.set(px); else target.style.flexBasis = px + 'px'; };
        const up = () => { W.removeEventListener('pointermove', mv); W.removeEventListener('pointerup', up); bar.classList.remove('on'); };
        bar.classList.add('on'); W.addEventListener('pointermove', mv); W.addEventListener('pointerup', up); });
    }
    /* 3.0.3: height handles for stacked lists. The handle is an absolutely positioned thin line laid ON the existing gap
     * below the list (bottom:-5px), so it adds no layout height. Double-click resets to the stylesheet default. */
    const listHeights = {};
    function heightHandle(el, key, min, max) {
      el.classList.add('gxp-hh-host'); const h = doc.createElement('div'); h.className = 'gxp-hh'; h.dataset.hh = key;
      h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'horizontal'); h.title = 'Drag to change the list height (double-click: default)';
      el.appendChild(h);
      const set = px => { if (px == null) { el.style.height = ''; el.style.flexBasis = ''; delete listHeights[key]; if (typeof fitPrimary === 'function') fitPrimary(); } else { el.style.height = px + 'px'; el.style.flexBasis = px + 'px'; listHeights[key] = px; } };
      splitter(h, el, 'y', { min, max, set }); on(h, 'dblclick', () => set(null));
      heightHandle.set = heightHandle.set || {}; heightHandle.set[key] = set;
    }
    /* 3.0.3: dragged heights are capped to the visible tab height so each list keeps its own scrollbars instead of the tab scrolling */
    const tabRoom = () => { const b = TP.querySelector('.gxp-scrollbox'); return b && b.clientHeight ? b.clientHeight - 40 : 900; };
    heightHandle(TP.querySelector('.gxp-tr-grid'), 'trPick', 120, tabRoom); heightHandle($('gxp-trl-host'), 'trList', 100, tabRoom); // 3.0.3
    /* 3.0.3: primary list fill. Single-list tabs already flex-fill (.gxp-vt flex:1). On the stacked Transport tab the
     * live transport list is the primary list: it grows to the bottom of the visible tab (min = stylesheet 260px) and is
     * recomputed on window resize / tab show / redraw; other panes keep their dragged heights. A dragged trList height wins
     * until double-click reset. */
    function fitPrimary() {
      const host = $('gxp-trl-host'), box = host && host.closest('.gxp-scrollbox'); if (!host || !box || listHeights.trList || !box.clientHeight) return;
      const top = host.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const want = Math.max(260, Math.floor(box.clientHeight - top - 8));
      if (Math.abs((parseFloat(host.style.height) || 0) - want) > 1) { host.style.height = want + 'px'; host.dataset.fill = '1'; }
    }
    W.addEventListener('resize', () => fitPrimary()); app.fitPrimary = fitPrimary;
    app.listHeights = () => Object.assign({}, listHeights);
    app.setListHeights = o => { for (const [k, v] of Object.entries(o || {})) if (heightHandle.set && heightHandle.set[k] && v > 0) heightHandle.set[k](v); };
    splitter($('gxp-sv'), $('gxp-left'), 'x'); splitter($('gxp-sh'), $('gxp-details'), 'y');

    /* ---------- settings dialog ---------- */
    onBtn($('gxp-settings-btn'), () => {
      let d = $('gxp-dialog'); if (d) { d.remove(); return; }
      d = doc.createElement('div'); d.id = 'gxp-dialog'; d.className = 'gxp-dialog'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Galaxy Console settings');
      const gate = writeGate(Object.assign({}, settings, { writesEnabled: true }), transport.template);
      d.innerHTML = `<b>Galaxy Console settings</b>
        <div class="gxp-subtabs" role="tablist">${[['general', 'General'], ['sending', 'Sending'], ['notify', 'Notifications'], ['keys', 'Shortcuts'], ['events', 'Events'], ['debug', 'Debug'], ['dev', 'Developer']].map(([k, l], i) => `<span role="tab" tabindex="0" data-subtab="${k}" class="${i ? '' : 'on'}">${l}</span>`).join('')}</div>
        <div data-sub="general">
        <label>Owner names for "mine", comma-separated; replaces auto-detection (empty = detect automatically). Now: ${esc(meLabel())}<br><input data-s="meOverride" title="Leave empty to detect your owner names automatically" size="40" value="${esc(settings.meOverride)}"></label>
        <label>Extra owner names (your other countries / corporations), added to the detected ones: <input data-s="meExtra" title="Names of your other countries or corporations, comma-separated" size="40" value="${esc(settings.meExtra)}"></label>
        <span class="gxbutton gxp-btn" data-act="forgetOwner" role="button" tabindex="0" title="Forget the auto-detected owner names and keys">forget detected owner</span>
        <label>Seconds per tu (approximate real time): <input data-s="tuSeconds" title="Used to convert tu to real time for estimates and game-time timers" type="number" step="0.1" min="0.1" value="${settings.tuSeconds}" style="width:70px"></label>
        <label><input type="checkbox" data-s="linkNames" ${settings.linkNames !== false ? 'checked' : ''}> Clickable country/owner names (open the game page in a new tab)</label>
        <label style="margin-left:18px"><input type="checkbox" data-s="linkNamesTables" ${settings.linkNamesTables !== false ? 'checked' : ''} ${settings.linkNames === false ? 'disabled' : ''}> also in tables</label>
        <label>Keep a shuttle missing from the map layer at its last position (dimmed) for <input data-s="mapMissTolerance" title="0 = drop at once; higher = more tolerant of incomplete map answers" type="number" min="0" step="1" value="${settings.mapMissTolerance == null ? 3 : settings.mapMissTolerance}" style="width:50px"> refreshes</label>
        <label><input type="checkbox" data-s="mapShowDocked" ${settings.mapShowDocked !== false ? 'checked' : ''} title="The game's map layer only carries shuttles in flight. When on, idle / docked shuttles of the current list are drawn as small yellow dots at their position from the shuttle list."> Show idle / docked shuttles on the map (yellow dots)</label>
        <label><input type="checkbox" data-s="autoDetails" ${settings.autoDetails ? 'checked' : ''}> refresh shuttle details automatically</label>
        <label><input type="checkbox" data-s="writesEnabled" ${settings.writesEnabled ? 'checked' : ''}> <b>enable writes</b> (master switch)</label>
        <fieldset style="margin:4px 0"><legend>Write actions (each also needs the master switch)</legend>
          <label><input type="checkbox" data-s="writeRename" ${settings.writeRename ? 'checked' : ''}> rename shuttles (single and bulk)</label>
          <label><input type="checkbox" data-s="writeFlights" ${settings.writeFlights ? 'checked' : ''}> schedule shuttle flights</label>
          <label title="Not available yet"><input type="checkbox" disabled> cargo · docking · trading <span class="gxp-approx">(not yet)</span></label>
          <span class="gxp-approx">Transport requests use the master switch only. Every write shows one confirmation with the details first.</span></fieldset>
        </div><div data-sub="sending" style="display:none">${settingsSendingHtml()}</div><div data-sub="notify" style="display:none">${settingsNotifyHtml()}</div><div data-sub="keys" style="display:none">${settingsKeysHtml()}</div>
        <div data-sub="events" style="display:none"></div><div data-sub="debug" style="display:none"></div>
        <div data-sub="dev" style="display:none">
        <label><input type="checkbox" data-s="devTools" ${settings.devTools ? 'checked' : ''}> Developer / debug tools</label>
        <p class="gxp-approx" style="margin-left:18px">Shows the Debug tab (debug log, its settings, Dry run, form capture) and raw-response buttons. Events settings are in the Events tab. Leave this OFF unless support or the developer asks you to turn it on. Galaxy Console keeps logging internally either way.</p>
        </div>
        <p class="gxp-approx">Write method: gxAddTransportRequest. Form capture: ${esc(gate.ok ? gate.why : gate.why)}</p>
        <p class="gxp-approx">Register: ${tracker.ships.size} shuttles, session #${tracker.session}. Eviction: unseen &gt; ${C.EVICT_DAYS} days AND &gt;= ${C.EVICT_SESSIONS} sessions.</p>
        <span class="gxbutton gxp-btn" data-close role="button" tabindex="0">Close</span>`;
      root.appendChild(d);
      on(d, 'change', e => { const k = e.target.dataset.s; if (!k) return; settings[k] = e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' ? (k === 'tuSeconds' ? Math.max(0.1, +e.target.value || DEFAULT_SETTINGS.tuSeconds) : Math.max(0, +e.target.value || 0)) : e.target.value.trim());
        saveSettings(); foot(); if (k === 'linkNames') { const sub2 = d.querySelector('[data-s=linkNamesTables]'); if (sub2) sub2.disabled = !settings.linkNames; }
        if (k === 'linkNames' || k === 'linkNamesTables') { LK.at = 0; renderAll(); if (typeof forceDetails === 'function') forceDetails(); }
        if (k === 'devTools' || k === 'formCapture') applyDevTools(); if (k === 'linkNames' || k === 'linkNamesTables') applyExtUl(); if (k.indexOf('notify') === 0) notifySettingChanged(k); dbg.script('info', 'setting ' + k + ' = ' + settings[k]); if (k === 'meOverride' || k === 'meExtra') logMine('settings changed'); renderAll(); });
      onBtn(d.querySelector('[data-close]'), () => d.remove()); settingsDialogExtras(d); settingsLogExtras(d);
      onBtn(d.querySelector('[data-act=forgetOwner]'), () => { owner.names.clear(); owner.keys.clear(); try { W.localStorage.removeItem('gxp.owner'); } catch (e) { /* */ } app._ownerProbe = app._ownerListRead = false; dbg.script('info', 'detected owner forgotten'); d.remove(); renderAll(); });
    });

    /* ---------- status ---------- */
    const median = a => { const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    const pollInfo = { status: 'starting', at: 0, errors: 0, cadence: [] };
    function renderStatus() {
      const c = client.stats, ago = pollInfo.at ? Math.round((Date.now() - pollInfo.at) / 1000) + 's ago' : 'never';
      const cad = pollInfo.cadence.length >= 3 ? Math.round(median(pollInfo.cadence) / 1000) + 's' : '-'; // 3.0.2: median of in-cadence samples (was a mean incl. outliers)
      const active = [...tracker.ships.values()].filter(s => s.status === 'flight' || isActive(s)).length;
      $('gxp-status').textContent = `map: ${pollInfo.status} (${ago})${pollInfo.errors ? ', ' + pollInfo.errors + ' errors' : ''} · ${active} active shuttles, refresh every ≈${cad} · requests ${client.pending} pending, ${c.done} ok, ${c.failed} failed, ${c.retried} retried`;
      const b = $('gxp-session'); b.textContent = 'session: ' + ({ ok: 'signed in', expired: 'not signed in', unknown: 'checking…' }[session.state] || session.state);
      b.className = 'gxp-badge ' + (session.state === 'ok' ? 'ok' : session.state === 'expired' ? 'bad' : '');
      b.title = session.state === 'expired' ? 'Login-only lists (transport pickers) need a sign-in. Click to sign in (opens the game in a popup), or sign in in any Simcountry tab; this window picks it up automatically and works without other game tabs open.' : 'Sign-in state';
    }
    session.subscribe(state => { if (state === 'ok' && activeTab === 'transport' && !transport.origins.length) act('pick'); renderAll(); });
    let raf = 0;
    function renderAll() { if (raf) return; raf = (W.requestAnimationFrame || (f => setTimeout(f, 16)))(() => { raf = 0;
      try { if (activeTab === 'ships') renderShips(); renderLists(); if (activeTab === 'transport') renderTransport(); if (activeTab === 'events') renderEvents(); if (activeTab === 'debug') renderDebug(); renderDetails(); renderMap(); renderStatus(); }
      catch (e) { dbg.script('error', 'render: ' + e.message); } }); }
    app.renderAll = renderAll; app.renderNow = () => { if (activeTab === 'ships') renderShips(); renderLists(); renderTransport(); renderEvents(); renderDetails(); renderMap(); renderStatus(); };
    app.showTab = showTab; app.shipsVT = shipsTab.vt; app.data = data;
    tracker.subscribe(renderAll); client.onChange(() => renderStatus());
    every(renderStatus, 1000);
    /* ===================================================================
     * 0.2.5 READ-ONLY ADDITIONS (inside the existing Details pane; no new tabs)
     *  A shuttle Cargo / Logbook views   B station Products Stored / Activities / free docks
     *  C product info + Galaxy Console-recorded market history   D world info + game world-map link
     * All reads go through cachedRead -> client (read-only allowlist, shared throttle/concurrency, per-key caching).
     * =================================================================== */
    const X25 = { shipTab: {}, shipLogs: new Map(), sort: {}, station: null, stationFree: new Map(), view: null };
    const TTL = { cargo: 60000, logs: 120000, station: 120000, free: 300000, product: 3600000, world: 3600000 };
    const sortBtn = (tbl, key, label) => { const s = X25.sort[tbl] || {}; return `<th class="gxp-sortable" data-gxp-sort="${tbl}:${key}" style="cursor:pointer" title="Sort">${esc(label)}${s.key === key ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`; };
    const sorted = (tbl, rows, def) => { const s = X25.sort[tbl] || def || {}; if (!s.key) return rows; return rows.slice().sort((a, b) => { const x = a[s.key], y = b[s.key]; return (typeof x === 'number' || typeof y === 'number' ? (x || 0) - (y || 0) : String(x || '').localeCompare(String(y || ''))) * (s.dir || 1); }); };
    /* 3.0.5: product name on the Transport tab: bold black (category link colours were unreadable), with the game's
     * category/product icon left of it when the page provides one (only https images.simcountry.com, or a bare game file name). */
    const iconUrl = u => { u = String(u || '').trim(); if (!u) return ''; if (/^https:\/\/images\.simcountry\.com\/[\w./-]+\.(gif|png|jpe?g|webp)$/i.test(u)) return u; if (/^[\w-]+\.(gif|png)$/i.test(u)) return 'https://images.simcountry.com/' + u; return ''; };
    const prodCell = (name, id, icon) => { const i = iconUrl(icon); return `<span class="gxp-pn">${i ? `<img class="gxp-pi" src="${esc(i)}" alt="" loading="lazy" onerror="this.remove()">` : ''}${prodLink(name, id)}</span>`; };
    const prodLink = (name, id) => id ? `<a href="#" data-gxp-prod="${esc(id)}" data-gxp-pname="${esc(name)}" title="Product info and market history">${esc(name)}</a>` : esc(name);
    function worldLinks(place) { const code = worldCode(place); if (aliasOf(place)) return aliasHtml(place); if (!code) return esc(place); const g = globes.find(x => initials(x.name) === code);
      return g ? esc(String(place).slice(0, -code.length)) + `<a href="#" data-gxp-world="${esc(g.id)}" title="${esc(g.name)}: world info">${esc(code)}</a>` : esc(place); }
    const miniTable = (tbl, cols, rows) => '<table class="gxp-mini"><tr class="gxpu_rc0">' + cols.map(c => sortBtn(tbl, c[0], c[1])).join('') + '</tr>' + rows.map((r, i) => `<tr class="gxpu_rc${(i + 1) % 2}">` + cols.map(c => `<td${c[3] ? ' style="text-align:right"' : ''}>${c[2] ? c[2](r) : esc(r[c[0]])}</td>`).join('') + '</tr>').join('') + '</table>';

    /* ---------- A: shuttle cargo + logbook ---------- */
    async function loadShipCargo(s) {
      const html = await cachedRead('cargo:' + s.id, 'gxShipCargo', { miObjectID: s.id, miObjectView: 0, miObjectSort: 1, miObjectOrder: 1 }, TTL.cargo);
      const r = parseInventoryTable(html); if (!r.ok) throw new Error('unrecognised cargo page');
      tracker.observe(s.id, { cargoItems: r.rows.map(x => ({ product: x.product, productId: x.productId, qty: x.qty, unit: x.unit, quality: x.quality })) }, 'cargo'); s.cargoEmptyNote = r.empty;
      dbg.script('debug', `cargo ${s.name}#${s.id.slice(-6)}: ${r.rows.length} products`);
    }
    async function loadShipLogs(s) {
      const html = await cachedRead('logs:' + s.id, 'gxShipLogs', { miObjectID: s.id, miObjectView: 0, miObjectSort: 2, miObjectOrder: -1 }, TTL.logs);
      const r = parseLogTable(html); if (!r.ok) throw new Error('unrecognised logbook page');
      X25.shipLogs.set(s.id, { at: Date.now(), rows: r.rows, empty: r.empty });
      if (X25.shipLogs.size > MEM.SHIPLOG_CACHE) { const old = [...X25.shipLogs.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, X25.shipLogs.size - MEM.SHIPLOG_CACHE); for (const [k] of old) X25.shipLogs.delete(k); } // 3.1.5
      const fresh = tracker.recordLogbook(s, r.rows.map(x => ({ when: x.when, text: x.text }))); T25dirty(s);
      dbg.script('debug', `logbook tab ${s.name}#${s.id.slice(-6)}: ${r.rows.length} lines, ${fresh} new in register`);
    }
    function T25dirty(s) { if (tracker.dirty) tracker.dirty.add(s.id); }
    function openShipTab(s, tab) {
      X25.shipTab[s.id] = X25.shipTab[s.id] === tab ? null : tab; renderDetails(); if (!X25.shipTab[s.id]) return;
      const job = tab === 'cargo' ? loadShipCargo(s) : loadShipLogs(s); s['err_' + tab] = null;
      job.catch(e => { if (e.name !== 'StaleResponseError') { s['err_' + tab] = e.message; dbg.script('warn', `${tab} ${s.name}: ${e.message}`); } }).finally(() => { if (selected === s.id) renderDetails(); });
    }
    function shipExtraHtml(s) {
      const tab = X25.shipTab[s.id];
      let h = `<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-stab="cargo" role="button" tabindex="0"${tab === 'cargo' ? ' style="font-weight:bold"' : ''}>Cargo</span> <span class="gxbutton gxp-btn" data-gxp-stab="logs" role="button" tabindex="0"${tab === 'logs' ? ' style="font-weight:bold"' : ''}>Logbook (full)</span></p>`;
      if (tab === 'cargo') {
        if (s.err_cargo) h += `<p class="gxp-warn">Cargo failed: ${esc(s.err_cargo)}</p>`;
        else if (!s.cargoAt) h += '<p><span class="gxp-skel"></span></p>';
        else h += `<p class="gxpu_text"><b>Cargo</b> <span class="gxp-approx">read ${fmtTime(s.cargoAt)}</span></p>` + ((s.cargoItems || []).length ? miniTable('cargo', [['product', 'Product', r => prodLink(r.product, r.productId)], ['qty', 'Quantity', r => fmtN(r.qty) + (r.unit ? ' ' + esc(r.unit) : ''), 1], ['quality', 'Avg quality', r => r.quality == null ? '' : esc(r.quality), 1]], sorted('cargo', s.cargoItems)) : `<p class="gxpu_text">${esc(s.cargoEmptyNote || 'Empty.')}</p>`);
      } else if (tab === 'logs') {
        const L = X25.shipLogs.get(s.id);
        if (s.err_logs) h += `<p class="gxp-warn">Logbook failed: ${esc(s.err_logs)}</p>`;
        else if (!L) h += '<p><span class="gxp-skel"></span></p>';
        else h += `<p class="gxpu_text"><b>Logbook</b> (server time, ${esc(SERVER_TZ)}) <span class="gxp-approx">${L.rows.length} lines read ${fmtTime(L.at)} · ${(s.logbook || []).length} kept in register</span></p>` + (L.rows.length ? miniTable('logs', [['when', 'Date'], ['kind', 'Kind'], ['text', 'Description']], sorted('logs', L.rows)) : `<p class="gxpu_text">${esc(L.empty || 'No entries.')}</p>`);
      }
      return h;
    }

    /* ---------- B: station Products Stored / Activities / free docks ---------- */
    function stationExtraHtml(r) {
      const v = X25.station && X25.station.id === r.id ? X25.station : null, free = X25.stationFree.get(r.id);
      let h = `<p class="gxpu_text">Position: ${worldLinks(r.position)}</p>`;
      if (!v || (!v.at && !v.error)) return h + '<p><span class="gxp-skel"></span> reading station page…</p>'; // 0.2.6: also while a read is in flight
      if (v.error) return h + `<p class="gxp-warn">Station page failed: ${esc(v.error)}</p>`;
      h += `<p class="gxpu_text"><b>Products stored</b> (yours) <span class="gxp-approx">read ${fmtTime(v.at)}</span></p>` + (v.inv.rows.length ? miniTable('inv', [['product', 'Product', x => prodLink(x.product, x.productId)], ['qty', 'Quantity', x => fmtN(x.qty) + (x.unit ? ' ' + esc(x.unit) : ''), 1], ['quality', 'Avg quality', x => x.quality == null ? '' : esc(x.quality), 1], ['dock', 'Dock']], sorted('inv', v.inv.rows)) : `<p class="gxpu_text">${esc(v.inv.empty || 'Nothing stored.')}</p>`);
      h += '<p class="gxpu_text"><b>Activities</b> (yours)</p>' + (v.act.rows.length ? miniTable('act', [['when', 'Date'], ['kind', 'Kind'], ['text', 'Description']], sorted('act', v.act.rows)) : `<p class="gxpu_text">${esc(v.act.empty || 'No activities.')}</p>`);
      const docks = v.docks, freeHere = docks.filter(d => !d.usedBy || d.usedBy === '-' || /^free$/i.test(d.usedBy));
      h += `<p class="gxpu_text"><b>Docks</b>: ${docks.length} on the station page${docks.length ? `, ${freeHere.length} without a user` : ''}. <span class="gxbutton gxp-btn" data-gxp-free="${esc(r.id)}" role="button" tabindex="0" title="Read the game's own 'free' docking view for this station">Free docks</span></p>`;
      if (free) h += free.error ? `<p class="gxp-warn">Free docks failed: ${esc(free.error)}</p>` : !free.rows ? '<p><span class="gxp-skel"></span></p>'
        : `<p class="gxpu_text">${free.rows.length} free dock(s) per the game <span class="gxp-approx">read ${fmtTime(free.at)}</span></p>` + (free.rows.length ? miniTable('free', [['dock', 'Dock'], ['owner', 'Owned by'], ['usePct', 'Use%', x => x.usePct == null ? '' : x.usePct + '%', 1]], sorted('free', free.rows)) : '');
      return h;
    }
    async function loadStationExtras(r) {
      X25.station = { id: r.id };
      try { const html = await cachedRead('gxInfo:' + r.id, 'gxInfo', { miKey: r.id }, TTL.station);
        X25.station = { id: r.id, at: Date.now(), inv: parseInventoryTable(html, 'tsUserInventory'), act: parseLogTable(html, 'tsUserLogs'), docks: parseStationDocks(html, r.id, r.name) };
        data.stationDocks.set(r.id, X25.station.docks); }
      catch (e) { if (e.name === 'StaleResponseError') return; X25.station = { id: r.id, error: e.message }; }
      if (X25.view && X25.view.kind === 'station' && X25.view.r.id === r.id) showStation(r);
    }
    async function loadFreeDocks(r) {
      X25.stationFree.set(r.id, {}); showStation(r);
      try { const html = await cachedRead('free:' + r.id, 'gxDockingStations', { miObjectID: r.id, miObjectView: 2, miObjectSort: 1, miObjectOrder: 1 }, TTL.free);
        X25.stationFree.set(r.id, { at: Date.now(), rows: parseStationDocks(html, r.id, r.name) }); }
      catch (e) { if (e.name !== 'StaleResponseError') X25.stationFree.set(r.id, { error: e.message }); }
      if (X25.view && X25.view.kind === 'station' && X25.view.r.id === r.id) showStation(r);
    }

    /* ---------- C: product info + market history (recorded by Galaxy Console; the game shows no prices or history here) ---------- */
    const MKH_KEY = 'gxp.mkHistory', MKH_MAX = 60;
    let mkHist = {}; try { mkHist = JSON.parse(W.localStorage.getItem(MKH_KEY) || '{}'); } catch (e) { mkHist = {}; }
    let mkHistSave = null;
    function recordMarketHistory() {
      let changed = 0;
      for (const [sid, m] of data.mkStations) { if (m.cached) continue; for (const r of m.rows || []) { if (!r.productId) continue;
        const k = r.productId + '|' + sid, L = mkHist[k] || (mkHist[k] = []), last = L[L.length - 1];
        if (last && last[0] >= m.at) continue; if (last && last[1] === r.offered && last[2] === r.requested) { last[3] = m.at; continue; }
        L.push([m.at, r.offered, r.requested, m.at]); if (L.length > MKH_MAX) L.splice(0, L.length - MKH_MAX); changed++; } }
      if (changed && !mkHistSave) mkHistSave = later(() => { mkHistSave = null; try { W.localStorage.setItem(MKH_KEY, JSON.stringify(mkHist)); } catch (e) { dbg.script('warn', 'market history not saved: ' + e.message); } }, 5000);
    }
    every(recordMarketHistory, 15000);
    function spark(points) { if (points.length < 2) return ''; const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1, max = Math.max(1, ...points.map(p => Math.max(p[1] || 0, p[2] || 0)));
      const path = i => points.map((p, j) => `${j ? 'L' : 'M'}${(4 + 192 * (p[0] - t0) / Math.max(1, t1 - t0)).toFixed(1)},${(36 - 32 * (p[i] || 0) / max).toFixed(1)}`).join('');
      return `<svg width="200" height="40" style="background:#e6e8da;vertical-align:middle"><path d="${path(1)}" fill="none" stroke="#2f7d32"/><path d="${path(2)}" fill="none" stroke="#a33" stroke-dasharray="3 2"/></svg> <span class="gxp-approx">green offered, red requested</span>`; }
    async function showProduct(pid, pname) {
      selected = null; X25.view = { kind: 'product', pid };
      const rows = (data.markets || []).filter(m => String(m.productId) === String(pid));
      const render = info => { if (!X25.view || X25.view.kind !== 'product' || X25.view.pid !== pid) return;
        let h = `<h3>${esc((info && info.name) || pname || 'Product')} <span class="gxp-id">product ${esc(pid)}</span></h3>`;
        if (!info) h += '<p><span class="gxp-skel"></span></p>'; else if (info.error) h += `<p class="gxp-warn">Product info failed: ${esc(info.error)}</p>`;
        else h += '<table>' + info.props.map((p, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(p[0])}</td><td class="gxpu_data">${esc(p[1])}</td></tr>`).join('') + '</table>';
        h += `<p class="gxpu_text"><b>Space markets</b> ${rows.length ? '' : '<span class="gxp-approx">(open the Markets tab to load them)</span>'}</p>`;
        if (rows.length) h += miniTable('pmk', [['station', 'Station'], ['offered', 'Offered', r => fmtN(r.offered), 1], ['requested', 'Requested', r => fmtN(r.requested), 1], ['unit', 'Unit']], sorted('pmk', rows));
        const hist = Object.entries(mkHist).filter(([k]) => k.split('|')[0] === String(pid)).map(([k, L]) => [k.split('|')[1], L]).filter(([, L]) => L.length);
        h += '<p class="gxpu_text"><b>History recorded by Galaxy Console</b> <span class="gxp-approx">(the game shows no price or history for space markets; quantities are logged each time Galaxy Console reads a market)</span></p>';
        h += hist.length ? '<table class="gxp-mini">' + hist.map(([sid, L], i) => { const st = (data.mkStations.get(sid) || {}).name || sid, last = L[L.length - 1];
          return `<tr class="gxpu_rc${i % 2}"><td>${esc(st)}</td><td>${spark(L)}</td><td>${L.length} change(s) since ${fmtTime(L[0][0])}; now ${fmtN(last[1])} / ${fmtN(last[2])}</td></tr>`; }).join('') + '</table>' : '<p class="gxpu_text">Nothing recorded yet.</p>';
        $('gxp-details').innerHTML = h; };
      render(null);
      try { render(parseProductInfo(await cachedRead('prod:' + pid, 'gxProductInfo', { miProduct: pid }, TTL.product))); }
      catch (e) { if (e.name !== 'StaleResponseError') render({ error: e.message }); }
    }

    /* ---------- D: world (globe) info + world map link ---------- */
    async function showWorld(id) {
      selected = null; X25.view = { kind: 'world', id }; const g = globes.find(x => String(x.id) === String(id));
      const render = w => { if (!X25.view || X25.view.kind !== 'world' || X25.view.id !== id) return;
        let h = `<h3>${esc((w && w.name) || (g && g.name) || 'World ' + id)} <span class="gxp-id">world ${esc(id)}</span></h3>`;
        if (!w) h += '<p><span class="gxp-skel"></span></p>'; else if (w.error) h += `<p class="gxp-warn">World info failed: ${esc(w.error)}</p>`;
        else { if (w.blurb) h += `<p class="gxpu_text">${esc(w.blurb)}</p>`;
          h += '<table>' + w.stats.map((p, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(p[0])}</td><td class="gxpu_data">${esc(p[1])}</td></tr>`).join('') + '</table>';
          const url = worldMapUrl(w.host); if (url) h += `<p class="gxpu_text"><a href="${esc(url)}" target="_blank" rel="noopener">Open the ${esc(w.name)} world map in the game</a> <span class="gxp-approx">(${esc(w.host)})</span></p>`;
          const sts = (data.stations || []).filter(s => worldCode(s.position) === initials(w.name)), here = [...tracker.ships.values()].filter(s => worldCode(s.location) === initials(w.name));
          h += `<p class="gxpu_text">${here.length} shuttle(s) seen at this world${sts.length ? `, ${sts.length} station(s) positioned here` : ''}.</p>`; }
        if (g) h += '<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-center-world="' + esc(id) + '" role="button" tabindex="0">Show on map</span></p>';
        $('gxp-details').innerHTML = h; };
      render(null);
      try { render(parseWorldInfo(await cachedRead('world:' + id, 'gxInfo', { miKey: id }, TTL.world))); }
      catch (e) { if (e.name !== 'StaleResponseError') render({ error: e.message }); }
    }

    /* ---------- delegated clicks (Details pane, tables, map) ---------- */
    on(doc, 'click', e => {
      const t = e.target.closest && e.target.closest('[data-gxp-prod],[data-gxp-world],[data-gxp-stab],[data-gxp-sort],[data-gxp-free],[data-gxp-center-world]'); if (!t) return;
      e.preventDefault(); e.stopPropagation();
      if (t.dataset.gxpProd) return showProduct(t.dataset.gxpProd, t.dataset.gxpPname);
      if (t.dataset.gxpWorld) return showWorld(t.dataset.gxpWorld);
      if (t.dataset.gxpCenterWorld) { const g = globes.find(x => String(x.id) === t.dataset.gxpCenterWorld); if (g) centerOn(g.x, g.y); return; }
      if (t.dataset.gxpStab) { const s = tracker.ships.get(selected); if (s) openShipTab(s, t.dataset.gxpStab); return; }
      if (t.dataset.gxpFree) { const r = (data.stations || []).find(x => String(x.id) === t.dataset.gxpFree) || (X25.view && X25.view.r); if (r) loadFreeDocks(r); return; }
      if (t.dataset.gxpSort) { const [tbl, key] = t.dataset.gxpSort.split(':'), s = X25.sort[tbl]; X25.sort[tbl] = { key, dir: s && s.key === key ? -s.dir : 1 };
        if (selected) renderDetails(); else if (X25.view && X25.view.kind === 'station') showStation(X25.view.r); else if (X25.view && X25.view.kind === 'product') showProduct(X25.view.pid); }
    }, true);

    /** Map click on a space station (like the game's gx1ClickStation -> gxGetMarketInfo): open the Stations tab on that row + its details. */
    async function openStationFromMap(id, name) {
      if (!data.stations) await loadStations();
      const r = (data.stations || []).find(x => String(x.id) === String(id)) || { id: String(id), name: name || 'Station ' + id, owner: '', position: '', storage: null, usePct: null };
      if (activeTab !== 'stations') showTab('stations'); try { stTab.vt.selectedKey = r.id; stTab.vt.scrollToKey(r.id); } catch (e) { /* */ }
      showStation(r);
    }
    app.openStationFromMap = openStationFromMap; app.showWorld = showWorld; app.showProduct = showProduct;

    /* ===================================================================
     * 0.2.5 SPACE CENTERS tab + local aliases. Aliases live only in Galaxy Console (IndexedDB meta 'centerAliases'); nothing is sent to the game.
     * Source: the login-only transport pickers (gxGetTransportOrigins / gxGetTransportTargets), kind 2 = space center, 5 = remote depot.
     * =================================================================== */
    var centerAliases = new Map(); // game name (normalised) -> { name, alias, key, at }
    function aliasOf(name) { const a = name && centerAliases.get(normName(name)); return a && a.alias ? a.alias : ''; }
    function aliasHtml(name) { if (!name) return ''; const a = aliasOf(name); return a ? `<span class="gxp-alias" title="Game name: ${esc(name)}">${esc(a)}</span>` : esc(name); }
    const centerKey = c => [c.world, c.entityKind, c.entityId, c.target].join(':');
    db.getMeta('centerAliases', []).then(list => { for (const a of list || []) if (a && a.name) centerAliases.set(normName(a.name), a); renderAll(); }).catch(() => {});
    const saveAliases = () => db.setMeta('centerAliases', [...centerAliases.values()]).catch(e => dbg.script('warn', 'aliases not saved: ' + e.message));
    function setAlias(c, alias) {
      alias = String(alias || '').replace(/\s+/g, ' ').trim().slice(0, 60); const k = normName(c.name);
      if (alias && alias !== c.name) centerAliases.set(k, { name: c.name, alias, key: c.key || '', at: Date.now() }); else centerAliases.delete(k);
      saveAliases(); dbg.script('info', `space center alias: "${c.name}" -> ${alias ? '"' + alias + '"' : '(cleared)'} (local only)`); renderAll();
    }
    function centersList() {
      const by = new Map();
      for (const [list, role] of [[transport.origins, 'origin'], [transport.targets, 'target']]) for (const o of list || []) { if (!isCenterKind(o.kind)) continue;
        const key = centerKey(o), c = by.get(key) || { key, name: o.name, kind: +o.kind, world: o.world, entityKind: o.entityKind, entityId: o.entityId, target: o.target, roles: new Set(), cells: o.cells || [] };
        c.roles.add(role); by.set(key, c); }
      for (const a of centerAliases.values()) if (![...by.values()].some(c => normName(c.name) === normName(a.name))) by.set('alias:' + a.name, { key: a.key || 'alias:' + a.name, name: a.name, kind: null, roles: new Set(['alias only (not in current pickers)']), cells: [] });
      return [...by.values()].map(c => Object.assign(c, { alias: aliasOf(c.name), code: worldCode(c.name), entity: c.entityKind === 'e' ? 'enterprise' : c.entityKind === 'c' ? 'country' : (c.entityKind || '') }));
    }
    const CC_COLS = [{ key: 'alias', label: 'Your name', w: '24%', grow: true, min: 110, html: r => r.alias ? esc(r.alias) : '<span class="gxp-approx">—</span>', title: r => 'Game name: ' + r.name },
      { key: 'name', label: 'Game name', w: '26%', grow: true, min: 120 }, { key: 'code', label: 'World', w: '8%', max: 60 },
      { key: 'kind', label: 'Kind', w: '12%', max: 90, html: r => r.kind === 5 ? 'depot' : r.kind === 2 ? 'center' : '' }, { key: 'entity', label: 'Owner type', w: '14%', max: 100 },
      { key: 'roles', label: 'Usable as', w: '16%', html: r => esc([...r.roles].join(', ')), sortVal: r => [...r.roles].join() }];
    const ccTab = listTab('centers', `<input type="search" data-f="q" title="Type to filter the rows shown (matches any visible text)" placeholder="Filter name or alias" aria-label="Text filter">
      <span class="gxbutton gxp-btn" data-act="ccLoad" role="button" tabindex="0" title="Read your space centers from the transport pickers (login needed)">Reload</span>
      <span class="gxbutton gxp-btn" data-act="ccExp" role="button" tabindex="0" title="Your local aliases as CSV">Export aliases CSV</span>
      <label class="gxbutton gxp-btn" title="Merge aliases from a CSV exported here">Import aliases <input type="file" accept=".csv,text/csv" data-act="ccImp" title="Import Space Center aliases from a CSV file" style="display:none"></label>
      <span class="gxp-approx">Aliases are local to Galaxy Console and never sent to the game.</span>`, CC_COLS,
      { sort: { key: 'name', dir: 1 }, rowKey: r => r.key, onRowClick: k => { const c = centersList().find(x => x.key === k); if (c) showCenter(c); },
        emptyHtml: () => session.state === 'expired' ? 'Sign in to Simcountry in another tab, then press Reload.' : (transport.origins.length ? 'No space centers in your transport pickers.' : '<span class="gxp-skel"></span> reading your space centers…') });
    const ccf = { q: '' };
    on(ccTab.bar, 'input', e => { if (e.target.dataset.f === 'q') { ccf.q = e.target.value.toLowerCase(); renderAll(); } });
    const ccLoad = () => Promise.all([transport.loadOrigins(), transport.loadTargets()]).then(() => { dbg.script('info', `space centers: ${centersList().filter(c => c.kind).length} from pickers`); renderAll(); }).catch(e => { dbg.script('warn', 'space centers: ' + e.message); renderAll(); });
    onBtn(ccTab.bar.querySelector('[data-act=ccLoad]'), ccLoad);
    onBtn(ccTab.bar.querySelector('[data-act=ccExp]'), () => { const rows = [['record_type', 'game_name', 'alias', 'center_key', 'set_at']].concat([...centerAliases.values()].map(a => ['center_alias', a.name, a.alias, a.key || '', a.at ? new Date(a.at).toISOString() : '']));
      downloadText(doc, 'galaxyplus-center-aliases-' + new Date().toISOString().slice(0, 10) + '.csv', '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'text/csv;charset=utf-8'); });
    async function importAliases(text) { const rows = csvParse(text), h = rows[0] || [], i = n => h.indexOf(n); let n = 0;
      if (i('game_name') < 0 || i('alias') < 0) throw new Error('not a Galaxy Console aliases CSV');
      for (const r of rows.slice(1)) { const name = r[i('game_name')], alias = (r[i('alias')] || '').trim(); if (!name || !alias) continue; centerAliases.set(normName(name), { name, alias, key: r[i('center_key')] || '', at: Date.parse(r[i('set_at')]) || Date.now() }); n++; }
      await saveAliases(); renderAll(); return n; }
    on(ccTab.bar.querySelector('[data-act=ccImp]'), 'change', async e => { const f = e.target.files[0]; if (!f) return; try { const n = await importAliases(await f.text()); ccTab.count.textContent = `imported ${n} alias(es)`; } catch (x) { ccTab.count.textContent = 'Import failed: ' + x.message; } e.target.value = ''; });
    function showCenter(c) {
      selected = null; X25.view = { kind: 'center', key: c.key };
      $('gxp-details').innerHTML = `<h3>${aliasHtml(c.name)} <span class="gxp-id">space center</span></h3><table>` +
        [['Game name', esc(c.name)], ['Your name', `<input type="text" id="gxp-cc-alias" title="Your own short name for this Space Center (stored only in this browser)" value="${esc(c.alias)}" maxlength="60" placeholder="local alias" style="width:180px"> <span class="gxbutton gxp-btn" id="gxp-cc-save" role="button" tabindex="0">Save</span> <span class="gxbutton gxp-btn" id="gxp-cc-clear" role="button" tabindex="0">Clear</span>`],
          ['World', worldCode(c.name) ? worldLinks(String(c.name).replace(/^.*\s(on\s+[A-Z]{2,3})$/, '$1')) : ''], ['Kind', c.kind === 5 ? 'remote depot' : c.kind === 2 ? 'space center' : ''], ['Owner type', esc(c.entity || '')],
          ['Game ids', esc(c.kind ? `world ${c.world}, entity ${c.entityKind} ${c.entityId}, target ${c.target}` : '')], ['Usable as', esc([...c.roles].join(', '))]]
          .map((p, i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(p[0])}</td><td class="gxpu_data">${p[1]}</td></tr>`).join('') + '</table>' +
        '<p class="gxpu_text gxp-approx">The alias only changes how Galaxy Console shows this center (lists, pickers, transports, shuttle locations). Nothing is sent to the game.</p>';
      const inp = $('gxp-cc-alias'); onBtn($('gxp-cc-save'), () => { setAlias(c, inp.value); showCenter(Object.assign(c, { alias: aliasOf(c.name) })); });
      onBtn($('gxp-cc-clear'), () => { setAlias(c, ''); showCenter(Object.assign(c, { alias: '' })); });
      on(inp, 'keydown', e => { if (e.key === 'Enter') { setAlias(c, inp.value); showCenter(Object.assign(c, { alias: aliasOf(c.name) })); } });
    }
    function renderCenters() { if (activeTab !== 'centers') return; let r = centersList().filter(c => textMatch(ccf.q, [c.name, c.alias]));
      r = sortRows(r, CC_COLS.find(c => c.key === ccTab.vt.sort.key), ccTab.vt.sort.dir); ccTab.vt.setRows(r); ccTab.count.textContent = `${r.length} space center(s) · ${centerAliases.size} alias(es)`; }
    every(renderCenters, 1000);
    tabOpeners.centers = () => { if (!transport.origins.length && session.state !== 'expired') ccLoad(); renderCenters(); };
    app.db = db; app.centerAliases = centerAliases; app.setAlias = setAlias; app.centersList = centersList; app.importAliases = importAliases; app.renderCenters = renderCenters;
    /* ===================================================================
     * 0.2.6  FORM CAPTURE (read-only) + RENAME (first write action) + write pacing
     * =================================================================== */
    /* ---------- capture store (localStorage, capped; exported as JSON for the developer) ---------- */
    const CAP_KEY = 'gxp.formCapture026', CAP_MAX = 300;
    var fcap = []; try { fcap = JSON.parse(W.localStorage.getItem(CAP_KEY) || '[]'); } catch (e) { fcap = []; }
    const capSave = () => { try { W.localStorage.setItem(CAP_KEY, JSON.stringify(fcap.slice(-CAP_MAX))); } catch (e) { dbg.script('warn', 'fcap not saved: ' + e.message); } };
    function capAdd(item) { item.at = Date.now(); item.version = VERSION; { const j = safeJson(item); if (j.length > MEM.CAPTURE_ITEM) item = { kind: item.kind, fn: item.fn, method: item.method, at: item.at, version: VERSION, truncated: true, json: capStr(j, MEM.CAPTURE_ITEM) }; } fcap.push(item); // 3.1.5: per-item cap if (fcap.length > CAP_MAX) fcap.splice(0, fcap.length - CAP_MAX); capSave();
      dbg.script('info', `form capture: ${item.kind} ${item.fn || item.method || ''} ${item.forms ? item.forms.length + ' form(s)' : ''} ${item.actions ? item.actions.length + ' action call(s)' : ''}`.trim(), item); renderCapBtn(); }
    /** Strip anything session-like before export (the pages carry none, but be safe). */
    function capScrub(s) { return String(s).replace(/(Passport|SN_SESSION|session|sessid|cookie)=([^&"'\s;]+)/gi, '$1=<removed>'); }
    function exportCapture() {
      const data = { format: 'galaxyplus-form-capture-1', exportedAt: new Date().toISOString(), version: VERSION, note: 'Owner action forms opened read-only by Galaxy Console; nothing was submitted.', items: fcap };
      downloadText(doc, 'galaxyplus-form-capture-' + new Date().toISOString().slice(0, 10) + '.json', capScrub(JSON.stringify(data, null, 1)), 'application/json'); }
    const capBar = dbTab.bar; capBar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="capExp" role="button" tabindex="0" title="Form capture file to send to the developer">Export form capture (0)</span> <span class="gxbutton gxp-btn" data-act="capClr" role="button" tabindex="0">Clear capture</span>');
    function renderCapBtn() { const b = capBar.querySelector('[data-act=capExp]'); if (b) b.textContent = `Export form capture (${fcap.length})`; }
    onBtn(capBar.querySelector('[data-act=capExp]'), exportCapture); onBtn(capBar.querySelector('[data-act=capClr]'), () => { fcap = []; capSave(); renderCapBtn(); dbg.script('info', 'form capture cleared'); }); renderCapBtn();

    /* ---------- capture: scan pages (reads only) ---------- */
    const capState = new Map(); // key 'ship:<id>' | 'station:<id>' -> { running, actions:[], error }
    /* 3.0.5: every write exchange (request URL, reply, any confirm form in the reply; also blocked / dry-run / failed
     * attempts) is captured automatically while Developer tools + Form capture are on. Before, capture only grew from the
     * manual "Capture … forms" buttons, so writes were never recorded. */
    client.onWrite = x => {
      if (!settings.devTools || !settings.formCapture) return;
      const cf = x.response ? captureForms(x.response) : { forms: [], submits: [], message: '' };
      capAdd({ kind: 'write', method: x.method, note: x.note || '', url: x.url || '', status: x.status == null ? null : x.status, ms: x.ms, outcome: x.blocked ? 'blocked: ' + x.blocked : x.dryRun ? 'dry run' : x.error ? 'error: ' + x.error : 'sent',
        response: x.response ? String(x.response).slice(0, 60000) : '', forms: cf.forms, submits: cf.submits, message: cf.message, row: x.row || null });
    };
    async function capRead(kind, key, method, params) {
      const html = await cachedRead('cap:' + key, method, params, 15000), sc = scanActions(html), cf = captureForms(html);
      capAdd({ kind: 'page', source: kind, method, params, actions: sc, forms: cf.forms, submits: cf.submits, message: cf.message });
      return { html, actions: sc };
    }
    async function captureShip(s) {
      const st = { running: true, actions: [] }; capState.set('ship:' + s.id, st); renderDetails();
      try {
        for (const [m, p] of [['gxShipInfo', { miShipID: s.id }], ['gxFlightPlan', { miObjectID: s.id }], ['gxShipCargo', { miObjectID: s.id, miObjectView: 0, miObjectSort: 1, miObjectOrder: 1 }]]) {
          const r = await capRead('shuttle ' + s.name, m + ':' + s.id, m, p); for (const a of r.actions) if (!st.actions.some(x => x.fn === a.fn && JSON.stringify(x.args) === JSON.stringify(a.args))) st.actions.push(a); }
      } catch (e) { if (e.name !== 'StaleResponseError') st.error = e.message; }
      st.running = false; if (selected === s.id) renderDetails();
    }
    async function captureStation(r) {
      const st = { running: true, actions: [] }; capState.set('station:' + r.id, st); showStation(r);
      const add = list => { for (const a of list) if (!st.actions.some(x => x.fn === a.fn && JSON.stringify(x.args) === JSON.stringify(a.args))) st.actions.push(a); };
      try {
        const page = await capRead('station ' + r.name, 'gxInfo:' + r.id, 'gxInfo', { miKey: r.id }); add(page.actions);
        const mine = parseStationDocks(page.html, r.id, r.name).filter(d => isMine(d.owner) || isMine(d.usedBy)).slice(0, 4);
        for (const d of mine) add((await capRead('dock ' + d.dock, 'dock:' + r.id + ':' + d.dockNo, 'gxTradeDocking', { miObjectID: r.id, miDockID: d.dockNo })).actions);
        const prods = parseStationMarket(page.html, r.id, r.name).slice(0, 2);
        for (const p of prods) if (p.productId) add((await capRead('trade ' + p.product, 'trade:' + r.id + ':' + p.productId, 'gxTradeProduct', { miObjectID: r.id, miProduct: p.productId })).actions);
        st.note = `${mine.length} of your docks, ${prods.length} market product(s) scanned`;
      } catch (e) { if (e.name !== 'StaleResponseError') st.error = e.message; }
      st.running = false; if (X25.view && X25.view.kind === 'station' && X25.view.r.id === r.id) showStation(r);
    }
    /** Open ONE discovered loader form (the user's click; GET of the game's own modal form). Never submitted. */
    async function openLoader(stKey, i) {
      const st = capState.get(stKey), a = st && st.actions[i]; if (!a || !a.loader) return;
      a.state = 'opening'; refreshCapView(stKey);
      try { const r = await client.loadForm(a.fn, a.args), cf = captureForms(r.body);
        a.state = `opened: ${cf.forms.length} form(s)` + (cf.forms.length ? '' : ' (NO form returned, see fcap)'); a.forms = cf.forms;
        capAdd({ kind: 'form', fn: a.fn, args: a.args, url: r.url, forms: cf.forms, submits: cf.submits, message: cf.message, title: cf.title, responseHead: capScrub(r.body.slice(0, 6000)) });
        if (!cf.forms.length) dbg.script('warn', `form capture: ${a.fn} returned no form; check the game whether anything changed`);
      } catch (e) { a.state = 'failed: ' + e.message; }
      refreshCapView(stKey);
    }
    function refreshCapView(stKey) { if (stKey.startsWith('ship:')) { if (selected === stKey.slice(5)) renderDetails(); } else if (X25.view && X25.view.kind === 'station') showStation(X25.view.r); }
    function capHtml(stKey) {
      const st = capState.get(stKey); if (!st) return '';
      let h = '<p class="gxpu_text"><b>Form capture</b> <span class="gxp-approx">(read-only: forms are opened, never submitted)</span></p>';
      if (st.running) return h + '<p><span class="gxp-skel"></span> scanning…</p>'; if (st.error) h += `<p class="gxp-warn">${esc(st.error)}</p>`;
      if (st.note) h += `<p class="gxp-approx">${esc(st.note)}</p>`;
      if (!st.actions.length) return h + '<p class="gxpu_text">No owner action buttons found on these pages (are you signed in, and is this yours?).</p>';
      return h + '<table class="gxp-mini">' + st.actions.map((a, i) => `<tr class="gxpu_rc${i % 2}"><td>${esc(a.title || a.fn)}</td><td title="${esc(a.fn + '(' + a.args.join(', ') + ')')}">${esc(a.label || '')}</td><td>${a.loader
        ? `<span class="gxbutton gxp-btn" data-gxp-cap="${esc(stKey)}|${i}" role="button" tabindex="0" title="Opens the game's form for this action and records it. Nothing is submitted.">Open form (read-only)</span> <span class="gxp-approx">${esc(a.state || '')}</span>`
        : '<span class="gxp-approx">recorded only (this call acts directly)</span>'}</td></tr>`).join('') + '</table>' + `<p class="gxp-approx">Captured items: ${fcap.length}. Send the file from Debug → "Export form capture".</p>`;
    }

    /* ---------- write pacing (0.2.7): one write at a time, an internal minimum gap of 1.5 s (waits, never refuses) ---------- */
    const pace = { busy: false, last: 0, GAP: (opts.writeGapMs != null ? opts.writeGapMs : 1500) };
    async function writeSlot() { if (pace.busy) throw new Error('Another write is still running.'); pace.busy = true; const w = pace.last + pace.GAP - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); }
    function writeDone() { pace.busy = false; pace.last = Date.now(); }

    /* ---------- RENAME (write family 'rename') ---------- */
    const renameUi = new Map(); // shipId -> { open, value, msg, cls, result }
    function renameGateFor(s) { return actionGate(settings, 'rename', isMine(s)); }
    function renameHtml(s) {
      const g = renameGateFor(s), u = renameUi.get(s.id) || {};
      if (!isMine(s)) return '';
      if (!u.open) return `<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-ren="open" role="button" tabindex="0" title="${esc(g.ok ? 'Rename this shuttle in the game' : g.why)}" style="opacity:${g.ok ? 1 : 0.5}">Rename…</span> ${u.result ? `<span class="${u.cls || ''}">${esc(u.result)}</span>` : ''}</p>`;
      let h = `<div class="gxp-ren"><p class="gxpu_text"><b>Rename shuttle</b> (writes to the game) ${g.ok ? '' : `<span class="gxp-warn">${esc(g.why)}</span>`}</p>
        <label>New name <input id="gxp-ren-name" title="New shuttle name (letters, digits, spaces and simple punctuation)" maxlength="30" value="${esc(u.value == null ? s.name : u.value)}" style="width:200px"></label>`;
      const v = u.value == null ? s.name : u.value, prob = renameProblem(v) || (v === s.name ? 'Same as the current name.' : '');
      let url = ''; try { if (!prob) url = buildRenameUrl(s.id, v); } catch (e) { /* */ }
      h += `<p class="gxp-approx">Allowed: letters, digits, space and . _ ' - (max 30). ${prob ? `<span class="gxp-warn">${esc(prob)}</span>` : ''}</p>`;
      h += `<span class="gxbutton gxp-btn" data-gxp-ren="go" role="button" tabindex="0">Rename…</span> <span class="gxbutton gxp-btn" data-gxp-ren="close" role="button" tabindex="0">Cancel</span>
        ${u.msg ? `<p class="${u.cls || 'gxpu_text'}">${esc(u.msg)}</p>` : ''}</div>`;
      return h;
    }
    async function doRename(s) {
      const u = renameUi.get(s.id) || {}; renameUi.set(s.id, u);
      const name = ($('gxp-ren-name') || {}).value != null ? $('gxp-ren-name').value : u.value; u.value = name;
      const set = (msg, cls) => { u.msg = msg; u.cls = cls; if (selected === s.id) forceDetails(); };
      const g = renameGateFor(s); if (!g.ok) return set(g.why, 'gxp-warn');
      const prob = renameProblem(name) || (name === s.name ? 'Same as the current name.' : ''); if (prob) return set(prob, 'gxp-warn');
      const url = buildRenameUrl(s.id, name);
      const old = s.name;
      if (!(await confirmWrite({ title: 'Rename shuttle', lead: `Rename your shuttle in Simcountry:`, rows: [['Shuttle', old], ['New name', name], ['Shuttle ID', s.id]],
        debug: { method: 'jxShipRename', url, fields: [['miShipID', s.id], ['miObjectName', name + '  (sent escape()d)']] } }))) return set('Cancelled, nothing sent.', 'gxpu_text');
      set('Sending…', 'gxpu_text');
      const { outcome, detail, line } = await renameOne(s, name, g);
      if (outcome === 'busy') return set(detail, 'gxp-warn');
      if (outcome === 'verified') { u.open = false; u.result = `Renamed to "${name}" (verified).`; u.cls = 'gxpu_text'; u.msg = ''; if (selected === s.id) forceDetails(); }
      else if (/^dry run/.test(outcome)) set(`Dry run — not sent. Request: ${detail}`, 'gxpu_text');
      else set(line + '. Not retried.', 'gxp-warn');
      return outcome;
    }
    var writeLog = [];
    /** One rename: write, fresh re-read, log. No UI, no confirmation (callers confirm first). Never retried. */
    async function renameOne(s, name, g) {
      const url = buildRenameUrl(s.id, name), old = s.name;
      try { await writeSlot(); } catch (e) { return { outcome: 'busy', detail: e.message }; }
      let outcome = 'unknown', detail = '';
      try {
        const body = await client.writeUrl('jxShipRename', url, g, `${old} -> ${name}`);
        const msg = parseGameMessage(body); detail = msg || '';
        const d = parseShipInfo(await client.request('gxShipInfo', { miShipID: s.id }, { channel: 'verify:' + s.id, priority: 1 }).promise);
        if (d && d.name === name) { outcome = 'verified'; tracker.observe(s.id, { detail: d, name }, 'galaxyplus-write'); }
        else outcome = d ? 'unverified' : 'unknown', detail = (detail ? detail + ' · ' : '') + (d ? `re-read shows "${d.name}"` : 're-read failed');
      } catch (e) { if (e.name === 'DryRunError') { outcome = 'dry run — not sent'; detail = e.url; } else { outcome = 'failed'; detail = e.name === 'TimeoutError' ? 'no answer within 30 s: outcome UNKNOWN, check the shuttle before trying again' : e.message; } }
      finally { writeDone(); }
      const line = `rename ${old} -> "${name}": ${outcome}${detail ? ' (' + detail + ')' : ''}`;
      dbg.script(outcome === 'verified' ? 'info' : 'warn', line, { url, ship: s.id });
      if (!/^dry run/.test(outcome)) tracker.addWriteEvent && tracker.addWriteEvent(s, 'rename', old, name, outcome, url);
      writeLog.push({ t: Date.now(), action: 'rename', ship: s.id, from: old, to: name, outcome, detail, url });
      return { outcome, detail, line };
    }
    function forceDetails() { renderDetails.force = true; try { renderDetails(); } finally { renderDetails.force = false; } }

    /* ---------- hooks into the Details panes ---------- */
    function shipWriteHtml(s) {
      return renameHtml(s) + (typeof flightHtml === 'function' && isMine(s) ? flightHtml(s) : '') + (isMine(s) && settings.devTools && settings.formCapture ? `<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-capship="1" role="button" tabindex="0" title="Read-only: finds the game's action buttons for this shuttle and lets you open their forms without submitting">Capture action forms</span></p>` + capHtml('ship:' + s.id) : '');
    }
    function stationWriteHtml(r) {
      if (!settings.devTools || !settings.formCapture) return '';
      return `<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-capst="${esc(r.id)}" role="button" tabindex="0" title="Read-only: station page, your docks' trade pages and two market trade forms are scanned; nothing is submitted">Capture trade / dock forms</span></p>` + capHtml('station:' + r.id);
    }
    on(doc, 'click', e => {
      const t = e.target.closest && e.target.closest('[data-gxp-ren],[data-gxp-capship],[data-gxp-capst],[data-gxp-cap]'); if (!t) return; e.preventDefault(); e.stopPropagation();
      if (t.dataset.gxpCap) { const [k, i] = t.dataset.gxpCap.split('|'); return openLoader(k, +i); }
      if (t.dataset.gxpCapst) { const r = (X25.view && X25.view.r && String(X25.view.r.id) === t.dataset.gxpCapst) ? X25.view.r : (data.stations || []).find(x => String(x.id) === t.dataset.gxpCapst); if (r) captureStation(r); return; }
      const s = tracker.ships.get(selected); if (!s) return;
      if (t.dataset.gxpCapship) return captureShip(s);
      const u = renameUi.get(s.id) || {}; renameUi.set(s.id, u);
      if (t.dataset.gxpRen === 'open') { u.open = true; u.value = s.name; u.msg = ''; forceDetails(); }
      else if (t.dataset.gxpRen === 'close') { u.open = false; forceDetails(); }
      else if (t.dataset.gxpRen === 'go') doRename(s);
    }, true);
    on(doc, 'input', e => { const id = e.target && e.target.id; if (id === 'gxp-ren-name') { const s = tracker.ships.get(selected); if (s) { const u = renameUi.get(s.id) || {}; if (id === 'gxp-ren-name') u.value = e.target.value; else u.again = e.target.value; renameUi.set(s.id, u); } } }, true);
    app.formCapture = () => fcap; app.captureShip = captureShip; app.captureStation = captureStation; app.openLoader = openLoader; app.capState = capState; app.doRename = doRename; app.renameUi = renameUi; app.writeLog = () => writeLog; app.exportCapture = exportCapture;
    /* ===================================================================
     * 0.2.7  confirmation dialog · flights · bulk renamer · developer tools switch
     * =================================================================== */
    /* ---------- one formatted confirmation per write or batch; exact request under "Debug details" ---------- */
    function confirmWrite(spec) {
      if (typeof opts.confirmWrite === 'function') return Promise.resolve(!!opts.confirmWrite(spec));
      if (typeof opts.confirm === 'function') return Promise.resolve(!!opts.confirm((spec.title || '') + ': ' + (spec.lead || ''))); // older test suites
      return new Promise(res => {
        const old = $('gxp-confirm'); if (old) old.remove();
        const d = doc.createElement('div'); d.id = 'gxp-confirm'; d.className = 'gxp-dialog gxp-confirm'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-label', spec.title || 'Confirm');
        const rows = (spec.rows || []).map(([k, v], i) => `<tr class="gxpu_rc${i % 2}"><td class="gxpu_firstdata">${esc(k)}</td><td class="gxpu_data"><b>${esc(v == null ? '' : v)}</b></td></tr>`).join('');
        const items = spec.items ? `<div style="max-height:260px;overflow:auto"><table class="gxp-mini"><tr>${spec.items.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${spec.items.rows.map((r, i) => `<tr class="gxpu_rc${i % 2}">${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>` : '';
        const dbgList = [].concat(spec.debug || []);
        const dbgHtml = dbgList.map(x => `<p><b>${esc(x.method || '')}</b>${x.note ? ' · ' + esc(x.note) : ''}</p>${x.fields ? `<table class="gxp-mini">${x.fields.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td></tr>`).join('')}</table>` : ''}${x.url ? `<p>Request: <code class="gxp-url">${esc(x.url)}</code></p>` : ''}`).join('<hr>');
        d.innerHTML = `<b>${esc(spec.title || 'Confirm')}</b>${spec.lead ? `<p>${esc(spec.lead)}</p>` : ''}${rows ? `<table class="gxp-mini">${rows}</table>` : ''}${items}
          ${dryRunOn() ? '<p class="gxp-warn"><b>DRY RUN</b> (developer tools): nothing will be sent; the result shows the exact request.</p>' : ''}${(spec.notes || []).map(n => `<p class="gxp-approx">${esc(n)}</p>`).join('')}
          <p class="gxp-approx">This changes your game. It is sent once and never retried automatically; Galaxy Console re-reads the game afterwards to check it.</p>
          ${dbgList.length ? `<details class="gxp-dbgdetails"><summary>Debug details</summary>${dbgHtml}</details>` : ''}
          <div style="margin-top:8px"><span class="gxbutton gxp-btn" data-c="ok" role="button" tabindex="0"><b>${esc(spec.okLabel || 'Confirm')}</b></span> <span class="gxbutton gxp-btn" data-c="no" role="button" tabindex="0">Cancel</span></div>`;
        root.appendChild(d);
        const done = v => { d.remove(); res(v); };
        onBtn(d.querySelector('[data-c=ok]'), () => done(true)); onBtn(d.querySelector('[data-c=no]'), () => done(false));
        on(d, 'keydown', e => { if (e.key === 'Escape') done(false); });
        try { d.querySelector('[data-c=no]').focus(); } catch (e) { /* */ }
      });
    }

    /* ---------- developer / debug tools switch ---------- */
    const dryRunOn = () => !!(settings.devTools && settings.dryRun);
    client.dryRun = dryRunOn; app.dryRunOn = dryRunOn;
    function applyDevTools() {
      if (!settings.devTools && settings.dryRun) { settings.dryRun = false; saveSettings(); dbg.script('info', 'dry run switched off with the developer tools'); }
      root.classList.toggle('gxp-dev-on', !!settings.devTools);
      const tab = $('gxp-tab-debug'); if (tab) tab.style.display = settings.devTools ? '' : 'none';
      for (const el of root.querySelectorAll('[data-dev]')) el.style.display = settings.devTools ? '' : 'none';
      if (!settings.devTools && activeTab === 'debug') showTab('ships');
      const dr = doc.querySelector('#gxp-dialog [data-s=dryRun]'); if (dr) dr.checked = !!settings.dryRun;
    }
    applyDevTools();

    /* ---------- FLIGHTS ---------- */
    const flightUi = new Map(); // shipId -> { open, loading, plan, error, msg, cls, busy }
    function flightHtml(s) {
      const g = actionGate(settings, 'flights', isMine(s)), u = flightUi.get(s.id) || {};
      let h = `<p class="gxpu_text"><span class="gxbutton gxp-btn" data-gxp-fly="${u.open ? 'close' : 'open'}" role="button" tabindex="0" title="${esc(g.ok ? 'Schedule a flight for this shuttle' : g.why)}">${u.open ? 'Hide flight plan' : 'Fly to…'}</span>
        ${u.result ? ` <span class="${u.resultCls || ''}">${esc(u.result)}</span>` : ''}</p>`;
      if (!u.open) return h;
      if (!g.ok) h += `<p class="gxp-warn">${esc(g.why)} You can still look at the destinations.</p>`;
      if (u.loading) return h + '<p><span class="gxp-skel"></span> reading the flight plan…</p>';
      if (u.error) return h + `<p class="gxp-warn">${esc(u.error)}</p>`;
      const p = u.plan; if (!p) return h;
      if (p.current && p.current.name) h += `<p class="gxpu_text">Current destination: <b>${esc(p.current.name)}</b></p>`;
      for (const n of p.notes) h += `<p class="gxp-approx">${esc(n)}</p>`;
      const nOn = p.dests.filter(x => x.enabled).length;
      if (!nOn) h += `<p class="gxp-warn">The game offers no flight for this shuttle right now (all Schedule buttons are disabled in the game too${p.notes.length ? ': ' + esc(p.notes.join(' ')) : ''}).</p>`;
      h += `<div style="max-height:280px;overflow:auto"><table class="gxp-mini"><tr><th>Destination</th><th>Kind</th><th>Distance</th><th>Docks</th><th></th></tr>` + p.dests.map((x, i) => `<tr class="gxpu_rc${i % 2}"><td>${esc(x.name)}</td><td>${x.kind === 'station' ? 'station' : 'space center'}</td><td>${esc(x.distance)}</td><td>${esc(x.docks)}</td><td>${x.enabled
        ? `<span class="gxbutton gxp-btn" data-gxp-flyto="${i}" role="button" tabindex="0">Send here…</span>` : '<span class="gxp-approx">not offered now</span>'}</td></tr>`).join('') + '</table></div>';
      if (u.msg) h += `<p class="${u.cls || 'gxpu_text'}">${esc(u.msg)}</p>`;
      return h;
    }
    async function loadFlightPlan(s) {
      const u = flightUi.get(s.id) || {}; flightUi.set(s.id, u); u.loading = true; u.error = ''; forceDetails();
      try { u.plan = parseFlightPlan(await client.request('gxFlightPlan', { miObjectID: s.id }, { channel: 'fp:' + s.id, priority: 1 }).promise);
        dbg.script('info', `flight plan ${s.name}: ${u.plan.dests.length} destinations, ${u.plan.dests.filter(x => x.enabled).length} offered`); }
      catch (e) { if (e.name !== 'StaleResponseError') u.error = 'Flight plan not read: ' + e.message; }
      u.loading = false; if (selected === s.id) forceDetails();
    }
    /** Mirrors the game: open the destination's own form (gxShip2Station/Center), check its shape, confirm, submit it like gxSendShipForm, re-read. */
    async function sendFlight(s, dest) {
      const u = flightUi.get(s.id) || {}; flightUi.set(s.id, u);
      const set = (msg, cls) => { u.msg = msg; u.cls = cls; if (selected === s.id) forceDetails(); };
      const g = actionGate(settings, 'flights', isMine(s)); if (!g.ok) { set(g.why, 'gxp-warn'); return 'refused'; }
      if (!dest || !dest.call) { set('The game does not offer this flight now.', 'gxp-warn'); return 'refused'; }
      if (String(dest.call.args[1]) !== String(s.id)) { set('Flight plan belongs to another shuttle; reload it.', 'gxp-warn'); return 'refused'; }
      set('Opening the game\'s flight form…', 'gxpu_text');
      let form, method, loaderUrl, url, cf, pageText = '';
      try { const r = await client.loadForm(dest.call.fn, dest.call.args); loaderUrl = r.url; cf = captureForms(r.body); pageText = txt(parseDoc(r.body).body || parseDoc(r.body).documentElement).replace(/\s+/g, ' ').trim();
        capAdd({ kind: 'form', fn: dest.call.fn, args: dest.call.args, url: r.url, forms: cf.forms, submits: cf.submits, message: cf.message, title: cf.title, responseHead: capScrub(r.body.slice(0, 6000)) });
        form = cf.forms.find(f => f.submits.some(x => x.fn === 'gxSendShipForm')); method = form && form.submits.find(x => x.fn === 'gxSendShipForm').method;
        if (!form) { set('The game did not return a flight form' + (cf.message ? ': ' + cf.message : '.') + ' Nothing was sent.', 'gxp-warn'); return 'no-form'; }
        const a = dest.call.args, expect = dest.call.fn === 'gxShip2Station' ? { shipId: s.id, stationId: a[2] } : { shipId: s.id, worldNumber: a[2], entityNumber: a[4], targetId: a[5] };
        url = buildFlightUrl(method, form, expect);
      } catch (e) { set('Flight form check failed: ' + e.message + '. Nothing was sent.', 'gxp-warn'); dbg.script('warn', 'flight form check: ' + e.message); return 'refused'; }
      const ok = await confirmWrite({ title: 'Schedule flight', lead: 'Send your shuttle:', okLabel: 'Send shuttle',
        rows: [['Shuttle', s.name], ['From', s.location || '?'], ['To', dest.name + (dest.kind === 'station' ? ' (space station)' : ' (space center)')], ['Distance', dest.distance], ['Docks at destination', dest.docks]],
        notes: pageText ? ['The game\'s form says: ' + pageText.slice(0, 400)] : [],
        debug: [{ method: dest.call.fn + ' (form opened, not a write)', url: loaderUrl }, { method, note: 'submit, mirrored from gxSendShipForm(' + form.name + ')', fields: form.fields.map(f => [f.name + ' [' + f.type + (f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? ', checked' : ', unchecked: not sent') : '') + ']', f.value]), url }] });
      if (!ok) { set('Cancelled, nothing sent.', 'gxpu_text'); return 'cancelled'; }
      try { await writeSlot(); } catch (e) { set(e.message, 'gxp-warn'); return 'busy'; }
      set('Sending…', 'gxpu_text'); const from = s.destination || s.location || '';
      let outcome = 'unknown', detail = '';
      try {
        const body = await client.writeUrl(method, url, Object.assign({}, g, { flightMethod: method }), `${s.name} -> ${dest.name}`);
        detail = parseGameMessage(body) || '';
        const d = parseShipInfo(await client.request('gxShipInfo', { miShipID: s.id }, { channel: 'verify:' + s.id, priority: 1 }).promise);
        const same = x => !!x && (x === dest.name || x.indexOf(dest.name) === 0);
        if (d && same(d.destination)) outcome = 'verified';
        else { const fp = parseFlightPlan(await client.request('gxFlightPlan', { miObjectID: s.id }, { channel: 'fp:' + s.id, priority: 1 }).promise); u.plan = fp;
          outcome = fp.current && same(fp.current.name) ? 'verified' : 'unverified'; if (outcome !== 'verified') detail = (detail ? detail + ' · ' : '') + `re-read destination: "${(d && d.destination) || (fp.current && fp.current.name) || 'none'}"`; }
        if (d) tracker.observe(s.id, { detail: d }, 'galaxyplus-write');
      } catch (e) { if (e.name === 'DryRunError') { outcome = 'dry run — not sent'; detail = e.url; } else { outcome = 'failed'; detail = e.name === 'TimeoutError' ? 'no answer within 30 s: outcome UNKNOWN, check the shuttle before trying again' : e.message; } }
      finally { writeDone(); }
      const line = `flight ${s.name} -> ${dest.name}: ${outcome}${detail ? ' (' + detail + ')' : ''}`;
      dbg.script(outcome === 'verified' ? 'info' : 'warn', line, { url, ship: s.id });
      if (!/^dry run/.test(outcome)) tracker.addWriteEvent(s, 'flight', from, dest.name, outcome, url);
      writeLog.push({ t: Date.now(), action: 'flight', ship: s.id, from, to: dest.name, outcome, detail, url });
      if (outcome === 'verified') { u.open = false; u.result = `Flight to ${dest.name} scheduled (verified).`; u.resultCls = 'gxpu_text'; u.msg = ''; if (selected === s.id) forceDetails(); }
      else if (/^dry run/.test(outcome)) { u.result = `Dry run — not sent. Request: ${detail}`; u.resultCls = 'gxpu_text'; set('', 'gxpu_text'); }
      else set(line + '. Not retried.', 'gxp-warn');
      return outcome;
    }
    on(doc, 'click', e => {
      const t = e.target.closest && e.target.closest('[data-gxp-fly],[data-gxp-flyto]'); if (!t) return; e.preventDefault(); e.stopPropagation();
      const s = tracker.ships.get(selected); if (!s) return; const u = flightUi.get(s.id) || {}; flightUi.set(s.id, u);
      if (t.dataset.gxpFly === 'open') { u.open = true; u.msg = ''; loadFlightPlan(s); }
      else if (t.dataset.gxpFly === 'close') { u.open = false; forceDetails(); }
      else if (t.dataset.gxpFlyto != null && u.plan) sendFlight(s, u.plan.dests[+t.dataset.gxpFlyto]);
    }, true);

    /* ---------- BULK RENAMER (upper-right pane) ---------- */
    const BR = { rows: [], o: { pattern: '{name}', start: 1, pad: 2, step: 1, find: '', repl: '', regex: false, ci: true, prefix: '', suffix: '', kase: 'none', stopOnError: true }, running: false, abort: false, err: '' };
    const brTitle = x => x.toLowerCase().replace(/(^|[\s._'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    function brCompute() {
      const o = BR.o; BR.err = ''; let re = null;
      if (o.find) { try { re = o.regex ? new RegExp(o.find, o.ci ? 'gi' : 'g') : new RegExp(o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), o.ci ? 'gi' : 'g'); } catch (e) { BR.err = 'Find: ' + e.message; } }
      let n = +o.start || 0;
      for (const r of BR.rows) { const s = r.s;
        let v = String(o.pattern || '{name}').replace(/\{(n|name|type|loc|dest|id)\}/g, (m, k) => k === 'n' ? String(n).padStart(Math.max(0, Math.min(6, +o.pad || 0)), '0') : k === 'name' ? s.name : k === 'type' ? ((s.detail && s.detail.type) || 'Shuttle') : k === 'loc' ? (s.location || '') : k === 'dest' ? (s.destination || '') : String(s.id).slice(-4));
        if (r.include) n += +o.step || 1;
        if (re) v = v.replace(re, o.repl || '');
        v = (o.prefix || '') + v + (o.suffix || '');
        if (o.kase === 'upper') v = v.toUpperCase(); else if (o.kase === 'lower') v = v.toLowerCase(); else if (o.kase === 'title') v = brTitle(v);
        r.newName = v.replace(/\s+/g, ' ').trim(); if (!r.result) r.status = ''; }
      const mine = [...tracker.ships.values()].filter(x => isMine(x)), batchIds = new Set(BR.rows.filter(r => r.include).map(r => r.s.id)), count = new Map();
      for (const r of BR.rows) if (r.include) { const k = r.newName.toLowerCase(); count.set(k, (count.get(k) || 0) + 1); }
      for (const r of BR.rows) { if (r.result) continue; const p = BR.err || renameProblem(r.newName);
        if (p) r.status = 'invalid: ' + p; else if (r.newName === r.s.name) r.status = 'unchanged';
        else if (r.include && count.get(r.newName.toLowerCase()) > 1) r.status = 'duplicate in this batch';
        else if (mine.some(x => !batchIds.has(x.id) && x.name.toLowerCase() === r.newName.toLowerCase())) r.status = 'name used by another of your shuttles';
        else r.status = 'ok'; }
    }
    const brSendable = () => BR.rows.filter(r => r.include && r.status === 'ok' && !r.result);
    function openBulk() {
      const rows = (shipsTab.vt.rows || []).filter(s => isMine(s)); selected = null; X25.view = { kind: 'bulk' };
      BR.rows = rows.map(s => ({ s, include: true, newName: s.name, status: '', result: '' })); BR.abort = false;
      const o = BR.o, inp = (k, l, w, t) => `<label>${l} <input data-br="${k}" ${t ? `type="${t}"` : ''} value="${esc(o[k])}" style="width:${w}px"></label>`;
      $('gxp-details').innerHTML = `<h3 class="gxpu_header">Bulk rename <span class="gxp-id">${rows.length} of your shuttles from the current list</span></h3>
        <div class="gxp-bulk">${inp('pattern', 'Pattern', 160)} <span class="gxp-approx">tokens: {name} {n} {type} {loc} {dest} {id}</span><br>
        ${inp('start', '{n} start', 50, 'number')} ${inp('pad', 'digits', 40, 'number')} ${inp('step', 'step', 40, 'number')}<br>
        ${inp('find', 'Find', 110)} ${inp('repl', 'Replace with', 110)} <label><input type="checkbox" data-br="regex" ${o.regex ? 'checked' : ''}> regex</label> <label><input type="checkbox" data-br="ci" ${o.ci ? 'checked' : ''}> ignore case</label><br>
        ${inp('prefix', 'Prefix', 80)} ${inp('suffix', 'Suffix', 80)} <label>Case <select data-br="kase" title="Change the letter case of the new names">${[['none', 'keep'], ['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title']].map(([v, l]) => `<option value="${v}" ${o.kase === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label><input type="checkbox" data-br="stopOnError" ${o.stopOnError ? 'checked' : ''}> stop on first error</label></div>
        <p class="gxpu_text"><span class="gxbutton gxp-btn" data-brx="go" role="button" tabindex="0">Rename selected…</span> <span class="gxbutton gxp-btn" data-brx="stop" role="button" tabindex="0">Stop</span>
        <span class="gxbutton gxp-btn" data-brx="all" role="button" tabindex="0">all</span> <span class="gxbutton gxp-btn" data-brx="none" role="button" tabindex="0">none</span> <span class="gxbutton gxp-btn" data-brx="close" role="button" tabindex="0">Close</span> <span id="gxp-br-sum" class="gxp-approx"></span></p>
        <div id="gxp-br-prev" style="max-height:330px;overflow:auto"></div>`;
      brRender();
    }
    function brRender() {
      if (!X25.view || X25.view.kind !== 'bulk') return; brCompute(); const el = $('gxp-br-prev'); if (!el) return;
      const cls = st => /^ok|verified|dry run/.test(st) ? '' : 'gxp-warn';
      el.innerHTML = (BR.err ? `<p class="gxp-warn">${esc(BR.err)}</p>` : '') + `<table class="gxp-mini"><tr><th></th><th>Current name</th><th>New name</th><th>Check / result</th></tr>` + BR.rows.map((r, i) => `<tr class="gxpu_rc${i % 2}" data-br-row="${i}"><td><input type="checkbox" data-br-inc="${i}" ${r.include ? 'checked' : ''} ${BR.running ? 'disabled' : ''}></td><td>${esc(r.s.name)}</td><td>${r.newName === r.s.name ? '<span class="gxp-approx">(same)</span>' : '<b>' + esc(r.newName) + '</b>'}</td><td class="${cls(r.result || r.status)}">${esc(r.result || r.status)}</td></tr>`).join('') + '</table>';
      const sum = $('gxp-br-sum'); if (sum) sum.textContent = `${brSendable().length} to rename${BR.running ? ' · running…' : ''}`;
    }
    async function runBulk() {
      if (BR.running) return; brCompute(); const list = brSendable(); if (!list.length) { const s = $('gxp-br-sum'); if (s) s.textContent = 'Nothing to rename.'; return 'empty'; }
      const g0 = actionGate(settings, 'rename', true); if (!g0.ok) { const s = $('gxp-br-sum'); if (s) s.textContent = g0.why; return 'refused'; }
      const ok = await confirmWrite({ title: 'Bulk rename', lead: `Rename ${list.length} of your shuttles, one by one${BR.o.stopOnError ? ', stopping at the first problem' : ''}:`, okLabel: `Rename ${list.length}`,
        items: { head: ['Current name', 'New name'], rows: list.map(r => [r.s.name, r.newName]) },
        debug: list.slice(0, 50).map(r => ({ method: 'jxShipRename', url: buildRenameUrl(r.s.id, r.newName) })).concat(list.length > 50 ? [{ method: `… and ${list.length - 50} more` }] : []) });
      if (!ok) return 'cancelled';
      BR.running = true; BR.abort = false; let done = 0;
      for (const r of list) {
        if (BR.abort) { r.result = 'not sent (stopped)'; continue; }
        const g = actionGate(settings, 'rename', isMine(r.s)); if (!g.ok) { r.result = 'not sent: ' + g.why; BR.abort = true; continue; }
        r.result = 'sending…'; brRender();
        const res = await renameOne(r.s, r.newName, g); r.result = res.outcome + (res.detail ? ' (' + res.detail + ')' : ''); done++;
        if (res.outcome !== 'verified' && !/^dry run/.test(res.outcome) && BR.o.stopOnError) BR.abort = true;
        brRender();
      }
      BR.running = false; brRender(); dbg.script('info', `bulk rename: ${done} sent, ${list.filter(r => /^verified/.test(r.result)).length} verified`);
      return 'done';
    }
    shipsTab.bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="bulkRen" role="button" tabindex="0" title="Rename many of your shuttles at once (uses the shuttles shown in the list)">Bulk rename…</span>');
    onBtn(shipsTab.bar.querySelector('[data-act=bulkRen]'), openBulk);
    on(doc, 'input', e => { const k = e.target && e.target.dataset && e.target.dataset.br; if (!k || BR.running) return; BR.o[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; brRender(); }, true);
    on(doc, 'change', e => { const t = e.target; if (!t || !t.dataset) return;
      if (t.dataset.br) { BR.o[t.dataset.br] = t.type === 'checkbox' ? t.checked : t.value; brRender(); }
      else if (t.dataset.brInc != null) { BR.rows[+t.dataset.brInc].include = t.checked; brRender(); } }, true);
    on(doc, 'click', e => { const t = e.target.closest && e.target.closest('[data-brx]'); if (!t) return; e.preventDefault();
      const a = t.dataset.brx; if (a === 'go') runBulk(); else if (a === 'stop') BR.abort = true; else if (a === 'close') { X25.view = null; $('gxp-details').innerHTML = ''; }
      else if (!BR.running && (a === 'all' || a === 'none')) { for (const r of BR.rows) r.include = a === 'all'; brRender(); } }, true);

    app.confirmWrite = confirmWrite; app.sendFlight = sendFlight; app.loadFlightPlan = loadFlightPlan; app.flightUi = flightUi; app.openBulk = openBulk; app.runBulk = runBulk; app.BR = BR; app.applyDevTools = applyDevTools; app.brRender = brRender; app.renameOne = renameOne;

    /* ---------- 0.2.7 external links: country and owner (player/enterprise) names open the game's own page in a new tab ----------
     * Owner -> profile: the game's Owner cells link to /cgi-bin/cgi2nova?SN_ADDRESS=wwwPortal&SN_METHOD=ppview&miKey=<key> (VERIFIED: v1.html, shuttle list).
     * Country -> /<host>/cgi-bin/cgiw?gxCountryMap&miCountryNumber=<n>: the path gxCountryMapByHostName (gxscript l.50784) opens in its popup.
     *   Opening it as a normal tab is UNVERIFIED (marked in the link title). Host + number come from gxCountryMapByHostName(...) calls in shuttle pages. */
    const PROFILE_URL = k => 'https://www.simcountry.com/cgi-bin/cgi2nova?SN_ADDRESS=wwwPortal&SN_METHOD=ppview&miKey=' + k;
    /* 0.2.8.2: absolute URL on the country's own world server. The host comes from the game's gxCountryMapByHostName(host, n)
     * call for that place (per world, e.g. sim04 = GR); only simNN.simcountry.com hosts are accepted. Old builds produced
     * '/simNN.simcountry.com/cgi-bin/...', which the browser resolved under www.simcountry.com. */
    /* 0.2.8.3: the game's gxCountryMap answer is an HTML FRAGMENT served as Content-Type text/plain (the game loads it with XHR
     * into its own popup). Opened top-level, Firefox shows/saves it as a file. The link now opens the console's own map viewer
     * (gxRoot#gxc-map=...), which fetches the fragment same-origin through the game's proxy path /<host>/cgi-bin/cgiw and renders it. */
    const COUNTRY_URL = (h, n) => mapViewUrl(h, 'country', n);
    const LK = { at: 0, owners: new Map(), places: new Map() };
    function linkMaps() {
      if (Date.now() - LK.at < 3000) return LK; LK.at = Date.now();
      for (const s of tracker.ships.values()) {
        if (s.owner && /^\d{6,30}$/.test(s.ownerKey || '')) LK.owners.set(s.owner, s.ownerKey);
        const d = s.detail; if (!d) continue;
        for (const [nm, c] of [[d.location, d.locCountry], [d.destination, d.destCountry]]) if (nm && c && /^[a-z0-9.-]+\.simcountry\.com$/i.test(c[0]) && /^\d{1,8}$/.test(c[1])) LK.places.set(nm, c);
      }
      for (const [k, n] of owner.keys || []) if (typeof n === 'string' && /^\d{6,30}$/.test(k)) LK.owners.set(n, k);
      return LK;
    }
    function ownerLinkHtml(name, key) {
      if (!name) return ''; if (settings.linkNames === false) return plainOwner(name); key = /^\d{6,30}$/.test(key || '') ? key : linkMaps().owners.get(name);
      return key ? `<a class="gxp-ext" target="_blank" rel="noopener" href="${esc(PROFILE_URL(key))}" title="${esc(name)}: profile page (new tab)">${esc(name)}</a>` : `<span title="profile link not known yet">${esc(name)}</span>`;
    }
    function placeLinkHtml(name, inner) {
      if (settings.linkNames === false) return plainPlace(name, inner);
      const c = name && linkMaps().places.get(name); if (!c || !COUNTRY_URL(c[0], c[1])) return inner == null ? esc(name || '') : inner;
      return `<a class="gxp-ext" target="_blank" rel="noopener" href="${esc(COUNTRY_URL(c[0], c[1]))}" title="${esc(name)}: country page (new tab; URL unverified)">${inner == null ? esc(name) : inner}</a>`;
    }
    function countryIcon(name) { if (settings.linkNames === false) return ''; const c = name && linkMaps().places.get(name); return c && COUNTRY_URL(c[0], c[1]) ? ` <a class="gxp-ext" target="_blank" rel="noopener" href="${esc(COUNTRY_URL(c[0], c[1]))}" title="country page (new tab; URL unverified)">↗</a>` : ''; }
    /* 0.2.8.3 Settings: 'Clickable country/owner names' (linkNames) and 'also in tables' (linkNamesTables). */
    const plainOwner = name => esc(name || ''), plainPlace = (name, inner) => inner == null ? esc(name || '') : inner;
    function ownerLinkT(name, key) { return settings.linkNames !== false && settings.linkNamesTables !== false ? ownerLinkHtml(name, key) : plainOwner(name); }
    function placeLinkT(name, inner) { return settings.linkNames !== false && settings.linkNamesTables !== false ? placeLinkHtml(name, inner) : plainPlace(name, inner); }
    app.ownerLinkHtml = ownerLinkHtml; app.placeLinkHtml = placeLinkHtml;
    /* ===================================================================
     * 0.2.8.0  transport one-click + presets + recurring (triggers) · notifications · Trends · shortcuts · layout memory · map full screen
     * =================================================================== */
    const nowMs = () => Date.now();
    const lsGet = (k, d) => { try { const v = JSON.parse(W.localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { W.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* */ } };
    const csvQ = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

    /* ---------- transport: picks stay highlighted until queued; Execute now ---------- */
    function clearPicks() { trSel.o = trSel.t = trSel.p = null; transport.products = []; renderTransport(); }
    /** Build a queue item for origin/target/product and send just that one. One click (Settings "Execute now without confirmation", default ON). */
    async function executeNow() {
      if (!(trSel.o && trSel.t && trSel.p)) return trMsg('Pick origin, target and product first.', true);
      const q = Math.floor(+$('gxp-tr-qty').value || 0); if (q < 1) return trMsg('Enter a quantity.', true);
      if (!settings.writesEnabled) return trMsg('Writes are OFF (Settings).', true);
      try { await transport.readLive(); } catch (e) { /* validated again inside submit */ }
      const it = await transport.add(trSel.o, trSel.t, trSel.p, q);
      if (it.status !== 'valid') { await transport.remove(it.qid); return trMsg('Not sent: ' + it.issues.join('; '), true); }
      if (!settings.executeNow && !(await confirmWrite({ title: 'Submit transport request', lead: 'Send this transport request now:', okLabel: 'Send', rows: [['From', it.origin.name], ['To', it.target.name], ['Product', it.product.name], ['Quantity', fmtN(it.quantity)]] }))) { await transport.remove(it.qid); return trMsg('Cancelled, nothing sent.'); }
      await transport.submitAll([it.qid]);
      trMsg(`Execute now: ${ST_LABEL[it.status] || it.status}${it.message ? ' — ' + it.message : ''}`, ['submitted', 'dry-run'].indexOf(it.status) < 0); clearPicks(); return it.status;
    }

    /* ---------- presets (one-click fill) ---------- */
    const PR_KEY = 'gxp.trPresets'; let presets = lsGet(PR_KEY, []); const savePresets = () => lsSet(PR_KEY, presets);
    async function resolvePreset(p) {
      if (!transport.origins.length || !transport.targets.length) await Promise.all([transport.loadOrigins(), transport.loadTargets()]);
      const o = transport.origins.find(x => pickKey(x) === p.origin.key) || transport.origins.find(x => normName(x.name) === normName(p.origin.name));
      const t = transport.targets.find(x => pickKey(x) === p.target.key) || transport.targets.find(x => normName(x.name) === normName(p.target.name));
      if (!o || !t) throw new Error('origin or target of preset "' + p.name + '" is not offered by the game now');
      const prods = await transport.loadProducts(o, t), pr = prods.find(x => normName(x.name) === normName(p.product));
      if (!pr) throw new Error(`${p.product} is not offered at ${o.name} now`);
      return { o, t, pr };
    }
    async function applyPreset(id) {
      const p = presets.find(x => x.id === id); if (!p) return;
      try { const r = await resolvePreset(p); trSel.o = r.o; trSel.t = r.t; trSel.p = r.pr; const av = transport.available(r.o, r.pr);
        $('gxp-tr-qty').value = av == null ? p.qty : Math.min(p.qty, av); renderTransport(); trMsg(`Preset "${p.name}" filled in.`); return true; }
      catch (e) { trMsg(e.message, true); return false; }
    }
    function savePresetFromSel() {
      if (!(trSel.o && trSel.t && trSel.p)) return trMsg('Pick origin, target and product first.', true);
      const qty = Math.floor(+$('gxp-tr-qty').value || 0) || trSel.p.stock || 1;
      const name = `${fmtN(qty)} ${trSel.p.name}: ${aliasOf(trSel.o.name) || trSel.o.name} → ${aliasOf(trSel.t.name) || trSel.t.name}`;
      presets.push({ id: 'pr' + nowMs().toString(36), name, origin: { name: trSel.o.name, key: pickKey(trSel.o) }, target: { name: trSel.t.name, key: pickKey(trSel.t) }, product: trSel.p.name, qty });
      savePresets(); renderPresets(); trMsg('Preset saved.');
    }
    let recurFor = null;
    function renderPresets() {
      const el = $('gxp-tr-presets'); if (!el) return;
      el.innerHTML = `<b>Presets</b> ` + (presets.length ? presets.map(p => { const n = triggers.list.filter(t => t.action && t.action.preset === p.id && t.enabled).length;
        return `<span class="gxp-chip" data-preset="${esc(p.id)}" role="button" tabindex="0" title="One click: fill origin, target, product and quantity">${esc(p.name)}</span><span class="gxp-chip" data-prrec="${esc(p.id)}" role="button" tabindex="0" title="Repeat this transport on a timer">⟳${n ? ' ' + n : ''}</span><span class="gxp-chip" data-prdel="${esc(p.id)}" role="button" tabindex="0" title="Delete preset">✕</span>`; }).join(' ') : '<span class="gxp-approx">none yet</span>')
        + ` <span class="gxbutton gxp-btn" data-act="presetSave" role="button" tabindex="0">Save selection as preset</span>`;
      const rb = $('gxp-tr-recur'); const p = presets.find(x => x.id === recurFor);
      if (!p) { rb.style.display = 'none'; rb.innerHTML = ''; return; }
      const mine = triggers.list.filter(t => t.action && t.action.preset === p.id);
      rb.style.display = ''; rb.innerHTML = `<b>Repeat "${esc(p.name)}"</b> every <input id="gxp-rec-n" title="How many units between runs" type="number" min="1" step="1" value="1" style="width:60px">
        <select id="gxp-rec-u" title="Real time or game time unit for the repeat"><option value="time-real|hours">hours (real)</option><option value="time-real|minutes">minutes (real)</option><option value="time-real|days">days (real)</option><option value="time-game|tu">tu (game)</option><option value="time-game|game-days">game days</option></select>
        <span class="gxbutton gxp-btn" data-act="recAdd" role="button" tabindex="0">Add timer</span> <span class="gxbutton gxp-btn" data-act="recClose" role="button" tabindex="0">Close</span>
        <span class="gxp-approx">Runs with the normal send settings (Execute now ON: sent at once; OFF: queued for you). Overdue timers are only run after you confirm them when a session starts.</span>`
        + (mine.length ? '<table class="gxp-mini">' + mine.map((t, i) => `<tr class="gxpu_rc${i % 2}"><td><label><input type="checkbox" data-trig-on="${esc(t.id)}" ${t.enabled ? 'checked' : ''}> every ${t.condition.every} ${esc(t.condition.unit)}</label></td><td>next ${t.nextDue ? fmtTime(t.nextDue) : '-'}</td><td>last ${t.lastRun ? fmtTime(t.lastRun) + ': ' + esc(t.lastOutcome) : '-'}</td><td><span class="gxbutton gxp-btn" data-trig-del="${esc(t.id)}" role="button" tabindex="0">delete</span></td></tr>`).join('') + '</table>' : '');
    }
    on(TP, 'click', async e => {
      const t = e.target.closest('[data-preset],[data-prrec],[data-prdel],[data-act=presetSave],[data-act=recAdd],[data-act=recClose],[data-trig-del]'); if (!t) return;
      if (t.dataset.preset) return applyPreset(t.dataset.preset);
      if (t.dataset.prdel) { presets = presets.filter(x => x.id !== t.dataset.prdel); for (const tr of triggers.list.filter(x => x.action && x.action.preset === t.dataset.prdel)) await triggers.remove(tr.id); savePresets(); return renderPresets(); }
      if (t.dataset.prrec) { recurFor = recurFor === t.dataset.prrec ? null : t.dataset.prrec; return renderPresets(); }
      if (t.dataset.trigDel) { await triggers.remove(t.dataset.trigDel); return renderPresets(); }
      const a = t.dataset.act;
      if (a === 'presetSave') return savePresetFromSel();
      if (a === 'recClose') { recurFor = null; return renderPresets(); }
      if (a === 'recAdd') { const p = presets.find(x => x.id === recurFor); if (!p) return; const [type, unit] = $('gxp-rec-u').value.split('|'), every = Math.max(1, Math.floor(+$('gxp-rec-n').value || 1));
        await triggers.registerTrigger({ name: 'repeat ' + p.name, condition: { type, every, unit }, action: { kind: 'transport', preset: p.id } }); renderPresets(); }
    });
    on(TP, 'change', async e => { const id = e.target.dataset && e.target.dataset.trigOn; if (id) { await triggers.setEnabled(id, e.target.checked); renderPresets(); } });

    /* ---------- triggers: persisted timers; overdue ones are confirmed at session start ---------- */
    const triggers = createTriggers({ db, tuSeconds: () => settings.tuSeconds, gameDayTu: () => settings.gameDayTu || 24, onLog: (l, m) => dbg.script(l, m) });
    triggers.registerAction('transport', async t => {
      const p = presets.find(x => x.id === t.action.preset); if (!p) return 'preset deleted';
      if (!settings.writesEnabled) return 'not sent: writes are OFF';
      const r = await resolvePreset(p); try { await transport.readLive(); } catch (e) { /* */ }
      const it = await transport.add(r.o, r.t, r.pr, p.qty); if (it.status !== 'valid') { const why = it.issues.join('; '); await transport.remove(it.qid); return 'not queued: ' + why; }
      if (!settings.executeNow) { toast(`Recurring transport queued: ${p.name}. Press Submit all to send it.`); return 'queued (Execute now is OFF)'; }
      await transport.submitAll([it.qid]); return it.status + (it.message ? ': ' + it.message : '');
    });
    let trigRunning = false, startDone = false; const startPending = new Set(); // nothing runs before the session-start check has been answered
    async function runTriggers(list) { if (trigRunning) return; trigRunning = true; try { for (const t of list) { const out = await triggers.run(t); toast(`Recurring: ${t.name}: ${out}`); } } finally { trigRunning = false; renderPresets(); } }
    async function sessionStartTriggers() {
      const over = await triggers.sessionStart(); renderPresets(); if (!over.length) return { overdue: 0 };
      for (const t of over) startPending.add(t.id);
      const ok = await confirmWrite({ title: 'Overdue recurring actions', okLabel: `Run ${over.length} now`, lead: `These timers came due while Galaxy Console was closed. Run them now, one by one? (Cancel skips them to their next period.)`,
        items: { head: ['Action', 'Was due', 'Every'], rows: over.map(t => [t.name || t.id, fmtTime(t.nextDue), t.condition.every + ' ' + t.condition.unit]) } });
      if (ok) await runTriggers(over); else for (const t of over) await triggers.skip(t.id);
      startPending.clear(); renderPresets(); dbg.script('info', `session start: ${over.length} overdue trigger(s) ${ok ? 'run after confirmation' : 'skipped by the user'}`); return { overdue: over.length, ran: ok };
    }
    app.triggerStart = (async () => { try { await triggers.load(); renderPresets(); await new Promise(r => setTimeout(r, opts.triggerStartDelayMs != null ? opts.triggerStartDelayMs : 1500)); return await sessionStartTriggers(); } finally { startDone = true; } })();
    every(() => { if (!startDone || startPending.size || trigRunning) return; const due = triggers.evaluate().filter(t => !startPending.has(t.id)); if (due.length) runTriggers(due); }, opts.triggerTickMs || 10000);

    /* ---------- notifications ---------- */
    function toast(msg) { const t = doc.createElement('div'); t.className = 'gxp-toast'; t.textContent = msg; root.appendChild(t); setTimeout(() => t.remove(), 6000); app.notices.push({ t: nowMs(), msg }); }
    app.notices = [];
    let audio = null;
    function beep() { try { audio = audio || new (W.AudioContext || W.webkitAudioContext)(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.15); } catch (e) { /* */ } }
    function notify(title, body) {
      toast(title + ': ' + body); if (settings.notifySound) beep();
      try { if (settings.notifyDesktop && W.Notification && W.Notification.permission === 'granted') new W.Notification(title, { body, tag: 'gxc-' + title }); } catch (e) { /* */ }
      dbg.script('info', 'notification: ' + title + ': ' + body);
    }
    function notifySettingChanged(k) { if ((k === 'notifyDesktop' || k === 'notifyArrivals' || k === 'notifyTransports') && settings[k] && settings.notifyDesktop && W.Notification && W.Notification.permission === 'default') { try { W.Notification.requestPermission(); } catch (e) { /* */ } } }
    const startedAt = nowMs(); let evSeen = startedAt; const trPrev = new Map(); let trPrevInit = false;
    every(() => {
      if (!settings.notifyArrivals && !settings.notifyTransports) { evSeen = nowMs(); trPrevInit = false; return; }
      if (settings.notifyArrivals) for (const e of tracker.events) { if (e.t <= evSeen) continue;
        if (e.field === 'arrived' && (!e.st || nowMs() - e.st < 20 * 60000)) { const s = tracker.ships.get(e.ship); if (!settings.notifyMineOnly || (s && isMine(s))) notify('Shuttle arrived', `${e.name} at ${aliasOf(e.place) || e.place}`); } }
      evSeen = tracker.events.length ? Math.max(evSeen, tracker.events[tracker.events.length - 1].t) : evSeen;
      const cur = new Map(transport.live.filter(r => r.id).map(r => [r.id, r]));
      if (trPrevInit && settings.notifyTransports) for (const [id, r] of trPrev) { const n = cur.get(id);
        if (TR_STATUS[r.status] && TR_STATUS[r.status].active && (!n || !(TR_STATUS[n.status] || {}).active)) notify('Transport finished', `${fmtN(r.quantity)} ${r.product}: ${r.origin} → ${r.target}${n ? ' (' + n.statusLabel + ')' : ''}`); }
      trPrev.clear(); for (const [k, v] of cur) trPrev.set(k, v); trPrevInit = trPrevInit || !!transport.liveAt;
    }, opts.notifyTickMs || 3000);
    function settingsNotifyHtml() {
      const cb = (k, l) => `<label><input type="checkbox" data-s="${k}" ${settings[k] ? 'checked' : ''}> ${l}</label>`;
      return cb('notifyArrivals', 'shuttle arrivals') + cb('notifyMineOnly', '… only my shuttles') + cb('notifyTransports', 'transport finished (seen in your transport list)') + cb('notifyDesktop', 'desktop notification (the browser asks for permission once)') + cb('notifySound', 'sound') + '<p class="gxp-approx">Notifications always show inside the console too.</p>';
    }
    function settingsSendingHtml() {
      return `<label><input type="checkbox" data-s="executeNow" ${settings.executeNow ? 'checked' : ''}> <b>Execute now</b> sends a transport request with one click, no confirmation (also used by recurring transports)</label>
        <label>Game day length for "game days" timers: <input data-s="gameDayTu" title="How many tu make one game day (used by 'game days' timers)" type="number" min="1" step="1" value="${+settings.gameDayTu || 24}" style="width:60px"> tu <span class="gxp-approx">(unverified; adjust if your timers drift)</span></label>`;
    }

    /* ---------- Trends tab (from the register; keeps 4 real days, oldest purged) ---------- */
    /* 3.1.0 Trends: incremental aggregates. Before, opening the tab (and a 5-minute timer) re-read every stored event
     * from IndexedDB, derived all trips and rewrote the whole table: the cost grew with the register (see TEST/ARCH notes).
     * Now each recorded event updates the hour buckets as it is added (event hook), the buckets are cached in meta
     * 'trendHist' { v: 2 }, the tab renders straight from memory, and a full recompute only runs in the background
     * (batched cursor reads, yielding between batches): at first start after the upgrade and on "Refresh". */
    const HOUR = 3600000, KEEP = 4 * 86400000; let trend = {}; let trendWin = 86400000;
    let trPlace = new Map(), trendDirty = false, trendDelta = null, trendJob = null;
    const tBucket = (o, t) => { const h = Math.floor(t / HOUR) * HOUR; const b = o[h] || (o[h] = { routes: {}, products: {}, stations: {}, types: {}, owners: {} }); if (!b.types) { b.types = {}; b.owners = {}; } return b; };
    const addN = (o, k, n) => { if (k) o[k] = (o[k] || 0) + n; };
    function trendApply(o, places, e) {
      const t = e.st || e.t, old = t < nowMs() - KEEP;
      if (!old) { const b = tBucket(o, t); addN(b.types, e.field, 1); } // 3.1.3: every recorded event, by type (graph)
      if (!(e.source === 'logbook' || e.lk)) return;
      if (!old && e.owner) addN(tBucket(o, t).owners, e.owner, 1); // 3.1.3: logbook events per owner (graph)
      if (e.field === 'arrived') { if (!old) addN(tBucket(o, t).stations, e.place, 1); if (e.place) places.set(e.ship, e.place); return; }
      if (old) return;
      if (e.field === 'cargo_load') { addN(tBucket(o, t).products, e.product, +e.qty || 0); addN(tBucket(o, t).stations, e.place, 1); }
      else if (e.field === 'cargo_unload') addN(tBucket(o, t).stations, e.place, 1);
      else if (e.field === 'trip_start') { addN(tBucket(o, t).stations, e.place, 1); const from = e.from || places.get(e.ship); if (from && e.place) addN(tBucket(o, t).routes, from + ' → ' + e.place, 1); }
    }
    const trendPurge = o => { const since = nowMs() - KEEP; for (const h of Object.keys(o)) if (+h + HOUR < since) delete o[h]; return o; };
    tracker.eventHooks.add(e => { trendApply(trend, trPlace, e); trendDirty = true; if (trendDelta) trendDelta.push(e); });
    const trendSave = async () => { if (!trendDirty) return; trendDirty = false; trendPurge(trend); await db.setMeta('trendHist', { v: 3, at: nowMs(), data: trend }); }; // 3.1.3: v3 adds types / owners
    /** full recompute in the background; events added meanwhile are applied once (by their time) afterwards */
    function trendsRebuild() {
      if (trendJob) return trendJob;
      trendJob = (async () => {
        const t0 = nowMs(); trendDelta = []; await tracker.flush(); const fresh = {}, pl = new Map(); let n = 0; const tStart = Date.now();
        if (db.eachBatch) await db.eachBatch('events', 1000, async b => { for (const r of b) { const e = tracker.unpackEvent(r); if (e.t <= t0) trendApply(fresh, pl, e); } n += b.length; await new Promise(r => setTimeout(r, 0)); }, { t: t0 - KEEP - 86400000, dks: [] });
        for (const e of trendDelta) if (e.t > t0) trendApply(fresh, pl, e);
        trendDelta = null; trend = trendPurge(fresh); trPlace = pl; trendDirty = true; await trendSave();
        app.trendStats = { events: n, ms: Date.now() - tStart, at: nowMs() }; dbg.script('info', `trends recomputed in the background: ${n} events, ${app.trendStats.ms} ms`);
        if (activeTab === 'trends') renderTrends(); return trend;
      })().finally(() => { trendJob = null; });
      return trendJob;
    }
    app.trendsRebuild = trendsRebuild; app.trendNow = () => trend;
    (async () => { const st = await db.getMeta('trendHist', null);
      if (st && st.v === 3) { trend = trendPurge(st.data || {}); if (activeTab === 'trends') renderTrends(); }
      else { if (st && typeof st === 'object') trend = trendPurge(st.data || st); setTimeout(() => trendsRebuild().catch(e => dbg.script('warn', 'trends: ' + e.message)), opts.trendStartDelayMs != null ? opts.trendStartDelayMs : 5000); } })().catch(() => {});
    function trendAgg(win) { const since = nowMs() - win, out = { routes: {}, products: {}, stations: {} }, perHour = {};
      for (const [h, v] of Object.entries(trend)) { if (+h + HOUR < since) continue; for (const k of ['routes', 'products', 'stations']) for (const [n, c] of Object.entries(v[k])) out[k][n] = (out[k][n] || 0) + c;
        for (const [n, c] of Object.entries(v.stations)) (perHour[n] || (perHour[n] = {}))[h] = c; }
      return { out, perHour }; }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
    P('trends').innerHTML = `<div class="gxp-bar"><b>Trends</b> from what Galaxy Console has seen (last 4 days kept)
      <select data-tw title="Time window for the trends shown"><option value="21600000">6 hours</option><option value="86400000" selected>24 hours</option><option value="345600000">4 days</option></select>
      <span class="gxbutton gxp-btn" data-act="trRefresh" role="button" tabindex="0">Refresh</span> <span class="gxbutton gxp-btn" data-act="trExport" role="button" tabindex="0">Export trends CSV</span> <span id="gxp-trend-info" class="gxp-approx"></span></div><div class="gxp-scrollbox" id="gxp-trend-body"></div>`;
    function renderTrends() {
      const { out, perHour } = trendAgg(trendWin), hrs = []; for (let h = Math.floor((nowMs() - trendWin) / HOUR) * HOUR; h <= nowMs(); h += HOUR) hrs.push(h);
      const tbl = (title, head, rows) => `<h4>${title}</h4>` + (rows.length ? `<table class="gxp-mini"><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr>${rows.map((r, i) => `<tr class="gxpu_rc${i % 2}">${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="gxp-approx">Nothing seen in this window yet.</p>');
      const bars = n => { const v = hrs.map(h => (perHour[n] || {})[h] || 0), mx = Math.max(1, ...v); return `<span title="per hour, oldest left">${v.map(x => `<i style="display:inline-block;width:3px;margin-right:1px;background:#7aa35a;height:${Math.round(14 * x / mx) + 1}px;vertical-align:bottom"></i>`).join('')}</span>`; };
      $('gxp-trend-body').innerHTML = tbl('Busiest routes (trips)', ['Route', 'Trips'], top(out.routes, 15).map(([k, n]) => [esc(k), fmtN(n)]))
        + tbl('Most-moved products (loaded)', ['Product', 'Quantity'], top(out.products, 15).map(([k, n]) => [esc(k), fmtN(n)]))
        + tbl('Station / center activity', ['Place', 'Events', 'Over time'], top(out.stations, 15).map(([k, n]) => [placeLinkHtml(k, esc(aliasOf(k) || k)), fmtN(n), bars(k)]));
      $('gxp-trend-info').textContent = `${Object.keys(trend).length} hour bucket(s) stored`;
    }
    function trendsCSV() { const rows = [['record_type', 'hour_utc', 'key', 'count', 'quantity'].join(','), ['meta', '', 'format galaxyconsole-trends-1 / ' + VERSION, '', ''].join(',')];
      for (const h of Object.keys(trend).sort()) { const v = trend[h], iso = new Date(+h).toISOString();
        for (const [k, n] of Object.entries(v.routes)) rows.push(['route', iso, k, n, ''].map(csvQ).join(','));
        for (const [k, n] of Object.entries(v.products)) rows.push(['product', iso, k, '', n].map(csvQ).join(','));
        for (const [k, n] of Object.entries(v.stations)) rows.push(['station', iso, k, n, ''].map(csvQ).join(',')); }
      return '\uFEFF' + rows.join('\r\n'); }
    const exportTrends = async () => { await trendSave(); downloadText(doc, 'galaxyconsole-trends-' + new Date().toISOString().slice(0, 10) + '.csv', trendsCSV(), 'text/csv;charset=utf-8'); };
    on(P('trends'), 'click', async e => { const a = e.target.closest('[data-act]'); if (!a) return; if (a.dataset.act === 'trRefresh') { $('gxp-trend-info').textContent = 'recomputing in the background…'; await trendsRebuild(); renderTrends(); } if (a.dataset.act === 'trExport') exportTrends(); });
    on(P('trends'), 'change', e => { if (e.target.dataset.tw != null) { trendWin = +e.target.value; renderTrends(); } });
    { const evBar = P('events').querySelector('.gxp-bar'); if (evBar) { evBar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="trExport2" role="button" tabindex="0" title="Busiest routes, products and station activity per hour (last 4 days)">Export trends CSV</span>'); onBtn(evBar.querySelector('[data-act=trExport2]'), exportTrends); } }
    tabOpeners.trends = () => { renderTrends(); }; // 3.1.0: from the cached aggregates, no database scan
    every(() => { trendSave().catch(() => {}); if (activeTab === 'trends') renderTrends(); }, opts.trendTickMs || 60000);

    /* ---------- keyboard shortcuts (configurable) ---------- */
    const SC_DEFAULT = { tabNext: 'Alt+ArrowRight', tabPrev: 'Alt+ArrowLeft', refresh: 'Alt+R', focusFilter: '/', listDown: 'J', listUp: 'K', mapFull: 'Alt+F', settings: 'Alt+S' };
    const SC_LABEL = { tabNext: 'Next tab', tabPrev: 'Previous tab', refresh: 'Refresh now', focusFilter: 'Focus the list filter', listDown: 'Next row in the list', listUp: 'Previous row in the list', mapFull: 'Map full screen', settings: 'Open/close Settings' };
    for (let i = 1; i <= 9; i++) { SC_DEFAULT['tab' + i] = 'Alt+' + i; SC_LABEL['tab' + i] = 'Tab ' + i; }
    const sc = () => Object.assign({}, SC_DEFAULT, settings.shortcuts || {});
    const comboOf = e => { const k = e.key.length === 1 ? e.key.toUpperCase() : e.key; if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(k) >= 0) return ''; return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey && k.length > 1 ? 'Shift+' : '') + (e.metaKey ? 'Meta+' : '') + (k === ' ' ? 'Space' : k); };
    const visTabs = () => TABS.map(t => t[0]).filter(k => $('gxp-tab-' + k).style.display !== 'none');
    function listStep(d) { const rows = [...P(activeTab).querySelectorAll('tbody tr[data-k]')]; if (!rows.length) return; let i = rows.findIndex(r => r === doc.activeElement || r.classList.contains('sel'));
      i = Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d)); rows[i].focus(); rows[i].dispatchEvent(new W.MouseEvent('click', { bubbles: true })); }
    on(doc, 'keydown', e => {
      if (e.target && e.target.closest && e.target.closest('[data-sckey]')) return;
      const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (mapFs.on && !typing) { const st = 80; let h = true; if (e.key === 'ArrowLeft') mwrap.scrollLeft -= st; else if (e.key === 'ArrowRight') mwrap.scrollLeft += st; else if (e.key === 'ArrowUp') mwrap.scrollTop -= st; else if (e.key === 'ArrowDown') mwrap.scrollTop += st;
        else if (e.key === '+' || e.key === '=') app.setScale(app.getScale() * 1.25); else if (e.key === '-' || e.key === '_') app.setScale(app.getScale() / 1.25); else if (e.key === 'Escape') mapFullscreen(false); else h = false; if (h) { e.preventDefault(); return; } }
      const c = comboOf(e); if (!c) return; const map = sc(), act = Object.keys(map).find(k => map[k] === c); if (!act) return;
      if (typing && !/^(Alt|Ctrl|Meta)\+/.test(c)) return; e.preventDefault(); runShortcut(act);
    });
    function runShortcut(act) { const tabs = visTabs(), i = tabs.indexOf(activeTab);
      if (act === 'tabNext') showTab(tabs[(i + 1) % tabs.length]); else if (act === 'tabPrev') showTab(tabs[(i - 1 + tabs.length) % tabs.length]);
      else if (/^tab\d$/.test(act)) { const k = tabs[+act.slice(3) - 1]; if (k) showTab(k); }
      else if (act === 'refresh') $('gxp-refresh').click(); else if (act === 'focusFilter') { const f = P(activeTab).querySelector('input[type=search]'); if (f) f.focus(); }
      else if (act === 'listDown') listStep(1); else if (act === 'listUp') listStep(-1); else if (act === 'mapFull') mapFullscreen(!mapFs.on); else if (act === 'settings') $('gxp-settings-btn').click(); }
    function settingsKeysHtml() { const m = sc(); return '<table class="gxp-mini">' + Object.keys(SC_DEFAULT).map((k, i) => `<tr class="gxpu_rc${i % 2}"><td>${esc(SC_LABEL[k])}</td><td><input data-sckey="${k}" value="${esc(m[k])}" readonly style="width:130px" title="Click, then press the new key combination (Backspace = none)"></td><td><span class="gxp-chip" data-screset="${k}" role="button" tabindex="0">default</span></td></tr>`).join('') + '</table><p class="gxp-approx">Shortcuts are ignored while you type in a field (except ones with Alt/Ctrl). In full-screen map: arrows pan, + and − zoom, Esc exits.</p><span class="gxbutton gxp-btn" data-screset="*" role="button" tabindex="0">Reset all</span>'; }
    /* 3.0.8: event types recorded in the events register (all on by default; settings.eventsOff = { type: true }). */
    const EVENT_TYPES = [
      ['Shuttle logbook (read from the shuttle info page)', [
        ['trip_start', 'Logbook line: the shuttle started a trip (departure).'],
        ['arrived', 'Logbook line: the shuttle arrived at a space center or station.'],
        ['cargo_load', 'Logbook line: cargo loaded (product, quantity).'],
        ['cargo_unload', 'Logbook line: cargo unloaded / delivered (product, quantity).'],
        ['log', 'Any other logbook line not recognised as the types above (best guess: maintenance, misc. game messages).']]],
      ['Shuttle changes (seen in the lists, map and info pages)', [
        ['registered', 'A shuttle was seen for the first time and added to the register.'],
        ['location', 'The shuttle\'s location changed.'],
        ['destination', 'The shuttle\'s destination changed (set, changed or cleared).'],
        ['cargo', 'The cargo amount shown in the shuttle list changed.'],
        ['cargo_items', 'The cargo item list on the shuttle\'s cargo page changed.'],
        ['missions', 'Missions left changed (each flight uses one; 0 = retired).'],
        ['sinceTu', 'Time units since the last event changed (best guess: ticks up while idle or flying; very frequent).'],
        ['arrivalTu', 'Time units until arrival changed (frequent while in flight).'],
        ['status', 'Status changed (idle / in flight / retired …).'],
        ['onMap', 'The shuttle appeared on or disappeared from the galaxy map layer.'],
        ['flight', 'A new flight plan target was seen on the shuttle info page.']]],
      ['Your actions in Galaxy Console', [
        ['write_rename', 'You renamed a shuttle (outcome and request).'],
        ['write_flight', 'You sent a shuttle on a flight (outcome and request).'],
        ['write_cancel_transport', 'You cancelled a transport request (outcome and the game\'s reply).']]]];
    app.EVENT_TYPES = EVENT_TYPES;
    /* 3.0.8: retained-row limits (persisted as settings.debugRows / settings.eventRows) */
    function applyLimits(kind, v) {
      if (kind === 'debug') settings.debugRows = dbg.setLimit(v); else if (kind === 'events') settings.eventRows = tracker.setEventLimit(v);
      saveSettings(); dbg.script('info', `${kind} log limit = ${kind === 'debug' ? dbg.limit() : tracker.eventLimit} rows`); renderAll(); }
    app.applyLimits = applyLimits;
    if (settings.debugRows) dbg.setLimit(settings.debugRows); if (settings.eventRows) tracker.setEventLimit(settings.eventRows);
    /* Basic level (default): only trips, cargo, new shuttles and your own actions are recorded. */
    const EV_BASIC_OFF = ['log', 'location', 'destination', 'cargo', 'cargo_items', 'missions', 'sinceTu', 'arrivalTu', 'status', 'onMap', 'flight'];
    const basicOff = () => EV_BASIC_OFF.reduce((o, k) => (o[k] = true, o), {});
    const evOn = k => !((settings.eventsOff || basicOff())[k]);
    tracker.eventFilter = k => evOn(k);
    function settingsEventsHtml() {
      return `<p class="gxpu_text">Event types recorded in the events register (Events tab, events CSV, trends, notifications). Default is the basic level. Unchecked types are not recorded from now on; data already stored is kept.</p>
        <p><span class="gxbutton gxp-btn" data-evall="1" role="button" tabindex="0" title="Record every event type">Select all</span> <span class="gxbutton gxp-btn" data-evall="0" role="button" tabindex="0" title="Record no events (shuttle data is still kept)">Select none</span> <span class="gxbutton gxp-btn" data-evall="basic" role="button" tabindex="0" title="Restore the default basic level: trip_start, arrived, cargo_load, cargo_unload, registered and your own actions (rename, flight, cancel)">Basic (default)</span></p>` +
        EVENT_TYPES.map(([g, list]) => `<fieldset><legend>${esc(g)}</legend>${list.map(([k, tip]) => `<label title="${esc(tip)}" style="display:inline-block;min-width:190px"><input type="checkbox" data-evt="${k}" ${evOn(k) ? 'checked' : ''}> ${esc(k)}</label>`).join(' ')}</fieldset>`).join('') +
        `<p class="gxp-approx">Note: trips, trends and arrival notifications are built from trip_start / arrived / cargo events; turning those off stops them updating.</p>`;
    }
    function setEventType(k, onv) { const o = Object.assign({}, settings.eventsOff || basicOff()); if (onv) delete o[k]; else o[k] = true; settings.eventsOff = o; }
    app.setEventType = (k, v) => { setEventType(k, v); saveSettings(); };
    function settingsDialogExtras(d) {
      const tabsEl = d.querySelector('.gxp-subtabs'); if (!tabsEl) return;
      on(d, 'change', e => { const c = e.target.closest && e.target.closest('[data-evt]'); if (!c) return; setEventType(c.dataset.evt, c.checked); saveSettings(); dbg.script('info', `event type ${c.dataset.evt} ${c.checked ? 'recorded' : 'not recorded'}`); });
      on(d, 'click', e => { const b = e.target.closest && e.target.closest('[data-evall]'); if (!b) return; if (b.dataset.evall === 'basic') { settings.eventsOff = basicOff(); for (const c of d.querySelectorAll('[data-evt]')) c.checked = evOn(c.dataset.evt); saveSettings(); dbg.script('info', 'event types: basic (default)'); return; }
        const v = b.dataset.evall === '1';
        for (const c of d.querySelectorAll('[data-evt]')) { c.checked = v; setEventType(c.dataset.evt, v); } saveSettings(); dbg.script('info', 'event types: ' + (v ? 'all recorded' : 'none recorded')); });
      on(tabsEl, 'click', e => { const s = e.target.closest('[data-subtab]'); if (!s) return; for (const x of tabsEl.children) x.classList.toggle('on', x === s); for (const p of d.querySelectorAll('[data-sub]')) p.style.display = p.dataset.sub === s.dataset.subtab ? '' : 'none'; });
      on(d, 'keydown', e => { const inp = e.target.closest && e.target.closest('[data-sckey]'); if (!inp) return; e.preventDefault(); e.stopPropagation(); const c = e.key === 'Backspace' ? '' : comboOf(e); if (c == null || (c === '' && e.key !== 'Backspace')) return;
        settings.shortcuts = Object.assign({}, settings.shortcuts || {}, { [inp.dataset.sckey]: c }); inp.value = c; saveSettings(); dbg.script('info', `shortcut ${inp.dataset.sckey} = ${c || '(none)'}`); });
      on(d, 'click', e => { const r = e.target.closest('[data-screset]'); if (!r) return; const k = r.dataset.screset; if (k === '*') settings.shortcuts = {}; else { const o = Object.assign({}, settings.shortcuts || {}); delete o[k]; settings.shortcuts = o; } saveSettings();
        for (const i of d.querySelectorAll('[data-sckey]')) i.value = sc()[i.dataset.sckey]; });
    }

    /* ---------- map full screen ---------- */
    const mapFs = { on: false, saved: null }; const mwrap = $('gxp-mapwrap'), mframe = $('gxp-mapframe'); // 0.2.8.4: overlays live in the non-scrolling frame
    mframe.insertAdjacentHTML('beforeend', `<span id="gxp-fsbtn" role="button" tabindex="0" title="Full screen map (Esc to exit)" aria-label="Full screen map"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false" style="display:block"><path d="M0.75 3.5V0.75H3.5M6.5 0.75H9.25V3.5M9.25 6.5V9.25H6.5M3.5 9.25H0.75V6.5" fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="square" stroke-linejoin="miter"/></svg></span>
      <div id="gxp-fsctl" role="group" aria-label="Pan and zoom"><span></span><span class="gxbutton gxp-btn" data-pan="0,-1" role="button" title="Pan up">&#9650;</span><span></span>
      <span class="gxbutton gxp-btn" data-pan="-1,0" role="button" title="Pan left">&#9664;</span><span class="gxbutton gxp-btn" data-fsx role="button" title="Exit full screen">&#10005;</span><span class="gxbutton gxp-btn" data-pan="1,0" role="button" title="Pan right">&#9654;</span>
      <span class="gxbutton gxp-btn" data-zm="-1" role="button" title="Zoom out">&minus;</span><span class="gxbutton gxp-btn" data-pan="0,1" role="button" title="Pan down">&#9660;</span><span class="gxbutton gxp-btn" data-zm="1" role="button" title="Zoom in">+</span></div>`);
    function mapFullscreen(onOff) {
      if (onOff === mapFs.on) return;
      if (onOff) { mapFs.saved = { sl: mwrap.scrollLeft, st: mwrap.scrollTop, scale: app.getScale() }; mframe.classList.add('gxp-fs'); mapFs.on = true;
        try { if (mframe.requestFullscreen && !opts.noNativeFullscreen) mframe.requestFullscreen().catch(() => {}); } catch (e) { /* */ } }
      else { mframe.classList.remove('gxp-fs'); mapFs.on = false; try { if (doc.fullscreenElement && doc.exitFullscreen) doc.exitFullscreen().catch(() => {}); } catch (e) { /* */ }
        const s = mapFs.saved; if (s) { app.setScale(s.scale); mwrap.scrollLeft = s.sl; mwrap.scrollTop = s.st; } }
      renderAll();
    }
    on(doc, 'fullscreenchange', () => { if (!doc.fullscreenElement && mapFs.on) mapFullscreen(false); });
    onBtn($('gxp-fsbtn'), () => mapFullscreen(!mapFs.on));
    on($('gxp-fsctl'), 'click', e => { const b = e.target.closest('[data-pan],[data-zm],[data-fsx]'); if (!b) return; e.stopPropagation();
      if (b.dataset.pan) { const [x, y] = b.dataset.pan.split(',').map(Number); mwrap.scrollLeft += x * 120; mwrap.scrollTop += y * 120; }
      else if (b.dataset.zm) app.setScale(app.getScale() * (+b.dataset.zm > 0 ? 1.25 : 0.8)); else mapFullscreen(false); });
    on($('gxp-fsctl'), 'pointerdown', e => e.stopPropagation());
    app.mapFullscreen = mapFullscreen; app.mapFs = mapFs;

    /* ---------- remember window layout (pane sizes, active tab, scroll positions, map view) ---------- */
    const LAY_KEY = 'gxp.layout';
    function layoutNow() { const sc2 = {}; for (const [k] of TABS) { const s = P(k).querySelector('.gxp-vt-s'); if (s) sc2[k] = s.scrollTop; }
      return { left: $('gxp-left').style.flexBasis || '', details: $('gxp-details').style.flexBasis || '', tab: activeTab, scroll: sc2, lists: app.listHeights ? app.listHeights() : {}, map: mapFs.on && mapFs.saved ? mapFs.saved : { sl: mwrap.scrollLeft, st: mwrap.scrollTop, scale: app.getScale() } }; }
    let layLast = ''; const layStart = nowMs(), layHold = () => nowMs() - layStart < (opts.layoutHoldMs != null ? opts.layoutHoldMs : 10000); // do not save during start-up (restore pending)
    every(() => { if (!settings.layoutMemory || layHold()) return; const s = JSON.stringify(layoutNow()); if (s !== layLast) { layLast = s; lsSet(LAY_KEY, JSON.parse(s)); } }, opts.layoutTickMs || 5000);
    function restoreLayout() { const L = lsGet(LAY_KEY, null); if (!L || !settings.layoutMemory) return false;
      if (L.left) $('gxp-left').style.flexBasis = L.left; if (L.details) $('gxp-details').style.flexBasis = L.details;
      if (L.lists && app.setListHeights) app.setListHeights(L.lists); // 3.0.3 list heights
      if (L.tab && $('gxp-tab-' + L.tab) && $('gxp-tab-' + L.tab).style.display !== 'none') showTab(L.tab);
      setTimeout(() => { for (const [k, v] of Object.entries(L.scroll || {})) { const s = P(k) && P(k).querySelector('.gxp-vt-s'); if (s) s.scrollTop = v; }
        if (L.map) { if (L.map.scale) app.setScale(L.map.scale); mwrap.scrollLeft = L.map.sl || 0; mwrap.scrollTop = L.map.st || 0; } }, opts.layoutRestoreDelayMs != null ? opts.layoutRestoreDelayMs : 800);
      return true; }
    app.restoredLayout = restoreLayout(); app.layoutNow = layoutNow;

    app.executeNow = executeNow; app.applyPreset = applyPreset; app.presets = () => presets; app.triggers = triggers; app.sessionStartTriggers = sessionStartTriggers; app.trendsRebuild = trendsRebuild; app.trendsCSV = trendsCSV; app.trendAgg = trendAgg; app.runShortcut = runShortcut; app.toast = toast; app.renderPresets = renderPresets; app.clearPicks = clearPicks;

    /* ---------- standalone operation (0.2.8.0): no window.opener anywhere; cookies are the only auth ----------
     * keep-alive: a light read (the session probe) every keepAliveMin minutes, also while the window is hidden, so the game
     * session does not idle out when all other game tabs are closed. Recovery: while not signed in, re-probe every minute and
     * offer "Sign in…" which opens the game's start page in a popup FROM the console; any game page running this script
     * announces the sign-in over BroadcastChannel and the console resumes (no opener needed in either direction). */
    const SIGNIN_URL = String(GXP_URL).replace(/\/cgi-bin\/.*$/, '/') || 'https://www.simcountry.com/';
    let lastKeep = nowMs();
    every(() => { const t = nowMs(), km = opts.keepAliveMs || Math.max(1, +settings.keepAliveMin || 10) * 60000;
      if (session.state === 'expired') { if (t - session.lastProbe > (opts.reauthMs || 60000)) session.probe('re-auth check'); return; }
      if (t - lastKeep >= km) { lastKeep = t; session.probe('keep-alive'); } }, opts.keepAliveTickMs || 15000);
    function openSignIn() { const w2 = W.open(SIGNIN_URL, 'simc_signin', 'resizable=yes,scrollbars=yes,width=1100,height=800'); if (w2) w2.focus(); dbg.script('info', 'sign-in window opened from the console'); return !!w2; }
    { const b = $('gxp-session'); b.style.cursor = 'pointer'; on(b, 'click', () => { if (session.state === 'expired') openSignIn(); else session.probe('manual'); }); }
    app.openSignIn = openSignIn; app.SIGNIN_URL = SIGNIN_URL;
    app.activeTab = () => activeTab;
    /* ===================================================================
     * 3.1.0  Events tab settings panel (on/off, mode, types, limit, auto-export on rollover) · Debug tab settings
     *        (on/off, rows, dry run, form capture) · storage migration kick-off and progress
     * =================================================================== */
    /* ---------- apply settings to the tracker / debug log ---------- */
    function applyLogSettings() {
      tracker.loggingOn = settings.eventsOn !== false;
      tracker.mode = settings.eventsMode === 'compact' ? 'compact' : 'standard';
      dbg.setMinLevel(settings.debugOn === false ? 'error' : 'debug');
      if (typeof applyRollBatch === 'function') applyRollBatch();
    }
    /* 3.1.1: auto-export batch size follows the row limit */
    function applyRollBatch() { tracker.autoExport = !!settings.evAutoExport; }
    applyRollBatch(); app.rollBatch = () => (tracker.autoExport ? tracker.rollBatch() : 0);

    /* ---------- auto-export on rollover ---------- */
    const pad2 = n => String(n).padStart(2, '0');
    const localStamp = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    let lastRollName = '', rollSeq = 1, rollChain = Promise.resolve();
    app.rollovers = [];
    tracker.onTrim = rows => {
      if (!settings.evAutoExport || !rows.length) return;
      const batch = rows.slice(); // exactly the rows that leave memory: consecutive files never overlap or leave gaps
      rollChain = rollChain.then(async () => {
        let name = 'galaxy-console-events-' + localStamp(new Date()); if (name === lastRollName) name += '-' + (++rollSeq); else { lastRollName = name; rollSeq = 1; }
        const parts = await tracker.exportEventsParts(batch); downloadParts(doc, name + '.csv', parts, 'text/csv;charset=utf-8');
        app.rollovers.push({ name: name + '.csv', n: batch.length, first: batch[0].dk, last: batch[batch.length - 1].dk });
        dbg.script('info', `events rollover: ${batch.length} events exported to ${name}.csv before leaving memory`);
      }).catch(e => dbg.script('error', 'rollover export: ' + e.message));
    };
    app.rolloverDone = () => rollChain;

    /* ---------- 3.1.2: Events and Debug settings live in the Settings dialog (sub-tabs 'Events' and 'Debug'; Debug only with
     * developer tools on). The Events / Debug tab toolbars keep only their actions (exports, reset view). ---------- */
    let EVP = null;
    function evPanelHtml() {
      const compact = settings.eventsMode === 'compact';
      return `<fieldset><legend>Events settings</legend>
        <label title="Turn event recording off completely (shuttle data is still kept and refreshed)"><input type="checkbox" data-es="eventsOn" ${settings.eventsOn !== false ? 'checked' : ''}> <b>Record events</b></label><br>
        <label title="Standard: the event types ticked below. Compact: for every shuttle only departures (origin and destination), arrivals and cargo loaded / unloaded (product and quantity), with real time and the game's tu counter; enough for Trends, smallest storage.">Mode <select data-es="eventsMode"><option value="standard" ${compact ? '' : 'selected'}>Standard</option><option value="compact" ${compact ? 'selected' : ''}>Compact</option></select></label><br>
        <label title="Newest events kept in memory for the Events tab, Trends and notifications (1,000 – 200,000; default 20,000). Saved history is not trimmed.">Rows kept <input type="number" data-lim="events" min="1000" max="200000" step="1000" value="${tracker.eventLimit}" style="width:90px"></label><br>
        <label title="Each time the in-memory list rolls over, download the events that leave memory as galaxy-console-events-YYYYMMDD-HHMMSS.csv (local time): a continuous series of files while the console is open, without gaps or overlaps. One file every 1,000 events when Rows kept is 10,000 or less, every 10,000 events above that (memory may briefly hold Rows kept + one batch)."><input type="checkbox" data-es="evAutoExport" ${settings.evAutoExport ? 'checked' : ''}> Auto-export on rollover</label>
        </fieldset><div class="gxp-evtypes" style="${compact ? 'opacity:.5' : ''}" title="${compact ? 'Not used in Compact mode' : ''}">${settingsEventsHtml()}</div>
        <p class="gxp-approx">Export and "Reset view" buttons are in the Events tab.</p><span class="gxp-approx gxp-migr"></span>`;
    }
    const dbPanelHtml = () => `<label title="Off = only errors are logged (less work for the browser). The log keeps what it already has."><input type="checkbox" data-ds="debugOn" ${settings.debugOn !== false ? 'checked' : ''}> <b>Debug logging</b></label><br>
      <label title="Newest debug log lines kept in memory (1,000 – 100,000; default 15,000). Older lines are dropped at once when lowered.">Rows kept <input type="number" data-lim="debug" min="1000" max="100000" step="1000" value="${dbg.limit()}" style="width:90px"></label><br>
      <label title="3.1.5: byte budget of the debug log (5 – 4096 MB, default 500; last-resort safety net). Lines are capped at 64 KB text + 256 KB data; when the budget is reached the oldest lines go and debug-level lines stop being kept.">Debug memory budget <input type="number" data-mem="memDebugMB" min="5" max="4096" step="50" value="${settings.memDebugMB || 500}" style="width:70px"> MB</label><br>
      <label title="3.1.5: byte budget of the events kept in memory (20 – 8192 MB, default 2048; last-resort safety net), on top of Rows kept. The oldest rows leave memory first (auto-exported first when the rollover auto-export is on); saved history is kept.">Events memory budget <input type="number" data-mem="memEventsMB" min="20" max="8192" step="100" value="${settings.memEventsMB || 2048}" style="width:70px"> MB</label><br>
      <label title="Writes go through the normal confirmation but are NOT sent; the result shows the exact request"><input type="checkbox" data-ds="dryRun" ${settings.dryRun ? 'checked' : ''}> <b>Dry run</b></label><br>
      <label title="Show the 'Capture … forms' buttons and record every write exchange for the developer"><input type="checkbox" data-ds="formCapture" ${settings.formCapture ? 'checked' : ''}> <b>Form capture</b></label>
      <p class="gxp-approx">Export, copy and "Reset" buttons are in the Debug tab.</p>`;
    function settingsLogExtras(d) {
      const ev = d.querySelector('[data-sub=events]'), db = d.querySelector('[data-sub=debug]'), dtab = d.querySelector('[data-subtab=debug]');
      if (!ev || !db) return;
      EVP = ev; ev.innerHTML = evPanelHtml(); db.innerHTML = dbPanelHtml(); renderMigr();
      if (dtab) { dtab.setAttribute('data-dev', '1'); dtab.style.display = settings.devTools ? '' : 'none'; }
      on(ev, 'change', e => { const t = e.target, k = t.dataset.es;
        if (k) { settings[k] = t.type === 'checkbox' ? t.checked : t.value; saveSettings(); applyLogSettings(); dbg.script('info', `events setting ${k} = ${settings[k]}`);
          if (k === 'eventsMode') { const c = settings.eventsMode === 'compact', box = ev.querySelector('.gxp-evtypes'); box.style.opacity = c ? '.5' : ''; box.title = c ? 'Not used in Compact mode' : ''; } return; }
        if (t.dataset.lim) { applyLimits(t.dataset.lim, t.value); t.value = tracker.eventLimit; } });
      on(db, 'change', e => { const t = e.target, k = t.dataset.ds;
        if (k) { settings[k] = t.checked; saveSettings(); applyLogSettings(); if (k === 'formCapture') applyDevTools(); dbg.script(k === 'debugOn' && !t.checked ? 'error' : 'info', `debug setting ${k} = ${t.checked}`); renderAll(); return; }
        if (t.dataset.mem) { settings[t.dataset.mem] = Math.round(+t.value) || 0; saveSettings(); if (app.applyMemBudgets) app.applyMemBudgets(); t.value = t.dataset.mem === 'memDebugMB' ? Math.round(dbg.byteBudget() / 1048576) : Math.round(tracker.eventBytes / 1048576); dbg.script('info', `memory budget ${t.dataset.mem} = ${t.value} MB`); return; }
        if (t.dataset.lim) { applyLimits(t.dataset.lim, t.value); t.value = dbg.limit(); } });
      // developer tools switched in the same dialog: show / hide the Debug sub-tab at once
      on(d, 'change', e => { if (e.target.dataset && e.target.dataset.s === 'devTools' && dtab) { dtab.style.display = settings.devTools ? '' : 'none'; const ds = db.querySelector('[data-ds=dryRun]'); if (ds) ds.checked = !!settings.dryRun; } });
    }
    app.openEventsSettings = () => { const d = app.openSettings('events'); return d && d.querySelector('[data-sub=events]'); };
    evTab.bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="evSettings" role="button" tabindex="0" title="Open Settings › Events (recording on/off, mode, event types, rows kept, auto-export)">⚙ Settings</span>');
    onBtn(evTab.bar.querySelector('[data-act=evSettings]'), () => app.openSettings('events'));
    dbTab.bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="dbgSettings" role="button" tabindex="0" title="Open Settings › Debug (debug logging on/off, rows kept, dry run, form capture)">⚙ Settings</span>');
    onBtn(dbTab.bar.querySelector('[data-act=dbgSettings]'), () => app.openSettings('debug'));
    /** open Settings on a sub-tab ('events' | 'debug' | …) */
    app.openSettings = sub => { const b = $('gxp-settings-btn'); if (!$('gxp-dialog')) b.click(); const d = $('gxp-dialog'); const t = d && d.querySelector(`[data-subtab=${sub || 'general'}]`); if (t && t.style.display !== 'none') t.click(); return d; };

    /* ---------- storage migration (background, resumable) ---------- */
    function renderMigr() { const m = tracker.migration, el = EVP && EVP.isConnected ? EVP.querySelector('.gxp-migr') : null; if (!el) return;
      el.textContent = m.state === 'running' ? `Converting saved events to the compact storage format: ${fmtN(m.done)} of ${fmtN(m.total)}…` : m.state === 'done' ? `Saved events: compact storage (${fmtN(m.total)} converted).` : ''; }
    tracker.subscribe(() => { renderMigr(); if (tracker.migration.state === 'running' && activeTab === 'events') evTab.count.textContent = `storage upgrade: ${fmtN(tracker.migration.done)} / ${fmtN(tracker.migration.total)} events converted`; });
    setTimeout(() => tracker.migrateV2().catch(e => dbg.script('error', 'storage migration paused: ' + e.message + ' (resumes next start)')), opts.migrateDelayMs != null ? opts.migrateDelayMs : 8000);
    /* ===================================================================
     * 3.1.3  persistent sort / filter state (every tab) + per-tab "Reset filters" · Trends graph (in-console overlay, SVG)
     * =================================================================== */
    /* ---------- persistence: every filter control of every tab is saved in localStorage 'gxp.filters' as
     * { <tab>: { <control key>: value } } and restored at start (by setting the value and firing the control's own
     * input/change events, so each tab's existing filter code applies it). Dropdowns whose options appear later
     * (owners, locations, stations) are re-tried every second until the option exists or the user picks something.
     * Table sorts are kept by VTable itself (gxp.cols.<table>.sort). ---------- */
    const FKEY = 'gxp.filters';
    const fStore = (() => { const v = lsGet(FKEY, {}); return v && typeof v === 'object' ? v : {}; })();
    const fSave = () => { try { W.localStorage.setItem(FKEY, JSON.stringify(fStore)); } catch (e) { /* */ } };
    const FSEL = '[data-f],[data-tf],[data-tw],#gxp-trl-st,#gxp-trl-q';
    const ckey = el => el.dataset.f ? 'f:' + el.dataset.f : el.dataset.tf ? 'tf:' + el.dataset.tf : el.dataset.tw != null ? 'tw' : el.id ? 'id:' + el.id : '';
    const ctlVal = el => (el.type === 'checkbox' ? !!el.checked : el.value);
    const panels = () => [...root.querySelectorAll('[id^=gxp-panel-]')].map(p => [p.id.slice(10), p]);
    const ctls = p => [...p.querySelectorAll(FSEL)].filter(el => /^(INPUT|SELECT)$/.test(el.tagName) && el.type !== 'file' && ckey(el));
    const fDefaults = {}; const fPending = new Map(); // el -> value still to apply
    // defaults = what the markup declares (not the current value, which older code may already have restored)
    const ctlDefault = el => el.type === 'checkbox' ? !!el.defaultChecked : el.tagName === 'SELECT' ? ((([...el.options].find(o => o.defaultSelected) || el.options[0]) || {}).value || '') : el.defaultValue;
    for (const [k, p] of panels()) { fDefaults[k] = {}; for (const el of ctls(p)) fDefaults[k][ckey(el)] = ctlDefault(el); }
    const fire = el => { el.dispatchEvent(new W.Event('input', { bubbles: true })); el.dispatchEvent(new W.Event('change', { bubbles: true })); };
    const setCtl = (el, v) => { if (el.type === 'checkbox') { if (el.checked === !!v) return true; el.checked = !!v; fire(el); return true; }
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(v))) return false; if (el.value === String(v)) return true; el.value = String(v); fire(el); return true; };
    let fRestoring = false;
    function fApply(only) {
      fRestoring = true;
      try { for (const [k, p] of panels()) { const st = fStore[k]; if (!st) continue; for (const el of ctls(p)) { const ck = ckey(el); if (!(ck in st)) continue; if (only && !only.has(el)) continue; if (setCtl(el, st[ck])) fPending.delete(el); else fPending.set(el, st[ck]); } } }
      finally { fRestoring = false; }
    }
    for (const [k, p] of panels()) {
      const save = e => { const el = e.target; if (fRestoring || !el.matches || !el.matches(FSEL) || el.type === 'file' || !ckey(el)) return; fPending.delete(el); (fStore[k] || (fStore[k] = {}))[ckey(el)] = ctlVal(el); fSave(); };
      on(p, 'input', save); on(p, 'change', save);
    }
    fApply(); every(() => { if (fPending.size) fApply(new Set(fPending.keys())); }, 1000);
    function resetFilters(k) {
      const p = $('gxp-panel-' + k); if (!p) return; delete fStore[k]; fSave();
      fRestoring = true; try { for (const el of ctls(p)) { fPending.delete(el); const d = (fDefaults[k] || {})[ckey(el)]; if (d !== undefined) setCtl(el, d); } } finally { fRestoring = false; }
      const v = (app.vts || {})[k]; for (const t of v ? (v.list ? v.list() : [v]) : []) if (t && t.resetSort) t.resetSort();
      dbg.script('info', `filters and sort of the ${k} tab reset`); renderAll();
    }
    app.resetFilters = resetFilters; app.filterStore = () => fStore;
    for (const [k, p] of panels()) {
      if (!ctls(p).length && !(app.vts || {})[k]) continue;
      const bar = k === 'transport' ? ($('gxp-trl-q') || {}).parentNode : p.querySelector('.gxp-bar'); if (!bar) continue;
      bar.insertAdjacentHTML('beforeend', ` <span class="gxbutton gxp-btn" data-act="fReset" data-ftab="${k}" role="button" tabindex="0" title="Reset this tab's filters, searches and sort to the defaults (they are otherwise kept across tabs and reloads)">Reset filters</span>`);
      onBtn(bar.querySelector(`[data-ftab=${k}]`), () => resetFilters(k));
    }

    /* ---------- Trends graph: in-console overlay (no popup window: popups can be blocked, would need their own copy of
     * the script / session, and the console must keep working standalone). Data = the cached hourly trend buckets only
     * (app.trendNow(), maintained incrementally); redraws never read the database. ---------- */
    const GDIMS = [['types', 'Events by type (count)'], ['products', 'Cargo loaded by product (quantity)'], ['routes', 'Trips by route (count)'], ['stations', 'Station / center activity (events)'], ['owners', 'Logbook events by owner (count)']];
    const GKEY = 'gxp.graph', gDefault = () => ({ layers: [{ dim: 'types', inc: '', exc: '', top: 5, min: 0, sort: 'total' }], win: 86400000, game: false, norm: false, hidden: [], view: null });
    let GS = Object.assign(gDefault(), lsGet(GKEY, {})); if (!Array.isArray(GS.layers) || !GS.layers.length) GS.layers = gDefault().layers;
    const gSave = () => { try { W.localStorage.setItem(GKEY, JSON.stringify(GS)); } catch (e) { /* */ } };
    const splitList = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    /** series of one layer: filter (include / exclude substrings, min total), top-N by total, then sort (total | name) */
    function graphSeries(tr, layer, win, nowT) {
      const H = 3600000, from = Math.floor((nowT - win) / H) * H, hours = []; for (let h = from; h <= nowT; h += H) hours.push(h);
      const idx = new Map(hours.map((h, i) => [h, i])), acc = new Map();
      for (const [h, b] of Object.entries(tr || {})) { const i = idx.get(+h); if (i == null || !b) continue; for (const [n, v] of Object.entries(b[layer.dim] || {})) { let a = acc.get(n); if (!a) acc.set(n, a = new Array(hours.length).fill(0)); a[i] += +v || 0; } }
      const inc = splitList(layer.inc), exc = splitList(layer.exc), min = +layer.min || 0, top = Math.max(0, +layer.top || 0);
      let out = [...acc].map(([name, pts]) => ({ id: layer.dim + ':' + name, dim: layer.dim, name, pts, total: pts.reduce((x, y) => x + y, 0) }))
        .filter(s => (!inc.length || inc.some(q => s.name.toLowerCase().indexOf(q) >= 0)) && !exc.some(q => s.name.toLowerCase().indexOf(q) >= 0) && s.total >= min && s.total > 0);
      out.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1)); if (top) out = out.slice(0, top);
      if (layer.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
      return { hours, series: out };
    }
    app.graphSeries = graphSeries; app.graphState = () => GS;
    const PAL = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f'];
    function graphData() { const nowT = nowMs(); let hours = [], all = []; for (const L of GS.layers) { const r = graphSeries(app.trendNow(), L, GS.win, nowT); hours = r.hours; all = all.concat(r.series); } return { hours, series: all, nowT }; }
    function graphSvg(dd) {
      const Wd = 900, Ht = 380, ml = 56, mr = 12, mt = 10, mb = GS.game ? 46 : 30, pw = Wd - ml - mr, ph = Ht - mt - mb;
      const t0 = dd.hours[0] || nowMs() - GS.win, t1 = dd.hours[dd.hours.length - 1] || nowMs();
      const v = GS.view && GS.view.from < GS.view.to ? GS.view : { from: t0, to: Math.max(t1, t0 + 3600000) };
      const X = t => ml + (t - v.from) / (v.to - v.from) * pw, vis = dd.series.filter(s => GS.hidden.indexOf(s.id) < 0);
      const val = (s, i) => GS.norm ? (s._mx ? s.pts[i] / s._mx * 100 : 0) : s.pts[i];
      let mx = 0; for (const s of vis) { s._mx = Math.max(...s.pts); dd.hours.forEach((h, i) => { if (h >= v.from - 3600000 && h <= v.to + 3600000) mx = Math.max(mx, val(s, i)); }); } mx = mx || 1;
      const Y = y => mt + ph - y / mx * ph; let g = `<svg xmlns="http://www.w3.org/2000/svg" id="gxp-graph-svg" viewBox="0 0 ${Wd} ${Ht}" width="100%" style="max-height:60vh;background:#fff;cursor:grab;user-select:none" font-size="10" font-family="arial">`;
      g += `<defs><clipPath id="gxp-gclip"><rect x="${ml}" y="${mt}" width="${pw}" height="${ph}"/></clipPath></defs>`;
      for (let k = 0; k <= 4; k++) { const y = mx * k / 4; g += `<line x1="${ml}" x2="${ml + pw}" y1="${Y(y)}" y2="${Y(y)}" stroke="#eee"/><text x="${ml - 4}" y="${Y(y) + 3}" text-anchor="end">${GS.norm ? Math.round(y) + '%' : fmtN(Math.round(y))}</text>`; }
      const span = v.to - v.from, step = [3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000, 86400000].find(s => span / s <= 10) || 86400000;
      const pad = n => String(n).padStart(2, '0'), tuS = (+settings.tuSeconds || 4) * 1000;
      for (let t = Math.ceil(v.from / step) * step; t <= v.to; t += step) { const d = new Date(t), x = X(t);
        g += `<line x1="${x}" x2="${x}" y1="${mt}" y2="${mt + ph}" stroke="#f2f2f2"/><text x="${x}" y="${mt + ph + 13}" text-anchor="middle">${step >= 86400000 || d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}</text>`;
        if (GS.game) g += `<text x="${x}" y="${mt + ph + 26}" text-anchor="middle" fill="#666">${Math.round((t - dd.nowT) / tuS)} tu</text>`; }
      g += `<text x="${ml + pw}" y="${Ht - 3}" text-anchor="end" fill="#666">local time${GS.game ? ' · game time: tu relative to now (≈' + (tuS / 1000) + ' s per tu, Settings)' : ''}</text>`;
      g += `<rect x="${ml}" y="${mt}" width="${pw}" height="${ph}" fill="none" stroke="#999"/><g clip-path="url(#gxp-gclip)">`;
      dd.series.forEach((s, si) => { s.color = PAL[si % PAL.length]; if (GS.hidden.indexOf(s.id) >= 0) return;
        g += `<polyline fill="none" stroke="${s.color}" stroke-width="1.6" points="${dd.hours.map((h, i) => `${X(h + 1800000).toFixed(1)},${Y(val(s, i)).toFixed(1)}`).join(' ')}"><title>${esc(s.name)}</title></polyline>`; });
      return g + '</g></svg>';
    }
    let GO = null;
    function graphCtlHtml() {
      const lay = GS.layers.map((L, i) => `<div data-gl="${i}" style="margin:2px 0">${i + 1}. <select data-g="dim" title="What to plot (from the recorded events)">${GDIMS.map(([k, l]) => `<option value="${k}" ${L.dim === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input data-g="inc" value="${esc(L.inc)}" placeholder="include…" size="12" title="Only names containing one of these (comma-separated); empty = all">
        <input data-g="exc" value="${esc(L.exc)}" placeholder="exclude…" size="12" title="Hide names containing any of these (comma-separated)">
        top <input data-g="top" type="number" min="0" max="50" value="${L.top}" style="width:46px" title="Keep the N largest by total (0 = all)">
        min <input data-g="min" type="number" min="0" value="${L.min}" style="width:60px" title="Hide series whose total in the window is below this">
        <select data-g="sort" title="Legend order"><option value="total" ${L.sort !== 'name' ? 'selected' : ''}>by total</option><option value="name" ${L.sort === 'name' ? 'selected' : ''}>by name</option></select>
        <span class="gxbutton gxp-btn" data-gact="del" role="button" tabindex="0" title="Remove this series group">×</span></div>`).join('');
      return `<div class="gxp-bar"><b>Trends graph</b> <select data-gw title="Time window">${[[21600000, '6 hours'], [86400000, '24 hours'], [172800000, '2 days'], [345600000, '4 days']].map(([v, l]) => `<option value="${v}" ${GS.win === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label title="Second axis row: game time in tu relative to now, converted with Settings › seconds per tu (approximate)"><input type="checkbox" data-gx="game" ${GS.game ? 'checked' : ''}> game time</label>
        <label title="Scale every series to its own maximum (100 %), to compare shapes of very different sizes"><input type="checkbox" data-gx="norm" ${GS.norm ? 'checked' : ''}> scale each to 100 %</label>
        <span class="gxbutton gxp-btn" data-gact="zin" role="button" tabindex="0" title="Zoom in (or mouse wheel on the graph)">+</span><span class="gxbutton gxp-btn" data-gact="zout" role="button" tabindex="0" title="Zoom out">−</span><span class="gxbutton gxp-btn" data-gact="zreset" role="button" tabindex="0" title="Show the whole window (drag the graph to pan)">⟲</span>
        <span class="gxbutton gxp-btn" data-gact="add" role="button" tabindex="0" title="Overlay another series group">+ series group</span> <span class="gxbutton gxp-btn" data-gact="reset" role="button" tabindex="0" title="Back to the default graph selection">Reset</span> <span class="gxbutton gxp-btn" data-gact="close" role="button" tabindex="0" title="Close (selections are kept)">Close</span></div>
        ${lay}<div id="gxp-graph-plot"></div><div id="gxp-graph-legend" style="margin-top:4px"></div><p class="gxp-approx">From the cached trend buckets (hourly, last 4 days); no database reads on redraw.</p>`;
    }
    function graphDraw() {
      if (!GO) return; const dd = graphData(); $('gxp-graph-plot').innerHTML = dd.series.length ? graphSvg(dd) : '<p>No data for this selection yet.</p>';
      $('gxp-graph-legend').innerHTML = dd.series.map(s => `<span data-gs="${esc(s.id)}" role="button" tabindex="0" title="Click to show / hide · total ${fmtN(s.total)}" style="cursor:pointer;margin-right:10px;white-space:nowrap;${GS.hidden.indexOf(s.id) >= 0 ? 'opacity:.35;text-decoration:line-through' : ''}"><i style="display:inline-block;width:12px;height:3px;vertical-align:middle;background:${s.color || '#999'}"></i> ${esc(s.name)} <span class="gxp-approx">(${fmtN(s.total)})</span></span>`).join('');
      app.lastGraph = dd;
    }
    const zoom = (f, cx) => { const dd = app.lastGraph || graphData(); const t0 = dd.hours[0], t1 = dd.hours[dd.hours.length - 1] + 3600000; const v = GS.view || { from: t0, to: t1 };
      const c = cx == null ? (v.from + v.to) / 2 : cx, span = Math.max(3600000, Math.min(t1 - t0, (v.to - v.from) * f)); let from = c - (c - v.from) * span / (v.to - v.from); from = Math.max(t0, Math.min(from, t1 - span));
      GS.view = span >= t1 - t0 ? null : { from, to: from + span }; gSave(); graphDraw(); };
    function openGraph() {
      if (GO) { GO.remove(); GO = null; }
      GO = doc.createElement('div'); GO.id = 'gxp-graph'; GO.setAttribute('role', 'dialog'); GO.setAttribute('aria-label', 'Trends graph');
      GO.style.cssText = 'position:fixed;left:4%;top:5%;width:92%;max-height:90%;overflow:auto;background:#fff;border:1px solid #888;box-shadow:0 6px 24px rgba(0,0,0,.35);z-index:2147483000;padding:8px';
      GO.innerHTML = graphCtlHtml(); root.appendChild(GO); graphDraw();
      const upd = e => { const t = e.target, row = t.closest('[data-gl]');
        if (row && t.dataset.g) { const L = GS.layers[+row.dataset.gl]; L[t.dataset.g] = t.type === 'number' ? +t.value || 0 : t.value; }
        else if (t.dataset.gw != null) { GS.win = +t.value; GS.view = null; } else if (t.dataset.gx) GS[t.dataset.gx] = t.checked; else return;
        gSave(); graphDraw(); };
      on(GO, 'change', upd); on(GO, 'input', e => { if (e.target.dataset.g === 'inc' || e.target.dataset.g === 'exc') upd(e); });
      on(GO, 'click', e => { const s = e.target.closest('[data-gs]'); if (s) { const id = s.dataset.gs, i = GS.hidden.indexOf(id); if (i >= 0) GS.hidden.splice(i, 1); else GS.hidden.push(id); gSave(); graphDraw(); return; }
        const b = e.target.closest('[data-gact]'); if (!b) return; const a = b.dataset.gact;
        if (a === 'close') { GO.remove(); GO = null; return; } if (a === 'zin') return zoom(0.5); if (a === 'zout') return zoom(2); if (a === 'zreset') { GS.view = null; gSave(); return graphDraw(); }
        if (a === 'add') GS.layers.push({ dim: 'products', inc: '', exc: '', top: 5, min: 0, sort: 'total' });
        else if (a === 'del') { GS.layers.splice(+b.closest('[data-gl]').dataset.gl, 1); if (!GS.layers.length) GS.layers = gDefault().layers; }
        else if (a === 'reset') GS = gDefault();
        gSave(); const keep = GO; keep.innerHTML = graphCtlHtml(); graphDraw(); });
      const tAt = ev => { const svg = $('gxp-graph-svg'); if (!svg || !app.lastGraph) return null; const r = svg.getBoundingClientRect(), dd = app.lastGraph, v = GS.view || { from: dd.hours[0], to: dd.hours[dd.hours.length - 1] + 3600000 };
        const x = (ev.clientX - r.left) / (r.width || 1) * 900; return v.from + (x - 56) / 832 * (v.to - v.from); };
      on(GO, 'wheel', e => { if (!e.target.closest || !e.target.closest('#gxp-graph-svg')) return; e.preventDefault(); zoom(e.deltaY < 0 ? 0.8 : 1.25, tAt(e)); });
      let drag = null; on(GO, 'pointerdown', e => { if (e.target.closest && e.target.closest('#gxp-graph-svg') && GS.view) drag = { x: e.clientX, v: Object.assign({}, GS.view) }; });
      on(doc, 'pointermove', e => { if (!drag || !GO) return; const svg = $('gxp-graph-svg'); if (!svg) return; const dd = app.lastGraph, t0 = dd.hours[0], t1 = dd.hours[dd.hours.length - 1] + 3600000, span = drag.v.to - drag.v.from;
        let from = drag.v.from - (e.clientX - drag.x) / ((svg.getBoundingClientRect().width || 900) * 832 / 900) * span; from = Math.max(t0, Math.min(from, t1 - span)); GS.view = { from, to: from + span }; graphDraw(); });
      on(doc, 'pointerup', () => { if (drag) { drag = null; gSave(); } });
      on(doc, 'keydown', e => { if (GO && e.key === 'Escape') { GO.remove(); GO = null; } });
      return GO;
    }
    app.openGraph = openGraph;
    { const bar = P('trends').querySelector('.gxp-bar'); if (bar) { bar.insertAdjacentHTML('beforeend', ' <span class="gxbutton gxp-btn" data-act="trGraph" role="button" tabindex="0" title="Open a graph that overlays series over time (event types, products, routes, stations, owners), with filters, legend and zoom">Graph…</span>'); onBtn(bar.querySelector('[data-act=trGraph]'), openGraph); } }
    every(() => { if (GO) graphDraw(); }, 60000);
    /* ===================================================================
     * 3.1.5  memory safeguards: byte budgets (debug log, events in memory, logbooks, page cache), per-entry caps, periodic
     * watchdog (performance.memory on Chromium, size estimates everywhere), warn once + status badge, never throws.
     * =================================================================== */
    const memMB = (k, dflt, lo, hi) => { const v = Math.round(+settings[k]); return Math.max(lo, Math.min(hi, v > 0 ? v : dflt)); };
    const MB = 1048576;
    function applyMemBudgets() {
      dbg.setByteBudget(memMB('memDebugMB', MEM.DEBUG_BYTES / MB, MEM.DEBUG_BYTES_MIN / MB, MEM.DEBUG_BYTES_MAX / MB) * MB);
      tracker.eventBytes = memMB('memEventsMB', MEM.EVENT_BYTES / MB, MEM.EVENT_BYTES_MIN / MB, MEM.EVENT_BYTES_MAX / MB) * MB; tracker.trimEvents(true);
    }
    const memState = { warned: {}, downgraded: false, last: null, notes: [] };
    const badge = () => { const b = $('gxp-mem'); if (!b) return; const n = memState.notes; b.style.display = n.length ? '' : 'none'; b.textContent = n.length ? 'memory: trimmed' : ''; b.title = n.join('\n') + (n.length ? '\n(click to hide; Settings › Debug: memory budgets)' : ''); };
    on($('gxp-mem'), 'click', () => { memState.notes = []; badge(); });
    const warnOnce = (k, msg) => { if (memState.warned[k]) return; memState.warned[k] = true; memState.notes.push(msg); try { dbg.script('warn', 'memory: ' + msg); } catch (e) { /* */ } badge(); };
    dbg.onBudget(() => {
      warnOnce('debug', `debug log reached its ${Math.round(dbg.byteBudget() / MB)} MB budget: oldest lines dropped`);
      // downgrade verbosity: debug-level lines are the bulk (per-request net lines); keep info and above until the user changes it
      if (!memState.downgraded && dbg.minLevel() === 'debug') { memState.downgraded = true; dbg.setMinLevel('info'); dbg.script('warn', 'memory: debug log verbosity lowered to "info" (debug-level lines no longer kept); turn Debug logging off/on in Settings › Debug to restore'); }
    });
    tracker.onBudget = n => warnOnce('events', `events in memory reached ${Math.round(tracker.eventBytes / MB)} MB: ${n} oldest rows dropped from memory${tracker.autoExport ? ' (exported first by the rollover auto-export)' : ' (saved history is kept)'}`);
    function memStats() {
      const pm = W.performance && W.performance.memory, st = { at: Date.now(),
        debug: dbg.stats(), events: { rows: tracker.events.length, bytes: tracker.evBytes, budget: tracker.eventBytes, byteTrims: tracker.evByteTrims },
        logbooks: tracker.logbookBytes(), shuttles: tracker.ships.size, dict: tracker.dictSize ? tracker.dictSize() : null,
        pageCache: app.pageCache ? { n: app.pageCache.size, bytes: app.pageCache.bytes } : null, pending: tracker.pendingEvents.length,
        heap: pm ? { used: pm.usedJSHeapSize, total: pm.totalJSHeapSize, limit: pm.jsHeapSizeLimit } : null };
      try { st.trends = estBytes(trend, 200000); } catch (e) { st.trends = null; }
      try { st.marketHistory = { keys: Object.keys(mkHist).length, points: Object.values(mkHist).reduce((n, L) => n + (L ? L.length : 0), 0) }; } catch (e) { st.marketHistory = null; }
      try { st.formCapture = fcap.length; } catch (e) { st.formCapture = null; }
      st.estimatedTotal = st.debug.bytes + st.events.bytes + st.logbooks + ((st.pageCache && st.pageCache.bytes) || 0) + (st.trends || 0);
      return st; }
    function memWatch() {
      try {
        const st = memStats(); memState.last = st;
        if (st.logbooks > MEM.LOGBOOK_BYTES) { const cut = tracker.trimLogbooks(MEM.LOGBOOK_BYTES); if (cut) warnOnce('logbooks', `shuttle logbooks in memory over ${MEM.LOGBOOK_BYTES / MB} MB: ${cut} oldest lines trimmed (each shuttle keeps at least ${MEM.LOGBOOK_MIN_KEEP})`); }
        if (st.marketHistory && st.marketHistory.points > MEM.MKHIST_POINTS) { // drop the oldest points of the longest series
          let over = st.marketHistory.points - MEM.MKHIST_POINTS; const keys = Object.keys(mkHist).sort((a, b) => mkHist[b].length - mkHist[a].length);
          for (let r = 0; r < 10 && over > 0; r++) for (const k of keys) { if (over <= 0) break; const L = mkHist[k]; if (L.length > 5) { const n = Math.min(over, Math.ceil(L.length / 4)); L.splice(0, n); over -= n; } }
          warnOnce('market', `market history over ${MEM.MKHIST_POINTS} points: oldest points dropped`); }
        try { for (const b of Object.values(trend)) for (const d of ['routes', 'products', 'stations', 'types', 'owners']) { const o = b && b[d]; if (!o) continue; const ks = Object.keys(o); if (ks.length > MEM.TREND_KEYS) { ks.sort((x, y) => o[x] - o[y]); for (const k of ks.slice(0, ks.length - MEM.TREND_KEYS)) delete o[k]; warnOnce('trends', `trends: more than ${MEM.TREND_KEYS} keys in one hour bucket; smallest dropped`); } } } catch (e) { /* */ }
        if (st.heap && st.heap.limit && st.heap.used > st.heap.limit * MEM.HEAP_WARN) { // Chromium: real heap pressure -> trim the big buffers to half their budget
          const a = dbg.trimTo(0.5); const before = tracker.events.length, keep = Math.max(1000, Math.floor(before / 2)); if (before > keep) { const lim = tracker.eventLimit; tracker.eventLimit = keep; tracker.trimEvents(true); tracker.eventLimit = lim; }
          if (app.pageCache) app.pageCache.clear(); tracker.trimLogbooks(MEM.LOGBOOK_BYTES / 2);
          warnOnce('heap', `JS heap at ${Math.round(100 * st.heap.used / st.heap.limit)} % of its limit: debug log (${a} lines), events (${before - tracker.events.length} rows), page cache and logbooks trimmed`); }
        dbg.script('debug', `memory: est. ${Math.round(st.estimatedTotal / MB)} MB (debug ${Math.round(st.debug.bytes / MB)}/${Math.round(st.debug.budget / MB)} MB ${st.debug.rows} rows, events ${Math.round(st.events.bytes / MB)}/${Math.round(st.events.budget / MB)} MB ${st.events.rows} rows, logbooks ${Math.round(st.logbooks / MB)} MB)` + (st.heap ? `; heap ${Math.round(st.heap.used / MB)}/${Math.round(st.heap.limit / MB)} MB` : ''), st);
      } catch (e) { try { dbg.script('error', 'memory watchdog: ' + e.message); } catch (x) { /* never throw */ } }
    }
    applyMemBudgets(); every(memWatch, opts.memWatchMs || MEM.WATCH_MS); setTimeout(memWatch, opts.memFirstMs || 15000);
    app.memStats = memStats; app.memWatch = memWatch; app.applyMemBudgets = applyMemBudgets; app.memState = memState;
    /* ---------- data: shuttle list ---------- */
    async function loadList() {
      try {
        const rows = parseShipList(await client.request('gxQuerySpaceShips', { miObjectID: -1, miObjectView: 0, miObjectSort: 1, miObjectOrder: 1 }, { channel: 'list', priority: 3 }).promise);
        const ids = new Set(); for (const r of rows) { ids.add(r.id); tracker.observe(r.id, r, 'list'); }
        tracker.listLoaded(ids); dbg.script('info', `shuttle list: ${rows.length} rows`);
        if (owner.hint && !owner.names.size && rows.some(r => normName(r.owner) === normName(owner.hint))) learnOwner(owner.hint, owner.hintSource + ', verified against the shuttle list');
        logMine('shuttle list loaded');
      } catch (e) { if (e.name !== 'StaleResponseError') { dbg.script('warn', 'shuttle list failed: ' + e.message); later(loadList, 30000); } }
      tracker.flush(); renderAll(); pumpDetails();
    }

    /* ---------- data: map layer poll (never dies) ---------- */
    let pollTimer = null, idleCount = 0, lastTickAt = Date.now(), nextDelay = 0;
    const schedulePoll = ms => { clearTimeout(pollTimer); app.timers.delete(pollTimer); nextDelay = ms; pollTimer = later(pollTick, ms); };
    const pollNow = () => schedulePoll(0);
    let layerTs = '0', layerCount = 0, layerSuspect = 0; app.layerStats = () => ({ layerCount, layerSuspect });
    async function pollTick() {
      lastTickAt = Date.now();
      if (doc.hidden && !opts.ignoreHidden) { schedulePoll(C.HIDDEN_MS); return; }
      let next = C.LAYER_SLOW_MS;
      try {
        const r = parseShipsLayer(await client.request('gxGetShipsLayer', { miTimeStamp: layerTs, miZoomLevel: 0 }, { channel: 'layer', priority: 1, retries: 1 }).promise);
        pollInfo.at = Date.now();
        if (r.status === 'ok') {
          if (r.ts) layerTs = r.ts; if (r.globes.length) globes = r.globes; if (r.stations.length) stationsL = r.stations;
          const seen = new Set();
          for (const o of r.ships) {
            seen.add(o.id); const prev = tracker.ships.get(o.id);
            const moved = prev && prev.mapObj && (prev.mapObj.left !== o.left || prev.mapObj.top !== o.top);
            const s = tracker.observe(o.id, { name: o.name, x: o.x, y: o.y, heading: o.heading, onMap: true }, 'layer'); s.mapObj = o;
            if (moved) { s.movedAt = Date.now(); if (s.nextDueAt > Date.now() + C.ACTIVE_REFRESH_MS) s.nextDueAt = Date.now(); }
          }
          // 0.2.8.0 tolerance: an answer with < 50% of the previous count (and >= 10 before) is treated as partial: positions in it are used, nobody is removed.
          const prevN = layerCount, partial = prevN >= 10 && r.ships.length < prevN * 0.5;
          if (partial) { layerSuspect++; dbg.script('warn', `map layer: suspicious answer with ${r.ships.length} shuttles (previous ${prevN}); not applied as complete (${layerSuspect} in a row)`, { bytes: (r.raw || '').length }); }
          if (!partial || layerSuspect > 5) { layerCount = r.ships.length; layerSuspect = 0; }
          tracker.layerTick(seen, settings.mapMissTolerance == null ? 3 : +settings.mapMissTolerance, !partial); mapVer++;
          pollInfo.errors = 0; idleCount = 0; pollInfo.status = `updated, ${r.ships.length} on map`; next = C.LAYER_FAST_MS;
        } else if (r.status === 'unchanged') { pollInfo.errors = 0; idleCount++; pollInfo.status = 'no change'; next = idleCount <= 12 ? C.LAYER_FAST_MS : idleCount <= 20 ? C.LAYER_MID_MS : C.LAYER_SLOW_MS; }
        else throw new Error('server answered "' + (r.code || r.status) + '"');
      } catch (e) {
        if (e.name === 'StaleResponseError') next = C.LAYER_FAST_MS;
        else { pollInfo.errors++; pollInfo.status = 'error: ' + e.message; next = Math.min(C.ERROR_MAX_MS, C.LAYER_FAST_MS * Math.pow(2, Math.min(pollInfo.errors, 3))); dbg.script('warn', 'map poll: ' + e.message); }
      } finally { tracker.flush(); renderAll(); pumpDetails(); schedulePoll(next); }
    }
    every(() => { if (Date.now() - lastTickAt > Math.max(nextDelay, C.LAYER_SLOW_MS) * 2 + 30000) { pollInfo.status = 'restarted by watchdog'; dbg.script('warn', 'poll watchdog restart'); pollNow(); } }, Math.min(30000, C.LAYER_FAST_MS));
    on(doc, 'visibilitychange', () => { if (!doc.hidden) pollNow(); });

    /* ---------- data: detail scheduler (active = game cadence, idle less, stale rarely) ---------- */
    const isActive = s => s.status === 'flight' || (s.lastChangeAt && Date.now() - s.lastChangeAt < 3 * C.ACTIVE_REFRESH_MS) || (s.movedAt && Date.now() - s.movedAt < 3 * C.ACTIVE_REFRESH_MS);
    const intervalFor = s => isActive(s) ? C.ACTIVE_REFRESH_MS : s.stale ? C.STALE_REFRESH_MS : C.IDLE_REFRESH_MS;
    let inFlight = 0, pumpT = null;
    function pumpDetails() {
      if (!settings.autoDetails && selected == null) return;
      clearTimeout(pumpT); app.timers.delete(pumpT);
      const now = Date.now();
      /* 3.0.10: fair order. Before, own shuttles always sorted ahead of everyone else's; with ~950 shuttles the detail
       * queue is saturated (≈3.5 reads/s), so other players' shuttles were read late or not at all and produced far fewer
       * events. Now: selected first, then never-read, then most overdue first, with own and others' shuttles interleaved 1:1. */
      const rank = s => [s.id === selected ? 0 : 1, s.detailAt ? 1 : 0, s.nextDueAt || 0];
      const sorted = [...tracker.ships.values()].filter(s => !s._hyd && (s.nextDueAt || 0) <= now && (settings.autoDetails || s.id === selected))
        .map(s => [rank(s), s]).sort((x, y) => { for (let i = 0; i < 3; i++) if (x[0][i] !== y[0][i]) return x[0][i] - y[0][i]; return 0; }).map(x => x[1]);
      const mineQ = sorted.filter(s => isMine(s)), otherQ = sorted.filter(s => !isMine(s)), due = [];
      if (sorted.length && sorted[0].id === selected) due.push(sorted[0]);
      for (let i = 0; i < Math.max(mineQ.length, otherQ.length); i++) { for (const q of [mineQ, otherQ]) { const s = q[i]; if (s && s.id !== selected) due.push(s); } }
      app.lastDetailOrder = due.map(s => s.id);
      while (inFlight < 2 && due.length) {
        const s = due.shift(); s._hyd = true; inFlight++;
        const prevAt = s.detailAt;
        client.request('gxShipInfo', { miShipID: s.id }, { channel: 'ship:' + s.id, priority: s.id === selected ? 2 : 8 }).promise
          .then(html => { const d = parseShipInfo(html); if (!d) throw new Error('unrecognised shuttle page'); tracker.observe(s.id, { detail: d }, 'detail');
            const gap = Date.now() - prevAt; /* 3.0.2: only gaps that reflect the schedule (not first reads after a pause / deprioritised backlog) */
            if (prevAt && isActive(s) && gap <= 3 * intervalFor(s)) { pollInfo.cadence.push(gap); if (pollInfo.cadence.length > 50) pollInfo.cadence.shift(); }
            s.nextDueAt = Date.now() + intervalFor(s); })
          .catch(e => { if (e.name === 'StaleResponseError') return; s.detailError = e.message; s.nextDueAt = Date.now() + C.DETAIL_ERROR_RETRY_MS; dbg.script('debug', `detail ${s.id}: ${e.message}`); })
          .finally(() => { s._hyd = false; inFlight--; renderAll(); pumpT = later(pumpDetails, C.DETAIL_GAP_MS); });
      }
      if (!due.length && inFlight === 0) { const nextAt = Math.min(...[...tracker.ships.values()].map(s => s.nextDueAt || 0).filter(t => t > now), now + 5000); pumpT = later(pumpDetails, Math.max(200, nextAt - now)); }
    }
    every(() => tracker.flush(), 5000);
    onBtn($('gxp-refresh'), () => { cache.clear(); loadList(); layerTs = '0'; pollNow(); data.stations = data.myDocks = null; if (data.markets) loadMarkets(true); if (tabOpeners[activeTab]) tabOpeners[activeTab](); });

    app.stop = async () => {
      app.stopped = true;
      for (const t of app.timers) { clearTimeout(t); clearInterval(t); } app.timers.clear(); clearTimeout(pumpT);
      session.stop(); client.abortAll(); for (const f of app.cleanups.splice(0)) { try { f(); } catch (e) { /* */ } }
      if (bc) bc.close(); await tracker.flush(); root.remove(); style.remove();
    };
    app.pollNow = pollNow; app.pumpDetails = pumpDetails; app.loadList = loadList; app.pollInfo = pollInfo;
    renderAll(); loadList(); pollNow(); session.start();
    dbg.script('info', `Galaxy Console ${VERSION} started (session #${tracker.session})`);
    return app;
  }
  /* ===================================================================
   * ENTRY POINTS (original pages are only read, never changed except for the added button)
   * =================================================================== */
  function openGalaxyPlus() {
    const w = W.open(GXP_URL, 'simc_galaxyplus', 'resizable=yes,scrollbars=no,width=' + Math.min(1500, screen.availWidth - 40) + ',height=' + Math.min(950, screen.availHeight - 60));
    if (w) w.focus(); else W.location.href = GXP_URL;
  }
  function makeButton(doc, small) {
    const b = doc.createElement(small ? 'a' : 'span'); b.textContent = 'Galaxy Console'; b.title = 'Open the Galaxy Console viewer in its own window';
    b.className = small ? 'gxp-open' : 'gxbutton'; b.setAttribute('role', 'button'); b.tabIndex = 0; b.dataset.gxp = '1';
    b.style.cssText = small ? 'margin-left:8px;padding:1px 6px;border:1px outset #999;background:#ceceb5;color:#000;cursor:pointer;font:bold 9pt arial,sans-serif;text-decoration:none' : 'display:inline-block;margin-left:20px;padding:4px 10px;cursor:pointer';
    b.addEventListener('click', e => { e.preventDefault(); openGalaxyPlus(); });
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGalaxyPlus(); } });
    return b;
  }
  /** 0.2.8.0 launcher: one small fixed panel on the main game page with two buttons. Collapsible (remembered). Nothing on the page is changed. */
  function openGameGalaxy() { const u = String(GXP_URL).split('#')[0]; const w = W.open(u, 'simc_gamegalaxy', 'resizable=yes,scrollbars=yes,width=' + Math.min(1300, screen.availWidth - 40) + ',height=' + Math.min(900, screen.availHeight - 60)); if (w) w.focus(); else W.location.href = u; }
  /** 0.2.8.0 launcher. On the home page it modifies ONLY the game's "Worlds & Space Travel" gadget (#gbodygalaxy): a two-button
   *  bar is added under the game's galaxy image (the image stays). Inline styles only (no global CSS), ids prefixed gxc-,
   *  idempotent, and re-attached by a MutationObserver if another script or the game re-renders the gadget.
   *  Pages without that gadget get a small fixed panel instead. "Game galaxy" clicks the game's own link (galaxy1200) when present. */
  function gameGalaxyLink(doc) { return doc.querySelector('#gbodygalaxy a[onclick*="galaxy1200"]') || doc.querySelector('a[onclick*="galaxy1200"]'); }
  function launcherButtons(doc, wrapEl) {
    const btn = (label, title, fn, act) => { const b = doc.createElement('span'); b.textContent = label; b.title = title; b.dataset.act = act; b.setAttribute('role', 'button'); b.tabIndex = 0;
      b.style.cssText = 'display:inline-block;padding:2px 8px;border:1px outset #999;background:#ceceb5;color:#000;cursor:pointer;font:bold 9pt arial,sans-serif;margin:0 3px';
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); }); b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }); return b; };
    wrapEl.appendChild(btn('Galaxy Console', 'Open Galaxy Console in its own window', openGalaxyPlus, 'console'));
    wrapEl.appendChild(btn('Game galaxy', "Open the game's own galaxy window", () => { const a = gameGalaxyLink(doc); if (a) a.click(); else openGameGalaxy(); }, 'game'));
  }
  function injectGadgetLauncher(doc) {
    const body = doc.getElementById('gbodygalaxy'); if (!body) return null;
    const have = body.querySelector('[data-gxc-launcher]'); if (have) return have;
    const d = doc.createElement('div'); d.id = 'gxc-launcher'; d.dataset.gxcLauncher = '1'; d.dataset.gxp = '1'; d.style.cssText = 'margin:6px 0 0 0;padding:0;text-align:center;white-space:nowrap;position:relative;z-index:1';
    launcherButtons(doc, d); body.insertBefore(d, body.firstChild); return d; // 0.2.8.1: TOP of the gadget, before the game's image (which keeps its own 40px top margin)
  }
  /** Keep the launcher attached (idempotent; observer only re-adds our own element, never touches others). */
  function keepLauncher(doc) {
    const ensure = () => { if (doc.getElementById('gbodygalaxy')) { const f = doc.querySelector('body > #gxc-launcher-float'); if (f) f.remove(); return injectGadgetLauncher(doc); } return null; };
    const r = ensure(); let pend = false;
    try { const mo = new MutationObserver(() => { if (pend) return; pend = true; setTimeout(() => { pend = false; ensure(); }, 50); }); mo.observe(doc.body, { childList: true, subtree: true }); return { el: r, mo }; } catch (e) { return { el: r }; }
  }
  function injectLauncher(doc) {
    if (doc.getElementById('gbodygalaxy')) return injectGadgetLauncher(doc);
    if (!doc.body || doc.getElementById('gxc-launcher-float')) return null;
    const p = doc.createElement('div'); p.id = 'gxc-launcher-float'; p.dataset.gxp = '1';
    let min = false; try { min = W.localStorage.getItem('gxc.launcherMin') === '1'; } catch (e) { /* */ }
    p.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;background:#e8e8d8;border:1px solid #888;box-shadow:2px 2px 6px rgba(0,0,0,.35);padding:4px 6px;font:bold 9pt arial,sans-serif;color:#000;display:flex;gap:6px;align-items:center';
    const btn = (label, title, fn, act) => { const b = doc.createElement('span'); b.textContent = label; b.title = title; b.dataset.act = act; b.setAttribute('role', 'button'); b.tabIndex = 0;
      b.style.cssText = 'padding:2px 8px;border:1px outset #999;background:#ceceb5;cursor:pointer';
      b.addEventListener('click', e => { e.preventDefault(); fn(); }); b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }); return b; };
    const body = doc.createElement('span'); body.style.cssText = 'display:flex;gap:6px';
    launcherButtons(doc, body);
    const tg = btn(min ? '«' : '»', 'Show / hide', () => { min = !min; body.style.display = min ? 'none' : 'flex'; tg.textContent = min ? '«' : '»'; try { W.localStorage.setItem('gxc.launcherMin', min ? '1' : '0'); } catch (e) { /* */ } }, 'toggle');
    tg.style.padding = '2px 4px'; body.style.display = min ? 'none' : 'flex'; p.appendChild(tg); p.appendChild(body); doc.body.appendChild(p); return p;
  }
  /** 0.2.8.3 map viewer (gxRoot#gxc-map=<host>/<kind>[/<n>]): renders the game's country/world map fragment as a normal page.
   *  Read-only GET of the same-origin proxy path; scripts and inline handlers are stripped; the fragment's own map navigation
   *  (gxCountryMap(n), gxWorldMap(), gxContinentMap(n), gxRegionMap(n)) becomes in-page navigation. */
  function parseMapHash(h) { const m = /^#gxc-map=(sim\d{2}\.simcountry\.com)\/(country|world|continent|region)(?:\/(\d{1,8}))?$/i.exec(h || ''); return m && (m[2] === 'world' || m[3]) ? { host: m[1].toLowerCase(), kind: m[2].toLowerCase(), n: m[3] } : null; }
  function sanitizeMapFragment(doc, html, host) {
    const t = doc.createElement('div'); t.innerHTML = html;
    for (const s of t.querySelectorAll('script,iframe,object,embed,form,link,meta,base')) s.remove();
    for (const el of t.querySelectorAll('*')) { for (const a of [...el.attributes]) { const n = a.name.toLowerCase(), v = a.value;
      if (n === 'onclick') { let m; const nav = (m = /gxCountryMap\(\s*(\d+)\s*\)/.exec(v)) ? 'country/' + m[1] : (m = /gxContinentMap\(\s*(\d+)\s*\)/.exec(v)) ? 'continent/' + m[1] : (m = /gxRegionMap\(\s*(\d+)\s*\)/.exec(v)) ? 'region/' + m[1] : /gxWorldMap\(\s*\)/.test(v) ? 'world' : '';
        el.removeAttribute(a.name); if (nav) { el.dataset.gxcNav = host + '/' + nav; el.style.cursor = 'pointer'; } continue; }
      if (/^on/.test(n) || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(v))) el.removeAttribute(a.name); } }
    return t;
  }
  async function startMapView() {
    const doc = W.document; const show = async () => {
      const p = parseMapHash(location.hash); doc.title = 'Galaxy Console map';
      doc.body.innerHTML = ''; doc.body.style.cssText = 'margin:0;background:#000;color:#ddd;font:10pt arial,sans-serif';
      const bar = doc.createElement('div'); bar.style.cssText = 'padding:4px 8px;background:#222'; bar.textContent = p ? `${p.kind} map ${p.n || ''} · ${p.host} · Galaxy Console viewer` : 'Invalid map link';
      doc.body.appendChild(bar); if (!p) return;
      const box = doc.createElement('div'); box.style.cssText = 'position:relative;min-height:700px'; box.textContent = 'Loading…'; doc.body.appendChild(box);
      try { const r = await W.fetch(mapFragmentPath(p.host, p.kind, p.n), { credentials: 'include' }); const html = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status);
        box.textContent = ''; box.appendChild(sanitizeMapFragment(doc, html, p.host)); }
      catch (e) { box.textContent = 'Could not load the map: ' + e.message; }
    };
    doc.addEventListener('click', e => { const el = e.target.closest && e.target.closest('[data-gxc-nav]'); if (el) { e.preventDefault(); location.hash = MAPVIEW_HASH.slice(1) + el.dataset.gxcNav; } });
    W.addEventListener('hashchange', show);
    try { if (W.gxTimeoutID) clearTimeout(W.gxTimeoutID); W.gxScheduleShipReload = function () {}; W.gxReloadShipPositions = function () {}; W.onresize = null; } catch (e) { /* */ }
    await show();
  }
  function injectNextToExploreLinks(doc) {
    for (const a of doc.querySelectorAll('a, button, input[type=button], [onclick]')) {
      if (a.dataset.gxp || a.dataset.gxpSeen) continue;
      const label = (a.textContent || a.value || a.title || '').replace(/\s+/g, ' '), target = (a.getAttribute('href') || '') + ' ' + (a.getAttribute('onclick') || '');
      if (!/explore\s+centaudos\s+galaxy/i.test(label) && !/gxRoot/.test(target)) continue;
      a.dataset.gxpSeen = '1'; a.insertAdjacentElement('afterend', makeButton(doc, true));
    }
  }
  function injectToolbarButton(doc) {
    const pann = doc.getElementById('pann'); if (!pann || pann.querySelector('[data-gxp]')) return;
    const tr = pann.querySelector('tr'); if (!tr) return; const td = doc.createElement('td'); td.align = 'center'; td.appendChild(makeButton(doc, false)); tr.appendChild(td);
  }
  /** Read-only capture of the ORIGINAL transport form (field names/types, hidden defaults, submit method). Nothing is sent. */
  function captureTransportForm(doc) {
    const f = doc.forms && doc.forms.gx_transport; if (!f) return null;
    const fields = []; for (const el of f.elements) { if (!el.name || el.name.indexOf('mi') < 0) continue; if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      fields.push({ name: el.name, type: el.type || el.tagName.toLowerCase(), value: el.type === 'hidden' ? el.value : '' }); }
    let method = null; for (const el of doc.querySelectorAll('[onclick*="gxSendTransportForm"], a[href*="gxSendTransportForm"]')) {
      const a = callArgs((el.getAttribute('onclick') || '') + (el.getAttribute('href') || ''), 'gxSendTransportForm'); if (a && a[0] === 'gx_transport') { method = a[1]; break; } }
    const cap = { at: Date.now(), method, fields, page: location.pathname };
    try { W.localStorage.setItem('gxp.formCapture', JSON.stringify(cap)); } catch (e) { /* */ }
    return cap;
  }
  function announceSignIn() {
    if (!readPortalCookieHash(W.document)) return;
    try { W.localStorage.setItem('gxp.signin', String(Date.now())); } catch (e) { /* */ }
    try { const c = new BroadcastChannel('galaxyplus'); c.postMessage({ type: 'gxp-signin' }); c.close(); } catch (e) { /* */ }
  }
  function detectOwnerFromText(t) {
    const m = /\bPresident\s*[:\-]?\s*([A-Za-z0-9_.\-]{3,40})/.exec(t) || /\bWelcome(?:\s+back)?,?\s+([A-Za-z0-9_.\-]{3,40})/.exec(t);
    return m && !/^(to|the|on|of)$/i.test(m[1]) ? m[1] : '';
  }
  async function startApp() {
    try { if (W.gxTimeoutID) clearTimeout(W.gxTimeoutID); } catch (e) { /* */ }
    try { W.gxScheduleShipReload = function () {}; W.gxReloadShipPositions = function () {}; W.onresize = null; } catch (e) { /* */ }
    // owner hint from the original page text before it is cleared (e.g. "President: ExamplePlayer" / "Welcome ExamplePlayer")
    const pageText = (W.document.body.innerText || W.document.body.textContent || '').slice(0, 20000);
    const ownerHint = detectOwnerFromText(pageText);
    for (const n of [...W.document.body.children]) if (!n.classList.contains('sc-consent') && n.id !== 'sc-consent-link') n.remove();
    W.document.title = 'Galaxy Console ' + VERSION + ' – CentauDos';
    return mount({ ownerHint: ownerHint, ownerSource: 'page header' });
  }

  W.GalaxyPlus = { VERSION, LIMITS, CADENCE, READ_METHODS, WRITE_METHODS, TRANSPORT_FIELDS, buildUrl, buildWriteUrl, cancelStep1Url, cancelStep2Url, findSubmitForm, parseFormTemplate, isConfirmationPage, writeResponseSummary, confirmTemplateFor, writeGate, RequestClient, ForbiddenRequestError, SessionExpiredError,
    parseShipsLayer, parseShipList, parseShipInfo, parseStations, parseMarkets, parseStationDocks, parseStationMarket, classifyLogLine, serverStamp, normName, parseMyDocks, parseTransportList, parseTransportInfo, classifyTransportRow, TR_STATUS, shipDiagnostics, routeOverview, parsePicker, parseGameMessage, classifyWriteMessage, parseLoadLine, originParams, detectOwnerFromText, shipDiagnostics, isLoginPage,
    callArgs, csvParse, LRU, MEM, estBytes, capStr, GxDB, MemDB, createTracker, createTransport, createSession, createDebug, transportValues, routeKey, mount, captureTransportForm, injectNextToExploreLinks, injectToolbarButton, injectLauncher, injectGadgetLauncher, keepLauncher, createTriggers, VTable, createTransport, statusOf,
    mapViewUrl, mapFragmentPath, parseMapHash, sanitizeMapFragment, headerMap, parseInventoryTable, parseLogTable, parseProductInfo, parseWorldInfo, worldMapUrl, worldCode, initials, serverStamp, serverTzOffsetMs, SERVER_TZ, EVENT_CSV_COLUMNS, SHIP_CSV_COLUMNS,
    scanActions, captureForms, parseFlightPlan, buildFlightUrl, flightSubmitProblem, buildLoaderUrl, buildRenameUrl, renameProblem, actionGate, CAPTURE_LOADERS, CAPTURE_RECORD_ONLY, DEFAULT_SETTINGS };
  if (W.__GXP_TEST__) return;

  const isGxRoot = /cgi2nova/.test(location.pathname) && /SN_METHOD=gxRoot/i.test(location.search);
  if (isGxRoot && location.hash.indexOf(MAPVIEW_HASH) === 0) { startMapView(); return; }
  if (isGxRoot && location.hash === GXP_HASH) { startApp().then(a => { W.GalaxyPlusApp = a; }); return; }
  announceSignIn();
  if (isGxRoot) {
    injectToolbarButton(W.document);
    const capturedForms = new WeakSet(); // capture each form once, when it first appears (hidden values = defaults)
    try { const mo = new MutationObserver(() => { const f = W.document.forms.gx_transport; if (f && !capturedForms.has(f)) { capturedForms.add(f); const c = captureTransportForm(W.document); if (c && c.method) console.info('[Galaxy Console] transport form captured (read-only):', c.method, c.fields.map(f => f.name).join(',')); } });
      mo.observe(W.document.body, { childList: true, subtree: true }); } catch (e) { /* */ }
    return;
  }
  { const d = W.document, hasExplore = () => [...d.querySelectorAll('a,[onclick]')].some(a => /explore\s+centaudos\s+galaxy/i.test(a.textContent || '') || /gxRoot/.test((a.getAttribute('href') || '') + (a.getAttribute('onclick') || '')));
    const want = () => d.body && d.body.tagName !== 'FRAMESET' && (W.top === W.self || hasExplore());
    if (d.getElementById('gbodygalaxy')) keepLauncher(d); else if (want()) injectLauncher(d); else try { const mo = new MutationObserver(() => { if (d.getElementById('gbodygalaxy')) { mo.disconnect(); keepLauncher(d); } else if (want()) { injectLauncher(d); mo.disconnect(); } }); mo.observe(d.documentElement, { childList: true, subtree: true }); setTimeout(() => mo.disconnect(), 15000); } catch (e) { /* */ } } // 0.2.8.0: one launcher panel (top frame only) instead of buttons next to each link
})();
