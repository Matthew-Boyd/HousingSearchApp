'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const ExcelJS  = require('exceljs');
const fetch    = require('node-fetch');
const cheerio  = require('cheerio');
const turf     = require('@turf/turf');

const app  = express();
const PORT = 3000;

const HIDDEN_FILE    = path.join(__dirname, 'hidden.json');
const BUILDINGS_FILE = path.join(__dirname, 'buildings.geojson');
const ASSESSOR_CACHE_FILE = path.join(__dirname, 'assessor-cache.json');
const WATER_CACHE_FILE    = path.join(__dirname, 'water-cache.json');

// In-memory assessor cache. Key: PARCELID. Value: { bedrooms, sqft, yearBuilt, cachedAt }
const assessorCache = new Map();

// In-memory water-feature cache. Key: county name (e.g. "DANE"). Value:
// { features: [...GeoJSON features], cachedAt }. Populated lazily by getWaterFeaturesForCounty
// — see the water-adjacency section below.
const waterFeatureCache = new Map();

// Spatial grid cell size (degrees). 0.05° ≈ 3.5 km lat / 4.3 km lng at 43°N.
const CELL = 0.05;

// Bounding box enclosing all 11 target counties with a small margin.
const BLDG_BBOX = { minLat: 42.2, maxLat: 44.0, minLng: -90.3, maxLng: -87.75 };

// Grid populated at startup from buildings.geojson.
// Key: "rowIndex|colIndex"  Value: [{lat, lng}, …]
const buildingGrid = new Map();

// Browser-like User-Agent for county assessor scraping.
const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SCO_URL           = 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query';
const FEMA_URL          = 'https://services.arcgis.com/2gdL2gxYNFY2TOUb/arcgis/rest/services/FEMA_National_Flood_Hazard_Layer/FeatureServer/0/query';
const NWI_URL           = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
const DOR_URL           = 'https://www.revenue.wi.gov/SLFReportscotvc/2025sumagg.xlsx';
// Verified live 2026-08-05: services.nationalmap.gov no longer resolves (dead host,
// replaced by hydro.nationalmap.gov). Layer 8 was also wrong — it's the HI/PR/VI/Pacific
// Territories waterbody variant, which returns nothing for Wisconsin. Layer 12 ("Waterbody -
// Large Scale") is the correct CONUS layer; confirmed against Lake Mendota, Madison WI.
const NHD_WATERBODY_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query';
const NHD_FLOWLINE_URL  = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';

// A parcel centroid is essentially never literally inside a lake polygon (houses aren't built
// underwater) and can never be "inside" a river/stream (zero-width lines), so adjacency is a
// distance check, not a containment check. 300 ft is a small buffer standing in for "touches" —
// real-world coordinates never exactly touch.
const WATER_ADJACENT_FT = 300;

// Cowardin classes that represent standing open water you could fish or float a small boat on
// (Unconsolidated Bottom / Aquatic Bed), restricted to regimes that hold water most or all of
// the year (Permanently/Semipermanently Flooded). Excludes marsh (Emergent), swamp
// (Forested/Scrub-Shrub), exposed shoreline, and seasonal/intermittent ponds that go dry.
const NWI_POND_WHERE =
  "NWI_Wetland_Codes.CLASS_NAME IN ('Unconsolidated Bottom','Aquatic Bed') " +
  "AND NWI_Wetland_Codes.WATER_REGIME_NAME IN ('Permanently Flooded','Semipermanently Flooded')";

// 1 km² = 247.10538 acres.
const SQKM_TO_ACRES = 247.10538;

// ─── in-memory state ─────────────────────────────────────────────────────────
// Key: "MUNICIPALITY NAME|COUNTY NAME" (normalized uppercase)
// Value: assessment ratio (e.g. 88.3 means 88.3%)
const dorRatioMap = new Map();

let hiddenSet = new Set();

// ─── normalization helpers ────────────────────────────────────────────────────
function normStr(s) {
  // Replace line breaks with spaces before stripping punctuation — DOR column
  // headers contain \r\n (e.g., "AGGREGATE\r\nRATIO") which would otherwise
  // merge into "AGGREGATERATIO" and break header detection.
  return (s || '').toString().toUpperCase().replace(/[\r\n]+/g, ' ').replace(/[^A-Z0-9 ]/g, '').trim();
}
function dorKey(muni, county) {
  // DOR county names include " COUNTY" suffix (e.g., "ADAMS COUNTY").
  // Parcel coname does not (e.g., "ADAMS"). Strip the suffix for a consistent key.
  const c = normStr(county).replace(/\s*COUNTY\s*$/, '').trim();
  return `${normStr(muni)}|${c}`;
}
function getRatio(cityname, coname) {
  return dorRatioMap.get(dorKey(cityname, coname)) ?? 95;
}

// ─── DOR loading (runs once at startup) ──────────────────────────────────────
async function loadDorRatios() {
  try {
    const res = await fetch(DOR_URL, { timeout: 15000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.buffer();
    const wb  = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws  = wb.worksheets[0];
    // exceljs row.values is 1-indexed (index 0 is null); normalise cells to plain values.
    const cellVal = v => {
      if (v == null) return '';
      if (typeof v === 'object') return v.text ?? v.result ?? String(v);
      return v;
    };
    const rows = [];
    ws.eachRow(row => rows.push(row.values.slice(1).map(cellVal)));

    // Locate the header row. The column "AGGREGATE\r\nRATIO" has an embedded newline
    // so use normStr (which converts \r\n to space) before checking.
    let hi = rows.findIndex(r =>
      r.some(c => normStr(c).includes('AGGREGATE RATIO'))
    );
    if (hi === -1) throw new Error('Header row not found in DOR Excel');

    const headers = rows[hi].map(h => normStr(h));
    // Match both "MUNICIPALITY NAME" and the DOR typo "MINUCIPALITY NAME".
    const muniIdx   = headers.findIndex(h => /CIPALITY NAME/.test(h));
    const countyIdx = headers.findIndex(h => h === 'COUNTY NAME');
    const ratioIdx  = headers.findIndex(h => h === 'AGGREGATE RATIO');

    if ([muniIdx, countyIdx, ratioIdx].includes(-1)) {
      throw new Error(`Missing DOR columns. Found: ${headers.join(', ')}`);
    }

    for (let i = hi + 1; i < rows.length; i++) {
      const r      = rows[i];
      const muni   = r[muniIdx];
      const county = r[countyIdx];
      // DOR stores ratio as a decimal (e.g., 0.9647). Multiply by 100 for percent.
      const ratio  = parseFloat(r[ratioIdx]) * 100;
      if (muni && county && !isNaN(ratio)) {
        dorRatioMap.set(dorKey(muni, county), ratio);
      }
    }
    console.log(`[DOR] Loaded ${dorRatioMap.size} municipality ratios`);
  } catch (err) {
    console.warn(`[DOR] Load failed: ${err.message} — defaulting to 95%`);
  }
}

// ─── hidden.json management ───────────────────────────────────────────────────
function initHiddenFile() {
  if (!fs.existsSync(HIDDEN_FILE)) {
    fs.writeFileSync(HIDDEN_FILE, '[]', 'utf8');
  }
  try {
    const arr = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8'));
    hiddenSet = new Set(Array.isArray(arr) ? arr : []);
    console.log(`[hidden] Loaded ${hiddenSet.size} hidden parcels`);
  } catch {
    hiddenSet = new Set();
    fs.writeFileSync(HIDDEN_FILE, '[]', 'utf8');
  }
}

function saveHidden() {
  fs.writeFileSync(HIDDEN_FILE, JSON.stringify([...hiddenSet], null, 2), 'utf8');
}

// ─── Assessor cache ───────────────────────────────────────────────────────────
function loadAssessorCache() {
  try {
    if (!fs.existsSync(ASSESSOR_CACHE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(ASSESSOR_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) assessorCache.set(k, v);
    console.log(`[assessor] Cache loaded: ${assessorCache.size} parcels`);
  } catch (err) {
    console.warn(`[assessor] Cache load failed: ${err.message}`);
  }
}

let cacheSaveTimer = null;
function scheduleAssessorCacheSave() {
  // Debounce: write at most once per 5 s to avoid hammering disk during a bulk scrape.
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      const obj = Object.fromEntries(assessorCache);
      fs.writeFileSync(ASSESSOR_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[assessor] Cache save failed: ${err.message}`);
    }
  }, 5000);
}

// ─── Water-feature cache ──────────────────────────────────────────────────────
// Bump whenever the shape of a cached feature changes (e.g. v2 added `_acres`) — an old-schema
// cache on disk is silently ignored rather than loaded, so stale entries missing the new data
// get refetched instead of masquerading as complete.
const WATER_CACHE_VERSION = 2;

function loadWaterCache() {
  try {
    if (!fs.existsSync(WATER_CACHE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(WATER_CACHE_FILE, 'utf8'));
    if (obj.__version !== WATER_CACHE_VERSION) {
      console.log(`[water] Cache schema is v${obj.__version ?? 1}, need v${WATER_CACHE_VERSION} — ignoring, will refetch`);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === '__version') continue;
      waterFeatureCache.set(k, v);
    }
    console.log(`[water] Cache loaded: ${waterFeatureCache.size} counties`);
  } catch (err) {
    console.warn(`[water] Cache load failed: ${err.message}`);
  }
}

let waterCacheSaveTimer = null;
function scheduleWaterCacheSave() {
  // Debounce: write at most once per 5 s in case several counties fetch in close succession.
  if (waterCacheSaveTimer) return;
  waterCacheSaveTimer = setTimeout(() => {
    waterCacheSaveTimer = null;
    try {
      const obj = { __version: WATER_CACHE_VERSION, ...Object.fromEntries(waterFeatureCache) };
      fs.writeFileSync(WATER_CACHE_FILE, JSON.stringify(obj), 'utf8');
    } catch (err) {
      console.warn(`[water] Cache save failed: ${err.message}`);
    }
  }, 5000);
}

// ─── express middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── static: serve index.html ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── GET /init-data ───────────────────────────────────────────────────────────
// Returns all DOR ratios as a flat object so the frontend can compute county
// averages and per-parcel display values without additional server round-trips.
app.get('/init-data', (req, res) => {
  const ratios = Object.fromEntries(dorRatioMap);
  res.json({ ratios, defaultRatio: 95 });
});

// ─── GET /parcel-query ────────────────────────────────────────────────────────
// Thin proxy to SCO ArcGIS FeatureServer. The browser controls pagination —
// it calls this once per page (resultOffset=0, 2000, 4000, …).
app.get('/parcel-query', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('f'))     params.set('f',     'geojson');
    if (!params.has('outSR')) params.set('outSR', '4326');
    const data = await fetchJSON(`${SCO_URL}?${params}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /flood-query ─────────────────────────────────────────────────────────
// Proxy to FEMA NFHL FeatureServer. Browser sends bounding-box geometry params.
app.get('/flood-query', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('f'))     params.set('f',     'geojson');
    if (!params.has('outSR')) params.set('outSR', '4326');
    const data = await fetchJSON(`${FEMA_URL}?${params}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /wetlands-query ──────────────────────────────────────────────────────
// Proxy to USFWS NWI MapServer.
app.get('/wetlands-query', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('f'))     params.set('f',     'geojson');
    if (!params.has('outSR')) params.set('outSR', '4326');
    const data = await fetchJSON(`${NWI_URL}?${params}`);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /neighbor-query ─────────────────────────────────────────────────────
// Accepts: { parcels: [{parcelfid, lat, lng, acres}, …] }
// Returns: [{parcelfid, nearestDistanceFt, nearestDistanceMi}, …]
// All computation is local — no external API call. Requires buildings.geojson.
app.post('/neighbor-query', async (req, res) => {
  try {
    const { parcels } = req.body;
    if (!Array.isArray(parcels) || parcels.length === 0) return res.json([]);
    if (buildingGrid.size === 0) {
      return res.status(503).json({
        error: 'Building footprint data not loaded. Download Wisconsin.geojson.zip from ' +
               'https://github.com/microsoft/USBuildingFootprints, unzip, rename to ' +
               'buildings.geojson, place in the project directory, and restart the server.'
      });
    }
    const results = parcels.map(p => {
      // Exclude the parcel's own structure using a radius proportional to parcel size.
      // Formula: 80% of the side length of an equivalent square, minimum 100 m.
      const exclusionM = Math.max(100, Math.sqrt((p.acres || 4) * 4046.86) * 0.8);
      const distM      = nearestBuildingM(p.lat, p.lng, exclusionM);
      return {
        parcelfid:         p.parcelfid,
        nearestDistanceFt: distM != null ? Math.round(distM * 3.28084)              : null,
        nearestDistanceMi: distM != null ? parseFloat((distM / 1609.344).toFixed(2)) : null,
      };
    });
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Search a 5×5 grid neighbourhood (~8 km radius) for the nearest building
// whose centroid is at least exclusionM metres from the parcel centroid.
function nearestBuildingM(lat, lng, exclusionM) {
  const baseR = Math.floor(lat / CELL);
  const baseC = Math.floor(lng / CELL);
  let minDist = Infinity;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      for (const b of (buildingGrid.get(`${baseR + dr}|${baseC + dc}`) || [])) {
        const d = haversineMeters(lat, lng, b.lat, b.lng);
        if (d < exclusionM) continue;
        if (d < minDist) minDist = d;
      }
    }
  }
  return minDist === Infinity ? null : minDist;
}

// ─── Building footprint loader ────────────────────────────────────────────────
// Reads buildings.geojson (Microsoft USBuildingFootprints Wisconsin file,
// standard GeoJSON FeatureCollection with one feature per line).
// Filters to the 11-county bounding box and indexes centroids into buildingGrid.
async function loadBuildingFootprints() {
  if (!fs.existsSync(BUILDINGS_FILE)) {
    console.warn('[buildings] buildings.geojson not found — nearest-structure distances disabled');
    console.warn('[buildings] Get it: download Wisconsin.geojson.zip from');
    console.warn('[buildings]   https://github.com/microsoft/USBuildingFootprints');
    console.warn('[buildings] unzip → rename to buildings.geojson → place in project dir → restart');
    return;
  }

  console.log('[buildings] Loading building footprints…');
  const rl = readline.createInterface({
    input: fs.createReadStream(BUILDINGS_FILE),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    const t = line.trim();
    if (!t || t === '[' || t === ']') continue;
    // Skip the FeatureCollection wrapper line
    if (t.includes('"FeatureCollection"')) continue;
    const json = t.endsWith(',') ? t.slice(0, -1) : t;
    try {
      const feat = JSON.parse(json);
      if (!feat.geometry) continue;
      const c = geojsonCentroid(feat.geometry);
      if (!c) continue;
      const { lat, lng } = c;
      if (lat < BLDG_BBOX.minLat || lat > BLDG_BBOX.maxLat ||
          lng < BLDG_BBOX.minLng || lng > BLDG_BBOX.maxLng) continue;
      const key = `${Math.floor(lat / CELL)}|${Math.floor(lng / CELL)}`;
      if (!buildingGrid.has(key)) buildingGrid.set(key, []);
      buildingGrid.get(key).push({ lat, lng });
      count++;
    } catch {}
  }

  console.log(`[buildings] Loaded ${count.toLocaleString()} buildings in ${buildingGrid.size} grid cells`);
}

function geojsonCentroid(geom) {
  if (!geom) return null;
  let coords;
  if      (geom.type === 'Polygon')      coords = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') coords = geom.coordinates[0][0];
  else return null;
  if (!coords || !coords.length) return null;
  let slng = 0, slat = 0;
  for (const c of coords) { slng += c[0]; slat += c[1]; }
  return { lat: slat / coords.length, lng: slng / coords.length };
}


function haversineMeters(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── POST /assessor-query ─────────────────────────────────────────────────────
// Accepts:
//   { county: "DANE", parcels: [{parcelfid, siteadress, cityname}, …] }
// Returns:
//   { results: [{parcelfid, bedrooms, sqft, yearBuilt}, …], error?: string }
// Cache hit: returns immediately without hitting the county website.
app.post('/assessor-query', async (req, res) => {
  const { county, parcels } = req.body;
  if (!county || !Array.isArray(parcels) || parcels.length === 0) {
    return res.json({ results: [] });
  }
  console.log(`[assessor:${county}] ${parcels.length} parcels requested`);

  const scraper = COUNTY_SCRAPERS[county.toUpperCase()];
  if (scraper === undefined) {
    return res.json({ results: [], error: `No scraper for county: ${county}` });
  }
  if (scraper === null) {
    // Scraper not yet implemented — signal stub so the UI shows "—" not "✗".
    return res.json({ results: null, error: 'stub' });
  }

  let cacheWrites = 0;
  const results = new Array(parcels.length);

  const tasks = parcels.map((parcel, idx) => async () => {
    const cached = assessorCache.get(parcel.parcelfid);
    if (cached) {
      results[idx] = { parcelfid: parcel.parcelfid, ...cached };
      return;
    }
    try {
      const data = await scraper(parcel);
      const entry = {
        bedrooms: data.bedrooms ?? null,
        sqft: data.sqft ?? null,
        yearBuilt: data.yearBuilt ?? null,
        cachedAt: Date.now(),
      };
      assessorCache.set(parcel.parcelfid, entry);
      cacheWrites++;
      results[idx] = { parcelfid: parcel.parcelfid, ...entry };
    } catch (err) {
      console.warn(`[assessor:${county}] ${parcel.parcelfid}: ${err.message}`);
      results[idx] = { parcelfid: parcel.parcelfid, bedrooms: null, sqft: null, yearBuilt: null };
    }
  });

  await runConcurrently(tasks, 5);
  if (cacheWrites > 0) scheduleAssessorCacheSave();
  res.json({ results });
});

// ─── County scrapers ──────────────────────────────────────────────────────────
// Each scraper: async (parcel) => { bedrooms, sqft, yearBuilt }
// parcel fields available: { parcelfid, siteadress, cityname }
// Return null for any field not found. Throw to signal a lookup failure.
// null entry in COUNTY_SCRAPERS = known stub (signals 'stub' to UI without burning HTTP).

// Generic table/dl parser — extracts bedrooms, sqft, yearBuilt from labeled HTML rows.
// Works for most county portals that render building data in <table> or <dl> structures.
function parseLabelValueTable($) {
  let bedrooms = null, sqft = null, yearBuilt = null;
  const trySet = (rawLabel, rawVal) => {
    const l = rawLabel.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
    const n = parseInt(rawVal.replace(/[^0-9]/g, ''), 10);
    if (/BEDROOM|BDRM/.test(l) && !isNaN(n) && n < 30)                                               bedrooms  = n;
    if (/SQ ?FT|SQUARE FEET|TOTAL.{1,10}AREA|LIVING.{1,10}AREA|FLOOR.{1,5}AREA/.test(l) && !isNaN(n) && n > 100) sqft = n;
    if (/YEAR.{1,5}BUILT|YR.{1,5}BUILT|^BUILT$/.test(l) && !isNaN(n) && n > 1800 && n < 2100)        yearBuilt = n;
  };
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    trySet($(cells[0]).text().trim(), $(cells[cells.length - 1]).text().trim());
    if (cells.length >= 4) trySet($(cells[2]).text().trim(), $(cells[3]).text().trim());
  });
  $('dt').each((_, dt) => trySet($(dt).text().trim(), $(dt).next('dd').text().trim()));
  return { bedrooms, sqft, yearBuilt };
}

// ── Dane County ───────────────────────────────────────────────────────────────
// Access Dane is a tax-only portal — no building characteristics.
// Building data comes from three sources, tried in order:
//
//   1. AccurateAssessor (Prolorem Dataverse): towns Albion, Berry, Blooming Grove,
//      Cottage Grove, Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant
//      Springs, Primrose, + villages. Has bedrooms, sqft, year built.
//
//   2. City of Madison ArcGIS MapServer: City of Madison only.
//      Has bedrooms, sqft, year built.
//
//   3. CAMA Cloud (Playwright): Town of Bristol, Springfield, Westport, Burke;
//      Village of Cottage Grove, Waunakee, DeForest, Verona, and others.
//      Headless Chromium bypasses the AWS WAF that blocks direct HTTP requests.
//
//   Other municipalities (York, Springdale, Montrose, …): AssessorData.org has
//     sqft/year but not bedrooms — not yet integrated.
//
async function scrapeDane(parcel) {
  const raw = String(parcel.parcelfid || '');
  const pin = raw.replace(/^[A-Z]+\//, '').replace(/-/g, '');
  if (!/^\d{12}$/.test(pin)) throw new Error(`Unexpected Dane PARCELID format: ${raw}`);

  // 1. AccurateAssessor (Prolorem) Dataverse API — public, no auth needed.
  //    Parcel records have format "MMM/XXXXXXXXXXXX"; contains() on the 12-digit portion
  //    matches only parcels in AccurateAssessor-covered municipalities.
  try {
    const filter = `statecode eq 0 and contains(acc_parcelumber,'${pin}')`;
    const expand = `acc_acc_realestate_acc_dwelling_RealEstate($select=acc_bedroomcount,acc_totallivingarea,acc_yearbuilt)`;
    const select = `acc_dwellingtotallivingarea,acc_dwellingrecordcount`;
    const url = `https://accurateassessor.powerappsportals.com/_api/acc_realestates`
      + `?$filter=${encodeURIComponent(filter)}`
      + `&$expand=${encodeURIComponent(expand)}`
      + `&$select=${encodeURIComponent(select)}`
      + `&$top=1`;
    const text = await fetchHTML(url, {
      headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Accept': 'application/json' },
    });
    const data = JSON.parse(text);
    const recs = data.value || [];
    if (recs.length) {
      const rec = recs[0];
      const dwellings = rec['acc_acc_realestate_acc_dwelling_RealEstate'] || [];
      let bedrooms = null, sqft = null, yearBuilt = null;
      for (const d of dwellings) {
        if (d.acc_bedroomcount != null) bedrooms = d.acc_bedroomcount;
        if (d.acc_totallivingarea != null) sqft = d.acc_totallivingarea;
        if (d.acc_yearbuilt) yearBuilt = parseInt(d.acc_yearbuilt.slice(0, 4), 10);
      }
      if (sqft == null && rec.acc_dwellingtotallivingarea != null) sqft = rec.acc_dwellingtotallivingarea;
      if (bedrooms != null || sqft != null) {
        console.log(`[assessor:DANE/AA] ${pin} → beds=${bedrooms} sqft=${sqft} yr=${yearBuilt}`);
        return { bedrooms, sqft, yearBuilt };
      }
    }
  } catch (err) {
    console.warn(`[assessor:DANE/AA] ${pin}: ${err.message}`);
  }

  // 2. City of Madison ArcGIS MapServer — public, no auth needed.
  //    Parcel field is a 12-char string matching the SCO PARCELID directly.
  try {
    const url = `https://maps.cityofmadison.com/arcgis/rest/services/Public/Property_Lookup/MapServer/9/query`
      + `?where=${encodeURIComponent(`Parcel='${pin}'`)}`
      + `&outFields=Bedrooms,TotalLivingArea,YearBuilt&returnGeometry=false&f=json`;
    const text = await fetchHTML(url);
    const data = JSON.parse(text);
    const features = data.features || [];
    if (features.length) {
      const a = features[0].attributes;
      const bedrooms  = a.Bedrooms       ?? null;
      const sqft      = a.TotalLivingArea ?? null;
      const yearBuilt = a.YearBuilt       ?? null;
      if (bedrooms != null || sqft != null) {
        console.log(`[assessor:DANE/Madison] ${pin} → beds=${bedrooms} sqft=${sqft} yr=${yearBuilt}`);
        return { bedrooms, sqft, yearBuilt };
      }
    }
  } catch (err) {
    console.warn(`[assessor:DANE/Madison] ${pin}: ${err.message}`);
  }

  // 3. CAMA Cloud (Playwright) — Bristol, Springfield, Westport, Burke,
  //    Village of Cottage Grove, Waunakee, DeForest, Verona, and others.
  try {
    const result = await scrapeCamaCloud(parcel);
    if (result.bedrooms != null || result.sqft != null) return result;
  } catch (err) {
    console.warn(`[assessor:DANE/CAMA] ${pin}: ${err.message}`);
  }

  // Municipality not covered by any integrated source.
  return { bedrooms: null, sqft: null, yearBuilt: null };
}

// ── Jefferson County ──────────────────────────────────────────────────────────
// System: JCLRS  https://apps.jeffersoncountywi.gov/jc/jclrs
// SCO PARCELID: "XXX-XXXX-XXXX-XXX" — used directly in URL path.
// The public JCLRS summary report exposes assessment/tax data; CAMA building
// characteristics (bedrooms, sqft) are not exposed in this view. Results will
// cache as null until Jefferson County adds a building-data endpoint.
async function scrapeJefferson(parcel) {
  const html = await fetchHTML(
    `https://apps.jeffersoncountywi.gov/jc/JCLRS/parcel_summary_report/${encodeURIComponent(parcel.parcelfid)}`
  );
  return parseLabelValueTable(cheerio.load(html));
}

// ── Rock County ───────────────────────────────────────────────────────────────
// System: taxsearch.co.rock.wi.us (PHP)
// SCO PARCELID: "XXX XXXXXX" (alpha-prefix + space + numeric, e.g. "Z002 020007")
// Space encodes as + in the taxid query param (PHP convention).
async function scrapeRock(parcel) {
  const taxid = (parcel.parcelfid || '').replace(/ /g, '+');
  try {
    const html = await fetchHTML(`https://taxsearch.co.rock.wi.us/parceldetails.php?taxid=${taxid}`);
    return parseLabelValueTable(cheerio.load(html));
  } catch {
    // Fallback to legacy URL path in case subdomain is unavailable.
    const html = await fetchHTML(`http://www.co.rock.wi.us/Rock/TaxSearch/parceldetails.php?taxid=${taxid}`);
    return parseLabelValueTable(cheerio.load(html));
  }
}

// ── Dodge County ─────────────────────────────────────────────────────────────
// System: LIST (GCSWebPortal)  https://list.co.dodge.wi.us/GCSWebPortal
// SCO PARCELID: "XXX-XXXX-XXXX-XXX" — strip dashes for ParcelNumber param.
// ASP.NET session: a prior GET to the search page is needed to obtain a session
// cookie, otherwise the parcel-number query triggers an infinite redirect loop.
async function scrapeDodge(parcel) {
  const parcelNo = (parcel.parcelfid || '').replace(/-/g, '');
  const baseUrl  = 'https://list.co.dodge.wi.us/GCSWebPortal/Search.aspx';
  const cookie   = await fetchSessionCookie(baseUrl);
  const html = await fetchHTML(
    `${baseUrl}?ParcelNumber=${encodeURIComponent(parcelNo)}`,
    { headers: cookie ? { Cookie: cookie } : {} }
  );
  return parseLabelValueTable(cheerio.load(html));
}

// ── CAMA Cloud (Playwright) ───────────────────────────────────────────────────
// CAMA Cloud (camacloudtech.com) is a Next.js App Router app protected by AWS
// WAF (blocks plain HTTP clients). Playwright/Chromium bypasses the WAF.
// We call Next.js Server Actions via fetch() from within the browser context
// rather than interacting with the UI.
//
// Server Action IDs from bundle 0hds_li8i1oin.js (extracted 2026-07-26):
//   getCountyMunicipalities(countyId, taxYear)
//   getCountyMuniAsmts(countyId, muniId, taxYear)
// Dane County ID in CAMA Cloud system = 18.
// NOTE: Next.js re-hashes these IDs on every deploy of camacloudtech.com, so
// they will go stale again. If munis start failing with "action not found",
// re-extract: curl the /search page for its /_next/static/chunks/*.js list,
// download each chunk, and grep for "getCountyMunicipalities"/"getCountyMuniAsmts" —
// the createServerReference(...) call immediately before each name has the new ID.

const CAMA_DANE_ID  = 18;
const CAMA_TAX_YEAR = 2025;
const CAMA_A_MUNIS  = '600d5b11deb80767f90baba9a38a053277076cb213';
const CAMA_A_ASMTS  = '70a08497e34fecc1b2e85b6393f86335091ebed9b5';

let _camaBrowser  = null;
let _camaPage     = null;    // Persistent page for server action fetch() calls
let _camaMuniLoad = null;    // Promise; set once; null = not started
const _camaMuniMap   = new Map(); // normalised name → muniId
const _camaAsmtCache = new Map(); // muniId → Map<taxKey, asmtId>

async function camaGetPage() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    throw new Error('playwright not installed — run: npm install playwright && npx playwright install chromium');
  }
  if (!_camaBrowser || !_camaBrowser.isConnected()) {
    _camaBrowser = await chromium.launch({ headless: true });
    _camaPage    = null;
  }
  if (!_camaPage || _camaPage.isClosed()) {
    const ctx = await _camaBrowser.newContext({ userAgent: SCRAPER_UA });
    _camaPage  = await ctx.newPage();
    await _camaPage.goto('https://camacloudtech.com/search', { waitUntil: 'networkidle', timeout: 30000 });
  }
  return _camaPage;
}

async function camaCallAction(actionId, args) {
  const pg = await camaGetPage();
  return pg.evaluate(async ({ actionId, args }) => {
    const res = await fetch('https://camacloudtech.com/search', {
      method: 'POST',
      headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(args),
      credentials: 'include',
    });
    return { status: res.status, text: await res.text() };
  }, { actionId, args });
}

function camaParseRsc(text) {
  const parsed = {};
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^(\w+):(.+)$/s);
    if (m) { try { parsed[m[1]] = JSON.parse(m[2]); } catch {} }
  }
  return parsed;
}

function camaLoadMunis() {
  if (_camaMuniLoad) return _camaMuniLoad;
  _camaMuniLoad = (async () => {
    const res    = await camaCallAction(CAMA_A_MUNIS, [CAMA_DANE_ID, CAMA_TAX_YEAR]);
    const parsed = camaParseRsc(res.text);
    const munis  = Object.values(parsed).find(v => Array.isArray(v) && v.length > 0 && v[0]?.id);
    if (!munis) throw new Error('getCountyMunicipalities returned no data');
    for (const m of munis) {
      const key = (m.name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (key) _camaMuniMap.set(key, m.id);
    }
    console.log(`[CAMA] Ready — ${_camaMuniMap.size} Dane municipalities`);
  })().catch(err => {
    _camaMuniLoad = null;
    console.warn(`[CAMA] Municipality load failed: ${err.message}`);
  });
  return _camaMuniLoad;
}

function camaFindMuniId(cityname) {
  if (_camaMuniMap.size === 0) return null;
  const norm = (cityname || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (_camaMuniMap.has(norm)) return _camaMuniMap.get(norm);
  const bare = norm.replace(/^(VILLAGE|TOWN|CITY) OF /, '');
  for (const [k, v] of _camaMuniMap) {
    if (k.replace(/^(VILLAGE|TOWN|CITY) OF /, '') === bare) return v;
  }
  for (const [k, v] of _camaMuniMap) {
    if (k.includes(bare)) return v;
  }
  return null;
}

async function camaGetMuniAsmts(muniId) {
  if (_camaAsmtCache.has(muniId)) return _camaAsmtCache.get(muniId);
  const res    = await camaCallAction(CAMA_A_ASMTS, [CAMA_DANE_ID, muniId, CAMA_TAX_YEAR]);
  const parsed = camaParseRsc(res.text);
  const asmts  = Object.values(parsed).find(v => Array.isArray(v) && v.length > 0);
  if (!asmts) throw new Error(`getCountyMuniAsmts(${muniId}) returned no data`);
  const map = new Map();
  for (const a of asmts) {
    if (a.taxKeyNumber) map.set(a.taxKeyNumber, a.id);
  }
  _camaAsmtCache.set(muniId, map);
  return map;
}

function pinToTaxKey(pin) {
  // 12-digit SCO PIN → CAMA Cloud 4-3-4-1 format e.g. 0809-051-0005-1
  return `${pin.slice(0,4)}-${pin.slice(4,7)}-${pin.slice(7,11)}-${pin.slice(11)}`;
}

function parseAsmtText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let bedrooms = null, sqft = null, yearBuilt = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const lbl = lines[i].toLowerCase();
    const val = lines[i + 1];
    if (lbl === 'bedrooms:') {
      const n = parseInt(val, 10);
      if (!isNaN(n)) bedrooms = n;
    } else if (lbl === 'year built:') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n > 1800) yearBuilt = n;
    } else if (lbl === 'total living area:') {
      const n = parseInt(val.replace(/,/g, ''), 10);
      if (!isNaN(n)) sqft = n;
    }
  }
  return { bedrooms, sqft, yearBuilt };
}

async function scrapeCamaCloud(parcel) {
  await camaLoadMunis();

  const muniId = camaFindMuniId(parcel.cityname);
  if (!muniId) return { bedrooms: null, sqft: null, yearBuilt: null };

  const pin = String(parcel.parcelfid || '').replace(/^[A-Z]+\//, '').replace(/-/g, '');
  if (!/^\d{12}$/.test(pin)) throw new Error(`Unexpected PARCELID: ${parcel.parcelfid}`);

  const taxKey  = pinToTaxKey(pin);
  const asmtMap = await camaGetMuniAsmts(muniId);
  const asmtId  = asmtMap.get(taxKey);
  if (!asmtId) return { bedrooms: null, sqft: null, yearBuilt: null };

  const pg   = await camaGetPage();
  await pg.goto(`https://camacloudtech.com/search/asmt/${asmtId}`, { waitUntil: 'networkidle', timeout: 30000 });
  const text   = await pg.evaluate(() => document.body.innerText);
  const result = parseAsmtText(text);

  if (result.bedrooms != null || result.sqft != null) {
    console.log(`[assessor:DANE/CAMA] ${pin} → beds=${result.bedrooms} sqft=${result.sqft} yr=${result.yearBuilt}`);
  }
  return result;
}

const COUNTY_SCRAPERS = {
  DANE:       scrapeDane,
  JEFFERSON:  scrapeJefferson,
  ROCK:       scrapeRock,
  DODGE:      scrapeDodge,
  // ── Stubs: null = known unimplemented, returns 'stub' status to UI ──────────
  // WAUKESHA: tax.waukeshacounty.gov — session-based search, no direct deep-link.
  //   Building data is held per-municipality. Requires POST form with session state.
  WAUKESHA:   null,
  // GREEN/COLUMBIA/WALWORTH/WASHINGTON: Ascent Land Records Suite (Transcendent Technologies).
  //   Angular SPA — REST API endpoints could not be determined without running the app
  //   in a browser and capturing XHR traffic via DevTools. To implement:
  //   1. Open the county's Ascent portal in Chrome DevTools → Network → XHR/Fetch
  //   2. Search for a known parcel and record the API request URL + response shape
  //   3. Implement a scraper using those endpoints
  //   Green:      https://ascent.greencountywi.org/LandRecords/PropertyListing/RealEstateTaxParcel
  //   Columbia:   http://ascent.co.columbia.wi.us/LandRecords/PropertyListing/RealEstateTaxParcel
  //   Walworth:   https://ascent.co.walworth.wi.us/LandRecords/PropertyListing/RealEstateTaxParcel
  //   Washington: https://landrecords.washcowisco.gov/LandRecords/PropertyListing/RealEstateTaxParcel
  GREEN:      null,
  WALWORTH:   null,
  COLUMBIA:   null,
  WASHINGTON: null,
  // RACINE: not in AccurateAssessor. Uses Ascent LRS (ascent.racinecounty.gov) for tax
  //   data — same dead end as Green/Columbia/Walworth/Washington above. The only
  //   building-data source found is CAMA Cloud, which covers just 1 of 17 municipalities
  //   (Village of Wind Point, ~851 parcels) — bulk-fetched once, not worth a live scraper.
  RACINE:     null,
  // KENOSHA: not in AccurateAssessor, but the county runs its own public "Catalis /
  //   LandNav" property inquiry portal (pp-kenosha-co-wi-fb.app.landnav.com, free
  //   "Guest Sign In") which exposes full CAMA building data — including Bedrooms — for
  //   every municipality in the county. Best source found in this project; bulk-fetched
  //   via fetch_kenosha_landnav.py rather than wired up as a live per-parcel scraper.
  KENOSHA:    null,
};

// ─── GET /water-query ────────────────────────────────────────────────────────
// Queries USGS NHD for waterbodies and flowlines in the given bbox.
// Browser passes geometry/geometryType/spatialRel/inSR params; proxy adds outSR/f.
// Returns a GeoJSON FeatureCollection merging both layers.
app.get('/water-query', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    if (!params.has('f'))     params.set('f',     'geojson');
    if (!params.has('outSR')) params.set('outSR', '4326');

    const [bodies, lines] = await Promise.all([
      fetchJSON(`${NHD_WATERBODY_URL}?${params}`).catch(() => ({ features: [] })),
      fetchJSON(`${NHD_FLOWLINE_URL}?${params}` ).catch(() => ({ features: [] }))
    ]);

    res.json({
      type: 'FeatureCollection',
      features: [...(bodies.features || []), ...(lines.features || [])]
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /water-adjacency-query ─────────────────────────────────────────────
// Accepts: { parcels: [{parcelfid, lat, lng, county}, …] }
// Returns: { results: [{parcelfid, waterAdjacent}, …] }
// Water features are fetched and cached per `county` (see getWaterFeaturesForCounty below),
// not per search bbox.
//
// This used to run client-side: ship every NHD lake/stream plus every qualifying NWI pond in
// the search bbox to the browser as raw GeoJSON, then loop turf distance checks over every
// parcel there. A single county can have 2,000+ qualifying farm ponds, and shipping + parsing
// that much geometry then running an unindexed nested loop froze the browser tab for extended
// stretches. Computing it here instead means the browser gets back a handful of booleans, and
// the (still O(parcels × water features), just server-side) loop runs against a grid index —
// same technique as nearestBuildingM/buildingGrid above, just built fresh per-request since
// water data comes from a live external API rather than a static local file.

// Paginates past the upstream services' maxRecordCount (Wetlands: 1000, NHD: 2000) — a single
// unpaginated request silently drops features beyond that cap for a county-sized bbox
// (confirmed: a full-Racine-County pond query hits exceededTransferLimit at exactly 1000
// features). Pages are fetched BATCH at a time in parallel since each page takes ~40s from
// these upstream federal/NWI services — sequential paging alone made an 11-county search
// impractically slow. Capped at 5 rounds (20k features) as a safety valve against a runaway loop.
// Pages are fetched ONE AT A TIME, not in parallel. Tried 4-way concurrent pagination first;
// confirmed live that these federal ArcGIS hosts degrade under concurrent load from a single
// client — a lone sequential page reliably returns in ~44s, but 4 concurrent requests to the
// SAME host pushed even the first one past a 90s timeout. Page failures are NOT swallowed —
// a timed-out or errored page throws and propagates up to the /water-adjacency-query handler,
// which fails the whole request (502) rather than silently substituting [] and turning "we
// couldn't reach the upstream service" into a wrong "there is no water here" (`false`).
async function fetchAllFeaturesUpstream(url, baseParams) {
  const all = [];
  for (let offset = 0, page = 0; page < 20; page++, offset += 1000) {
    const params = new URLSearchParams({ ...baseParams, resultRecordCount: '1000', resultOffset: String(offset) });
    const feats  = (await fetchJSON(`${url}?${params}`)).features || [];
    all.push(...feats);
    if (feats.length < 1000) break; // last page — ArcGIS page sizes decrease monotonically to 0
  }
  return all;
}

// The NWI pond query's WHERE clause joins against NWI_Wetland_Codes (see NWI_POND_WHERE), and
// that join scales far worse than a plain query as the bbox grows — confirmed live: a
// 0.1°×0.1° box returns in ~7s, a 0.2°×0.2° box (4x the area) already takes 31s, and a single
// county-sized bbox never completes inside fetchJSON's 90s timeout (hangs past 100s with no
// response at all, with or without geometry — it's the join, not the payload). NHD's plain
// '1=1' queries have no such join and return a full county in ~2s, so only the pond query
// needs to be split. NWI_TILE_DEG keeps each tile's area well under where the join starts
// timing out, with margin for denser-than-average pond areas.
const NWI_TILE_DEG = 0.15;

function tileBbox([minLng, minLat, maxLng, maxLat], tileDeg) {
  const tiles = [];
  for (let y = minLat; y < maxLat; y += tileDeg) {
    for (let x = minLng; x < maxLng; x += tileDeg) {
      tiles.push([x, y, Math.min(x + tileDeg, maxLng), Math.min(y + tileDeg, maxLat)]);
    }
  }
  return tiles;
}

// outFields must be table-qualified (Wetlands.WETLAND_TYPE) here — this service 400s on a
// bare column name once the WHERE clause references the joined NWI_Wetland_Codes table.
// Ponds that straddle a tile boundary are returned once per tile they intersect, so results
// are deduped by the geojson feature's `id` (the service's OBJECTID) across tiles.
async function fetchNwiPondsForBbox(bbox, baseParams) {
  const seen = new Map();
  for (const [minLng, minLat, maxLng, maxLat] of tileBbox(bbox, NWI_TILE_DEG)) {
    const geomParam = JSON.stringify({ xmin: minLng, ymin: minLat, xmax: maxLng, ymax: maxLat, spatialReference: { wkid: 4326 } });
    // OBJECTID must be requested explicitly — without it, geojson conversion leaves
    // feature.id undefined for every pond, which previously collapsed every tile's ponds
    // into a single Map entry keyed by undefined and silently dropped all but the last one.
    const feats = await fetchAllFeaturesUpstream(NWI_URL, { ...baseParams, geometry: geomParam, outFields: 'Wetlands.OBJECTID,Wetlands.WETLAND_TYPE,Wetlands.ACRES', where: NWI_POND_WHERE });
    for (const f of feats) seen.set(f.id, f);
  }
  const ponds = [...seen.values()];
  // NWI already reports area in acres — no unit conversion needed, unlike NHD's AREASQKM below.
  for (const f of ponds) {
    const acres = f.properties?.['Wetlands.ACRES'];
    f._acres = (typeof acres === 'number') ? acres : null;
  }
  return ponds;
}

// Fetches NHD lakes/streams plus NWI-classified open-water ponds (farm ponds too small or
// recent to be in NHD, e.g. excavated stock ponds) within bbox, merged into one array.
// NWI_POND_WHERE keeps marsh/swamp/seasonal wetlands out of the merge. The three sources are
// fetched sequentially too, for the same concurrent-load reason as fetchAllFeaturesUpstream —
// the NHD waterbody and flowline layers share a host, and hammering it doesn't help.
// Polygon features (waterbody, ponds) get a `_acres` field for the min-water-area filter;
// flowlines are lines with no area and are left without one.
async function fetchOpenWaterFeaturesForBbox(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const geomParam = JSON.stringify({ xmin: minLng, ymin: minLat, xmax: maxLng, ymax: maxLat, spatialReference: { wkid: 4326 } });
  const baseParams = {
    geometry: geomParam, geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects', inSR: '4326',
    returnGeometry: 'true', outSR: '4326', f: 'geojson',
  };
  const waterbody = await fetchAllFeaturesUpstream(NHD_WATERBODY_URL, { ...baseParams, outFields: 'OBJECTID,GNIS_NAME,AREASQKM', where: '1=1' });
  for (const f of waterbody) {
    const sqkm = f.properties?.AREASQKM;
    f._acres = (typeof sqkm === 'number') ? sqkm * SQKM_TO_ACRES : null;
  }
  const flowline  = await fetchAllFeaturesUpstream(NHD_FLOWLINE_URL,  { ...baseParams, outFields: 'OBJECTID,GNIS_NAME', where: '1=1' });
  const ponds     = await fetchNwiPondsForBbox(bbox, baseParams);
  return [...waterbody, ...flowline, ...ponds];
}

// Buckets water features into the same CELL-sized grid used by buildingGrid, keyed by every
// cell each feature's (buffered) bbox overlaps — unlike buildings, water features are lines/
// polygons that can span many cells, not single points. Unnamed flowlines (unmapped farm
// creeks/ditches) are dropped here rather than at fetch time, matching the "GNIS-named
// streams only" rule.
// NHD lake polygons — especially the Great Lakes, since Racine and Kenosha border Lake
// Michigan — can carry tens of thousands of shoreline vertices, which makes every downstream
// turf operation on them (bbox, polygonToLine, booleanPointInPolygon) slow. Confirmed live:
// a Racine County search's CPU-bound distance-matching phase blocked the whole Node process
// for minutes, on top of the fetch time. Simplifying once here, well inside the 300ft
// adjacency threshold (73ft max deviation), collapses vertex count without materially
// changing which parcels count as adjacent.
const SIMPLIFY_TOLERANCE_DEG = 0.0002; // ~73 ft at this latitude

function buildWaterGrid(features, minAcres = 0) {
  const bufDeg = (WATER_ADJACENT_FT / 364000) * 1.5; // rough ft→degree conversion + margin
  const grid = new Map(); // "row|col" -> [feature, …]
  for (let wf of features) {
    if (!wf.geometry) continue;
    const isLine = wf.geometry.type === 'LineString' || wf.geometry.type === 'MultiLineString';
    // NHD's GeoJSON output uses lowercase "gnis_name" (the "GNIS_NAME" alias only applies to
    // non-geojson/Esri JSON responses) — matching on the uppercase key would silently treat
    // every flowline as unnamed.
    if (isLine && !wf.properties?.gnis_name) continue;
    // Rivers/streams have no area and are exempt from this filter. A feature with unknown
    // acreage (missing AREASQKM upstream) is let through rather than dropped — same fail-open
    // reasoning as elsewhere in this file: unknown shouldn't silently become "doesn't count".
    if (!isLine && minAcres > 0 && typeof wf._acres === 'number' && wf._acres < minAcres) continue;
    try { wf = turf.simplify(wf, { tolerance: SIMPLIFY_TOLERANCE_DEG, highQuality: false, mutate: true }); } catch {}
    let bb;
    try { bb = turf.bbox(wf); } catch { continue; }
    const [minX, minY, maxX, maxY] = [bb[0] - bufDeg, bb[1] - bufDeg, bb[2] + bufDeg, bb[3] + bufDeg];
    wf._bbox = [minX, minY, maxX, maxY];
    const r0 = Math.floor(minY / CELL), r1 = Math.floor(maxY / CELL);
    const c0 = Math.floor(minX / CELL), c1 = Math.floor(maxX / CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${r}|${c}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(wf);
      }
    }
  }
  return grid;
}

function waterFeatureDistanceFt(pt, wf) {
  const g = wf.geometry;
  if (!g) return Infinity;
  // turf@6's pointToLineDistance only accepts a single-part LineString — Multi* geometries
  // (multi-part lakes, rivers with disconnected segments) must be split and compared piece by
  // piece, otherwise it throws and the feature is silently skipped as a non-match.
  if (g.type === 'MultiLineString' || g.type === 'MultiPolygon') {
    // The same water feature is checked against every nearby parcel — cache the flatten once
    // per feature (on the feature itself) instead of recomputing it on every call, so each
    // resulting Polygon part is a stable object that can itself cache _outline below.
    if (!wf._parts) wf._parts = turf.flatten(wf).features;
    let min = Infinity;
    for (const part of wf._parts) {
      const d = waterFeatureDistanceFt(pt, part);
      if (d < min) min = d;
    }
    return min;
  }
  if (g.type === 'LineString') {
    return turf.pointToLineDistance(pt, wf, { units: 'feet' });
  }
  if (g.type === 'Polygon') {
    if (turf.booleanPointInPolygon(pt, wf)) return 0;
    // Cached on first use — polygonToLine on a large lake shoreline is expensive, and the same
    // polygon is checked against every parcel whose grid cell it overlaps.
    if (!wf._outline) wf._outline = turf.polygonToLine(wf); // may itself be a MultiLineString if the polygon has holes
    return waterFeatureDistanceFt(pt, wf._outline);
  }
  return Infinity;
}

// Checks the parcel's own grid cell plus its 8 neighbors — a 1-cell buffer is enough since
// CELL (0.05°, ~3.5km) is vastly larger than WATER_ADJACENT_FT (300ft, ~0.0009°), so a
// qualifying feature can only ever be one cell away from the parcel's own cell.
function isWaterAdjacent(grid, lat, lng) {
  const pt  = turf.point([lng, lat]);
  const row = Math.floor(lat / CELL), col = Math.floor(lng / CELL);
  const seen = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      for (const wf of (grid.get(`${row + dr}|${col + dc}`) || [])) {
        if (seen.has(wf)) continue;
        seen.add(wf);
        const [minX, minY, maxX, maxY] = wf._bbox;
        if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
        try { if (waterFeatureDistanceFt(pt, wf) <= WATER_ADJACENT_FT) return true; } catch {}
      }
    }
  }
  return false;
}

// Water features are cached per county rather than per search bbox — the first
// water-adjacency request touching a county pays for the full NHD/NWI fetch (minutes for a
// Lake-Michigan county like Racine/Kenosha), and every later request for that county, from any
// map viewport or search, is served straight from waterFeatureCache. The county's extent is
// queried live from the same Statewide Parcels service used for parcel search (SCO_URL) rather
// than hardcoded, so it can't silently drift from the actual parcel data.
//
// Padded by ~1 mile: a one-time per-county fetch can afford a generous margin so a water body
// just across the county line still counts for a parcel near the border (WATER_ADJACENT_FT
// itself is only 300 ft).
const COUNTY_EXTENT_PAD_DEG = 0.02;

async function fetchCountyExtent(county) {
  const params = new URLSearchParams({ where: `CONAME='${county}'`, returnExtentOnly: 'true', outSR: '4326', f: 'json' });
  const data = await fetchJSON(`${SCO_URL}?${params}`);
  const ext  = data.extent;
  if (!ext || ext.xmin == null) throw new Error(`No parcel extent for county: ${county}`);
  return [ext.xmin - COUNTY_EXTENT_PAD_DEG, ext.ymin - COUNTY_EXTENT_PAD_DEG,
          ext.xmax + COUNTY_EXTENT_PAD_DEG, ext.ymax + COUNTY_EXTENT_PAD_DEG];
}

// Guards against two concurrent water-adjacency requests for a brand-new county both paying
// for the full fetch — the second request just awaits the first's in-flight promise.
const waterFetchInFlight = new Map();

async function getWaterFeaturesForCounty(county) {
  const cached = waterFeatureCache.get(county);
  if (cached) {
    console.log(`[water:${county}] Loading water data from cache (${cached.features.length} features)`);
    return cached.features;
  }
  if (waterFetchInFlight.has(county)) return waterFetchInFlight.get(county);

  const promise = (async () => {
    console.log(`[water:${county}] Not cached — fetching water data from NHD/NWI…`);
    const bbox     = await fetchCountyExtent(county);
    const features = await fetchOpenWaterFeaturesForBbox(bbox);
    waterFeatureCache.set(county, { features, cachedAt: Date.now() });
    console.log(`[water:${county}] Saving water data to cache (${features.length} features)`);
    scheduleWaterCacheSave();
    return features;
  })();
  waterFetchInFlight.set(county, promise);
  try {
    return await promise;
  } finally {
    waterFetchInFlight.delete(county);
  }
}

// ─── GET /water-cache-status ──────────────────────────────────────────────────
// Cheap pre-check so the browser can show "fetching from source" (can take minutes for a
// Great-Lakes county) vs. "from cache" (near-instant) BEFORE kicking off the slow
// /water-adjacency-query request — otherwise there's no indication of what's happening during
// a long first-time county fetch.
app.get('/water-cache-status', (req, res) => {
  const counties = (req.query.counties || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
  const status = {};
  for (const c of counties) status[c] = waterFeatureCache.has(c);
  res.json({ status });
});

app.post('/water-adjacency-query', async (req, res) => {
  try {
    const { parcels, minAcres } = req.body;
    if (!Array.isArray(parcels)) {
      return res.status(400).json({ error: 'parcels required' });
    }
    if (parcels.length === 0) return res.json({ results: [] });

    const counties = [...new Set(parcels.map(p => (p.county || '').toUpperCase()).filter(Boolean))];
    if (counties.length === 0) {
      return res.json({ results: parcels.map(p => ({ parcelfid: p.parcelfid, waterAdjacent: false })) });
    }

    const minAcresNum = (typeof minAcres === 'number' && minAcres > 0) ? minAcres : 0;
    const t0 = Date.now();
    const featureLists = await Promise.all(counties.map(c => getWaterFeaturesForCounty(c)));
    const features = featureLists.flat();
    const t1 = Date.now();
    const grid = buildWaterGrid(features, minAcresNum);
    const t2 = Date.now();

    // Yielding every YIELD_EVERY parcels lets other requests (a second search, a status check)
    // interleave during this CPU-bound phase instead of the whole server stalling for its full
    // duration — confirmed live that an unyielded pass over a large county can block Node's
    // single event loop, and every other request, for minutes.
    const YIELD_EVERY = 200;
    const results = [];
    for (let i = 0; i < parcels.length; i++) {
      const p = parcels[i];
      results.push({
        parcelfid:     p.parcelfid,
        waterAdjacent: (p.lat != null && p.lng != null) ? isWaterAdjacent(grid, p.lat, p.lng) : false,
      });
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise(r => setImmediate(r));
    }
    const t3 = Date.now();
    console.log(`[water-adjacency] ${parcels.length} parcels, ${counties.length} counties, ${features.length} features, minAcres=${minAcresNum} — fetch ${t1 - t0}ms, grid ${t2 - t1}ms, match ${t3 - t2}ms`);

    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── GET /ratio ───────────────────────────────────────────────────────────────
// Returns average assessment ratio across a list of counties.
// county param: comma-separated list, e.g. "DANE,JEFFERSON,WAUKESHA"
app.get('/ratio', (req, res) => {
  const counties = (req.query.counties || '').split(',').map(c => normStr(c)).filter(Boolean);
  if (counties.length === 0) return res.json({ ratio: 95 });

  const values = [];
  for (const [key, val] of dorRatioMap.entries()) {
    const keyCounty = key.split('|')[1];
    if (counties.includes(keyCounty)) values.push(val);
  }
  const ratio = values.length > 0
    ? parseFloat((values.reduce((s, v) => s + v, 0) / values.length).toFixed(1))
    : 95;
  res.json({ ratio });
});

// ─── Hidden parcel routes ─────────────────────────────────────────────────────
app.get('/hidden', (req, res) => {
  res.json([...hiddenSet]);
});

app.post('/hidden/:parcelfid', (req, res) => {
  hiddenSet.add(req.params.parcelfid);
  saveHidden();
  res.json({ ok: true, count: hiddenSet.size });
});

app.delete('/hidden/:parcelfid', (req, res) => {
  hiddenSet.delete(req.params.parcelfid);
  saveHidden();
  res.json({ ok: true, count: hiddenSet.size });
});

app.delete('/hidden', (req, res) => {
  hiddenSet.clear();
  saveHidden();
  res.json({ ok: true, count: 0 });
});

// ─── fetch helpers ────────────────────────────────────────────────────────────
async function fetchJSON(url, { timeout = 90000 } = {}) {
  const res = await fetch(url, { timeout });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}


async function fetchHTML(url, { headers = {}, ...opts } = {}) {
  const res = await fetch(url, {
    timeout: 15000,
    ...opts,
    headers: { 'User-Agent': SCRAPER_UA, ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// Fetches a page with redirect:manual to harvest session cookies without following
// the redirect chain — used by ASP.NET county portals (e.g. Dodge LIST) that
// require an established session before they will serve parcel detail queries.
async function fetchSessionCookie(url) {
  try {
    const res = await fetch(url, {
      timeout: 10000, redirect: 'manual',
      headers: { 'User-Agent': SCRAPER_UA },
    });
    const raw = res.headers.raw()['set-cookie'] || [];
    return raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  } catch {
    return '';
  }
}

// Runs an array of zero-arg async functions with at most `limit` running simultaneously.
// Safe in JS: `i++` is evaluated atomically before each `await`, so workers never
// claim the same index even though they share the closure variable `i`.
async function runConcurrently(tasks, limit) {
  if (!tasks.length) return;
  let i = 0;
  async function worker() { while (i < tasks.length) await tasks[i++](); }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ─── startup ──────────────────────────────────────────────────────────────────
async function start() {
  initHiddenFile();
  loadAssessorCache();
  loadWaterCache();
  await Promise.all([loadDorRatios(), loadBuildingFootprints()]);
  app.listen(PORT, () => {
    console.log(`Wisconsin Parcel Search → http://localhost:${PORT}`);
  });
}

start();
