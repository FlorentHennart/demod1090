"""Tests de la version Python : pytest (depuis le dossier python/)."""
import math
import os
import struct
import zlib

import numpy as np
import pytest

from demod1090 import modes as M
from demod1090.demod import demodulate, probe_rate
from demod1090.iq import ArraySource, guess_from_name, parse_mat, parse_wav, to_magnitude
from demod1090.synth import Scenario
from demod1090.tracker import Tracker

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
dec = lambda h: M.decode_fields(bytes.fromhex(h))  # noqa: E731


# ---------------------------------------------------------------- trames de référence
@pytest.mark.parametrize("h", ["8D4840D6202CC371C32CE0576098", "8D40621D58C382D690C8AC2863A7",
                               "8D485020994409940838175B284F", "8DA05F219B06B6AF189400CBC33F"])
def test_crc_nul(h):
    assert M.residual(bytes.fromhex(h)) == 0


def test_decodage_reference():
    assert dec("8D4840D6202CC371C32CE0576098")["callsign"] == "KLM1023"
    v = dec("8D485020994409940838175B284F")
    assert round(v["gs"]) == 159 and abs(v["track"] - 182.88) < 0.1 and v["vr"] == -832
    v3 = dec("8DA05F219B06B6AF189400CBC33F")
    assert round(v3["heading"]) == 244 and v3["tas"] == 375 and v3["vr"] == -2304
    assert dec("8D40621D58C382D690C8AC2863A7")["alt"] == 38000


def test_correction_un_bit():
    b = bytearray.fromhex("8D4840D6202CC371C32CE0576098")
    b[6] ^= 0x10
    r = M.FrameValidator().check(bytes(b))
    assert r and r[2] == "corrigé" and r[0].hex().upper() == "8D4840D6202CC371C32CE0576098"


def test_cpr_global_reference():
    e, o = dec("8D40621D58C382D690C8AC2863A7")["cpr"], dec("8D40621D58C386435CC412692AD6")["cpr"]
    lat, lon = M.cpr_global(e, o, False)
    assert abs(lat - 52.2572) < 1e-4 and abs(lon - 3.91937) < 1e-4


@pytest.mark.parametrize("lat,lon", [(48.7, 2.35), (-33.9, 151.2), (64.1, -21.9)])
def test_cpr_aller_retour(lat, lon):
    p = M.cpr_global(M.cpr_encode(lat, lon, 0), M.cpr_encode(lat, lon, 1), True)
    assert M.dist_km(*p, lat, lon) < 0.01


@pytest.mark.parametrize("sq", ["7700", "1200", "4567", "0000"])
def test_squawk(sq):
    assert M.squawk_from_id13(M.id13_from_squawk(sq)) == sq


@pytest.mark.parametrize("alt", [-1000, 2500, 36000, 41025])
def test_altitude(alt):
    assert M.decode_ac13(M.encode_ac13(alt)) == alt and M.decode_ac12(M.encode_ac12(alt)) == alt


def test_frame_bytes_formats():
    for v in ("*8D4840D6202CC371C32CE0576098;", "8d4840d6202cc371c32ce0576098", "@0123456789AB8D4840D6202CC371C32CE0576098;",
              bytes.fromhex("8D4840D6202CC371C32CE0576098")):
        assert M.frame_bytes(v) == bytes.fromhex("8D4840D6202CC371C32CE0576098")
    assert M.frame_bytes("hello") is None


# ---------------------------------------------------------------- démodulation (aller-retour synthétique)
@pytest.mark.parametrize("fs,min_rate", [(2e6, 0.55), (2.4e6, 0.7), (4e6, 0.9), (8e6, 0.93)])
def test_demodulation_synthetique(fs, min_rate):
    sc = Scenario(fs=fs, duration=2.5, seed=11)
    msgs, st = demodulate(sc, fs)
    sent = {e.data.hex().upper() for e in sc.emissions}
    icaos = {f"{a['icao']:06X}" for a in sc.fleet}
    assert all(m["icao"] in icaos for m in msgs), "aéronef fantôme"
    rate = sum(m["hex"] in sent for m in msgs) / len(sc.emissions)
    assert rate >= min_rate, f"taux {rate:.2%}"
    tr = Tracker(sc.ref)
    for m in msgs:
        tr.update(m)
    worst, n = 0.0, 0
    for a in tr.aircraft.values():
        pos = [e for e in sc.emissions if f"{e.icao:06X}" == a.icao and e.kind.startswith("pos")]
        for t, lat, lon, _ in a.trail:
            e = min(pos, key=lambda e: abs(e.t - t))
            worst, n = max(worst, M.dist_km(e.truth[0], e.truth[1], lat, lon)), n + 1
    assert n > 0 and worst < 0.02, f"écart {worst * 1000:.1f} m"


def test_decoupage_en_blocs_sans_doublon():
    sc = Scenario(fs=2.4e6, duration=2.0, seed=3)
    a, _ = demodulate(sc, 2.4e6, chunk_ms=250)
    b, _ = demodulate(sc, 2.4e6, chunk_ms=2000)
    assert len({m["sample"] for m in a}) == len(a)
    assert abs(len(a) - len(b)) <= 2


# ---------------------------------------------------------------- formats
def test_formats_module():
    m = to_magnitude(np.array([3000, -4000, 0, 0, -32768, 0], np.int16).tobytes(), "cs16")
    assert abs(m[0] - 5000 / 32768) < 1e-6 and m[2] == 1
    assert abs(to_magnitude(struct.pack(">hh", 3000, -4000), "cs16be")[0] - 5000 / 32768) < 1e-6
    assert abs(to_magnitude(np.array([0.3, 0.4], np.float32).tobytes(), "cf32")[0] - 0.5) < 1e-6
    assert abs(to_magnitude(np.array([30, -40], np.int8).tobytes(), "cs8")[0] - 50 / 128) < 1e-6


def test_wav_et_nom():
    h = b"RIFF" + struct.pack("<I", 4036) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, 2400000, 9600000, 4, 16) + b"data" + struct.pack("<I", 4000)
    w = parse_wav(h, 4044)
    assert w.format == "cs16" and w.rate == 2400000 and w.data_offset == 44
    assert guess_from_name("adsb_2.4Msps.cs16") == {"format": "cs16", "rate": 2.4e6}
    assert guess_from_name("rec_fs2000000.bin")["rate"] == 2e6


def _mat_v5(iq_int16_cols: np.ndarray) -> bytes:
    def el(t, payload):
        pad = (8 - len(payload) % 8) % 8
        return struct.pack("<II", t, len(payload)) + payload + b"\0" * pad
    n = iq_int16_cols.shape[0]
    body = el(6, struct.pack("<II", 6, 0)) + el(5, struct.pack("<ii", n, 2)) + el(1, b"IQ") + el(3, iq_int16_cols.T.astype("<i2").tobytes())
    z = zlib.compress(el(14, body))
    head = b"MATLAB 5.0 MAT-file, test".ljust(124, b" ") + struct.pack("<H", 0x0100) + b"IM"
    return head + struct.pack("<II", 15, len(z)) + z


def test_mat_et_recherche_de_frequence():
    fs = 8e6
    sc = Scenario(fs=fs, duration=0.6, seed=5)
    raw = sc.iq_int16(0, sc.total)
    cols = np.stack([raw[0::2], raw[1::2]], axis=1)
    m = parse_mat(_mat_v5(cols))
    assert m.name == "IQ" and m.iq.size == sc.total
    assert abs(m.iq[1].real - raw[2] / 32768) < 1e-6 and abs(m.iq[1].imag - raw[3] / 32768) < 1e-6
    res = probe_rate(ArraySource(m.iq))
    assert max(res, key=lambda x: x[1])[0] == fs


# ---------------------------------------------------------------- Parquet
pa = pytest.importorskip("pyarrow")


def test_parquet_trames():
    from demod1090.table import ParquetReader
    rd = ParquetReader(os.path.join(FIX, "frames.parquet"))
    assert rd.info["mode"] == "frames" and rd.info["roles"]["frame"] == "msg"
    msgs = list(rd.messages())
    assert len(msgs) == rd.total
    tr = Tracker()
    for m in msgs:
        tr.update(m)
    a = tr.aircraft["3A1F7E"]
    assert a.callsign == "TVF72HM" and a.squawk == "7700" and a.lat is not None
    assert abs(rd.t_min - 1793527200) < 1  # 2026-11-01 10:00 UTC


def test_parquet_etats_et_unites():
    from demod1090.table import ParquetReader, analyze, state_fields
    rd = ParquetReader(os.path.join(FIX, "states.parquet"))
    assert rd.info["mode"] == "states" and rd.info["roles"]["icao"] == "hex"
    tr = Tracker(trail_step=0)
    for m in rd.messages():
        tr.update(m)
    a = tr.aircraft["3944F1"]
    assert a.callsign == "AFR1047" and a.alt == 36000 and len(a.trail) >= 4
    row = {"icao24": "3c66b4", "time": 1.7e9, "lat": 48, "lon": 2, "baroaltitude": 10000, "velocity": 230, "vertrate": 5}
    an = analyze(list(row), [row])
    f = state_fields(row, an["roles"], an["units"])
    assert an["mode"] == "states" and f["alt"] == 32808 and round(f["gs"]) == 447 and f["vr"] == 984
