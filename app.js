/* FM Channel Finder — find vacant FM channels for a car FM transmitter.
 *
 * Data: FCC FM Query dump (stations.js), all licensed/CP FM, LPFM, translator
 * and booster transmitters in the US plus Canadian/Mexican border stations.
 *
 * Signal model: empirical fit of the FCC F(50,50) propagation curves.
 * Predicted field strength E (dBu at ~2 m receive height):
 *   within radio horizon:  E = 98 + 10·log10(ERP kW) + 20·log10(HAAT/100) − 39·log10(d/1.6)
 *   beyond horizon:        additional 55·log10(d/dh) roll-off
 * This is an approximation (no terrain), but plenty for *ranking* channels.
 */
"use strict";

/* ---------------- constants ---------------- */
const CH_MIN = 87.9, CH_STEP = 0.2, N_CH = 101;      // 87.9 … 107.9
const CH_FIRST_USABLE = 1; // skip 87.9: most car FM transmitters tune 88.1–107.9
const ADJ1_REJ = 12;   // dB a car radio attenuates a first-adjacent (±0.2 MHz) signal
const ADJ2_REJ = 30;   // dB for second-adjacent (±0.4 MHz)
const MAX_DIST_KM = 300;         // ignore stations farther than this
const SEG_GOOD = 40, SEG_OK = 55; // dBu interference thresholds for route segments
const RATINGS = [
  { max: 25, label: "Excellent", cls: "excellent" },
  { max: 40, label: "Good",      cls: "good" },
  { max: 55, label: "Fair",      cls: "fair" },
  { max: 999, label: "Poor",     cls: "poor" },
];
const SEG_COLORS = ["#4da3ff", "#2ecc71", "#f4c542", "#e5735a", "#b07cf7",
                    "#4dd0c4", "#f78fb3", "#9ccc65", "#ff9e57", "#7f9cf5"];

/* ---------------- station data ---------------- */
const S = window.STATION_DATA.stations; // [call,freq,lat,lon,erp,haat,svc,cls,city,state]
const F_CALL = 0, F_FREQ = 1, F_LAT = 2, F_LON = 3, F_ERP = 4, F_HAAT = 5,
      F_SVC = 6, F_CLS = 7, F_CITY = 8, F_ST = 9;

function chIndex(freq) { return Math.round((freq - CH_MIN) / CH_STEP); }
function chFreq(i) { return (CH_MIN + i * CH_STEP).toFixed(1); }

/* ---------------- geometry ---------------- */
const R_EARTH = 6371;
function haversine(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const a = 0.5 - Math.cos((lat2 - lat1) * p) / 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * (1 - Math.cos((lon2 - lon1) * p)) / 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/* ---------------- propagation ---------------- */
function fieldStrength(erpKw, haatM, dKm) {
  const d = Math.max(dKm, 0.3);
  const freeSpace = 106.9 + 10 * Math.log10(erpKw) - 20 * Math.log10(d);
  if (d < 1.6) return freeSpace;
  const horizon = 4.12 * (Math.sqrt(haatM) + 1.4); // km, rx antenna ~2 m
  let e = 98 + 10 * Math.log10(erpKw) + 20 * Math.log10(Math.max(haatM, 10) / 100)
        - 39 * Math.log10(d / 1.6);
  if (d > horizon) e -= 55 * Math.log10(d / horizon);
  return Math.min(e, freeSpace);
}

/* Pre-filter stations to a bounding box (with margin) once per analysis. */
function stationsNear(latMin, latMax, lonMin, lonMax) {
  const margin = MAX_DIST_KM / 111; // deg latitude
  const lonMargin = margin / Math.max(0.2, Math.cos(((latMin + latMax) / 2) * Math.PI / 180));
  const out = [];
  for (let i = 0; i < S.length; i++) {
    const st = S[i];
    if (st[F_LAT] > latMin - margin && st[F_LAT] < latMax + margin &&
        st[F_LON] > lonMin - lonMargin && st[F_LON] < lonMax + lonMargin) {
      out.push(st);
    }
  }
  return out;
}

/* Per-channel max co-channel field at a point. Returns
 * { level: Float64Array, top: [{station, e, d} | null] } */
function coChannelLevels(lat, lon, pool) {
  const level = new Float64Array(N_CH).fill(-999);
  const top = new Array(N_CH).fill(null);
  for (let i = 0; i < pool.length; i++) {
    const st = pool[i];
    const d = haversine(lat, lon, st[F_LAT], st[F_LON]);
    if (d > MAX_DIST_KM) continue;
    const e = fieldStrength(st[F_ERP], st[F_HAAT], d);
    const c = chIndex(st[F_FREQ]);
    if (c < 0 || c >= N_CH) continue;
    if (e > level[c]) { level[c] = e; top[c] = { station: st, e, d }; }
  }
  return { level, top };
}

/* Interference score per channel = worst of co-channel and (attenuated)
 * adjacent-channel signals. Lower = more vacant. */
function interferenceScores(level) {
  const score = new Float64Array(N_CH);
  for (let c = 0; c < N_CH; c++) {
    let s = level[c];
    if (c > 0) s = Math.max(s, level[c - 1] - ADJ1_REJ);
    if (c < N_CH - 1) s = Math.max(s, level[c + 1] - ADJ1_REJ);
    if (c > 1) s = Math.max(s, level[c - 2] - ADJ2_REJ);
    if (c < N_CH - 2) s = Math.max(s, level[c + 2] - ADJ2_REJ);
    score[c] = s;
  }
  return score;
}

function ratingFor(score) {
  return RATINGS.find(r => score <= r.max);
}

/* ---------------- map ---------------- */
const map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const pointLayer = L.layerGroup().addTo(map);   // query marker + station overlays
const routeLayer = L.layerGroup().addTo(map);   // route polylines

/* ---------------- UI helpers ---------------- */
const $ = id => document.getElementById(id);
const statusEl = $("status"), resultsEl = $("results");

function setStatus(msg, isError) {
  if (!msg) { statusEl.classList.add("hidden"); return; }
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
  statusEl.classList.remove("hidden");
}

function fmtStation(t) {
  if (!t) return "no station within range";
  const st = t.station;
  const svc = { FM: "", FL: " LPFM", FX: " translator", FB: " booster", FR: " booster" }[st[F_SVC]] ?? "";
  return `${st[F_CALL]}${svc} · ${st[F_CITY]}, ${st[F_ST]} · ${Math.round(t.d * 0.621)} mi`;
}

/* ---------------- mode switching ---------------- */
let mode = "point";
function setMode(m) {
  mode = m;
  $("tab-point").classList.toggle("active", m === "point");
  $("tab-route").classList.toggle("active", m === "route");
  $("point-controls").classList.toggle("hidden", m !== "point");
  $("route-controls").classList.toggle("hidden", m !== "route");
  resultsEl.innerHTML = "";
  setStatus(null);
  pointLayer.clearLayers();
  routeLayer.clearLayers();
}
$("tab-point").onclick = () => setMode("point");
$("tab-route").onclick = () => setMode("route");

/* ---------------- geocoding (Nominatim, free) ---------------- */
async function geocode(q) {
  const coordMatch = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (coordMatch) return { lat: +coordMatch[1], lon: +coordMatch[2], name: q.trim() };
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us,ca,mx&q="
    + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geocoding service error " + res.status);
  const js = await res.json();
  if (!js.length) throw new Error(`Couldn't find "${q}"`);
  return { lat: +js[0].lat, lon: +js[0].lon, name: js[0].display_name.split(",").slice(0, 2).join(",") };
}

function getGpsPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, name: "My location" }),
      err => reject(new Error("Location failed: " + err.message +
        (location.protocol === "file:" ? " (open via http://localhost — see README)" : ""))),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

/* ================= LOCATION MODE ================= */
let selectedCard = null;

function analyzePoint(lat, lon, label) {
  setStatus("Analyzing " + (label || "location") + "…");
  pointLayer.clearLayers();
  routeLayer.clearLayers();

  const pool = stationsNear(lat, lat, lon, lon);
  const { level, top } = coChannelLevels(lat, lon, pool);
  const score = interferenceScores(level);

  const ranked = [];
  for (let c = CH_FIRST_USABLE; c < N_CH; c++) ranked.push(c);
  ranked.sort((a, b) => score[a] - score[b]);

  L.marker([lat, lon]).addTo(pointLayer).bindPopup(label || "Query point");
  map.setView([lat, lon], Math.max(map.getZoom(), 9));

  let html = `<h2 class="results-title">Best channels near ${label || "this point"}</h2>`;
  const shown = ranked.slice(0, 10);
  for (const c of shown) {
    const r = ratingFor(score[c]);
    const co = top[c];
    const adjParts = [];
    if (c > 0 && top[c - 1] && level[c - 1] - ADJ1_REJ >= score[c] - 3) adjParts.push(chFreq(c - 1));
    if (c < N_CH - 1 && top[c + 1] && level[c + 1] - ADJ1_REJ >= score[c] - 3) adjParts.push(chFreq(c + 1));
    const detail = co && level[c] > -100
      ? `Strongest on-channel: ${fmtStation(co)}`
      : "No co-channel station within " + Math.round(MAX_DIST_KM * 0.621) + " mi";
    const adjNote = adjParts.length ? `<br>Limited by adjacent ${adjParts.join(" / ")}` : "";
    html += `
      <div class="chan-card" data-ch="${c}">
        <div class="chan-freq">${chFreq(c)}</div>
        <div class="chan-info">
          <div class="chan-detail">${detail}${adjNote}</div>
        </div>
        <span class="badge ${r.cls}">${r.label}</span>
      </div>`;
  }
  html += footerNote();
  resultsEl.innerHTML = html;
  setStatus(null);

  // tap a channel card -> show the interfering stations on the map
  resultsEl.querySelectorAll(".chan-card").forEach(card => {
    card.addEventListener("click", () => {
      if (selectedCard) selectedCard.classList.remove("selected");
      selectedCard = card;
      card.classList.add("selected");
      showChannelStations(+card.dataset.ch, lat, lon, pool);
    });
  });
}

function showChannelStations(c, lat, lon, pool) {
  pointLayer.clearLayers();
  L.marker([lat, lon]).addTo(pointLayer);
  const freqs = [c - 2, c - 1, c, c + 1, c + 2].filter(i => i >= 0 && i < N_CH);
  for (const st of pool) {
    const ci = chIndex(st[F_FREQ]);
    if (!freqs.includes(ci)) continue;
    const d = haversine(lat, lon, st[F_LAT], st[F_LON]);
    if (d > MAX_DIST_KM) continue;
    const e = fieldStrength(st[F_ERP], st[F_HAAT], d);
    const eff = ci === c ? e : Math.abs(ci - c) === 1 ? e - ADJ1_REJ : e - ADJ2_REJ;
    if (eff < 10) continue;
    const color = ci === c ? "#e5735a" : "#f4c542";
    L.circleMarker([st[F_LAT], st[F_LON]], {
      radius: 6, color, fillColor: color, fillOpacity: 0.7, weight: 1,
    }).addTo(pointLayer).bindPopup(
      `<b>${st[F_CALL]}</b> ${st[F_FREQ]} MHz<br>${st[F_CITY]}, ${st[F_ST]}<br>` +
      `${st[F_ERP]} kW · ${Math.round(d * 0.621)} mi away`);
  }
}

$("btn-locate").onclick = async () => {
  try {
    setStatus("Getting GPS fix…");
    const p = await getGpsPosition();
    analyzePoint(p.lat, p.lon, "my location");
  } catch (e) { setStatus(e.message, true); }
};

async function doPointSearch() {
  const q = $("point-search").value.trim();
  if (!q) return;
  try {
    setStatus("Searching…");
    const p = await geocode(q);
    analyzePoint(p.lat, p.lon, p.name);
  } catch (e) { setStatus(e.message, true); }
}
$("btn-point-search").onclick = doPointSearch;
$("point-search").addEventListener("keydown", e => { if (e.key === "Enter") doPointSearch(); });

map.on("click", e => {
  if (mode === "point") {
    analyzePoint(e.latlng.lat, e.latlng.lng,
      e.latlng.lat.toFixed(3) + ", " + e.latlng.lng.toFixed(3));
  }
});

/* ================= ROUTE MODE ================= */

/* Extract waypoints from a full Google Maps URL. Returns array of
 * strings (place names) and/or {lat, lon} objects. */
function parseGmapsUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error("That doesn't look like a URL."); }
  if (/goo\.gl|maps\.app/.test(url.hostname)) {
    throw new Error("That's a shortened link. Open it in a browser, then copy the full " +
      "google.com/maps/dir/… address from the address bar and paste that here.");
  }
  const path = decodeURIComponent(url.pathname);
  const m = path.match(/\/dir\/(.+?)(?:\/@|\/data|$)/);
  if (m) {
    const parts = m[1].split("/").filter(p => p && p !== "''");
    if (parts.length >= 2) {
      return parts.map(p => {
        const c = p.match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/);
        return c ? { lat: +c[1], lon: +c[2] } : p.replace(/\+/g, " ");
      });
    }
  }
  const pl = path.match(/\/place\/([^/]+)/);
  if (pl) return [pl[1].replace(/\+/g, " ")]; // destination only; origin = GPS
  throw new Error("Couldn't find a route in that link. Use a google.com/maps/dir/… link " +
    "with both start and destination, or type them in the boxes above.");
}

async function resolveWaypoint(w) {
  if (typeof w === "object") return { ...w, name: w.lat.toFixed(3) + ", " + w.lon.toFixed(3) };
  return geocode(w);
}

/* Free routing via the public OSRM demo server. */
async function fetchRoute(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}` +
    "?overview=full&geometries=geojson&steps=false";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Routing service error " + res.status);
  const js = await res.json();
  if (js.code !== "Ok" || !js.routes.length) throw new Error("No route found.");
  return js.routes[0]; // .geometry.coordinates = [[lon,lat],…], .distance meters
}

/* Resample route geometry to points every ~step km. */
function sampleRoute(coords, totalKm) {
  const step = Math.max(2, totalKm / 120);
  const samples = [{ lat: coords[0][1], lon: coords[0][0], km: 0 }];
  let acc = 0, cum = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    acc += d; cum += d;
    if (acc >= step) {
      samples.push({ lat: coords[i][1], lon: coords[i][0], km: cum });
      acc = 0;
    }
  }
  const last = coords[coords.length - 1];
  if (samples[samples.length - 1].km < cum - 0.5) {
    samples.push({ lat: last[1], lon: last[0], km: cum });
  }
  return samples;
}

/* Greedy segmentation: at each position pick the channel that stays under the
 * threshold for the longest stretch ahead, then merge segments too short to be
 * worth a retune. */
function segmentRoute(scores /* per-sample Float64Array */, samples) {
  const segs = [];
  let i = 0;
  while (i < samples.length) {
    let bestCh = -1, bestReach = i, bestWorst = Infinity;
    for (const thr of [SEG_GOOD, SEG_OK, 999]) {
      for (let c = CH_FIRST_USABLE; c < N_CH; c++) {
        let j = i, worst = -999;
        while (j < samples.length && scores[j][c] <= thr) {
          worst = Math.max(worst, scores[j][c]); j++;
        }
        if (j > bestReach || (j === bestReach && worst < bestWorst)) {
          bestReach = j; bestCh = c; bestWorst = worst;
        }
      }
      if (bestReach > i) break; // found something under this threshold
    }
    if (bestCh < 0) { bestCh = CH_FIRST_USABLE; bestReach = i + 1; bestWorst = scores[i][CH_FIRST_USABLE]; }
    segs.push({ ch: bestCh, from: i, to: bestReach - 1, worst: bestWorst });
    i = bestReach;
  }
  return mergeShortSegments(segs, scores, Math.max(2, Math.round(samples.length * 0.06)));
}

/* Absorb segments shorter than minSamples into whichever neighbor keeps the
 * combined worst-case interference lowest, then collapse same-channel runs. */
function mergeShortSegments(segs, scores, minSamples) {
  const worstOver = (ch, from, to) => {
    let w = -999;
    for (let j = from; j <= to; j++) w = Math.max(w, scores[j][ch]);
    return w;
  };
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let k = 0; k < segs.length; k++) {
      if (segs[k].to - segs[k].from + 1 >= minSamples) continue;
      let best = null;
      for (const n of [k - 1, k + 1]) {
        if (n < 0 || n >= segs.length) continue;
        const from = Math.min(segs[n].from, segs[k].from);
        const to = Math.max(segs[n].to, segs[k].to);
        const w = worstOver(segs[n].ch, from, to);
        if (!best || w < best.w) best = { n, from, to, w };
      }
      if (best) {
        const keep = segs[best.n];
        segs.splice(Math.min(best.n, k), 2,
          { ch: keep.ch, from: best.from, to: best.to, worst: best.w });
        changed = true;
        break;
      }
    }
  }
  // collapse consecutive segments that landed on the same channel
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.ch === s.ch) {
      prev.to = s.to;
      prev.worst = Math.max(prev.worst, s.worst);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

async function runRoute(waypointsRaw) {
  try {
    routeLayer.clearLayers();
    pointLayer.clearLayers();
    resultsEl.innerHTML = "";

    setStatus("Resolving locations…");
    const pts = [];
    for (const w of waypointsRaw) pts.push(await resolveWaypoint(w));

    setStatus("Fetching driving route…");
    const route = await fetchRoute(pts);
    const coords = route.geometry.coordinates;
    const totalKm = route.distance / 1000;
    const totalMi = totalKm * 0.621;

    setStatus(`Analyzing ${Math.round(totalMi)} mi route…`);
    await new Promise(r => setTimeout(r, 30)); // let status paint

    const samples = sampleRoute(coords, totalKm);
    let latMin = 90, latMax = -90, lonMin = 180, lonMax = -180;
    for (const s of samples) {
      latMin = Math.min(latMin, s.lat); latMax = Math.max(latMax, s.lat);
      lonMin = Math.min(lonMin, s.lon); lonMax = Math.max(lonMax, s.lon);
    }
    const pool = stationsNear(latMin, latMax, lonMin, lonMax);

    const perSample = samples.map(s =>
      interferenceScores(coChannelLevels(s.lat, s.lon, pool).level));

    // whole-route worst-case per channel
    const worst = new Float64Array(N_CH).fill(-999);
    for (const sc of perSample) {
      for (let c = 0; c < N_CH; c++) worst[c] = Math.max(worst[c], sc[c]);
    }
    const rankedWhole = [...Array(N_CH).keys()].slice(CH_FIRST_USABLE)
      .sort((a, b) => worst[a] - worst[b]);

    const segs = segmentRoute(perSample, samples);

    // ---- draw ----
    const base = L.polyline(coords.map(c => [c[1], c[0]]),
      { color: "#5c6b7a", weight: 7, opacity: 0.5 }).addTo(routeLayer);
    segs.forEach((seg, i) => {
      const fromKm = samples[seg.from].km, toKm = samples[seg.to].km;
      const line = [];
      let cum = 0;
      for (let k = 0; k < coords.length; k++) {
        if (k > 0) cum += haversine(coords[k - 1][1], coords[k - 1][0], coords[k][1], coords[k][0]);
        if (cum >= fromKm - 0.01 && cum <= toKm + 0.01) line.push([coords[k][1], coords[k][0]]);
      }
      if (line.length > 1) {
        L.polyline(line, { color: SEG_COLORS[i % SEG_COLORS.length], weight: 5, opacity: 0.95 })
          .addTo(routeLayer)
          .bindPopup(`<b>${chFreq(seg.ch)} MHz</b><br>${(fromKm * 0.621).toFixed(0)}–${(toKm * 0.621).toFixed(0)} mi`);
      }
    });
    map.fitBounds(base.getBounds(), { padding: [30, 30] });

    // ---- results HTML ----
    let html = `<h2 class="results-title">Whole drive (${Math.round(totalMi)} mi) — best single channels</h2>`;
    for (const c of rankedWhole.slice(0, 5)) {
      const r = ratingFor(worst[c]);
      html += `
        <div class="chan-card">
          <div class="chan-freq">${chFreq(c)}</div>
          <div class="chan-info"><div class="chan-detail">worst-case interference along route</div></div>
          <span class="badge ${r.cls}">${r.label}</span>
        </div>`;
    }

    if (segs.length > 1 || ratingFor(worst[rankedWhole[0]]).cls !== "excellent") {
      html += `<h2 class="results-title">Segmented plan (${segs.length} segment${segs.length > 1 ? "s" : ""})</h2>`;
      segs.forEach((seg, i) => {
        const r = ratingFor(seg.worst);
        const fromMi = (samples[seg.from].km * 0.621).toFixed(0);
        const toMi = (samples[Math.min(seg.to + 1, samples.length - 1)].km * 0.621).toFixed(0);
        html += `
          <div class="seg-row">
            <div class="seg-swatch" style="background:${SEG_COLORS[i % SEG_COLORS.length]}"></div>
            <div class="seg-miles">mi ${fromMi}–${toMi}</div>
            <div class="seg-freq">${chFreq(seg.ch)}</div>
            <span class="badge ${r.cls}">${r.label}</span>
          </div>`;
      });
    }
    html += footerNote();
    resultsEl.innerHTML = html;
    setStatus(null);
  } catch (e) {
    setStatus(e.message, true);
  }
}

$("btn-route").onclick = async () => {
  const from = $("route-from").value.trim();
  const to = $("route-to").value.trim();
  if (!to) { setStatus("Enter a destination.", true); return; }
  try {
    const origin = from ? from : await (async () => {
      setStatus("Getting GPS fix for origin…");
      const p = await getGpsPosition();
      return { lat: p.lat, lon: p.lon };
    })();
    runRoute([origin, to]);
  } catch (e) { setStatus(e.message, true); }
};
$("route-to").addEventListener("keydown", e => { if (e.key === "Enter") $("btn-route").click(); });

$("btn-gmaps").onclick = () => {
  try {
    const wps = parseGmapsUrl($("gmaps-url").value);
    if (wps.length === 1) {
      $("route-to").value = typeof wps[0] === "string" ? wps[0] : wps[0].lat + "," + wps[0].lon;
      setStatus("Link had only a destination — origin will be your GPS location. Press Route.");
      return;
    }
    runRoute(wps);
  } catch (e) { setStatus(e.message, true); }
};

/* ---------------- misc ---------------- */
function footerNote() {
  return `<div class="footer-note">
    Ratings estimate how clear each channel is for a low-power car FM transmitter
    (co-channel + adjacent-channel interference, FCC F(50,50)-style propagation,
    terrain not modeled). Station data: FCC, ${window.STATION_DATA.generated}
    (${S.length.toLocaleString()} transmitters incl. translators &amp; LPFM).
    Mountains, tunnels and HD Radio digital sidebands can make a predicted-clear
    channel noisy — keep a runner-up in mind.</div>`;
}

setMode("point");
