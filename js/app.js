// HeatGuard web app on ThingSpeak: one page, two roles (wearer / guardian).
// Reads the channels with their read keys, writes SOS / location with write keys,
// and sends commands to the band through a TalkBack queue. No server of its own.
(() => {
  'use strict';

  const API = ((window.HEATGUARD_CONFIG || {}).api ?? 'https://api.thingspeak.com').replace(/\/+$/, '');
  const STORE = 'hg.link.v2';
  const ACKS = 'hg.acks.v2';
  const POLL_MS = 15000;
  const LOC_EVERY_MS = 120000;
  const $ = (id) => document.getElementById(id);

  const S = {
    cfg: null, role: null, latest: null, events: [], settings: HG.DEFAULTS, phone: null,
    readings: [], hours: 24, series: 'hi', lastHist: 0, week: {}, lastWeek: 0,
    seen: new Set(), firstEvents: true, allEvents: false, loc: null, locSentAt: 0, timer: null,
  };

  // ---------------- utilities ----------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? '--' : Number(v).toFixed(d));
  const nowS = () => Math.floor(Date.now() / 1000);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  function ago(sec) {
    if (sec === null || sec === undefined || Number.isNaN(sec)) return 'never';
    if (sec < 50) return 'just now';
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ${m % 60} min ago`;
    return `${Math.floor(h / 24)} days ago`;
  }
  const mins = (m) => (!m ? '0 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  function clock(ts) {
    const d = new Date(ts * 1000);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return new Date().toDateString() === d.toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${t}`;
  }
  function toast(msg, ms = 4000) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => { t.hidden = true; }, ms);
  }
  const utc = (ts) => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // ---------------- ThingSpeak calls ----------------
  async function tsGet(path, params = {}) {
    const q = new URLSearchParams(params);
    const res = await fetch(`${API}${path}?${q}`, { cache: 'no-store' });
    if (!res.ok) { const e = new Error(`ThingSpeak returned ${res.status}`); e.status = res.status; throw e; }
    const text = await res.text();
    if (text === '-1') { const e = new Error('Wrong read key or private channel'); e.status = 401; throw e; }
    return JSON.parse(text);
  }
  // simple form POST (no custom headers, so no CORS preflight)
  async function tsPost(path, params) {
    const res = await fetch(`${API}${path}`, { method: 'POST', body: new URLSearchParams(params) });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }
  const feeds = (ch, params) => tsGet(`/channels/${ch.id}/feeds.json`, { api_key: ch.r, ...params });

  async function talkback(command) {
    const r = await tsPost(`/talkbacks/${S.cfg.t.id}/commands.json`, { api_key: S.cfg.t.k, command_string: command });
    if (!r.ok) throw new Error(r.status === 401 ? 'TalkBack key is wrong' : `TalkBack returned ${r.status}`);
  }

  // one write per channel every 15 s on free ThingSpeak: "0" means "too soon", so retry
  async function writeEvent(params, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const r = await tsPost('/update.json', { api_key: S.cfg.e.w, ...params });
      if (r.ok && r.text.trim().startsWith('{')) return true;
      if (i < tries - 1) await new Promise((ok) => setTimeout(ok, 16000));
    }
    return false;
  }

  // ---------------- link / setup ----------------
  function readHash() {
    if (!location.hash) return null;
    // the link stays in the address bar, so a reload or a bookmark keeps the same role
    const p = new URLSearchParams(location.hash.slice(1));
    return p.get('hg') ? HG.decodeLink(p.get('hg')) : null;
  }

  function showSetup(error) {
    $('app').hidden = true; $('pair').hidden = false;
    $('pairError').hidden = !error;
    $('pairError').textContent = error || '';
  }

  $('setupForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target).entries());
    for (const k of Object.keys(f)) f[k] = f[k].trim();
    const base = { name: f.name, v: { id: f.vId, r: f.vR }, t: { id: f.tId, k: f.tK } };
    const wearer = { ...base, e: { id: f.eId, r: f.eR, w: f.eW }, p: { id: f.pId, r: f.pR, w: f.pW } };
    const guardian = { ...base, e: { id: f.eId, r: f.eR }, p: { id: f.pId, r: f.pR } };
    const url = location.origin + location.pathname;
    $('wearerLink').value = `${url}#hg=${HG.encodeLink(wearer)}`;
    $('guardianLink').value = `${url}#hg=${HG.encodeLink(guardian)}`;
    $('openWearer').href = $('wearerLink').value;
    $('openGuardian').href = $('guardianLink').value;
    $('links').hidden = false;
    $('links').scrollIntoView({ behavior: 'smooth' });
  });
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const t = $(b.dataset.copy);
    try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
    toast('Copied.');
  }));
  for (const id of ['openWearer', 'openGuardian']) {
    $(id).addEventListener('click', () => setTimeout(() => location.reload(), 50));
  }

  async function connect(cfg) {
    S.cfg = cfg;
    S.role = cfg.e.w ? 'wearer' : 'guardian';
    try {
      await feeds(cfg.v, { results: 1 });          // checks the read key
      store.set(STORE, cfg);
      start();
    } catch (e) {
      S.cfg = null;
      showSetup(e.status === 401 || e.status === 400 || e.status === 404
        ? 'The link has a wrong channel ID or read key. Make the links again.'
        : 'Could not reach ThingSpeak. Check your internet connection.');
    }
  }

  $('signOut').addEventListener('click', () => {
    store.del(STORE);
    if (S.watchId !== undefined) navigator.geolocation.clearWatch(S.watchId);
    location.href = location.pathname;
  });

  // ---------------- main loop ----------------
  function start() {
    $('pair').hidden = true; $('app').hidden = false;
    document.body.dataset.role = S.role;
    $('bandName').textContent = S.cfg.name || 'Band';
    $('roleTag').textContent = S.role === 'wearer' ? 'Wearer' : 'Guardian';
    $('wearerActions').hidden = S.role !== 'wearer';
    $('guardianActions').hidden = S.role !== 'guardian';
    $('settingsForm').hidden = S.role !== 'wearer';
    $('gThresholds').hidden = S.role !== 'guardian';
    updateNotifButton();
    refresh(true);
    S.timer = setInterval(() => refresh(false), POLL_MS);
    if (S.role === 'wearer') startLocation();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.cfg) refresh(false); });

  async function refresh(first) {
    if (document.hidden && !first) return;
    try {
      const [v, ev, ph] = await Promise.all([
        feeds(S.cfg.v, { results: 1, status: true }),
        feeds(S.cfg.e, { results: 60, status: true, location: true }),
        tsGet(`/channels/${S.cfg.p.id}/feeds/last.json`, { api_key: S.cfg.p.r, location: true }).catch(() => null),
      ]);
      S.latest = v.feeds && v.feeds.length ? HG.reading(v.feeds[v.feeds.length - 1]) : null;
      S.events = (ev.feeds || []).map(HG.event).sort((a, b) => b.ts - a.ts);
      S.settings = HG.settingsFrom(S.events);
      S.phone = ph && ph.latitude ? { lat: Number(ph.latitude), lon: Number(ph.longitude), acc: Number(ph.field1), ts: HG.tsOf(ph.created_at) } : null;
      notifyNew(first);
      render();
      if (first) fillSettings();
    } catch {
      $('conn').className = 'conn off';
      $('connText').textContent = 'ThingSpeak unreachable';
    }
    refreshHistory(first);
    refreshWeek(first);
  }

  // ---------------- risk + vitals ----------------
  const LEVEL = ['Green', 'Amber', 'Red'];
  const ESC = { 1: 'skin temperature high', 2: 'skin rose 1 °C in 15 min', 4: 'resting heart rate high', 8: 'SpO2 low' };
  const WHY = { 1: 'SOS pressed', 2: 'risk has been red for 15 min', 4: 'skin temperature at emergency level' };
  const bitsText = (map, v) => Object.keys(map).filter((b) => v & b).map((b) => map[b]);

  function say(lv) {
    const n = S.cfg.name || 'The wearer';
    if (S.role === 'wearer') return ['All good', 'Drink water', 'Get into shade now'][lv];
    return [`${n} is fine`, `${n} should drink water`, `${n} needs shade now`][lv];
  }

  function render() {
    const L = S.latest || {};
    const t = nowS();
    const online = HG.isOnline(L.ts, t);
    $('conn').className = `conn ${online ? 'on' : 'off'}`;
    $('connText').textContent = online ? 'Band online' : L.ts ? `Last seen ${ago(t - L.ts)}` : 'No data yet';

    const lv = L.lv;
    $('risk').className = `risk lv-${lv ?? 'none'}${online ? '' : ' stale'}`;
    if (lv === undefined) {
      $('riskLevel').textContent = 'Waiting for the band';
      $('riskSay').textContent = 'No reading yet';
      $('hiNum').textContent = '--';
    } else {
      $('riskLevel').textContent = `${online ? '' : 'Last known: '}${LEVEL[lv]} risk`;
      $('riskSay').textContent = say(lv);
      $('hiNum').textContent = fmt(L.hi, 1);
    }
    const raised = L.esc ? bitsText(ESC, L.esc) : [];
    $('riskWhy').textContent = raised.length ? `Raised one level: ${raised.join(', ')}.` : '';
    $('riskAir').textContent = L.ta !== undefined ? `Air ${fmt(L.ta)} °C, humidity ${fmt(L.rh, 0)} %. Measured ${ago(t - L.ts)}.` : '';

    const s = S.settings;
    $('vSkin').textContent = fmt(L.sk);
    $('vSkin').classList.toggle('warn', L.sk >= s.sk);
    $('vSkinNote').textContent = L.dsk !== undefined ? `${L.dsk >= 0 ? '+' : ''}${fmt(L.dsk)} °C in 15 min` : 'surface, not core';
    $('vHr').textContent = fmt(L.hr, 0);
    $('vHr').classList.toggle('warn', L.hr > s.hr);
    $('vSp').textContent = fmt(L.sp, 0);
    $('vSp').classList.toggle('warn', L.sp !== undefined && L.sp < s.sp);
    const vAge = L.va !== undefined ? L.va + (t - L.ts) : null;
    const vNote = L.hr === undefined ? 'no finger contact' : `read ${ago(vAge)}`;
    $('vHrNote').textContent = vNote;
    $('vSpNote').textContent = L.sp === undefined && L.hr !== undefined ? 'not measured' : vNote;

    // emergency + silence
    const em = HG.emergencyState(S.events, t);
    const silenced = em.silencedUntil > t && !em.active;   // a newer SOS/emergency overrides "I'm OK"
    const silText = silenced ? `Repeat alerts are off until ${clock(em.silencedUntil)}.` : '';
    $('silenceNote').hidden = !silenced; $('silenceNote').textContent = silText;
    $('gSilenceNote').hidden = !silenced;
    $('gSilenceNote').textContent = silenced ? `${S.cfg.name} said they're OK. ${silText}` : '';

    $('emergency').hidden = !em.active;
    if (em.active) {
      const why = bitsText(WHY, em.why).join(', ') || 'emergency';
      $('emTitle').textContent = S.role === 'wearer' ? 'Your guardians have been alerted' : `Check on ${S.cfg.name} now`;
      $('emText').textContent = S.role === 'wearer'
        ? `Reason: ${why}. Press "I'm OK" if you are safe.`
        : `Reason: ${why}. Since ${clock(em.since)}.`;
      const acks = new Set(store.get(ACKS) || []);
      $('emAck').hidden = S.role !== 'guardian' || acks.has(em.last.id);
      $('emAck').dataset.id = em.last.id;
    }
    const loc = em.active && em.loc ? { lat: em.loc.lat, lon: em.loc.lon, ts: em.loc.ts } : S.phone;
    const fresh = loc && t - loc.ts < 3600;
    const map = fresh ? `https://maps.google.com/?q=${loc.lat},${loc.lon}` : null;
    $('emMap').hidden = !(map && S.role === 'guardian');
    $('gMap').hidden = !(map && S.role === 'guardian');
    if (map) {
      $('emMap').href = map; $('gMap').href = map;
      $('gMap').textContent = `Wearer's phone on the map (${ago(t - loc.ts)})`;
    }

    renderEvents();
    renderExposure();
    if (S.role === 'guardian') {
      $('gThresholds').textContent = `Thresholds on the band: heat index amber at ${s.hiA} °C, red above ${s.hiR} °C; skin warning ${s.sk} °C, emergency ${s.skE} °C; heart rate above ${s.hr} bpm; SpO2 below ${s.sp} %.`;
    }
    $('setSource').textContent = s.known
      ? `These are the values the band reported at ${clock(s.at)}.`
      : 'The band has not reported its settings yet, so these are the defaults.';
  }

  // ---------------- history, exposure ----------------
  async function refreshHistory(force) {
    if (!force && Date.now() - S.lastHist < 60000) return;
    S.lastHist = Date.now();
    const t = nowS();
    const from = Math.min(HG.dayStart(t, S.settings.tz), t - S.hours * 3600);
    try {
      const d = await feeds(S.cfg.v, { start: utc(from), timezone: 'Etc/UTC', results: 8000 });
      S.readings = (d.feeds || []).map(HG.reading).filter((r) => r.ts >= from).sort((a, b) => a.ts - b.ts);
    } catch { /* keep old */ }
    $('csvBtn').href = `${API}/channels/${S.cfg.v.id}/feeds.csv?${new URLSearchParams({ api_key: S.cfg.v.r, start: utc(t - S.hours * 3600), timezone: 'Etc/UTC', results: 8000 })}`;
    drawChart();
    renderExposure();
  }

  async function refreshWeek(force) {
    if (!force && Date.now() - S.lastWeek < 600000) return;
    S.lastWeek = Date.now();
    const tz = S.settings.tz;
    const today = HG.dayStart(nowS(), tz);
    for (let i = 1; i <= 6; i++) {
      const d0 = today - i * 86400;
      if (S.week[d0]) continue;                       // past days do not change
      try {
        const d = await tsGet(`/channels/${S.cfg.v.id}/fields/5.json`, {
          api_key: S.cfg.v.r, start: utc(d0), end: utc(d0 + 86399), timezone: 'Etc/UTC', results: 8000 });
        S.week[d0] = HG.exposure((d.feeds || []).map((f) => ({ lv: Number(f.field5) })));
      } catch { /* try again later */ }
    }
    renderExposure();
  }

  function renderExposure() {
    if (!S.cfg) return;
    const tz = S.settings.tz;
    const today = HG.dayStart(nowS(), tz);
    const t = HG.exposure(S.readings.filter((r) => r.ts >= today));
    const total = t.green + t.amber + t.red;
    $('expBar').innerHTML = total ? ['green', 'amber', 'red'].map((k) =>
      `<span style="width:${(t[k] / total) * 100}%;background:var(--${k})"></span>`).join('') : '';
    $('expBar').setAttribute('aria-label', `${t.amber} minutes amber, ${t.red} minutes red today`);
    $('expLegend').innerHTML = total
      ? `<b>${esc(mins(t.amber))}</b> amber, <b>${esc(mins(t.red))}</b> red, ${esc(mins(t.green))} green.`
      : 'No readings yet today.';
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d0 = today - i * 86400;
      days.push({ d0, ...(i === 0 ? t : S.week[d0] || { green: 0, amber: 0, red: 0 }) });
    }
    const max = Math.max(60, ...days.map((d) => d.green + d.amber + d.red));
    $('week').innerHTML = days.map((d) => {
      const name = new Date((d.d0 + tz * 60 + 43200) * 1000).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
      const seg = (k) => `<i style="height:${(d[k] / max) * 100}%;background:var(--${k})"></i>`;
      return `<div class="day" title="${esc(`${d.amber} min amber, ${d.red} min red`)}"><div class="stack">${seg('green')}${seg('amber')}${seg('red')}</div>${esc(name)}</div>`;
    }).join('');
  }

  const SERIES = {
    hi: { name: 'Heat index', unit: '°C', d: 1, lines: (s) => [[s.hiA, 'var(--amber)'], [s.hiR, 'var(--red)']] },
    sk: { name: 'Skin', unit: '°C', d: 1, lines: (s) => [[s.sk, 'var(--amber)'], [s.skE, 'var(--red)']] },
    hr: { name: 'Heart rate', unit: 'bpm', d: 0, lines: (s) => [[s.hr, 'var(--red)']] },
    sp: { name: 'SpO2', unit: '%', d: 0, lines: (s) => [[s.sp, 'var(--red)']] },
  };
  document.querySelectorAll('[data-hours]').forEach((b) => b.addEventListener('click', () => {
    S.hours = Number(b.dataset.hours);
    document.querySelectorAll('[data-hours]').forEach((x) => x.setAttribute('aria-selected', x === b));
    refreshHistory(true);
  }));
  document.querySelectorAll('[data-series]').forEach((b) => b.addEventListener('click', () => {
    S.series = b.dataset.series;
    document.querySelectorAll('[data-series]').forEach((x) => x.setAttribute('aria-selected', x === b));
    drawChart();
  }));

  function drawChart() {
    const box = $('chart');
    const cfg = SERIES[S.series];
    const t1 = nowS(), t0 = t1 - S.hours * 3600;
    const all = HG.downsample(S.readings.filter((r) => r.ts >= t0), 400);
    const pts = all.filter((p) => p[S.series] !== undefined);
    if (pts.length < 2) {
      box.innerHTML = `<p class="empty">No ${esc(cfg.name.toLowerCase())} readings in the last ${S.hours} hours.</p>`;
      return;
    }
    const W = 600, H = 230, L = 38, R = 12, T = 12, B = 42, STRIP = 8;
    const thr = cfg.lines(S.settings).map(([v]) => v);
    const vals = pts.map((p) => p[S.series]);
    let lo = Math.min(...vals, ...thr), hi = Math.max(...vals, ...thr);
    const pad = (hi - lo) * 0.12 || 1;
    lo -= pad; hi += pad;
    const x = (ts) => L + ((ts - t0) / (t1 - t0)) * (W - L - R);
    const plotB = H - B - STRIP - 4;
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (plotB - T);
    let g = '';
    const step = niceStep((hi - lo) / 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E3EAE8"/>`;
      g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, step < 1 ? 1 : 0)}</text>`;
    }
    for (const [v, c] of cfg.lines(S.settings)) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-dasharray="5 4" stroke-width="1.5"/>`;
    }
    const every = S.hours <= 6 ? 3600 : 4 * 3600;
    for (let tt = Math.ceil(t0 / every) * every; tt <= t1; tt += every) {
      g += `<text x="${x(tt)}" y="${H - 8}" text-anchor="middle">${esc(new Date(tt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</text>`;
    }
    for (let i = 0; i < all.length; i++) {
      const a = all[i], b = all[i + 1];
      const end = b && b.ts - a.ts <= 600 ? b.ts : a.ts + 60;
      const col = ['var(--green)', 'var(--amber)', 'var(--red)'][a.lv] || '#ccc';
      g += `<rect x="${x(a.ts)}" y="${plotB + 6}" width="${Math.max(1, x(end) - x(a.ts))}" height="${STRIP}" fill="${col}"/>`;
    }
    let d = '';
    pts.forEach((p, i) => {
      const gap = i === 0 || p.ts - pts[i - 1].ts > 300;
      d += `${gap ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p[S.series]).toFixed(1)}`;
    });
    g += `<path d="${d}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>`;
    const last = pts[pts.length - 1];
    g += `<circle cx="${x(last.ts)}" cy="${y(last[S.series])}" r="4" fill="var(--ink)"/>`;
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.name)} over the last ${S.hours} hours, latest ${fmt(last[S.series], cfg.d)} ${cfg.unit}">${g}</svg>`;
  }
  function niceStep(raw) {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  // ---------------- alerts ----------------
  const KIND = {
    sos: (e) => (e.source === 'app' ? 'SOS from the phone' : 'SOS from the band'),
    red: () => 'Heat risk turned red',
    emerg: () => 'Emergency alert',
    drink: () => 'Drink-water reminder',
    ok: (e) => (e.source === 'app' ? 'Marked OK in the app' : 'Marked OK on the band'),
    hello: () => 'Band connected',
  };
  function detail(e) {
    const parts = [];
    if (e.kind === 'emerg') parts.push(`Reason: ${bitsText(WHY, e.why).join(', ')}.`);
    if (e.kind === 'red' && e.why) parts.push(`Raised by ${bitsText(ESC, e.why).join(', ')}.`);
    if (e.kind === 'hello') { const q = HG.parseKv(e.text).q; if (q) parts.push(`Sending ${q} saved readings.`); }
    const s = e.snap;
    if (['sos', 'emerg', 'red'].includes(e.kind) && s.hi !== undefined) {
      parts.push(`Heat index ${fmt(s.hi)} °C, skin ${fmt(s.sk)} °C, HR ${fmt(s.hr, 0)}, SpO2 ${fmt(s.sp, 0)} %.`);
    }
    return esc(parts.join(' '));
  }

  function renderEvents() {
    const ul = $('events');
    const list = S.events.filter((e) => (S.role === 'guardian' ? !['drink', 'hello'].includes(e.kind) : e.kind !== 'hello'));
    const more = $('moreEvents');
    if (!list.length) { ul.innerHTML = '<li><span class="empty">No alerts yet.</span></li>'; more.hidden = true; return; }
    const shown = S.allEvents ? list : list.slice(0, 6);
    more.hidden = list.length <= 6;
    more.textContent = S.allEvents ? 'Show fewer' : `Show all ${list.length} alerts`;
    const acks = new Set(store.get(ACKS) || []);
    ul.innerHTML = shown.map((e) => {
      const map = e.lat !== undefined ? ` <a href="https://maps.google.com/?q=${e.lat},${e.lon}" target="_blank" rel="noopener">Location</a>` : '';
      const canAck = S.role === 'guardian' && ['sos', 'emerg', 'red'].includes(e.kind);
      const ack = !canAck ? '' : acks.has(e.id) ? '<span class="ackd">Seen</span>'
        : `<button class="btn small" data-ack="${esc(e.id)}">Mark seen</button>`;
      return `<li class="k-${esc(e.kind)}"><span class="mark"></span>
        <span class="what">${esc((KIND[e.kind] || (() => e.text))(e))}</span>
        <time>${esc(clock(e.ts))}</time>
        <span class="detail">${detail(e)}${map} ${ack}</span></li>`;
    }).join('');
  }
  $('moreEvents').addEventListener('click', () => { S.allEvents = !S.allEvents; renderEvents(); });

  async function ackEvent(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await talkback('ACK');
      const acks = store.get(ACKS) || [];
      acks.push(Number(id));
      store.set(ACKS, acks.slice(-200));
      toast('Marked as seen. The band beeps within 20 s so the wearer knows.');
      render();
    } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
  }
  $('events').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ack]');
    if (b) ackEvent(b.dataset.ack, b);
  });
  $('emAck').addEventListener('click', (ev) => ackEvent(ev.currentTarget.dataset.id, ev.currentTarget));

  // ---------------- notifications on this phone ----------------
  function notifyNew(first) {
    const fresh = S.events.filter((e) => !S.seen.has(e.id));
    S.events.forEach((e) => S.seen.add(e.id));
    if (first) return;
    fresh.filter((e) => nowS() - e.ts < 900).forEach(notifyEvent);
  }

  async function notifyEvent(e) {
    const n = S.cfg.name;
    const forWearer = { drink: 'Drink some water now.', red: 'Heat risk is red. Get into shade now.', emerg: 'Your guardians were alerted.' };
    const forGuardian = { sos: `${n} pressed SOS.`, emerg: `Check on ${n} now.`, red: `${n}'s heat risk is red.`, ok: `${n} says they're OK.` };
    const body = (S.role === 'wearer' ? forWearer : forGuardian)[e.kind];
    if (!body) return;
    if (e.kind === 'drink' && HG.inQuietHours(S.settings, nowS())) return;
    toast(body, 6000);
    if (navigator.vibrate) navigator.vibrate(e.kind === 'drink' ? [150, 100, 150] : [400, 150, 400, 150, 400]);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body, tag: String(e.id), icon: 'icons/icon-192.png', requireInteraction: e.kind !== 'drink' };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification('HeatGuard', opts); else new Notification('HeatGuard', opts);
    } catch { /* the toast was shown */ }
  }

  function updateNotifButton() {
    const b = $('notifBtn');
    b.hidden = !('Notification' in window) || Notification.permission === 'granted';
    b.onclick = async () => {
      const p = await Notification.requestPermission();
      toast(p === 'granted' ? 'Notifications are on while this app is open.' : 'Notifications are blocked in your browser settings.');
      updateNotifButton();
    };
  }

  // ---------------- wearer: location, SOS, commands ----------------
  function startLocation() {
    const note = $('locNote');
    if (!('geolocation' in navigator)) { note.textContent = 'This phone cannot share its location. SOS will be sent without it.'; return; }
    note.textContent = 'Asking for location so alerts can include where you are.';
    S.watchId = navigator.geolocation.watchPosition((p) => {
      S.loc = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      note.textContent = "Alerts include this phone's location while the app is open.";
      if (Date.now() - S.locSentAt > LOC_EVERY_MS) {
        S.locSentAt = Date.now();
        tsPost('/update.json', { api_key: S.cfg.p.w, field1: Math.round(S.loc.acc), lat: S.loc.lat.toFixed(6), long: S.loc.lon.toFixed(6) })
          .then((r) => { if (!r.text.trim().startsWith('{')) S.locSentAt = 0; })
          .catch(() => { S.locSentAt = 0; });
      }
    }, () => {
      note.textContent = 'Location is off. SOS will be sent without it. Allow location for this site to fix this.';
    }, { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 });
  }

  function currentPosition() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(S.loc);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        () => resolve(S.loc), { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
    });
  }

  const sos = $('sosBtn');
  let holdTimer = null;
  function holdStart(ev) {
    if (ev.type === 'keydown' && (ev.repeat || !['Enter', ' '].includes(ev.key))) return;
    ev.preventDefault();
    if (holdTimer || sos.classList.contains('sent')) return;
    sos.classList.add('holding');
    if (navigator.vibrate) navigator.vibrate(30);
    holdTimer = setTimeout(sendSos, 2000);
  }
  function holdEnd() { clearTimeout(holdTimer); holdTimer = null; sos.classList.remove('holding'); }
  async function sendSos() {
    holdTimer = null;
    sos.classList.remove('holding');
    sos.classList.add('sent');
    sos.querySelector('.sos-text').textContent = 'Sent';
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    $('sosHelp').textContent = 'Sending SOS…';
    const loc = await currentPosition();
    const L = S.latest || {};
    const p = { field1: 1, field2: 1, field7: L.lv ?? 0, field8: 1, status: 'SOS from the phone' };
    if (L.hi !== undefined) p.field3 = L.hi;
    if (L.sk !== undefined) p.field4 = L.sk;
    if (L.hr !== undefined) p.field5 = L.hr;
    if (L.sp !== undefined) p.field6 = L.sp;
    if (loc) { p.lat = loc.lat.toFixed(6); p.long = loc.lon.toFixed(6); }
    let ok = false;
    try { ok = await writeEvent(p); } catch { ok = false; }
    talkback('FIND').catch(() => {});
    const msg = ok
      ? `SOS sent at ${clock(nowS())}${loc ? ' with your location' : ''}. Your guardian's app shows it now; the e-mail follows.`
      : 'SOS was NOT sent: no connection to ThingSpeak. Call 112 or your guardian directly.';
    toast(msg, 8000);
    $('sosHelp').textContent = msg;
    refresh(false);
    setTimeout(() => {
      sos.classList.remove('sent');
      sos.querySelector('.sos-text').textContent = 'SOS';
      $('sosHelp').textContent = 'Hold for 2 seconds. Sends your location to your guardians.';
    }, 120000);
  }
  sos.addEventListener('pointerdown', holdStart);
  sos.addEventListener('keydown', holdStart);
  ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur'].forEach((t) => sos.addEventListener(t, holdEnd));
  sos.addEventListener('contextmenu', (e) => e.preventDefault());

  async function command(cmd, okMsg, btn) {
    btn.disabled = true;
    try { await talkback(cmd); toast(okMsg, 6000); } catch (e) { toast(`Not sent: ${e.message}`); }
    btn.disabled = false;
  }
  $('okBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await talkback('OK');
      toast('Marked OK. Repeat alerts stop for 30 minutes.', 6000);
      writeEvent({ field1: 5, field2: 1, field8: 1, status: "I'm OK (from the app)" }).then(() => refresh(false));
    } catch (err) { toast(`Not sent: ${err.message}`); }
    btn.disabled = false;
  });
  $('readBtn').addEventListener('click', (e) => command('VITALS', 'The band starts a 20 s reading within 20 s. Keep still with your finger on the sensor.', e.currentTarget));
  $('gReadBtn').addEventListener('click', (e) => command('VITALS', 'Asked the band for a new reading. It shows up in about a minute.', e.currentTarget));
  $('findBtn').addEventListener('click', (e) => command('FIND', 'The band beeps within 20 s.', e.currentTarget));

  // ---------------- settings ----------------
  const hhmm = (h) => (h < 0 ? '' : `${String(h).padStart(2, '0')}:00`);
  function fillSettings() {
    if (S.role !== 'wearer') return;
    const s = S.settings, f = $('settingsForm');
    for (const k of ['hiA', 'hiR', 'sk', 'skE', 'hr', 'sp']) f[k].value = s[k];
    f.quietOn.checked = s.qs >= 0 && s.qe >= 0;
    f.qs.value = hhmm(s.qs >= 0 ? s.qs : 22);
    f.qe.value = hhmm(s.qe >= 0 ? s.qe : 7);
    $('quietRow').hidden = !f.quietOn.checked;
  }
  $('settingsForm').quietOn.addEventListener('change', (e) => { $('quietRow').hidden = !e.target.checked; });
  $('settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const s = {};
    for (const k of ['hiA', 'hiR', 'sk', 'skE', 'hr', 'sp']) s[k] = Number(f[k].value);
    s.qs = f.quietOn.checked ? Number(f.qs.value.slice(0, 2)) : -1;
    s.qe = f.quietOn.checked ? Number(f.qe.value.slice(0, 2)) : -1;
    s.tz = -new Date().getTimezoneOffset();
    const msg = $('setMsg');
    const bad = HG.validateSettings(s);
    if (bad) { msg.textContent = `Not sent: ${bad}.`; return; }
    $('saveSettings').disabled = true;
    try {
      await talkback(HG.cfgCommand(s));
      msg.textContent = 'Sent. The band applies them within about 20 s when it is online, beeps once, and this page then shows the new values.';
    } catch (e) { msg.textContent = `Not sent: ${e.message}.`; }
    $('saveSettings').disabled = false;
  });

  // opening another link in the same tab: start over with it
  window.addEventListener('hashchange', () => { if (location.hash.includes('hg=')) location.reload(); });

  // ---------------- boot ----------------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const hadHash = location.hash.includes('hg=');
  const fromHash = readHash();
  if (fromHash) connect(fromHash);
  else if (hadHash) showSetup('That link is incomplete. Copy the whole link, or make the links again below.');
  else if (store.get(STORE)) connect(store.get(STORE));
  else showSetup('');
})();
