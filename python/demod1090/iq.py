"""Lecture d'enregistrements IQ : binaires bruts, WAV/RF64, MATLAB .mat v5 ; conversion en module."""
from __future__ import annotations

import os
import re
import struct
import zlib
from dataclasses import dataclass, field

import numpy as np

# format → (dtype numpy d'une composante, octets par échantillon complexe, pleine échelle, décalage)
FORMATS = {
    "cs16": (np.dtype("<i2"), 4, 32768.0, 0.0),
    "cs16be": (np.dtype(">i2"), 4, 32768.0, 0.0),
    "cu8": (np.dtype("u1"), 2, 128.0, 127.4),
    "cs8": (np.dtype("i1"), 2, 128.0, 0.0),
    "cf32": (np.dtype("<f4"), 8, 1.0, 0.0),
}
FORMAT_LABELS = {
    "cs16": "int16 signé LE (I/Q entrelacés)", "cs16be": "int16 signé BE", "cu8": "uint8 (RTL-SDR)",
    "cs8": "int8 signé (HackRF)", "cf32": "float32 (GNU Radio)",
}


def to_magnitude(raw: bytes | np.ndarray, fmt: str) -> np.ndarray:
    """Échantillons I/Q entrelacés → module |I + jQ| normalisé (float32, pleine échelle 1)."""
    dt, _, full, off = FORMATS[fmt]
    a = np.frombuffer(raw, dtype=dt) if not isinstance(raw, np.ndarray) else raw
    a = a[: len(a) - (len(a) & 1)].astype(np.float32)
    if off:
        a -= off
    i, q = a[0::2], a[1::2]
    return (np.sqrt(i * i + q * q) / full).astype(np.float32)


# ---------------------------------------------------------------- WAV
@dataclass
class WavInfo:
    format: str | None
    rate: int
    channels: int
    bits_per_sample: int
    data_offset: int
    data_size: int


def parse_wav(head: bytes, file_size: int | None = None) -> WavInfo | None:
    if len(head) < 12 or head[0:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
        return None
    o, fmt, ds64, off, size = 12, None, None, None, None
    while o + 8 <= len(head):
        cid, sz = head[o:o + 4], struct.unpack_from("<I", head, o + 4)[0]
        if cid == b"ds64" and o + 36 <= len(head):
            ds64 = struct.unpack_from("<Q", head, o + 16)[0]
        if cid == b"fmt ":
            audio, ch, rate = struct.unpack_from("<HHI", head, o + 8)
            bps = struct.unpack_from("<H", head, o + 22)[0]
            fmt = (audio, ch, rate, bps)
        if cid == b"data":
            off, size = o + 8, (ds64 if sz == 0xFFFFFFFF and ds64 else sz)
            break
        o += 8 + sz + (sz & 1)
    if not fmt or off is None:
        return None
    if file_size and (not size or off + size > file_size):
        size = file_size - off
    audio, ch, rate, bps = fmt
    f = None
    if ch == 2:
        f = {16: "cs16", 8: "cu8"}.get(bps)
        if bps == 32 and audio in (3, 0xFFFE):
            f = "cf32"
    return WavInfo(f, rate, ch, bps, off, size)


# ---------------------------------------------------------------- MATLAB .mat v5
_MI = {1: "i1", 2: "u1", 3: "<i2", 4: "<u2", 5: "<i4", 6: "<u4", 7: "<f4", 9: "<f8", 12: "<i8", 13: "<u8"}
_MI_FULL = {1: 128.0, 2: 128.0, 3: 32768.0, 4: 32768.0, 5: 2147483648.0, 6: 2147483648.0}
_CLS = {6: "double", 7: "single", 8: "int8", 9: "uint8", 10: "int16", 11: "uint16", 12: "int32", 13: "uint32"}


@dataclass
class MatIQ:
    iq: np.ndarray            # complexe (complex64), pleine échelle 1 pour les entiers
    name: str
    dims: tuple
    cls: str
    complex: bool
    rate: float | None = None
    extras: dict = field(default_factory=dict)


def _tag(buf: bytes, o: int):
    t = struct.unpack_from("<I", buf, o)[0]
    if t >> 16:  # petit élément (données dans la balise)
        return t & 0xFFFF, t >> 16, o + 4, o + 8
    n = struct.unpack_from("<I", buf, o + 4)[0]
    return t, n, o + 8, o + 8 + n + ((8 - n % 8) % 8)


def _matrix(buf: bytes, start: int, length: int):
    o, end, parts = start, start + length, []
    while o + 8 <= end:
        typ, n, d, nxt = _tag(buf, o)
        parts.append((typ, n, d))
        o = nxt
    if len(parts) < 4:
        return None
    flags = struct.unpack_from("<I", buf, parts[0][2])[0]
    cls, cplx = flags & 0xFF, bool(flags & 0x800)
    dims = struct.unpack_from(f"<{parts[1][1] // 4}i", buf, parts[1][2])
    name = buf[parts[2][2]:parts[2][2] + parts[2][1]].decode("latin1")
    if not 6 <= cls <= 15:
        return {"name": name, "dims": dims, "cls": cls}

    def arr(p):
        typ, n, d = p
        if typ not in _MI:
            return None, 1.0
        return np.frombuffer(buf, dtype=_MI[typ], count=n // np.dtype(_MI[typ]).itemsize, offset=d), _MI_FULL.get(typ, 1.0)

    re_, full = arr(parts[3])
    im_ = arr(parts[4])[0] if cplx and len(parts) > 4 else None
    return {"name": name, "dims": dims, "cls": cls, "complex": cplx, "re": re_, "im": im_, "full": full}


def parse_mat(data: bytes) -> MatIQ:
    """Lit un MAT-file v5 et renvoie la variable IQ (complexe N×1, réelle N×2 / 2×N, ou vecteur entrelacé)."""
    head = data[:116].decode("latin1", "replace")
    if not head.startswith("MATLAB"):
        raise ValueError("Ce fichier n’est pas un MAT-file MATLAB.")
    if "7.3 MAT-file" in head:
        raise ValueError("MAT-file v7.3 (HDF5) non pris en charge : réenregistrez-le avec save(…, '-v7').")
    if data[126:128] != b"IM":
        raise ValueError("MAT-file gros-boutiste non pris en charge.")
    vars_, o = [], 128
    while o + 8 <= len(data):
        typ, n, d, nxt = _tag(data, o)
        if typ == 15:
            raw = zlib.decompress(data[d:d + n])
            it, inn, idd, _ = _tag(raw, 0)
            if it == 14:
                m = _matrix(raw, idd, inn)
                if m: vars_.append(m)
            o = d + n
        elif typ == 14:
            m = _matrix(data, d, n)
            if m: vars_.append(m)
            o = nxt
        else:
            o = nxt
    rate = None
    for v in vars_:
        if v.get("re") is not None and v["re"].size == 1 and re.fullmatch(r"(fs|fe|sr|samp.*rate|sample_?rate|rate|fech|f_?ech)", v["name"], re.I):
            x = float(v["re"][0])
            rate = x * 1e6 if x < 1000 else x
    cands = [v for v in vars_ if v.get("re") is not None and v["re"].size > 1000]
    if not cands:
        raise ValueError("Aucune variable IQ trouvée dans le fichier .mat (attendu : complexe N×1 ou réel N×2).")
    score = lambda v: (2 if v["complex"] else 0) + (1 if 2 in v["dims"] else 0) + (1 if re.search("iq", v["name"], re.I) else 0)  # noqa: E731
    v = max(cands, key=lambda v: (score(v), v["re"].size))
    k = 1.0 / v["full"]
    re_ = v["re"].astype(np.float32) * k
    r, c = v["dims"][0], v["dims"][1] if len(v["dims"]) > 1 else 1
    if v["complex"] and v["im"] is not None:
        iq = re_ + 1j * (v["im"].astype(np.float32) * k)
    elif c == 2:      # colonnes I, Q (stockage par colonne)
        iq = re_[:r] + 1j * re_[r:2 * r]
    elif r == 2:      # lignes I, Q
        iq = re_[0::2] + 1j * re_[1::2]
    else:             # vecteur entrelacé
        n = re_.size // 2
        iq = re_[0:2 * n:2] + 1j * re_[1:2 * n:2]
    return MatIQ(iq.astype(np.complex64), v["name"], tuple(v["dims"]), _CLS.get(v["cls"], "?"), bool(v["complex"]), rate)


# ---------------------------------------------------------------- nom de fichier
def guess_from_name(name: str) -> dict:
    n, r = os.path.basename(name).lower(), {}
    for pat, f in ((r"\.(cs16|sc16|c16|iq16|s16|ci16|int16)$", "cs16"), (r"\.(cu8|u8|c8u)$", "cu8"),
                   (r"\.(cs8|s8|ci8|sc8)$", "cs8"), (r"\.(cf32|fc32|cfile|f32|complex)$", "cf32"),
                   (r"\.wav$", "wav"), (r"\.mat$", "mat"), (r"\.parquet$", "parquet")):
        if re.search(pat, n):
            r["format"] = f
            break
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:msps|ms/s|msamp|mhzsr)", n)
    if m:
        r["rate"] = float(m.group(1).replace(",", ".")) * 1e6
    if "rate" not in r and (m := re.search(r"(\d+(?:[.,]\d+)?)\s*ksps", n)):
        r["rate"] = float(m.group(1).replace(",", ".")) * 1e3
    if "rate" not in r and (m := re.search(r"(?:^|[^a-z])(?:sr|fs|rate|s)[=_-]?(\d{6,8})(?!\d)", n)):
        r["rate"] = float(m.group(1))
    if "rate" not in r:
        for x in re.findall(r"\d{7,8}", n):
            if 1.9e6 <= int(x) <= 61.44e6:
                r["rate"] = float(x)
                break
    if "rate" not in r and (m := re.search(r"(?:^|[^0-9.])(\d{1,2}(?:[.,]\d+)?)m(?:[^a-z]|$)", n)):
        v = float(m.group(1).replace(",", "."))
        if 2 <= v <= 61.44:
            r["rate"] = v * 1e6
    if "rate" in r and not 1.9e6 <= r["rate"] <= 100e6:
        del r["rate"]
    return r


# ---------------------------------------------------------------- sources
class Source:
    """Source d'échantillons : `total` échantillons complexes, `read(start, n)` → module float32."""
    total: int
    description: str = ""

    def read(self, start: int, n: int) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError


class FileSource(Source):
    def __init__(self, path: str, fmt: str, offset: int = 0, size: int | None = None):
        self.path, self.fmt, self.offset = path, fmt, offset
        self.bps = FORMATS[fmt][1]
        size = (os.path.getsize(path) - offset) if size is None else size
        self.total = size // self.bps
        self.description = f"{os.path.basename(path)} ({FORMAT_LABELS[fmt]})"
        self._fh = open(path, "rb")

    def read(self, start, n):
        self._fh.seek(self.offset + start * self.bps)
        return to_magnitude(self._fh.read(n * self.bps), self.fmt)

    def close(self):
        self._fh.close()


class ArraySource(Source):
    def __init__(self, iq: np.ndarray, description: str = "tableau"):
        self.mag = np.abs(iq).astype(np.float32) if np.iscomplexobj(iq) else np.asarray(iq, np.float32)
        self.total = self.mag.size
        self.description = description

    def read(self, start, n):
        return self.mag[start:start + n]


def open_source(path: str, fmt: str | None = None, rate: float | None = None):
    """Ouvre un fichier IQ et devine format / fréquence. Retourne (source, fréquence ou None, notes)."""
    notes, g = [], guess_from_name(path)
    with open(path, "rb") as fh:
        head = fh.read(65536)
    size = os.path.getsize(path)
    if fmt in (None, "mat") and (g.get("format") == "mat" or head.startswith(b"MATLAB")):
        with open(path, "rb") as fh:
            m = parse_mat(fh.read())
        notes.append(f"MATLAB : variable « {m.name} » {'×'.join(map(str, m.dims))} {m.cls}{' complexe' if m.complex else ''}")
        if m.rate:
            notes.append(f"fréquence lue dans le fichier : {m.rate / 1e6:g} MS/s")
        return ArraySource(m.iq, os.path.basename(path)), rate or m.rate, notes
    w = parse_wav(head, size) if fmt in (None, "wav") else None
    if w:
        if not w.format:
            raise ValueError(f"WAV non pris en charge ({w.channels} voies, {w.bits_per_sample} bits)")
        notes.append(f"en-tête WAV : {w.channels} voies, {w.bits_per_sample} bits, {w.rate / 1e6:g} MS/s")
        return FileSource(path, w.format, w.data_offset, w.data_size), rate or float(w.rate), notes
    f = fmt or (g.get("format") if g.get("format") in FORMATS else "cs16")
    if not rate and g.get("rate"):
        rate = g["rate"]
        notes.append(f"fréquence déduite du nom : {rate / 1e6:g} MS/s")
    return FileSource(path, f), rate, notes
