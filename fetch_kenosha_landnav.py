#!/usr/bin/env python3
"""
fetch_kenosha_landnav.py — bulk-fetch building data (bedrooms/sqft/year built)
for Kenosha County from the county's own "Catalis / LandNav" public property
inquiry portal, and merge into assessor-cache.json.

Kenosha County is NOT in AccurateAssessor (confirmed via discover_county_guid.py
broad scan). Its official portal at
    https://pp-kenosha-co-wi-fb.app.landnav.com/
(Catalis Portal, "Guest Sign In") exposes full CAMA building data — including
Bedrooms — for every municipality in the county (not just the 8 municipalities
covered by the CAMA Cloud fallback used for Dane). This is a much better source
than any other county in this project. It is a plain server-rendered ASP.NET
site (no WAF/SPA obstacles like CAMA Cloud) and works with a normal
`requests.Session` — no Playwright needed.

Flow per parcel:
  1. POST /Search/RealEstate/Search/Search  (single Parcel # search) -> PropertyId
  2. GET  /Search/RealEstate/Buildings?propertyId=<id>  -> parse buildingFeaturesTable
     for the first (default-selected) building's Year Built / Bedrooms / Total Area.

Kenosha SCO PARCELID format (e.g. "60-4-119-132-0400") matches the portal's
"Parcel #" field exactly — no conversion needed.

Usage:
    pip install requests
    python fetch_kenosha_landnav.py [--limit N] [--workers N] [--test]
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("Install: pip install requests")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, 'assessor-cache.json')
CHECKPOINT_FILE = os.path.join(SCRIPT_DIR, 'kenosha_landnav_checkpoint.jsonl')

BASE = 'https://pp-kenosha-co-wi-fb.app.landnav.com'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

SCO_URL = ('https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/'
           'Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query')

TAX_YEAR = '2026'

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


def now_ms():
    return int(time.time() * 1000)


def new_guest_session():
    """Log in as guest and return an authenticated requests.Session."""
    s = requests.Session()
    s.headers.update({'User-Agent': UA})
    r = s.get(f'{BASE}/login/', timeout=20)
    r.raise_for_status()
    m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', r.text)
    if not m:
        raise RuntimeError('Could not find antiforgery token on login page')
    token = m.group(1)
    r2 = s.post(f'{BASE}/login/GuestLogin',
                data={'returnUrl': '', '__RequestVerificationToken': token},
                timeout=20)
    r2.raise_for_status()
    # Prime the search page once so the session has a "current search" context.
    s.get(f'{BASE}/Search/RealEstate/Search', timeout=20)
    return s


def search_property_id(s, parcel):
    """Single Parcel # search -> PropertyId, or None if not found."""
    headers = {'X-Requested-With': 'XMLHttpRequest',
               'Referer': f'{BASE}/Search/RealEstate/Search'}
    data = {
        'TaxYearSearchType': '0',
        'MinTaxYear': TAX_YEAR,
        'UserDefinedIdSearchType': '0',
        'MinUserDefinedId': parcel,
    }
    r = s.post(f'{BASE}/Search/RealEstate/Search/Search', data=data,
               headers=headers, timeout=30)
    if r.status_code != 200:
        return None
    try:
        payload = r.json()
    except ValueError:
        return None
    data_obj = payload.get('data') or {}
    if not data_obj:
        return None
    first = data_obj.get('0') or next(iter(data_obj.values()), None)
    if not first:
        return None
    return first.get('PropertyId')


ROW_RE = re.compile(
    r'<tr>\s*<td>\d+</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*<td>([^<]*)</td>\s*</tr>',
    re.S,
)


def fetch_building_features(s, property_id):
    """GET the Buildings tab and parse the default-selected building's features."""
    r = s.get(f'{BASE}/Search/RealEstate/Buildings?propertyId={property_id}', timeout=30)
    if r.status_code != 200:
        return None
    html = r.text
    idx = html.find('id="buildingFeaturesTable"')
    if idx < 0:
        return {'bedrooms': None, 'sqft': None, 'yearBuilt': None}
    table_html = html[idx:idx + 6000]
    bedrooms = sqft = year_built = None
    for label, value, _unit in ROW_RE.findall(table_html):
        label = label.strip()
        value = value.strip()
        if label == 'Bedrooms':
            try:
                bedrooms = int(value)
            except ValueError:
                pass
        elif label == 'Total Area':
            try:
                sqft = int(value.replace(',', ''))
            except ValueError:
                pass
        elif label == 'Year Built':
            try:
                year_built = int(value)
            except ValueError:
                pass
    return {'bedrooms': bedrooms, 'sqft': sqft, 'yearBuilt': year_built}


def fetch_sco_kenosha_parcels():
    """All Kenosha County PARCELIDs with a site address (addressless parcels
    are overwhelmingly vacant land with no dwelling — see project notes)."""
    parcels = []
    offset = 0
    page = 0
    PAGE_SIZE = 2000
    while True:
        params = {
            'where': "CONAME='KENOSHA' AND SITEADRESS IS NOT NULL",
            'outFields': 'PARCELID',
            'returnGeometry': 'false',
            'resultOffset': offset,
            'resultRecordCount': PAGE_SIZE,
            'f': 'json',
        }
        r = requests.get(SCO_URL, params=params, timeout=60)
        r.raise_for_status()
        data = r.json()
        feats = data.get('features', [])
        if not feats:
            break
        for feat in feats:
            pid = str(feat['attributes'].get('PARCELID') or '').strip()
            if pid:
                parcels.append(pid)
        page += 1
        offset += len(feats)
        log(f'[SCO] page {page}: {len(feats)} parcels, {len(parcels)} total')
        if not data.get('exceededTransferLimit', False) and len(feats) < PAGE_SIZE:
            break
        time.sleep(0.15)
    return parcels


# ── Worker ──────────────────────────────────────────────────────────────────

_thread_local = threading.local()


def get_thread_session():
    if not hasattr(_thread_local, 'session'):
        _thread_local.session = new_guest_session()
    return _thread_local.session


def process_parcel(parcel, retry=True):
    try:
        s = get_thread_session()
        pid = search_property_id(s, parcel)
        if pid is None:
            return parcel, None
        feats = fetch_building_features(s, pid)
        if feats is None:
            return parcel, None
        if feats['bedrooms'] is None and feats['sqft'] is None and feats['yearBuilt'] is None:
            return parcel, None
        return parcel, feats
    except (requests.RequestException, RuntimeError) as e:
        if retry:
            try:
                _thread_local.session = new_guest_session()
            except Exception:
                pass
            time.sleep(1.0)
            return process_parcel(parcel, retry=False)
        log(f'  [error] {parcel}: {e}')
        return parcel, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=None, help='Only process first N parcels (testing)')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--test', action='store_true', help='Run a tiny 5-parcel smoke test and exit')
    args = ap.parse_args()

    if args.test:
        test_parcels = ['60-4-119-132-0400', '60-4-119-154-0550', '01-122-01-176-031']
        s = new_guest_session()
        for p in test_parcels:
            pid = search_property_id(s, p)
            log(f'{p} -> propertyId={pid}')
            if pid:
                feats = fetch_building_features(s, pid)
                log(f'  {feats}')
        return

    log('[SCO] Fetching Kenosha County parcel list...')
    parcels = fetch_sco_kenosha_parcels()
    if args.limit:
        parcels = parcels[:args.limit]
    log(f'[SCO] {len(parcels)} parcels to process')

    # Resume support: skip parcels already in the checkpoint file.
    done = set()
    results = {}
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                done.add(rec['parcel'])
                if rec.get('data'):
                    results[rec['parcel']] = rec['data']
        log(f'[checkpoint] Resuming: {len(done)} parcels already processed '
            f'({len(results)} with data)')

    todo = [p for p in parcels if p not in done]
    log(f'[fetch] {len(todo)} parcels remaining')

    ckpt_f = open(CHECKPOINT_FILE, 'a', encoding='utf-8')
    ckpt_lock = threading.Lock()
    processed = 0
    matched = 0
    start = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_parcel, p): p for p in todo}
        for fut in as_completed(futures):
            parcel, feats = fut.result()
            processed += 1
            if feats:
                matched += 1
                results[parcel] = {**feats, 'cachedAt': now_ms()}
            with ckpt_lock:
                ckpt_f.write(json.dumps({'parcel': parcel, 'data': feats}) + '\n')
                if processed % 200 == 0:
                    ckpt_f.flush()
            if processed % 500 == 0:
                elapsed = time.time() - start
                rate = processed / elapsed
                remaining = (len(todo) - processed) / rate if rate > 0 else 0
                log(f'[progress] {processed}/{len(todo)} '
                    f'({matched} matched) — {rate:.1f}/s, '
                    f'~{remaining/60:.0f} min remaining')

    ckpt_f.close()
    log(f'[fetch] Done: {processed} processed, {matched} matched this run')

    # Merge into assessor-cache.json
    cache = {}
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        log(f'[cache] Loaded {len(cache)} existing entries')

    before = len(cache)
    cache.update(results)
    log(f'[cache] Writing {len(cache)} total entries '
        f'({len(results)} from Kenosha, {len(cache) - before} net new)...')
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2)
    log(f'[cache] Saved -> {CACHE_FILE}')

    beds = sum(1 for v in results.values() if v.get('bedrooms') is not None)
    log(f'\nSummary: {len(results)} Kenosha parcels cached, {beds} with a bedroom count')


if __name__ == '__main__':
    main()
