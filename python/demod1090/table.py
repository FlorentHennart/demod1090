"""Fichiers Parquet ADS-B : trames Mode S brutes ou états déjà décodés (nécessite pyarrow)."""
from __future__ import annotations

import datetime as _dt
import math
import re
from typing import Callable, Iterator

from .modes import FrameValidator, frame_bytes

ROLES = {
    "icao": r"^(icao_?24|icao|hex|icao_?hex|icao_?address|address|aa|transponder|mode_?s_?code|addr)$",
    "callsign": r"^(flight|callsign|call_?sign|ident|flight_?id|flight_?number|cs)$",
    "lat": r"^(lat|latitude)$",
    "lon": r"^(lon|lng|long|longitude)$",
    "alt": r"^(alt_?baro|baro_?alt(itude)?|baroaltitude|altitude|alt|altitude_?baro|barometric_?altitude|alt_?ft|altitude_?ft)$",
    "alt_gnss": r"^(alt_?geom|geo_?alt(itude)?|geoaltitude|gnss_?alt(itude)?|altitude_?geom|alt_?gnss)$",
    "gs": r"^(gs|ground_?speed|groundspeed|speed|velocity|spd|gspeed)$",
    "track": r"^(track|true_?track|course|trk|cog)$",
    "heading": r"^(heading|hdg|true_?heading|mag_?heading|nav_?heading)$",
    "vr": r"^(baro_?rate|vert_?rate|vertical_?rate|vertrate|geom_?rate|vr|roc|vs|vspeed)$",
    "squawk": r"^(squawk|sqk|mode_?a|squawk_?code)$",
    "time": r"^(time|timestamp|ts|t|mintime|seen_?time|received|received_?at|rx_?time|datetime|date_?time|event_?time|lastcontact|last_?contact|last_?seen|created_?at|time_?position|recorded_?at|epoch|unix_?time|msg_?time|now)$",
    "rssi": r"^(rssi|signal|signal_?level|level|signal_?strength|dbfs)$",
    "ground": r"^(on_?ground|onground|ground|is_?on_?ground|gnd)$",
    "category": r"^(category|cat|emitter_?category|aircraft_?category)$",
}
METRIC = re.compile(r"^(baroaltitude|geoaltitude|velocity|vertrate|altitude_?m|alt_?m)$", re.I)


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def to_seconds(v) -> float | None:
    """Temps en secondes Unix (datetime, ISO, s, ms, µs, ns)."""
    if v is None:
        return None
    if isinstance(v, _dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=_dt.timezone.utc)
        return v.timestamp()
    if isinstance(v, str) and not re.fullmatch(r"\d+(\.\d+)?", v.strip()):
        try:
            d = _dt.datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return to_seconds(d)
    x = _num(v)
    if x is None:
        return None
    a = abs(x)
    return x / 1e9 if a > 1e17 else x / 1e6 if a > 1e14 else x / 1e3 if a > 1e11 else x


def icao_of(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, int):
        return f"{v:06X}"
    s = str(v).strip().upper()
    s = s[2:] if s.startswith("0X") else s
    if re.fullmatch(r"~?[0-9A-F]{6}", s):
        return s
    return s.zfill(6) if re.fullmatch(r"[0-9A-F]{1,6}", s) else None


def analyze(names: list[str], sample: list[dict]) -> dict:
    """Associe les rôles aux colonnes (noms + valeurs d'un échantillon). mode : 'frames', 'states' ou None."""
    roles: dict[str, str] = {}
    best = None
    for n in names:
        vals = [r.get(n) for r in sample if r.get(n) is not None]
        ok = sum(1 for v in vals if frame_bytes(v))
        if vals and ok / len(vals) >= 0.6 and (not best or ok > best[1]):
            best = (n, ok)
    if best:
        roles["frame"] = best[0]
    for role, pat in ROLES.items():
        for n in names:
            if n != roles.get("frame") and (re.match(pat, n.split(".")[-1], re.I) or re.match(pat, n, re.I)):
                roles[role] = n
                break
    if "icao" in roles:
        vals = [r.get(roles["icao"]) for r in sample if r.get(roles["icao"]) is not None][:50]
        if vals and sum(1 for v in vals if icao_of(v)) / len(vals) < 0.6:
            del roles["icao"]
    units = {k: ("metric" if METRIC.match(roles[k].split(".")[-1]) else "imperial") for k in ("alt", "alt_gnss", "gs", "vr") if k in roles}
    mode = "frames" if "frame" in roles else "states" if "icao" in roles and any(k in roles for k in ("lat", "alt", "callsign", "gs")) else None
    return {"roles": roles, "units": units, "mode": mode}


def state_fields(r: dict, roles: dict, units: dict) -> dict:
    """Ligne « état » → champs décodés (pieds, nœuds, ft/min)."""
    f: dict = {"df": None, "kind": "state"}
    g = lambda k: r.get(roles[k]) if k in roles else None  # noqa: E731
    alt = g("alt")
    if isinstance(alt, str) and re.search(r"ground|gnd", alt, re.I):
        f["on_ground"] = True
    elif (a := _num(alt)) is not None:
        f["alt"] = round(a * 3.28084 if units.get("alt") == "metric" else a)
    if (a := _num(g("alt_gnss"))) is not None:
        f["alt_gnss"] = round(a * 3.28084 if units.get("alt_gnss") == "metric" else a)
    if (v := _num(g("gs"))) is not None:
        f["gs"] = round(v * 1.943844 if units.get("gs") == "metric" else v, 1)
    if (v := _num(g("track"))) is not None:
        f["track"] = round(v, 1)
    if (v := _num(g("heading"))) is not None:
        f["heading"] = round(v, 1)
    if (v := _num(g("vr"))) is not None:
        f["vr"] = round(v * 196.850 if units.get("vr") == "metric" else v)
    la, lo = _num(g("lat")), _num(g("lon"))
    if la is not None and lo is not None and abs(la) <= 90 and abs(lo) <= 180:
        f["lat"], f["lon"] = la, lo
    cs = g("callsign")
    if cs is not None and str(cs).strip():
        f["callsign"] = str(cs).strip().upper()
    sq = g("squawk")
    if sq is not None and str(sq).strip():
        s = f"{int(sq):04d}" if isinstance(sq, (int, float)) and not isinstance(sq, bool) else str(sq).strip()
        if re.fullmatch(r"[0-7]{4}", s):
            f["squawk"] = s
    gr = g("ground")
    if gr is not None:
        f["on_ground"] = gr is True or gr == 1 or bool(re.fullmatch(r"true|1|yes|ground", str(gr), re.I))
    cat = g("category")
    if cat is not None and str(cat).strip():
        f["cat_code"] = str(cat).strip()
    return f


class ParquetReader:
    """Lit un Parquet ADS-B par lots ; produit des messages au même format que le démodulateur."""

    def __init__(self, path: str, batch_rows: int = 200_000):
        try:
            import pyarrow.parquet as pq
        except ImportError as e:  # pragma: no cover
            raise ImportError("La lecture Parquet nécessite pyarrow : pip install pyarrow") from e
        self.path, self.batch_rows = path, batch_rows
        self.pf = pq.ParquetFile(path)
        self.total = self.pf.metadata.num_rows
        self.names = [f.name for f in self.pf.schema_arrow]
        first = next(self.pf.iter_batches(batch_size=400), None)
        sample = first.to_pylist() if first is not None else []
        self.info = analyze(self.names, sample)
        self.validator = FrameValidator(fix1=True)
        self.t_min = self.t_max = None

    def _scan_time(self):
        col = self.info["roles"].get("time")
        if not col:
            return
        lo, hi = math.inf, -math.inf
        for b in self.pf.iter_batches(batch_size=self.batch_rows, columns=[col]):
            for v in b.column(0).to_pylist():
                t = to_seconds(v)
                if t is not None:
                    lo, hi = min(lo, t), max(hi, t)
        if hi >= lo:
            self.t_min, self.t_max = lo, hi

    def messages(self, progress: Callable[[int, int], None] | None = None) -> Iterator[dict]:
        info = self.info
        if not info["mode"]:
            raise ValueError("Colonnes non reconnues : il faut une colonne de trames Mode S (hexadécimal) "
                             "ou des colonnes ICAO + position/altitude. Colonnes présentes : " + ", ".join(self.names))
        roles, units = info["roles"], info["units"]
        self._scan_time()
        cols = list(dict.fromkeys(roles.values()))
        done = 0
        for b in self.pf.iter_batches(batch_size=self.batch_rows, columns=cols):
            for i, r in enumerate(b.to_pylist()):
                t = to_seconds(r.get(roles["time"])) if "time" in roles else None
                t = (done + i) / 1000 if t is None and self.t_min is None else (None if t is None else t - self.t_min)
                if t is None:
                    continue
                rssi = _num(r.get(roles["rssi"])) if "rssi" in roles else None
                if info["mode"] == "frames":
                    m = self.validator.decode(r.get(roles["frame"]), t, rssi)
                    if m:
                        yield m
                else:
                    icao = icao_of(r.get(roles["icao"]))
                    if icao:
                        yield {"t": t, "hex": "", "df": None, "icao": icao, "crc": "état", "rssi": rssi, "snr": None,
                               "f": state_fields(r, roles, units)}
            done += b.num_rows
            if progress:
                progress(done, self.total)
