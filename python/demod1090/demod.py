"""Démodulation PPM 1090 MHz à toute fréquence d'échantillonnage ≥ 2 MS/s.

Principe (identique à la version web) :
  * module |I+jQ|, sommes cumulées → intégration fractionnaire de chaque demi-bit de 0,5 µs ;
  * recherche du préambule (impulsions à 0 ; 1 ; 3,5 ; 4,5 µs) vectorisée avec numpy,
    puis essai de plusieurs phases sous-échantillon ;
  * décision bit à bit (énergie 1re moitié > 2e moitié), et à faible suréchantillonnage
    un tranchage par modèle avec rétroaction de décision ;
  * validation par CRC-24 / adresse-parité (FrameValidator).
"""
from __future__ import annotations

import math
import time
from typing import Callable, Iterable

import numpy as np

from .iq import Source
from .modes import DF_NAMES, FrameValidator

_PRE = np.array([1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0], dtype=np.float64)


class Demodulator:
    def __init__(self, fs: float, threshold_db: float = 8.0, fix1: bool = True,
                 snippets: int = 0, validator: FrameValidator | None = None):
        if fs < 1.9e6:
            raise ValueError("Il faut au moins 2 MS/s pour séparer les demi-bits de 0,5 µs.")
        self.fs, self.sp = fs, fs / 1e6
        self.h = self.sp / 2
        self.thr = 10 ** (threshold_db / 20)
        sp = self.sp
        self.offsets = np.array([0, -0.25, 0.25, -0.5, 0.5] if sp < 3 else [0, -0.35, 0.35] if sp < 7 else [0.0])
        self.use_model = sp < 5
        self.validator = validator or FrameValidator(fix1=fix1)
        self.max_snip, self.n_snip = snippets, 0
        self.next_t = 0.0
        self.stats = {"candidates": 0, "crc_fail": 0}

    # ------------------------------------------------------------ bloc
    def process(self, mag: np.ndarray, start: int, valid_end: int) -> list[dict]:
        sp, h = self.sp, self.h
        mag = np.ascontiguousarray(mag, dtype=np.float32)
        L = mag.size
        if L < 130 * sp:
            return []
        P = np.empty(L + 1, dtype=np.float64)
        P[0] = 0
        np.cumsum(mag, dtype=np.float64, out=P[1:])
        magd = mag.astype(np.float64)

        def F(x):
            i = np.floor(x).astype(np.int64)
            return P[i] + (x - i) * magd[i]

        # bruit : 20e centile (robuste quand le signal est dense) ; Rayleigh : moyenne = 1,876 × p20
        smp = np.sort(mag[np.linspace(0, L - 1, min(L, 4096)).astype(np.int64)])
        noise = max(min(float(P[-1] / L), float(smp[int(smp.size * 0.2)]) * 1.876), 1e-9)
        min_e = noise * h * self.thr

        t_first = max(1, math.ceil(self.next_t - start + 0.5))
        t_end = min(valid_end, L - math.ceil(122 * sp) - 2)
        if t_end <= t_first:
            return []
        t = np.arange(t_first, t_end, dtype=np.float64)
        ok = (F(t + h + 0.5) - F(t - 0.5) >= min_e) & (F(t + sp + h + 0.5) - F(t + sp - 0.5) >= min_e)
        t = t[ok]
        if not t.size:
            return []
        # score du préambule à chaque phase : (candidats × phases)
        t0 = t[:, None] + self.offsets[None, :]
        E = lambda a, b: F(t0 + a * sp) - F(t0 + b * sp)  # noqa: E731
        p = np.stack([E(0.5, 0), E(1.5, 1), E(4, 3.5), E(5, 4.5)])
        g = E(1, 0.5) + E(3.5, 1.5) + E(4.5, 4) + E(8, 5)
        hi, lo, pmin = p.mean(0), g / 12, p.min(0)
        good = (hi >= min_e) & (pmin > 0.6 * min_e) & (hi > 2.2 * lo) & (pmin > 1.4 * lo)
        q = np.where(good, (hi - lo) / (hi + lo + 1e-30), -1.0)
        keep = good.any(1)
        t, t0, q, hi = t[keep], t0[keep], q[keep], hi[keep]

        out: list[dict] = []
        bit_idx = np.arange(112, dtype=np.float64)
        skip_until = -1.0
        for k in range(t.size):
            if t[k] < skip_until:
                continue
            self.stats["candidates"] += 1
            order = np.argsort(-q[k])
            found = None
            for j in order:
                if q[k, j] < 0:
                    break
                c0 = t0[k, j]
                for method in ((0, 1) if self.use_model else (0,)):
                    if method == 0:
                        a = c0 + (8 + bit_idx) * sp
                        bitv = (F(a + h) - F(a)) > (F(a + sp) - F(a + h))
                    else:
                        bitv = self._model_bits(magd, c0, noise)
                        if bitv is None:
                            continue
                    raw = np.packbits(bitv).tobytes()
                    df = raw[0] >> 3
                    if df not in DF_NAMES:
                        continue
                    nb = 14 if df >= 16 else 7
                    r = self.validator.check(raw[:nb])
                    if r:
                        found = (c0, hi[k, j], r)
                        break
                if found:
                    break
            if not found:
                self.stats["crc_fail"] += 1
                continue
            c0, hik, (b, icao, status, fixed) = found
            amp = hik / h
            m = self.validator._record(b, icao, status, fixed, (start + c0) / self.fs,
                                       round(20 * math.log10(max(amp, 1e-9)), 1),
                                       round(20 * math.log10(hik / (noise * h)), 1))
            m["sample"] = start + c0
            if self.n_snip < self.max_snip:
                a0, a1 = max(0, int(c0 - sp)), min(L, int(math.ceil(c0 + (9 + len(b) * 8) * sp)))
                m["snip"] = {"mag": mag[a0:a1].copy(), "spu": sp, "off": c0 - a0, "noise": noise}
                self.n_snip += 1
            out.append(m)
            self.next_t = start + c0 + (8 + len(b) * 8) * sp - 1
            skip_until = self.next_t - start
        return out

    # ------------------------------------------------------------ tranchage par modèle
    def _model_bits(self, mag: np.ndarray, t0: float, noise: float, nbits: int = 112):
        """Chaque échantillon moyenne deux demi-bits quand la phase est fractionnaire : on compare,
        bit par bit, les deux hypothèses au module attendu, avec rétroaction sur le bit précédent."""
        h = self.h
        chips = np.full(16 + 2 * nbits, 0.5)
        chips[:16] = _PRE

        def frac(k):
            c0, c1 = max(0, int(math.floor((k - t0) / h))), int(math.floor((k + 1 - t0) / h))
            v = 0.0
            for c in range(c0, min(c1, chips.size - 1) + 1):
                a, b = max(k, t0 + c * h), min(k + 1, t0 + (c + 1) * h)
                if b > a:
                    v += (b - a) * chips[c]
            return v

        k0, k_end = int(math.floor(t0)), int(math.ceil(t0 + 8 * self.sp))
        e = np.array([frac(k) for k in range(k0, k_end)])
        s = mag[k0:k_end]
        nz = s[e < 0.01].mean() if (e < 0.01).any() else noise
        den = float((e * e).sum())
        A = float(((s - nz) * e).sum() / den) if den > 0 else 0.0
        if A <= 0:
            return None
        out = np.zeros(nbits, dtype=bool)
        for i in range(nbits):
            c = 16 + 2 * i
            ka, kb = int(math.floor(t0 + c * h)), int(math.ceil(t0 + (c + 2) * h))
            err = [0.0, 0.0]
            for hyp in (0, 1):
                chips[c], chips[c + 1] = hyp, 1 - hyp
                for k in range(ka, kb):
                    d = mag[k] - nz - A * frac(k)
                    err[hyp] += d * d
            bit = err[1] < err[0]
            chips[c], chips[c + 1] = (1.0, 0.0) if bit else (0.0, 1.0)
            out[i] = bit
        return out


# ---------------------------------------------------------------- traitement d'une source complète
def demodulate(source: Source, fs: float, threshold_db: float = 8.0, fix1: bool = True, snippets: int = 0,
               chunk_ms: float = 250, progress: Callable[[int, int, float], None] | None = None) -> tuple[list[dict], dict]:
    """Démodule toute la source par blocs (avec recouvrement). Retourne (messages, statistiques)."""
    sp = fs / 1e6
    ch = max(1 << 18, round(chunk_ms * 1e-3 * fs))
    ov = math.ceil(140 * sp) + 8
    d = Demodulator(fs, threshold_db, fix1, snippets)
    msgs: list[dict] = []
    s, t_start = 0, time.perf_counter()
    while s < source.total:
        n = min(ch + ov, source.total - s)
        mag = source.read(s, n)
        last = s + ch >= source.total
        msgs.extend(d.process(mag, s, mag.size if last else ch))
        s = min(s + ch, source.total)
        if progress:
            progress(s, source.total, time.perf_counter() - t_start)
    st = dict(d.validator.stats)
    st.update(d.stats, elapsed=time.perf_counter() - t_start, samples=source.total, fs=fs)
    return msgs, st


PROBE_RATES = [2e6, 2.4e6, 2.56e6, 3e6, 3.2e6, 4e6, 5e6, 6e6, 8e6, 10e6, 12e6, 12.5e6, 16e6, 20e6, 24e6,
               25e6, 30.72e6, 32e6, 40e6, 50e6, 56e6, 61.44e6, 64e6, 80e6, 100e6]


def probe_rate(source: Source, rates: Iterable[float] = PROBE_RATES, max_samples: int = 3_000_000,
               threshold_db: float = 6.0) -> list[tuple[float, int]]:
    """Compte les trames à CRC exact obtenues sur le début du signal pour chaque fréquence candidate."""
    mag = source.read(0, min(source.total, max_samples))
    res = []
    for fs in rates:
        if mag.size <= 140 * fs / 1e6:
            res.append((fs, 0))
            continue
        d = Demodulator(fs, threshold_db, fix1=False)
        d.use_model = False  # essai rapide
        msgs = d.process(mag, 0, mag.size)
        res.append((fs, sum(1 for m in msgs if m["crc"] == "ok")))
    return res
