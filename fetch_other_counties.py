#!/usr/bin/env python3
"""
fetch_other_counties.py — bulk-fetch building data for 5 target counties
and merge into assessor-cache.json.

Counties covered:
  - Green    (AccurateAssessor): remove spaces + dots from parcel# → 13-digit SCO PARCELID
  - Dodge    (AccurateAssessor): remove dashes from parcel#       → 14-digit SCO PARCELID
  - Rock     (AccurateAssessor): parcel# matches SCO directly
  - Walworth (AccurateAssessor): parcel# matches SCO directly
  - Columbia (AccurateAssessor): address-join with SCO to resolve 7-digit SCO PARCELID

Output: assessor-cache.json (merged with existing entries).

Usage:
    pip install requests
    python fetch_other_counties.py
"""

import json
import os
import re
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Install: pip install requests")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE  = os.path.join(SCRIPT_DIR, 'assessor-cache.json')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

session = requests.Session()
session.headers.update({'User-Agent': UA})

AA_BASE    = 'https://accurateassessor.powerappsportals.com/_api/acc_realestates'
AA_HEADERS = {
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    'Accept':           'application/json',
    'Prefer':           'odata.maxpagesize=500',
}
AA_EXPAND  = (
    'acc_acc_realestate_acc_dwelling_RealEstate'
    '($select=acc_bedroomcount,acc_totallivingarea,acc_yearbuilt)'
)

SCO_URL = ('https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/'
           'Wisconsin_Statewide_Parcels/FeatureServer/0/query')


def now_ms():
    return int(time.time() * 1000)


# ── AccurateAssessor bulk fetch ───────────────────────────────────────────────

def fetch_aa_county(county_name, county_guid, convert_pin, validate_pin):
    """Fetch all parcels for one county from AccurateAssessor.
    Returns dict[sco_parcelid -> {bedrooms, sqft, yearBuilt, cachedAt}].
    """
    results   = {}
    skipped   = 0
    next_url  = None
    page      = 0

    print(f'[{county_name}] Fetching from AccurateAssessor...')

    while True:
        try:
            if next_url:
                r = session.get(next_url, headers=AA_HEADERS, timeout=30)
            else:
                params = {
                    '$filter': f"statecode eq 0 and _acc_county_value eq '{county_guid}'",
                    '$select': 'acc_parcelumber,acc_dwellingtotallivingarea',
                    '$expand': AA_EXPAND,
                }
                r = session.get(AA_BASE, params=params, headers=AA_HEADERS, timeout=30)
            r.raise_for_status()
            data = r.json()
        except requests.HTTPError as e:
            body = e.response.text[:300] if e.response is not None else ''
            print(f'  [{county_name}] Page {page+1} HTTP error: {e}\n    {body}')
            break
        except Exception as e:
            print(f'  [{county_name}] Page {page+1} error: {e}')
            break

        recs = data.get('value', [])
        if not recs:
            break

        for rec in recs:
            raw = rec.get('acc_parcelumber', '') or ''
            pin = convert_pin(raw)
            if not validate_pin(pin):
                skipped += 1
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

        page    += 1
        next_url = data.get('@odata.nextLink')
        print(f'  [{county_name}] Page {page}: {len(recs)} records, '
              f'{len(results)} with data, {skipped} skipped')

        if not next_url:
            break
        time.sleep(0.3)

    print(f'[{county_name}] Done: {len(results)} parcels cached, {skipped} skipped\n')
    return results


# ── Columbia County: address-join approach ────────────────────────────────────

def _norm_addr(raw):
    """Normalize an address string for matching: uppercase, no punctuation, collapse spaces."""
    if not raw:
        return ''
    s = raw.upper()
    s = re.sub(r'[^A-Z0-9 ]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def _addr_key(raw):
    """Return (house_number, first_word_of_street) as a rough join key."""
    tokens = _norm_addr(raw).split()
    if len(tokens) >= 2:
        return (tokens[0], tokens[1])
    return (tokens[0], '') if tokens else ('', '')


def fetch_sco_columbia():
    """Download all Columbia County parcels from SCO: returns dict[norm_addr -> parcelid]."""
    addr_map  = {}   # normalized_addr -> PARCELID
    key_map   = {}   # (num, street_word) -> list of (norm_addr, PARCELID) for collision detection
    offset    = 0
    page      = 0
    PAGE_SIZE = 2000

    print('[Columbia/SCO] Fetching Columbia County parcels from Wisconsin SCO...')

    while True:
        params = {
            'where':             "CONAME='COLUMBIA'",
            'outFields':         'PARCELID,SITEADRESS',
            'returnGeometry':    'false',
            'resultOffset':      offset,
            'resultRecordCount': PAGE_SIZE,
            'f':                 'json',
        }
        try:
            r = session.get(SCO_URL, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  [Columbia/SCO] Page {page+1} error: {e}')
            break

        features = data.get('features', [])
        if not features:
            break

        for feat in features:
            a    = feat.get('attributes', {})
            pid  = str(a.get('PARCELID') or '').strip()
            addr = str(a.get('SITEADRESS') or '').strip()
            if pid and addr:
                norm = _norm_addr(addr)
                addr_map[norm] = pid
                key  = _addr_key(addr)
                key_map.setdefault(key, []).append((norm, pid))

        page   += 1
        offset += len(features)
        print(f'  [Columbia/SCO] Page {page}: {len(features)} parcels, {len(addr_map)} total')

        exceeded = data.get('exceededTransferLimit', False)
        if not exceeded and len(features) < PAGE_SIZE:
            break
        time.sleep(0.2)

    print(f'[Columbia/SCO] Done: {len(addr_map)} Columbia County parcels indexed\n')
    return addr_map, key_map


def fetch_columbia(sco_addr_map, sco_key_map):
    """Fetch Columbia County AA parcels, join to SCO PARCELID via address."""
    results  = {}
    no_match = 0
    next_url = None
    page     = 0
    COLUMBIA_GUID = '25a4971a-56b5-ea11-a812-000d3a3be5cf'

    EXPAND = (
        'acc_acc_realestate_acc_dwelling_RealEstate'
        '($select=acc_bedroomcount,acc_totallivingarea,acc_yearbuilt)'
    )
    SELECT = 'acc_parcelumber,acc_physicalstreet1,acc_physicalcity,acc_dwellingtotallivingarea'

    print('[Columbia/AA] Fetching Columbia County parcels from AccurateAssessor...')

    while True:
        try:
            if next_url:
                r = session.get(next_url, headers=AA_HEADERS, timeout=30)
            else:
                params = {
                    '$filter': f"statecode eq 0 and _acc_county_value eq '{COLUMBIA_GUID}'",
                    '$select': SELECT,
                    '$expand': EXPAND,
                }
                r = session.get(AA_BASE, params=params, headers=AA_HEADERS, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  [Columbia/AA] Page {page+1} error: {e}')
            break

        recs = data.get('value', [])
        if not recs:
            break

        for rec in recs:
            # Get building data
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

            if bedrooms is None and sqft is None:
                continue

            # Resolve SCO PARCELID via address
            street = rec.get('acc_physicalstreet1', '') or ''
            city   = rec.get('acc_physicalcity', '') or ''
            if not street:
                no_match += 1
                continue

            norm = _norm_addr(street)
            # Try exact address match first
            sco_pid = sco_addr_map.get(norm)
            if not sco_pid:
                # Try with city appended
                norm2 = _norm_addr(f'{street} {city}')
                sco_pid = sco_addr_map.get(norm2)
            if not sco_pid:
                # Try partial key match (house# + first street word)
                key = _addr_key(street)
                candidates = sco_key_map.get(key, [])
                if len(candidates) == 1:
                    sco_pid = candidates[0][1]
            if not sco_pid:
                no_match += 1
                continue

            results[sco_pid] = {
                'bedrooms':  bedrooms,
                'sqft':      int(sqft) if sqft is not None else None,
                'yearBuilt': year_built,
                'cachedAt':  now_ms(),
            }

        page    += 1
        next_url = data.get('@odata.nextLink')
        print(f'  [Columbia/AA] Page {page}: {len(recs)} records, '
              f'{len(results)} matched, {no_match} unmatched')

        if not next_url:
            break
        time.sleep(0.3)

    print(f'[Columbia/AA] Done: {len(results)} matched, {no_match} unmatched\n')
    return results


# ── Main ─────────────────────────────────────────────────────────────────────

# Parcel conversion functions (AA parcel# -> SCO PARCELID)
def _green_convert(p):
    return re.sub(r'[ .]', '', p)

def _green_valid(p):
    return len(p) == 13 and p.isdigit()

def _dodge_convert(p):
    return p.replace('-', '')

def _dodge_valid(p):
    return len(p) == 14 and p.isdigit()

def _identity(p):
    return p

def _nonempty(p):
    return bool(p)


SIMPLE_COUNTIES = [
    # (display_name, county_guid, convert_fn, validate_fn)
    ('Green',     'fe072b1a-3dfc-ea11-a815-000d3a353d78', _green_convert,  _green_valid),
    ('Dodge',     '90470156-f5c9-eb11-bacc-000d3a5a1c19', _dodge_convert,  _dodge_valid),
    ('Rock',      '06bc1ad7-b3ee-ea11-a817-000d3a353d78', _identity,       _nonempty),
    ('Walworth',  '8676bc1f-b143-eb11-a813-00224803df6d', _identity,       _nonempty),
    # Jefferson: SCO PARCELID keeps dashes (e.g. 022-0613-3522-000)
    ('Jefferson', 'dae12e4f-5518-eb11-a813-000d3a353d78', _identity,       _nonempty),
    # Waukesha: SCO PARCELID is same alpha-numeric code (e.g. SUMT0671061)
    ('Waukesha',  'e96a44ab-9444-eb11-a813-00224803df6d', _identity,       _nonempty),
]


def main():
    cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            print(f'[cache] Loaded {len(cache)} existing entries\n')
        except Exception as e:
            print(f'[cache] Warning: could not load existing cache: {e}\n')

    all_new = {}

    # Which counties to fetch (pass county names on command line to limit)
    only = set(s.lower() for s in sys.argv[1:]) if len(sys.argv) > 1 else None

    # Fetch simple counties
    for name, guid, convert, validate in SIMPLE_COUNTIES:
        if only and name.lower() not in only:
            print(f'[{name}] Skipping (not in filter)')
            continue
        data = fetch_aa_county(name, guid, convert, validate)
        all_new.update(data)

    # Fetch Columbia County with address join
    columbia_data = {}
    if not only or 'columbia' in only:
        sco_addr_map, sco_key_map = fetch_sco_columbia()
        columbia_data = fetch_columbia(sco_addr_map, sco_key_map)
        all_new.update(columbia_data)
    else:
        print('[Columbia] Skipping (not in filter)')

    before = len(cache)
    cache.update(all_new)
    added = len(cache) - before

    print(f'[cache] Writing {len(cache)} total entries '
          f'({len(all_new)} from this run, {added} net new)...')
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, indent=2)
    print(f'[cache] Saved -> {CACHE_FILE}')

    beds_count = sum(1 for e in all_new.values() if e.get('bedrooms') is not None)
    print(f'\nSummary: {len(all_new)} parcels cached this run; '
          f'{beds_count} have bedroom count')
    print(f'  Green:    {sum(1 for k in all_new if len(k)==13 and k.isdigit())} parcels')
    print(f'  Dodge:    {sum(1 for k in all_new if len(k)==14 and k.isdigit())} parcels')
    print(f'  Rock:     {sum(1 for k in all_new if re.match(r"^\d{3} \d", k))} parcels')
    print(f'  Columbia: {len(columbia_data)} parcels (address-matched)')


if __name__ == '__main__':
    main()
