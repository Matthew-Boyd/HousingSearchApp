#!/usr/bin/env python3
"""
count_gap_parcels.py — Step 0 of the PropStream evaluation plan (see
fetching_bedroom_etc.md > "PropStream Evaluation Plan").

Quantifies the REAL bedroom-data gap: how many 4+ acre candidate parcels
(matching the same PROPCLASS/acreage filter the app itself uses) fall in the
counties/towns currently missing bedroom data, broken down by county and
municipality (PLACENAME). This is much smaller than "every parcel in every
uncovered town" and is what should size the PropStream trial sample and any
eventual paid tier.

Usage:
    pip install requests
    python count_gap_parcels.py
    python count_gap_parcels.py --min-acres 4 --counties washington green dodge
"""

import argparse
import json
import os
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Install: pip install requests")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(SCRIPT_DIR, 'assessor-cache.json')

SCO_URL = ('https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/'
           'Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

session = requests.Session()
session.headers.update({'User-Agent': UA})

# Counties currently blocked or with significant coverage gaps
# (see "Municipality Coverage Gaps" in fetching_bedroom_etc.md)
GAP_COUNTIES = ['WASHINGTON', 'GREEN', 'DODGE', 'JEFFERSON', 'WAUKESHA', 'ROCK', 'COLUMBIA']


def load_cached_parcelids():
    if not os.path.exists(CACHE_FILE):
        print(f'WARNING: {CACHE_FILE} not found — treating cache as empty '
              '(every candidate parcel will count as a gap).')
        return set()
    with open(CACHE_FILE, 'r') as f:
        data = json.load(f)
    return set(data.keys())


def fetch_candidates(county, min_acres, classes):
    """Page through SCO for one county's 4+ acre PROPCLASS 1/4 parcels.

    PROPCLASS is not always a single code — some counties (confirmed:
    Washington, Waukesha, Green, Dodge, Jefferson, Rock, Columbia) store
    compound comma-separated values like '1,4' or '4,5M'. An exact-match
    `IN (...)` filter silently drops those, undercounting rural parcels
    that mix residential/ag-forest with other uses. Match each class as a
    comma-delimited component instead of requiring an exact field value.
    """
    acres_expr = 'COALESCE(GISACRES, ASSDACRES, DEEDACRES)'
    class_conds = []
    for c in classes:
        class_conds += [f"PROPCLASS='{c}'", f"PROPCLASS LIKE '{c},%'",
                         f"PROPCLASS LIKE '%,{c}'", f"PROPCLASS LIKE '%,{c},%'"]
    where = (f"CONAME='{county}' AND {acres_expr} >= {min_acres} "
             f"AND ({' OR '.join(class_conds)})")

    records = []
    offset = 0
    page = 0
    while True:
        params = {
            'where': where,
            'outFields': 'PARCELID,PLACENAME,CONAME',
            'returnGeometry': 'false',
            'f': 'json',
            'resultRecordCount': '2000',
            'resultOffset': str(offset),
        }
        try:
            r = session.get(SCO_URL, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  Error on page {page+1} for {county}: {e}')
            break

        feats = data.get('features', [])
        if not feats:
            break

        records.extend(f['attributes'] for f in feats)
        page += 1
        print(f'  {county}: page {page}, {len(feats)} records, running total {len(records)}')

        if len(feats) < 2000:
            break
        offset += 2000
        time.sleep(0.2)

    return records


def main():
    parser = argparse.ArgumentParser(
        description='Count 4+ acre candidate parcels missing bedroom data, by county/town.')
    parser.add_argument('--min-acres', type=float, default=4,
                         help='Minimum acreage threshold (default: 4, matching the app default)')
    parser.add_argument('--classes', nargs='*', default=['1', '4'],
                         help='PROPCLASS codes to include (default: 1 4, matching app defaults)')
    parser.add_argument('--counties', nargs='*', default=GAP_COUNTIES,
                         help='Counties to scan (default: all known gap counties)')
    args = parser.parse_args()

    cached = load_cached_parcelids()
    print(f'Loaded {len(cached)} cached PARCELIDs from {CACHE_FILE}\n')

    county_totals = {}
    town_totals = {}  # (county, placename) -> {'total': N, 'gap': N}

    for county in args.counties:
        county = county.upper()
        print(f'--- Scanning {county} County (>= {args.min_acres} acres, PROPCLASS {args.classes}) ---')
        records = fetch_candidates(county, args.min_acres, args.classes)

        total = len(records)
        gap = 0
        for rec in records:
            pid = str(rec.get('PARCELID', '') or '')
            place = rec.get('PLACENAME', '') or '(unknown)'
            key = (county, place)
            town_totals.setdefault(key, {'total': 0, 'gap': 0})
            town_totals[key]['total'] += 1
            if pid not in cached:
                gap += 1
                town_totals[key]['gap'] += 1

        county_totals[county] = {'total': total, 'gap': gap}
        print(f'  {county}: {total} candidates, {gap} missing bedroom data\n')

    print('\n=== Summary by county ===')
    grand_total = grand_gap = 0
    for county, v in county_totals.items():
        print(f'  {county:12s}  candidates={v["total"]:6d}  missing_bedrooms={v["gap"]:6d}')
        grand_total += v['total']
        grand_gap += v['gap']
    print(f'  {"TOTAL":12s}  candidates={grand_total:6d}  missing_bedrooms={grand_gap:6d}')

    print('\n=== Breakdown by municipality (gap > 0, sorted by gap size) ===')
    rows = [(k, v) for k, v in town_totals.items() if v['gap'] > 0]
    rows.sort(key=lambda kv: -kv[1]['gap'])
    for (county, place), v in rows:
        print(f'  {county:12s} {place:30s}  candidates={v["total"]:5d}  missing_bedrooms={v["gap"]:5d}')

    print(f'\nThis {grand_gap}-parcel total (not the full municipality parcel counts) is the '
          'real PropStream trial/paid-tier sizing target. See "PropStream Evaluation Plan" '
          'in fetching_bedroom_etc.md, Step 2, for how to allocate the 50-lead trial sample '
          'against this breakdown.')


if __name__ == '__main__':
    main()
