// HeatGuard: turning ThingSpeak entries into what the app shows.
// No DOM here, so it runs in the browser and in Node tests (tests/logic.test.js).
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({ hiA: 32, hiR: 41, sk: 37.5, skE: 38.5, hr: 100, sp: 94, qs: -1, qe: -1, tz: 330 });
  const KIND = { 1: 'sos', 2: 'red', 3: 'emerg', 4: 'drink', 5: 'ok', 6: 'hello' };
  const ONLINE_S = 180;            // band writes every 60 s
  const OK_SILENCE_S = 1800;       // "I'm OK" silences repeats for 30 min
  const EMERG_STALE_S = 30 * 60;   // an SOS/emergency with no repeat for 30 min is shown as over

  const num = (v) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const tsOf = (createdAt) => Math.floor(Date.parse(createdAt) / 1000);

  // "esc=4 va=35 q=0" -> { esc: 4, va: 35, q: 0 }
  function parseKv(text) {
    const out = {};
    String(text || '').split(/\s+/).forEach((tok) => {
      const i = tok.indexOf('=');
      if (i > 0) {
        const v = tok.slice(i + 1);
        out[tok.slice(0, i)] = num(v) !== undefined ? num(v) : v;
      }
    });
    return out;
  }

  // vitals channel entry -> reading
  function reading(e) {
    const st = parseKv(e.status);
    return {
      ts: tsOf(e.created_at), id: e.entry_id,
      hi: num(e.field1), sk: num(e.field2), hr: num(e.field3), sp: num(e.field4), lv: num(e.field5),
      ta: num(e.field6), rh: num(e.field7), dsk: num(e.field8),
      esc: st.esc || 0, va: st.va, q: st.q, sil: st.sil, rssi: st.rssi,
    };
  }

  // events channel entry -> event
  function event(e) {
    const kind = KIND[num(e.field1)] || 'other';
    return {
      id: e.entry_id, ts: tsOf(e.created_at), kind, why: num(e.field2) || 0,
      snap: { hi: num(e.field3), sk: num(e.field4), hr: num(e.field5), sp: num(e.field6), lv: num(e.field7) },
      source: num(e.field8) === 1 ? 'app' : 'band',
      lat: num(e.latitude), lon: num(e.longitude),
      text: e.status || '',
    };
  }

  // latest "hello" event -> the band's settings
  function settingsFrom(events) {
    const hello = events.filter((e) => e.kind === 'hello').sort((a, b) => b.ts - a.ts)[0];
    if (!hello) return { ...DEFAULTS, known: false };
    const kv = parseKv(hello.text);
    const s = { ...DEFAULTS, known: true, at: hello.ts, fw: kv.fw };
    for (const k of Object.keys(DEFAULTS)) if (typeof kv[k] === 'number') s[k] = kv[k];
    return s;
  }

  function cfgCommand(s) {
    return `CFG hiA=${s.hiA} hiR=${s.hiR} sk=${s.sk} skE=${s.skE} hr=${s.hr} sp=${s.sp} qs=${s.qs} qe=${s.qe} tz=${s.tz}`;
  }

  function validateSettings(s) {
    const lim = { hiA: [20, 50], hiR: [25, 60], sk: [35, 40], skE: [36, 42], hr: [60, 180], sp: [80, 99], qs: [-1, 23], qe: [-1, 23], tz: [-720, 840] };
    const names = { hiA: 'Heat index amber', hiR: 'Heat index red', sk: 'Skin warning', skE: 'Skin emergency', hr: 'Heart rate', sp: 'SpO2', qs: 'Quiet hours start', qe: 'Quiet hours end', tz: 'Time zone' };
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      const v = s[k];
      if (!Number.isFinite(v) || v < lo || v > hi) return `${names[k]} must be between ${lo} and ${hi}`;
    }
    if (s.hiR <= s.hiA) return 'Heat index red must be above amber';
    if (s.skE <= s.sk) return 'Skin emergency must be above the skin warning';
    return null;
  }

  // emergency banner + "I'm OK" silence, from the event log
  function emergencyState(events, nowS) {
    const sorted = [...events].sort((a, b) => b.ts - a.ts);
    const lastOk = sorted.find((e) => e.kind === 'ok');
    const silencedUntil = lastOk ? lastOk.ts + OK_SILENCE_S : 0;
    const okTs = lastOk ? lastOk.ts : 0;
    const open = sorted.filter((e) => (e.kind === 'sos' || e.kind === 'emerg') && e.ts > okTs);
    if (!open.length || nowS - open[0].ts > EMERG_STALE_S) return { active: false, silencedUntil };
    const why = open.reduce((w, e) => w | (e.kind === 'sos' ? 1 : e.why), 0);
    const loc = open.find((e) => e.lat !== undefined);
    return { active: true, why, since: open[open.length - 1].ts, last: open[0], loc, silencedUntil };
  }

  // minutes at each level: one vitals entry = one minute
  function exposure(readings) {
    const out = { green: 0, amber: 0, red: 0 };
    for (const r of readings) {
      if (r.lv === 0) out.green++;
      else if (r.lv === 1) out.amber++;
      else if (r.lv === 2) out.red++;
    }
    return out;
  }

  // start of the local day (tz minutes from UTC) containing ts, as epoch seconds
  function dayStart(ts, tzMin) {
    const local = ts + tzMin * 60;
    return local - (local % 86400) - tzMin * 60;
  }

  function isOnline(lastTs, nowS) {
    return lastTs !== undefined && nowS - lastTs <= ONLINE_S;
  }

  function inQuietHours(s, nowS) {
    if (s.qs < 0 || s.qe < 0 || s.qs === s.qe) return false;
    const h = Math.floor(((nowS + s.tz * 60) % 86400) / 3600);
    return s.qs < s.qe ? h >= s.qs && h < s.qe : h >= s.qs || h < s.qe;
  }

  // keep long histories light for the chart: max N points, worst value per bucket
  function downsample(rows, max) {
    if (rows.length <= max) return rows;
    const size = Math.ceil(rows.length / max);
    const out = [];
    for (let i = 0; i < rows.length; i += size) {
      const b = rows.slice(i, i + size);
      const pick = (k, f) => {
        const v = b.map((r) => r[k]).filter((x) => x !== undefined);
        return v.length ? f(...v) : undefined;
      };
      out.push({ ts: b[b.length - 1].ts, lv: pick('lv', Math.max), hi: pick('hi', Math.max),
        sk: pick('sk', Math.max), hr: pick('hr', Math.max), sp: pick('sp', Math.min) });
    }
    return out;
  }

  // the link: everything the app needs, packed into the URL after #
  function encodeLink(cfg) {
    const json = JSON.stringify(cfg);
    const b64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, 'utf8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeLink(s) {
    try {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      const json = typeof atob === 'function'
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, 'base64').toString('utf8');
      const c = JSON.parse(json);
      return c && c.v && c.e ? c : null;
    } catch { return null; }
  }

  const api = {
    DEFAULTS, ONLINE_S, OK_SILENCE_S, parseKv, reading, event, settingsFrom, cfgCommand, validateSettings,
    emergencyState, exposure, dayStart, isOnline, inQuietHours, downsample, encodeLink, decodeLink, tsOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HG = api;
})(typeof self !== 'undefined' ? self : this);
