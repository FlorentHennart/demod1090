# Démod 1090 · version Python

Même moteur que l'application web, en Python + numpy, utilisable en ligne de commande ou comme bibliothèque.

| Entrées | IQ entrelacé `cs16` (défaut), `cs16be`, `cu8`, `cs8`, `cf32` ; WAV / RF64 ; MATLAB `.mat` v5 ; Parquet de trames ou de positions (avec `pyarrow`) |
|---|---|
| Fréquence | Toute fréquence ≥ 2 MS/s ; lue dans le WAV / le `.mat` / le nom de fichier, sinon **recherchée automatiquement** (2 à 100 MS/s) |
| Démodulation | Préambule recherché de façon vectorisée (numpy), phase sous-échantillon, intégration fractionnaire, tranchage par modèle à faible suréchantillonnage |
| Validation | CRC-24, correction d'un bit (DF17/18), adresse-parité sur adresses confirmées |
| Décodage | DF0/4/5/11/16/17/18/20/21 : indicatif, catégorie, CPR global/local, altitudes, vitesses, vario, squawk, urgences, état cible, version, BDS 2,0 |
| Sorties | Tableau des aéronefs, liste des messages, exports AVR, CSV, JSON, GeoJSON (trajectoires) |

## Installation

```bash
cd python
pip install .              # numpy seulement
pip install ".[parquet]"   # + pyarrow pour les fichiers Parquet
```

Sans installation : `python3 -m demod1090 …` depuis le dossier `python/`.

## Exemples

```bash
demod1090 --demo --ref 48.7262,2.3652                 # signal synthétique (7 avions autour d'Orly)
demod1090 capture_2.4Msps.cs16                        # fréquence lue dans le nom
demod1090 enregistrement.bin -r 2.4M -m               # fréquence imposée, affiche chaque message
demod1090 IQ_3951C2_131.mat                           # .mat : fréquence trouvée automatiquement (40 MS/s)
demod1090 SDRSharp_IQ.wav --geojson traces.geojson    # WAV + export des trajectoires
demod1090 10.parquet --json avions.json --csv msgs.csv
demod1090 --write-demo demo.cs16 --demo-rate 4M       # écrit un fichier de test
```

Options utiles : `-t/--threshold` (seuil du préambule, dB), `--no-fix`, `--ref LAT,LON`, `--min-msgs`, `--avr -`.

## Bibliothèque

```python
from demod1090 import open_source, demodulate, Tracker

src, fs, notes = open_source("capture.cs16", rate=2.4e6)
msgs, stats = demodulate(src, fs)
tr = Tracker(ref=(48.72, 2.36))
for m in msgs:
    tr.update(m)
for a in tr.visible():
    print(a.icao, a.callsign, a.alt, a.lat, a.lon)
```

Chaque message est un dictionnaire : `t` (s), `hex`, `df`, `icao`, `crc` (`ok`, `corrigé`, `AP`), `rssi`/`snr` (dB) et `f` (champs décodés).

## Tests

```bash
pip install ".[test]"
python3 -m pytest
```

## Modules

```
demod1090/modes.py    CRC-24, champs Mode S / ADS-B, altitude, squawk, CPR, validation, encodeur
demod1090/iq.py       formats IQ, WAV, MATLAB .mat, devinette depuis le nom, sources
demod1090/demod.py    démodulateur, traitement par blocs, recherche de la fréquence
demod1090/tracker.py  suivi des aéronefs et trajectoires
demod1090/table.py    Parquet (pyarrow) : reconnaissance des colonnes, trames ou états
demod1090/synth.py    générateur de signal synthétique (démo, tests)
demod1090/cli.py      ligne de commande
```
