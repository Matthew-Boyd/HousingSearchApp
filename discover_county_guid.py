#!/usr/bin/env python3
"""
discover_county_guid.py — Scan AccurateAssessor for a given WI county's records.

Strategy: query AA without a county filter, requesting the county display name
alongside each record. Scan through pages until we either find a matching
county entry or exhaust the dataset.

Also tries targeted city-name filters for the county's municipalities, if given.

Usage:
    python discover_county_guid.py "Washington" --cities "West Bend" Hartford Germantown Slinger Jackson Kewaskum
    python discover_county_guid.py "Rock" --max-pages 60
"""

import argparse
import sys
import time

try:
    import requests
except ImportError:
    sys.exit("Install: pip install requests")

AA_BASE = 'https://accurateassessor.powerappsportals.com/_api/acc_realestates'
AA_HEADERS = {
    'OData-MaxVersion': '4.0',
    'OData-Version':    '4.0',
    'Accept':           'application/json',
    'Prefer':           'odata.maxpagesize=500',
}

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

session = requests.Session()
session.headers.update({'User-Agent': UA})


def try_city_filter(city):
    """Query AA filtering by physical city name — returns unique county GUIDs + names seen."""
    print(f'\n--- Searching AA for city: {city!r} ---')
    params = {
        '$filter': f"acc_physicalcity eq '{city}'",
        '$select': 'acc_parcelumber,acc_physicalcity,acc_physicalstate',
        '$expand': 'acc_county_acc_realestate($select=acc_name)',
    }
    # Also request the formatted value for the county lookup
    params['$select'] += ',_acc_county_value'

    # Add county formatted value via annotation
    headers = dict(AA_HEADERS)
    headers['Prefer'] += ',odata.include-annotations="OData.Community.Display.V1.FormattedValue"'

    counties_seen = {}
    page = 0
    next_url = None
    total = 0

    while True:
        try:
            if next_url:
                r = session.get(next_url, headers=headers, timeout=30)
            else:
                r = session.get(AA_BASE, params=params, headers=headers, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  Error on page {page+1}: {e}')
            break

        recs = data.get('value', [])
        if not recs:
            print(f'  No records returned.')
            break

        for rec in recs:
            guid = rec.get('_acc_county_value', '')
            name = rec.get('_acc_county_value@OData.Community.Display.V1.FormattedValue', '')
            state = rec.get('acc_physicalstate', '')
            if guid not in counties_seen:
                counties_seen[guid] = {'name': name, 'state': state, 'count': 0}
            counties_seen[guid]['count'] += 1
        total += len(recs)
        page += 1

        next_url = data.get('@odata.nextLink')
        print(f'  Page {page}: {len(recs)} records, total={total}, counties seen: {list(counties_seen.keys())}')

        if not next_url:
            break
        time.sleep(0.3)

    print(f'  Result: {total} total records for city={city!r}')
    for guid, info in counties_seen.items():
        print(f'    GUID={guid!r}  name={info["name"]!r}  state={info["state"]!r}  count={info["count"]}')

    return counties_seen


def scan_all_counties(target_county, max_pages=30):
    """Page through AA without a county filter and collect all distinct county GUIDs."""
    print('\n--- Scanning all AA records for county GUIDs (up to {} pages) ---'.format(max_pages))
    headers = dict(AA_HEADERS)
    headers['Prefer'] += ',odata.include-annotations="OData.Community.Display.V1.FormattedValue"'

    params = {
        '$select': '_acc_county_value,acc_physicalstate',
        '$filter': 'statecode eq 0',
    }

    counties = {}
    next_url = None
    page = 0
    total = 0

    while page < max_pages:
        try:
            if next_url:
                r = session.get(next_url, headers=headers, timeout=30)
            else:
                r = session.get(AA_BASE, params=params, headers=headers, timeout=30)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'  Error on page {page+1}: {e}')
            break

        recs = data.get('value', [])
        if not recs:
            break

        for rec in recs:
            guid = rec.get('_acc_county_value', '') or ''
            name = rec.get('_acc_county_value@OData.Community.Display.V1.FormattedValue', '') or ''
            state = rec.get('acc_physicalstate', '') or ''
            if guid and guid not in counties:
                counties[guid] = {'name': name, 'state': state}
        total += len(recs)
        page += 1

        next_url = data.get('@odata.nextLink')
        wi_counties = {g: v for g, v in counties.items() if 'WI' in v.get('state', '').upper() or v.get('name')}
        print(f'  Page {page}: {len(recs)} recs | {len(counties)} distinct county GUIDs | WI candidates: {len(wi_counties)}')

        # Stop early if we've found the target county
        target_found = any(target_county.lower() in v['name'].lower() for v in counties.values())
        if target_found:
            print(f'  *** FOUND {target_county.upper()} COUNTY ***')
            break

        if not next_url:
            break
        time.sleep(0.2)

    print(f'\nAll distinct county GUIDs found across {total} records ({page} pages):')
    for guid, info in sorted(counties.items(), key=lambda x: x[1]['name']):
        print(f'  {guid!r:42s}  {info["name"]!r}  state={info["state"]!r}')

    return counties


def main():
    parser = argparse.ArgumentParser(
        description="Discover whether a WI county (and its municipalities) exist in AccurateAssessor, and find its GUID.")
    parser.add_argument('county', help='County name to search for, e.g. "Rock"')
    parser.add_argument('--cities', nargs='*', default=[],
                         help='Municipality names to try as targeted city filters, e.g. --cities "Beloit" Janesville')
    parser.add_argument('--max-pages', type=int, default=40,
                         help='Max pages to scan in the broad county sweep (default: 40)')
    args = parser.parse_args()

    county = args.county

    # 1. Try targeted city searches for the county's municipalities, if given
    all_found = {}
    if args.cities:
        for city in args.cities:
            result = try_city_filter(city)
            all_found.update(result)
            time.sleep(1)

        print('\n\n=== Summary of city-filter results ===')
        if all_found:
            for guid, info in all_found.items():
                marker = f' <-- {county.upper()}?' if county.lower() in info.get('name', '').lower() else ''
                print(f'  GUID={guid!r}  name={info["name"]!r}  state={info["state"]!r}{marker}')
        else:
            print(f'  No AA records found for any {county} County city.')
    else:
        print(f'\n(No --cities given; skipping targeted city-filter search.)')

    # 2. Broad scan to see all county GUIDs present in AA
    all_counties = scan_all_counties(county, max_pages=args.max_pages)

    matches = {g: v for g, v in all_counties.items() if county.lower() in v['name'].lower()}
    if matches:
        print(f'\n*** {county} County IS in AccurateAssessor! ***')
        for guid, info in matches.items():
            print(f'  GUID: {guid!r}')
            print(f'  Name: {info["name"]!r}')
    else:
        print(f'\n*** {county} County NOT found in AccurateAssessor. ***')


if __name__ == '__main__':
    main()
