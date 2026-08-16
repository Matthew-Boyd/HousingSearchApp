'use strict';
/**
 * fetch_racine_camacloud.js — bulk-fetch building data for Racine County's
 * one CAMA Cloud municipality (Village of Wind Point) and merge into
 * assessor-cache.json.
 *
 * Racine County is NOT in AccurateAssessor, and its Ascent LRS portal
 * (ascent.racinecounty.gov) is tax-administration only (no CAMA fields) — the
 * same dead end confirmed for Green/Columbia/Walworth/Washington. The only
 * building-data source found is CAMA Cloud (camacloudtech.com), which lists
 * Racine as county id 11 but only has data loaded for one municipality:
 * Village of Wind Point (muni id 1186, ~851 assessments).
 *
 * Racine's CAMA Cloud taxKeyNumber matches the SCO PARCELID exactly once
 * dashes are stripped, e.g. "192-04-23-21-001-000" -> "192042321001000"
 * (verified directly against the SCO ArcGIS layer).
 *
 * Usage:
 *   node fetch_racine_camacloud.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CACHE_FILE = path.join(__dirname, 'assessor-cache.json');

const RACINE_COUNTY_ID = 11;
const TAX_YEAR = 2025;
// NOTE: networkidle + concurrency>1 caused near-total timeouts in practice (only
// 19/851 succeeded) — CAMA Cloud appears to rate-limit/never-idle under concurrent
// navigation. 'load' + serial navigation is slower but reliable.
const CONCURRENCY = 1;

// Server Action IDs re-extracted 2026-08-14 (Next.js re-hashes these on every
// deploy — see fetching_bedroom_etc.md's CAMA Cloud section for how to refresh).
const A_MUNIS = '600d5b11deb80767f90baba9a38a053277076cb213'; // getCountyMunicipalities
const A_ASMTS = '70a08497e34fecc1b2e85b6393f86335091ebed9b5'; // getCountyMuniAsmts

function camaParseRsc(text) {
  const parsed = {};
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^(\w+):(.+)$/s);
    if (m) { try { parsed[m[1]] = JSON.parse(m[2]); } catch {} }
  }
  return parsed;
}

async function callAction(pg, actionId, args) {
  return pg.evaluate(async ({ actionId, args }) => {
    const r = await fetch('https://camacloudtech.com/search', {
      method: 'POST',
      headers: { 'Next-Action': actionId, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(args),
      credentials: 'include',
    });
    return { status: r.status, text: await r.text() };
  }, { actionId, args });
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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const bootPage = await ctx.newPage();
  await bootPage.goto('https://camacloudtech.com/search', { waitUntil: 'networkidle', timeout: 30000 });

  console.log('[Racine/CAMA] Fetching municipality list...');
  const munisRes = await callAction(bootPage, A_MUNIS, [RACINE_COUNTY_ID, TAX_YEAR]);
  const munisParsed = camaParseRsc(munisRes.text);
  const munis = Object.values(munisParsed).find(v => Array.isArray(v) && v.length > 0 && v[0]?.id);
  if (!munis) throw new Error('getCountyMunicipalities returned no data for Racine');
  console.log(`[Racine/CAMA] ${munis.length} municipalities: ${munis.map(m => m.name).join(', ')}`);

  const allResults = {};
  let processed = 0;

  for (const muni of munis) {
    console.log(`[Racine/CAMA] Fetching assessments for ${muni.name}...`);
    const asmtsRes = await callAction(bootPage, A_ASMTS, [RACINE_COUNTY_ID, muni.id, TAX_YEAR]);
    const asmtsParsed = camaParseRsc(asmtsRes.text);
    const asmts = Object.values(asmtsParsed).find(v => Array.isArray(v) && v.length > 0);
    if (!asmts) {
      console.log(`  No assessments found for ${muni.name}, skipping.`);
      continue;
    }
    console.log(`  ${asmts.length} assessments in ${muni.name}`);

    const queue = asmts.slice();
    const pages = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => ctx.newPage())
    );

    async function worker(pg) {
      while (queue.length) {
        const asmt = queue.pop();
        const pin = (asmt.taxKeyNumber || '').replace(/-/g, '');
        if (!/^\d{15}$/.test(pin)) continue;
        try {
          await pg.goto(`https://camacloudtech.com/search/asmt/${asmt.id}`, {
            waitUntil: 'load', timeout: 20000,
          });
          // Content renders client-side after `load` fires ("Loading..." placeholder
          // first) — wait for the actual assessment data. NOTE: the page's boilerplate
          // disclaimer footer ("...errors, omissions...") is present even during the
          // "Loading..." state, so a naive /Error/i check resolves immediately without
          // waiting for real content — match on "Assessment Year" specifically instead.
          await pg.waitForFunction(
            () => /Assessment Year/i.test(document.body.innerText),
            { timeout: 15000 }
          ).catch(() => {});
          const text = await pg.evaluate(() => document.body.innerText);
          const result = parseAsmtText(text);
          if (result.bedrooms != null || result.sqft != null || result.yearBuilt != null) {
            allResults[pin] = { ...result, cachedAt: Date.now() };
          }
        } catch (e) {
          console.warn(`  [error] asmt ${asmt.id} (${pin}): ${e.message}`);
        }
        await new Promise(res => setTimeout(res, 200));
        processed++;
        if (processed % 100 === 0) {
          console.log(`  [progress] ${processed} processed, ${Object.keys(allResults).length} matched`);
        }
      }
    }

    await Promise.all(pages.map(worker));
    await Promise.all(pages.map(pg => pg.close()));
  }

  await browser.close();

  console.log(`[Racine/CAMA] Done: ${Object.keys(allResults).length} parcels with data`);

  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    console.log(`[cache] Loaded ${Object.keys(cache).length} existing entries`);
  }
  const before = Object.keys(cache).length;
  Object.assign(cache, allResults);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`[cache] Saved ${Object.keys(cache).length} total entries ` +
              `(${Object.keys(allResults).length} from Racine, ${Object.keys(cache).length - before} net new) -> ${CACHE_FILE}`);

  const beds = Object.values(allResults).filter(v => v.bedrooms != null).length;
  console.log(`\nSummary: ${Object.keys(allResults).length} Racine parcels cached, ${beds} with a bedroom count`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
