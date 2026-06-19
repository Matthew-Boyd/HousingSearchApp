'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const ExcelJS  = require('exceljs');
const fetch    = require('node-fetch');
const cheerio  = require('cheerio');

const app  = express();
const PORT = 3000;

const HIDDEN_FILE    = path.join(__dirname, 'hidden.json');
const BUILDINGS_FILE = path.join(__dirname, 'buildings.geojson');
const ASSESSOR_CACHE_FILE = path.join(__dirname, 'assessor-cache.json');

// In-memory assessor cache. Key: PARCELID. Value: { bedrooms, sqft, yearBuilt, cachedAt }
const assessorCache = new Map();

// Spatial grid cell size (degrees). 0.05° ≈ 3.5 km lat / 4.3 km lng at 43°N.
const CELL = 0.05;

// Bounding box enclosing all 9 target counties with a small margin.
const BLDG_BBOX = { minLat: 42.2, maxLat: 44.0, minLng: -90.3, maxLng: -87.9 };

// Grid populated at startup from buildings.geojson.
// Key: "rowIndex|colIndex"  Value: [{lat, lng}, …]
const buildingGrid = new Map();

// Browser-like User-Agent for county assessor scraping.
const SCRAPER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SCO_URL           = 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels/FeatureServer/0/query';
const FEMA_URL          = 'https://services.arcgis.com/2gdL2gxYNFY2TOUb/arcgis/rest/services/FEMA_National_Flood_Hazard_Layer/FeatureServer/0/query';
const NWI_URL           = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
const DOR_URL           = 'https://www.revenue.wi.gov/SLFReportscotvc/2025sumagg.xlsx';
// NHD layer indices may need verification at runtime against the service's layerIds list.
const NHD_WATERBODY_URL = 'https://services.nationalmap.gov/arcgis/rest/services/nhd/MapServer/8/query';
const NHD_FLOWLINE_URL  = 'https://services.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query';

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
// Filters to the 9-county bounding box and indexes centroids into buildingGrid.
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
// Building data comes from two public APIs, depending on municipality:
//
//   AccurateAssessor (Prolorem Dataverse): towns Albion, Berry, Blooming Grove, Cottage Grove,
//     Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant Springs, Primrose, + villages.
//     Has bedrooms, sqft, year built.
//
//   City of Madison ArcGIS MapServer: City of Madison only.
//     Has bedrooms, sqft, year built.
//
//   Other municipalities (York, Springdale, Bristol, Westport, …): no source available yet.
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

  // Municipalities not covered by either source (York, Springdale, Bristol, Westport, …).
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
};

// ─── GET /water-query ────────────────────────────────────────────────────────
// Queries USGS NHD for waterbodies and flowlines in the given bbox.
// Browser passes geometry/geometryType/spatialRel/inSR params; proxy adds outSR/f.
// Returns a GeoJSON FeatureCollection merging both layers.
// Note: NHD layer indices 6 (flowlines) and 8 (waterbodies) should be verified
// against the live service at https://services.nationalmap.gov/arcgis/rest/services/nhd/MapServer
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
async function fetchJSON(url) {
  const res = await fetch(url, { timeout: 90000 });
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
  await Promise.all([loadDorRatios(), loadBuildingFootprints()]);
  app.listen(PORT, () => {
    console.log(`Wisconsin Parcel Search → http://localhost:${PORT}`);
  });
}

start();
