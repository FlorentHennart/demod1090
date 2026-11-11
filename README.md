# Démod 1090 · démodulateur ADS-B / Mode S (`adsb/`)

Application web autonome qui démodule des enregistrements IQ à 1090 MHz directement dans le
navigateur (Web Worker, aucun envoi de données). Pensée pour le téléphone autant que pour l'ordinateur.

| Fonction | Détail |
|---|---|
| Entrées | I/Q entrelacés **int16** LE (cs16, défaut) ou BE, uint8 (RTL-SDR), int8 (HackRF), float32 ; **MATLAB .mat** v5 (variable complexe N×1 ou réelle N×2, compressée ou non) ; **Parquet** de trames Mode S (hexadécimal, AVR) ou de positions déjà décodées (style readsb, OpenSky…), colonnes reconnues automatiquement ; **WAV** SDR#/SDRuno/SDR++ (16 bits, RF64 compris) ; lecture par blocs, fichiers de plusieurs Go |
| Détection auto | En-tête WAV, variable `fs` d'un .mat ou nom de fichier (`2.4Msps`, `fs2400000`…) ; à défaut, **recherche automatique de la fréquence** (2 à 100 MS/s) en comptant les trames à CRC exact |
| Démodulation | N'importe quelle fréquence ≥ 2 MS/s : intégration fractionnaire des demi-bits, recherche de phase sous-échantillon et, à faible suréchantillonnage, tranchage par modèle (rétroaction de décision) |
| Validation | CRC-24, correction d'un bit (DF17/18), parité d'adresse AP pour DF0/4/5/16/20/21 sur adresses déjà confirmées |
| Décodage | Indicatif et catégorie, positions CPR (global puis local, sol avec position récepteur), altitude baro/GNSS, vitesse sol/air, vario, squawk et urgences, état cible, version ADS-B, Comm-B BDS 2,0 |
| Interface | Carte (fond Natural Earth, traces colorées par altitude, cercles de distance, pincer/zoomer), fiches aéronefs, liste filtrable des messages, export AVR, vue **Signal** (forme d'onde, préambule, bits, octets) |
| Démo | Signal synthétique (7 aéronefs autour d'Orly, bruit gaussien) généré au chargement |

## Lancer

Aucune installation ni dépendance : servir le dossier puis ouvrir la page.

```bash
python3 -m http.server 8000
```

puis <http://localhost:8000/>. Un signal de démonstration synthétique se décode au chargement.

## Version Python

Le même moteur existe en Python (numpy) dans [`python/`](python/README.md) : ligne de commande
(`python3 -m demod1090 capture.cs16`), bibliothèque, exports AVR / CSV / JSON / GeoJSON, tests pytest.

## Tests

```bash
node tests/adsb.test.js     # ou : npm test
```

```
index.html          page et styles
adsb-core.js        moteur (formats, démodulateur, CRC, décodage, suivi, générateur synthétique) — sans dépendance
app.js              interface (worker, carte canvas, listes, vue signal)
parquet.js          lecture Parquet : reconnaissance des colonnes, trames ou états, lecture par groupes de lignes
vendor/             hyparquet 1.31.5 + hyparquet-compressors 1.1.2 (MIT, regroupés avec esbuild), terres Natural Earth 110m
tests/fixtures/     petits fichiers Parquet de test (trames, états)
python/             version Python (numpy) : paquet demod1090, ligne de commande, tests pytest
tests/adsb.test.js  trames de référence, CPR, aller-retour synthétique 2 / 2,4 / 4 / 8 MS/s, formats
```
