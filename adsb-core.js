/* Moteur ADS-B / Mode S — sans dépendance.
 *  - lecture d'échantillons IQ (int16 LE/BE, uint8, int8, float32, WAV) → module
 *  - démodulation PPM 1090 MHz à n'importe quelle fréquence d'échantillonnage ≥ 2 MS/s
 *    (intégration fractionnaire par sommes cumulées, recherche de phase sous-échantillon)
 *  - CRC-24 Mode S, correction d'une erreur (DF17/18), validation AP (DF0/4/5/16/20/21)
 *  - décodage DF0/4/5/11/16/17/18/20/21 (identification, position CPR, vitesse, squawk…)
 *  - suivi des aéronefs (décodage CPR global/local, trajectoires)
 *  - générateur de signal synthétique (démo et tests)
 * Utilisable dans la page, dans un Web Worker (source via factorySource) et sous Node.
 */
(function (root, factory) {
  const lib = factory();
  lib.factorySource = factory.toString();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.ADSB = lib;
})(typeof self !== 'undefined' ? self : this, function ADSBFactory() {
  'use strict';

  // ------------------------------------------------------------------ utilitaires
  const mod = (a, b) => ((a % b) + b) % b;
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const fromHex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

  function bits(b, start, len) { // start : numéro de bit 1-based (convention ICAO)
    let v = 0;
    for (let i = 0; i < len; i++) { const p = start - 1 + i; v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1); }
    return v;
  }
  function setBits(b, start, len, val) {
    for (let i = 0; i < len; i++) {
      const p = start - 1 + i;
      if (Math.floor(val / 2 ** (len - 1 - i)) % 2) b[p >> 3] |= 0x80 >> (p & 7);
      else b[p >> 3] &= ~(0x80 >> (p & 7));
    }
  }

  // ------------------------------------------------------------------ CRC-24
  const POLY = 0xFFF409;
  const CRC_T = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 16;
    for (let k = 0; k < 8; k++) c = (c & 0x800000) ? ((c << 1) ^ POLY) : (c << 1);
    CRC_T[i] = c & 0xFFFFFF;
  }
  function crc24(b, n) {
    let c = 0;
    for (let i = 0; i < n; i++) c = ((c << 8) ^ CRC_T[((c >>> 16) ^ b[i]) & 0xFF]) & 0xFFFFFF;
    return c;
  }
  function residual(b, nbytes) {
    return (crc24(b, nbytes - 3) ^ ((b[nbytes - 3] << 16) | (b[nbytes - 2] << 8) | b[nbytes - 1])) >>> 0;
  }
  // syndromes d'une erreur simple sur 112 bits (on ne corrige pas le champ DF)
  const SYN112 = new Map();
  { const z = new Uint8Array(14);
    for (let i = 5; i < 112; i++) { z.fill(0); z[i >> 3] = 0x80 >> (i & 7); SYN112.set(residual(z, 14), i); } }

  // ------------------------------------------------------------------ altitude / squawk
  const ID13_MAP = [[0x1000, 0x0010], [0x0800, 0x1000], [0x0400, 0x0020], [0x0200, 0x2000], [0x0100, 0x0040],
    [0x0080, 0x4000], [0x0020, 0x0100], [0x0010, 0x0001], [0x0008, 0x0200], [0x0004, 0x0002], [0x0002, 0x0400], [0x0001, 0x0004]];
  function id13ToGillham(id) { let h = 0; for (const [a, g] of ID13_MAP) if (id & a) h |= g; return h; }
  function gillhamToId13(h) { let id = 0; for (const [a, g] of ID13_MAP) if (h & g) id |= a; return id; }
  function squawkFromId13(id) {
    const h = id13ToGillham(id);
    return `${(h >> 12) & 7}${(h >> 8) & 7}${(h >> 4) & 7}${h & 7}`;
  }
  function id13FromSquawk(sq) {
    const d = String(sq).padStart(4, '0').split('').map(Number);
    return gillhamToId13((d[0] << 12) | (d[1] << 8) | (d[2] << 4) | d[3]);
  }
  function modeAToModeC(a) { // centaines de pieds, ou null
    if ((a & 0xFFFF8889) !== 0 || (a & 0x000000F0) === 0) return null;
    let five = 0, one = 0;
    if (a & 0x0010) one ^= 0x007; if (a & 0x0020) one ^= 0x003; if (a & 0x0040) one ^= 0x001;
    if ((one & 5) === 5) one ^= 2;
    if (one > 5) return null;
    if (a & 0x0002) five ^= 0x0FF; if (a & 0x0004) five ^= 0x07F; if (a & 0x1000) five ^= 0x03F;
    if (a & 0x2000) five ^= 0x01F; if (a & 0x4000) five ^= 0x00F; if (a & 0x0100) five ^= 0x007;
    if (a & 0x0200) five ^= 0x003; if (a & 0x0400) five ^= 0x001;
    if (five & 1) one = 6 - one;
    return five * 5 + one - 13;
  }
  function decodeAC13(ac) { // pieds
    if (!ac) return null;
    if (ac & 0x40) return null; // altitude métrique (rarissime)
    if (ac & 0x10) return ((((ac & 0x1F80) >> 2) | ((ac & 0x20) >> 1) | (ac & 0xF)) * 25) - 1000;
    const c = modeAToModeC(id13ToGillham(ac));
    return c === null || c < -12 ? null : c * 100;
  }
  const decodeAC12 = (ac) => decodeAC13(((ac & 0xFC0) << 1) | (ac & 0x3F));
  function encodeAC12(ft) { const n = Math.round((ft + 1000) / 25); return ((n & 0x7F0) << 1) | 0x10 | (n & 0xF); }
  function encodeAC13(ft) { const n = Math.round((ft + 1000) / 25); return ((n & 0x7E0) << 2) | ((n & 0x10) << 1) | 0x10 | (n & 0xF); }

  // ------------------------------------------------------------------ CPR
  function NL(lat) {
    lat = Math.abs(lat);
    if (lat === 0) return 59;
    if (lat === 87) return 2;
    if (lat > 87) return 1;
    const a = 1 - Math.cos(Math.PI / 30), c = Math.cos(Math.PI / 180 * lat);
    return Math.floor(2 * Math.PI / Math.acos(1 - a / (c * c)));
  }
  function cprGlobal(even, odd, lastIsOdd) { // aéroporté
    const latE = even.lat / 131072, lonE = even.lon / 131072, latO = odd.lat / 131072, lonO = odd.lon / 131072;
    const j = Math.floor(59 * latE - 60 * latO + 0.5);
    let rE = 6 * (mod(j, 60) + latE), rO = (360 / 59) * (mod(j, 59) + latO);
    if (rE >= 270) rE -= 360; if (rO >= 270) rO -= 360;
    if (Math.abs(rE) > 90 || Math.abs(rO) > 90 || NL(rE) !== NL(rO)) return null;
    const lat = lastIsOdd ? rO : rE, nl = NL(lat), ni = Math.max(nl - (lastIsOdd ? 1 : 0), 1);
    const m = Math.floor(lonE * (nl - 1) - lonO * nl + 0.5);
    let lon = (360 / ni) * (mod(m, ni) + (lastIsOdd ? lonO : lonE));
    if (lon >= 180) lon -= 360;
    return { lat, lon };
  }
  function cprLocal(cpr, odd, ref, surface) {
    const base = surface ? 90 : 360, latC = cpr.lat / 131072, lonC = cpr.lon / 131072;
    const dLat = base / (odd ? 59 : 60);
    const j = Math.floor(ref.lat / dLat) + Math.floor(0.5 + mod(ref.lat, dLat) / dLat - latC);
    const lat = dLat * (j + latC);
    if (Math.abs(lat) > 90) return null;
    const dLon = base / Math.max(NL(lat) - (odd ? 1 : 0), 1);
    const m = Math.floor(ref.lon / dLon) + Math.floor(0.5 + mod(ref.lon, dLon) / dLon - lonC);
    let lon = dLon * (m + lonC);
    if (lon >= 180) lon -= 360; if (lon < -180) lon += 360;
    return { lat, lon };
  }
  function cprEncode(lat, lon, odd) {
    const dLat = 360 / (60 - odd);
    const yz = Math.floor(131072 * mod(lat, dLat) / dLat + 0.5);
    const rlat = dLat * (yz / 131072 + Math.floor(lat / dLat));
    const n = NL(rlat) - odd, dLon = n > 0 ? 360 / n : 360;
    const xz = Math.floor(131072 * mod(lon, dLon) / dLon + 0.5);
    return { lat: yz & 0x1FFFF, lon: xz & 0x1FFFF };
  }
  function distKm(a, b) {
    const R = 6371.0088, p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
    const dp = p2 - p1, dl = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
    return mod(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI, 360);
  }
  function destination(p, brgDeg, km) {
    const R = 6371.0088, d = km / R, b = brgDeg * Math.PI / 180, l1 = p.lat * Math.PI / 180, g1 = p.lon * Math.PI / 180;
    const l2 = Math.asin(Math.sin(l1) * Math.cos(d) + Math.cos(l1) * Math.sin(d) * Math.cos(b));
    const g2 = g1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(l1), Math.cos(d) - Math.sin(l1) * Math.sin(l2));
    return { lat: l2 * 180 / Math.PI, lon: mod(g2 * 180 / Math.PI + 540, 360) - 180 };
  }

  // ------------------------------------------------------------------ décodage des champs
  const CHARSET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######';
  const DF_NAMES = {
    0: 'ACAS courte', 4: 'Altitude', 5: 'Identité', 11: 'All-Call', 16: 'ACAS longue',
    17: 'ADS-B', 18: 'ADS-B (non transpondeur)', 20: 'Comm-B altitude', 21: 'Comm-B identité',
  };
  const CATEGORIES = {
    4: ['Non précisé', 'Léger', 'Petit', 'Gros porteur', 'Gros porteur (forte turbulence)', 'Lourd', 'Haute performance', 'Hélicoptère'],
    3: ['Non précisé', 'Planeur', 'Plus léger que l’air', 'Parachutiste', 'ULM', 'Réservé', 'Drone', 'Véhicule spatial'],
    2: ['Non précisé', 'Véhicule d’urgence', 'Réservé', 'Véhicule de service', 'Obstacle', 'Obstacle', 'Obstacle', 'Obstacle'],
    1: ['Réservé', 'Réservé', 'Réservé', 'Réservé', 'Réservé', 'Réservé', 'Réservé', 'Réservé'],
  };
  const EMERGENCY = ['', 'Urgence générale', 'Urgence médicale', 'Carburant minimum', 'Panne radio', 'Intervention illicite', 'Aéronef retardé', 'Réservé'];
  const FS_NAMES = ['En vol', 'Au sol', 'Alerte, en vol', 'Alerte, au sol', 'Alerte + SPI', 'SPI', 'Réservé', 'Non assigné'];

  function callsignAt(b, start) {
    let s = '';
    for (let i = 0; i < 8; i++) s += CHARSET[bits(b, start + 6 * i, 6)];
    return s.replace(/[# ]+$/g, '').replace(/#/g, '?').trim();
  }
  function surfaceSpeed(m) {
    if (m === 0 || m > 124) return null;
    if (m === 1) return 0;
    if (m <= 8) return 0.125 + (m - 2) * 0.125;
    if (m <= 12) return 1 + (m - 9) * 0.25;
    if (m <= 38) return 2 + (m - 13) * 0.5;
    if (m <= 93) return 15 + (m - 39);
    if (m <= 108) return 70 + (m - 94) * 2;
    if (m <= 123) return 100 + (m - 109) * 5;
    return 175;
  }

  function decodeME(b, f) { // b : message 112 bits, ME = bits 33..88
    const me = (k, n) => bits(b, 32 + k, n);
    const tc = me(1, 5), st = me(6, 3);
    f.tc = tc;
    if (tc >= 1 && tc <= 4) {
      f.kind = 'ident'; f.callsign = callsignAt(b, 41);
      f.category = (CATEGORIES[tc] || [])[st] || 'Non précisé';
      f.catCode = `${String.fromCharCode(69 - tc)}${st}`;
    } else if (tc >= 5 && tc <= 8) {
      f.kind = 'surface'; f.onGround = true;
      f.gs = surfaceSpeed(me(6, 7));
      if (me(13, 1)) f.track = me(14, 7) * 360 / 128;
      f.cpr = { odd: me(22, 1), lat: me(23, 17), lon: me(40, 17), surface: true };
    } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
      f.kind = 'position';
      const ac = me(9, 12);
      if (tc <= 18) { f.alt = decodeAC12(ac); f.altSrc = 'baro'; } else if (ac) { f.altGnss = Math.round(ac * 3.28084); }
      f.cpr = { odd: me(22, 1), lat: me(23, 17), lon: me(40, 17), surface: false };
    } else if (tc === 19) {
      f.kind = 'velocity'; f.subtype = st;
      if (st === 1 || st === 2) {
        const k = st === 2 ? 4 : 1, ew = me(15, 10), ns = me(26, 10);
        if (ew && ns) {
          const vx = (me(14, 1) ? -1 : 1) * (ew - 1) * k, vy = (me(25, 1) ? -1 : 1) * (ns - 1) * k;
          f.gs = Math.round(Math.hypot(vx, vy) * 10) / 10;
          f.track = Math.round(mod(Math.atan2(vx, vy) * 180 / Math.PI, 360) * 10) / 10;
        }
      } else if (st === 3 || st === 4) {
        if (me(14, 1)) f.heading = Math.round(me(15, 10) * 360 / 1024 * 10) / 10;
        const as = me(26, 10);
        if (as) { const v = (as - 1) * (st === 4 ? 4 : 1); if (me(25, 1)) f.tas = v; else f.ias = v; }
      }
      const vr = me(38, 9);
      if (vr) { f.vr = (me(37, 1) ? -1 : 1) * (vr - 1) * 64; f.vrSrc = me(36, 1) ? 'baro' : 'GNSS'; }
      const d = me(50, 7);
      if (d) f.gnssBaroDiff = (me(49, 1) ? -1 : 1) * (d - 1) * 25;
    } else if (tc === 28) {
      f.kind = 'status';
      if (st === 1) { const e = me(9, 3); f.emergency = EMERGENCY[e] || ''; f.squawk = squawkFromId13(me(12, 13)); }
    } else if (tc === 29) {
      f.kind = 'target';
      if (me(6, 2) === 1) {
        const sa = me(10, 11); if (sa) f.selAlt = (sa - 1) * 32;
        const qnh = me(21, 9); if (qnh) f.qnh = Math.round((800 + (qnh - 1) * 0.8) * 10) / 10;
        if (me(30, 1)) f.selHeading = Math.round(me(31, 9) * 180 / 256 * 10) / 10;
      }
    } else if (tc === 31) {
      f.kind = 'opstatus'; f.version = me(41, 3);
    } else f.kind = 'other';
  }

  function decodeFields(b, df) {
    const f = { df };
    if (df === 17 || df === 18) {
      if (df === 18) { f.cf = bits(b, 6, 3); if (f.cf > 1 && f.cf !== 6) { f.kind = 'tisb'; return f; } } else f.ca = bits(b, 6, 3);
      decodeME(b, f);
    } else if (df === 11) {
      f.kind = 'allcall'; f.ca = bits(b, 6, 3);
    } else if (df === 0 || df === 16 || df === 4 || df === 20) {
      f.kind = 'alt'; f.alt = decodeAC13(bits(b, 20, 13));
      if (df === 0 || df === 16) f.onGround = bits(b, 6, 1) === 1;
      else { const fs = bits(b, 6, 3); f.fs = FS_NAMES[fs]; f.onGround = fs === 1 || fs === 3; f.alert = fs >= 2 && fs <= 4; f.spi = fs === 4 || fs === 5; }
    } else if (df === 5 || df === 21) {
      f.kind = 'squawk'; f.squawk = squawkFromId13(bits(b, 20, 13));
      const fs = bits(b, 6, 3); f.fs = FS_NAMES[fs]; f.onGround = fs === 1 || fs === 3; f.alert = fs >= 2 && fs <= 4; f.spi = fs === 4 || fs === 5;
    }
    if ((df === 20 || df === 21) && bits(b, 33, 8) === 0x20) { // BDS 2,0
      const cs = callsignAt(b, 41); if (/^[A-Z0-9 ]+$/.test(cs) && cs.length) f.callsign = cs;
    }
    return f;
  }

  function summarize(m) {
    const f = m.f, p = [];
    if (f.callsign) p.push(`Indicatif ${f.callsign}`);
    if (f.category && f.kind === 'ident') p.push(f.category);
    if (f.alt != null) p.push(`${f.alt.toLocaleString('fr-FR')} ft`);
    if (f.altGnss != null) p.push(`${f.altGnss.toLocaleString('fr-FR')} ft GNSS`);
    if (f.cpr) p.push(`CPR ${f.cpr.odd ? 'impair' : 'pair'}${f.cpr.surface ? ' (sol)' : ''}`);
    if (f.gs != null) p.push(`${Math.round(f.gs)} kt`);
    if (f.track != null) p.push(`route ${Math.round(f.track)}°`);
    if (f.heading != null) p.push(`cap ${Math.round(f.heading)}°`);
    if (f.ias != null) p.push(`IAS ${f.ias} kt`);
    if (f.tas != null) p.push(`TAS ${f.tas} kt`);
    if (f.vr != null) p.push(`${f.vr > 0 ? '+' : ''}${f.vr} ft/min`);
    if (f.squawk) p.push(`squawk ${f.squawk}`);
    if (f.emergency) p.push(f.emergency);
    if (f.selAlt != null) p.push(`alt. sélectionnée ${f.selAlt} ft`);
    if (f.qnh != null) p.push(`QNH ${f.qnh} hPa`);
    if (f.version != null) p.push(`ADS-B v${f.version}`);
    if (f.kind === 'allcall') p.push(`capacité ${f.ca}`);
    if (f.fs && f.fs !== 'En vol') p.push(f.fs);
    if (!p.length) p.push(f.tc != null ? `TC ${f.tc}` : '—');
    return p.join(' · ');
  }

  // ------------------------------------------------------------------ formats IQ
  const FORMATS = {
    cs16: { label: 'int16 signé LE (I/Q entrelacés)', bps: 4, full: 32768 },
    cs16be: { label: 'int16 signé BE', bps: 4, full: 32768 },
    cu8: { label: 'uint8 (RTL-SDR)', bps: 2, full: 128 },
    cs8: { label: 'int8 signé (HackRF)', bps: 2, full: 128 },
    cf32: { label: 'float32 (GNU Radio)', bps: 8, full: 1 },
  };
  function toMagnitude(buf, fmt) {
    let out;
    if (fmt === 'cs16') {
      const a = new Int16Array(buf), n = a.length >> 1; out = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 2) { const x = a[j], y = a[j + 1]; out[i] = Math.sqrt(x * x + y * y) * (1 / 32768); }
    } else if (fmt === 'cs16be') {
      const v = new DataView(buf), n = buf.byteLength >> 2; out = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = v.getInt16(4 * i, false), y = v.getInt16(4 * i + 2, false); out[i] = Math.sqrt(x * x + y * y) / 32768; }
    } else if (fmt === 'cu8') {
      const a = new Uint8Array(buf), n = a.length >> 1; out = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 2) { const x = a[j] - 127.4, y = a[j + 1] - 127.4; out[i] = Math.sqrt(x * x + y * y) / 128; }
    } else if (fmt === 'cs8') {
      const a = new Int8Array(buf), n = a.length >> 1; out = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 2) { const x = a[j], y = a[j + 1]; out[i] = Math.sqrt(x * x + y * y) / 128; }
    } else if (fmt === 'cf32') {
      const a = new Float32Array(buf), n = a.length >> 1; out = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 2) { const x = a[j], y = a[j + 1]; out[i] = Math.sqrt(x * x + y * y); }
    } else throw new Error('Format inconnu : ' + fmt);
    return out;
  }

  /** Analyse un en-tête WAV/RF64 (ArrayBuffer des premiers octets). */
  function parseWav(buf, fileSize) {
    const v = new DataView(buf), tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (buf.byteLength < 12) return null;
    const riff = tag(0);
    if ((riff !== 'RIFF' && riff !== 'RF64') || tag(8) !== 'WAVE') return null;
    let o = 12, fmt = null, dataOff = null, dataSize = null, ds64 = null;
    while (o + 8 <= buf.byteLength) {
      const id = tag(o), sz = v.getUint32(o + 4, true);
      if (id === 'ds64' && o + 36 <= buf.byteLength) ds64 = v.getUint32(o + 16, true) + v.getUint32(o + 20, true) * 2 ** 32;
      if (id === 'fmt ') fmt = { audio: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bitsPS: v.getUint16(o + 22, true) };
      if (id === 'data') { dataOff = o + 8; dataSize = (sz === 0xFFFFFFFF && ds64) ? ds64 : sz; break; }
      o += 8 + sz + (sz & 1);
    }
    if (!fmt || dataOff === null) return null;
    if (fileSize && (!dataSize || dataOff + dataSize > fileSize)) dataSize = fileSize - dataOff;
    let format = null;
    if (fmt.ch === 2) {
      if (fmt.bitsPS === 16) format = 'cs16';
      else if (fmt.bitsPS === 8) format = 'cu8';
      else if (fmt.bitsPS === 32 && (fmt.audio === 3 || fmt.audio === 0xFFFE)) format = 'cf32';
    }
    return { format, rate: fmt.rate, channels: fmt.ch, bitsPerSample: fmt.bitsPS, dataOffset: dataOff, dataSize };
  }

  /** Devine format et fréquence d'échantillonnage depuis le nom de fichier. */
  function guessFromName(name) {
    const n = name.toLowerCase(), r = {};
    if (/\.(cs16|sc16|c16|iq16|s16|ci16|int16)$/.test(n)) r.format = 'cs16';
    else if (/\.(cu8|u8|c8u)$/.test(n)) r.format = 'cu8';
    else if (/\.(cs8|s8|ci8|sc8)$/.test(n)) r.format = 'cs8';
    else if (/\.(cf32|fc32|cfile|f32|complex)$/.test(n)) r.format = 'cf32';
    else if (/\.wav$/.test(n)) r.format = 'wav';
    else if (/\.mat$/.test(n)) r.format = 'mat';
    let m = n.match(/(\d+(?:[.,]\d+)?)\s*(?:msps|ms\/s|msamp|mhz?sr)/);
    if (m) r.rate = parseFloat(m[1].replace(',', '.')) * 1e6;
    if (!r.rate && (m = n.match(/(\d+(?:[.,]\d+)?)\s*ksps/))) r.rate = parseFloat(m[1].replace(',', '.')) * 1e3;
    if (!r.rate && (m = n.match(/(?:^|[^a-z])(?:sr|fs|rate|s)[=_-]?(\d{6,8})(?!\d)/))) r.rate = +m[1];
    if (!r.rate) {
      for (const x of n.match(/\d{7,8}/g) || []) { const v = +x; if (v >= 1.9e6 && v <= 61.44e6) { r.rate = v; break; } }
    }
    if (!r.rate && (m = n.match(/(?:^|[^0-9.])(\d{1,2}(?:[.,]\d+)?)m(?:[^a-z]|$)/))) { const v = parseFloat(m[1].replace(',', '.')); if (v >= 2 && v <= 61.44) r.rate = v * 1e6; }
    if (r.rate && (r.rate < 1.9e6 || r.rate > 100e6)) delete r.rate;
    return r;
  }

  // ------------------------------------------------------------------ fichiers MATLAB (.mat v5)
  async function inflate(u8) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate');
      const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
      return new Uint8Array(await out.arrayBuffer());
    }
    if (typeof require === 'function') return new Uint8Array(require('zlib').inflateSync(u8));
    throw new Error('Décompression indisponible dans ce navigateur (fichier .mat compressé).');
  }
  const MI = { 1: [Int8Array, 1], 2: [Uint8Array, 1], 3: [Int16Array, 2], 4: [Uint16Array, 2], 5: [Int32Array, 4], 6: [Uint32Array, 4], 7: [Float32Array, 4], 9: [Float64Array, 8] };
  const MI_FULL = { 1: 128, 2: 128, 3: 32768, 4: 32768, 5: 2147483648, 6: 2147483648, 7: 1, 9: 1 };
  /** Lit un MAT-file v5 et renvoie l'IQ entrelacé (Float32, pleine échelle 1 pour les entiers). */
  async function parseMat(buf) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(116, buf.byteLength)));
    if (!/^MATLAB/.test(head)) throw new Error('Ce fichier n’est pas un MAT-file MATLAB.');
    if (/7\.3 MAT-file/.test(head)) throw new Error('MAT-file v7.3 (HDF5) non pris en charge : réenregistrez-le avec save(…, \'-v7\').');
    const le = String.fromCharCode(new Uint8Array(buf)[126], new Uint8Array(buf)[127]) === 'IM';
    if (!le) throw new Error('MAT-file gros-boutiste non pris en charge.');
    const vars = [];
    const tagAt = (dv, o) => { const t = dv.getUint32(o, true); return (t >>> 16) ? { type: t & 0xFFFF, n: t >>> 16, data: o + 4, next: o + 8 } : { type: t, n: dv.getUint32(o + 4, true), data: o + 8, next: o + 8 + dv.getUint32(o + 4, true) + ((8 - dv.getUint32(o + 4, true) % 8) % 8) }; };
    function matrix(u8, start, len) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let o = start; const end = start + len, parts = [];
      while (o + 8 <= end) { const t = tagAt(dv, o); parts.push(t); o = t.next; }
      if (parts.length < 4) return null;
      const flags = dv.getUint32(parts[0].data, true), cls = flags & 0xFF, cplx = !!(flags & 0x800);
      const dims = []; for (let i = 0; i < parts[1].n / 4; i++) dims.push(dv.getInt32(parts[1].data + 4 * i, true));
      const name = new TextDecoder().decode(u8.subarray(parts[2].data, parts[2].data + parts[2].n));
      if (cls < 6 || cls > 15) return { name, dims, cls };
      const arr = (t) => { const [T, sz] = MI[t.type] || []; if (!T) return null; return { a: new T(u8.slice(t.data, t.data + t.n).buffer), full: MI_FULL[t.type] }; };
      return { name, dims, cls, cplx, re: arr(parts[3]), im: cplx && parts[4] ? arr(parts[4]) : null };
    }
    let o = 128; const dv = new DataView(buf), u8all = new Uint8Array(buf);
    while (o + 8 <= buf.byteLength) {
      const t = tagAt(dv, o);
      if (t.type === 15) { const raw = await inflate(u8all.subarray(t.data, t.data + t.n)); const it = tagAt(new DataView(raw.buffer), 0); if (it.type === 14) { const m = matrix(raw, it.data, it.n); if (m) vars.push(m); } o = t.data + t.n; }
      else if (t.type === 14) { const m = matrix(u8all, t.data, t.n); if (m) vars.push(m); o = t.next; }
      else o = t.next;
    }
    let rate = null;
    for (const v of vars) if (v.re && v.re.a.length === 1 && /^(fs|fe|sr|samp.*rate|sample_?rate|rate|fech|f_?ech)$/i.test(v.name)) { const x = v.re.a[0]; rate = x < 1000 ? x * 1e6 : x; }
    const pick = vars.filter((v) => v.re && v.re.a.length > 1000).sort((a, b) => {
      const sc = (v) => (v.cplx ? 2 : 0) + (v.dims.includes(2) ? 1 : 0) + (/iq/i.test(v.name) ? 1 : 0);
      return sc(b) - sc(a) || b.re.a.length - a.re.a.length;
    })[0];
    if (!pick) throw new Error('Aucune variable IQ trouvée dans le fichier .mat (attendu : complexe N×1 ou réel N×2).');
    const k = 1 / (pick.re.full || 1), re = pick.re.a, [r, c] = pick.dims;
    let n, iq;
    if (pick.cplx && pick.im) { n = re.length; iq = new Float32Array(2 * n); const im = pick.im.a; for (let i = 0; i < n; i++) { iq[2 * i] = re[i] * k; iq[2 * i + 1] = im[i] * k; } }
    else if (c === 2) { n = r; iq = new Float32Array(2 * n); for (let i = 0; i < n; i++) { iq[2 * i] = re[i] * k; iq[2 * i + 1] = re[n + i] * k; } } // colonnes I, Q (stockage colonne)
    else if (r === 2) { n = c; iq = new Float32Array(2 * n); for (let i = 0; i < 2 * n; i++) iq[i] = re[i] * k; } // lignes I, Q
    else { n = Math.floor(re.length / 2); iq = new Float32Array(2 * n); for (let i = 0; i < 2 * n; i++) iq[i] = re[i] * k; } // vecteur entrelacé
    const clsName = { 6: 'double', 7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16', 11: 'uint16', 12: 'int32', 13: 'uint32' }[pick.cls] || '?';
    return { iq, n, rate, name: pick.name, dims: pick.dims, complex: pick.cplx, cls: clsName };
  }
  function arraySource(iq) {
    return { format: 'cf32', total: iq.length >> 1, read: async (s, n) => iq.slice(2 * s, 2 * (s + n)).buffer };
  }

  /** Essaie plusieurs fréquences d'échantillonnage sur le début du signal ; renvoie les décomptes de messages valides. */
  const PROBE_RATES = [2e6, 2.4e6, 2.56e6, 3e6, 3.2e6, 4e6, 5e6, 6e6, 8e6, 10e6, 12e6, 12.5e6, 16e6, 20e6, 24e6, 25e6, 30.72e6, 32e6, 40e6, 50e6, 56e6, 61.44e6, 64e6, 80e6, 100e6];
  async function probeRate(source, o = {}) {
    const maxS = Math.min(source.total, o.maxSamples || 3e6);
    const buf = await source.read(0, maxS), mag = toMagnitude(buf, source.format), res = [];
    for (const fs of o.rates || PROBE_RATES) {
      const d = createDemod({ fs, thresholdDb: o.thresholdDb ?? 6, fix1: false, snippets: 0 }), out = [];
      if (mag.length > 140 * fs / 1e6) d.process(mag, 0, mag.length, out);
      // on ne compte que les trames à CRC exact (DF17/18/11) : quasi aucune fausse détection
      res.push({ fs, count: out.filter((m) => m.crc === 'ok').length });
      if (o.onStep) await o.onStep(res.length / (o.rates || PROBE_RATES).length);
    }
    return res;
  }

  // ------------------------------------------------------------------ démodulateur
  /**
   * @param {object} o  fs (Hz), thresholdDb (seuil SNR préambule), fix1 (correction 1 bit),
   *                    snippets (nb max d'extraits de signal conservés)
   */
  function createDemod(o) {
    const fs = o.fs, sp = fs / 1e6, h = sp / 2;
    const thr = 10 ** ((o.thresholdDb ?? 8) / 20);
    const fix1 = o.fix1 !== false, maxSnip = o.snippets ?? 3000;
    const offsets = sp < 3 ? [0, -0.25, 0.25, -0.5, 0.5] : sp < 7 ? [0, -0.35, 0.35] : [0];
    const known = new Set();
    const stats = { candidates: 0, valid: 0, fixed: 0, crcFail: 0, byDf: {} };
    let nextT = 0, snipCount = 0;
    const bytes = new Uint8Array(14);

    function process(mag, start, validEnd, out) {
      const L = mag.length, P = new Float64Array(L + 1);
      let s = 0;
      for (let i = 0; i < L; i++) { s += mag[i]; P[i + 1] = s; }
      // bruit : 20e centile du module (robuste quand le signal occupe une grande part du bloc).
      // Pour un bruit de Rayleigh, moyenne = 1,876 × 20e centile.
      const NS = Math.min(L, 4096), smp = new Float32Array(NS);
      for (let i = 0; i < NS; i++) smp[i] = mag[Math.floor((i + 0.5) * L / NS)];
      smp.sort();
      const noise = Math.max(Math.min(s / L, smp[Math.floor(NS * 0.2)] * 1.876), 1e-9);
      const minE = noise * h * thr;
      const F = (x) => { const i = x | 0; return P[i] + (x - i) * mag[i]; };
      const E = (a, b) => F(b) - F(a);

      const score = (t) => {
        const p0 = E(t, t + h), p1 = E(t + sp, t + sp + h), p2 = E(t + 3.5 * sp, t + 4 * sp), p3 = E(t + 4.5 * sp, t + 5 * sp);
        const g = E(t + h, t + sp) + E(t + 1.5 * sp, t + 3.5 * sp) + E(t + 4 * sp, t + 4.5 * sp) + E(t + 5 * sp, t + 8 * sp);
        const hi = (p0 + p1 + p2 + p3) / 4, lo = g / 12, pmin = Math.min(p0, p1, p2, p3);
        return { hi, lo, pmin };
      };
      const demodBits = (t0, nbits) => {
        bytes.fill(0);
        for (let i = 0; i < nbits; i++) {
          const a = t0 + (8 + i) * sp, x = E(a, a + h), y = E(a + h, a + sp);
          if (x > y) bytes[i >> 3] |= 0x80 >> (i & 7);
        }
      };

      // Tranchage par modèle (faible suréchantillonnage) : chaque échantillon moyenne
      // deux demi-bits quand la phase est fractionnaire ; on compare, bit par bit, les
      // deux hypothèses au module attendu (rétroaction de décision sur le bit précédent).
      const chips = new Float32Array(16 + 224);
      const PRE = [1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0];
      const frac = (k, t0) => { // part « allumée » de l'échantillon [k, k+1)
        let v = 0;
        const c0 = Math.max(0, Math.floor((k - t0) / h)), c1 = Math.floor((k + 1 - t0) / h);
        for (let c = c0; c <= c1 && c < chips.length; c++) {
          const a = Math.max(k, t0 + c * h), b = Math.min(k + 1, t0 + (c + 1) * h);
          if (b > a) v += (b - a) * chips[c];
        }
        return v;
      };
      const modelBits = (t0, nbits) => {
        chips.fill(0.5);
        for (let c = 0; c < 16; c++) chips[c] = PRE[c];
        const kEnd = Math.ceil(t0 + 8 * sp);
        let nz = 0, nn = 0, num = 0, den = 0;
        for (let k = Math.floor(t0); k < kEnd; k++) { const e = frac(k, t0); if (e < 0.01) { nz += mag[k]; nn++; } }
        nz = nn ? nz / nn : noise;
        for (let k = Math.floor(t0); k < kEnd; k++) { const e = frac(k, t0); num += (mag[k] - nz) * e; den += e * e; }
        const A = den > 0 ? num / den : 0;
        if (A <= 0) return false;
        bytes.fill(0);
        for (let i = 0; i < nbits; i++) {
          const c = 16 + 2 * i, k0 = Math.floor(t0 + c * h), k1 = Math.ceil(t0 + (c + 2) * h);
          let e1 = 0, e0 = 0;
          for (let hyp = 0; hyp < 2; hyp++) {
            chips[c] = hyp; chips[c + 1] = 1 - hyp;
            let err = 0;
            for (let k = k0; k < k1; k++) { const d = mag[k] - nz - A * frac(k, t0); err += d * d; }
            if (hyp) e1 = err; else e0 = err;
          }
          const bit = e1 < e0 ? 1 : 0;
          chips[c] = bit; chips[c + 1] = 1 - bit;
          if (bit) bytes[i >> 3] |= 0x80 >> (i & 7);
        }
        return true;
      };
      const methods = sp < 5 ? [0, 1] : [0];

      let t = Math.max(0, Math.ceil(nextT - start + 0.5));
      if (t < 1) t = 1;
      const tEnd = Math.min(validEnd, L - Math.ceil(122 * sp) - 2);
      for (; t < tEnd; t++) {
        // pré-filtre rapide : deux premières impulsions au-dessus du seuil
        if (E(t - 0.5, t + h + 0.5) < minE) continue;
        if (E(t + sp - 0.5, t + sp + h + 0.5) < minE) continue;
        const cands = [];
        for (const d of offsets) {
          const t0 = t + d, sc = score(t0);
          if (sc.hi >= minE && sc.pmin > 0.6 * minE && sc.hi > 2.2 * sc.lo && sc.pmin > 1.4 * sc.lo) cands.push({ t0, sc, q: (sc.hi - sc.lo) / (sc.hi + sc.lo) });
        }
        if (!cands.length) continue;
        stats.candidates++;
        cands.sort((a, b) => b.q - a.q);
        let msg = null;
        search: for (const c of cands) for (const meth of methods) {
          if (meth === 0) demodBits(c.t0, 112); else if (!modelBits(c.t0, 112)) continue;
          const df = bytes[0] >> 3, long = df >= 16, nb = long ? 14 : 7;
          if (!(df in DF_NAMES)) continue;
          if (!long) for (let i = 7; i < 14; i++) bytes[i] = 0;
          let res = residual(bytes, nb), status = null, fixedBit = null, icao = null;
          if (df === 17 || df === 18) {
            if (res === 0) status = 'ok';
            else if (fix1) { const bi = SYN112.get(res); if (bi !== undefined) { bytes[bi >> 3] ^= 0x80 >> (bi & 7); status = 'corrigé'; fixedBit = bi; } }
            if (status) { icao = bits(bytes, 9, 24); if (df === 17 || bits(bytes, 6, 3) === 0) known.add(icao); }
          } else if (df === 11) {
            if ((res & 0xFFFF80) === 0) { status = 'ok'; icao = bits(bytes, 9, 24); known.add(icao); }
          } else if (known.has(res)) { status = 'AP'; icao = res; }
          if (!status) continue;
          msg = { c, df, nb, status, fixedBit, icao, iid: df === 11 ? res : undefined };
          break search;
        }
        if (!msg) { stats.crcFail++; continue; }
        const { c, df, nb } = msg, nbits = nb * 8, b = bytes.slice(0, nb);
        const amp = c.sc.hi / h;
        const m = {
          t: (start + c.t0) / fs, sample: start + c.t0, hex: hex(b), df, icao: msg.icao.toString(16).toUpperCase().padStart(6, '0'),
          crc: msg.status, rssi: Math.round(20 * Math.log10(Math.max(amp, 1e-9)) * 10) / 10,
          snr: Math.round(20 * Math.log10(c.sc.hi / (noise * h)) * 10) / 10,
          f: decodeFields(b, df),
        };
        if (df === 17 && msg.fixedBit != null) m.fixedBit = msg.fixedBit;
        if (msg.iid) m.f.iid = msg.iid;
        if (df === 18 && m.f.cf === 1) m.icao = '~' + m.icao;
        if (snipCount < maxSnip) { // extrait du module pour la vue « Signal »
          const a = Math.max(0, Math.floor(c.t0 - sp)), z = Math.min(L, Math.ceil(c.t0 + (9 + nbits) * sp));
          const dec = Math.max(1, Math.floor(sp / 8));
          const d = new Float32Array(Math.ceil((z - a) / dec));
          for (let i = 0; i < d.length; i++) { let mx = 0; for (let k = 0; k < dec && a + i * dec + k < z; k++) mx = Math.max(mx, mag[a + i * dec + k]); d[i] = mx; }
          m.snip = { d, spu: sp / dec, off: (c.t0 - a) / dec, noise, nbits };
          snipCount++;
        }
        stats.valid++; if (msg.status === 'corrigé') stats.fixed++;
        stats.byDf[df] = (stats.byDf[df] || 0) + 1;
        out.push(m);
        nextT = start + c.t0 + (8 + nbits) * sp - 1;
        t = Math.max(t, Math.floor(nextT - start));
      }
    }
    return { process, stats, known, sp };
  }

  // ------------------------------------------------------------------ trames déjà extraites (AVR, Beast, Parquet…)
  /** Normalise une trame : hexadécimal (avec ou sans *…; @horodatage) ou octets → Uint8Array(7|14), sinon null. */
  function frameBytes(v) {
    if (v == null) return null;
    if (v instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v))) {
      const u = v instanceof Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return u.length === 7 || u.length === 14 ? u : null;
    }
    if (typeof v !== 'string') return null;
    let h = v.trim().replace(/^[*:]/, '').replace(/;$/, '');
    if (h[0] === '@' || h[0] === '%') h = h.slice(13); // AVR horodaté (@ + 12 hex)
    h = h.replace(/[\s;]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(h) || (h.length !== 14 && h.length !== 28)) return null;
    return fromHex(h);
  }
  /** Valide (CRC / adresse-parité) et décode des trames déjà démodulées. */
  function createFrameDecoder(o = {}) {
    const known = new Set(), fix1 = o.fix1 !== false;
    const stats = { frames: 0, valid: 0, fixed: 0, crcFail: 0, byDf: {} };
    function decode(raw, t, extra) {
      const b0 = frameBytes(raw); stats.frames++;
      if (!b0) { stats.crcFail++; return null; }
      const b = Uint8Array.from(b0), df = b[0] >> 3, nb = b.length;
      if (!(df in DF_NAMES) || (df >= 16) !== (nb === 14)) { stats.crcFail++; return null; }
      const res = residual(b, nb);
      let status = null, icao = null, fixedBit;
      if (df === 17 || df === 18) {
        if (res === 0) status = 'ok';
        else if (fix1) { const bi = SYN112.get(res); if (bi !== undefined) { b[bi >> 3] ^= 0x80 >> (bi & 7); status = 'corrigé'; fixedBit = bi; } }
        if (status) { icao = bits(b, 9, 24); if (df === 17 || bits(b, 6, 3) === 0) known.add(icao); }
      } else if (df === 11) {
        if ((res & 0xFFFF80) === 0) { status = 'ok'; icao = bits(b, 9, 24); known.add(icao); }
      } else if (known.has(res) || o.trustAP) { status = 'AP'; icao = res; if (o.trustAP) known.add(res); }
      if (!status) { stats.crcFail++; return null; }
      stats.valid++; if (status === 'corrigé') stats.fixed++; stats.byDf[df] = (stats.byDf[df] || 0) + 1;
      const m = { t, hex: hex(b), df, icao: icao.toString(16).toUpperCase().padStart(6, '0'), crc: status, rssi: extra && extra.rssi != null ? extra.rssi : null, snr: null, f: decodeFields(b, df) };
      if (fixedBit != null) m.fixedBit = fixedBit;
      if (df === 18 && m.f.cf === 1) m.icao = '~' + m.icao;
      return m;
    }
    return { decode, stats, known };
  }

  // ------------------------------------------------------------------ traitement complet
  const yieldTask = () => new Promise((r) => setTimeout(r, 0));
  /**
   * source : { total (échantillons), format, read(start, n) → Promise<ArrayBuffer> }
   * emit({type:'progress'|'done'|'error', ...})
   */
  async function runJob(source, o, emit, cancelled) {
    const t0 = Date.now(), sp = o.fs / 1e6;
    const CH = Math.max(1 << 18, Math.round((o.chunkMs || 250) * 1e-3 * o.fs));
    const ov = Math.ceil(140 * sp) + 8;
    const demod = createDemod(o);
    let s = 0;
    while (s < source.total) {
      if (cancelled && cancelled()) { emit({ type: 'done', cancelled: true, done: s, total: source.total, stats: demod.stats, elapsed: (Date.now() - t0) / 1000 }); return; }
      const n = Math.min(CH + ov, source.total - s);
      const mag = toMagnitude(await source.read(s, n), source.format);
      const last = s + CH >= source.total;
      const msgs = [];
      demod.process(mag, s, last ? mag.length : CH, msgs);
      s = Math.min(s + CH, source.total);
      emit({ type: 'progress', done: s, total: source.total, msgs, stats: demod.stats, elapsed: (Date.now() - t0) / 1000 });
      await yieldTask();
    }
    emit({ type: 'done', done: source.total, total: source.total, stats: demod.stats, elapsed: (Date.now() - t0) / 1000 });
  }

  async function readBlob(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Response(blob).arrayBuffer();
  }
  function fileSource(file, format, dataOffset = 0, dataSize = null) {
    const bps = FORMATS[format].bps, size = dataSize ?? (file.size - dataOffset);
    return {
      format, total: Math.floor(size / bps),
      read: (s, n) => readBlob(file.slice(dataOffset + s * bps, dataOffset + (s + n) * bps)),
    };
  }

  // ------------------------------------------------------------------ suivi des aéronefs
  function createTracker(ref) {
    const ac = new Map();
    const T = { ac, ref: ref || null, maxRangeKm: 0, positions: 0 };
    function get(icao, t) {
      let a = ac.get(icao);
      if (!a) {
        a = { icao, first: t, last: t, msgs: 0, df: {}, rssiSum: 0, rssiMax: -200, trail: [], altHist: [], cpr: { even: null, odd: null } };
        ac.set(icao, a);
      }
      return a;
    }
    T.setRef = (r) => { T.ref = r; for (const a of ac.values()) if (a.lat != null && r) a.dist = distKm(r, a); };
    T.update = (m) => {
      const f = m.f, a = get(m.icao, m.t);
      a.msgs++; a.last = Math.max(a.last, m.t); a.first = Math.min(a.first, m.t);
      const dk = m.df == null ? 'état' : m.df; a.df[dk] = (a.df[dk] || 0) + 1;
      if (m.rssi != null) { a.rssiN = (a.rssiN || 0) + 1; a.rssiSum += m.rssi; a.rssiMax = Math.max(a.rssiMax, m.rssi); a.rssi = a.rssiSum / a.rssiN; }
      if (f.callsign) a.callsign = f.callsign;
      if (f.kind === 'ident') { a.category = f.category; a.catCode = f.catCode; }
      if (f.alt != null) { a.alt = f.alt; if (!a.altHist.length || m.t - a.altHist[a.altHist.length - 1].t > 0.4) a.altHist.push({ t: m.t, alt: f.alt }); }
      if (f.altGnss != null) a.altGnss = f.altGnss;
      if (f.squawk) a.squawk = f.squawk;
      if (f.emergency) a.emergency = f.emergency;
      if (f.onGround != null) a.onGround = f.onGround;
      if (f.alert) a.alert = true;
      for (const k of ['gs', 'track', 'vr', 'ias', 'tas', 'heading', 'selAlt', 'qnh', 'version']) if (f[k] != null) a[k] = f[k];
      if (f.cpr) position(a, f.cpr, m.t, f);
      else if (f.lat != null && f.lon != null && Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180 && (f.lat || f.lon)) { // position déjà décodée
        const last = a.trail[a.trail.length - 1];
        a.lat = f.lat; a.lon = f.lon; a.posT = m.t; T.positions++;
        if (T.ref) { a.dist = distKm(T.ref, a); a.brg = bearing(T.ref, a); T.maxRangeKm = Math.max(T.maxRangeKm, a.dist); }
        if (!last || Math.abs(m.t - last.t) >= (T.trailStep || 0) || distKm(last, a) > 2) a.trail.push({ t: m.t, lat: f.lat, lon: f.lon, alt: f.alt ?? a.alt ?? null });
        if (a.trail.length > 4000) a.trail.splice(0, a.trail.length - 4000);
      }
      return a;
    };
    function accept(a, p, t, f) {
      a.lat = p.lat; a.lon = p.lon; a.posT = t; T.positions++;
      a.trail.push({ t, lat: p.lat, lon: p.lon, alt: f.alt ?? a.alt ?? null });
      if (T.ref) { a.dist = distKm(T.ref, p); a.brg = bearing(T.ref, p); T.maxRangeKm = Math.max(T.maxRangeKm, a.dist); }
    }
    function position(a, cpr, t, f) {
      const slot = cpr.odd ? 'odd' : 'even';
      a.cpr[slot] = { lat: cpr.lat, lon: cpr.lon, t };
      if (cpr.surface) {
        const r = a.lat != null ? a : T.ref; if (!r) return;
        const p = cprLocal(cpr, cpr.odd, r, true); if (p && distKm(r, p) < 45) accept(a, p, t, f);
        return;
      }
      if (a.lat != null && t - a.posT < 30) { // décodage local relatif à la dernière position
        const p = cprLocal(cpr, cpr.odd, a, false);
        if (p && distKm(a, p) < 3 + (t - a.posT) * 0.4) { accept(a, p, t, f); return; }
      }
      const e = a.cpr.even, o = a.cpr.odd;
      if (e && o && Math.abs(e.t - o.t) < 10) {
        const p = cprGlobal(e, o, cpr.odd === 1);
        if (!p) return;
        if (T.ref && distKm(T.ref, p) > 700) return;
        if (a.lat != null && distKm(a, p) > 5 + (t - a.posT) * 0.4) { // saut incohérent : on attend une confirmation
          if (a.pending && distKm(a.pending, p) < 5) { a.trail = []; accept(a, p, t, f); a.pending = null; } else a.pending = p;
          return;
        }
        accept(a, p, t, f);
      }
    }
    return T;
  }

  // ------------------------------------------------------------------ encodeur (démo / tests)
  function finalize(b, nb, ap) {
    const c = crc24(b, nb - 3) ^ (ap || 0);
    b[nb - 3] = (c >> 16) & 0xFF; b[nb - 2] = (c >> 8) & 0xFF; b[nb - 1] = c & 0xFF; return b;
  }
  function es(icao, tc, st) { const b = new Uint8Array(14); setBits(b, 1, 5, 17); setBits(b, 6, 3, 5); setBits(b, 9, 24, icao); setBits(b, 33, 5, tc); setBits(b, 38, 3, st); return b; }
  const ENC = {
    ident(icao, cs, tc = 4, cat = 3) {
      const b = es(icao, tc, cat), s = cs.toUpperCase().padEnd(8, ' ');
      for (let i = 0; i < 8; i++) setBits(b, 41 + 6 * i, 6, Math.max(0, CHARSET.indexOf(s[i])));
      return finalize(b, 14);
    },
    position(icao, lat, lon, altFt, odd) {
      const b = es(icao, 11, 0), c = cprEncode(lat, lon, odd);
      setBits(b, 41, 12, encodeAC12(altFt)); setBits(b, 54, 1, odd); setBits(b, 55, 17, c.lat); setBits(b, 72, 17, c.lon);
      return finalize(b, 14);
    },
    velocity(icao, gs, trk, vr) {
      const b = es(icao, 19, 1), vx = gs * Math.sin(trk * Math.PI / 180), vy = gs * Math.cos(trk * Math.PI / 180);
      setBits(b, 46, 1, vx < 0 ? 1 : 0); setBits(b, 47, 10, Math.min(1023, Math.round(Math.abs(vx)) + 1));
      setBits(b, 57, 1, vy < 0 ? 1 : 0); setBits(b, 58, 10, Math.min(1023, Math.round(Math.abs(vy)) + 1));
      setBits(b, 68, 1, 1); setBits(b, 69, 1, vr < 0 ? 1 : 0); setBits(b, 70, 9, Math.min(511, Math.round(Math.abs(vr) / 64) + 1));
      return finalize(b, 14);
    },
    emergency(icao, squawk, code) { const b = es(icao, 28, 1); setBits(b, 41, 3, code); setBits(b, 44, 13, id13FromSquawk(squawk)); return finalize(b, 14); },
    allcall(icao, ca = 5) { const b = new Uint8Array(7); setBits(b, 1, 5, 11); setBits(b, 6, 3, ca); setBits(b, 9, 24, icao); return finalize(b, 7); },
    alt(icao, altFt, fs = 0) { const b = new Uint8Array(7); setBits(b, 1, 5, 4); setBits(b, 6, 3, fs); setBits(b, 20, 13, encodeAC13(altFt)); return finalize(b, 7, icao); },
    squawk(icao, sq, fs = 0) { const b = new Uint8Array(7); setBits(b, 1, 5, 5); setBits(b, 6, 3, fs); setBits(b, 20, 13, id13FromSquawk(sq)); return finalize(b, 7, icao); },
  };

  // ------------------------------------------------------------------ générateur de signal
  function h32(x) { x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return x >>> 0; }
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  const DEMO_FLEET = [
    { icao: 0x3944F1, cs: 'AFR1047', tc: 4, cat: 3, brg: 20, km: 62, alt: 36000, gs: 452, trk: 135, vr: 0, sq: '1000', snr: 22 },
    { icao: 0x406A3C, cs: 'EZY48QT', tc: 4, cat: 3, brg: 300, km: 41, alt: 21000, gs: 338, trk: 305, vr: 1792, sq: '6210', snr: 18 },
    { icao: 0x4CA7B2, cs: 'RYR3PL', tc: 4, cat: 3, brg: 200, km: 28, alt: 11500, gs: 276, trk: 40, vr: -1472, sq: '3457', snr: 26 },
    { icao: 0x3C66B4, cs: 'DLH9CW', tc: 4, cat: 3, brg: 75, km: 148, alt: 38000, gs: 471, trk: 228, vr: 0, sq: '2271', snr: 11 },
    { icao: 0x39AC05, cs: 'FGKXA', tc: 4, cat: 1, brg: 155, km: 17, alt: 2500, gs: 104, trk: 75, vr: 256, sq: '7000', snr: 9 },
    { icao: 0x400F2B, cs: 'BAW318', tc: 4, cat: 5, brg: 340, km: 96, alt: 33000, gs: 482, trk: 162, vr: 0, sq: '5513', snr: 15 },
    { icao: 0x3A1F7E, cs: 'TVF72HM', tc: 4, cat: 3, brg: 250, km: 74, alt: 17000, gs: 312, trk: 70, vr: -2432, sq: '7700', snr: 17, emergency: 1 },
  ];

  /** Scénario synthétique : planning de messages + générateur IQ int16 déterministe. */
  function demoScenario(opt = {}) {
    const fs = opt.fs || 2.4e6, dur = opt.duration || 15, seed = opt.seed ?? 7, sigma = opt.noise ?? 220;
    const ref = opt.ref || { lat: 48.7262, lon: 2.3652 };
    const fleet = (opt.fleet || DEMO_FLEET).map((a) => ({ ...a, p0: destination(ref, a.brg, a.km) }));
    const R = rng(seed), msgs = [], sp = fs / 1e6;
    const state = (a, t) => {
      const p = destination(a.p0, a.trk, a.gs * 1.852 / 3600 * t);
      return { lat: p.lat, lon: p.lon, alt: Math.round((a.alt + a.vr * t / 60) / 25) * 25 };
    };
    for (const a of fleet) {
      const amp = sigma * Math.SQRT2 * 10 ** (a.snr / 20), fOff = (R() - 0.5) * 160e3;
      const push = (t, bytes, kind) => { if (t >= 0.0002 && t < dur - 0.0003) msgs.push({ t, bytes, amp: amp * 10 ** ((R() - 0.5) * 0.1), fOff, ph: R() * 2 * Math.PI, icao: a.icao, kind, truth: state(a, t) }); };
      let odd = 0;
      for (let t = R() * 0.5; t < dur; t += 0.4 + R() * 0.2) { const s = state(a, t); push(t, ENC.position(a.icao, s.lat, s.lon, s.alt, odd), odd ? 'pos-odd' : 'pos-even'); odd ^= 1; }
      for (let t = R() * 0.5; t < dur; t += 0.4 + R() * 0.2) push(t, ENC.velocity(a.icao, a.gs, a.trk, a.vr), 'vel');
      for (let t = 0.05 + R() * 0.8; t < dur; t += 4.6 + R() * 0.8) push(t, ENC.ident(a.icao, a.cs, a.tc, a.cat), 'ident');
      for (let t = R(); t < dur; t += 0.8 + R() * 0.4) push(t, ENC.allcall(a.icao), 'allcall');
      for (let t = 0.4 + R(); t < dur; t += 0.6 + R() * 0.6) push(t, ENC.alt(a.icao, state(a, t).alt), 'alt');
      for (let t = 0.4 + R(); t < dur; t += 1.1 + R() * 0.8) push(t, ENC.squawk(a.icao, a.sq), 'squawk');
      if (a.emergency) for (let t = 0.3 + R(); t < dur; t += 2.5 + R()) push(t, ENC.emergency(a.icao, a.sq, a.emergency), 'emergency');
    }
    msgs.sort((x, y) => x.t - y.t);
    for (const m of msgs) { m.s0 = m.t * fs; m.len = (8 + m.bytes.length * 8) * sp; }
    const total = Math.floor(dur * fs);

    function onAt(m, tau) { // tau en µs depuis le début du message
      if (tau < 0) return 0;
      if (tau < 8) return (tau < 0.5 || (tau >= 1 && tau < 1.5) || (tau >= 3.5 && tau < 4) || (tau >= 4.5 && tau < 5)) ? 1 : 0;
      const i = Math.floor(tau - 8);
      if (i >= m.bytes.length * 8) return 0;
      const bit = (m.bytes[i >> 3] >> (7 - (i & 7))) & 1, first = (tau - 8 - i) < 0.5;
      return bit ? (first ? 1 : 0) : (first ? 0 : 1);
    }
    function generate(start, n) {
      const iq = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        const k = (start + i) | 0;
        const u1 = (h32((k * 2 + seed) | 0) + 1) / 4294967297, u2 = h32(((k * 2 + 1) ^ 0x9e3779b9) + seed) / 4294967296;
        const r = Math.sqrt(-2 * Math.log(u1)) * sigma;
        iq[2 * i] = r * Math.cos(2 * Math.PI * u2); iq[2 * i + 1] = r * Math.sin(2 * Math.PI * u2);
      }
      let lo = 0, hi = msgs.length; const first = start - 130 * sp;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (msgs[mid].s0 < first) lo = mid + 1; else hi = mid; }
      for (let j = lo; j < msgs.length && msgs[j].s0 < start + n; j++) {
        const m = msgs[j], a = Math.max(start, Math.floor(m.s0)), z = Math.min(start + n, Math.ceil(m.s0 + m.len) + 1);
        for (let k = a; k < z; k++) {
          let v = 0;
          for (let q = 0; q < 4; q++) v += onAt(m, (k + (q + 0.5) / 4 - m.s0) / sp);
          if (!v) continue;
          v *= m.amp / 4;
          const ph = m.ph + 2 * Math.PI * m.fOff * (k / fs);
          iq[2 * (k - start)] += v * Math.cos(ph); iq[2 * (k - start) + 1] += v * Math.sin(ph);
        }
      }
      const out = new Int16Array(2 * n);
      for (let i = 0; i < 2 * n; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(iq[i])));
      return out;
    }
    return {
      fs, duration: dur, ref, fleet, msgs, total, generate,
      source: () => ({ format: 'cs16', total, read: async (s, n) => generate(s, n).buffer }),
    };
  }

  return {
    bits, setBits, hex, fromHex, crc24, residual, decodeFields, summarize, decodeAC12, decodeAC13, squawkFromId13, id13FromSquawk,
    NL, cprGlobal, cprLocal, cprEncode, distKm, bearing, destination,
    FORMATS, toMagnitude, parseWav, parseMat, frameBytes, createFrameDecoder, arraySource, probeRate, PROBE_RATES, guessFromName, createDemod, runJob, fileSource, createTracker,
    ENC, demoScenario, DEMO_FLEET, DF_NAMES, CATEGORIES,
  };
});
