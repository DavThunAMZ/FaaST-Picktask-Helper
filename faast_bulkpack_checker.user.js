// ==UserScript==
// @name         Faast – Picktask Helper
// @namespace    https://faast.amazon.co.uk/
// @version      1.6.4
// @description  Picktask Helper – Bulk/BulkSplit/Proposal + Weight check + Best-fit bin
// @author       Developed by davthun, built by Aki
// @match        https://faast.amazon.co.uk/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/DavThunAMZ/FaaST-Picktask-Helper/main/faast_bulkpack_checker.user.js
// @downloadURL  https://raw.githubusercontent.com/DavThunAMZ/FaaST-Picktask-Helper/main/faast_bulkpack_checker.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE = 'https://faast.amazon.co.uk';
  const MAX_KG = 30;

  const LS_INV     = 'bpc_inv_v1';
  const LS_TASKS   = 'bpc_tasks_v1';
  const LS_WEIGHTS = 'bpc_weights_v1';
  let WH       = new URLSearchParams(location.search).get('warehouseCode') || '';
  let dateFrom = ''; // YYYY-MM-DD, synced from Faast
  let dateTo   = ''; // YYYY-MM-DD, synced from Faast

  const isAsin = v => /^B[0-9A-Z]{9}$/.test(String(v ?? '').trim());

  // === DEBUG LOG =============================================================
  let debugEnabled = false;
  const LOG_BUFFER = [];
  const CAT_COLORS = {
    INIT:'#6366f1', FETCH:'#0891b2', XHR:'#0891b2', ORDERS:'#16a34a',
    INV:'#d97706', SCRAPE:'#7c3aed', WEIGHT:'#db2777', PICKER:'#059669',
    ANALYZE:'#475569', FILL:'#2563eb', STORAGE:'#94a3b8', ERROR:'#dc2626',
  };
  function dbg(cat, msg, data) {
    if (!debugEnabled) return;
    const ts = new Date().toTimeString().slice(0, 8);
    LOG_BUFFER.push({ts, cat, msg, data});
    if (LOG_BUFFER.length > 200) LOG_BUFFER.shift();
    const sty = 'color:' + (CAT_COLORS[cat]||'#64748b') + ';font-weight:700';
    if (data !== undefined) console.log('[PTH %c'+cat+'%c] '+msg, sty, '', data);
    else                    console.log('[PTH %c'+cat+'%c] '+msg, sty, '');
    renderDebugLog();
  }
  function renderDebugLog() {
    const el = document.getElementById('bpc-dbg-log');
    if (!el || el.style.display === 'none') return;
    const atBot = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = LOG_BUFFER.map(e => {
      const c = CAT_COLORS[e.cat]||'#64748b';
      const d = e.data !== undefined
        ? '<span style="color:#94a3b8;margin-left:6px">' + JSON.stringify(e.data).slice(0,120) + '</span>'
        : '';
      return '<div style="padding:1px 0;border-bottom:1px solid #1e293b">'
        + '<span style="color:#475569">' + e.ts + '</span> '
        + '<span style="color:' + c + ';font-weight:700;font-size:9px;padding:1px 5px;border-radius:3px;margin:0 4px">' + e.cat + '</span>'
        + '<span style="color:#e2e8f0">' + e.msg + '</span>' + d + '</div>';
    }).join('');
    if (atBot) el.scrollTop = el.scrollHeight;
  }
  // ===========================================================================

  const DB = {
    picktasks: [],   // [{ asin, orderQty }]
    lastLoaded: null,  // timestamp when orders were last loaded
    unitCounts: {},  // { asin: totalUnits } — scraped from Faast picker
    inventory: [],   // [{ asin, qty, containerId }]
    weights:   {},   // { asin: kg_per_unit }
  };

  // ─── Storage ──────────────────────────────────────────────────────────────
  const lsGet = k => { try { return localStorage.getItem(k); } catch(_) { return null; } };
  const lsSet = (k,v) => { try { localStorage.setItem(k,v); } catch(_) {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch(_) {} };

  function loadFromStorage() {
    try { const i=JSON.parse(lsGet(LS_INV)||'[]');     if(i.length) { DB.inventory=i; dbg('STORAGE','Inventory from cache: '+i.length+' rows'); } } catch(e) { dbg('ERROR','LS inv: '+e.message); }
    try { const t=JSON.parse(lsGet(LS_TASKS)||'[]');   if(t.length) { DB.picktasks=t; dbg('STORAGE','Tasks from cache: '+t.length); } } catch(e) { dbg('ERROR','LS tasks: '+e.message); }
    try { const w=JSON.parse(lsGet(LS_WEIGHTS)||'{}'); if(w) { DB.weights=w; dbg('STORAGE','Weights from cache: '+Object.keys(w).length); } } catch(e) { dbg('ERROR','LS weights: '+e.message); }
  }



  function saveWeight(asin, kg) {
    DB.weights[asin] = kg;
    lsSet(LS_WEIGHTS, JSON.stringify(DB.weights));
    dbg('WEIGHT', 'Saved '+asin+' = '+kg+' kg');
  }

  // ═══ SCRAPER ══════════════════════════════════════════════════════════════

  // Inventar-Tabelle: Container | Inv.Type | FNSKU | FCSKU | Available | Bound …
  function scrapeInvTable(doc, fallbackAsin) {
    const results = [];
    for (const table of doc.querySelectorAll('table')) {
      const heads = [...table.querySelectorAll('thead th,thead td')]
        .map(th => th.textContent.trim().toLowerCase());
      if (!heads.some(h=>h.includes('container'))) continue;
      if (!heads.some(h=>h.includes('available')||h==='quantity')) continue;
      dbg('SCRAPE', 'Table found for '+fallbackAsin+' — heads: '+heads.join(','));
      const ci = {
        container: heads.findIndex(h=>h==='container'),
        invType:   heads.findIndex(h=>h.includes('inventory')||h.includes('type')),
        fnsku:     heads.findIndex(h=>h.includes('fnsku')||h.includes('asin')),
        avail:     heads.findIndex(h=>h.includes('available')),
        qty:       heads.findIndex(h=>h==='quantity'),
      };
      const qCol = ci.avail>=0 ? ci.avail : ci.qty;
      if (ci.container<0||qCol<0) continue;
      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length<3) continue;
        const invType = ci.invType>=0 ? cells[ci.invType]?.textContent.trim() : '';
        // Nur beschädigte/defekte/abgelaufene Typen überspringen
        const SKIP = /DAMAGED|DEFECTIVE|EXPIRED|RETURN/i;
        if (invType && SKIP.test(invType)) continue;
        const cEl = cells[ci.container];
        const containerId = (cEl?.querySelector('a')?.textContent||cEl?.textContent||'').trim();
        if (!containerId) continue;
        let asin = fallbackAsin;
        if (ci.fnsku>=0) { const fn=cells[ci.fnsku]?.textContent.trim().toUpperCase(); if(isAsin(fn)) asin=fn; }
        if (!isAsin(asin)) continue;
        const qty = parseInt(cells[qCol]?.textContent.trim())||0;
        results.push({ asin, qty, containerId, location: containerId, invType: invType||'' });
      }
      if (results.length) break;
    }
    // Fallback: Container-Links
    if (!results.length) {
      const seen = new Set();
      for (const a of doc.querySelectorAll('a[href*="/containers/"]')) {
        const cid=a.textContent.trim(); if(!cid||seen.has(cid)) continue; seen.add(cid);
        const row=a.closest('tr'); if(!row) continue;
        const nums=[...row.querySelectorAll('td')].map(td=>parseInt(td.textContent.trim())).filter(n=>!isNaN(n)&&n>=0&&n<999999);
        results.push({ asin: fallbackAsin, qty: nums[0]??0, containerId: cid, location: cid });
      }
    }
    dbg('SCRAPE', 'scrapeInvTable result for '+fallbackAsin+': '+results.length+' rows');
    return results;
  }

  // Gewicht aus Produktseite scrapen (sucht "X kg" / "X g" near "weight")
  function scrapeWeight(doc) {
    if (!doc.body) return null;
    const text = doc.body.innerText || '';

    // Format auf Produkt-Seite: "Weight = 18.48 KG" (mit = Zeichen)
    const patterns = [
      /weight\s*=\s*(\d+[.,]\d+|\d+)\s*(kg|g)\b/i,           // Weight = 18.48 KG
      /(?:weight|gewicht)\s*[=:]\s*(\d+[.,]\d+|\d+)\s*(kg|g)\b/i,
      /\b(\d+[.,]\d+)\s*(kg)\b(?=[^\n]{0,40}(?:weight|gewicht))/i,
    ];
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        const val = parseFloat(m[1].replace(',','.'));
        const unit = m[2].toLowerCase();
        if (!isNaN(val) && val > 0) return unit==='g' ? val/1000 : val;
      }
    }
    // Fallback: Tabellen-Zeile mit "Weight"
    for (const row of doc.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td,th')];
      if (cells.length < 2) continue;
      if (!/weight|gewicht/i.test(cells[0].textContent)) continue;
      const m2 = cells[1].textContent.match(/(\d+[.,]\d+|\d+)\s*(kg|g)/i);
      if (m2) { const val=parseFloat(m2[1].replace(',','.')); return m2[2].toLowerCase()==='g'?val/1000:val; }
    }
    dbg('WEIGHT', 'No weight found for page');
    return null;
  }

  // Kombinierter Scraper: Inventar + Gewicht von Produktseite
  function scrapeProductPage(doc, asin) {
    return {
      rows:   scrapeInvTable(doc, asin),
      weight: scrapeWeight(doc),
    };
  }

  // ═══ SILENT FETCH ═════════════════════════════════════════════════════════
  async function silentFetch(asins, onStatus) {
    const results = []; let failed = 0;
    dbg('INV', 'silentFetch: '+asins.length+' ASINs');
    for (let i=0; i<asins.length; i++) {
      const asin = asins[i];
      onStatus(`⏳ ${i+1}/${asins.length}: ${asin}…`);
      dbg('INV', `Fetching ${asin} (${i+1}/${asins.length})`);
      try {
        const r = await fetch(`${BASE}/web/products/${asin}`, {
          credentials: 'include', headers: { 'Accept': 'text/html' }
        });
        dbg('INV', `HTTP ${r.status} for ${asin}`);
        if (!r.ok) { failed++; dbg('ERROR', `HTTP ${r.status} for ${asin}`); continue; }
        const html = await r.text();
        dbg('INV', `HTML ${html.length} chars for ${asin}`);
        if (html.length<3000 && html.includes('login')) { dbg('ERROR','Login redirect — aborting'); failed+=asins.length; break; }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const { rows, weight } = scrapeProductPage(doc, asin);
        dbg('INV', `${asin}: ${rows.length} rows, weight=${weight}`);
        if (rows.length) results.push(...rows);
        else { failed++; dbg('ERROR', `0 rows for ${asin}`); }
        if (weight !== null) saveWeight(asin, weight);
      } catch(e) { failed++; dbg('ERROR', `Exception ${asin}: `+e.message); }
    }
    dbg('INV', `silentFetch done: ${results.length} rows, ${failed} failed`);
    return { results, failed };
  }

  // ═══ PICKTASKS ════════════════════════════════════════════════════════════
  function parseTaskData(data) {
    if (!data) { dbg('ORDERS','parseTaskData: null data'); return []; }
    dbg('ORDERS','parseTaskData keys: '+Object.keys(data).join(', '));
    const rows = [];
    const map = data.topFnskus??data.topFnsku??data.fnskus??null;
    if (map&&typeof map==='object'&&!Array.isArray(map))
      for (const [a,c] of Object.entries(map)) { const id=String(a).trim().toUpperCase(); if(isAsin(id)) rows.push({asin:id,orderQty:Number(c)||1}); }
    if (!rows.length) for (const [k,v] of Object.entries(data)) if(isAsin(k)) rows.push({asin:k,orderQty:Number(v)||1});
    dbg('ORDERS','parseTaskData: '+rows.length+' ASINs');
    return rows.sort((a,b)=>b.orderQty-a.orderQty);
  }

  const _F = window.fetch.bind(window);

  function updateDateDisplay() {
    const el = document.getElementById('bpc-date');
    if (!el) return;
    const fmt = s => s ? s.split('-').reverse().join('.') : '?';
    el.textContent = dateFrom === dateTo
      ? fmt(dateFrom)
      : fmt(dateFrom) + ' – ' + fmt(dateTo);
  }

  // MM/DD/YYYY → YYYY-MM-DD (for HTML date input)
  function apiDateToInput(s) {
    const p = s?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return p ? `${p[3]}-${p[1]}-${p[2]}` : null;
  }

  window.fetch = async function(...a) {
    const url  = typeof a[0]==='string' ? a[0] : (a[0]?.url??'');
    const body = a[1]?.body;

    // Sync date range: wenn Faast selbst die Order-API aufruft, Datums-Inputs anpassen
    if (url.includes('getOrderCountAndTopFnskuByFilter') && body) {
      dbg('FETCH','Intercepted: getOrderCountAndTopFnskuByFilter');
      try {
        const params = new URLSearchParams(body);
        const from = apiDateToInput(params.get('exsdDateAfter'));
        const to   = apiDateToInput(params.get('exsdDateBefore'));
        if (from) dateFrom = from;
        if (to)   dateTo   = to;
        if (from || to) { updateDateDisplay(); dbg('FETCH',`Date sync: ${from} – ${to}, WH: ${wh}`); }
        const wh = params.get('warehouseCode'); if (wh) WH = wh;
      } catch(_) {}
    }

    const r = await _F(...a);
    try { r.clone().json().then(d => {
      const m=url.match(/warehouseCode=([A-Z0-9]{3,6})/); if(m) WH=m[1];
      dbg('FETCH','Response JSON keys: '+Object.keys(d).join(', '));
      const rows=parseTaskData(d);
      if(rows.length>=3&&rows.length>DB.picktasks.length){DB.picktasks=rows;lsSet(LS_TASKS,JSON.stringify(rows));dbg('ORDERS','Auto-loaded '+rows.length+' tasks via intercept');setStatus(`✅ ${rows.length} Orders — 🗄 Inventory aktualisieren!`);refreshPanel();}
    }).catch(()=>{}); } catch(_) {}
    return r;
  };

  // XHR-Interceptor: Faast nutzt XHR (nicht fetch) für eigene API-Calls
  // Wenn Faast den Datumsfilter ändert → unsere Inputs automatisch synchronisieren
  const _XOpen = XMLHttpRequest.prototype.open;
  const _XSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._bpcUrl = url || '';
    return _XOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._bpcUrl.includes('getOrderCountAndTopFnskuByFilter') && body) {
      try {
        const params = new URLSearchParams(body);
        const wh   = params.get('warehouseCode'); if (wh) WH = wh;
        const from = apiDateToInput(params.get('exsdDateAfter'));
        const to   = apiDateToInput(params.get('exsdDateBefore'));
        // Inputs updaten (falls Panel schon existiert)
        if (from) dateFrom = from;
        if (to)   dateTo   = to;
        if (from || to) { updateDateDisplay(); dbg('XHR', 'Date sync: ' + from + ' – ' + to); }
      } catch(_) {}
    }
    return _XSend.call(this, body);
  };

  // Format: MM/DD/YYYY (faast API format)
  function fmtDate(d) {
    return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
  }
  // Format: YYYY-MM-DD (HTML input format)
  function fmtInput(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }


  // ═══ SEARCH ORDER PAGE ════════════════════════════════════════════════════
  // Lädt alle Orders von /web/orders/search (kein Top-10-Limit).
  // Angezeigte ASINs kommen aus dem Use-FNSKU-Picker (nur die können Picktasks erstellen).
  // Search Orders liefert nur die orderQty je Picker-ASIN.
  async function loadOrdersFromSearch() {
    setStatus('⏳ Full Orders…');
    const btn = document.getElementById('btn-so');
    if (btn) { btn.disabled = true; btn.textContent = '⏳…'; }

    // ── Schritt 1: Picker triggern und auf Ergebnisse warten ──────────────────
    DB.unitCounts = {};
    try { autoTriggerPicker(); } catch(_) {}
    setStatus('⏳ Warte auf Picker…');
    await new Promise(r => setTimeout(r, 900));
    const pickerAsins = Object.keys(DB.unitCounts);
    dbg('PICKER', 'Picker-Ergebnis nach 900ms: ' + pickerAsins.length + ' ASINs');

    // ── Schritt 2: Search Orders alle Seiten abrufen ──────────────────────────
    const toMDY = s => { if (!s) return fmtDate(new Date()); const [y,m,d]=s.split('-'); return `${m}/${d}/${y}`; };
    const params = new URLSearchParams({
      useExsdAfter:    'on',
      exsdDateAfter:   toMDY(dateFrom),
      exsdTimeAfter:   '00:00',
      useExsdBefore:   'on',
      exsdDateBefore:  toMDY(dateTo),
      exsdTimeBefore:  '23:59',
      orderTypes:      'SHIPMENT',
      fastTrack:       'null',
      single:          'null',
      sioc:            'null',
      giftOrder:       'null',
      fragile:         'null',
      containsLiquids: 'null',
      giftWrap:        'null',
      hazmat:          'null',
      b2b:             'null',
      fnsku:           '',
      action:          'search',
      statuses:        'NEW',
    });

    const orderCounts = {};  // { asin: totalQty }
    const seenOrders = new Set();  // Duplikate durch Pagination-Overlap vermeiden
    let page = 1, totalRows = 0;
    try {
      while (page <= 200) {
        params.set('page', page);
        setStatus(`⏳ Seite ${page}…`);
        dbg('ORDERS', `searchOrders: page ${page}`);
        const r = await fetch(`${BASE}/web/orders/search?${params}`, {
          credentials: 'include',
          headers: { 'Accept': 'text/html' },
        });
        if (!r.ok) { dbg('ERROR', `Search p${page}: HTTP ${r.status}`); break; }
        const html = await r.text();
        if (html.length < 500 || (html.length < 5000 && html.includes('login'))) {
          dbg('ERROR', 'Login redirect'); break;
        }
        // Pro <tr> je ASIN einmal zählen (= Anzahl Orders, nicht Units-Summe)
        const _doc = new DOMParser().parseFromString(html, 'text/html');
        const _trs = _doc.querySelectorAll('table.order-result tbody tr, .search-order-result-container tbody tr');
        dbg('ORDERS', `DOMParser: ${_trs.length} rows on page ${page}`);
        let pageRows = 0;
        const re = /([B][0-9A-Z]{9})\((\d+)\)/g;
        if (_trs.length > 0) {
          // Nur echte Order-Zeilen; Order-ID merken → Pagination-Duplikate überspringen
          for (const tr of _trs) {
            const idCell = tr.querySelector('.order-id-column');
            if (!idCell) continue;
            const orderId = (idCell.querySelector('a')?.textContent || idCell.textContent).trim();
            if (!orderId || seenOrders.has(orderId)) continue;
            seenOrders.add(orderId);
            re.lastIndex = 0;
            const seen = new Set();
            let m;
            while ((m = re.exec(tr.textContent)) !== null) {
              if (isAsin(m[1]) && !seen.has(m[1])) {
                seen.add(m[1]);
                orderCounts[m[1]] = (orderCounts[m[1]] || 0) + 1;
                pageRows++;
              }
            }
            totalRows++;
          }
        } else {
          // Fallback: ganzes HTML, Summe der Units
          let m;
          while ((m = re.exec(html)) !== null) {
            if (isAsin(m[1])) {
              orderCounts[m[1]] = (orderCounts[m[1]] || 0) + Number(m[2]);
              pageRows++; totalRows++;
            }
          }
        }
        dbg('ORDERS', `searchOrders page ${page}: ${pageRows} items`);
        if (pageRows === 0) break;
        page++;
      }
    } catch(e) {
      dbg('ERROR', 'loadOrdersFromSearch: ' + e.message);
      setStatus('⚠️ Orders Error: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '📋 All Orders'; }
      return;
    }

    // ── Schritt 3: DB.picktasks = Picker-ASINs + orderQty aus Search Orders ───
    // Nur Picker-ASINs anzeigen (nur die können Picktasks erstellen).
    // Fallback: wenn Picker leer → alle Search-Order-ASINs.
    const baseAsins = pickerAsins.length > 0 ? pickerAsins : Object.keys(orderCounts);
    if (baseAsins.length === 0) {
      setStatus('⚠️ Keine Orders/Picker-Daten gefunden');
      if (btn) { btn.disabled = false; btn.textContent = '📋 All Orders'; }
      return;
    }

    DB.picktasks = baseAsins
      .map(asin => ({ asin, orderQty: orderCounts[asin] || 0 }))
      .sort((a, b) => b.orderQty - a.orderQty);
    lsSet(LS_TASKS, JSON.stringify(DB.picktasks));
    DB.lastLoaded = Date.now();
    const dupes = totalRows - seenOrders.size;
    DB.searchStats = { uniqueOrders: seenOrders.size, totalRows, dupes, pages: page - 1 };
    dbg('ORDERS', `searchOrders done: ${DB.picktasks.length} ASINs | ${seenOrders.size} unique orders | ${totalRows} rows scanned | ${dupes} dupes skipped | ${page} pages`);
    setStatus(`✅ ${DB.picktasks.length} ASINs | ${totalRows} Units (${page} Seiten)`);
    refreshPanel();
    loadInventory();  // Picker bereits gelaufen (Schritt 1)
    if (btn) { btn.disabled = false; btn.textContent = '📋 All Orders'; }
  }


  // ═══ ANALYSE ══════════════════════════════════════════════════════════════
  function analyze() {
    const tMap = {};
    for (const t of DB.picktasks) tMap[t.asin] = t.orderQty;

    const iMap = {};
    for (const i of DB.inventory) {
      if (!iMap[i.asin]) iMap[i.asin] = [];
      iMap[i.asin].push({ c: i.containerId, q: Number(i.qty)||0 });
    }
    for (const a in iMap) iMap[a] = iMap[a]
      .filter(l => l.q > 0 && (!l.invType || !/DAMAGED|DEFECTIVE|EXPIRED|RETURN/i.test(l.invType)))
      .sort((x,y) => y.q - x.q)
      .slice(0, 5);

    return Object.keys(tMap).map(asin => {
      const orders  = tMap[asin];                  // Anzahl Orders (aus topFnskus) — nur Anzeige
      const units   = DB.unitCounts[asin] ?? null; // Gesamtmenge Units (aus Picker) — null = noch nicht geladen
      const qty     = units ?? orders;              // für Kalkulationen: units wenn verfügbar, sonst orders
      const bins    = iMap[asin] ?? [];
      const avail   = bins[0]?.q ?? 0;
      const total   = bins.reduce((s,l)=>s+l.q, 0);
      const weight  = DB.weights[asin] ?? null;  // kg per unit or null

      // ── Bulk-Logik (basiert auf qty = Units) ─────────────────────────────
      // Bulk:      bin ÷ qty = ganze Zahl (avail % qty === 0)
      // BulkSplit: kein ganzes Ergebnis
      const rawPicktasks = avail > 0 ? Math.ceil(qty / avail) : 0;
      // Threshold: avail > 60 ODER qty < 2 → immer Proposal
      const isProposal  = avail > 60 || qty < 2;
      const canBulk     = !isProposal && avail > 0 && avail % qty === 0;
      const isBulkSplit = !isProposal && avail > 0 && !canBulk;

      // ── Best-fit bin (alle Typen) ────────────────────────────────────────
      // Wähle kleinsten Bin der qty abdeckt; wenn keiner ausreicht → größter Bin (idx=0)
      const bestBinIdx = (() => {
        if (!bins.length) return 0;
        const suf = bins.map((b,i)=>({b,i})).filter(({b})=>b.q>=qty);
        return suf.length > 0 ? suf.reduce((a,c)=>c.b.q<a.b.q?c:a).i : 0;
      })();
      const proposalBinQty = bins[bestBinIdx]?.q ?? avail;

      // ── Gewichtslimit für Proposal ────────────────────────────────────────
      let proposalQty   = proposalBinQty;
      let proposalKg    = null;
      let weightWarning = false;
      const ignoreKg = document.getElementById('chk-nokg')?.checked ?? false;
      if (isProposal && weight !== null && weight > 0) {
        const maxUnits = Math.max(1, Math.floor(MAX_KG / weight));
        proposalKg = +(proposalBinQty * weight).toFixed(1);
        if (proposalBinQty * weight > MAX_KG) {
          weightWarning = true;
          if (!ignoreKg) {
            proposalQty = maxUnits;
            proposalKg  = +(proposalQty * weight).toFixed(1);
          }
        }
      }
      // Finale Picktasks: qty durch proposalQty (gewichtskorrigiert)
      const picktasks = isProposal && proposalQty > 0
        ? Math.ceil(qty / proposalQty)
        : rawPicktasks;

      dbg('ANALYZE', `${asin}: orders=${orders} units=${units} avail=${avail} → ${canBulk?'Bulk':isBulkSplit?'BulkSplit':'Proposal'} pt=${picktasks}`);
      return {
        asin, orders, units, qty, bins, avail, total, bestBinIdx,
        batchSize: (orders > 0 && picktasks > 0) ? Math.ceil(orders / picktasks) : 0,
        picktasks, weight, proposalQty, proposalKg, weightWarning, ignoreKg,
        canBulk, isBulkSplit, isProposal,
        noStock:     avail === 0,
        hasStock:    avail > 0,
        unitsMissing: units === null,
      };
    }).sort((a,b) =>
      (a.canBulk?0:a.isBulkSplit?1:a.isProposal?2:3) - (b.canBulk?0:b.isBulkSplit?1:b.isProposal?2:3) ||
      a.picktasks - b.picktasks || b.qty - a.qty
    );
  }

  // ═══ UI ═══════════════════════════════════════════════════════════════════
  let activeFilter = 'all';

  const CSS = `
    #bpc{position:fixed;bottom:16px;right:16px;z-index:999999;width:760px;max-height:88vh;
      background:#fff;border:1px solid #cbd5e1;border-radius:8px;
      box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:Arial,sans-serif;font-size:11px;
      color:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;}
    #bpc-hdr{background:#1e293b;color:#fff;padding:8px 12px;display:flex;align-items:center;
      gap:8px;cursor:move;user-select:none;border-radius:8px 8px 0 0;flex-shrink:0;}
    #bpc-hdr h3{flex:1;margin:0;font-size:12px;}
    #bpc-bar{display:flex;gap:5px;padding:7px 10px;border-bottom:1px solid #e2e8f0;
      flex-wrap:wrap;align-items:center;flex-shrink:0;background:#f8fafc;}
    .btn{padding:4px 11px;border:none;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;}
    .bg{background:#16a34a;color:#fff;}.bb{background:#2563eb;color:#fff;}
    .bd{background:#475569;color:#fff;}.br{background:#dc2626;color:#fff;}.bp{background:#7c3aed;color:#fff;}
    .btn:hover{opacity:.82;}.btn:disabled{opacity:.5;cursor:default;}
    #bpc-c{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;}
    #bpc-body{overflow-y:auto;flex:1;padding:10px;min-height:0;}
    .flt{display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap;}
    .fb{padding:3px 10px;border-radius:12px;border:1px solid #d1d5db;background:#f9fafb;font-size:10px;cursor:pointer;font-weight:600;}
    .fb.on{background:#1e293b;color:#fff;border-color:#1e293b;}
    .summ{background:#f0f9ff;border:1px solid #bae6fd;border-radius:5px;padding:6px 12px;font-size:10px;margin-bottom:8px;}
    table.t{width:100%;border-collapse:collapse;}
    table.t th{background:#1e293b;color:#fff;padding:5px 7px;font-size:10px;text-align:left;white-space:nowrap;}
    table.t td{padding:5px 7px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}
    table.t tr:hover td{background:#f0f9ff!important;}
    .mono{font-family:monospace;font-size:11px;font-weight:700;}
    .dim{color:#94a3b8;font-size:9px;}
    .tag{display:inline-block;font-size:9px;font-weight:700;border-radius:3px;padding:2px 7px;white-space:nowrap;}
    .tok{background:#dcfce7;color:#15803d;border:1px solid #86efac;}
    .tos{background:#ffedd5;color:#9a3412;border:1px solid #fed7aa;}
    .tpp{background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;}
    .tsi{background:#e0e7ff;color:#3730a3;border:1px solid #a5b4fc;}
    .bin-pill{display:inline-block;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:3px;
      padding:1px 6px;font-size:9px;font-family:monospace;margin:1px;white-space:nowrap;}
    .bin-best{background:#d1fae5;border-color:#6ee7b7;font-weight:700;}
    .kg-warn{color:#dc2626;font-size:9px;font-weight:700;}
    .kg-ok{color:#64748b;font-size:9px;}
    .notice{background:#fefce8;border:1px solid #fde047;border-radius:5px;padding:10px 14px;font-size:10px;line-height:2;}
    #bpc-st{font-size:9px;opacity:.85;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .bdbg{background:#7c3aed;color:#fff;}
    #bpc-dbg-wrap{border-top:2px solid #334155;flex-shrink:0;}
    #bpc-dbg-bar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#1e293b;}
    #bpc-dbg-bar span{color:#94a3b8;font-size:9px;font-weight:700;flex:1;}
    #bpc-dbg-log{height:160px;overflow-y:auto;padding:6px 10px;font-family:monospace;font-size:9px;
      line-height:1.6;color:#e2e8f0;background:#0f172a;}
  `;

  function buildPanel() {
    if (document.getElementById('bpc')||!document.body) return;
    const s=document.createElement('style');s.textContent=CSS;document.head.appendChild(s);
    const p=document.createElement('div');p.id='bpc';
    p.innerHTML=`
      <div id="bpc-hdr">
        <span>📦</span>
        <h3>Picktask Helper <small style="opacity:.4;font-weight:400;font-size:9px">v1.6.4</small></h3>
        <span id="bpc-st"></span>
        <button class="btn bd" id="btn-help" style="padding:2px 8px;margin-right:2px" title="Quick Guide">💡</button>
        <button class="btn bdbg" id="btn-dbg" style="padding:2px 8px" title="Toggle Debug Log">🐛</button>
        <button class="btn bd" id="bpc-m" style="padding:2px 7px;margin-left:2px">▼</button>
        <button class="btn bd" id="bpc-x" style="padding:2px 7px">✕</button>
      </div>
      <div id="bpc-c">
        <div id="bpc-bar">
          <button class="btn bp" id="btn-so" title="Alle Orders kumuliert aus Search Order Seite">📋 All Orders</button>
          <button class="btn bb" id="btn-inv">🗄 Inventory</button>
          <button class="btn br" id="btn-cl" title="Clear inventory + tasks from cache">🗑 Clear Cache</button>
          <span id="bpc-date" style="font-size:10px;color:#475569;font-weight:600;padding:3px 7px;background:#f1f5f9;border-radius:4px;border:1px solid #cbd5e1">—</span>
          <label style="font-size:10px;color:#64748b;display:flex;align-items:center;gap:3px;cursor:pointer;">
            <input type="checkbox" id="chk-nokg" style="cursor:pointer;"> Ignore 30kg limit
          </label>
        </div>
        <div id="bpc-body"></div>

      <div id="bpc-dbg-wrap" style="display:none">
        <div id="bpc-dbg-bar">
          <span>🐛 Debug Log</span>
          <button class="btn bd" id="btn-dbg-clear" style="padding:2px 7px;font-size:9px">Clear</button>
          <button class="btn bd" id="btn-dbg-copy"  style="padding:2px 7px;font-size:9px">Copy</button>
        </div>
        <div id="bpc-dbg-log"></div>
      </div>`;
    document.body.appendChild(p);

    document.getElementById('bpc-x').onclick = ()=>p.remove();
    document.getElementById('btn-help').onclick = () => {
      const body = document.getElementById('bpc-body');
      if (!body) return;
      if (body.dataset.helpOpen === '1') {
        body.dataset.helpOpen = '0';
        document.getElementById('btn-help').style.opacity = '1';
        renderResult();
      } else {
        body.dataset.helpOpen = '1';
        document.getElementById('btn-help').style.opacity = '0.5';
        body.innerHTML = `<div class="notice">
          <strong style="font-size:11px">📦 Picktask Helper — Quick Guide</strong><br><br>
          <strong>1. 📋 All Orders</strong> &nbsp;Scans Use-FNSKU picker for available ASINs, then fetches all orders from the Search Order page. Inventory loads automatically.<br>
          <span style="color:#dc2626">⚠️ Set the date filter on the Faast picktask page first — otherwise ALL open orders will be pulled.</span><br>
          <strong>2. Click a row</strong> &nbsp;Fills Use FNSKU + Batch Size in the Faast form — ready to create the pick task.<br>
          <strong>3. 🗄 Inventory</strong> &nbsp;Use to manually refresh stock levels if needed.<br><br>
          <strong style="color:#64748b">Types:</strong><br>
          ✅ <strong>Bulk</strong> &nbsp;— Bin qty divides evenly by units (one pick)<br>
          🟠 <strong>Bulk Split</strong> &nbsp;— Multiple picks from same bin required<br>
          📋 <strong>Pick Task Proposal</strong> &nbsp;— avail &gt; 60 or qty &lt; 2<br><br>
          <strong style="color:#64748b">Columns:</strong><br>
          <strong>Orders</strong> = units ordered today &nbsp;·&nbsp; <strong>Units</strong> = qty from picker &nbsp;·&nbsp; <strong>Bins</strong> = green = best-fit bin
        </div>`;
      }
    };
    document.getElementById('btn-dbg').onclick = () => {
      debugEnabled = true;
      const wrap = document.getElementById('bpc-dbg-wrap');
      const isOpen = wrap.style.display !== 'none';
      wrap.style.display = isOpen ? 'none' : '';
      document.getElementById('btn-dbg').style.opacity = isOpen ? '0.5' : '1';
      if (!isOpen) { renderDebugLog(); dbg('INIT', 'Debug panel opened — ' + LOG_BUFFER.length + ' entries'); }
    };
    document.getElementById('btn-dbg-clear').onclick = () => {
      LOG_BUFFER.length = 0;
      const el = document.getElementById('bpc-dbg-log'); if (el) el.innerHTML = '';
    };
    document.getElementById('btn-dbg-copy').onclick = () => {
      const text = LOG_BUFFER.map(e=>'['+e.ts+'] ['+e.cat+'] '+e.msg+(e.data!==undefined?' '+JSON.stringify(e.data):'')).join('\n');
      navigator.clipboard.writeText(text).then(()=>setStatus('📋 Log copied!'));
    };
    document.getElementById('bpc-m').onclick = () => {
      const bpcBody  = document.getElementById('bpc-c');
      const bpcPanel = document.getElementById('bpc');
      const bpcHdr   = document.getElementById('bpc-hdr');
      const isOpen   = bpcBody.style.display !== 'none';
      if (isOpen) {
        bpcBody.style.display    = 'none';
        bpcPanel.style.height    = bpcHdr.offsetHeight + 'px';
        bpcPanel.style.maxHeight = bpcHdr.offsetHeight + 'px';
        document.getElementById('bpc-m').textContent = '▲';
      } else {
        bpcBody.style.display    = '';
        bpcPanel.style.height    = '';
        bpcPanel.style.maxHeight = '88vh';
        document.getElementById('bpc-m').textContent = '▼';
      }
    };
    document.getElementById('btn-cl').onclick = ()=>{[LS_INV,LS_TASKS,LS_WEIGHTS].forEach(lsDel);DB.inventory=[];DB.picktasks=[];DB.weights={};setStatus('Cache cleared');renderResult();};
    document.getElementById('chk-nokg').onchange = renderResult;

    document.getElementById('btn-inv').onclick = loadInventory;
    document.getElementById('btn-so').onclick = loadOrdersFromSearch;

    // Init date display with today as fallback
    const _td  = new Date();
    const _iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!dateFrom) dateFrom = _iso(_td);
    if (!dateTo)   dateTo   = _iso(_td);
    updateDateDisplay();
    makeDraggable(document.getElementById('bpc-hdr'),p);
    startUnitObserver();
    startStaleTimer();
    renderResult();
  }

  function renderResult() {
    const body=document.getElementById('bpc-body');if(!body)return;
    if(!DB.picktasks.length){
      body.innerHTML=`<div class="notice">
        <strong style="font-size:11px">📦 Picktask Helper — Quick Guide</strong><br><br>
        <strong>1. 📋 All Orders</strong> &nbsp;Scans Use-FNSKU picker for available ASINs, then fetches all orders from the Search Order page. Inventory loads automatically.<br>
        <span style="color:#dc2626">⚠️ Set the date filter on the Faast picktask page first — otherwise ALL open orders will be pulled.</span><br>
        <strong>2. Click a row</strong> &nbsp;Fills Use FNSKU + Batch Size in the Faast form — ready to create the pick task.<br>
        <strong>3. 🗄 Inventory</strong> &nbsp;Use to manually refresh stock levels if needed.<br><br>
        <strong style="color:#64748b">Types:</strong><br>
        ✅ <strong>Bulk</strong> &nbsp;— Bin qty divides evenly by units (one pick)<br>
        🟠 <strong>Bulk Split</strong> &nbsp;— Multiple picks from same bin required<br>
        📋 <strong>Pick Task Proposal</strong> &nbsp;— avail &gt; 60 or qty &lt; 2<br><br>
        <strong style="color:#64748b">Columns:</strong><br>
        <strong>Orders</strong> = units ordered today &nbsp;·&nbsp; <strong>Units</strong> = qty from picker &nbsp;·&nbsp; <strong>Bins</strong> = green = best-fit bin
      </div>`;return;
    }
    if(!DB.inventory.length){
      body.innerHTML=`<div class="notice">✅ ${DB.picktasks.length} ASINs loaded — click <strong>🗄 Inventory</strong></div>`;return;
    }

    const rows=analyze();
    const visible = rows.filter(r=>!r.unitsMissing);
    const bulk  = visible.filter(r=>r.canBulk);
    const split = visible.filter(r=>r.isBulkSplit);
    const prop  = visible.filter(r=>r.isProposal);
    const nos   = visible.filter(r=>r.noStock);
    const vis   = activeFilter==='bulk'  ? bulk
                : activeFilter==='split' ? split
                : activeFilter==='prop'  ? prop
                : activeFilter==='nos'   ? nos
                : visible.filter(r=>r.hasStock);

    body.innerHTML=`
      <div class="summ" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">
        <span>
          ✅ <strong style="color:#15803d">${bulk.length}</strong> Bulk &nbsp;·&nbsp;
          🟠 <strong style="color:#9a3412">${split.length}</strong> Bulk Split &nbsp;·&nbsp;
          📋 <strong style="color:#1d4ed8">${prop.length}</strong> Proposal &nbsp;·&nbsp;
          ❌ <strong style="color:#991b1b">${nos.length}</strong> No Stock
        </span>
        ${DB.searchStats ? `<span style="font-size:9px;color:#64748b;white-space:nowrap">
          📊 <strong>${DB.searchStats.uniqueOrders}</strong> orders${DB.searchStats.dupes > 0 ? ` · <span style="color:#dc2626">${DB.searchStats.dupes} dupes</span>` : ''}
        </span>` : ''}
      </div>
      <div class="flt">
        <span class="fb ${activeFilter==='all'  ?'on':''}" data-f="all">All (${rows.filter(r=>r.hasStock).length})</span>
        <span class="fb ${activeFilter==='bulk' ?'on':''}" data-f="bulk">✅ Bulk (${bulk.length})</span>
        <span class="fb ${activeFilter==='split'?'on':''}" data-f="split">🟠 Split (${split.length})</span>
        <span class="fb ${activeFilter==='prop' ?'on':''}" data-f="prop">📋 Proposal (${prop.length})</span>
        <span class="fb ${activeFilter==='nos'  ?'on':''}" data-f="nos">❌ No Stock (${nos.length})</span>
      </div>
      <table class="t"><thead><tr>
        <th>ASIN</th>
        <th style="text-align:center">Orders</th>
        <th style="text-align:center">Units</th>
        <th>Bins</th>
        <th style="text-align:center">Total Stock available</th>
        <th style="text-align:center">Pick Tasks</th>
        <th style="text-align:center">Batch Size</th>
        <th>Status</th>
      </tr></thead><tbody>
      ${vis.map(r => {
        // Status-Tag
        const tag = r.canBulk     ? '<span class="tag tok">✅ Bulk</span>'
                  : r.isBulkSplit ? '<span class="tag tos">🟠 Bulk Split</span>'
                  : r.isProposal  ? '<span class="tag tpp">📋 Proposal</span>'
                  :                  '<span class="tag tsi">🔍 Single Pick</span>';

        // Hintergrund
        const bg = r.canBulk ? 'background:#f0fdf4' : r.isBulkSplit ? 'background:#fff7ed' : r.isProposal ? 'background:#eff6ff' : '';

        // Bins anzeigen (beste zuerst, alle mit Qty)
        const binsHtml = r.bins.length
          ? r.bins.map((b,i)=>`<span class="bin-pill ${i===r.bestBinIdx?'bin-best':''}">${b.c}×${b.q}</span>`).join('')
          : '<span class="dim">—</span>';

        // Picktasks-Farbe
        const pc = r.picktasks===1?'#15803d':r.picktasks<=2?'#d97706':'#94a3b8';

        // Gewichts-Info (für Proposal)
        let weightHtml = '';
        if (r.isProposal && r.weight !== null) {
          if (r.weightWarning) {
            if (r.ignoreKg) {
              weightHtml = `<br><span class="kg-warn" style="color:#d97706">⚠️ ${(r.avail*r.weight).toFixed(1)}kg > ${MAX_KG}kg — ignored, ${r.proposalQty} units</span>`;
            } else {
              weightHtml = `<br><span class="kg-warn">⚠️ ${(r.avail*r.weight).toFixed(1)}kg > ${MAX_KG}kg → max ${r.proposalQty} units (${r.proposalKg}kg)</span>`;
            }
          } else if (r.proposalKg !== null) {
            weightHtml = `<br><span class="kg-ok">${r.proposalKg} kg/pick</span>`;
          }
        } else if (r.isProposal && r.weight === null) {
          weightHtml = '<br><span class="dim">Weight unknown</span>';
        }

        return '<tr style="' + bg + ';cursor:pointer" data-asin="' + r.asin + '" data-batch="' + r.batchSize + '">'
          + '<td><span class="mono">' + r.asin + '</span></td>'
          + '<td style="text-align:center;font-weight:700">' + (r.orders > 0 ? r.orders : '—') + '</td>'
          + '<td style="text-align:center;color:#64748b">' + (r.units !== null ? r.units : '—') + '</td>'
          + '<td>' + binsHtml + weightHtml + '</td>'
          + '<td style="text-align:center;color:#64748b">' + (r.total||'—') + '</td>'
          + '<td style="text-align:center;font-weight:700;color:' + pc + '">' + (r.picktasks>0?r.picktasks+'×':'—') + '</td>'
          + '<td style="text-align:center;font-weight:700;color:#475569">' + (r.orders>0 ? (r.batchSize>0?r.batchSize:'—') : '<span style="color:#dc2626;font-size:9px">❗ Order qty not available</span>') + '</td>'
          + '<td>' + tag + '</td></tr>';
      }).join('')}
      </tbody></table>
      ${(() => {
        const missing = rows.filter(r=>r.unitsMissing);
        if (!missing.length) return '';
        return `<div style="margin-top:8px;border-top:1px solid #e2e8f0;padding-top:6px;">
          <div style="font-size:10px;font-weight:700;color:#94a3b8;margin-bottom:4px;">⚠️ Missing qty data (${missing.length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">
          ${missing.map(r=>`<span class="bin-pill" style="color:#94a3b8">${r.asin}</span>`).join('')}
          </div></div>`;
      })()}`;

    body.querySelectorAll('.fb').forEach(b=>b.onclick=()=>{activeFilter=b.dataset.f;renderResult();});
    body.querySelectorAll('table.t tbody tr[data-asin]').forEach(tr=>{
      tr.addEventListener('click', e=>{
        if(e.target.closest('.fb')) return;
        const asin  = tr.dataset.asin;
        const batch = Number(tr.dataset.batch)||0;
        if(asin) fillFaastFields(asin, batch);
      });
    });
  }

  function refreshPanel(){setStatus(`T:${DB.picktasks.length} I:${DB.inventory.length}`);renderResult();}
  function setStatus(m){const s=document.getElementById('bpc-st');if(s)s.textContent=m;}

  function makeDraggable(handle,el){
    let ox,oy,sl,st;
    handle.addEventListener('mousedown',e=>{
      if(['BUTTON','INPUT'].includes(e.target.tagName))return;
      const r=el.getBoundingClientRect();ox=e.clientX;oy=e.clientY;sl=r.left;st=r.top;el.style.right='auto';
      const mv=e2=>{el.style.left=(sl+e2.clientX-ox)+'px';el.style.top=(st+e2.clientY-oy)+'px';};
      const up=()=>{removeEventListener('mousemove',mv);removeEventListener('mouseup',up);};
      addEventListener('mousemove',mv);addEventListener('mouseup',up);e.preventDefault();
    });
  }


  // ═══ INIT ═════════════════════════════════════════════════════════════════
  async function loadInventory() {
    const asins=[...new Set(DB.picktasks.map(t=>t.asin))];
    if(!asins.length){setStatus('⚠️ Load Orders first!');return;}
    dbg('INV','loadInventory: '+asins.length+' unique ASINs');
    const btn=document.getElementById('btn-inv');
    if(btn){btn.disabled=true; btn.textContent='⏳…';}
    const {results,failed}=await silentFetch(asins,msg=>{setStatus(msg);if(btn)btn.textContent=msg.substring(0,15);});
    if(results.length>0){
      const asinSet=new Set(asins);
      DB.inventory=DB.inventory.filter(r=>!asinSet.has(r.asin));
      DB.inventory.push(...results);
      lsSet(LS_INV,JSON.stringify(DB.inventory));
      dbg('INV',`Inventory updated: ${DB.inventory.length} total, ${failed} failed`);
      setStatus(`✅ Inventory: ${DB.inventory.length}`);
      renderResult();
    } else {
      dbg('ERROR',`0 results, ${failed} failed — login?`);
      setStatus('Fetch failed — please retry');
    }
    if(btn){btn.disabled=false; btn.textContent='🗄 Inventory';}
  }

  // MutationObserver + Auto-trigger: fängt Faast-Picker-Optionen automatisch
  // Format: 'ASIN( N units )' oder 'ASIN(N units)'
  function scrapeUnitCounts() { /* no-op, observer handles it */ }
  function startUnitObserver() {
    const re = /([A-Z0-9]{10})\s*\(\s*(\d+)\s*units?\s*\)/gi;
    function extractUnits(text) {
      let m, found = false;
      while ((m = re.exec(text)) !== null) {
        const asin = m[1].toUpperCase();
        if (isAsin(asin)) { DB.unitCounts[asin] = Number(m[2]); found = true; dbg('PICKER', asin+' = '+m[2]+' units'); }
      }
      re.lastIndex = 0;
      return found;
    }
    // MutationObserver: feuert wenn Picker-Optionen in den DOM eingefügt werden
    const obs = new MutationObserver(muts => {
      let updated = false;
      for (const mut of muts) {
        for (const node of mut.addedNodes) {
          const text = node.textContent || '';
          if (text.toLowerCase().includes('unit') && extractUnits(text)) updated = true;
        }
      }
      if (updated) {
        // Fehlende ASINs aus Picker in DB.picktasks einfügen (orderQty=0 als Fallback)
        const known = new Set(DB.picktasks.map(t => t.asin));
        let added = false;
        for (const asin of Object.keys(DB.unitCounts)) {
          if (!known.has(asin)) {
            DB.picktasks.push({ asin, orderQty: 0 });
            added = true;
          }
        }
        if (added) {
          lsSet(LS_TASKS, JSON.stringify(DB.picktasks));
          // Inventory für neue Picker-ASINs still nachladen
          const invKnown = new Set(DB.inventory.map(i => i.asin));
          const toFetch = Object.keys(DB.unitCounts).filter(a => !invKnown.has(a));
          if (toFetch.length > 0) {
            dbg('INV', 'Picker: nachladen für ' + toFetch.length + ' neue ASINs');
            silentFetch(toFetch, msg => dbg('INV', msg)).then(({results}) => {
              if (results.length > 0) {
                DB.inventory.push(...results);
                lsSet(LS_INV, JSON.stringify(DB.inventory));
                renderResult();
              }
            }).catch(() => {});
          }
        }
        renderResult();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Öffnet den Faast FNSKU-Picker kurz → MutationObserver fängt alle ASIN(N units)
  function autoTriggerPicker() {
    DB.unitCounts = {};
    dbg('PICKER','autoTriggerPicker: resetting and triggering');
    const picker = document.querySelector('input[placeholder="Use FNSKU"]')
                || [...document.querySelectorAll('input')].find(el => el.placeholder?.toLowerCase().includes('fnsku'));
    if (!picker) { dbg('PICKER','autoTriggerPicker: picker input NOT found'); return; }
    dbg('PICKER','autoTriggerPicker: picker found');
    picker.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
    picker.focus();
    setTimeout(() => {
      picker.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}));
      picker.blur();
      document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    }, 400);
  }

  const STALE_MS = 30 * 60 * 1000; // 30 Minuten
  function startStaleTimer() {
    setInterval(() => {
      if (!DB.lastLoaded) return;
      const age = Date.now() - DB.lastLoaded;
      if (age >= STALE_MS) {
        const mins = Math.floor(age / 60000);
        const st = document.getElementById('bpc-st');
        if (st) st.innerHTML = `<span style="color:#dc2626;font-weight:700">⏰ Daten ${mins} min alt — neu laden!</span>`;
      }
    }, 60 * 1000); // jede Minute prüfen
  }

  // Überträgt ASIN → Use FNSKU + Batch Size in Faast
  function fillFaastFields(asin, batchSize) {
    dbg('FILL', `fillFaastFields: ${asin} batch=${batchSize}`);
    // Step 1: Type ASIN into visible input → triggers dropdown
    const fnsku = document.getElementById('fnsku-input')
                || document.querySelector('input[placeholder="Use FNSKU"]');
    if (fnsku) {
      dbg('FILL', 'FNSKU input found');
      fnsku.value = asin;
      fnsku.dispatchEvent(new Event('input',  {bubbles:true}));
      fnsku.dispatchEvent(new Event('keyup',  {bubbles:true}));
    }
    setStatus(`✅ FNSKU: ${asin} — selecting…`);
    // Step 2: Wait for dropdown → click matching item
    setTimeout(() => {
      const item = [...document.querySelectorAll('li,a,div[role="option"],ul li')]
        .find(el => el.textContent.trim().startsWith(asin));
      if (item) {
        item.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
        item.click();
      } else {
        dbg('FILL', `Dropdown NOT found for ${asin} — trying hidden field`);
        // Fallback: set hidden field directly
        const fnskuHidden = document.querySelector('input[name="fnsku"]');
        if (fnskuHidden) { fnskuHidden.value=asin; fnskuHidden.dispatchEvent(new Event('change',{bubbles:true})); }
      }
    }, 350);
    // Step 3: After selection → fill batch size
    setTimeout(() => {
      // Ensure batch_size_mode is selected
      const batchModeRadio = [...document.querySelectorAll('input[name="batchMode"]')]
        .find(r=>r.value==='batch_size_mode');
      if (batchModeRadio && !batchModeRadio.checked) {
        batchModeRadio.checked = true;
        batchModeRadio.dispatchEvent(new Event('change',{bubbles:true}));
      }
      // Fill Batch Size
      const batchEl = document.getElementById('form_batch_size')
                    || document.querySelector('input[name="batchSize"]');
      if (batchEl && batchSize > 0) {
        dbg('FILL', `Batch size set: ${batchSize}`);
        batchEl.value = batchSize;
        ['input','change'].forEach(ev=>batchEl.dispatchEvent(new Event(ev,{bubbles:true})));
        setStatus(`✅ ${asin} | Batch: ${batchSize}`);
      } else {
        setStatus(`✅ FNSKU: ${asin}`);
      }
    }, 300);
  }

  const ON_PT = () => location.pathname === '/web/picktasks/new';

  function init(){
    dbg('INIT', `v1.6.4 init: path=${location.pathname} WH=${WH}`);
    console.log('[BulkPack] v1.6.4 Init:', location.pathname, '| WH:', WH);
    loadFromStorage();
    if(!ON_PT()) return;
    if(document.body){buildPanel();refreshPanel();}
    else document.addEventListener('DOMContentLoaded',()=>{buildPanel();refreshPanel();});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();

  window.addEventListener('load',()=>{
    if(!ON_PT()) return;
    loadFromStorage();
    if(!document.getElementById('bpc'))buildPanel();
    refreshPanel();
  });

  let _lp=location.pathname;
  setInterval(()=>{
    if(location.pathname!==_lp){
      _lp=location.pathname;
      setTimeout(()=>{
        if(ON_PT()){
          loadFromStorage();
          if(!document.getElementById('bpc'))buildPanel();
          refreshPanel();
          dbg('INIT',`SPA nav → picktasks`);
        } else {
          document.getElementById('bpc')?.remove();
          dbg('INIT',`SPA nav → away (${location.pathname})`);
        }
      },800);
    }
  },500);

})();
