#!/usr/bin/env python3
"""
Access Dane bedroom-data finder v3.

1. Fetches the parcel index page and extracts all navigation links.
2. Tests each nav link for bedroom/sqft/year-built data.
3. Also tries common sub-page URL guesses.
4. Shows label→value pairs for any page that has building characteristics.

~15 requests, 1.0 s apart.

Usage:
    pip install requests beautifulsoup4
    python test_accessdane.py
"""

import re, time, sys

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("Install:  pip install requests beautifulsoup4")

BASE       = "https://accessdane.danecounty.gov"
SAMPLE_PIN = "091236486702"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.5"})

# ── helpers ───────────────────────────────────────────────────────────────────

def get(url, delay=1.0):
    if not url.startswith("http"):
        url = BASE + url
    time.sleep(delay)
    try:
        r = session.get(url, timeout=15, allow_redirects=True)
        return r.status_code, r.text, r.url
    except Exception as e:
        return 0, str(e), url

def has_building_data(html):
    """True only if the page appears to have actual building characteristics."""
    lo = html.lower()
    return any(k in lo for k in ["bedroom", "bdrm", "sq ft", "square feet",
                                   "year built", "yr built", "stories", "bath",
                                   "total rooms", "finished area"])

def parse_label_value_table(html):
    soup = BeautifulSoup(html, "html.parser")
    bedrooms = sqft = year_built = None

    def try_set(raw_label, raw_val):
        nonlocal bedrooms, sqft, year_built
        lbl = re.sub(r'[^A-Z0-9 ]', ' ', raw_label.upper())
        digits = re.sub(r'[^0-9]', '', raw_val)
        if not digits:
            return
        n = int(digits)
        if re.search(r'BEDROOM|BDRM', lbl) and n < 30:
            bedrooms = n
        if re.search(r'SQ ?FT|SQUARE FEET|TOTAL.{1,10}AREA|LIVING.{1,10}AREA|FLOOR.{1,5}AREA', lbl) and n > 100:
            sqft = n
        if re.search(r'YEAR.{1,5}BUILT|YR.{1,5}BUILT|^BUILT$', lbl) and 1800 < n < 2100:
            year_built = n

    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) >= 2:
            try_set(cells[0].get_text(" ", strip=True), cells[-1].get_text(" ", strip=True))
            if len(cells) >= 4:
                try_set(cells[2].get_text(" ", strip=True), cells[3].get_text(" ", strip=True))
    for dt in soup.find_all("dt"):
        dd = dt.find_next_sibling("dd")
        if dd:
            try_set(dt.get_text(" ", strip=True), dd.get_text(" ", strip=True))

    return bedrooms, sqft, year_built

def dump_table_rows(html, max_rows=60):
    soup = BeautifulSoup(html, "html.parser")
    rows_shown = 0
    for row in soup.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) >= 2:
            lbl = cells[0].get_text(" ", strip=True)[:60]
            val = cells[-1].get_text(" ", strip=True)[:60]
            if lbl or val:
                print(f"    {lbl!r:45s} → {val!r}")
                rows_shown += 1
                if rows_shown >= max_rows:
                    print("    ... (truncated)")
                    break

def banner(t):
    print(f"\n{'='*65}\n  {t}\n{'='*65}")


# ── 1. Fetch index page and extract navigation links ─────────────────────────
banner(f"1. Parcel index — extract nav links  (pin={SAMPLE_PIN})")

index_url = f"/Parcel/Index?id={SAMPLE_PIN}"
status, html, final_url = get(index_url)
print(f"  [{status}] {final_url}")

nav_links = []
if status == 200:
    soup = BeautifulSoup(html, "html.parser")

    # Collect all <a> hrefs that look like parcel sub-pages
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True)
        # Only keep links that look like internal parcel navigation
        if re.search(r'/Parcel/|/parcel/', href, re.I) and "?" not in href.split("#")[0] or \
           (href.startswith("/") and SAMPLE_PIN in href):
            print(f"  Nav link: {text!r:25s} → {href}")
            nav_links.append((text, href))

    # Also look for tab links that may use ?id= with a different controller
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = a.get_text(" ", strip=True)
        if SAMPLE_PIN in href and href not in [l[1] for l in nav_links]:
            print(f"  Link with pin: {text!r:20s} → {href}")
            nav_links.append((text, href))

    if not nav_links:
        print("  (no nav links found — printing all <a> hrefs for inspection)")
        for a in soup.find_all("a", href=True)[:40]:
            href = a["href"]
            text = a.get_text(" ", strip=True)
            print(f"    {text!r:30s} → {href}")


# ── 2. Test every discovered nav link ────────────────────────────────────────
banner("2. Test nav links for building characteristics")

found_building_page = None

for text, href in nav_links:
    url = href if href.startswith("http") else BASE + href
    st, body, fu = get(url)
    has_b = has_building_data(body)
    beds, sqft, yr = parse_label_value_table(body) if has_b else (None, None, None)
    print(f"\n  [{st}] {text!r} → {fu}")
    print(f"       has_building_data={has_b}  beds={beds}  sqft={sqft}  yr={yr}")
    if has_b:
        found_building_page = (text, url, body)
        print("       *** BUILDING DATA FOUND ***")


# ── 3. Try common sub-page URL guesses ───────────────────────────────────────
banner("3. Common sub-page guesses")

guesses = [
    f"/Parcel/Building?id={SAMPLE_PIN}",
    f"/Parcel/Buildings?id={SAMPLE_PIN}",
    f"/Parcel/Improvement?id={SAMPLE_PIN}",
    f"/Parcel/Improvements?id={SAMPLE_PIN}",
    f"/Parcel/Structure?id={SAMPLE_PIN}",
    f"/Parcel/Structures?id={SAMPLE_PIN}",
    f"/Parcel/Assessment?id={SAMPLE_PIN}",
    f"/Parcel/Details?id={SAMPLE_PIN}",
    f"/Parcel/Summary?id={SAMPLE_PIN}",
    f"/Parcel/Property?id={SAMPLE_PIN}",
    f"/Parcel/Sketch?id={SAMPLE_PIN}",
    f"/Parcel/Sales?id={SAMPLE_PIN}",
    f"/Parcel/Index/{SAMPLE_PIN}/Building",
    f"/Parcel/Index/{SAMPLE_PIN}/Improvement",
]

for url in guesses:
    st, body, fu = get(url, delay=0.8)
    has_b = has_building_data(body)
    beds, sqft, yr = parse_label_value_table(body) if has_b else (None, None, None)
    print(f"  [{st}] {url}")
    print(f"       has_building_data={has_b}  beds={beds}  sqft={sqft}  yr={yr}")
    if st == 404:
        continue
    if has_b:
        found_building_page = (url, fu, body)
        print("       *** BUILDING DATA FOUND ***")


# ── 4. If we found a building page, dump its rows ────────────────────────────
if found_building_page:
    label, url, body = found_building_page
    banner(f"4. Building page label→value pairs  ({url})")
    dump_table_rows(body)
else:
    banner("4. No building page found yet — showing all unique paths on the index page")
    if status == 200:
        soup = BeautifulSoup(html, "html.parser")
        seen = set()
        for a in soup.find_all("a", href=True):
            h = a["href"]
            if h not in seen:
                seen.add(h)
                print(f"  {a.get_text(' ', strip=True)!r:30s} → {h}")

banner("Done")
