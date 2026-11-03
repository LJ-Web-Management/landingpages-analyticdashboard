/* Google Search Console multi-site dashboard.
   - Demo mode: deterministic sample data so the page works before setup.
   - Shared mode: data/gsc/*.json written daily by the GitHub Action, so every
     visitor sees real data without signing in.
   - Live mode: one or more Google accounts signed in via Google Identity Services
     (webmasters.readonly) → Search Console API, called directly from the browser.
   Combining rules: clicks & impressions sum; CTR = Σclicks / Σimpressions;
   position = impression-weighted mean of each site's average position. */
(function(){
  "use strict";

  var API = "https://www.googleapis.com/webmasters/v3";
  var SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
  var LS_SEL = "gsc.selected.v2", LS_CID = "gsc.clientId";
  var MAX_SLOTS = 8;  // categorical colour slots; more sites fold to "Other" in per-site charts

  var RANGES = [
    { key: 7, label: "7D" }, { key: 28, label: "28D" }, { key: 90, label: "3M" },
    { key: 180, label: "6M" }, { key: 365, label: "12M" }, { key: 480, label: "16M" }
  ];
  var METRICS = [
    { key: "clicks", label: "Clicks", fmt: fmtInt },
    { key: "impressions", label: "Impressions", fmt: fmtInt },
    { key: "ctr", label: "CTR", fmt: fmtPct },
    { key: "position", label: "Avg position", fmt: fmtPos, invert: true }
  ];

  var state = {
    mode: "demo",           // demo | shared | live
    endDate: null,          // shared mode: last day in the synced data
    sites: [],              // [{ siteUrl, permissionLevel }]
    selected: [],           // siteUrls, in selection order
    slots: {},              // siteUrl -> colour slot 1..8 (stable while selected)
    range: 28,
    metric: "clicks",
    chartMode: "combined",  // combined | split
    qLimit: 15, pLimit: 15,
    loading: false
  };
  var cache = {};           // `${mode}|${siteUrl}|${range}` -> site dataset
  var renderSeq = 0;

  /* ================= utils ================= */
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]; }); }
  function fmtInt(n){ n = Math.round(n || 0); if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.0+$/,"") + "M"; return n.toLocaleString("en-US"); }
  function fmtFull(n){ return Math.round(n || 0).toLocaleString("en-US"); }
  function fmtPct(n){ return ((n || 0) * 100).toFixed(n < 0.1 ? 2 : 1) + "%"; }
  function fmtPos(n){ return n ? n.toFixed(1) : "—"; }
  function iso(d){ return d.toISOString().slice(0,10); }
  function addDays(d, n){ var x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function utcToday(){ var n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); }
  function shortSite(u){ return String(u).replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, ""); }
  function siteKind(u){ return /^sc-domain:/.test(u) ? "Domain" : "URL prefix"; }
  function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function colorFor(siteUrl){ var s = state.slots[siteUrl]; return s ? cssVar("--s" + s) : cssVar("--s-other"); }
  function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  var toastTimer;
  function toast(msg, ms){
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.classList.remove("show"); }, ms || 4200);
  }

  /* Windows: GSC data lags ~2 days, so the window ends 2 days ago
     (or on the last synced day in shared mode). */
  function windows(range){
    var end = state.endDate ? new Date(state.endDate + "T00:00:00Z") : addDays(utcToday(), -2);
    var start = addDays(end, -(range - 1));
    var pEnd = addDays(start, -1), pStart = addDays(pEnd, -(range - 1));
    return { start: iso(start), end: iso(end), pStart: iso(pStart), pEnd: iso(pEnd) };
  }
  function dateList(from, to){
    var out = [], d = new Date(from + "T00:00:00Z"), e = new Date(to + "T00:00:00Z");
    while (d <= e){ out.push(iso(d)); d = addDays(d, 1); }
    return out;
  }

  /* ================= colour slots ================= */
  function assignSlots(){
    var used = {};
    Object.keys(state.slots).forEach(function(u){ if (state.selected.indexOf(u) === -1) delete state.slots[u]; else used[state.slots[u]] = true; });
    state.selected.forEach(function(u){
      if (state.slots[u]) return;
      for (var s = 1; s <= MAX_SLOTS; s++) if (!used[s]){ state.slots[u] = s; used[s] = true; return; }
    });
  }

  /* ================= demo data ================= */
  var DEMO_SITES = [
    { siteUrl: "sc-domain:moldtraining.us", base: 95, trend: 0.0011, pool: ["mold remediation certification", "osha mold remediation certification", "mold inspector training", "mold remediation training online", "mold awareness training", "how to become a mold inspector", "mold certification course", "black mold training", "mold assessor license", "mold remediation course near me", "iicrc mold course", "mold safety training osha"] },
    { siteUrl: "https://confined-space.com/", base: 60, trend: 0.0016, pool: ["confined space training", "osha confined space certification", "confined space entry training online", "permit required confined space training", "confined space attendant training", "confined space rescue training", "confined space awareness", "what is a confined space osha", "confined space entry permit", "confined space training certificate"] },
    { siteUrl: "sc-domain:excavationtrenchingshoring.com", base: 72, trend: 0.0008, pool: ["trenching and shoring training", "competent person excavation training", "osha excavation safety course", "trench safety training online", "excavation competent person certification", "trench collapse prevention", "shoring training", "osha trenching standard", "excavation safety training", "trench box training"] },
    { siteUrl: "sc-domain:stormwaterplanning.us", base: 120, trend: 0.0012, pool: ["swppp training", "stormwater pollution prevention plan template", "qualified swppp practitioner", "stormwater compliance training", "swppp inspector certification", "construction stormwater training", "swppp plan", "stormwater inspector training", "erosion control training", "cpesc training"] },
    { siteUrl: "https://www.moldtraining.us/es/", base: 18, trend: 0.002, pool: ["curso de moho", "a que huele el moho", "certificacion de remediacion de moho", "capacitacion moho osha", "como eliminar el moho"] }
  ];
  function rng(seed){ var s = 0; for (var i=0;i<seed.length;i++) s = (s*31 + seed.charCodeAt(i)) >>> 0; return function(){ s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var demoDaily = {};
  function demoSeries(site){
    if (demoDaily[site.siteUrl]) return demoDaily[site.siteUrl];
    var r = rng(site.siteUrl), out = {}, end = addDays(utcToday(), -2);
    for (var i = 1000; i >= 0; i--){
      var d = addDays(end, -i), dow = d.getUTCDay();
      var season = 1 + 0.12 * Math.sin((d.getUTCMonth() + 1) / 12 * Math.PI * 2);
      var weekly = (dow === 0 || dow === 6) ? 0.62 : 1.08;
      var growth = Math.exp(site.trend * (1000 - i));
      var impr = site.base * 24 * season * weekly * growth * (0.82 + r() * 0.36) * 0.35;
      var ctr = 0.028 + r() * 0.018;
      out[iso(d)] = { impressions: Math.round(impr), clicks: Math.round(impr * ctr), position: Math.max(1.5, 14 - (1000 - i) * 0.006 + (r() - 0.5) * 3) };
    }
    return (demoDaily[site.siteUrl] = out);
  }
  function demoDataset(siteUrl, range){
    var site = DEMO_SITES.filter(function(s){ return s.siteUrl === siteUrl; })[0];
    var w = windows(range), daily = demoSeries(site), r = rng(siteUrl + range);
    var series = dateList(w.pStart, w.end).map(function(d){ var p = daily[d] || { clicks:0, impressions:0, position:0 }; return { date: d, clicks: p.clicks, impressions: p.impressions, position: p.position }; });
    var cur = series.filter(function(p){ return p.date >= w.start; });
    var tot = totalsOf(cur);
    function split(keys, weightsFn){
      var weights = keys.map(function(k, i){ return weightsFn(i); }), sum = weights.reduce(function(a,b){ return a+b; }, 0);
      return keys.map(function(k, i){
        var share = weights[i] / sum, impr = Math.round(tot.impressions * share), clicks = Math.round(tot.clicks * share * (0.6 + r() * 0.8));
        return { key: k, clicks: Math.min(clicks, impr), impressions: impr, position: Math.max(1, tot.position * (0.4 + r() * 1.3)) };
      });
    }
    var host = "https://" + shortSite(siteUrl).replace(/\/.*$/, "");
    var prefix = /^https?:/.test(siteUrl) ? siteUrl.replace(/\/$/, "") : host;
    var pages = ["/", "/courses/", "/certification/", "/online-training/", "/faq/", "/blog/osha-requirements/", "/pricing/", "/about/", "/contact/", "/blog/how-to-get-certified/"].map(function(p){ return prefix + p; });
    return {
      siteUrl: siteUrl, series: series, window: w,
      queries: split(site.pool, function(i){ return 1 / Math.pow(i + 1, 0.9) * (0.7 + r() * 0.6); }),
      pages: split(pages, function(i){ return 1 / Math.pow(i + 1, 1.1) * (0.7 + r() * 0.6); }),
      countries: split(["usa", "can", "gbr", "ind", "aus", "phl", "mex", "pri", "zaf", "deu"], function(i){ return i === 0 ? 30 : 1 / (i + 0.4); }),
      devices: split(["DESKTOP", "MOBILE", "TABLET"], function(i){ return [5.2, 4.2, 0.4][i]; })
    };
  }

  /* ================= shared (daily-synced) data ================= */
  // data/gsc/*.json is written by .github/workflows/fetch-gsc-data.yml so that
  // anyone who opens the dashboard sees real data without signing in.
  var sharedIndex = null, sharedFiles = {};
  function loadSharedIndex(){
    return fetch("data/gsc/index.json", { cache: "no-store" })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ return j && j.sites && j.sites.length ? j : null; })
      .catch(function(){ return null; });
  }
  function sharedFile(siteUrl){
    var entry = sharedIndex.sites.filter(function(s){ return s.siteUrl === siteUrl; })[0];
    if (!entry) return Promise.reject(new Error("No synced data for " + shortSite(siteUrl)));
    if (!sharedFiles[siteUrl]) sharedFiles[siteUrl] = fetch("data/gsc/" + encodeURIComponent(entry.file), { cache: "no-store" })
      .then(function(r){ if (!r.ok) throw new Error("Couldn't load synced data for " + shortSite(siteUrl)); return r.json(); })
      .catch(function(e){ delete sharedFiles[siteUrl]; throw e; });
    return sharedFiles[siteUrl];
  }
  function sharedDataset(siteUrl, range){
    return sharedFile(siteUrl).then(function(f){
      var w = windows(range), byDate = {};
      (f.daily || []).forEach(function(r){ byDate[r[0]] = r; });
      var rg = (f.ranges && f.ranges[range]) || {};
      function items(a){ return (a || []).map(function(r){ return { key: r[0], clicks: r[1], impressions: r[2], position: r[3] }; }); }
      return {
        siteUrl: siteUrl, window: w,
        series: dateList(w.pStart, w.end).map(function(d){ var r = byDate[d]; return { date: d, clicks: r ? r[1] : 0, impressions: r ? r[2] : 0, position: r ? r[3] : 0 }; }),
        queries: items(rg.q), pages: items(rg.p), countries: items(rg.c), devices: items(rg.d)
      };
    });
  }

  /* ================= live API (one or more Google accounts) ================= */
  var LS_ACCTS = "gsc.accounts.v1";
  state.accounts = [];   // [{ email, access_token, exp, sites: [{siteUrl, permissionLevel}] }]
  function getClientId(){ return (window.GSC_CONFIG && window.GSC_CONFIG.clientId) || lsGet(LS_CID) || ""; }
  function saveAccounts(){ lsSet(LS_ACCTS, JSON.stringify(state.accounts.map(function(a){ return { email: a.email, access_token: a.access_token, exp: a.exp }; }))); }
  function restoreAccounts(){
    var saved; try { saved = JSON.parse(lsGet(LS_ACCTS) || "[]"); } catch(e){ saved = []; }
    state.accounts = (Array.isArray(saved) ? saved : []).filter(function(a){ return a && a.email; }).map(function(a){ return { email: a.email, access_token: a.access_token, exp: a.exp || 0, sites: [] }; });
  }
  function isActive(a){ return a.access_token && a.exp > Date.now(); }
  var gisPromise;
  function loadGis(){
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function(resolve, reject){
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      var s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = function(){ resolve(); }; s.onerror = function(){ gisPromise = null; reject(new Error("Couldn't load Google sign-in.")); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }
  // hint = an email to re-authorise; no hint = let the user pick (or add) an account
  function requestToken(hint){
    return loadGis().then(function(){
      return new Promise(function(resolve, reject){
        var client = google.accounts.oauth2.initTokenClient({
          client_id: getClientId(), scope: SCOPE + " email", hint: hint || undefined, login_hint: hint || undefined,
          callback: function(resp){
            if (resp.error) return reject(new Error(resp.error_description || resp.error));
            if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE))
              return reject(new Error("Search Console access wasn't granted. Tick the Search Console box when signing in."));
            resolve({ access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000 });
          },
          error_callback: function(err){ reject(new Error(err && err.message || "Sign-in was cancelled.")); }
        });
        client.requestAccessToken({ prompt: hint ? "" : "select_account" });
      });
    });
  }
  function authed(acct, url, body){
    if (!isActive(acct)) return Promise.reject(new Error("The session for " + acct.email + " expired. Reconnect it from the Accounts menu."));
    return fetch(url, {
      method: body ? "POST" : "GET",
      headers: Object.assign({ Authorization: "Bearer " + acct.access_token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function(res){
      if (res.status === 401){ acct.exp = 0; saveAccounts(); }
      if (!res.ok) return res.json().catch(function(){ return {}; }).then(function(j){ throw new Error((j.error && j.error.message) || ("Google API error " + res.status)); });
      return res.json();
    });
  }
  function loadAccountSites(acct){
    return authed(acct, API + "/sites").then(function(j){ acct.sites = j.siteEntry || []; return acct; });
  }
  function ownerOf(siteUrl){
    return state.accounts.filter(function(a){ return isActive(a) && a.sites.some(function(s){ return s.siteUrl === siteUrl && s.permissionLevel !== "siteUnverifiedUser"; }); })[0];
  }
  // keep concurrent API calls modest (quota is per-user, per-site QPS)
  var active = 0, queue = [];
  function limited(fn){ return new Promise(function(res, rej){ queue.push({ fn: fn, res: res, rej: rej }); pump(); }); }
  function pump(){ while (active < 4 && queue.length){ var j = queue.shift(); active++; j.fn().then(j.res, j.rej).then(function(){ active--; pump(); }); } }
  function sa(siteUrl, body){
    var acct = ownerOf(siteUrl);
    if (!acct) return Promise.reject(new Error("No connected account can read " + shortSite(siteUrl) + "."));
    return limited(function(){ return authed(acct, API + "/sites/" + encodeURIComponent(siteUrl) + "/searchAnalytics/query", Object.assign({ dataState: "all" }, body)); });
  }
  function rowsToItems(rows){ return (rows || []).map(function(r){ return { key: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }; }); }
  function liveDataset(siteUrl, range){
    var w = windows(range);
    return Promise.all([
      sa(siteUrl, { startDate: w.pStart, endDate: w.end, dimensions: ["date"], rowLimit: 25000 }),
      sa(siteUrl, { startDate: w.start, endDate: w.end, dimensions: ["query"], rowLimit: 500 }),
      sa(siteUrl, { startDate: w.start, endDate: w.end, dimensions: ["page"], rowLimit: 250 }),
      sa(siteUrl, { startDate: w.start, endDate: w.end, dimensions: ["country"], rowLimit: 60 }),
      sa(siteUrl, { startDate: w.start, endDate: w.end, dimensions: ["device"], rowLimit: 10 })
    ]).then(function(r){
      var byDate = {}; (r[0].rows || []).forEach(function(row){ byDate[row.keys[0]] = row; });
      return {
        siteUrl: siteUrl, window: w,
        series: dateList(w.pStart, w.end).map(function(d){ var p = byDate[d]; return { date: d, clicks: p ? p.clicks : 0, impressions: p ? p.impressions : 0, position: p ? p.position : 0 }; }),
        queries: rowsToItems(r[1].rows), pages: rowsToItems(r[2].rows), countries: rowsToItems(r[3].rows), devices: rowsToItems(r[4].rows)
      };
    });
  }
  function dataset(siteUrl){
    var k = state.mode + "|" + siteUrl + "|" + state.range;
    if (!cache[k]){
      var load = state.mode === "demo" ? Promise.resolve(demoDataset(siteUrl, state.range))
        : state.mode === "shared" ? sharedDataset(siteUrl, state.range) : liveDataset(siteUrl, state.range);
      cache[k] = load.catch(function(e){ delete cache[k]; throw e; });
    }
    return cache[k];
  }

  /* ================= combining ================= */
  function totalsOf(points){
    var c = 0, i = 0, pw = 0;
    points.forEach(function(p){ c += p.clicks; i += p.impressions; pw += (p.position || 0) * p.impressions; });
    return { clicks: c, impressions: i, ctr: i ? c / i : 0, position: i ? pw / i : 0 };
  }
  function metricOf(t, m){ return t[m]; }
  function mergeItems(lists){
    var map = {};
    lists.forEach(function(entry){
      entry.items.forEach(function(it){
        var m = map[it.key] || (map[it.key] = { key: it.key, clicks: 0, impressions: 0, pw: 0, sites: [] });
        m.clicks += it.clicks; m.impressions += it.impressions; m.pw += it.position * it.impressions;
        if (m.sites.indexOf(entry.siteUrl) === -1) m.sites.push(entry.siteUrl);
      });
    });
    return Object.keys(map).map(function(k){ var m = map[k]; m.ctr = m.impressions ? m.clicks / m.impressions : 0; m.position = m.impressions ? m.pw / m.impressions : 0; return m; })
      .sort(function(a, b){ return b.clicks - a.clicks || b.impressions - a.impressions; });
  }
  function combine(sets){
    var w = sets[0].window;
    var dates = sets[0].series.map(function(p){ return p.date; });
    var combined = dates.map(function(d, idx){
      var c = 0, i = 0, pw = 0;
      sets.forEach(function(s){ var p = s.series[idx]; c += p.clicks; i += p.impressions; pw += (p.position || 0) * p.impressions; });
      return { date: d, clicks: c, impressions: i, ctr: i ? c / i : 0, position: i ? pw / i : 0 };
    });
    function cur(pts){ return pts.filter(function(p){ return p.date >= w.start; }); }
    function prev(pts){ return pts.filter(function(p){ return p.date < w.start; }); }
    // Search Console keeps ~16 months; if the previous window reaches past that,
    // a comparison would be against partial data, so report "no prior data".
    var prevOk = w.pStart >= iso(addDays(new Date(w.end + "T00:00:00Z"), -485));
    var none = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    var perSite = sets.map(function(s){
      return { siteUrl: s.siteUrl, cur: totalsOf(cur(s.series)), prev: prevOk ? totalsOf(prev(s.series)) : none,
        series: cur(s.series).map(function(p){ return { date: p.date, clicks: p.clicks, impressions: p.impressions, ctr: p.impressions ? p.clicks / p.impressions : 0, position: p.impressions ? p.position : null }; }) };
    });
    return {
      window: w, dates: cur(combined).map(function(p){ return p.date; }),
      series: cur(combined), prevSeries: prev(combined),
      cur: totalsOf(cur(combined)), prev: prevOk ? totalsOf(prev(combined)) : none, perSite: perSite,
      queries: mergeItems(sets.map(function(s){ return { siteUrl: s.siteUrl, items: s.queries }; })),
      pages: mergeItems(sets.map(function(s){ return { siteUrl: s.siteUrl, items: s.pages }; })),
      countries: mergeItems(sets.map(function(s){ return { siteUrl: s.siteUrl, items: s.countries }; })),
      devices: mergeItems(sets.map(function(s){ return { siteUrl: s.siteUrl, items: s.devices }; }))
    };
  }

  /* ================= site multi-select ================= */
  function renderSiteList(){
    var q = $("msSearch").value.trim().toLowerCase();
    var list = state.sites.filter(function(s){ return !q || s.siteUrl.toLowerCase().indexOf(q) !== -1; });
    $("msOnly").hidden = !q;
    $("msList").innerHTML = list.length ? list.map(function(s){
      var on = state.selected.indexOf(s.siteUrl) !== -1;
      var unverified = s.permissionLevel === "siteUnverifiedUser";
      return '<li class="ms-item" role="option" aria-selected="' + on + '"><label>' +
        '<input type="checkbox" data-site="' + esc(s.siteUrl) + '"' + (on ? " checked" : "") + (unverified ? " disabled" : "") + '>' +
        '<span class="ms-name" title="' + esc(s.siteUrl) + '">' + esc(shortSite(s.siteUrl)) + '</span>' +
        '<span class="ms-kind">' + (unverified ? "Unverified" : siteKind(s.siteUrl)) + '</span></label></li>';
    }).join("") : '<li class="ms-empty">' + (state.sites.length ? "No properties match." : "No properties found in this Google account.") + '</li>';
  }
  function updateTrigger(){
    var n = state.selected.length;
    $("msCount").textContent = n;
    $("msLabel").textContent = n === 0 ? "Select sites" : n === 1 ? shortSite(state.selected[0]) : n === usableSites().length ? "All sites" : n + " sites combined";
  }
  function usableSites(){ return state.sites.filter(function(s){ return s.permissionLevel !== "siteUnverifiedUser"; }); }
  function setSelected(list){
    var valid = usableSites().map(function(s){ return s.siteUrl; });
    state.selected = list.filter(function(u, i){ return valid.indexOf(u) !== -1 && list.indexOf(u) === i; });
    lsSet(LS_SEL + "." + state.mode, JSON.stringify(state.selected));
    assignSlots(); updateTrigger(); renderSiteList(); renderChips(); refresh();
  }
  function renderChips(){
    $("chips").innerHTML = state.selected.map(function(u){
      return '<span class="chip glass-panel"><span class="sw" style="background:' + colorFor(u) + '"></span>' + esc(shortSite(u)) +
        '<button type="button" data-remove="' + esc(u) + '" aria-label="Remove ' + esc(shortSite(u)) + '">×</button></span>';
    }).join("");
  }
  function wireMultiSelect(){
    var pop = $("msPop"), trig = $("msTrigger");
    function open(v){ pop.classList.toggle("open", v); trig.setAttribute("aria-expanded", String(v)); if (v){ renderSiteList(); setTimeout(function(){ $("msSearch").focus(); }, 0); } }
    trig.addEventListener("click", function(e){ e.stopPropagation(); open(!pop.classList.contains("open")); });
    document.addEventListener("click", function(e){ if (e.target.isConnected && !$("siteMs").contains(e.target)) open(false); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape" && pop.classList.contains("open")){ open(false); trig.focus(); } });
    $("msSearch").addEventListener("input", renderSiteList);
    $("msList").addEventListener("change", function(e){
      var u = e.target.getAttribute("data-site"); if (!u) return;
      setSelected(e.target.checked ? state.selected.concat([u]) : state.selected.filter(function(x){ return x !== u; }));
    });
    $("msAll").addEventListener("click", function(){ setSelected(state.selected.concat(usableSites().map(function(s){ return s.siteUrl; }))); });
    $("msNone").addEventListener("click", function(){ setSelected([]); });
    $("msOnly").addEventListener("click", function(){
      var q = $("msSearch").value.trim().toLowerCase();
      setSelected(usableSites().filter(function(s){ return s.siteUrl.toLowerCase().indexOf(q) !== -1; }).map(function(s){ return s.siteUrl; }));
    });
    $("chips").addEventListener("click", function(e){
      var b = e.target.closest("[data-remove]"); if (!b) return;
      var u = b.getAttribute("data-remove"); setSelected(state.selected.filter(function(x){ return x !== u; }));
    });
  }

  /* ================= segmented controls ================= */
  function seg(el, opts, cur, onPick){
    el.innerHTML = opts.map(function(o){ return '<button type="button" data-k="' + o.key + '" aria-pressed="' + (String(o.key) === String(cur)) + '">' + o.label + '</button>'; }).join("");
    el.onclick = function(e){ var b = e.target.closest("button"); if (b) onPick(b.getAttribute("data-k")); };
  }
  function renderControls(){
    seg($("rangeSeg"), RANGES, state.range, function(k){ state.range = Number(k); state.qLimit = state.pLimit = 15; renderControls(); refresh(); });
    seg($("metricSeg"), METRICS, state.metric, function(k){ state.metric = k; renderControls(); paint(); });
    seg($("modeSeg"), [{ key: "combined", label: "Combined" }, { key: "split", label: "By site" }], state.chartMode, function(k){ state.chartMode = k; renderControls(); paint(); });
    var w = windows(state.range);
    $("rangeNote").textContent = fmtDate(w.start) + " – " + fmtDate(w.end) + " · vs previous " + state.range + " days";
  }
  function fmtDate(s, short){ var d = new Date(s + "T00:00:00Z"); return d.toLocaleDateString("en-US", short ? { month: "short", day: "numeric", timeZone: "UTC" } : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); }

  /* ================= rendering ================= */
  var current = null;   // last combined dataset
  function refresh(){
    var seq = ++renderSeq;
    if (!state.selected.length){ current = null; paint(); return; }
    setLoading(true);
    Promise.all(state.selected.map(dataset)).then(function(sets){
      if (seq !== renderSeq) return;
      current = combine(sets); setLoading(false); paint();
      $("footerStamp").textContent = ({ demo: "Demo data", shared: "Daily-synced Search Console data", live: "Live Search Console data" })[state.mode] + " · loaded " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }).catch(function(err){
      if (seq !== renderSeq) return;
      setLoading(false); toast(err.message || String(err), 6000); console.error(err);
    });
  }
  function setLoading(v){ ["kpis", "trendCard"].forEach(function(id){ $(id).classList.toggle("loading", v); }); }

  function paint(){
    renderKpis(); renderTrend(); renderSitesTable(); renderQueries(); renderPages(); renderBars();
  }
  function deltaHtml(cur, prev, invert, isRatio){
    if (!prev){ return '<span class="delta flat">no prior data</span>'; }
    var d = isRatio ? (cur - prev) : (cur - prev) / prev;
    if (invert) d = prev - cur;   // position: lower is better
    var good = d > 0, flat = Math.abs(d) < 1e-9;
    var txt;
    if (invert) txt = (cur < prev ? "▲ " : cur > prev ? "▼ " : "") + Math.abs(cur - prev).toFixed(1);
    else if (isRatio) txt = (d >= 0 ? "▲ " : "▼ ") + Math.abs(d * 100).toFixed(2) + " pts";
    else txt = (d >= 0 ? "▲ " : "▼ ") + Math.abs(d * 100).toFixed(1) + "%";
    return '<span class="delta ' + (flat ? "flat" : good ? "up" : "down") + '">' + txt + '</span>';
  }
  function sparkline(values, color, invert){
    var w = 200, h = 34, n = values.length; if (n < 2) return "";
    var vals = values.map(function(v){ return v == null ? 0 : v; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals); if (max === min){ max += 1; min -= 1; }
    var pts = vals.map(function(v, i){ var y = (v - min) / (max - min); if (invert) y = 1 - y; return [(i / (n - 1)) * w, h - 3 - y * (h - 6)]; });
    var line = pts.map(function(p, i){ return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + line + ' L' + w + ' ' + h + ' L0 ' + h + 'Z" fill="' + color + '" opacity=".16"/><path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }
  function renderKpis(){
    var el = $("kpis");
    if (!current){ el.innerHTML = '<div class="kpi glass-panel" style="grid-column:1/-1"><div class="empty">Pick one or more sites to see their combined Search Console performance.</div></div>'; return; }
    var acc = cssVar("--accent");
    el.innerHTML = METRICS.map(function(m){
      var cur = current.cur[m.key], prev = current.prev[m.key];
      var sub = m.key === "ctr" ? fmtFull(current.cur.clicks) + " clicks / " + fmtFull(current.cur.impressions) + " impr."
        : m.key === "position" ? "Weighted by impressions" : "Prev: " + (prev ? fmtFull(prev) : "—");
      return '<div class="kpi glass-panel"><span class="kpi-label">' + m.label + '</span>' +
        '<div class="kpi-row"><span class="kpi-value" title="' + (m.key === "clicks" || m.key === "impressions" ? fmtFull(cur) : "") + '">' + m.fmt(cur) + '</span>' +
        deltaHtml(cur, prev, m.invert, m.key === "ctr") + '</div>' +
        '<span class="kpi-sub">' + sub + '</span>' +
        sparkline(current.series.map(function(p){ return m.key === "position" ? (p.impressions ? p.position : null) : p[m.key]; }), acc, m.invert) + '</div>';
    }).join("");
  }

  /* ---- trend chart: one y-axis, crosshair + tooltip ---- */
  function bucketize(dates, seriesPoints){
    // >120 days → weekly buckets so long ranges stay legible
    if (dates.length <= 120) return { labels: dates, pts: seriesPoints, weekly: false };
    var labels = [], pts = seriesPoints.map(function(){ return []; });
    for (var i = 0; i < dates.length; i += 7){
      labels.push(dates[i]);
      seriesPoints.forEach(function(sp, si){
        var chunk = sp.slice(i, i + 7), c = 0, im = 0, pw = 0;
        chunk.forEach(function(p){ c += p.clicks; im += p.impressions; pw += (p.position || 0) * p.impressions; });
        pts[si].push({ date: dates[i], clicks: c, impressions: im, ctr: im ? c / im : 0, position: im ? pw / im : null });
      });
    }
    return { labels: labels, pts: pts, weekly: true };
  }
  function renderTrend(){
    var box = $("trendChart"), legend = $("trendLegend"), m = METRICS.filter(function(x){ return x.key === state.metric; })[0];
    $("trendTitle").textContent = m.label + " over time";
    if (!current){ box.innerHTML = '<div class="empty">No sites selected.</div>'; legend.innerHTML = ""; return; }
    var series;
    if (state.chartMode === "combined" || current.perSite.length === 1){
      series = [{ name: current.perSite.length === 1 ? shortSite(current.perSite[0].siteUrl) : "All selected (" + current.perSite.length + ")", color: current.perSite.length === 1 ? colorFor(current.perSite[0].siteUrl) : cssVar("--accent"), points: current.series }];
    } else {
      var ranked = current.perSite.slice().sort(function(a, b){ return b.cur.clicks - a.cur.clicks; });
      var main = ranked.filter(function(s){ return state.slots[s.siteUrl]; }), rest = ranked.filter(function(s){ return !state.slots[s.siteUrl]; });
      series = main.map(function(s){ return { name: shortSite(s.siteUrl), color: colorFor(s.siteUrl), points: s.series }; });
      if (rest.length){
        series.push({ name: "Other (" + rest.length + ")", color: cssVar("--s-other"), points: current.dates.map(function(d, i){
          var c = 0, im = 0, pw = 0; rest.forEach(function(s){ var p = s.series[i]; c += p.clicks; im += p.impressions; pw += (p.position || 0) * p.impressions; });
          return { date: d, clicks: c, impressions: im, ctr: im ? c / im : 0, position: im ? pw / im : null };
        }) });
      }
    }
    // start the chart where the selected sites first have data, rather than
    // drawing a long flat line for days before they were in Search Console
    var first = 0;
    while (first < current.series.length - 2 && !current.series[first].impressions) first++;
    var dates = current.dates.slice(first);
    var b = bucketize(dates, series.map(function(s){ return s.points.slice(first); }));
    series.forEach(function(s, i){ s.values = b.pts[i].map(function(p){ var v = p[state.metric]; return state.metric === "position" && !p.impressions ? null : v; }); });
    legend.innerHTML = series.length > 1 ? series.map(function(s){ return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") : "";
    lineChart(box, b.labels, series, m, b.weekly);
  }
  function niceTicks(min, max, count){
    var span = max - min || 1, step = Math.pow(10, Math.floor(Math.log10(span / count))), err = span / count / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
    for (var v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }
  function lineChart(box, labels, series, metric, weekly){
    var W = Math.max(300, box.clientWidth || 600), H = W < 520 ? 230 : 290;
    var padL = 48, padR = series.length <= 4 && series.length > 1 && W > 620 ? 120 : 14, padT = 12, padB = 28;
    var iw = W - padL - padR, ih = H - padT - padB, n = labels.length;
    var all = []; series.forEach(function(s){ s.values.forEach(function(v){ if (v != null) all.push(v); }); });
    if (!all.length){ box.innerHTML = '<div class="empty">No data for this range.</div>'; return; }
    var min = metric.key === "position" ? Math.max(1, Math.min.apply(null, all)) : 0, max = Math.max.apply(null, all);
    if (max === min) max = min + 1;
    var ticks = niceTicks(min, max, 4); min = ticks[0]; max = ticks[ticks.length - 1];
    if (metric.key === "position" && min < 1) min = 1;
    function x(i){ return padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function y(v){ var t = (v - min) / (max - min); if (metric.invert) t = 1 - t; return padT + ih - t * ih; }
    var tickFmt = metric.key === "ctr" ? function(v){ return (v * 100).toFixed(v < 0.1 ? 1 : 0) + "%"; } : metric.key === "position" ? function(v){ return v.toFixed(0); } : fmtInt;
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="img" aria-label="' + esc(metric.label) + ' trend">';
    ticks.forEach(function(t){ if (t < min - 1e-9) return; var yy = y(t).toFixed(1);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + cssVar("--g-grid") + '"/>' +
             '<text class="axis" x="' + (padL - 8) + '" y="' + yy + '" dy="3.5" text-anchor="end">' + tickFmt(t) + '</text>'; });
    var xt = Math.min(n, W < 520 ? 4 : 7);
    for (var k = 0; k < xt; k++){ var i = Math.round(k * (n - 1) / Math.max(1, xt - 1));
      svg += '<text class="axis" x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + (k === 0 ? "start" : k === xt - 1 ? "end" : "middle") + '">' + fmtDate(labels[i], true) + '</text>'; }
    var labelYs = [];
    series.forEach(function(s, si){
      var d = "", pen = false;
      s.values.forEach(function(v, i){ if (v == null){ pen = false; return; } d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); pen = true; });
      if (series.length === 1){
        var area = d.replace(/^M/, "M") ; // area fill under the single combined line
        var firstI = s.values.findIndex(function(v){ return v != null; }), lastI = s.values.length - 1 - s.values.slice().reverse().findIndex(function(v){ return v != null; });
        if (firstI >= 0 && !metric.invert) svg += '<path d="' + area + ' L' + x(lastI).toFixed(1) + ' ' + (padT + ih) + ' L' + x(firstI).toFixed(1) + ' ' + (padT + ih) + 'Z" fill="' + s.color + '" opacity=".14"/>';
      }
      svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      if (padR > 14){
        var li = s.values.length - 1; while (li > 0 && s.values[li] == null) li--;
        if (s.values[li] != null) labelYs.push({ y: y(s.values[li]), name: s.name, x: x(li) });
      }
    });
    // direct end labels, nudged apart
    labelYs.sort(function(a, b){ return a.y - b.y; });
    for (var q = 1; q < labelYs.length; q++) if (labelYs[q].y - labelYs[q - 1].y < 13) labelYs[q].y = labelYs[q - 1].y + 13;
    labelYs.forEach(function(l){ var nm = l.name.length > 16 ? l.name.slice(0, 15) + "…" : l.name;
      svg += '<text x="' + (l.x + 8).toFixed(1) + '" y="' + l.y.toFixed(1) + '" dy="3.5" font-size="11" font-weight="600" fill="' + cssVar("--g-text-2") + '">' + esc(nm) + '</text>'; });
    svg += '<line id="xhair" y1="' + padT + '" y2="' + (padT + ih) + '" stroke="' + cssVar("--g-axis") + '" stroke-dasharray="3 3" visibility="hidden"/>';
    svg += '<g id="xdots"></g><rect x="' + padL + '" y="0" width="' + iw + '" height="' + (H - padB) + '" fill="transparent" id="hit"/></svg>';
    box.innerHTML = svg + '<div class="tip" id="tip"></div>';

    var svgEl = box.querySelector("svg"), hit = box.querySelector("#hit"), xh = box.querySelector("#xhair"), dots = box.querySelector("#xdots"), tip = box.querySelector("#tip");
    var surface = cssVar("--g-text") === "#ffffff" ? "rgba(20,20,30,.9)" : "#fff";
    function show(evt){
      var rect = svgEl.getBoundingClientRect(), px = (evt.clientX - rect.left) * (W / rect.width);
      var i = Math.round(((px - padL) / iw) * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
      var xx = x(i); xh.setAttribute("x1", xx); xh.setAttribute("x2", xx); xh.setAttribute("visibility", "visible");
      var rows = series.map(function(s){ return { s: s, v: s.values[i] }; }).filter(function(r){ return r.v != null; });
      dots.innerHTML = rows.map(function(r){ return '<circle cx="' + xx + '" cy="' + y(r.v) + '" r="4.5" fill="' + r.s.color + '" stroke="' + surface + '" stroke-width="2"/>'; }).join("");
      rows.sort(function(a, b){ return metric.invert ? a.v - b.v : b.v - a.v; });
      var end = weekly ? fmtDate(iso(addDays(new Date(labels[i] + "T00:00:00Z"), 6)), true) : null;
      tip.innerHTML = '<b>' + (weekly ? "Week of " + fmtDate(labels[i], true) + " – " + end : fmtDate(labels[i])) + '</b>' +
        rows.map(function(r){ return '<div class="r"><i style="background:' + r.s.color + '"></i>' + esc(r.s.name) + '<em>' + metric.fmt(r.v) + '</em></div>'; }).join("");
      tip.classList.add("show");
      var bw = box.clientWidth, tx = (xx / W) * rect.width, tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(bw - tw, tx + 14 + tw > bw ? tx - tw - 14 : tx + 14)) + "px";
      tip.style.top = "8px";
    }
    function hide(){ xh.setAttribute("visibility", "hidden"); dots.innerHTML = ""; tip.classList.remove("show"); }
    hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show); hit.addEventListener("pointerleave", hide);
  }

  function renderSitesTable(){
    var t = $("sitesTable");
    if (!current){ t.innerHTML = '<tbody><tr><td class="empty">No sites selected.</td></tr></tbody>'; return; }
    var rows = current.perSite.slice().sort(function(a, b){ return b.cur.clicks - a.cur.clicks; });
    var total = current.cur.clicks || 1;
    t.innerHTML = '<thead><tr><th>Site</th><th class="n">Clicks</th><th class="n">Δ</th><th class="n">Impressions</th><th class="n">CTR</th><th class="n">Position</th><th>Share of clicks</th></tr></thead><tbody>' +
      rows.map(function(s){
        var share = s.cur.clicks / total;
        return '<tr><td class="main"><span class="dots"><i style="background:' + colorFor(s.siteUrl) + '"></i></span> ' + esc(shortSite(s.siteUrl)) + '</td>' +
          '<td class="n">' + fmtFull(s.cur.clicks) + '</td><td class="n">' + deltaHtml(s.cur.clicks, s.prev.clicks) + '</td>' +
          '<td class="n">' + fmtFull(s.cur.impressions) + '</td><td class="n">' + fmtPct(s.cur.ctr) + '</td><td class="n">' + fmtPos(s.cur.position) + '</td>' +
          '<td><div class="share"><div class="track"><div class="fill" style="width:' + (share * 100).toFixed(1) + '%;background:' + colorFor(s.siteUrl) + '"></div></div><span>' + (share * 100).toFixed(1) + '%</span></div></td></tr>';
      }).join("") +
      (rows.length > 1 ? '<tr><td class="main"><b>Combined</b></td><td class="n"><b>' + fmtFull(current.cur.clicks) + '</b></td><td class="n">' + deltaHtml(current.cur.clicks, current.prev.clicks) + '</td><td class="n"><b>' + fmtFull(current.cur.impressions) + '</b></td><td class="n"><b>' + fmtPct(current.cur.ctr) + '</b></td><td class="n"><b>' + fmtPos(current.cur.position) + '</b></td><td></td></tr>' : "") +
      '</tbody>';
  }
  function siteDots(sites){ return '<span class="dots" title="' + esc(sites.map(shortSite).join(", ")) + '">' + sites.map(function(u){ return '<i style="background:' + colorFor(u) + '"></i>'; }).join("") + '</span>'; }
  function itemTable(tableId, moreId, items, limit, filter, labelFn, head){
    var t = $(tableId);
    if (!current){ t.innerHTML = '<tbody><tr><td class="empty">No sites selected.</td></tr></tbody>'; $(moreId).hidden = true; return; }
    var f = filter.trim().toLowerCase();
    var list = f ? items.filter(function(it){ return it.key.toLowerCase().indexOf(f) !== -1; }) : items;
    var multi = current.perSite.length > 1;
    t.innerHTML = '<thead><tr><th>' + head + '</th>' + (multi ? '<th>Sites</th>' : '') + '<th class="n">Clicks</th><th class="n">Impr.</th><th class="n">CTR</th><th class="n">Pos.</th></tr></thead><tbody>' +
      (list.length ? list.slice(0, limit).map(function(it){
        return '<tr><td class="main" title="' + esc(it.key) + '">' + labelFn(it.key) + '</td>' + (multi ? '<td>' + siteDots(it.sites) + '</td>' : '') +
          '<td class="n">' + fmtFull(it.clicks) + '</td><td class="n">' + fmtFull(it.impressions) + '</td><td class="n">' + fmtPct(it.ctr) + '</td><td class="n">' + fmtPos(it.position) + '</td></tr>';
      }).join("") : '<tr><td colspan="6" class="empty" style="min-height:80px">Nothing matches.</td></tr>') + '</tbody>';
    $(moreId).hidden = list.length <= limit;
  }
  function renderQueries(){ itemTable("queriesTable", "qMore", current ? current.queries : [], state.qLimit, $("qSearch").value, esc, "Query"); }
  function renderPages(){
    itemTable("pagesTable", "pMore", current ? current.pages : [], state.pLimit, $("pSearch").value, function(u){
      var path = u.replace(/^https?:\/\/[^/]+/, "") || "/", host = u.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + (current.perSite.length > 1 ? '<span style="opacity:.6">' + esc(host) + '</span>' : '') + esc(path) + '</a>';
    }, "Page");
  }
  var A3 = { usa:"US", can:"CA", gbr:"GB", ind:"IN", aus:"AU", phl:"PH", mex:"MX", pri:"PR", zaf:"ZA", deu:"DE", fra:"FR", esp:"ES", ita:"IT", bra:"BR", nld:"NL", irl:"IE", nzl:"NZ", sgp:"SG", pak:"PK", nga:"NG", are:"AE", sau:"SA", jpn:"JP", kor:"KR", chn:"CN", col:"CO", arg:"AR", chl:"CL", per:"PE", tto:"TT", jam:"JM", kny:"KE", ken:"KE", gha:"GH", egy:"EG", tur:"TR", pol:"PL", swe:"SE", nor:"NO", dnk:"DK", fin:"FI", bel:"BE", che:"CH", aut:"AT", prt:"PT", grc:"GR", isr:"IL", mys:"MY", idn:"ID", tha:"TH", vnm:"VN", bgd:"BD", lka:"LK", dom:"DO", gtm:"GT", hnd:"HN", slv:"SV", cri:"CR", pan:"PA", ecu:"EC", ven:"VE", qat:"QA", kwt:"KW", omn:"OM", bhr:"BH", hkg:"HK", gum:"GU", vir:"VI", asm:"AS", mnp:"MP", bhs:"BS", brb:"BB", blz:"BZ", nic:"NI", pry:"PY", ury:"UY", bol:"BO", cub:"CU", hti:"HT", mar:"MA", dza:"DZ", tun:"TN", eth:"ET", uga:"UG", tza:"TZ", zwe:"ZW", zmb:"ZM", cmr:"CM", npl:"NP", mmr:"MM", khm:"KH", irn:"IR", irq:"IQ", jor:"JO", lbn:"LB", isl:"IS", lux:"LU", hrv:"HR", srb:"RS", svk:"SK", svn:"SI", bgr:"BG", ltu:"LT", lva:"LV", est:"EE", cyp:"CY", mlt:"MT", geo:"GE", arm:"AM", aze:"AZ", kaz:"KZ", uzb:"UZ", fji:"FJ", png:"PG", twn:"TW", rus:"RU", ukr:"UA", rou:"RO", cze:"CZ", hun:"HU" };
  var regionNames; try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch(e){}
  function countryName(c){ var a2 = A3[String(c).toLowerCase()]; try { return a2 && regionNames ? regionNames.of(a2) : String(c).toUpperCase(); } catch(e){ return String(c).toUpperCase(); } }
  function bars(el, items, labelFn, max){
    if (!current){ el.innerHTML = '<div class="empty">No sites selected.</div>'; return; }
    var top = items.slice(0, max), total = items.reduce(function(a, b){ return a + b.clicks; }, 0) || 1, peak = top.length ? top[0].clicks || 1 : 1;
    el.innerHTML = top.length ? top.map(function(it){
      return '<div class="bar" title="' + fmtFull(it.impressions) + ' impressions · CTR ' + fmtPct(it.ctr) + '"><span class="lbl">' + esc(labelFn(it.key)) + '</span>' +
        '<div class="track"><div class="fill" style="width:' + (it.clicks / peak * 100).toFixed(1) + '%"></div></div>' +
        '<span class="val">' + fmtFull(it.clicks) + ' · ' + (it.clicks / total * 100).toFixed(1) + '%</span></div>';
    }).join("") : '<div class="empty">No data.</div>';
  }
  function renderBars(){
    bars($("countryBars"), current ? current.countries : [], countryName, 8);
    bars($("deviceBars"), current ? current.devices : [], function(k){ return k.charAt(0) + k.slice(1).toLowerCase(); }, 3);
  }

  /* ================= modes: live (signed-in accounts) → shared (daily sync) → demo ================= */
  function loadSelection(){
    var saved; try { saved = JSON.parse(lsGet(LS_SEL + "." + state.mode) || "null"); } catch(e){}
    var usable = usableSites().map(function(s){ return s.siteUrl; });
    state.selected = Array.isArray(saved) ? saved.filter(function(u){ return usable.indexOf(u) !== -1; }) : usable.slice();
    if (Array.isArray(saved) && saved.length && !state.selected.length) state.selected = usable.slice();
    state.slots = {}; assignSlots(); updateTrigger(); renderSiteList(); renderChips();
  }
  function setSource(live, text, button){
    $("sourcePill").classList.toggle("live", live); $("sourceText").textContent = text;
    $("connectBtn").textContent = button;
    $("demoBanner").hidden = state.mode !== "demo";
    renderControls(); renderAccounts();
  }
  function enterBase(){ return sharedIndex ? enterShared() : enterDemo(); }
  function enterDemo(){
    state.mode = "demo"; state.endDate = null;
    state.sites = DEMO_SITES.map(function(s){ return { siteUrl: s.siteUrl, permissionLevel: "siteOwner" }; });
    setSource(false, "Demo data", "Connect Google");
    loadSelection(); refresh();
  }
  function enterShared(){
    state.mode = "shared"; state.endDate = sharedIndex.endDate || null;
    state.sites = sharedIndex.sites.map(function(s){ return { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel || "siteOwner" }; })
      .sort(function(a, b){ return shortSite(a.siteUrl).localeCompare(shortSite(b.siteUrl)); });
    var when = sharedIndex.generatedAt ? new Date(sharedIndex.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    setSource(true, "Synced daily" + (when ? " · updated " + when : ""), state.accounts.length ? "Accounts (" + state.accounts.length + ")" : "Sign in for live data");
    loadSelection(); refresh();
  }
  function enterLive(){
    var activeAccts = state.accounts.filter(isActive);
    if (!activeAccts.length) return Promise.resolve(enterBase());
    setLoading(true);
    return Promise.all(activeAccts.map(function(a){ return loadAccountSites(a).catch(function(err){ toast(a.email + ": " + err.message, 6000); return a; }); })).then(function(){
      state.mode = "live"; state.endDate = null;
      var seen = {}; state.sites = [];
      state.accounts.filter(isActive).forEach(function(a){ a.sites.forEach(function(s){
        if (!seen[s.siteUrl] || (seen[s.siteUrl].permissionLevel === "siteUnverifiedUser" && s.permissionLevel !== "siteUnverifiedUser")){
          if (seen[s.siteUrl]) state.sites.splice(state.sites.indexOf(seen[s.siteUrl]), 1);
          seen[s.siteUrl] = s; state.sites.push(s);
        }
      }); });
      state.sites.sort(function(a, b){ return shortSite(a.siteUrl).localeCompare(shortSite(b.siteUrl)); });
      Object.keys(cache).forEach(function(k){ if (k.indexOf("live|") === 0) delete cache[k]; });
      var n = state.accounts.filter(isActive).length;
      setSource(true, "Live · " + n + " account" + (n === 1 ? "" : "s") + " · " + usableSites().length + " properties", "Accounts (" + state.accounts.length + ")");
      if (!state.sites.length) toast("The connected accounts have no Search Console properties.", 6000);
      loadSelection(); refresh();
    });
  }
  function upsertAccount(tok){
    return fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tok.access_token } })
      .then(function(r){ return r.ok ? r.json() : {}; })
      .then(function(info){
        var email = info.email || ("Google account " + (state.accounts.length + 1));
        var acct = state.accounts.filter(function(a){ return a.email === email; })[0];
        if (!acct){ acct = { email: email, sites: [] }; state.accounts.push(acct); }
        acct.access_token = tok.access_token; acct.exp = tok.exp;
        saveAccounts(); return acct;
      });
  }
  function addAccount(hint){
    if (!getClientId()){ openSetup(); return; }
    requestToken(hint).then(upsertAccount).then(function(acct){
      return enterLive().then(function(){ toast((hint ? "Reconnected " : "Added ") + acct.email); });
    }).catch(function(err){ toast(err.message || String(err), 6000); });
  }
  function removeAccount(email){
    var acct = state.accounts.filter(function(a){ return a.email === email; })[0]; if (!acct) return;
    if (acct.access_token && window.google && google.accounts && google.accounts.oauth2) try { google.accounts.oauth2.revoke(acct.access_token, function(){}); } catch(e){}
    state.accounts = state.accounts.filter(function(a){ return a !== acct; }); saveAccounts();
    toast("Removed " + email);
    enterLive();
  }
  function renderAccounts(){
    var list = $("acctList"); if (!list) return;
    list.innerHTML = state.accounts.length ? state.accounts.map(function(a){
      var ok = isActive(a);
      return '<li class="acct-item"><div class="acct-main"><span class="acct-email">' + esc(a.email) + '</span>' +
        '<span class="acct-meta">' + (ok ? a.sites.length + " properties" : "Session expired") + '</span></div>' +
        (ok ? "" : '<button type="button" class="acct-act" data-reconnect="' + esc(a.email) + '">Reconnect</button>') +
        '<button type="button" class="acct-x" data-remove-acct="' + esc(a.email) + '" aria-label="Remove ' + esc(a.email) + '">×</button></li>';
    }).join("") : '<li class="ms-empty">No accounts connected in this browser.</li>';
    $("acctShared").hidden = !(state.mode === "live" && sharedIndex);
    $("acctNote").textContent = sharedIndex
      ? "Signed-in accounts are only visible in this browser. Everyone else sees the daily-synced data."
      : "Signed-in accounts are only visible in this browser.";
  }
  function openSetup(){
    $("originHint").textContent = location.origin && location.origin !== "null" ? location.origin : "your site's origin (e.g. https://you.github.io)";
    $("clientIdInput").value = lsGet(LS_CID) || "";
    var d = $("setupDlg"); if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  }
  function wireSetup(){
    var d = $("setupDlg"), pop = $("acctPop"), btn = $("connectBtn");
    $("dlgCancel").addEventListener("click", function(){ d.close(); });
    $("dlgSave").addEventListener("click", function(){
      var v = $("clientIdInput").value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)){ toast("That doesn't look like an OAuth Client ID (…apps.googleusercontent.com)."); return; }
      lsSet(LS_CID, v); d.close(); addAccount();
    });
    function openPop(v){ pop.classList.toggle("open", v); btn.setAttribute("aria-expanded", String(v)); if (v) renderAccounts(); }
    btn.addEventListener("click", function(e){
      e.stopPropagation();
      if (!state.accounts.length){ addAccount(); return; }
      openPop(!pop.classList.contains("open"));
    });
    // ignore clicks on nodes a re-render just removed (e.g. an account's × button)
    document.addEventListener("click", function(e){ if (e.target.isConnected && !$("acctMenu").contains(e.target)) openPop(false); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape" && pop.classList.contains("open")){ openPop(false); btn.focus(); } });
    $("acctAdd").addEventListener("click", function(){ openPop(false); addAccount(); });
    $("acctShared").addEventListener("click", function(){ openPop(false); enterBase(); });
    $("acctList").addEventListener("click", function(e){
      var r = e.target.closest("[data-reconnect]"), x = e.target.closest("[data-remove-acct]");
      if (r){ openPop(false); addAccount(r.getAttribute("data-reconnect")); }
      if (x) removeAccount(x.getAttribute("data-remove-acct"));
    });
    $("bannerConnect").addEventListener("click", function(){ addAccount(); });
  }

  /* ================= boot ================= */
  function boot(){
    wireMultiSelect(); wireSetup(); renderControls();
    $("qSearch").addEventListener("input", function(){ state.qLimit = 15; renderQueries(); });
    $("pSearch").addEventListener("input", function(){ state.pLimit = 15; renderPages(); });
    $("qMore").addEventListener("click", function(){ state.qLimit += 25; renderQueries(); });
    $("pMore").addEventListener("click", function(){ state.pLimit += 25; renderPages(); });
    var rt; window.addEventListener("resize", function(){ clearTimeout(rt); rt = setTimeout(renderTrend, 120); });
    if (window.GlassTheme) GlassTheme.onChange(function(){ renderChips(); paint(); });

    restoreAccounts();
    loadSharedIndex().then(function(idx){
      sharedIndex = idx;
      // accounts signed in within the last hour resume without a popup
      if (state.accounts.some(isActive)) enterLive().catch(function(){ enterBase(); });
      else enterBase();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
