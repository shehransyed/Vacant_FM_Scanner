# 📻 FM Channel Finder

Find the clearest vacant FM channels for a car FM transmitter — at your current
location or along a whole driving route. 100% static web app: no backend, no API
keys, no costs.

## What it does

- **Location mode** — tap 📍 (GPS), search a place, or tap the map. Ranks the ten
  clearest FM channels, tells you which station limits each one, and tapping a
  channel plots the interfering stations on the map.
- **Route mode** — enter start/destination (or paste a full Google Maps
  `google.com/maps/dir/…` link). Shows the best single channels for the whole
  drive plus a **segmented plan** ("mi 0–202: 100.7, mi 202–213: 106.5") drawn
  color-coded on the map.

## How it works

- Station database: **24,736 active FM transmitters** (full-power, LPFM,
  translators, boosters; licensed + construction permits; US plus Canadian and
  Mexican border stations) from the [FCC FM Query](https://www.fcc.gov/media/radio/fm-query),
  baked into `stations.js`.
- Signal estimates use an empirical fit of the FCC F(50,50) propagation curves
  from each station's ERP and antenna height (HAAT). Terrain is not modeled.
- A channel's score is the worst of: co-channel signal, first-adjacent (±0.2 MHz)
  minus 12 dB, second-adjacent (±0.4 MHz) minus 30 dB — roughly how a car radio
  hears interference against a low-power transmitter.
- Routing: free public [OSRM](https://project-osrm.org) demo server.
  Geocoding: free [Nominatim](https://nominatim.org). Map: OpenStreetMap tiles.
- 87.9 MHz is excluded from recommendations (most car FM transmitters tune
  88.1–107.9).

## Run it

### On this PC

```bash
cd "C:/Users/shehr/Desktop/FM Scanner" && python -m http.server 8741
```

Then open <http://localhost:8741>. (A plain double-click on `index.html` also
works, except the GPS button — browsers only allow geolocation on
`localhost`/HTTPS.)

### On your Pixel 9 — option A: free hosting (recommended)

Push these files to a GitHub repo and enable **GitHub Pages**
(Settings → Pages → deploy from branch). You get a free HTTPS URL; open it in
Chrome and use **Add to Home screen** to install it like an app. GPS works
because Pages is HTTPS. Only files needed: `index.html`, `style.css`, `app.js`,
`stations.js`, `manifest.json`.

### On your Pixel 9 — option B: fully local

Install [Termux](https://f-droid.org/packages/com.termux/), copy the five files
above to the phone, then:

```bash
pkg install python && cd fm-finder && python -m http.server 8741
```

Open <http://localhost:8741> in Chrome on the phone. Geolocation works on
localhost.

## Refreshing the station data

Stations change slowly (worth refreshing every few months):

```bash
curl -s -o fmq_raw.txt "https://transition.fcc.gov/fcc-bin/fmq?state=&call=&arn=&serv=&vac=3&freq=87.9&fre2=107.9&facid=&class=&list=4&NS=N&EW=W&size=9" && python process_data.py
```

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | the app |
| `stations.js` | station database (generated; also `stations.json`) |
| `manifest.json` | lets Android install it as a home-screen app |
| `process_data.py` | rebuilds `stations.js` from `fmq_raw.txt` |
| `fmq_raw.txt` | raw FCC dump (keep to reprocess; not needed to run) |

## Notes & limits

- Predictions ignore terrain, so mountains can make a "Poor" channel usable and
  a valley can hide a predicted-strong station. Treat ratings as a shortlist.
- HD Radio digital sidebands (±~150 kHz) can add hiss on first-adjacent channels
  beyond what the model assumes.
- Unlicensed FM transmitters are legal in the US under FCC Part 15 at very low
  power (~200 ft range); this tool just helps you pick the cleanest channel.
