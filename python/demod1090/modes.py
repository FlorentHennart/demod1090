"""Mode S / ADS-B : CRC-24, champs, altitude, squawk, CPR, décodage et encodage des trames."""
from __future__ import annotations

import math

# ---------------------------------------------------------------- bits
def bits(b: bytes, start: int, length: int) -> int:
    """Extrait `length` bits à partir du bit `start` (numérotation ICAO 1-based)."""
    v = 0
    for i in range(length):
        p = start - 1 + i
        v = (v << 1) | ((b[p >> 3] >> (7 - (p & 7))) & 1)
    return v


def set_bits(b: bytearray, start: int, length: int, val: int) -> None:
    for i in range(length):
        p = start - 1 + i
        mask = 0x80 >> (p & 7)
        if (val >> (length - 1 - i)) & 1:
            b[p >> 3] |= mask
        else:
            b[p >> 3] &= ~mask & 0xFF


# ---------------------------------------------------------------- CRC-24
POLY = 0xFFF409
CRC_TABLE = []
for _i in range(256):
    _c = _i << 16
    for _ in range(8):
        _c = ((_c << 1) ^ POLY) if _c & 0x800000 else (_c << 1)
    CRC_TABLE.append(_c & 0xFFFFFF)


def crc24(b: bytes, n: int | None = None) -> int:
    c = 0
    for x in b[: len(b) if n is None else n]:
        c = ((c << 8) ^ CRC_TABLE[((c >> 16) ^ x) & 0xFF]) & 0xFFFFFF
    return c


def residual(b: bytes) -> int:
    """CRC des n-3 premiers octets XOR la parité transmise (0 pour une trame DF17 intacte)."""
    n = len(b)
    return crc24(b, n - 3) ^ ((b[n - 3] << 16) | (b[n - 2] << 8) | b[n - 1])


# syndromes d'une erreur simple sur 112 bits (champ DF exclu)
SYN112: dict[int, int] = {}
for _i in range(5, 112):
    _z = bytearray(14)
    _z[_i >> 3] = 0x80 >> (_i & 7)
    SYN112[residual(bytes(_z))] = _i

# ---------------------------------------------------------------- altitude / squawk
_ID13 = [(0x1000, 0x0010), (0x0800, 0x1000), (0x0400, 0x0020), (0x0200, 0x2000), (0x0100, 0x0040),
         (0x0080, 0x4000), (0x0020, 0x0100), (0x0010, 0x0001), (0x0008, 0x0200), (0x0004, 0x0002),
         (0x0002, 0x0400), (0x0001, 0x0004)]


def id13_to_gillham(i: int) -> int:
    return sum(g for a, g in _ID13 if i & a)


def gillham_to_id13(h: int) -> int:
    return sum(a for a, g in _ID13 if h & g)


def squawk_from_id13(i: int) -> str:
    h = id13_to_gillham(i)
    return f"{(h >> 12) & 7}{(h >> 8) & 7}{(h >> 4) & 7}{h & 7}"


def id13_from_squawk(sq: str) -> int:
    d = [int(c) for c in str(sq).zfill(4)]
    return gillham_to_id13((d[0] << 12) | (d[1] << 8) | (d[2] << 4) | d[3])


def mode_a_to_mode_c(a: int) -> int | None:
    """Code Gillham → centaines de pieds (algorithme de dump1090)."""
    if (a & 0xFFFF8889) or not (a & 0x00F0):
        return None
    five = one = 0
    if a & 0x0010: one ^= 0x007
    if a & 0x0020: one ^= 0x003
    if a & 0x0040: one ^= 0x001
    if (one & 5) == 5: one ^= 2
    if one > 5:
        return None
    for m, x in ((0x0002, 0x0FF), (0x0004, 0x07F), (0x1000, 0x03F), (0x2000, 0x01F), (0x4000, 0x00F),
                 (0x0100, 0x007), (0x0200, 0x003), (0x0400, 0x001)):
        if a & m:
            five ^= x
    if five & 1:
        one = 6 - one
    return five * 5 + one - 13


def decode_ac13(ac: int) -> int | None:
    """Champ altitude 13 bits (DF0/4/16/20) → pieds."""
    if not ac or ac & 0x40:  # absent ou métrique
        return None
    if ac & 0x10:
        n = ((ac & 0x1F80) >> 2) | ((ac & 0x20) >> 1) | (ac & 0xF)
        return n * 25 - 1000
    c = mode_a_to_mode_c(id13_to_gillham(ac))
    return None if c is None or c < -12 else c * 100


def decode_ac12(ac: int) -> int | None:
    """Champ altitude 12 bits (ADS-B) → pieds."""
    return decode_ac13(((ac & 0xFC0) << 1) | (ac & 0x3F))


def encode_ac12(ft: float) -> int:
    n = round((ft + 1000) / 25)
    return ((n & 0x7F0) << 1) | 0x10 | (n & 0xF)


def encode_ac13(ft: float) -> int:
    n = round((ft + 1000) / 25)
    return ((n & 0x7E0) << 2) | ((n & 0x10) << 1) | 0x10 | (n & 0xF)


# ---------------------------------------------------------------- CPR
def _mod(a: float, b: float) -> float:
    return a - b * math.floor(a / b)


def NL(lat: float) -> int:
    lat = abs(lat)
    if lat == 0:
        return 59
    if lat == 87:
        return 2
    if lat > 87:
        return 1
    a = 1 - math.cos(math.pi / 30)
    c = math.cos(math.pi / 180 * lat)
    return int(math.floor(2 * math.pi / math.acos(1 - a / (c * c))))


def cpr_global(even: dict, odd: dict, last_is_odd: bool) -> tuple[float, float] | None:
    """Décodage global d'une paire pair/impair (position aéroportée)."""
    lat_e, lon_e = even["lat"] / 131072, even["lon"] / 131072
    lat_o, lon_o = odd["lat"] / 131072, odd["lon"] / 131072
    j = math.floor(59 * lat_e - 60 * lat_o + 0.5)
    r_e = 6 * (_mod(j, 60) + lat_e)
    r_o = (360 / 59) * (_mod(j, 59) + lat_o)
    if r_e >= 270: r_e -= 360
    if r_o >= 270: r_o -= 360
    if abs(r_e) > 90 or abs(r_o) > 90 or NL(r_e) != NL(r_o):
        return None
    lat = r_o if last_is_odd else r_e
    nl = NL(lat)
    ni = max(nl - (1 if last_is_odd else 0), 1)
    m = math.floor(lon_e * (nl - 1) - lon_o * nl + 0.5)
    lon = (360 / ni) * (_mod(m, ni) + (lon_o if last_is_odd else lon_e))
    if lon >= 180:
        lon -= 360
    return lat, lon


def cpr_local(cpr: dict, odd: bool, ref_lat: float, ref_lon: float, surface: bool = False):
    """Décodage local relatif à une position de référence (< 180 NM, ou 45 NM au sol)."""
    base = 90 if surface else 360
    lat_c, lon_c = cpr["lat"] / 131072, cpr["lon"] / 131072
    d_lat = base / (59 if odd else 60)
    j = math.floor(ref_lat / d_lat) + math.floor(0.5 + _mod(ref_lat, d_lat) / d_lat - lat_c)
    lat = d_lat * (j + lat_c)
    if abs(lat) > 90:
        return None
    d_lon = base / max(NL(lat) - (1 if odd else 0), 1)
    m = math.floor(ref_lon / d_lon) + math.floor(0.5 + _mod(ref_lon, d_lon) / d_lon - lon_c)
    lon = d_lon * (m + lon_c)
    if lon >= 180: lon -= 360
    if lon < -180: lon += 360
    return lat, lon


def cpr_encode(lat: float, lon: float, odd: int) -> dict:
    d_lat = 360 / (60 - odd)
    yz = math.floor(131072 * _mod(lat, d_lat) / d_lat + 0.5)
    rlat = d_lat * (yz / 131072 + math.floor(lat / d_lat))
    n = NL(rlat) - odd
    d_lon = 360 / n if n > 0 else 360
    xz = math.floor(131072 * _mod(lon, d_lon) / d_lon + 0.5)
    return {"lat": yz & 0x1FFFF, "lon": xz & 0x1FFFF}


def dist_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def bearing(lat1, lon1, lat2, lon2) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def destination(lat, lon, brg_deg, km):
    R = 6371.0088
    d, b = km / R, math.radians(brg_deg)
    l1, g1 = math.radians(lat), math.radians(lon)
    l2 = math.asin(math.sin(l1) * math.cos(d) + math.cos(l1) * math.sin(d) * math.cos(b))
    g2 = g1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(l1), math.cos(d) - math.sin(l1) * math.sin(l2))
    return math.degrees(l2), (math.degrees(g2) + 540) % 360 - 180


# ---------------------------------------------------------------- champs
CHARSET = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######"
DF_NAMES = {0: "ACAS courte", 4: "Altitude", 5: "Identité", 11: "All-Call", 16: "ACAS longue",
            17: "ADS-B", 18: "ADS-B (non transpondeur)", 20: "Comm-B altitude", 21: "Comm-B identité"}
CATEGORIES = {
    4: ["Non précisé", "Léger", "Petit", "Gros porteur", "Gros porteur (forte turbulence)", "Lourd", "Haute performance", "Hélicoptère"],
    3: ["Non précisé", "Planeur", "Plus léger que l’air", "Parachutiste", "ULM", "Réservé", "Drone", "Véhicule spatial"],
    2: ["Non précisé", "Véhicule d’urgence", "Réservé", "Véhicule de service", "Obstacle", "Obstacle", "Obstacle", "Obstacle"],
    1: ["Réservé"] * 8,
}
EMERGENCY = ["", "Urgence générale", "Urgence médicale", "Carburant minimum", "Panne radio",
             "Intervention illicite", "Aéronef retardé", "Réservé"]
FS_NAMES = ["En vol", "Au sol", "Alerte, en vol", "Alerte, au sol", "Alerte + SPI", "SPI", "Réservé", "Non assigné"]


def callsign_at(b: bytes, start: int) -> str:
    s = "".join(CHARSET[bits(b, start + 6 * i, 6)] for i in range(8))
    return s.rstrip("# ").replace("#", "?").strip()


def surface_speed(m: int) -> float | None:
    if m == 0 or m > 124: return None
    if m == 1: return 0.0
    if m <= 8: return 0.125 + (m - 2) * 0.125
    if m <= 12: return 1 + (m - 9) * 0.25
    if m <= 38: return 2 + (m - 13) * 0.5
    if m <= 93: return 15.0 + (m - 39)
    if m <= 108: return 70.0 + (m - 94) * 2
    if m <= 123: return 100.0 + (m - 109) * 5
    return 175.0


def _decode_me(b: bytes, f: dict) -> None:
    me = lambda k, n: bits(b, 32 + k, n)  # noqa: E731  (bits du champ ME, 1-based)
    tc, st = me(1, 5), me(6, 3)
    f["tc"] = tc
    if 1 <= tc <= 4:
        f["kind"] = "ident"
        f["callsign"] = callsign_at(b, 41)
        f["category"] = CATEGORIES.get(tc, [])[st] if tc in CATEGORIES else "Non précisé"
        f["cat_code"] = f"{chr(69 - tc)}{st}"
    elif 5 <= tc <= 8:
        f["kind"] = "surface"
        f["on_ground"] = True
        f["gs"] = surface_speed(me(6, 7))
        if me(13, 1):
            f["track"] = me(14, 7) * 360 / 128
        f["cpr"] = {"odd": me(22, 1), "lat": me(23, 17), "lon": me(40, 17), "surface": True}
    elif 9 <= tc <= 18 or 20 <= tc <= 22:
        f["kind"] = "position"
        ac = me(9, 12)
        if tc <= 18:
            f["alt"] = decode_ac12(ac)
        elif ac:
            f["alt_gnss"] = round(ac * 3.28084)
        f["cpr"] = {"odd": me(22, 1), "lat": me(23, 17), "lon": me(40, 17), "surface": False}
    elif tc == 19:
        f["kind"] = "velocity"
        f["subtype"] = st
        if st in (1, 2):
            k = 4 if st == 2 else 1
            ew, ns = me(15, 10), me(26, 10)
            if ew and ns:
                vx = (-1 if me(14, 1) else 1) * (ew - 1) * k
                vy = (-1 if me(25, 1) else 1) * (ns - 1) * k
                f["gs"] = round(math.hypot(vx, vy), 1)
                f["track"] = round(math.degrees(math.atan2(vx, vy)) % 360, 1)
        elif st in (3, 4):
            if me(14, 1):
                f["heading"] = round(me(15, 10) * 360 / 1024, 1)
            a = me(26, 10)
            if a:
                v = (a - 1) * (4 if st == 4 else 1)
                f["tas" if me(25, 1) else "ias"] = v
        vr = me(38, 9)
        if vr:
            f["vr"] = (-1 if me(37, 1) else 1) * (vr - 1) * 64
            f["vr_src"] = "baro" if me(36, 1) else "GNSS"
        d = me(50, 7)
        if d:
            f["gnss_baro_diff"] = (-1 if me(49, 1) else 1) * (d - 1) * 25
    elif tc == 28:
        f["kind"] = "status"
        if st == 1:
            f["emergency"] = EMERGENCY[me(9, 3)]
            f["squawk"] = squawk_from_id13(me(12, 13))
    elif tc == 29:
        f["kind"] = "target"
        if me(6, 2) == 1:
            sa = me(10, 11)
            if sa:
                f["sel_alt"] = (sa - 1) * 32
            q = me(21, 9)
            if q:
                f["qnh"] = round(800 + (q - 1) * 0.8, 1)
            if me(30, 1):
                f["sel_heading"] = round(me(31, 9) * 180 / 256, 1)
    elif tc == 31:
        f["kind"] = "opstatus"
        f["version"] = me(41, 3)
    else:
        f["kind"] = "other"


def decode_fields(b: bytes, df: int | None = None) -> dict:
    """Décode les champs d'une trame valide (7 ou 14 octets)."""
    df = b[0] >> 3 if df is None else df
    f: dict = {"df": df}
    if df in (17, 18):
        if df == 18:
            f["cf"] = bits(b, 6, 3)
            if f["cf"] > 1 and f["cf"] != 6:
                f["kind"] = "tisb"
                return f
        else:
            f["ca"] = bits(b, 6, 3)
        _decode_me(b, f)
    elif df == 11:
        f["kind"] = "allcall"
        f["ca"] = bits(b, 6, 3)
    elif df in (0, 16, 4, 20):
        f["kind"] = "alt"
        f["alt"] = decode_ac13(bits(b, 20, 13))
        if df in (0, 16):
            f["on_ground"] = bits(b, 6, 1) == 1
        else:
            fs = bits(b, 6, 3)
            f.update(fs=FS_NAMES[fs], on_ground=fs in (1, 3), alert=2 <= fs <= 4, spi=fs in (4, 5))
    elif df in (5, 21):
        f["kind"] = "squawk"
        f["squawk"] = squawk_from_id13(bits(b, 20, 13))
        fs = bits(b, 6, 3)
        f.update(fs=FS_NAMES[fs], on_ground=fs in (1, 3), alert=2 <= fs <= 4, spi=fs in (4, 5))
    if df in (20, 21) and bits(b, 33, 8) == 0x20:  # Comm-B BDS 2,0
        cs = callsign_at(b, 41)
        if cs and all(c.isalnum() or c == " " for c in cs):
            f["callsign"] = cs
    return f


def summarize(f: dict) -> str:
    p = []
    if f.get("callsign"): p.append(f"Indicatif {f['callsign']}")
    if f.get("kind") == "ident" and f.get("category"): p.append(f["category"])
    if f.get("alt") is not None: p.append(f"{f['alt']} ft")
    if f.get("alt_gnss") is not None: p.append(f"{f['alt_gnss']} ft GNSS")
    if f.get("cpr"): p.append(f"CPR {'impair' if f['cpr']['odd'] else 'pair'}{' (sol)' if f['cpr']['surface'] else ''}")
    if f.get("gs") is not None: p.append(f"{round(f['gs'])} kt")
    if f.get("track") is not None: p.append(f"route {round(f['track'])}°")
    if f.get("heading") is not None: p.append(f"cap {round(f['heading'])}°")
    if f.get("ias") is not None: p.append(f"IAS {f['ias']} kt")
    if f.get("tas") is not None: p.append(f"TAS {f['tas']} kt")
    if f.get("vr") is not None: p.append(f"{f['vr']:+d} ft/min")
    if f.get("squawk"): p.append(f"squawk {f['squawk']}")
    if f.get("emergency"): p.append(f["emergency"])
    if f.get("sel_alt") is not None: p.append(f"alt. sélectionnée {f['sel_alt']} ft")
    if f.get("qnh") is not None: p.append(f"QNH {f['qnh']} hPa")
    if f.get("version") is not None: p.append(f"ADS-B v{f['version']}")
    if f.get("kind") == "allcall": p.append(f"capacité {f['ca']}")
    if f.get("fs") and f["fs"] != "En vol": p.append(f["fs"])
    return " · ".join(p) if p else (f"TC {f['tc']}" if "tc" in f else "—")


# ---------------------------------------------------------------- validation de trames déjà extraites
def frame_bytes(v) -> bytes | None:
    """Normalise une trame : hexadécimal (avec ou sans *…; @horodatage) ou octets → 7/14 octets."""
    if v is None:
        return None
    if isinstance(v, (bytes, bytearray, memoryview)):
        v = bytes(v)
        return v if len(v) in (7, 14) else None
    if not isinstance(v, str):
        return None
    h = v.strip().lstrip("*:").rstrip(";")
    if h[:1] in ("@", "%"):
        h = h[13:]
    h = "".join(h.split()).replace(";", "")
    if len(h) not in (14, 28):
        return None
    try:
        return bytes.fromhex(h)
    except ValueError:
        return None


class FrameValidator:
    """Valide les trames (CRC, correction 1 bit, adresse-parité sur ICAO connues) et les décode."""

    def __init__(self, fix1: bool = True, trust_ap: bool = False):
        self.fix1, self.trust_ap = fix1, trust_ap
        self.known: set[int] = set()
        self.stats = {"frames": 0, "valid": 0, "fixed": 0, "crc_fail": 0, "by_df": {}}

    def check(self, b: bytes) -> tuple[bytes, int, str, int | None] | None:
        """Retourne (octets éventuellement corrigés, icao, statut, bit corrigé) ou None."""
        df = b[0] >> 3
        if df not in DF_NAMES or (df >= 16) != (len(b) == 14):
            return None
        res = residual(b)
        if df in (17, 18):
            fixed = None
            if res:
                if not self.fix1 or res not in SYN112:
                    return None
                fixed = SYN112[res]
                bb = bytearray(b)
                bb[fixed >> 3] ^= 0x80 >> (fixed & 7)
                b = bytes(bb)
            icao = bits(b, 9, 24)
            if df == 17 or bits(b, 6, 3) == 0:
                self.known.add(icao)
            return b, icao, ("corrigé" if fixed is not None else "ok"), fixed
        if df == 11:
            if res & 0xFFFF80:
                return None
            icao = bits(b, 9, 24)
            self.known.add(icao)
            return b, icao, "ok", None
        if res in self.known or self.trust_ap:
            if self.trust_ap:
                self.known.add(res)
            return b, res, "AP", None
        return None

    def decode(self, raw, t: float, rssi: float | None = None) -> dict | None:
        self.stats["frames"] += 1
        b = frame_bytes(raw)
        r = self.check(b) if b else None
        if not r:
            self.stats["crc_fail"] += 1
            return None
        b, icao, status, fixed = r
        return self._record(b, icao, status, fixed, t, rssi, None)

    def _record(self, b, icao, status, fixed, t, rssi, snr) -> dict:
        df = b[0] >> 3
        s = self.stats
        s["valid"] += 1
        s["fixed"] += status == "corrigé"
        s["by_df"][df] = s["by_df"].get(df, 0) + 1
        f = decode_fields(b, df)
        m = {"t": t, "hex": b.hex().upper(), "df": df, "icao": f"{icao:06X}", "crc": status,
             "rssi": rssi, "snr": snr, "f": f}
        if fixed is not None:
            m["fixed_bit"] = fixed
        if df == 18 and f.get("cf") == 1:
            m["icao"] = "~" + m["icao"]
        return m


# ---------------------------------------------------------------- encodeur (démo, tests)
def _finalize(b: bytearray, ap: int = 0) -> bytes:
    c = crc24(b, len(b) - 3) ^ ap
    b[-3:] = bytes(((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF))
    return bytes(b)


def _es(icao: int, tc: int, st: int) -> bytearray:
    b = bytearray(14)
    set_bits(b, 1, 5, 17); set_bits(b, 6, 3, 5); set_bits(b, 9, 24, icao)
    set_bits(b, 33, 5, tc); set_bits(b, 38, 3, st)
    return b


def enc_ident(icao, cs, tc=4, cat=3) -> bytes:
    b, s = _es(icao, tc, cat), cs.upper().ljust(8)
    for i in range(8):
        set_bits(b, 41 + 6 * i, 6, max(0, CHARSET.find(s[i])))
    return _finalize(b)


def enc_position(icao, lat, lon, alt_ft, odd) -> bytes:
    b, c = _es(icao, 11, 0), cpr_encode(lat, lon, odd)
    set_bits(b, 41, 12, encode_ac12(alt_ft)); set_bits(b, 54, 1, odd)
    set_bits(b, 55, 17, c["lat"]); set_bits(b, 72, 17, c["lon"])
    return _finalize(b)


def enc_velocity(icao, gs, trk, vr) -> bytes:
    b = _es(icao, 19, 1)
    vx, vy = gs * math.sin(math.radians(trk)), gs * math.cos(math.radians(trk))
    set_bits(b, 46, 1, vx < 0); set_bits(b, 47, 10, min(1023, round(abs(vx)) + 1))
    set_bits(b, 57, 1, vy < 0); set_bits(b, 58, 10, min(1023, round(abs(vy)) + 1))
    set_bits(b, 68, 1, 1); set_bits(b, 69, 1, vr < 0); set_bits(b, 70, 9, min(511, round(abs(vr) / 64) + 1))
    return _finalize(b)


def enc_emergency(icao, squawk, code) -> bytes:
    b = _es(icao, 28, 1)
    set_bits(b, 41, 3, code); set_bits(b, 44, 13, id13_from_squawk(squawk))
    return _finalize(b)


def enc_allcall(icao, ca=5) -> bytes:
    b = bytearray(7)
    set_bits(b, 1, 5, 11); set_bits(b, 6, 3, ca); set_bits(b, 9, 24, icao)
    return _finalize(b)


def enc_alt(icao, alt_ft, fs=0) -> bytes:
    b = bytearray(7)
    set_bits(b, 1, 5, 4); set_bits(b, 6, 3, fs); set_bits(b, 20, 13, encode_ac13(alt_ft))
    return _finalize(b, icao)


def enc_squawk(icao, sq, fs=0) -> bytes:
    b = bytearray(7)
    set_bits(b, 1, 5, 5); set_bits(b, 6, 3, fs); set_bits(b, 20, 13, id13_from_squawk(sq))
    return _finalize(b, icao)
