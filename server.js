'use strict';

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const ExcelJS = require('exceljs');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');

const app  = express();
const PORT = 3000;

const HIDDEN_FILE = path.join(__dirname, 'hidden.json');

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
// Accepts:
//   { bbox: [minX,minY,maxX,maxY], parcels: [{parcelfid,lat,lng}, …] }
// Returns:
//   [{parcelfid, nearestDistanceFt, nearestDistanceMi}, …]
// Parcels with no neighbors within the bbox get null distances.
app.post('/neighbor-query', async (req, res) => {
  try {
    const { bbox, parcels } = req.body;
    if (!bbox || !Array.isArray(parcels) || parcels.length === 0) {
      return res.json([]);
    }
    const [minX, minY, maxX, maxY] = bbox;
    const neighbors = await fetchAllNeighborCentroids(minX, minY, maxX, maxY);

    // Spatial grid index: 0.05° cells (~2.5 mi) so we only check the 3×3 surrounding
    // cells for each result parcel instead of comparing against all neighbors.
    const CELL = 0.05;
    const grid  = new Map();
    for (const n of neighbors) {
      const key = `${Math.floor(n.lat / CELL)}|${Math.floor(n.lng / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(n);
    }

    const results = parcels.map(p => {
      let minDist = Infinity;
      const baseR = Math.floor(p.lat / CELL);
      const baseC = Math.floor(p.lng / CELL);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          for (const n of (grid.get(`${baseR + dr}|${baseC + dc}`) || [])) {
            if (n.parcelfid === p.parcelfid) continue;
            const d = haversineMeters(p.lat, p.lng, n.lat, n.lng);
            if (d < minDist) minDist = d;
          }
        }
      }
      if (minDist === Infinity) {
        return { parcelfid: p.parcelfid, nearestDistanceFt: null, nearestDistanceMi: null };
      }
      return {
        parcelfid:           p.parcelfid,
        nearestDistanceFt:   Math.round(minDist * 3.28084),
        nearestDistanceMi:   parseFloat((minDist / 1609.344).toFixed(2))
      };
    });

    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function fetchAllNeighborCentroids(minX, minY, maxX, maxY) {
  // V11 has LATITUDE/LONGITUDE fields — no need for returnCentroid or geometry fetch.
  // Request these fields directly with returnGeometry=false for 32,000 records/page.
  const geometry = JSON.stringify({
    xmin: minX, ymin: minY, xmax: maxX, ymax: maxY,
    spatialReference: { wkid: 4326 }
  });
  const records = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      where:            'IMPVALUE > 0',
      geometry,
      geometryType:     'esriGeometryEnvelope',
      spatialRel:       'esriSpatialRelIntersects',
      inSR:             '4326',
      outFields:        'PARCELID,LATITUDE,LONGITUDE',
      returnGeometry:   'false',
      outSR:            '4326',
      f:                'json',
      resultOffset:      String(offset),
      resultRecordCount: '32000'
    });

    const data = await fetchJSON(`${SCO_URL}?${params}`);
    if (!data.features || data.features.length === 0) break;

    for (const f of data.features) {
      const { PARCELID, LATITUDE, LONGITUDE } = f.attributes;
      if (LATITUDE && LONGITUDE) {
        records.push({ parcelfid: PARCELID, lat: LATITUDE, lng: LONGITUDE });
      }
    }
    if (data.features.length < 32000) break;
    offset += 32000;
  }

  return records;
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
// Fields default to null when the scraper cannot find a value.
app.post('/assessor-query', async (req, res) => {
  const { county, parcels } = req.body;
  if (!county || !Array.isArray(parcels) || parcels.length === 0) {
    return res.json({ results: [] });
  }

  const scraper = COUNTY_SCRAPERS[county.toUpperCase()];
  if (!scraper) {
    return res.json({ results: [], error: `No scraper for county: ${county}` });
  }

  const results = [];
  for (const parcel of parcels) {
    try {
      const data = await scraper(parcel);
      results.push({ parcelfid: parcel.parcelfid, ...data });
    } catch {
      results.push({ parcelfid: parcel.parcelfid, bedrooms: null, sqft: null, yearBuilt: null });
    }
  }
  res.json({ results });
});

// ─── County scrapers ──────────────────────────────────────────────────────────
// Each scraper: async (parcel) => { bedrooms, sqft, yearBuilt }
// Use null for any field the source doesn't provide.
// Throw to indicate a lookup failure (parcel will show null fields in UI).

async function scrapeNotImplemented() {
  throw new Error('Scraper not yet implemented');
}

// Generic Beacon (Schneider Geospatial) scraper. Pass the county-specific AppID.
// Find the AppID by visiting https://beacon.schneidercorp.com and navigating to
// a Wisconsin county — it appears in the URL as ?AppID=XXX.
async function scrapeBeacon(appId, parcel) {
  const url = `https://beacon.schneidercorp.com/Application.aspx`
    + `?AppID=${appId}&LayerID=0&PageTypeID=4`
    + `&KeyValue=${encodeURIComponent(parcel.parcelfid)}`;

  const html = await fetchHTML(url);
  const $    = cheerio.load(html);

  let bedrooms = null, sqft = null, yearBuilt = null;

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const label = $(cells[0]).text().trim().toUpperCase();
    const raw   = $(cells[1]).text().trim();
    const num   = parseInt(raw.replace(/,/g, ''), 10);
    if (/BEDROOM/.test(label))                                      bedrooms  = isNaN(num) ? null : num;
    if (/TOTAL.*AREA|GROSS.*AREA|LIVING.*AREA|SQ.*FT/.test(label)) sqft      = isNaN(num) ? null : num;
    if (/YEAR.*BUILT|^BUILT$/.test(label))                          yearBuilt = isNaN(num) ? null : num;
  });

  return { bedrooms, sqft, yearBuilt };
}

// TODO: Look up each county's CAMA web interface before implementing.
// For Beacon counties: find the AppID by browsing https://beacon.schneidercorp.com
// and clicking through to a Wisconsin county property detail page.
const COUNTY_SCRAPERS = {
  DANE:       scrapeNotImplemented,  // TODO: check assessor.countyofdane.com or Beacon
  JEFFERSON:  scrapeNotImplemented,  // TODO: check Jefferson County property search
  WAUKESHA:   scrapeNotImplemented,  // TODO: check waukeshacounty.gov property search
  GREEN:      scrapeNotImplemented,  // TODO: may be manual-only (no public web CAMA found)
  ROCK:       scrapeNotImplemented,  // TODO: check Rock County property search
  WALWORTH:   scrapeNotImplemented,  // TODO: check Walworth County assessor portal
  COLUMBIA:   scrapeNotImplemented,  // TODO: check Columbia County property search
  DODGE:      (p) => scrapeBeacon('TODO_DODGE_APPID', p),  // Beacon platform confirmed; replace AppID
  WASHINGTON: scrapeNotImplemented,  // TODO: check Washington County property search
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
  const res = await fetch(url, { timeout: 30000 });
  if (!res.ok) throw new Error(`Upstream HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WI-Parcel-Tool/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ─── startup ──────────────────────────────────────────────────────────────────
async function start() {
  initHiddenFile();
  await loadDorRatios();
  app.listen(PORT, () => {
    console.log(`Wisconsin Parcel Search → http://localhost:${PORT}`);
  });
}

start();
