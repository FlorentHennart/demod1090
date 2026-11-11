/* Interface du démodulateur 1090 : sources, worker, carte, listes, vue signal. */
(function () {
  'use strict';
  const A = window.ADSB;
  const $ = (id) => document.getElementById(id);
  const nf = (x, d = 0) => (x == null || Number.isNaN(x)) ? '—' : x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } } };
  const EMG = { 7500: 'Intervention illicite', 7600: 'Panne radio', 7700: 'Urgence' };
  const MSG_CAP = 300000; // messages conservés pour la liste (au-delà : comptés et suivis, pas listés)
  // temps : secondes depuis le début, ou heure UTC pour les fichiers horodatés (Parquet)
  const fmtT = (t, d = 3) => S.epoch != null ? new Date((S.epoch + t) * 1000).toISOString().slice(11, d > 1 ? 23 : 19) : nf(t, d);
  const fmtSpan = (a) => S.epoch != null ? `${fmtT(a.first, 0)} → ${fmtT(a.last, 0)} UTC` : `${nf(a.first, 1)} → ${nf(a.last, 1)} s`;

  // ------------------------------------------------------------------ état
  const S = {
    job: null, worker: null, running: false, file: null, wav: null, demo: false,
    msgs: [], tracker: A.createTracker(null), duration: 0, fs: 2.4e6, total: 0, done: 0,
    stats: null, elapsed: 0, bins: new Uint32Array(120), binsEs: new Uint32Array(120),
    selected: null, sigIdx: -1, msgShown: 300, acShown: 120, tab: 'map', labels: true, mode: 'iq', epoch: null, table: null, msgCount: 0,
  };
  const els = {};
  ['file', 'drop', 'demo', 'fileinfo', 'fmt', 'rate', 'rateCustom', 'thr', 'thrOut', 'fix', 'rlat', 'rlon', 'run', 'stop', 'bar', 'ptext',
    'status', 'statusText', 'kDur', 'kDurSub', 'kMsg', 'kMsgSub', 'kAc', 'kAcSub', 'kPos', 'kPosSub', 'kRng', 'kRngSub', 'tl', 'tlScale',
    'cAc', 'cMsg', 'map', 'detail', 'acgrid', 'acSort', 'acHide', 'mq', 'mdf', 'msglist', 'copyAvr', 'copyFallback', 'sigpane', 'labels', 'fit', 'altgrad', 'fFmt', 'fRate', 'detect', 'kDurLbl']
    .forEach((k) => { els[k] = $(k); });

  // ------------------------------------------------------------------ couleurs (jetons CSS)
  let C = {};
  function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'surface', 'surface-2', 'line', 'fg', 'muted', 'accent', 'signal', 'ok', 'warn', 'crit', 'alt-l', 'land', 'coast']) C[k] = cs.getPropertyValue('--' + k).trim();
  }
  const altColor = (alt, onGround) => {
    if (onGround) return C.muted;
    const x = Math.max(0, Math.min(1, (alt ?? 0) / 40000));
    return `hsl(${Math.round(28 + x * 232)} 72% ${C['alt-l'] || '60%'})`;
  };
  function paintAltKey() {
    const stops = [0, .25, .5, .75, 1].map((x) => altColor(x * 40000)).join(',');
    els.altgrad.style.background = `linear-gradient(90deg, ${stops})`;
  }

  // ------------------------------------------------------------------ réglages
  function getRate() {
    if (els.rate.value === 'custom') return parseFloat(els.rateCustom.value) * 1e6;
    return +els.rate.value;
  }
  function setRate(r) {
    const opt = Array.from(els.rate.options).find((o) => +o.value === Math.round(r));
    if (opt) { els.rate.value = opt.value; els.rateCustom.hidden = true; } else { els.rate.value = 'custom'; els.rateCustom.hidden = false; els.rateCustom.value = +(r / 1e6).toFixed(4); }
  }
  els.rate.addEventListener('change', () => { els.rateCustom.hidden = els.rate.value !== 'custom'; if (!els.rateCustom.hidden) els.rateCustom.focus(); els.fRate.classList.remove('attn'); describeFile(); });
  els.rateCustom.addEventListener('input', describeFile);
  els.fmt.addEventListener('change', () => {
    els.fFmt.classList.remove('attn');
    if (S.mat && els.fmt.value !== 'mat') els.fmt.value = 'mat';
    if (S.table && els.fmt.value !== 'parquet') els.fmt.value = 'parquet';
    if (!S.mat && els.fmt.value === 'mat') els.fmt.value = 'cs16';
    if (!S.table && els.fmt.value === 'parquet') els.fmt.value = 'cs16';
    describeFile();
  });
  els.thr.addEventListener('input', () => { els.thrOut.textContent = `${els.thr.value.replace('.', ',')} dB`; });
  const savedRef = (store.get('adsb.ref') || '').split(',');
  if (savedRef.length === 2) { els.rlat.value = savedRef[0]; els.rlon.value = savedRef[1]; }
  function getRef() {
    const la = parseFloat(els.rlat.value), lo = parseFloat(els.rlon.value);
    return Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? { lat: la, lon: lo } : null;
  }
  for (const e of [els.rlat, els.rlon]) e.addEventListener('change', () => {
    const r = getRef();
    if (r) store.set('adsb.ref', `${r.lat},${r.lon}`);
    if (!S.demo) { S.tracker.setRef(r); fitMap(); scheduleRender(); }
  });

  // ------------------------------------------------------------------ fichier
  const fmtBytes = (n) => n >= 1e9 ? `${nf(n / 1e9, 2)} Go` : n >= 1e6 ? `${nf(n / 1e6, 1)} Mo` : `${nf(n / 1e3, 0)} ko`;
  const fmtDur = (s) => s >= 60 ? `${Math.floor(s / 60)} min ${nf(s % 60, 0)} s` : `${nf(s, s < 10 ? 2 : 1)} s`;

  function describeFile() {
    if (!S.file) { els.run.disabled = true; els.detect.disabled = true; return; }
    if (S.table) { describeTable(); return; }
    const f = S.file, fmt = A.FORMATS[els.fmt.value] ? els.fmt.value : 'cs16', fs = getRate();
    const nSamp = S.mat ? S.mat.n : (S.wav ? S.wav.dataSize : f.size) / A.FORMATS[fmt].bps;
    const dur = Number.isFinite(fs) && fs > 0 ? nSamp / fs : NaN;
    let notes = '';
    if (S.mat) notes = `<span class="note">MATLAB : variable « ${esc(S.mat.name)} » ${S.mat.dims.join('×')} ${S.mat.cls}${S.mat.complex ? ' complexe' : ''}, ${nf(S.mat.n)} échantillons IQ</span>`;
    if (S.autoRate) notes += `<span class="note">Fréquence détectée automatiquement : ${nf(S.autoRate.fs / 1e6, 2)} MS/s (${S.autoRate.count} trames valides à l’essai)</span>`;
    else if (S.mat && S.mat.rate) notes += `<span class="note">Fréquence lue dans le fichier : ${nf(S.mat.rate / 1e6, 3)} MS/s</span>`;
    else if (S.mat) { /* rien */ }
    else if (S.wav) notes = `<span class="note">En-tête WAV : ${S.wav.channels} voies, ${S.wav.bitsPerSample} bits, ${nf(S.wav.rate / 1e6, 3)} MS/s${S.wav.format ? '' : ' — format non pris en charge'}</span>`;
    else if (S.guess && !S.guess.rate) notes = '<span class="note warn">Fréquence d’échantillonnage introuvable dans le nom : vérifiez-la avant de lancer.</span>';
    else if (S.guess && S.guess.rate) notes = `<span class="note">Fréquence déduite du nom du fichier : ${nf(S.guess.rate / 1e6, 3)} MS/s</span>`;
    if (S.probeFailed) notes += '<span class="note warn">Aucune fréquence testée ne donne de trame valide : choisissez-la manuellement.</span>';
    if (Number.isFinite(fs) && fs < 2e6) notes += '<span class="note warn">Il faut au moins 2 MS/s pour séparer les demi-bits de 0,5 µs.</span>';
    els.fileinfo.innerHTML = `<b>${esc(f.name)}</b><span class="muted">${fmtBytes(f.size)}</span><span class="muted">${Number.isFinite(dur) ? '≈ ' + fmtDur(dur) + ' de signal' : ''}</span>${notes}`;
    els.run.disabled = S.running || !(fs >= 1.9e6);
    els.detect.disabled = S.running;
  }

  async function onFile(f) {
    if (!f) return;
    stopJob();
    S.file = f; S.wav = null; S.mat = null; S.table = null; S.mode = 'iq'; S.epoch = null; S.autoRate = null; S.probeFailed = false; S.guess = A.guessFromName(f.name); S.demo = false;
    els.fFmt.classList.remove('attn'); els.fRate.classList.remove('attn');
    els.run.textContent = 'Démoduler le fichier';
    let magic = '';
    try { magic = new TextDecoder('latin1').decode(new Uint8Array(await f.slice(0, 4).arrayBuffer())); } catch (e) { /* illisible */ }
    if (/\.parquet$/i.test(f.name) || magic === 'PAR1') { loadParquet(f); return; }
    if (S.guess.format === 'mat' || /\.mat$/i.test(f.name)) {
      setStatus('live', 'Lecture du fichier MATLAB…');
      els.fileinfo.innerHTML = `<b>${esc(f.name)}</b><span class="muted">${fmtBytes(f.size)}</span><span class="note">Lecture…</span>`;
      try {
        if (f.size > 600e6) throw new Error('Fichier .mat trop gros pour être chargé en mémoire (> 600 Mo) : exportez-le en binaire int16.');
        S.mat = await A.parseMat(await f.arrayBuffer());
      } catch (e) { setStatus('err', e.message); els.fileinfo.innerHTML = `<b>${esc(f.name)}</b><span class="note warn">${esc(e.message)}</span>`; S.file = null; return; }
      els.fmt.value = 'mat';
      if (S.mat.rate) { setRate(S.mat.rate); describeFile(); start(); } else { describeFile(); probe(); }
      return;
    }
    if (els.fmt.value === 'mat' || els.fmt.value === 'parquet') els.fmt.value = 'cs16';
    try { const head = await f.slice(0, 65536).arrayBuffer(); S.wav = A.parseWav(head, f.size); } catch (e) { S.wav = null; }
    if (S.wav) {
      if (S.wav.format) els.fmt.value = S.wav.format;
      setRate(S.wav.rate);
    } else {
      if (S.guess.format && S.guess.format !== 'wav') els.fmt.value = S.guess.format;
      else if (!S.guess.format) els.fmt.value = 'cs16';
      if (S.guess.rate) setRate(S.guess.rate); else els.fRate.classList.add('attn');
    }
    describeFile();
    // départ automatique si la configuration est certaine (WAV ou fréquence dans le nom), sinon recherche de la fréquence
    if ((S.wav && S.wav.format) || (!S.wav && S.guess.rate)) start();
    else if (!S.wav) probe();
    else setStatus('', 'Format WAV non pris en charge');
  }
  els.file.addEventListener('change', () => onFile(els.file.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); }));
  els.drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
  els.run.addEventListener('click', () => start());
  els.detect.addEventListener('click', () => probe());
  els.stop.addEventListener('click', () => stopJob(true));
  els.demo.addEventListener('click', () => startDemo());

  // ------------------------------------------------------------------ worker
  function workerMain() {
    let cancel = false;
    self.onmessage = async (e) => {
      const d = e.data;
      if (d.type === 'stop') { cancel = true; return; }
      cancel = false;
      try {
        const src = d.demo ? ADSB.demoScenario(d.demo).source() : d.array ? ADSB.arraySource(d.array) : ADSB.fileSource(d.file, d.format, d.offset, d.size);
        if (d.type === 'probe') {
          const res = await ADSB.probeRate(src, { onStep: async (f) => { self.postMessage({ type: 'probeProgress', f }); await new Promise((r) => setTimeout(r, 0)); } });
          self.postMessage({ type: 'probe', res }); return;
        }
        await ADSB.runJob(src, d.opts, (ev) => self.postMessage(ev), () => cancel);
      } catch (err) { self.postMessage({ type: 'error', message: String((err && err.message) || err) }); }
    };
  }
  function makeWorker() {
    try {
      const src = `const ADSB = (${A.factorySource})();\n(${workerMain.toString()})();`;
      return new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch (e) { return null; }
  }
  // repli : même traitement sur le fil principal (par morceaux)
  function makeInline() {
    let cancel = false; const w = { onmessage: null };
    w.postMessage = (d) => {
      if (d.type === 'stop') { cancel = true; return; }
      cancel = false;
      const emit = (ev) => w.onmessage && w.onmessage({ data: ev });
      const src = d.demo ? A.demoScenario(d.demo).source() : d.array ? A.arraySource(d.array) : A.fileSource(d.file, d.format, d.offset, d.size);
      if (d.type === 'probe') {
        A.probeRate(src, { onStep: async (f) => { emit({ type: 'probeProgress', f }); await new Promise((r) => setTimeout(r, 0)); } })
          .then((res) => emit({ type: 'probe', res }), (err) => emit({ type: 'error', message: String(err.message || err) }));
        return;
      }
      A.runJob(src, d.opts, (ev) => w.onmessage && w.onmessage({ data: ev }), () => cancel)
        .catch((err) => w.onmessage && w.onmessage({ data: { type: 'error', message: String(err.message || err) } }));
    };
    w.terminate = () => { cancel = true; };
    return w;
  }

  function resetResults(fs, total, ref) {
    S.msgs = []; S.msgCount = 0; S.epoch = null; S.acShown = 120; S.tracker = A.createTracker(ref); S.fs = fs; S.total = total; S.duration = total / fs; S.done = 0;
    S.bins.fill(0); S.binsEs.fill(0); S.selected = null; S.sigIdx = -1; S.msgShown = 300; S.stats = null; S.elapsed = 0;
    view.fitted = false; view.user = false;
  }
  function launch(job, fs, total, ref) {
    stopJob();
    resetResults(fs, total, ref); S.mode = 'iq';
    let w = makeWorker();
    const go = (wk) => {
      S.worker = wk; S.running = true;
      wk.onmessage = (e) => onEvent(e.data);
      wk.onerror = (e) => {
        if (wk.__fallbackTried) return;
        e.preventDefault && e.preventDefault();
        wk.terminate();
        const inl = makeInline(); inl.__fallbackTried = true; go(inl); inl.postMessage(job);
      };
      wk.postMessage(job);
    };
    go(w || makeInline());
    els.stop.hidden = false; els.run.disabled = true;
    setStatus('live', S.demo ? 'Démodulation de la démo…' : 'Démodulation…');
    scheduleRender();
  }
  function start() {
    if (!S.file) return;
    if (S.table) { loadParquet(S.file); return; }
    const fs = getRate(), fmt = els.fmt.value;
    if (!(fs >= 1.9e6)) { els.fRate.classList.add('attn'); return; }
    S.demo = false;
    S.sourceLabel = S.file.name;
    if (S.mat) { launch({ type: 'start', array: S.mat.iq, opts: opts(fs) }, fs, S.mat.n, getRef()); return; }
    const offset = S.wav ? S.wav.dataOffset : 0, size = S.wav ? S.wav.dataSize : S.file.size;
    const total = Math.floor(size / A.FORMATS[fmt].bps);
    launch({ type: 'start', file: S.file, format: fmt, offset, size, opts: opts(fs) }, fs, total, getRef());
  }
  // ------------------------------------------------------------------ fichiers Parquet (trames ou états décodés)
  const ROLE_FR = { frame: 'trames', icao: 'ICAO', callsign: 'indicatif', lat: 'latitude', lon: 'longitude', alt: 'altitude', altGnss: 'alt. GNSS', gs: 'vitesse', track: 'route', heading: 'cap', vr: 'vario', squawk: 'squawk', time: 'temps', rssi: 'niveau', ground: 'au sol', category: 'catégorie' };
  function describeTable() {
    const f = S.file, i = S.table.info;
    let html = `<b>${esc(f.name)}</b><span class="muted">${fmtBytes(f.size)}</span>`;
    if (!i) { els.fileinfo.innerHTML = html + '<span class="note">Lecture de l’en-tête Parquet…</span>'; return; }
    html += `<span class="muted">${nf(i.total)} lignes${i.tMax > i.tMin && !i.noTime ? ' · ' + fmtDur(i.tMax - i.tMin) : ''}</span>`;
    const mapped = Object.entries(i.roles || {}).map(([k, c]) => `${ROLE_FR[k] || k} = <code>${esc(c)}</code>`).join(', ');
    if (i.mode === 'frames') html += `<span class="note">Parquet de <b>trames Mode S</b> : décodage CRC et CPR comme pour un signal IQ. Colonnes : ${mapped}</span>`;
    else if (i.mode === 'states') html += `<span class="note">Parquet de <b>positions déjà décodées</b>${i.units && i.units.alt === 'metric' ? ' (unités métriques converties)' : ''}. Colonnes : ${mapped}</span>`;
    else html += `<span class="note warn">${esc(i.error || '')} Colonnes présentes : ${i.names.map((n) => '<code>' + esc(n) + '</code>').join(', ')}</span>`;
    if (i.noTime && i.mode) html += '<span class="note warn">Aucune colonne de temps reconnue : ordre des lignes utilisé.</span>';
    els.fileinfo.innerHTML = html;
    els.run.disabled = S.running; els.detect.disabled = true;
  }
  async function loadParquet(f) {
    stopJob();
    const H = window.Hyparquet, T = window.ADSBTable;
    S.file = f; S.wav = null; S.mat = null; S.demo = false; S.autoRate = null; S.probeFailed = false;
    S.table = { info: null }; S.mode = 'table'; S.sourceLabel = f.name;
    els.fmt.value = 'parquet'; els.fFmt.classList.remove('attn'); els.fRate.classList.remove('attn');
    if (!H || !T) { setStatus('err', 'Lecteur Parquet non chargé'); return; }
    resetResults(1, 0, getRef());
    S.mode = 'table'; S.epoch = null; S.tracker.trailStep = 5;
    describeTable();
    let cancel = false;
    S.worker = { postMessage: (d) => { if (d.type === 'stop') cancel = true; }, terminate: () => { cancel = true; } };
    S.running = true; els.stop.hidden = false; els.run.disabled = true; els.detect.disabled = true;
    setStatus('live', 'Lecture du fichier Parquet…');
    const t0 = performance.now();
    const pause = () => new Promise((r) => setTimeout(r, 0));
    try {
      const info = await T.read({
        Hyparquet: H, ADSB: A, file: f, chunk: 40000, cancelled: () => cancel,
        onScan: async (p) => { els.bar.style.width = `${(p * 100).toFixed(0)}%`; els.ptext.textContent = `repérage des horodatages · ${Math.round(p * 100)} %`; await pause(); },
        onInfo: (i) => {
          S.table.info = i;
          if (i.mode) { S.total = i.total; S.duration = Math.max(1e-3, i.tMax - i.tMin); S.epoch = i.noTime ? null : i.tMin; S.fs = 1; }
          describeTable();
        },
        onRows: async (msgs, done, total, st) => {
          for (const m of msgs) addMsg(m);
          S.done = done; S.elapsed = (performance.now() - t0) / 1000;
          S.stats = S.table.info.mode === 'frames' ? st : { fixed: 0, byDf: {}, rows: done };
          scheduleRender(); await pause();
        },
      });
      S.running = false; S.worker = null; els.stop.hidden = true; describeTable();
      if (!info.mode) { setStatus('err', 'Colonnes Parquet non reconnues'); render(); return; }
      els.run.textContent = 'Relire';
      const ac = visibleAircraft().length;
      setStatus('done', `${info.cancelled ? 'Arrêté' : 'Terminé'} · ${nf(S.msgCount)} ${info.mode === 'frames' ? 'messages' : 'états'} · ${nf(ac)} aéronef${ac > 1 ? 's' : ''}`);
      if (!S.selected) { const top = visibleAircraft().filter((a) => a.lat != null).sort((a, b) => b.msgs - a.msgs)[0]; if (top) S.selected = top.icao; }
      render();
    } catch (e) {
      S.running = false; S.worker = null; els.stop.hidden = true;
      setStatus('err', 'Parquet illisible : ' + (e && e.message ? e.message : e));
      els.fileinfo.innerHTML = `<b>${esc(f.name)}</b><span class="note warn">${esc(e && e.message ? e.message : String(e))}</span>`;
    }
  }

  // recherche automatique de la fréquence d'échantillonnage (essais sur le début du signal)
  function probe() {
    if (!S.file) return;
    stopJob();
    const fmt = els.fmt.value;
    const job = S.mat ? { type: 'probe', array: S.mat.iq } : { type: 'probe', file: S.file, format: fmt, offset: S.wav ? S.wav.dataOffset : 0, size: S.wav ? S.wav.dataSize : S.file.size };
    const wk = makeWorker() || makeInline();
    S.worker = wk; S.running = true; S.autoRate = null; S.probeFailed = false;
    els.run.disabled = true; els.detect.disabled = true; els.stop.hidden = false;
    setStatus('live', 'Recherche de la fréquence d’échantillonnage…');
    wk.onmessage = (e) => {
      const ev = e.data;
      if (ev.type === 'probeProgress') { els.bar.style.width = `${(ev.f * 100).toFixed(0)}%`; els.ptext.textContent = `essai des fréquences · ${Math.round(ev.f * 100)} %`; return; }
      try { wk.terminate(); } catch (x) { /* rien */ }
      S.worker = null; S.running = false; els.stop.hidden = true; els.detect.disabled = false;
      if (ev.type === 'error') { setStatus('err', 'Erreur : ' + ev.message); describeFile(); return; }
      const best = ev.res.slice().sort((a, b) => b.count - a.count)[0];
      if (best && best.count >= 2) {
        S.autoRate = best; setRate(best.fs); els.fRate.classList.remove('attn'); describeFile(); start();
      } else {
        S.probeFailed = true; els.fRate.classList.add('attn'); describeFile();
        setStatus('', 'Fréquence introuvable : choisissez-la puis lancez');
      }
    };
    wk.onerror = (e) => {
      if (wk.__inline) return;
      e.preventDefault && e.preventDefault();
      try { wk.terminate(); } catch (x) { /* rien */ }
      const inl = makeInline(); inl.__inline = true; inl.onmessage = wk.onmessage; S.worker = inl; inl.postMessage(job);
    };
    wk.postMessage(job);
  }
  function startDemo() {
    S.demo = true; S.file = null; S.wav = null; S.mat = null; S.table = null; S.mode = 'iq'; S.autoRate = null; S.probeFailed = false;
    const cfg = { fs: 2.4e6, duration: 12, seed: 7 };
    const sc = A.demoScenario(cfg);
    els.fmt.value = 'cs16'; setRate(cfg.fs); els.fFmt.classList.remove('attn'); els.fRate.classList.remove('attn');
    els.fileinfo.innerHTML = `<b>Démonstration synthétique</b><span class="muted">7 aéronefs simulés autour d’Orly · 12 s à 2,4 MS/s · bruit gaussien, cs16</span><span class="note">Exemple généré dans le navigateur, pas une vraie capture.</span>`;
    els.run.disabled = true;
    S.sourceLabel = 'Démo';
    launch({ type: 'start', demo: cfg, opts: opts(cfg.fs) }, cfg.fs, sc.total, sc.ref);
  }
  const opts = (fs) => ({ fs, thresholdDb: +els.thr.value, fix1: els.fix.checked, snippets: 3000 });
  function stopJob(user) {
    if (S.worker) {
      if (user) { S.worker.postMessage({ type: 'stop' }); return; }
      try { S.worker.terminate(); } catch (e) { /* déjà arrêté */ }
      S.worker = null;
    }
    S.running = false; els.stop.hidden = true; els.detect.disabled = !S.file; describeFile();
  }

  function onEvent(ev) {
    if (ev.type === 'error') {
      S.running = false; els.stop.hidden = true; describeFile();
      setStatus('err', 'Erreur : ' + ev.message); return;
    }
    if (ev.msgs) for (const m of ev.msgs) addMsg(m);
    S.done = ev.done; S.stats = ev.stats; S.elapsed = ev.elapsed;
    if (ev.type === 'done') {
      S.running = false; els.stop.hidden = true;
      try { S.worker && S.worker.terminate(); } catch (e) { /* rien */ }
      S.worker = null; describeFile();
      if (S.file) els.run.textContent = 'Relancer';
      const ac = visibleAircraft().length;
      setStatus('done', `${ev.cancelled ? 'Arrêté' : 'Terminé'} · ${nf(S.msgCount)} messages · ${ac} aéronef${ac > 1 ? 's' : ''}`);
      if (!S.selected) { const top = visibleAircraft().filter((a) => a.lat != null).sort((a, b) => b.msgs - a.msgs)[0]; if (top) S.selected = top.icao; }
      if (S.sigIdx < 0 && S.msgs.length) S.sigIdx = Math.max(0, S.msgs.findIndex((m) => m.df === 17 && m.snip));
    }
    scheduleRender();
  }
  function addMsg(m) {
    S.msgCount++;
    if (S.msgs.length < MSG_CAP) { m.i = S.msgs.length; S.msgs.push(m); }
    S.tracker.update(m);
    const b = Math.max(0, Math.min(S.bins.length - 1, Math.floor(m.t / S.duration * S.bins.length)));
    if (m.df === 17 || m.df === 18 || m.df == null) S.binsEs[b]++; else S.bins[b]++;
  }
  function setStatus(kind, text) { els.status.className = 'chip ' + (kind || ''); els.statusText.textContent = text; }

  // ------------------------------------------------------------------ rendu (limité à ~6 images/s pendant le calcul)
  let rq = null, lastRender = 0;
  function scheduleRender() {
    if (rq) return;
    rq = requestAnimationFrame(() => {
      rq = null;
      const now = performance.now();
      const gap = S.mode === 'table' ? Math.min(1500, 200 + S.tracker.ac.size / 5) : 160; // rafraîchissement espacé pour les gros fichiers
      if (S.running && now - lastRender < gap) { scheduleRender(); return; }
      lastRender = now; render();
    });
  }
  function render() {
    renderProgress(); renderKpis(); drawTimeline();
    if (S.tab === 'map') { drawMap(); renderDetail(); }
    if (S.tab === 'ac') renderAircraft();
    if (S.tab === 'msg') renderMessages();
    if (S.tab === 'sig') renderSignal();
    els.cAc.textContent = visibleAircraft().length || '';
    els.cMsg.textContent = S.msgCount ? (S.msgCount > 9999 ? nf(S.msgCount / 1000, 0) + 'k' : S.msgCount) : '';
    els.cAc.textContent = (() => { const n = visibleAircraft().length; return n ? (n > 9999 ? nf(n / 1000, 0) + 'k' : n) : ''; })();
  }
  function renderProgress() {
    const p = S.total ? S.done / S.total : 0;
    els.bar.style.width = `${(p * 100).toFixed(1)}%`;
    if (S.mode === 'table') { els.ptext.textContent = S.total ? `${Math.round(p * 100)} % · ${nf(S.done)} / ${nf(S.total)} lignes` : ''; return; }
    const rt = S.elapsed > 0 ? (S.done / S.fs) / S.elapsed : 0;
    els.ptext.textContent = S.total ? `${Math.round(p * 100)} %${rt ? ` · ×${nf(rt, rt < 10 ? 1 : 0)} temps réel` : ''}` : '';
  }
  function visibleAircraft() {
    const all = Array.from(S.tracker.ac.values());
    return els.acHide.checked ? all.filter((a) => a.msgs >= 2) : all;
  }
  function renderKpis() {
    const st = S.stats, done = S.done / S.fs, tbl = S.mode === 'table', info = tbl && S.table && S.table.info;
    els.kDurLbl.textContent = tbl ? 'Période couverte' : 'Signal analysé';
    if (tbl) {
      els.kDur.innerHTML = info && info.mode ? (S.duration >= 120 ? `${nf(S.duration / 60, 0)}<small>min</small>` : `${nf(S.duration, 1)}<small>s</small>`) : '—';
      els.kDurSub.textContent = info && info.mode ? (S.epoch != null ? `${new Date(S.epoch * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC · Parquet` : 'Parquet') : '\u00a0';
      els.kMsg.textContent = st ? nf(S.msgCount) : '—';
      els.kMsgSub.textContent = st ? (info.mode === 'frames' ? `${nf(st.frames ? 100 * st.valid / st.frames : 0, 1)} % des trames valides · ${nf(st.fixed)} corrigées` : `états sur ${nf(S.done)} lignes lues`) : '\u00a0';
    } else {
      els.kDur.innerHTML = S.total ? `${nf(done, done < 100 ? 1 : 0)}<small>s</small>` : '—';
      els.kDurSub.textContent = S.total ? `sur ${fmtDur(S.duration)} · ${nf(S.fs / 1e6, 2)} MS/s` : '\u00a0';
      els.kMsg.textContent = st ? nf(S.msgCount) : '—';
      els.kMsgSub.textContent = st ? `${nf(done > 0 ? S.msgCount / done : 0, 1)} msg/s · ${nf(st.fixed)} corrigés` : '\u00a0';
    }
    const ac = visibleAircraft();
    els.kAc.textContent = st ? nf(ac.length) : '—';
    const withPos = ac.filter((a) => a.lat != null).length, withCs = ac.filter((a) => a.callsign).length;
    els.kAcSub.textContent = st ? `${withCs} identifiés · ${withPos} positionnés` : '\u00a0';
    els.kPos.textContent = st ? nf(S.tracker.positions) : '—';
    const es = st ? (st.byDf[17] || 0) + (st.byDf[18] || 0) : 0;
    els.kPosSub.textContent = st ? (tbl && info.mode === 'states' ? 'positions fournies par le fichier' : `${nf(es)} trames ADS-B`) : '\u00a0';
    const r = S.tracker.maxRangeKm;
    els.kRng.innerHTML = S.tracker.ref && r ? `${nf(r / 1.852, 0)}<small>NM</small>` : '—';
    els.kRngSub.textContent = S.tracker.ref ? (r ? `${nf(r, 0)} km du récepteur` : 'aucune position') : 'renseignez le récepteur';
  }

  // ------------------------------------------------------------------ canvas utilitaire
  function fitCanvas(cv, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = cssW ?? cv.clientWidth, h = cssH ?? cv.clientHeight;
    if (cssW != null) cv.style.width = w + 'px';
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function drawTimeline() {
    const { g, w, h } = fitCanvas(els.tl);
    const n = S.bins.length, bw = w / n, top = 4, base = h - 16;
    let mx = 1; for (let i = 0; i < n; i++) mx = Math.max(mx, S.bins[i] + S.binsEs[i]);
    g.strokeStyle = C.line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, base + 0.5); g.lineTo(w, base + 0.5); g.stroke();
    for (let i = 0; i < n; i++) {
      const he = (S.binsEs[i] / mx) * (base - top), ho = (S.bins[i] / mx) * (base - top);
      g.fillStyle = C.accent; g.fillRect(i * bw + 0.5, base - he, Math.max(1, bw - 1), he);
      g.fillStyle = C.signal; g.fillRect(i * bw + 0.5, base - he - ho, Math.max(1, bw - 1), ho);
    }
    if (S.total && S.done < S.total) { g.fillStyle = C['surface-2']; g.globalAlpha = 0.6; g.fillRect(w * S.done / S.total, top, w, base - top); g.globalAlpha = 1; }
    g.fillStyle = C.muted; g.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--f-mono');
    g.textBaseline = 'bottom';
    if (S.duration) {
      const step = niceStep(S.duration / 6);
      for (let t = 0; t <= S.duration + 1e-9; t += step) {
        const x = t / S.duration * w;
        g.textAlign = x < 20 ? 'left' : x > w - 20 ? 'right' : 'center';
        g.fillText(S.epoch != null ? fmtT(t, 0).slice(0, S.duration > 600 ? 5 : 8) : `${nf(t, step < 1 ? 1 : 0)} s`, x, h);
      }
    }
    const binDur = S.duration / n;
    els.tlScale.textContent = S.duration ? `pic ${nf(mx / binDur, mx / binDur < 10 ? 1 : 0)} msg/s` : '';
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }

  // ------------------------------------------------------------------ carte
  const view = { lat: 48.7, lon: 2.4, k: 60, fitted: false, user: false };
  const proj = (lat, lon, w, h) => [w / 2 + (lon - view.lon) * Math.cos(view.lat * Math.PI / 180) * view.k, h / 2 - (lat - view.lat) * view.k];
  const unproj = (x, y, w, h) => [view.lat - (y - h / 2) / view.k, view.lon + (x - w / 2) / (view.k * Math.cos(view.lat * Math.PI / 180))];
  function fitMap() {
    const pts = [];
    for (const a of S.tracker.ac.values()) for (const p of a.trail) pts.push(p);
    const hasAc = pts.length > 0;
    if (S.tracker.ref) pts.push(S.tracker.ref);
    if (!pts.length) return false;
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of pts) { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); }
    const w = els.map.clientWidth || 600, h = els.map.clientHeight || 400;
    view.lat = (la0 + la1) / 2; view.lon = (lo0 + lo1) / 2;
    const cl = Math.cos(view.lat * Math.PI / 180);
    const kx = (w - 90) / Math.max((lo1 - lo0) * cl, 0.05), ky = (h - 90) / Math.max(la1 - la0, 0.05);
    view.k = Math.min(kx, ky, 4000);
    view.fitted = hasAc; return true;
  }
  els.fit.addEventListener('click', () => { view.user = false; fitMap(); drawMap(); });
  els.labels.addEventListener('click', () => { S.labels = !S.labels; els.labels.setAttribute('aria-pressed', S.labels); drawMap(); });

  function planePath(g, x, y, ang, s) {
    g.save(); g.translate(x, y); g.rotate(ang * Math.PI / 180); g.scale(s, s);
    g.beginPath();
    g.moveTo(0, -9); g.lineTo(1.6, -4); g.lineTo(9, 1.5); g.lineTo(9, 3.2); g.lineTo(1.6, 1); g.lineTo(1.2, 6); g.lineTo(3.6, 8.2); g.lineTo(3.6, 9.4);
    g.lineTo(0, 8.4); g.lineTo(-3.6, 9.4); g.lineTo(-3.6, 8.2); g.lineTo(-1.2, 6); g.lineTo(-1.6, 1); g.lineTo(-9, 3.2); g.lineTo(-9, 1.5); g.lineTo(-1.6, -4); g.closePath();
    g.restore();
  }
  function drawMap() {
    const cv = els.map; if (!cv.clientWidth) return;
    if (!view.user) fitMap();
    const { g, w, h } = fitCanvas(cv);
    const mono = '11px "IBM Plex Mono", ui-monospace, monospace';
    g.fillStyle = C['surface-2']; g.fillRect(0, 0, w, h);
    // terres émergées (Natural Earth 110m)
    if (window.ADSB_LAND) {
      const [la0, lo0] = unproj(0, 0, w, h), [la1, lo1] = unproj(w, h, w, h);
      g.beginPath();
      for (const ring of window.ADSB_LAND) {
        let vis = false;
        for (let i = 0; i < ring.length; i += 3) { const [x, y] = ring[i]; if (y <= la0 + 8 && y >= la1 - 8 && x >= lo0 - 15 && x <= lo1 + 15) { vis = true; break; } }
        if (!vis) continue;
        for (let i = 0; i < ring.length; i++) { const [px, py] = proj(ring[i][1], ring[i][0], w, h); if (i) g.lineTo(px, py); else g.moveTo(px, py); }
        g.closePath();
      }
      g.fillStyle = C.land; g.fill('evenodd'); g.strokeStyle = C.coast; g.lineWidth = 0.8; g.stroke();
    }
    // graticule
    const [laTop, loLeft] = unproj(0, 0, w, h), [laBot, loRight] = unproj(w, h, w, h);
    const step = niceStep((laTop - laBot) / 5);
    g.strokeStyle = C.line; g.lineWidth = 1; g.fillStyle = C.muted; g.font = mono;
    const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    g.textBaseline = 'top'; g.textAlign = 'left';
    for (let la = Math.ceil(Math.max(-90, laBot) / step) * step; la <= Math.min(90, laTop); la += step) {
      const [, y] = proj(la, view.lon, w, h); g.beginPath(); g.moveTo(0, Math.round(y) + .5); g.lineTo(w, Math.round(y) + .5); g.stroke();
      g.fillText(`${nf(Math.abs(la), dec)}°${la >= 0 ? 'N' : 'S'}`, 6, y + 3);
    }
    const lstep = niceStep((loRight - loLeft) / 5);
    const ldec = lstep < 0.1 ? 2 : lstep < 1 ? 1 : 0;
    g.textBaseline = 'bottom';
    for (let lo = Math.ceil(loLeft / lstep) * lstep; lo <= loRight; lo += lstep) {
      const [x] = proj(view.lat, lo, w, h); g.beginPath(); g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, h); g.stroke();
      g.fillText(`${nf(Math.abs(lo), ldec)}°${lo >= 0 ? 'E' : 'O'}`, x + 4, h - 4);
    }
    // cercles de distance autour du récepteur
    const ref = S.tracker.ref;
    if (ref) {
      const [rx, ry] = proj(ref.lat, ref.lon, w, h);
      const pxPerNm = view.k / 60;
      const ringStep = niceStep(Math.max(w, h) / pxPerNm / 6);
      g.setLineDash([4, 5]); g.strokeStyle = C.muted; g.globalAlpha = 0.55;
      for (let nm = ringStep; nm * pxPerNm < Math.hypot(w, h); nm += ringStep) {
        g.beginPath(); g.arc(rx, ry, nm * pxPerNm, 0, Math.PI * 2); g.stroke();
      }
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = C.muted; g.textBaseline = 'bottom'; g.textAlign = 'left';
      for (let nm = ringStep; nm * pxPerNm < Math.hypot(w, h); nm += ringStep) g.fillText(`${nf(nm)} NM`, rx + nm * pxPerNm * 0.707 + 3, ry - nm * pxPerNm * 0.707 - 2);
      g.fillStyle = C.fg; g.beginPath(); g.moveTo(rx, ry - 7); g.lineTo(rx + 6, ry + 5); g.lineTo(rx - 6, ry + 5); g.closePath(); g.fill();
      g.strokeStyle = C['surface-2']; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
    }
    // traces
    const inView = (a) => { const [x, y] = proj(a.lat, a.lon, w, h); return x > -60 && x < w + 60 && y > -60 && y < h + 60; };
    const list = visibleAircraft().filter((a) => a.trail.length && a.lat != null && (inView(a) || S.selected === a.icao));
    const crowded = list.length > 250;
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const a of list) {
      const sel = S.selected === a.icao;
      g.lineWidth = sel ? 3.5 : crowded ? 1.2 : 2;
      if (crowded && !sel) { // une seule couleur par trace quand la carte est chargée
        g.strokeStyle = altColor(a.alt, a.onGround); g.globalAlpha = 0.7; g.beginPath();
        a.trail.forEach((q, i) => { const [x, y] = proj(q.lat, q.lon, w, h); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke(); g.globalAlpha = 1; continue;
      }
      for (let i = 1; i < a.trail.length; i++) {
        const p = a.trail[i - 1], q = a.trail[i];
        const [x0, y0] = proj(p.lat, p.lon, w, h), [x1, y1] = proj(q.lat, q.lon, w, h);
        g.strokeStyle = altColor(q.alt, a.onGround); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      if (a.trail.length === 1) { const [x, y] = proj(a.trail[0].lat, a.trail[0].lon, w, h); g.fillStyle = altColor(a.alt); g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
    }
    // avions
    S.hit = [];
    for (const a of list) {
      const [x, y] = proj(a.lat, a.lon, w, h), sel = S.selected === a.icao;
      const emg = EMG[a.squawk] || a.emergency;
      if (sel) { g.strokeStyle = C.accent; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 17, 0, 7); g.stroke(); }
      if (emg) { g.strokeStyle = C.crit; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 13, 0, 7); g.stroke(); }
      planePath(g, x, y, a.track ?? a.heading ?? 0, sel ? 1.25 : crowded ? 0.7 : 1.05);
      g.fillStyle = altColor(a.alt, a.onGround); g.fill(); g.lineWidth = 1.5; g.strokeStyle = C['surface-2']; g.stroke();
      S.hit.push({ x, y, icao: a.icao });
      if ((S.labels && list.length <= 60) || sel) {
        const l1 = a.callsign || a.icao, l2 = `${a.alt != null ? (a.alt >= 10000 ? 'FL' + String(Math.round(a.alt / 100)).padStart(3, '0') : nf(a.alt) + ' ft') : '—'}${a.gs != null ? ' · ' + Math.round(a.gs) + ' kt' : ''}`;
        g.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
        const tw = Math.max(g.measureText(l1).width, (g.font = mono, g.measureText(l2).width)) + 10;
        const bx = x + 14, by = y - 24;
        g.fillStyle = C.surface; g.globalAlpha = 0.92; g.fillRect(bx, by, tw, 32); g.globalAlpha = 1;
        g.strokeStyle = emg ? C.crit : sel ? C.accent : C.line; g.lineWidth = 1; g.strokeRect(bx + .5, by + .5, tw - 1, 31);
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.fillStyle = C.fg; g.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; g.fillText(l1, bx + 5, by + 3);
        g.fillStyle = C.muted; g.font = mono; g.fillText(l2, bx + 5, by + 17);
      }
    }
    if (!list.length) {
      g.fillStyle = C.muted; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '14px "IBM Plex Sans", system-ui, sans-serif';
      const noPos = visibleAircraft().length;
      g.fillText(S.running ? 'En attente de positions…' : noPos ? 'Aucune position décodée (il faut une paire de trames CPR pair/impair)' : 'Aucun aéronef pour l’instant', w / 2, h / 2);
    }
  }
  // interactions carte : glisser, pincer, molette, toucher
  (function mapInput() {
    const cv = els.map, pts = new Map();
    let moved = 0, pinch = null;
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); moved = 0; if (pts.size === 2) pinch = null; cv.style.cursor = 'grabbing'; });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId), w = cv.clientWidth, h = cv.clientHeight;
      if (pts.size === 1) {
        const dx = e.offsetX - p.x, dy = e.offsetY - p.y; moved += Math.abs(dx) + Math.abs(dy);
        view.lat += dy / view.k; view.lon -= dx / (view.k * Math.cos(view.lat * Math.PI / 180));
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()]; const other = a === p ? b : a;
        const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.offsetX - other.x, e.offsetY - other.y);
        if (d0 > 0) zoomAt((e.offsetX + other.x) / 2, (e.offsetY + other.y) / 2, d1 / d0, w, h);
        moved += 10;
      }
      p.x = e.offsetX; p.y = e.offsetY; if (moved > 4) view.user = true; drawMap();
    });
    const up = (e) => {
      if (pts.size === 1 && moved < 6) pick(e.offsetX, e.offsetY);
      pts.delete(e.pointerId); cv.style.cursor = 'grab';
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
    cv.addEventListener('wheel', (e) => { e.preventDefault(); view.user = true; zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015), cv.clientWidth, cv.clientHeight); drawMap(); }, { passive: false });
    cv.addEventListener('dblclick', () => { view.user = false; fitMap(); drawMap(); });
    function zoomAt(x, y, f, w, h) {
      const [la, lo] = unproj(x, y, w, h);
      view.k = Math.max(2, Math.min(20000, view.k * f));
      const [la2, lo2] = unproj(x, y, w, h);
      view.lat += la - la2; view.lon += lo - lo2;
    }
    function pick(x, y) {
      let best = null, bd = 26;
      for (const p of S.hit || []) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p.icao; } }
      S.selected = best; drawMap(); renderDetail();
    }
  })();

  function renderDetail() {
    const a = S.selected && S.tracker.ac.get(S.selected);
    if (!a) {
      const n = visibleAircraft().length;
      els.detail.innerHTML = `<h3 style="font-size:22px">Fiche aéronef</h3><p class="empty">${n ? 'Touchez un avion sur la carte ou une carte de l’onglet Aéronefs pour afficher ses paramètres décodés.' : 'Les aéronefs apparaîtront ici dès que des messages valides seront décodés.'}</p>`;
      return;
    }
    const emg = EMG[a.squawk] || a.emergency;
    const dfs = Object.entries(a.df).map(([d, n]) => `${d === 'état' ? 'états' : 'DF' + d} ×${n}`).join(' · ');
    els.detail.innerHTML = `
      <div class="dhead"><div><h3>${esc(a.callsign || a.icao)}</h3><div class="mono muted" style="font-size:13px">ICAO ${a.icao}${a.catCode ? ' · ' + a.catCode : ''}</div></div>
      ${a.squawk ? `<span class="sq ${emg ? 'emg' : ''}">${a.squawk}${emg ? ' · ' + esc(emg) : ''}</span>` : ''}</div>
      ${a.category ? `<div class="muted" style="font-size:13.5px">${esc(a.category)}${a.version != null ? ' · ADS-B v' + a.version : ''}</div>` : ''}
      <dl class="dl">
        <div><dt>Altitude baro</dt><dd>${a.alt != null ? nf(a.alt) + ' ft' : '—'}</dd></div>
        <div><dt>Altitude GNSS</dt><dd>${a.altGnss != null ? nf(a.altGnss) + ' ft' : '—'}</dd></div>
        <div><dt>Vitesse sol</dt><dd>${a.gs != null ? nf(a.gs) + ' kt' : '—'}</dd></div>
        <div><dt>Route</dt><dd>${a.track != null ? nf(a.track) + '°' : a.heading != null ? 'cap ' + nf(a.heading) + '°' : '—'}</dd></div>
        <div><dt>Vario</dt><dd>${a.vr != null ? (a.vr > 0 ? '+' : '') + nf(a.vr) + ' ft/min' : '—'}</dd></div>
        <div><dt>IAS / TAS</dt><dd>${a.ias != null ? a.ias + ' kt' : '—'} / ${a.tas != null ? a.tas + ' kt' : '—'}</dd></div>
        <div><dt>Position</dt><dd>${a.lat != null ? `${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}` : '—'}</dd></div>
        <div><dt>Distance</dt><dd>${a.dist != null ? `${nf(a.dist / 1.852, 1)} NM · ${nf(a.brg)}°` : '—'}</dd></div>
        <div><dt>Niveau reçu</dt><dd>${a.rssi != null ? nf(a.rssi, 1) + ' dB' : '—'}</dd></div>
        <div><dt>Vu</dt><dd>${fmtSpan(a)}</dd></div>
        ${a.selAlt != null ? `<div><dt>Alt. sélectionnée</dt><dd>${nf(a.selAlt)} ft</dd></div>` : ''}
        ${a.qnh != null ? `<div><dt>QNH</dt><dd>${nf(a.qnh, 1)} hPa</dd></div>` : ''}
      </dl>
      <div><div class="lbl muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em">Profil d’altitude</div><canvas id="spark"></canvas></div>
      <div class="muted mono" style="font-size:12px">${a.msgs} messages · ${dfs}</div>
      <div class="actions"><button class="btn small" type="button" id="dMsgs">Voir ses messages</button><button class="btn small" type="button" id="dClose">Fermer</button></div>`;
    $('dMsgs').onclick = () => { els.mq.value = a.icao; S.msgShown = 300; setTab('msg'); };
    $('dClose').onclick = () => { S.selected = null; drawMap(); renderDetail(); };
    drawSpark(a);
  }
  function drawSpark(a) {
    const cv = $('spark'); if (!cv) return;
    const { g, w, h } = fitCanvas(cv);
    const pts = a.altHist; if (pts.length < 2) { g.fillStyle = C.muted; g.font = '12px "IBM Plex Sans", sans-serif'; g.fillText('Pas assez de mesures', 0, 20); return; }
    let t0 = pts[0].t, t1 = pts[pts.length - 1].t, lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.alt); hi = Math.max(hi, p.alt); }
    if (hi - lo < 200) { lo -= 100; hi += 100; }
    const X = (t) => 4 + (t - t0) / Math.max(t1 - t0, 1e-6) * (w - 8), Y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 22);
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.alt)) : g.moveTo(X(p.t), Y(p.alt))));
    g.lineTo(X(t1), h - 14); g.lineTo(X(t0), h - 14); g.closePath(); g.fillStyle = C.accent; g.globalAlpha = 0.14; g.fill(); g.globalAlpha = 1;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.alt)) : g.moveTo(X(p.t), Y(p.alt))));
    g.strokeStyle = C.accent; g.lineWidth = 2; g.stroke();
    const lp = pts[pts.length - 1]; g.fillStyle = C.accent; g.beginPath(); g.arc(X(lp.t), Y(lp.alt), 3.5, 0, 7); g.fill();
    g.fillStyle = C.muted; g.font = '11px "IBM Plex Mono", monospace'; g.textBaseline = 'bottom';
    g.textAlign = 'left'; g.fillText(`${nf(pts[0].alt)} ft`, 0, h); g.textAlign = 'right'; g.fillText(`${nf(lp.alt)} ft`, w, h);
  }

  // ------------------------------------------------------------------ aéronefs
  els.acSort.addEventListener('change', () => { S.acShown = 120; renderAircraft(); });
  els.acHide.addEventListener('change', () => render());
  function renderAircraft() {
    const key = els.acSort.value;
    const list = visibleAircraft().sort((a, b) => {
      if (key === 'cs') return (a.callsign || '~' + a.icao).localeCompare(b.callsign || '~' + b.icao);
      if (key === 'dist') return (a.dist ?? 1e9) - (b.dist ?? 1e9);
      const va = key === 'last' ? a.last : key === 'alt' ? (a.alt ?? -1e9) : key === 'rssi' ? (a.rssi ?? -1e9) : a.msgs;
      const vb = key === 'last' ? b.last : key === 'alt' ? (b.alt ?? -1e9) : key === 'rssi' ? (b.rssi ?? -1e9) : b.msgs;
      return vb - va;
    });
    if (!list.length) { els.acgrid.innerHTML = `<div class="card emptybox">${S.running ? 'Démodulation en cours…' : 'Aucun aéronef décodé. Essayez d’abaisser le seuil de détection ou vérifiez la fréquence d’échantillonnage.'}</div>`; return; }
    const total = list.length; list.length = Math.min(list.length, S.acShown);
    els.acgrid.innerHTML = list.map((a) => {
      const emg = EMG[a.squawk] || a.emergency, lvl = a.rssi != null ? Math.max(0, Math.min(100, (a.rssi + 50) * 2)) : 0;
      return `<button class="card ac${S.selected === a.icao ? ' sel' : ''}" data-icao="${a.icao}" type="button">
        <div class="row1"><div><div class="cs">${esc(a.callsign || '—')}</div><div class="id">${a.icao}${a.catCode ? ' · ' + a.catCode : ''}</div></div>
        ${a.squawk ? `<span class="sq ${emg ? 'emg' : ''}" title="${emg ? esc(emg) : 'Code transpondeur'}">${a.squawk}</span>` : ''}</div>
        ${a.category ? `<div class="cat">${esc(a.category)}</div>` : ''}
        <div class="vals">
          <div><span>Altitude</span><b>${a.alt != null ? nf(a.alt) : '—'}</b></div>
          <div><span>Vit. sol</span><b>${a.gs != null ? Math.round(a.gs) + ' kt' : '—'}</b></div>
          <div><span>Route</span><b>${a.track != null ? Math.round(a.track) + '°' : '—'}</b></div>
          <div><span>Vario</span><b>${a.vr != null ? (a.vr > 0 ? '+' : '') + nf(a.vr) : '—'}</b></div>
          <div><span>Distance</span><b>${a.dist != null ? nf(a.dist / 1.852, 0) + ' NM' : '—'}</b></div>
          <div><span>Messages</span><b>${a.msgs}</b></div>
        </div>
        <div class="meter" title="Niveau moyen ${nf(a.rssi, 1)} dBFS"><i style="width:${lvl}%"></i></div>
        <div class="foot"><span>${a.rssi != null ? nf(a.rssi, 1) + ' dB' : '—'}</span><span>${fmtSpan(a)}</span></div>
      </button>`;
    }).join('') + (total > list.length ? `<div class="more" style="grid-column:1/-1"><span class="muted" style="align-self:center">${nf(list.length)} sur ${nf(total)}</span><button class="btn small" id="acMore" type="button">Afficher 120 de plus</button></div>` : '');
    const mb = $('acMore'); if (mb) mb.onclick = (e) => { e.stopPropagation(); S.acShown += 120; renderAircraft(); };
  }
  els.acgrid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-icao]'); if (!b) return;
    S.selected = b.dataset.icao;
    const a = S.tracker.ac.get(S.selected);
    if (a && a.lat != null) { view.lat = a.lat; view.lon = a.lon; view.user = true; }
    setTab('map');
  });

  // ------------------------------------------------------------------ messages
  els.mq.addEventListener('input', () => { S.msgShown = 300; renderMessages(); });
  els.mdf.addEventListener('change', () => { S.msgShown = 300; renderMessages(); });
  function filteredMsgs() {
    const q = els.mq.value.trim().toUpperCase(), dfv = els.mdf.value;
    const dfs = dfv === 'es' ? [17, 18] : dfv ? dfv.split(',').map(Number) : null;
    return S.msgs.filter((m) => {
      if (dfs && !dfs.includes(m.df)) return false;
      if (!q) return true;
      if (m.icao.includes(q) || m.hex.includes(q)) return true;
      const a = S.tracker.ac.get(m.icao);
      return !!(a && a.callsign && a.callsign.includes(q));
    });
  }
  function renderMessages() {
    const list = filteredMsgs(), shown = list.slice(0, S.msgShown);
    const head = `<div class="mrow head"><span>Temps</span><span>ICAO</span><span>Type</span><span class="sum">Contenu décodé</span><span class="rs">dBFS</span></div>`;
    const rows = shown.map((m) => {
      const es = m.df === 17 || m.df === 18;
      return `<div class="mrow${S.sigIdx === m.i ? ' sel' : ''}" data-i="${m.i}">
        <span class="mono">${fmtT(m.t)}</span><span class="mono">${m.icao}</span>
        <span><span class="df${es ? ' es' : ''}">${m.df == null ? 'État' : 'DF' + m.df}</span>${m.crc !== 'ok' && m.crc !== 'état' ? ` <span class="crcf" title="${m.crc === 'AP' ? 'Adresse retrouvée par la parité (adresse déjà connue)' : 'Un bit corrigé par le CRC'}">${m.crc}</span>` : ''}</span>
        <span class="sum">${esc(A.summarize(m))}</span><span class="rs mono muted">${nf(m.rssi, 1)}</span>
        ${m.hex ? `<span class="hx">${m.hex}</span>` : ''}</div>`;
    }).join('');
    const capNote = S.msgCount > S.msgs.length ? `<div class="more"><span class="note">Liste limitée aux ${nf(S.msgs.length)} premiers messages (sur ${nf(S.msgCount)}) ; tous sont pris en compte pour les aéronefs et la carte.</span></div>` : '';
    const more = list.length > shown.length ? `<div class="more"><span class="muted" style="align-self:center">${nf(shown.length)} sur ${nf(list.length)}</span><button class="btn small" id="moreBtn" type="button">Afficher 300 de plus</button></div>` : '';
    els.msglist.innerHTML = list.length ? head + rows + more + capNote : `<div class="emptybox">${S.msgs.length ? 'Aucun message ne correspond au filtre.' : 'Aucun message décodé pour l’instant.'}</div>`;
    const mb = $('moreBtn'); if (mb) mb.onclick = () => { S.msgShown += 300; renderMessages(); };
  }
  els.msglist.addEventListener('click', (e) => {
    const r = e.target.closest('[data-i]'); if (!r) return;
    if (S.mode === 'table') { const m = S.msgs[+r.dataset.i]; if (m) { S.selected = m.icao; setTab('map'); } return; }
    S.sigIdx = +r.dataset.i; setTab('sig');
  });
  els.copyAvr.addEventListener('click', () => {
    const txt = filteredMsgs().filter((m) => m.hex).map((m) => `*${m.hex};`).join('\n');
    const done = () => { els.copyAvr.textContent = 'Copié'; setTimeout(() => { els.copyAvr.textContent = 'Copier au format AVR'; }, 1600); };
    const fallback = () => { els.copyFallback.value = txt; els.copyFallback.select(); try { document.execCommand('copy'); done(); } catch (e) { els.copyAvr.textContent = 'Copie impossible'; } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  });

  // ------------------------------------------------------------------ signal
  function renderSignal() {
    const withSnip = S.msgs.filter((m) => m.snip);
    if (!S.msgs.length) { els.sigpane.innerHTML = '<div class="emptybox">Choisissez un message dans l’onglet Messages pour voir sa forme d’onde.</div>'; return; }
    if (S.mode === 'table') { els.sigpane.innerHTML = '<div class="emptybox">Pas de forme d’onde : ce fichier Parquet contient des trames ou des positions déjà démodulées, pas d’échantillons IQ.</div>'; return; }
    if (S.sigIdx < 0) S.sigIdx = (withSnip[0] || S.msgs[0]).i;
    const m = S.msgs[S.sigIdx];
    const hx = m.hex, nb = hx.length * 4;
    const hexHtml = `<span class="df5">${hx.slice(0, 2)}</span><span class="aa">${hx.slice(2, 8)}</span>${hx.slice(8, -6)}<span class="pi">${hx.slice(-6)}</span>`;
    els.sigpane.innerHTML = `
      <div class="sighead"><div><h3>DF${m.df} · ${esc(A.DF_NAMES[m.df] || '')} · ${m.icao}</h3>
        <div class="muted mono" style="font-size:12.5px">t = ${fmtT(m.t, 6)}${S.epoch != null ? '' : ' s'} · ${nf(m.rssi, 1)} dBFS · SNR ${nf(m.snr, 1)} dB · CRC ${m.crc}${m.fixedBit != null ? ' (bit ' + (m.fixedBit + 1) + ')' : ''}</div></div>
        <div class="actions"><button class="btn small" id="sPrev" type="button">← Précédent</button><button class="btn small" id="sNext" type="button">Suivant →</button></div></div>
      <div class="hexline">${hexHtml}</div>
      <div>${esc(A.summarize(m))}</div>
      ${m.snip ? '<div class="sigscroll"><canvas id="sigc"></canvas></div>' : '<div class="emptybox">Extrait de signal non conservé pour ce message (seuls les 3 000 premiers le sont).</div>'}
      <p class="explain">Module du signal (|I + jQ|) autour du message. Le préambule de 8 µs porte quatre impulsions de 0,5 µs ; chaque bit de données dure 1 µs : impulsion dans la première moitié = 1, dans la seconde = 0. En couleur : le type (DF), l’adresse ICAO et la parité CRC sur 24 bits.</p>`;
    const step = (d) => {
      let i = S.sigIdx + d;
      while (i >= 0 && i < S.msgs.length && !S.msgs[i].snip) i += d;
      if (i >= 0 && i < S.msgs.length) { S.sigIdx = i; renderSignal(); }
    };
    $('sPrev').onclick = () => step(-1); $('sNext').onclick = () => step(1);
    if (m.snip) drawSignal(m, nb);
  }
  function drawSignal(m, nb) {
    const cv = $('sigc'), sn = m.snip, d = sn.d;
    const pxUs = Math.max(9, Math.min(16, (cv.parentElement.clientWidth - 20) / (nb + 10)));
    const W = Math.ceil((nb + 10) * pxUs), H = 250;
    const { g } = fitCanvas(cv, W, H);
    const top = 30, base = H - 44, x0 = pxUs; // 1 µs de marge avant le préambule
    const X = (us) => x0 + us * pxUs;
    let mx = 0; for (const v of d) mx = Math.max(mx, v);
    const Y = (v) => base - (v / (mx * 1.08)) * (base - top);
    // zones
    g.fillStyle = C.accent; g.globalAlpha = 0.08; g.fillRect(X(0), top - 6, 8 * pxUs, base - top + 6); g.globalAlpha = 1;
    g.fillStyle = C.accent; g.globalAlpha = 0.22;
    for (const p of [0, 1, 3.5, 4.5]) g.fillRect(X(p), top - 6, 0.5 * pxUs, base - top + 6);
    g.globalAlpha = 1;
    const bitsArr = [];
    for (let i = 0; i < nb; i++) bitsArr.push((parseInt(m.hex[i >> 2], 16) >> (3 - (i & 3))) & 1);
    for (let i = 0; i < nb; i++) {
      if (i % 2 === 0) { g.fillStyle = C.line; g.globalAlpha = 0.35; g.fillRect(X(8 + i), top - 6, pxUs, base - top + 6); g.globalAlpha = 1; }
      const fixed = m.fixedBit === i;
      g.fillStyle = fixed ? C.warn : bitsArr[i] ? C.fg : C.muted;
      g.font = `${fixed ? 600 : 500} 10.5px "IBM Plex Mono", monospace`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.fillText(String(bitsArr[i]), X(8 + i + 0.5), top - 10);
    }
    // octets
    g.font = '11px "IBM Plex Mono", monospace'; g.textBaseline = 'top';
    for (let b = 0; b < nb / 8; b++) {
      const xs = X(8 + b * 8);
      g.strokeStyle = C.muted; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(Math.round(xs) + .5, base); g.lineTo(Math.round(xs) + .5, base + 20); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = b === 0 ? C.accent : b <= 3 ? C.signal : b >= nb / 8 - 3 ? C.muted : C.fg;
      g.textAlign = 'center'; g.fillText(m.hex.slice(b * 2, b * 2 + 2), xs + 4 * pxUs, base + 6);
    }
    g.fillStyle = C.muted; g.textAlign = 'left'; g.fillText('préambule', X(0) + 2, base + 6);
    // bruit
    g.setLineDash([3, 4]); g.strokeStyle = C.muted; g.beginPath(); g.moveTo(0, Y(sn.noise)); g.lineTo(W, Y(sn.noise)); g.stroke(); g.setLineDash([]);
    // trace en escalier
    g.strokeStyle = C.signal; g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < d.length; i++) {
      const xa = X((i - sn.off) / sn.spu), xb = X((i + 1 - sn.off) / sn.spu), y = Y(d[i]);
      if (i === 0) g.moveTo(xa, y); else g.lineTo(xa, y);
      g.lineTo(xb, y);
    }
    g.stroke();
    // axe temps
    g.fillStyle = C.muted; g.textBaseline = 'bottom'; g.textAlign = 'center';
    for (let us = 0; us <= 8 + nb; us += 8) g.fillText(`${us} µs`, X(us), H - 2);
  }

  // ------------------------------------------------------------------ onglets
  const TABS = { map: 't-map', ac: 't-ac', msg: 't-msg', sig: 't-sig' };
  function setTab(t) {
    S.tab = t;
    for (const [k, id] of Object.entries(TABS)) {
      const on = k === t; $(id).setAttribute('aria-selected', on); $('p-' + k).hidden = !on;
    }
    render();
  }
  for (const [k, id] of Object.entries(TABS)) $(id).addEventListener('click', () => setTab(k));

  // ------------------------------------------------------------------ thème / redimensionnement
  readTokens(); paintAltKey();
  const reTheme = () => { readTokens(); paintAltKey(); render(); };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reTheme); } catch (e) { /* ancien navigateur */ }
  new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  if (window.ResizeObserver) new ResizeObserver(() => scheduleRender()).observe(document.body);
  else window.addEventListener('resize', scheduleRender);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());

  // démarrage : démo synthétique pour montrer l'outil en fonctionnement
  render();
  startDemo();
})();
