"""Démod 1090 — démodulateur ADS-B / Mode S (version Python, numpy).

Usage rapide :
    from demod1090 import open_source, demodulate, Tracker
    src, fs, notes = open_source("capture_2.4Msps.cs16")
    msgs, stats = demodulate(src, fs)
"""
__version__ = "1.0.0"

from .demod import Demodulator, demodulate, probe_rate  # noqa: E402,F401
from .iq import ArraySource, FileSource, open_source, parse_mat, parse_wav, to_magnitude  # noqa: E402,F401
from .modes import FrameValidator, cpr_global, cpr_local, decode_fields, residual, summarize  # noqa: E402,F401
from .tracker import Tracker  # noqa: E402,F401
