/* Lecture de fichiers Parquet ADS-B (trames Mode S brutes ou états déjà décodés).
 * Dépend de Hyparquet (vendor/hyparquet.js dans la page, ou le module npm sous Node)
 * et d'ADSB (adsb-core.js) pour la reconnaissance des trames.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.ADSBTable = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // rôles des colonnes, reconnus par leur nom (insensible à la casse)
  const ROLES = {
    icao: /^(icao_?24|icao|hex|icao_?hex|icao_?address|address|aa|transponder|mode_?s_?code|addr)$/i,
    callsign: /^(flight|callsign|call_?sign|ident|flight_?id|flight_?number|cs)$/i,
    lat: /^(lat|latitude)$/i,
    lon: /^(lon|lng|long|longitude)$/i,
    alt: /^(alt_?baro|baro_?alt(itude)?|baroaltitude|altitude|alt|altitude_?baro|barometric_?altitude|alt_?ft|altitude_?ft)$/i,
    altGnss: /^(alt_?geom|geo_?alt(itude)?|geoaltitude|gnss_?alt(itude)?|altitude_?geom|alt_?gnss)$/i,
    gs: /^(gs|ground_?speed|groundspeed|speed|velocity|spd|gspeed)$/i,
    track: /^(track|true_?track|course|trk|cog)$/i,
    heading: /^(heading|hdg|true_?heading|mag_?heading|nav_?heading)$/i,
    vr: /^(baro_?rate|vert_?rate|vertical_?rate|vertrate|geom_?rate|vr|roc|vs|vspeed)$/i,
    squawk: /^(squawk|sqk|mode_?a|squawk_?code)$/i,
    time: /^(time|timestamp|ts|t|mintime|seen_?time|received|received_?at|rx_?time|datetime|date_?time|event_?time|lastcontact|last_?contact|last_?seen|created_?at|time_?position|recorded_?at|epoch|unix_?time|msg_?time|now)$/i,
    rssi: /^(rssi|signal|signal_?level|level|signal_?strength|dbfs)$/i,
    ground: /^(on_?ground|onground|ground|is_?on_?ground|gnd)$/i,
    category: /^(category|cat|emitter_?category|aircraft_?category)$/i,
  };
  // unités métriques (format OpenSky) : m, m/s
  const METRIC = /^(baroaltitude|geoaltitude|velocity|vertrate|altitude_?m|alt_?m)$/i;

  const num = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : null;
  };
  /** Temps en secondes Unix (accepte Date, ISO, s, ms, µs, ns). */
  function toSeconds(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.getTime() / 1000;
    if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v.trim())) { const d = Date.parse(v); return Number.isFinite(d) ? d / 1000 : null; }
    const x = num(v); if (x == null) return null;
    const a = Math.abs(x);
    return a > 1e17 ? x / 1e9 : a > 1e14 ? x / 1e6 : a > 1e11 ? x / 1e3 : x;
  }
  function icaoOf(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'bigint') return Number(v).toString(16).toUpperCase().padStart(6, '0');
    const s = String(v).trim().toUpperCase().replace(/^0X/, '');
    return /^~?[0-9A-F]{6}$/.test(s) ? s : (/^[0-9A-F]{1,6}$/.test(s) ? s.padStart(6, '0') : null);
  }

  /** Associe les rôles aux colonnes à partir des noms et d'un échantillon de lignes. */
  function analyze(names, sample, ADSB) {
    const roles = {}, flat = names.map((n) => ({ n, base: n.split('.').pop() }));
    // colonne de trames : choisie sur les valeurs (≥ 60 % de trames Mode S valides de 56/112 bits)
    let best = null;
    for (const { n } of flat) {
      let ok = 0, tot = 0;
      for (const r of sample) { const v = r[n]; if (v == null) continue; tot++; if (ADSB.frameBytes(v)) ok++; }
      if (tot && ok / tot >= 0.6 && (!best || ok > best.ok)) best = { n, ok };
    }
    if (best) roles.frame = best.n;
    for (const [role, re] of Object.entries(ROLES)) {
      const hit = flat.find(({ n, base }) => n !== roles.frame && (re.test(base) || re.test(n)));
      if (hit) roles[role] = hit.n;
    }
    // « hex » peut être la trame ou l'ICAO : on vérifie sur les valeurs
    if (roles.icao && roles.icao !== roles.frame) {
      const vals = sample.map((r) => r[roles.icao]).filter((v) => v != null).slice(0, 50);
      if (vals.length && vals.filter((v) => icaoOf(v)).length / vals.length < 0.6) delete roles.icao;
    }
    const units = {};
    for (const k of ['alt', 'altGnss', 'gs', 'vr']) if (roles[k]) units[k] = METRIC.test(roles[k].split('.').pop()) ? 'metric' : 'imperial';
    const mode = roles.frame ? 'frames' : (roles.icao && (roles.lat || roles.alt || roles.callsign || roles.gs)) ? 'states' : null;
    return { roles, units, mode };
  }

  /** Convertit une ligne « état » en champs décodés (pieds, nœuds, ft/min). */
  function stateFields(r, roles, units) {
    const f = { df: null, kind: 'state' };
    const g = (k) => (roles[k] ? r[roles[k]] : undefined);
    const altRaw = g('alt');
    if (typeof altRaw === 'string' && /ground|gnd/i.test(altRaw)) f.onGround = true;
    else { const a = num(altRaw); if (a != null) f.alt = Math.round(units.alt === 'metric' ? a * 3.28084 : a); }
    const ag = num(g('altGnss')); if (ag != null) f.altGnss = Math.round(units.altGnss === 'metric' ? ag * 3.28084 : ag);
    const gs = num(g('gs')); if (gs != null) f.gs = Math.round((units.gs === 'metric' ? gs * 1.943844 : gs) * 10) / 10;
    const tr = num(g('track')); if (tr != null) f.track = Math.round(tr * 10) / 10;
    const hd = num(g('heading')); if (hd != null) f.heading = Math.round(hd * 10) / 10;
    const vr = num(g('vr')); if (vr != null) f.vr = Math.round(units.vr === 'metric' ? vr * 196.850 : vr);
    const lat = num(g('lat')), lon = num(g('lon')); if (lat != null && lon != null) { f.lat = lat; f.lon = lon; }
    const cs = g('callsign'); if (cs != null && String(cs).trim()) f.callsign = String(cs).trim().toUpperCase();
    const sq = g('squawk'); if (sq != null && String(sq).trim()) { const s = typeof sq === 'number' ? String(sq).padStart(4, '0') : String(sq).trim(); if (/^[0-7]{4}$/.test(s)) f.squawk = s; }
    const gr = g('ground'); if (gr != null) f.onGround = gr === true || gr === 1 || /^(true|1|yes|ground)$/i.test(String(gr));
    const cat = g('category'); if (cat != null && String(cat).trim()) { f.catCode = String(cat).trim(); }
    return f;
  }

  /**
   * Lit un fichier Parquet par blocs de lignes.
   * opts : Hyparquet, ADSB, file (Blob/File ou {byteLength, slice}), chunk, onInfo(info), onRows(messages, done, total), cancelled()
   */
  async function read(opts) {
    const H = opts.Hyparquet, ADSB = opts.ADSB, chunk = opts.chunk || 50000;
    const file = opts.file.byteLength != null ? opts.file : {
      byteLength: opts.file.size,
      slice: (a, b) => opts.file.slice(a, b).arrayBuffer(),
    };
    const metadata = await H.parquetMetadataAsync(file);
    const total = Number(metadata.num_rows);
    const names = H.parquetSchema(metadata).children.map((c) => c.element.name);
    const compressors = H.compressors;
    const readRows = (rowStart, rowEnd, columns) => H.parquetReadObjects({ file, metadata, columns, rowStart, rowEnd, compressors });
    const sample = await readRows(0, Math.min(total, 400));
    const an = analyze(names, sample, ADSB);
    const info = { total, names, ...an, codec: (metadata.row_groups[0] && metadata.row_groups[0].columns[0].meta_data.codec) || '', createdBy: metadata.created_by || '' };
    if (!an.mode) { info.error = 'Colonnes non reconnues : il faut une colonne de trames Mode S (hexadécimal) ou des colonnes ICAO + position/altitude.'; opts.onInfo && opts.onInfo(info); return info; }

    const cols = [...new Set(Object.values(an.roles))];
    // plages de lecture alignées sur les groupes de lignes (évite de redécoder un groupe plusieurs fois)
    const ranges = []; let r0 = 0;
    for (const g of metadata.row_groups) {
      const n = Number(g.num_rows);
      for (let a = 0; a < n; a += 400000) ranges.push([r0 + a, r0 + Math.min(n, a + 400000)]);
      r0 += n;
    }
    if (!ranges.length) ranges.push([0, total]);
    // 1er passage : bornes temporelles (colonne de temps seule, lecture colonnaire rapide)
    let tMin = Infinity, tMax = -Infinity;
    if (an.roles.time) {
      for (const [s, e] of ranges) {
        const rows = await readRows(s, e, [an.roles.time]);
        for (const r of rows) { const t = toSeconds(r[an.roles.time]); if (t != null) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; } }
        if (opts.onScan) await opts.onScan(e / total);
        if (opts.cancelled && opts.cancelled()) return info;
      }
    }
    if (!(tMax >= tMin)) { tMin = 0; tMax = Math.max(1, total / 1000); info.noTime = true; }
    info.tMin = tMin; info.tMax = tMax;
    opts.onInfo && opts.onInfo(info);

    const fd = ADSB.createFrameDecoder({ fix1: true });
    info.decoder = fd;
    for (const [s, e] of ranges) {
      if (opts.cancelled && opts.cancelled()) { info.cancelled = true; break; }
      const rows = await readRows(s, e, cols);
      for (let c0 = 0; c0 < rows.length; c0 += chunk) {
      const out = [], sub = rows.slice(c0, c0 + chunk);
      for (let i = 0; i < sub.length; i++) {
        const r = sub[i];
        let t = an.roles.time ? toSeconds(r[an.roles.time]) : null;
        t = t == null ? (info.noTime ? (s + c0 + i) / 1000 : null) : t - tMin;
        if (t == null) continue;
        const rssi = an.roles.rssi ? num(r[an.roles.rssi]) : null;
        if (an.mode === 'frames') {
          const m = fd.decode(r[an.roles.frame], t, { rssi });
          if (m) out.push(m);
        } else {
          const icao = icaoOf(r[an.roles.icao]); if (!icao) continue;
          out.push({ t, hex: '', df: null, icao, crc: 'état', rssi, snr: null, f: stateFields(r, an.roles, an.units) });
        }
      }
      if (opts.onRows) await opts.onRows(out, s + c0 + sub.length, total, fd.stats);
      if (opts.cancelled && opts.cancelled()) { info.cancelled = true; break; }
      }
      if (info.cancelled) break;
    }
    return info;
  }

  return { read, analyze, stateFields, toSeconds, icaoOf, ROLES };
});
