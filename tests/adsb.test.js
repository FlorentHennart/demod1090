/* Tests du démodulateur ADS-B : node tests/adsb.test.js
 *  1. CRC-24 et décodage sur des trames de référence publiques.
 *  2. Décodage CPR global (paire pair/impair).
 *  3. Aller-retour signal synthétique → démodulation à 2 / 2,4 / 4 / 8 MS/s :
 *     aucun faux aéronef, taux de décodage minimal, positions exactes.
 *  4. Formats d'échantillons (cs16 LE/BE, cu8, cs8, cf32) et en-tête WAV.
 */
const A = require('../adsb-core.js');
let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`); if (!cond) failures++; };
const dec = (h) => A.decodeFields(A.fromHex(h), A.fromHex(h)[0] >> 3);

// 1. -------------------------------------------------------------------
for (const h of ['8D4840D6202CC371C32CE0576098', '8D40621D58C382D690C8AC2863A7', '8D485020994409940838175B284F', '8DA05F219B06B6AF189400CBC33F'])
  check(`CRC nul ${h}`, A.residual(A.fromHex(h), 14) === 0);
check('Indicatif KLM1023', dec('8D4840D6202CC371C32CE0576098').callsign === 'KLM1023');
const v = dec('8D485020994409940838175B284F');
check('Vitesse sol 159 kt / route 182,9° / -832 ft/min', Math.round(v.gs) === 159 && Math.abs(v.track - 182.88) < 0.1 && v.vr === -832);
const v3 = dec('8DA05F219B06B6AF189400CBC33F');
check('Sous-type 3 : cap 244° / TAS 375 kt / -2304 ft/min', Math.round(v3.heading) === 244 && v3.tas === 375 && v3.vr === -2304);
check('Altitude baro 38 000 ft', dec('8D40621D58C382D690C8AC2863A7').alt === 38000);
const b = A.fromHex('8D4840D6202CC371C32CE0576098'); b[6] ^= 0x10;
check('Erreur 1 bit détectée (résidu non nul)', A.residual(b, 14) !== 0);

// 2. -------------------------------------------------------------------
const e = dec('8D40621D58C382D690C8AC2863A7').cpr, o = dec('8D40621D58C386435CC412692AD6').cpr;
const p = A.cprGlobal(e, o, false);
check('CPR global 52,2572 / 3,9194', Math.abs(p.lat - 52.2572) < 1e-4 && Math.abs(p.lon - 3.91937) < 1e-4, `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`);
for (const [lat, lon] of [[48.7, 2.35], [-33.9, 151.2], [64.1, -21.9]]) {
  const pe = A.cprEncode(lat, lon, 0), po = A.cprEncode(lat, lon, 1), g = A.cprGlobal(pe, po, true);
  check(`CPR aller-retour ${lat}, ${lon}`, A.distKm(g, { lat, lon }) < 0.01);
}
for (const sq of ['7700', '1200', '4567', '0000']) check(`Squawk ${sq}`, A.squawkFromId13(A.id13FromSquawk(sq)) === sq);
for (const alt of [-1000, 2500, 36000, 41025]) check(`Altitude AC13 ${alt}`, A.decodeAC13(A.decodeAC13 && ((n) => ((n & 0x7E0) << 2) | ((n & 0x10) << 1) | 0x10 | (n & 0xF))(Math.round((alt + 1000) / 25))) === alt);

// 3. -------------------------------------------------------------------
(async () => {
  for (const [fs, minRate] of [[2e6, 0.55], [2.4e6, 0.7], [4e6, 0.9], [8e6, 0.93]]) {
    const sc = A.demoScenario({ fs, duration: 4, seed: 11 }), out = [];
    await A.runJob(sc.source(), { fs }, (ev) => { if (ev.msgs) out.push(...ev.msgs); });
    const sent = new Map(sc.msgs.map((m) => [A.hex(m.bytes), m]));
    const icaos = new Set(sc.fleet.map((a) => a.icao.toString(16).toUpperCase().padStart(6, '0')));
    const ghosts = out.filter((m) => !icaos.has(m.icao));
    const rate = out.filter((m) => sent.has(m.hex)).length / sc.msgs.length;
    check(`${fs / 1e6} MS/s : aucun aéronef fantôme`, ghosts.length === 0, ghosts.map((m) => m.icao).join(','));
    check(`${fs / 1e6} MS/s : taux de décodage ≥ ${minRate * 100} %`, rate >= minRate, `${(rate * 100).toFixed(1)} %`);
    const tr = A.createTracker(sc.ref); out.forEach((m) => tr.update(m));
    let worst = 0, n = 0;
    for (const a of tr.ac.values()) for (const pt of a.trail) {
      const truth = sc.msgs.filter((m) => m.icao === parseInt(a.icao, 16) && m.kind.startsWith('pos')).reduce((best, m) => (Math.abs(m.t - pt.t) < Math.abs(best.t - pt.t) ? m : best));
      worst = Math.max(worst, A.distKm(truth.truth, pt)); n++;
    }
    check(`${fs / 1e6} MS/s : positions à moins de 20 m`, n > 0 && worst < 0.02, `${n} positions, écart max ${(worst * 1000).toFixed(1)} m`);
  }

  // 4. -----------------------------------------------------------------
  const iq = new Int16Array([3000, -4000, 0, 0, -32768, 0]);
  const m16 = A.toMagnitude(iq.buffer, 'cs16');
  check('cs16 : module', Math.abs(m16[0] - 5000 / 32768) < 1e-6 && m16[2] === 1);
  const be = new DataView(new ArrayBuffer(4)); be.setInt16(0, 3000, false); be.setInt16(2, -4000, false);
  check('cs16 gros-boutiste', Math.abs(A.toMagnitude(be.buffer, 'cs16be')[0] - 5000 / 32768) < 1e-6);
  check('cf32', Math.abs(A.toMagnitude(new Float32Array([0.3, 0.4]).buffer, 'cf32')[0] - 0.5) < 1e-6);
  check('cs8', Math.abs(A.toMagnitude(new Int8Array([30, -40]).buffer, 'cs8')[0] - 50 / 128) < 1e-6);
  const h = new DataView(new ArrayBuffer(44));
  [...'RIFF'].forEach((c, i) => h.setUint8(i, c.charCodeAt(0))); [...'WAVEfmt '].forEach((c, i) => h.setUint8(8 + i, c.charCodeAt(0)));
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true); h.setUint32(24, 2400000, true); h.setUint16(34, 16, true);
  [...'data'].forEach((c, i) => h.setUint8(36 + i, c.charCodeAt(0))); h.setUint32(40, 4000, true);
  const w = A.parseWav(h.buffer, 4044);
  check('WAV : cs16 à 2,4 MS/s, données à 44', w && w.format === 'cs16' && w.rate === 2400000 && w.dataOffset === 44);
  check('Nom de fichier : 2,4 MS/s', A.guessFromName('adsb_2.4Msps.cs16').rate === 2.4e6 && A.guessFromName('rec_fs2000000.bin').rate === 2e6);

  // MAT-file v5 (compressé, variable réelle N×2 int16 comme les exports MATLAB) + recherche de fréquence
  {
    const zlib = require('zlib'), fs = 8e6, sc = A.demoScenario({ fs, duration: 0.6, seed: 5 }), iq = sc.generate(0, sc.total), n = sc.total;
    const col = new Int16Array(2 * n); for (let i = 0; i < n; i++) { col[i] = iq[2 * i]; col[n + i] = iq[2 * i + 1]; }
    const el = (type, payload) => { const pad = (8 - payload.length % 8) % 8, h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(payload.length, 4); return Buffer.concat([h, payload, Buffer.alloc(pad)]); };
    const flags = Buffer.alloc(8); flags.writeUInt32LE(6, 0);
    const dims = Buffer.alloc(8); dims.writeInt32LE(n, 0); dims.writeInt32LE(2, 4);
    const body = Buffer.concat([el(6, flags), el(5, dims), el(1, Buffer.from('IQ')), el(3, Buffer.from(col.buffer))]);
    const z = zlib.deflateSync(el(14, body)), zh = Buffer.alloc(8); zh.writeUInt32LE(15, 0); zh.writeUInt32LE(z.length, 4);
    const head = Buffer.alloc(128, 32); head.write('MATLAB 5.0 MAT-file, test', 0); head.writeUInt16LE(0x0100, 124); head.write('IM', 126);
    const file = Buffer.concat([head, zh, z]);
    const m = await A.parseMat(file.buffer.slice(file.byteOffset, file.byteOffset + file.length));
    check('MAT v5 : variable IQ N×2 lue', m.name === 'IQ' && m.n === n && Math.abs(m.iq[2] - iq[2] / 32768) < 1e-7 && Math.abs(m.iq[3] - iq[3] / 32768) < 1e-7);
    const pr = await A.probeRate(A.arraySource(m.iq));
    const best = pr.sort((x, y) => y.count - x.count)[0];
    check('Recherche de fréquence : 8 MS/s retrouvée', best.fs === fs, `${best.fs / 1e6} MS/s, ${best.count} trames`);
  }

  // Parquet (fixtures générées avec hyparquet-writer 0.17.0 à partir du scénario synthétique)
  {
    const fsx = require('fs'), path = require('path'), T = require('../parquet.js');
    const H = new Function(fsx.readFileSync(path.join(__dirname, '../vendor/hyparquet.js'), 'utf8') + ';return Hyparquet;')();
    const load = async (name) => {
      const b = fsx.readFileSync(path.join(__dirname, 'fixtures', name)), ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
      const tr = A.createTracker(null), msgs = [];
      const info = await T.read({ Hyparquet: H, ADSB: A, file: { byteLength: ab.byteLength, slice: (x, y) => ab.slice(x, y) }, chunk: 250, onRows: (ms) => ms.forEach((m) => { msgs.push(m); tr.update(m); }) });
      return { info, tr, msgs };
    };
    const fr = await load('frames.parquet');
    check('Parquet trames : colonnes reconnues', fr.info.mode === 'frames' && fr.info.roles.frame === 'msg' && fr.info.roles.time === 'ts');
    check('Parquet trames : toutes décodées', fr.msgs.length === fr.info.total, `${fr.msgs.length}/${fr.info.total}`);
    const tvf = fr.tr.ac.get('3A1F7E');
    check('Parquet trames : indicatif, squawk et position', tvf && tvf.callsign === 'TVF72HM' && tvf.squawk === '7700' && tvf.lat != null);
    check('Parquet trames : horodatage 2026-11-01 10:00 UTC', Math.abs(fr.info.tMin - Date.UTC(2026, 10, 1, 10) / 1000) < 1);
    const st = await load('states.parquet');
    check('Parquet états : colonnes style readsb reconnues', st.info.mode === 'states' && st.info.roles.icao === 'hex' && st.info.roles.alt === 'alt_baro');
    const afr = st.tr.ac.get('3944F1');
    check('Parquet états : avion suivi avec trajectoire', afr && afr.callsign === 'AFR1047' && afr.alt === 36000 && afr.trail.length >= 4, afr && `${afr.trail.length} points`);
    const an = T.analyze(['icao24', 'time', 'lat', 'lon', 'baroaltitude', 'velocity', 'vertrate'], [{ icao24: '3c66b4', time: 1.7e9, lat: 48, lon: 2, baroaltitude: 10000, velocity: 230, vertrate: 5 }], A);
    const sf = T.stateFields({ icao24: '3c66b4', time: 1.7e9, lat: 48, lon: 2, baroaltitude: 10000, velocity: 230, vertrate: 5 }, an.roles, an.units);
    check('Parquet OpenSky : unités métriques converties', an.mode === 'states' && sf.alt === 32808 && Math.round(sf.gs) === 447 && sf.vr === 984, `${sf.alt} ft, ${sf.gs} kt, ${sf.vr} ft/min`);
  }

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
})();
