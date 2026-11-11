"""Générateur de signal synthétique (démonstration et tests) : messages Mode S modulés en PPM + bruit gaussien."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass

import numpy as np

from . import modes as M
from .iq import Source, to_magnitude

DEMO_FLEET = [
    dict(icao=0x3944F1, cs="AFR1047", tc=4, cat=3, brg=20, km=62, alt=36000, gs=452, trk=135, vr=0, sq="1000", snr=22),
    dict(icao=0x406A3C, cs="EZY48QT", tc=4, cat=3, brg=300, km=41, alt=21000, gs=338, trk=305, vr=1792, sq="6210", snr=18),
    dict(icao=0x4CA7B2, cs="RYR3PL", tc=4, cat=3, brg=200, km=28, alt=11500, gs=276, trk=40, vr=-1472, sq="3457", snr=26),
    dict(icao=0x3C66B4, cs="DLH9CW", tc=4, cat=3, brg=75, km=148, alt=38000, gs=471, trk=228, vr=0, sq="2271", snr=11),
    dict(icao=0x39AC05, cs="FGKXA", tc=4, cat=1, brg=155, km=17, alt=2500, gs=104, trk=75, vr=256, sq="7000", snr=9),
    dict(icao=0x400F2B, cs="BAW318", tc=4, cat=5, brg=340, km=96, alt=33000, gs=482, trk=162, vr=0, sq="5513", snr=15),
    dict(icao=0x3A1F7E, cs="TVF72HM", tc=4, cat=3, brg=250, km=74, alt=17000, gs=312, trk=70, vr=-2432, sq="7700", snr=17, emergency=1),
]
DEMO_REF = (48.7262, 2.3652)  # Orly


@dataclass
class Emission:
    t: float
    data: bytes
    amp: float
    f_off: float
    phase: float
    icao: int
    kind: str
    truth: tuple  # (lat, lon, alt)


class Scenario(Source):
    """Planning d'émissions + génération déterministe d'IQ int16 (cs16) par blocs."""

    def __init__(self, fs: float = 2.4e6, duration: float = 15.0, seed: int = 7, noise: float = 220.0,
                 ref=DEMO_REF, fleet=None):
        self.fs, self.duration, self.seed, self.sigma, self.ref = fs, duration, seed, noise, ref
        self.total = int(duration * fs)
        self.description = f"démo synthétique ({duration:g} s à {fs / 1e6:g} MS/s)"
        rnd = random.Random(seed)
        self.fleet = [dict(a, p0=M.destination(ref[0], ref[1], a["brg"], a["km"])) for a in (fleet or DEMO_FLEET)]
        em: list[Emission] = []
        for a in self.fleet:
            amp0 = noise * math.sqrt(2) * 10 ** (a["snr"] / 20)
            f_off = (rnd.random() - 0.5) * 160e3

            def state(t, a=a):
                lat, lon = M.destination(*a["p0"], a["trk"], a["gs"] * 1.852 / 3600 * t)
                return lat, lon, round((a["alt"] + a["vr"] * t / 60) / 25) * 25

            def push(t, data, kind, a=a, amp0=amp0, f_off=f_off, state=state):
                if 0.0002 <= t < duration - 0.0003:
                    em.append(Emission(t, data, amp0 * 10 ** ((rnd.random() - 0.5) * 0.1), f_off,
                                       rnd.random() * 2 * math.pi, a["icao"], kind, state(t)))

            def every(t0, period, jitter):
                t = t0
                while t < duration:
                    yield t
                    t += period + rnd.random() * jitter

            odd = 0
            for t in every(rnd.random() * 0.5, 0.4, 0.2):
                la, lo, al = state(t)
                push(t, M.enc_position(a["icao"], la, lo, al, odd), "pos-odd" if odd else "pos-even")
                odd ^= 1
            for t in every(rnd.random() * 0.5, 0.4, 0.2):
                push(t, M.enc_velocity(a["icao"], a["gs"], a["trk"], a["vr"]), "vel")
            for t in every(0.05 + rnd.random() * 0.8, 4.6, 0.8):
                push(t, M.enc_ident(a["icao"], a["cs"], a["tc"], a["cat"]), "ident")
            for t in every(rnd.random(), 0.8, 0.4):
                push(t, M.enc_allcall(a["icao"]), "allcall")
            for t in every(0.4 + rnd.random(), 0.6, 0.6):
                push(t, M.enc_alt(a["icao"], state(t)[2]), "alt")
            for t in every(0.4 + rnd.random(), 1.1, 0.8):
                push(t, M.enc_squawk(a["icao"], a["sq"]), "squawk")
            if a.get("emergency"):
                for t in every(0.3 + rnd.random(), 2.5, 1.0):
                    push(t, M.enc_emergency(a["icao"], a["sq"], a["emergency"]), "emergency")
        em.sort(key=lambda e: e.t)
        self.emissions = em
        self._s0 = np.array([e.t * fs for e in em])

    def iq_int16(self, start: int, n: int) -> np.ndarray:
        """Échantillons I/Q entrelacés int16 pour [start, start+n) — identiques quel que soit le découpage."""
        sp, fs = self.fs / 1e6, self.fs
        k = np.arange(start, start + n, dtype=np.int64)
        # bruit gaussien déterministe par indice d'échantillon (hachage)
        def h32(x):
            x = x.astype(np.uint64) & 0xFFFFFFFF
            x ^= x >> 16; x = (x * 0x7FEB352D) & 0xFFFFFFFF
            x ^= x >> 15; x = (x * 0x846CA68B) & 0xFFFFFFFF
            x ^= x >> 16
            return x
        u1 = (h32(2 * k + self.seed).astype(np.float64) + 1) / 4294967297.0
        u2 = h32(((2 * k + 1) ^ 0x9E3779B9) + self.seed).astype(np.float64) / 4294967296.0
        r = np.sqrt(-2 * np.log(u1)) * self.sigma
        iq = r * np.exp(2j * np.pi * u2)
        lo = np.searchsorted(self._s0, start - 130 * sp)
        hi = np.searchsorted(self._s0, start + n)
        sub = (np.arange(4) + 0.5) / 4
        for e in self.emissions[lo:hi]:
            s0 = e.t * fs
            nbits = len(e.data) * 8
            a = max(start, int(math.floor(s0)))
            z = min(start + n, int(math.ceil(s0 + (8 + nbits) * sp)) + 1)
            if z <= a:
                continue
            kk = np.arange(a, z)
            tau = (kk[:, None] + sub[None, :] - s0) / sp  # µs depuis le début du message
            on = np.zeros_like(tau)
            pre = (tau >= 0) & (tau < 8)
            tp = tau[pre]
            on[pre] = ((tp < 0.5) | ((tp >= 1) & (tp < 1.5)) | ((tp >= 3.5) & (tp < 4)) | ((tp >= 4.5) & (tp < 5)))
            dat = (tau >= 8) & (tau < 8 + nbits)
            td = tau[dat] - 8
            i = np.floor(td).astype(np.int64)
            bitv = (np.frombuffer(e.data, np.uint8)[i >> 3] >> (7 - (i & 7))) & 1
            first = (td - i) < 0.5
            on[dat] = np.where(bitv == 1, first, ~first)
            v = on.mean(1) * e.amp
            iq[a - start:z - start] += v * np.exp(1j * (e.phase + 2 * np.pi * e.f_off * kk / fs))
        out = np.empty(2 * n, dtype=np.int16)
        out[0::2] = np.clip(np.round(iq.real), -32768, 32767)
        out[1::2] = np.clip(np.round(iq.imag), -32768, 32767)
        return out

    def read(self, start: int, n: int) -> np.ndarray:
        return to_magnitude(self.iq_int16(start, n), "cs16")

    def write_cs16(self, path: str, chunk: int = 1 << 20) -> None:
        with open(path, "wb") as fh:
            for s in range(0, self.total, chunk):
                fh.write(self.iq_int16(s, min(chunk, self.total - s)).tobytes())
