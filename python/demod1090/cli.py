"""Ligne de commande : python -m demod1090 FICHIER [options]."""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys

from . import __version__
from .demod import demodulate, probe_rate
from .iq import FORMATS, open_source
from .modes import DF_NAMES, summarize
from .tracker import Tracker

def nfmt(n) -> str:
    """Entier avec espace comme séparateur de milliers."""
    return f"{n:,}".replace(",", "\u202f")


EMG = {"7500": "Intervention illicite", "7600": "Panne radio", "7700": "Urgence"}


def parse_rate(s: str) -> float:
    m = re.fullmatch(r"\s*([\d.,eE+-]+)\s*([kKmM]?)(?:s/s|sps|hz)?\s*", s)
    if not m:
        raise argparse.ArgumentTypeError(f"fréquence illisible : {s!r} (ex. 2.4M, 2400000, 40e6)")
    v = float(m.group(1).replace(",", "."))
    v *= {"k": 1e3, "m": 1e6}.get(m.group(2).lower(), 1)
    if v < 1000:  # « 2.4 » → MS/s
        v *= 1e6
    return v


def parse_ref(s: str):
    try:
        la, lo = (float(x) for x in s.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("position attendue : LAT,LON (ex. 48.72,2.36)")
    return la, lo


class Progress:
    def __init__(self, enabled: bool, label: str):
        self.enabled, self.label = enabled and sys.stderr.isatty(), label

    def __call__(self, done, total, elapsed=None):
        if not self.enabled or not total:
            return
        p = done / total
        bar = "█" * int(p * 30) + "·" * (30 - int(p * 30))
        sys.stderr.write(f"\r{self.label} {bar} {p * 100:5.1f} %")
        sys.stderr.flush()

    def end(self):
        if self.enabled:
            sys.stderr.write("\r" + " " * 70 + "\r")


def fmt_t(t, epoch):
    if epoch is None:
        return f"{t:10.6f}"
    return dt.datetime.fromtimestamp(epoch + t, dt.timezone.utc).strftime("%H:%M:%S.%f")[:-3]


def print_aircraft(tr: Tracker, epoch, min_msgs: int, out=sys.stdout):
    acs = sorted(tr.visible(min_msgs), key=lambda a: -a.msgs)
    if not acs:
        print("Aucun aéronef décodé.", file=out)
        return
    hdr = f"{'ICAO':7} {'Indicatif':9} {'Squawk':6} {'Alt (ft)':>8} {'Vit (kt)':>8} {'Route':>5} {'Vario':>6} {'Position':>20} {'Dist':>7} {'Msg':>5} {'dB':>6}  Vu"
    print(hdr, file=out)
    print("─" * len(hdr), file=out)
    for a in acs:
        pos = f"{a.lat:8.4f},{a.lon:9.4f}" if a.lat is not None else ""
        dist = f"{a.dist / 1.852:5.1f}NM" if a.dist is not None else ""
        seen = f"{fmt_t(a.first, epoch).strip()} → {fmt_t(a.last, epoch).strip()}"
        emg = f"  ⚠ {EMG.get(a.squawk) or a.emergency}" if (a.squawk in EMG or a.emergency) else ""
        print(f"{a.icao:7} {a.callsign or '':9} {a.squawk or '':6} {'' if a.alt is None else a.alt:>8} "
              f"{'' if a.gs is None else round(a.gs):>8} {'' if a.track is None else round(a.track):>5} "
              f"{'' if a.vr is None else a.vr:>6} {pos:>20} {dist:>7} {a.msgs:>5} {'' if a.rssi is None else a.rssi:>6}  {seen}{emg}",
              file=out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="demod1090", description="Démodulateur ADS-B / Mode S pour enregistrements IQ "
                                 "(int16, uint8, int8, float32, WAV, MATLAB .mat) et fichiers Parquet de trames ou de positions.")
    ap.add_argument("fichier", nargs="?", help="enregistrement IQ, .wav, .mat ou .parquet")
    ap.add_argument("-f", "--format", choices=list(FORMATS) + ["wav", "mat", "parquet"], help="format (deviné sinon ; défaut cs16)")
    ap.add_argument("-r", "--rate", type=parse_rate, help="fréquence d'échantillonnage (ex. 2.4M) ; recherchée automatiquement si absente")
    ap.add_argument("-t", "--threshold", type=float, default=8.0, help="seuil de détection du préambule en dB (défaut 8)")
    ap.add_argument("--no-fix", action="store_true", help="désactive la correction d'un bit (DF17/18)")
    ap.add_argument("--ref", type=parse_ref, help="position du récepteur LAT,LON (distances, positions au sol)")
    ap.add_argument("--demo", action="store_true", help="démodule un signal synthétique (7 avions autour d'Orly)")
    ap.add_argument("--demo-rate", type=parse_rate, default=2.4e6, help="fréquence de la démo (défaut 2.4M)")
    ap.add_argument("--demo-duration", type=float, default=10.0, help="durée de la démo en s (défaut 10)")
    ap.add_argument("--write-demo", metavar="FICHIER.cs16", help="écrit le signal de démo au format cs16 puis quitte")
    ap.add_argument("-m", "--messages", action="store_true", help="affiche chaque message décodé")
    ap.add_argument("--min-msgs", type=int, default=2, help="messages minimum pour lister un aéronef (défaut 2)")
    ap.add_argument("--avr", metavar="FICHIER", help="exporte les trames au format AVR (*HEX;) — « - » pour la sortie standard")
    ap.add_argument("--csv", metavar="FICHIER", help="exporte les messages en CSV")
    ap.add_argument("--json", metavar="FICHIER", help="exporte aéronefs + statistiques en JSON")
    ap.add_argument("--geojson", metavar="FICHIER", help="exporte les trajectoires en GeoJSON")
    ap.add_argument("-q", "--quiet", action="store_true", help="pas de barre de progression")
    ap.add_argument("--version", action="version", version=f"demod1090 {__version__}")
    a = ap.parse_args(argv)

    if a.write_demo:
        from .synth import Scenario
        sc = Scenario(fs=a.demo_rate, duration=a.demo_duration)
        sc.write_cs16(a.write_demo)
        print(f"Démo écrite : {a.write_demo} ({sc.total} échantillons cs16 à {a.demo_rate / 1e6:g} MS/s)")
        return 0
    if not a.fichier and not a.demo:
        ap.print_help()
        return 2

    epoch, notes, ref = None, [], a.ref
    msgs: list[dict]
    if a.demo:
        from .synth import Scenario
        src = Scenario(fs=a.demo_rate, duration=a.demo_duration)
        fs, ref = a.demo_rate, ref or src.ref
        notes.append("signal synthétique généré localement (exemple, pas une vraie capture)")
    elif a.format == "parquet" or a.fichier.lower().endswith(".parquet") or _is_parquet(a.fichier):
        return _run_parquet(a, ref)
    else:
        src, fs, notes = open_source(a.fichier, None if a.format in (None,) else a.format, a.rate)
        if not fs:
            print("Fréquence d'échantillonnage inconnue : recherche automatique…", file=sys.stderr)
            res = probe_rate(src)
            best = max(res, key=lambda x: x[1])
            if best[1] < 2:
                print("Aucune fréquence testée ne donne de trame valide : précisez --rate.", file=sys.stderr)
                return 1
            fs = best[0]
            notes.append(f"fréquence détectée automatiquement : {fs / 1e6:g} MS/s ({best[1]} trames valides à l'essai)")

    print(f"Source : {src.description}")
    for n in notes:
        print(f"  · {n}")
    print(f"  · {nfmt(src.total)} échantillons à {fs / 1e6:g} MS/s = {src.total / fs:.3f} s")
    pr = Progress(not a.quiet, "Démodulation")
    msgs, st = demodulate(src, fs, a.threshold, not a.no_fix, progress=pr)
    pr.end()
    tr = Tracker(ref)
    for m in msgs:
        tr.update(m)
    dur = src.total / fs
    print(f"\n{len(msgs)} messages valides ({len(msgs) / dur:.1f} msg/s, {st['fixed']} corrigés) · "
          f"{len(tr.visible(a.min_msgs))} aéronefs · {tr.positions} positions · "
          f"calcul {st['elapsed']:.2f} s (×{dur / max(st['elapsed'], 1e-9):.1f} temps réel)")
    print("Par type : " + ", ".join(f"DF{k} {DF_NAMES.get(k, '')} ×{v}" for k, v in sorted(st["by_df"].items())))
    if tr.ref and tr.max_range_km:
        print(f"Portée max : {tr.max_range_km / 1.852:.0f} NM ({tr.max_range_km:.0f} km)")
    print()
    return _finish(a, msgs, tr, st, epoch)


def _is_parquet(path):
    try:
        with open(path, "rb") as fh:
            return fh.read(4) == b"PAR1"
    except OSError:
        return False


def _run_parquet(a, ref) -> int:
    from .table import ParquetReader
    rd = ParquetReader(a.fichier)
    info = rd.info
    print(f"Source : {os.path.basename(a.fichier)} (Parquet, {nfmt(rd.total)} lignes)")
    if not info["mode"]:
        print("Colonnes non reconnues : " + ", ".join(rd.names), file=sys.stderr)
        return 1
    kind = "trames Mode S" if info["mode"] == "frames" else "positions déjà décodées"
    print(f"  · {kind} ; colonnes : " + ", ".join(f"{k}={v}" for k, v in info["roles"].items()))
    pr = Progress(not a.quiet, "Lecture")
    tr = Tracker(ref, trail_step=5 if info["mode"] == "states" else 0)
    msgs = []
    for m in rd.messages(progress=pr):
        tr.update(m)
        msgs.append(m)
    pr.end()
    epoch = rd.t_min
    if epoch is not None:
        span = rd.t_max - rd.t_min
        start = dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        print(f"  · période : {start} UTC + {span / 60:.1f} min")
    st = dict(rd.validator.stats) if info["mode"] == "frames" else {"rows": rd.total}
    print(f"\n{nfmt(len(msgs))} {'messages valides' if info['mode'] == 'frames' else 'états'} · "
          f"{nfmt(len(tr.visible(a.min_msgs)))} aéronefs · {nfmt(tr.positions)} positions\n")
    return _finish(a, msgs, tr, st, epoch)


def _finish(a, msgs, tr: Tracker, st, epoch) -> int:
    if a.messages:
        for m in msgs:
            print(f"{fmt_t(m['t'], epoch)}  {m['icao']:7} {'État' if m['df'] is None else 'DF' + str(m['df']):5} "
                  f"{m['crc']:7} {m['hex']:28}  {summarize(m['f'])}")
        print()
    print_aircraft(tr, epoch, a.min_msgs)
    if a.avr:
        lines = "".join(f"*{m['hex']};\n" for m in msgs if m["hex"])
        if a.avr == "-":
            sys.stdout.write(lines)
        else:
            open(a.avr, "w").write(lines)
            print(f"\nAVR : {a.avr}")
    if a.csv:
        with open(a.csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["t", "utc", "icao", "df", "crc", "hex", "rssi_db", "snr_db", "resume"])
            for m in msgs:
                utc = dt.datetime.fromtimestamp(epoch + m["t"], dt.timezone.utc).isoformat() if epoch is not None else ""
                w.writerow([f"{m['t']:.6f}", utc, m["icao"], m["df"], m["crc"], m["hex"], m["rssi"], m["snr"], summarize(m["f"])])
        print(f"CSV : {a.csv}")
    if a.json:
        doc = {"stats": {k: v for k, v in st.items() if k != "by_df"} | {"by_df": {str(k): v for k, v in st.get("by_df", {}).items()}},
               "epoch": epoch, "aircraft": [x.to_dict() for x in tr.visible(a.min_msgs)]}
        json.dump(doc, open(a.json, "w"), ensure_ascii=False, indent=1, default=str)
        print(f"JSON : {a.json}")
    if a.geojson:
        feats = []
        for x in tr.visible(a.min_msgs):
            if len(x.trail) >= 1:
                coords = [[p[2], p[1]] + ([round(p[3] * 0.3048)] if p[3] is not None else []) for p in x.trail]
                geom = {"type": "LineString", "coordinates": coords} if len(coords) > 1 else {"type": "Point", "coordinates": coords[0]}
                feats.append({"type": "Feature", "geometry": geom,
                              "properties": {"icao": x.icao, "callsign": x.callsign, "squawk": x.squawk, "msgs": x.msgs}})
        json.dump({"type": "FeatureCollection", "features": feats}, open(a.geojson, "w"), ensure_ascii=False)
        print(f"GeoJSON : {a.geojson} ({len(feats)} trajectoires)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
