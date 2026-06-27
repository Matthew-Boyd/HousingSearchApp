#!/usr/bin/env python3
"""
fetch_dane_assessor.py — bulk-fetch Dane County building data and write assessor-cache.json.

Sources:
  1. AccurateAssessor (Prolorem Dataverse) — covers towns: Albion, Berry, Blooming Grove,
     Cottage Grove, Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant Springs,
     Primrose, and several villages. Has bedrooms, sqft, year built.

  2. City of Madison ArcGIS MapServer — covers City of Madison.
     Has bedrooms, sqft, year built.

Output: assessor-cache.json (merged with existing entries from other counties).

Usage:
    pip install requests
    python fetch_dane_assessor.py
"""

import json
import os
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Install: pip install requests")

SCRIPT_DIR       = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE       = os.path.join(SCRIPT_DIR, 'assessor-cache.json')
DANE_COUNTY_GUID = 'd8c67ee3-3692-eb11-b1ac-000d3a58b1bb'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

session = requests.Session()
session.headers.update({'User-Agent': UA})


def now_ms():
    return int(time.time() * 1000)


# ── AccurateAssessor (Prolorem Dataverse) ────────────────────────────────────

AA_BASE    = 'https://accurateassessor.powerappsportals.com/_api/acc_realestates'
AA_PAGE    = 500   # records per page via Prefer header (Dataverse ignores $skip; pagination uses @odata.nextLink)
AA_HEADERS = {
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    'Accept':           'application/json',
    'Prefer':           f'odata.maxpagesize={AA_PAGE}',
}
AA_FILTER  = (
    f"statecode eq 0"
    f" and _acc_county_value eq '{DANE_COUNTY_GUID}'"
)
AA_EXPAND  = (
    'acc_acc_realestate_acc_dwelling_RealEstate'
    '($select=acc_bedroomcount,acc_totallivingarea,acc_yearbuilt)'
)
AA_SELECT  = 'acc_parcelumber,acc_dwellingtotallivingarea,acc_dwellingrecordcount'


def fetch_accurateassessor():
    """Fetch all Dane County parcels from AccurateAssessor. Returns dict[pin12 -> entry]."""
    results  = {}
    # Dataverse does not support $skip — pagination uses @odata.nextLink only.
    next_url = None
    page     = 0

    print('[AA] Fetching AccurateAssessor (Dane County)...')

    while True:
        try:
            if next_url:
                r = session.get(next_url, headers=AA_HEADERS, timeout=30)
            else:
                params = {
                    '$filter': AA_FILTER,
                    '$expand': AA_EXPAND,
                    '$select': AA_SELECT,
                }
                r = session.get(AA_BASE, params=params, headers=AA_HEADERS, timeout=30)
            r.raise_for_status()
            data = r.json()
        except requests.HTTPError as e:
            body = e.response.text[:500] if e.response is not None else ''
            print(f'  [AA] Page {page+1} HTTP error: {e}\n       Response: {body}')
            break
        except Exception as e:
            print(f'  [AA] Page {page+1} error: {e}')
            break

        recs = data.get('value', [])
        if not recs:
            break

        for rec in recs:
            raw = rec.get('acc_parcelumber', '') or ''
            # Format is "MMM/XXXXXXXXXXXX" — take everything after the last '/'
            pin = raw.split('/')[-1].replace('-', '').strip()
            if len(pin) != 12 or not pin.isdigit():
                continue

            dwellings  = rec.get('acc_acc_realestate_acc_dwelling_RealEstate') or []
            bedrooms   = None
            sqft       = None
            year_built = None
            for d in dwellings:
                if d.get('acc_bedroomcount') is not None:
                    bedrooms = d['acc_bedroomcount']
                if d.get('acc_totallivingarea') is not None:
                    sqft = d['acc_totallivingarea']
                if d.get('acc_yearbuilt'):
                    year_built = int(str(d['acc_yearbuilt'])[:4])

            if sqft is None and rec.get('acc_dwellingtotallivingarea') is not None:
                sqft = rec['acc_dwellingtotallivingarea']

            if bedrooms is not None or sqft is not None:
                results[pin] = {
                    'bedrooms':  bedrooms,
                    'sqft':      int(sqft) if sqft is not None else None,
                    'yearBuilt': year_built,
                    'cachedAt':  now_ms(),
                }

        page += 1
        print(f'  [AA] Page {page}: {len(recs)} records fetched, {len(results)} with data so far')

        # Follow @odata.nextLink for subsequent pages; stop when it's absent.
        next_url = data.get('@odata.nextLink')
        if not next_url:
            break   # last page

        time.sleep(0.4)

    print(f'[AA] Done: {len(results)} parcels with building data\n')
    return results


# ── City of Madison ArcGIS ───────────────────────────────────────────────────

MAD_BASE = ('https://maps.cityofmadison.com/arcgis/rest/services/Public/'
            'Property_Lookup/MapServer/9/query')
MAD_PAGE = 1000


def fetch_madison():
    """Fetch all City of Madison parcels with bedrooms. Returns dict[pin12 -> entry]."""
    results = {}
    offset  = 0
    page    = 0

    print('[Madison] Fetching City of Madison ArcGIS…')

    while True:
        params = {
            'where':             'Bedrooms > 0',
            'outFields':         'Parcel,Bedrooms,TotalLivingArea,YearBuilt',
            'returnGeometry':    'false',
            'resultOffset':      offset,
            'resultRecordCount': MAD_PAGE,
            'f':                 'json',
        }
        try:
            r = session.get(MAD_BASE, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  [Madison] Page {page+1} error: {e}')
            break

        features = data.get('features', [])
        if not features:
            break

        for feat in features:
            a   = feat.get('attributes', {})
            pin = str(a.get('Parcel', '') or '').strip()
            if len(pin) != 12 or not pin.isdigit():
                continue
            bedrooms   = a.get('Bedrooms')
            sqft       = a.get('TotalLivingArea')
            year_built = a.get('YearBuilt')
            if bedrooms is not None or sqft is not None:
                results[pin] = {
                    'bedrooms':  int(bedrooms)   if bedrooms   is not None else None,
                    'sqft':      int(sqft)        if sqft       is not None else None,
                    'yearBuilt': int(year_built)  if year_built is not None else None,
                    'cachedAt':  now_ms(),
                }

        page   += 1
        offset += len(features)
        print(f'  [Madison] Page {page}: {len(features)} features, {len(results)} total so far')

        exceeded = data.get('exceededTransferLimit', False)
        if not exceeded and len(features) < MAD_PAGE:
            break

        time.sleep(0.2)

    print(f'[Madison] Done: {len(results)} parcels with building data\n')
    return results


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Load existing cache (preserve other counties' data)
    cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            print(f'[cache] Loaded {len(cache)} existing entries from {CACHE_FILE}\n')
        except Exception as e:
            print(f'[cache] Warning: could not load existing cache: {e}\n')

    aa_data  = fetch_accurateassessor()
    mad_data = fetch_madison()

    # Merge: load Madison first, then AccurateAssessor (AA wins on conflict since
    # AA has bedrooms for non-Madison municipalities and both rarely overlap).
    before = len(cache)
    merged = {**mad_data, **aa_data}
    cache.update(merged)
    added = len(cache) - before

    print(f'[cache] Writing {len(cache)} total entries '
          f'({len(merged)} Dane County, {added} new)…')
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2)
    print(f'[cache] Saved -> {CACHE_FILE}')

    beds_count = sum(1 for e in merged.values() if e.get('bedrooms') is not None)
    print(f'\nSummary: {len(merged)} Dane County parcels cached; '
          f'{beds_count} have bedroom count')


if __name__ == '__main__':
    main()
