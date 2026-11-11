"""Suivi des aéronefs : agrégation des messages, positions CPR (global puis local), trajectoires."""
from __future__ import annotations

from dataclasses import dataclass, field

from .modes import bearing, cpr_global, cpr_local, dist_km

_FIELDS = ("gs", "track", "vr", "ias", "tas", "heading", "sel_alt", "qnh", "version")


@dataclass
class Aircraft:
    icao: str
    first: float
    last: float
    msgs: int = 0
    df: dict = field(default_factory=dict)
    callsign: str | None = None
    category: str | None = None
    cat_code: str | None = None
    alt: int | None = None
    alt_gnss: int | None = None
    squawk: str | None = None
    emergency: str | None = None
    on_ground: bool | None = None
    lat: float | None = None
    lon: float | None = None
    pos_t: float | None = None
    dist: float | None = None
    brg: float | None = None
    rssi: float | None = None
    gs: float | None = None
    track: float | None = None
    vr: int | None = None
    ias: int | None = None
    tas: int | None = None
    heading: float | None = None
    sel_alt: int | None = None
    qnh: float | None = None
    version: int | None = None
    trail: list = field(default_factory=list)
    _rssi_sum: float = 0.0
    _rssi_n: int = 0
    _cpr: dict = field(default_factory=lambda: {"even": None, "odd": None})
    _pending: tuple | None = None

    def to_dict(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if not k.startswith("_") and k != "trail"}
        d["positions"] = len(self.trail)
        return d


class Tracker:
    def __init__(self, ref: tuple[float, float] | None = None, trail_step: float = 0.0):
        self.ref = ref
        self.trail_step = trail_step
        self.aircraft: dict[str, Aircraft] = {}
        self.positions = 0
        self.max_range_km = 0.0

    def update(self, m: dict) -> Aircraft:
        f, t = m["f"], m["t"]
        a = self.aircraft.get(m["icao"])
        if a is None:
            a = self.aircraft[m["icao"]] = Aircraft(m["icao"], t, t)
        a.msgs += 1
        a.first, a.last = min(a.first, t), max(a.last, t)
        key = "état" if m["df"] is None else m["df"]
        a.df[key] = a.df.get(key, 0) + 1
        if m.get("rssi") is not None:
            a._rssi_sum += m["rssi"]; a._rssi_n += 1
            a.rssi = round(a._rssi_sum / a._rssi_n, 1)
        if f.get("callsign"): a.callsign = f["callsign"]
        if f.get("kind") == "ident": a.category, a.cat_code = f.get("category"), f.get("cat_code")
        if f.get("alt") is not None: a.alt = f["alt"]
        if f.get("alt_gnss") is not None: a.alt_gnss = f["alt_gnss"]
        if f.get("squawk"): a.squawk = f["squawk"]
        if f.get("emergency"): a.emergency = f["emergency"]
        if f.get("on_ground") is not None: a.on_ground = f["on_ground"]
        if f.get("cat_code") and not a.cat_code: a.cat_code = f["cat_code"]
        for k in _FIELDS:
            if f.get(k) is not None:
                setattr(a, k, f[k])
        if f.get("cpr"):
            self._cpr(a, f["cpr"], t, f)
        elif f.get("lat") is not None and f.get("lon") is not None and (f["lat"] or f["lon"]):
            last = a.trail[-1] if a.trail else None
            self._accept(a, f["lat"], f["lon"], t, f,
                         push=not last or abs(t - last[0]) >= self.trail_step or dist_km(last[1], last[2], f["lat"], f["lon"]) > 2)
        return a

    def _accept(self, a, lat, lon, t, f, push=True):
        a.lat, a.lon, a.pos_t = lat, lon, t
        self.positions += 1
        if push:
            a.trail.append((t, lat, lon, f.get("alt", a.alt)))
        if self.ref:
            a.dist = dist_km(self.ref[0], self.ref[1], lat, lon)
            a.brg = bearing(self.ref[0], self.ref[1], lat, lon)
            self.max_range_km = max(self.max_range_km, a.dist)

    def _cpr(self, a: Aircraft, cpr: dict, t: float, f: dict):
        odd = bool(cpr["odd"])
        a._cpr["odd" if odd else "even"] = {"lat": cpr["lat"], "lon": cpr["lon"], "t": t}
        if cpr["surface"]:
            ref = (a.lat, a.lon) if a.lat is not None else self.ref
            if not ref:
                return
            p = cpr_local(cpr, odd, ref[0], ref[1], surface=True)
            if p and dist_km(ref[0], ref[1], *p) < 45:
                self._accept(a, *p, t, f)
            return
        if a.lat is not None and t - a.pos_t < 30:  # local, relatif à la dernière position
            p = cpr_local(cpr, odd, a.lat, a.lon)
            if p and dist_km(a.lat, a.lon, *p) < 3 + (t - a.pos_t) * 0.4:
                self._accept(a, *p, t, f)
                return
        e, o = a._cpr["even"], a._cpr["odd"]
        if e and o and abs(e["t"] - o["t"]) < 10:
            p = cpr_global(e, o, odd)
            if not p:
                return
            if self.ref and dist_km(self.ref[0], self.ref[1], *p) > 700:
                return
            if a.lat is not None and dist_km(a.lat, a.lon, *p) > 5 + (t - a.pos_t) * 0.4:
                # saut incohérent : on attend une deuxième position concordante
                if a._pending and dist_km(*a._pending, *p) < 5:
                    a.trail.clear()
                    self._accept(a, *p, t, f)
                    a._pending = None
                else:
                    a._pending = p
                return
            self._accept(a, *p, t, f)

    def visible(self, min_msgs: int = 2) -> list[Aircraft]:
        return [a for a in self.aircraft.values() if a.msgs >= min_msgs]
