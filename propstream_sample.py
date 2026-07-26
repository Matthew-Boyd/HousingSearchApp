#!/usr/bin/env python3
"""
propstream_sample.py — Step 2 of the PropStream evaluation plan (see
fetching_bedroom_etc.md > "PropStream Evaluation Plan").

Builds an address-level sample list spread across ALL 9 target counties, so
the PropStream trial can be used to determine WHICH counties PropStream has
bedroom data for, not just whether one or two do. Every candidate:
  - is >= min-acres (default 4, matching the app's default filter)
  - matches the app's PROPCLASS filter (default classes 1/4, compound-value
    aware — see count_gap_parcels.py / index.html for why this matters)
  - is currently missing bedroom data in assessor-cache.json
  - has a non-null SITEADRESS (needed to search PropStream by address)

Within each county, the sample is spread round-robin across distinct
municipalities (largest-gap towns first) rather than concentrated in one
town, since CAMA data source quality can vary by municipality even within
a county.

Usage:
    pip install requests
    python propstream_sample.py
    python propstream_sample.py --sample-size 50
    python propstream_sample.py --counties dane walworth washington
"""

import argparse
import csv
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
OUT_FILE   = os.path.join(SCRIPT_DIR, 'propstream_sample.csv')

SCO_URL = ('https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/'
           'Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query')

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

session = requests.Session()
session.headers.update({'User-Agent': UA})

# All 9 target counties (matches TARGET_COUNTIES in index.html / design.md),
# not just the counties previously flagged as "gap" counties — Dane and
# Walworth both have partially-uncovered municipalities too.
TARGET_COUNTIES = ['DANE', 'JEFFERSON', 'WAUKESHA', 'GREEN', 'ROCK',
                    'WALWORTH', 'COLUMBIA', 'DODGE', 'WASHINGTON']


def load_cached_parcelids():
    if not os.path.exists(CACHE_FILE):
        print(f'WARNING: {CACHE_FILE} not found — treating cache as empty.')
        return set()
    with open(CACHE_FILE, 'r') as f:
        data = json.load(f)
    return set(data.keys())


def fetch_candidates(county, min_acres, classes):
    """Page through SCO for one county's 4+ acre qualifying-class parcels,
    with address fields included for the PropStream lookup.

    See count_gap_parcels.py for why PROPCLASS needs component matching
    rather than exact IN(...) matching.
    """
    acres_expr = 'COALESCE(GISACRES, ASSDACRES, DEEDACRES)'
    class_conds = []
    for c in classes:
        class_conds += [f"PROPCLASS='{c}'", f"PROPCLASS LIKE '{c},%'",
                         f"PROPCLASS LIKE '%,{c}'", f"PROPCLASS LIKE '%,{c},%'"]
    where = (f"CONAME='{county}' AND {acres_expr} >= {min_acres} "
             f"AND ({' OR '.join(class_conds)}) AND SITEADRESS IS NOT NULL")

    records = []
    offset = 0
    page = 0
    while True:
        params = {
            'where': where,
            'outFields': 'PARCELID,PLACENAME,CONAME,SITEADRESS,PROPCLASS,ESTFMKVALUE',
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
        if len(feats) < 2000:
            break
        offset += 2000
        time.sleep(0.2)

    return records


def select_round_robin(records_by_town, quota):
    """Cycle through municipalities picking one record at a time, so the
    sample spreads across towns instead of exhausting the biggest one first."""
    towns = sorted(records_by_town.keys(), key=lambda t: -len(records_by_town[t]))
    town_iters = {t: iter(records_by_town[t]) for t in towns}
    selected = []
    while len(selected) < quota and town_iters:
        for t in list(town_iters.keys()):
            if len(selected) >= quota:
                break
            try:
                selected.append(next(town_iters[t]))
            except StopIteration:
                del town_iters[t]
    return selected


def main():
    parser = argparse.ArgumentParser(
        description='Build an address-level PropStream trial sample spread across all target counties.')
    parser.add_argument('--min-acres', type=float, default=4)
    parser.add_argument('--classes', nargs='*', default=['1', '4'])
    parser.add_argument('--counties', nargs='*', default=TARGET_COUNTIES)
    parser.add_argument('--sample-size', type=int, default=50,
                         help='Total addresses to select across all counties (default: 50, matching the trial lead cap)')
    args = parser.parse_args()
    counties = [c.upper() for c in args.counties]

    cached = load_cached_parcelids()
    print(f'Loaded {len(cached)} cached PARCELIDs from {CACHE_FILE}\n')

    per_county_quota = args.sample_size // len(counties)
    remainder = args.sample_size % len(counties)

    all_selected = []
    county_stats = {}

    for i, county in enumerate(counties):
        print(f'--- Scanning {county} County (>= {args.min_acres} acres, classes {args.classes}) ---')
        records = fetch_candidates(county, args.min_acres, args.classes)

        by_town = {}
        for rec in records:
            pid = str(rec.get('PARCELID', '') or '')
            if pid in cached:
                continue
            place = rec.get('PLACENAME', '') or '(unknown)'
            by_town.setdefault(place, []).append(rec)

        gap_total = sum(len(v) for v in by_town.values())
        quota = per_county_quota + (1 if i < remainder else 0)
        selected = select_round_robin(by_town, quota)

        for rec in selected:
            all_selected.append({
                'county': county,
                'municipality': rec.get('PLACENAME', ''),
                'parcelid': rec.get('PARCELID', ''),
                'address': rec.get('SITEADRESS', ''),
                'propclass': rec.get('PROPCLASS', ''),
                'est_fmv': rec.get('ESTFMKVALUE', ''),
            })

        county_stats[county] = {
            'gap_total': gap_total,
            'towns_with_gap': len(by_town),
            'selected': len(selected),
        }
        print(f'  {county}: {gap_total} candidates missing bedroom data across {len(by_town)} municipalities; selected {len(selected)}\n')

    with open(OUT_FILE, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['county', 'municipality', 'parcelid', 'address', 'propclass', 'est_fmv'])
        writer.writeheader()
        writer.writerows(all_selected)

    print(f'\n=== Sample summary (target {args.sample_size}, got {len(all_selected)}) ===')
    for county, v in county_stats.items():
        print(f'  {county:12s}  gap_total={v["gap_total"]:6d}  towns={v["towns_with_gap"]:3d}  selected={v["selected"]:3d}')

    print(f'\nWrote {len(all_selected)} addresses to {OUT_FILE}')
    print('Next: Step 3 of the PropStream Evaluation Plan — for each address, check the '
          'PropStream property detail page (before spending export credits) and record '
          'whether bedrooms/sqft/year built are populated, per county.')


if __name__ == '__main__':
    main()
