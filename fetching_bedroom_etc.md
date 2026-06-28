# Fetching Bedroom, Sqft & Year Built — County-by-County Notes

This document records how building characteristics (bedrooms, sqft, year built) are sourced and cached for each of the 9 target Wisconsin counties. It is intended to explain the implementation so the scripts can be re-run, extended, or debugged without starting from scratch.

---

## Overall Strategy

Building data is NOT in the Wisconsin SCO statewide parcel layer. It must come from county assessor systems (CAMA — Computer-Assisted Mass Appraisal databases).

**Key discovery:** AccurateAssessor (Prolorem) operates a public Dataverse API that covers 8 of the 9 target counties. This API provides bedrooms, sqft, and year built and is the primary data source for all counties except Washington.

Data is pre-fetched in bulk and stored in `assessor-cache.json`. The server loads this file at startup into an in-memory Map keyed by SCO PARCELID. Per-parcel scraping happens as a fallback for cache misses (rare after the bulk fetch).

**Cache file:** `assessor-cache.json`
- Key: SCO PARCELID (the `PARCELID` field from the Wisconsin SCO ArcGIS FeatureServer, or `parcelfid` as called in `server.js`)
- Value: `{ "bedrooms": N, "sqft": N, "yearBuilt": N, "cachedAt": timestamp_ms }`
- Total entries as of last run: ~168,000

---

## AccurateAssessor (Prolorem) Dataverse API — General Notes

**Base URL:** `https://accurateassessor.powerappsportals.com/_api/acc_realestates`

**Auth:** Public, no authentication required.

**Pagination:** Dataverse does NOT support `$skip`. Page through results using:
- `Prefer: odata.maxpagesize=500` header to set page size
- Follow `@odata.nextLink` in each response for the next page
- Stop when `@odata.nextLink` is absent or `value` array is empty

**Building data expand:**
```
$expand=acc_acc_realestate_acc_dwelling_RealEstate($select=acc_bedroomcount,acc_totallivingarea,acc_yearbuilt)
```
Fields in each dwelling record:
- `acc_bedroomcount`: integer bedroom count
- `acc_totallivingarea`: sqft (numeric)
- `acc_yearbuilt`: ISO date string — year is the first 4 characters (`int(str(val)[:4])`)

**County filter:** `_acc_county_value eq '{county_guid}'`

**How to discover county GUIDs:** Query `acc_realestates` without a county filter, collect `_acc_county_value` GUID and `_acc_county_value@OData.Community.Display.V1.FormattedValue` (the county name) from sample records across many pages. After ~10,000 records you'll have seen most represented counties.

**Parcel number field:** `acc_parcelumber` — format varies by county (see per-county notes below).

**Required headers:**
```
OData-MaxVersion: 4.0
OData-Version: 4.0
Accept: application/json
Prefer: odata.maxpagesize=500
```

**Known errors:**
- `$skip` returns error code `9004010B` — never use it
- `$top` caps TOTAL records, not page size — omit it entirely
- `$count=true` returns max 5000 even when there are more records

---

## Fetch Scripts

| Script | Counties covered |
|---|---|
| `fetch_dane_assessor.py` | Dane (AccurateAssessor + City of Madison ArcGIS) |
| `fetch_other_counties.py` | Green, Dodge, Rock, Walworth, Jefferson, Waukesha, Columbia |

To re-run a specific county only: `python fetch_other_counties.py jefferson waukesha`  
(county names are lowercase, space-separated; omit to run all)

---

## County-by-County Details

---

### Dane County

**Status:** Implemented. ~97,321 parcels cached (~30,906 from AccurateAssessor + ~66,415 from Madison ArcGIS).

**AccurateAssessor GUID:** `d8c67ee3-3692-eb11-b1ac-000d3a58b1bb`

**AA parcel format:** `MMM/XXXXXXXXXXXX`
- `MMM` = 3-letter municipality code (e.g., `ORC` for Oregon, `PER` for Perry)
- `XXXXXXXXXXXX` = 12 digits = SCO PARCELID exactly
- Conversion: `raw.split('/')[-1].replace('-', '').strip()` — take after last `/`, strip dashes

Municipalities covered: Albion, Berry, Blooming Grove, Cottage Grove, Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant Springs, Primrose, and several villages.

**City of Madison ArcGIS MapServer:**  
`https://maps.cityofmadison.com/arcgis/rest/services/Public/Property_Lookup/MapServer/9/query`
- Fields: `Parcel` (= 12-char SCO PARCELID), `Bedrooms`, `TotalLivingArea`, `YearBuilt`
- Query: `where=Bedrooms > 0`, paginate with `resultOffset` / `resultRecordCount`

**Not covered (no bedroom data):**
- AssessorData.org covers some Dane municipalities (York, Springdale, Vermont, Montrose, Roxbury, Rutland, Christiana, Vienna, Mazomanie, Middleton, Fitchburg, Sun Prairie, Dane) but has sqft/year built only — NO bedrooms
- CAMA Cloud covers Waunakee, DeForest, Verona, Westport, Springfield, Bristol, Burke, Cottage Grove (village) — blocked by AWS WAF (403 on JS bundles)

**Script:** `fetch_dane_assessor.py`

---

### Green County

**Status:** Implemented. ~4,630 parcels cached.

**AccurateAssessor GUID:** `fe072b1a-3dfc-ea11-a815-000d3a353d78`

**AA parcel format:** `23251 1153.0000` (county+muni prefix, space, parcel number, `.0000`)

**SCO PARCELID format:** 13-digit numeric string (e.g., `2325111530000`)

**Conversion:** Remove all spaces and periods: `re.sub(r'[ .]', '', raw)`
- `23251 1153.0000` → `2325111530000` ✓

**Validation:** 13 digits, all numeric.

**Script:** `fetch_other_counties.py`

---

### Dodge County

**Status:** Implemented. ~8,505 parcels cached.

**AccurateAssessor GUID:** `90470156-f5c9-eb11-bacc-000d3a5a1c19`

**AA parcel format:** `206-1214-3334-007` (dash-separated, same visual format as Jefferson County)

**SCO PARCELID format:** 14-digit numeric string (e.g., `20612143334007`)

**Conversion:** Remove dashes: `raw.replace('-', '')`
- `206-1214-3334-007` → `20612143334007` ✓

**Validation:** 14 digits, all numeric.

**Important distinction:** Dodge County strips dashes for SCO PARCELID. Jefferson County (same visual dash format) keeps dashes. These are different county conventions despite the same appearance.

**Script:** `fetch_other_counties.py`

---

### Rock County

**Status:** Implemented. ~8,402 parcels cached.

**AccurateAssessor GUID:** `06bc1ad7-b3ee-ea11-a817-000d3a353d78`

**AA parcel format:** `221 190005` or `221 18900209` (3-digit code + space + 6 or 8 digit local number)

**SCO PARCELID format:** Same format — `NNN NNNNNN` or `NNN NNNNNNNN`. Direct match.

**Conversion:** Use as-is (no transformation needed).

**Script:** `fetch_other_counties.py`

---

### Walworth County

**Status:** Implemented. ~24,552 parcels cached (largest non-Dane county).

**AccurateAssessor GUID:** `8676bc1f-b143-eb11-a813-00224803df6d`

**AA parcel format:** Alphabetic municipality prefix + number, variable format:
- `NVS   00017` (New Vineyard Springs?)
- `NVSP  00020`
- `NVS   00065A` (with letter suffix)
- `#A352400002` (hash prefix)

**SCO PARCELID format:** Same alpha-numeric codes — direct match verified for multiple formats.

**Conversion:** Use as-is (no transformation needed).

**Script:** `fetch_other_counties.py`

---

### Jefferson County

**Status:** Implemented. ~8,337 parcels cached.

**AccurateAssessor GUID:** `dae12e4f-5518-eb11-a813-000d3a353d78`

**AA parcel format:** `292-0515-3141-033` (dash-separated — same visual structure as Dodge)

**SCO PARCELID format:** `292-0515-3141-033` — WITH dashes (direct match)

**Conversion:** Use as-is (no transformation needed).

**Important distinction:** Jefferson County KEEPS dashes in the SCO PARCELID; Dodge County STRIPS them. Both counties use the same `NNN-NNNN-NNNN-NNN` visual format. Never confuse these.

**Note from previous investigation:** The JCLRS portal (`jclrs.co.jefferson.wi.us`) is a tax-only portal with no building data exposed. AccurateAssessor is the correct source.

**Script:** `fetch_other_counties.py`

---

### Waukesha County

**Status:** Implemented. ~8,745 parcels cached.

**AccurateAssessor GUID:** `e96a44ab-9444-eb11-a813-00224803df6d`

**AA parcel format:** Municipality-code + local number, e.g.:
- `SUMT0671061` (Summit)
- `EGLT1844997` (Eagle Township)
- `WAKC1004185` (Waukesha City)

**SCO PARCELID format:** Same alpha-numeric codes — direct match.

**Conversion:** Use as-is (no transformation needed).

**Script:** `fetch_other_counties.py`

---

### Columbia County

**Status:** Implemented via address-join. ~6,342 parcels cached (out of ~9,261 AA records; ~2,919 unmatched due to address format differences or missing SCO addresses).

**AccurateAssessor GUID:** `25a4971a-56b5-ea11-a812-000d3a3be5cf`

**AA parcel format:** `MMMM PPPP` or `MMMM PPPP.NN` or `MMMM PPPP.B`:
- `11127 106` (Friesland)
- `11012 44` (Fort Winnebago)
- `11032 239.02` (Pacific)
- `11010 775.03` (Dekorra)
- `11127 210.B` (Friesland, sub-parcel B)

**SCO PARCELID format:** 7-digit sequential integer (e.g., `2238842`). There is NO arithmetic relationship between the AA parcel number and the SCO PARCELID — they are completely different numbering systems.

**Conversion approach:** Address-based join.
1. Download all Columbia County parcels from SCO ArcGIS (`CONAME='COLUMBIA'`, ~25,000 parcels) with `PARCELID` and `SITEADRESS`
2. Build a normalized-address → PARCELID lookup dict
3. For each AA parcel with a physical address, normalize and look up in the SCO dict
4. Where unique match found, use the SCO PARCELID as the cache key

**Municipalities covered by AccurateAssessor in Columbia County:**
Dekorra (~766 records), Pacific (~491), Courtland (~266), Cambria (~193), Caledonia (~187), Fort Winnebago (~176), Randolph (~174), Friesland (~123), Pardeeville (~88), Poynette (~36). All are rural townships — these are the types of areas with 4+ acre properties.

**Script:** `fetch_other_counties.py` (Columbia section uses `fetch_sco_columbia()` + `fetch_columbia()`)

**Why ~30% unmatched:** Rural addresses in AA often omit city, use abbreviated street types, or appear on private roads with no SCO address record. These unmatched parcels are mostly land-only parcels (no dwelling).

---

### Washington County

**Status:** BLOCKED — no public source for bedroom data found.

**SCO PARCELID format:** `291 NNNNNNNNNNN` (3-digit county code `291`, space, 11-digit number). Confirmed by querying the SCO ArcGIS service.

**Land records portal:** `https://landrecords.washcowisco.gov/LandRecords/`  
System: Transcendent Technologies Ascent LRS (Angular SPA). This is a **tax records** system — it contains assessed values, owner names, tax bills, parcel history, and sales history, but **NOT bedrooms, sqft, or year built**.

**Assessors (from Ascent page config):**
- Associated Appraisal Consultants Inc — domain expired (GoDaddy parking page); no public portal
- CATALIS TAX & CAMA Inc (Menomonee Falls) — no public-facing portal found
- Schultz Appraisal LLC (Oconomowoc) — small local firm, no portal
- Accurate Appraisal LLC — no portal found (separate company from AccurateAssessor)

**Investigation results:**

Ascent API at `/LandRecords/api/`:
- Internal parcel IDs (`LRSPARID`) are available from the Washington County GIS `CurrentParcelSearch` FeatureServer at `https://maps.washcowisco.gov/server/rest/services/WashCoGIS/CurrentParcelSearch/FeatureServer/0/query`
- Fields available in GIS layer: `LRSPARID`, `ParcelNum` (e.g. `0505011`), `TaxKey` (e.g. `T2_0505011`), `MUNINAME`, `SiteAddresses1`, `LRS_URL`, `TOTALACRES`, `CNTASSDVAL`, `IMPRVVALUE` — no CAMA fields
- `GET /LandRecords/api/RealEstateTaxParcelService/{LRSPARID}` returns HTTP 500 NullReferenceException for unauthenticated requests even with valid IDs; this is an admin-only endpoint requiring a login session
- All `/Services/api/` endpoints (the public side) are autocomplete-only lookups (`LrsParcelLookup`, `LrsStreetNameLookup`, etc.); no property detail endpoint exists there
- The Angular app at `/LandRecords/Ascent/Scripts/ProductSpecific` (2.3MB bundle) was analyzed; the property detail calls `api/RealEstateTaxParcelService/{id}` which is blocked for public users

GIS open data (`gisdata.washcowisco.gov`):
- 138 published datasets enumerated via DCAT catalog
- The `CurrentParcel` layer has parcel boundaries + tax data but no building attributes
- No CAMA dataset (bedrooms/sqft/year built) is published

AssessorData.org: Does not cover Washington County.

**Conclusion:** Bedroom data for Washington County is not accessible via any public API or download. The county's tax portal (Ascent LRS) is authenticated-only for property detail, and none of the 4 assessor vendors have public CAMA portals. Washington County will remain at 0 bedroom entries in the cache.

**LRS_URL pattern (for reference):**  
`https://landrecords.washcowisco.gov/LandRecords/PropertyListing/RealEstateTaxParcel/ParcelDetail/{LRSPARID}`  
The `LRSPARID` is an integer in the GIS `CurrentParcelSearch` layer but requires county staff login to view property details via API.

---

## AccurateAssessor County GUID Reference

All confirmed Wisconsin county GUIDs in the AccurateAssessor Dataverse system:

| County | GUID | Notes |
|---|---|---|
| Calumet | `b60d7f23-cd18-eb11-b1ac-000d3a353d78` | Not a target county |
| Columbia | `25a4971a-56b5-ea11-a812-000d3a3be5cf` | Target — implemented |
| Dane | `d8c67ee3-3692-eb11-b1ac-000d3a58b1bb` | Target — implemented |
| Dodge | `90470156-f5c9-eb11-bacc-000d3a5a1c19` | Target — implemented |
| Grant | `9b6531b1-0509-eb11-a813-000d3a32896d` | Not a target county |
| Green | `fe072b1a-3dfc-ea11-a815-000d3a353d78` | Target — implemented |
| Jefferson | `dae12e4f-5518-eb11-a813-000d3a353d78` | Target — implemented |
| Lafayette | `e14b57d6-be1a-eb11-a813-000d3a5a733e` | Not a target county |
| Marathon | `141e6657-5d19-eb11-a813-000d3a353d78` | Not a target county |
| Milwaukee | `db42b6ef-6007-eb11-a813-000d3a32896d` | Not a target county |
| Monroe | `9bc6ae7e-a22a-ec11-b6e5-000d3a332cf1` | Not a target county |
| Outagamie | `c723a526-56b5-ea11-a812-000d3a3be5cf` | Not a target county |
| Rock | `06bc1ad7-b3ee-ea11-a817-000d3a353d78` | Target — implemented |
| Sauk | `5aa2d1c0-4225-ec11-b6e5-000d3a5bb925` | Not a target county |
| Shawano | `630eadcb-ff00-ec11-94ef-000d3a5b3acc` | Not a target county |
| Walworth | `8676bc1f-b143-eb11-a813-00224803df6d` | Target — implemented |
| Waukesha | `e96a44ab-9444-eb11-a813-00224803df6d` | Target — implemented |

Washington County is **not in AccurateAssessor** (confirmed by querying known cities: West Bend, Hartford, Germantown, Slinger, Jackson — none matched Washington County in AA).

---

## SCO PARCELID Format by County

The SCO ArcGIS FeatureServer (`https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels/FeatureServer/0/query`) stores parcel IDs in the `PARCELID` field. Formats vary by county:

| County | SCO PARCELID format | Example |
|---|---|---|
| Dane | 12-digit numeric | `050601180820` |
| Green | 13-digit numeric | `2325111530000` |
| Dodge | 14-digit numeric | `20612143334007` |
| Jefferson | Dashed `NNN-NNNN-NNNN-NNN` | `292-0515-3141-033` |
| Rock | `NNN NNNNNN` or `NNN NNNNNNNN` | `221 190005` |
| Walworth | Alpha-numeric prefix | `NVS   00017`, `#A352400002` |
| Waukesha | Alpha-numeric prefix | `SUMT0671061`, `EGLT1844997` |
| Columbia | 7-digit numeric | `2238842` |
| Washington | `291 NNNNNNNNNNN` | `291 11190120005` |

---

## Municipality Coverage Gaps

Which localities we cannot yet get bedroom data for, broken down by county. Rural **towns** (townships) are the most relevant gap for the 4+ acre property search — that is where rural land parcels sit.

Sources used to determine coverage: AccurateAssessor municipality list queried via Dataverse API; full municipality inventory from Wisconsin SCO statewide parcel data (`PLACENAME` field).

---

### Dane County

**Covered:** Towns of Albion, Berry, Blooming Grove, Cottage Grove, Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant Springs, Primrose (AccurateAssessor) + City of Madison (ArcGIS MapServer).

**No bedrooms — AssessorData.org has sqft/year built only:**
- Towns of York, Springdale, Vermont, Montrose, Roxbury, Rutland, Christiana, Vienna, Mazomanie, Dane
- Cities of Fitchburg, Middleton, Sun Prairie

**No bedrooms — CAMA Cloud blocked (AWS WAF returns 403 on JS bundles):**
- Towns of Westport, Springfield, Bristol, Burke
- City of Verona; Villages of Waunakee, DeForest, Cottage Grove

**No known source:**
- Towns of Black Earth, Blue Mounds, Dunkirk, Dunn, Middleton, Sun Prairie, Verona
- Cities of Monona, Stoughton; many villages (Belleville, Black Earth, Blue Mounds, Brooklyn, Cambridge, Cross Plains, Dane, Deerfield, Maple Bluff, Marshall, Mazomanie, McFarland, Mount Horeb, Oregon, Rockdale, Shorewood Hills, Windsor)

---

### Green County

AccurateAssessor covers 4 of 25 municipalities: City of Monroe, Village of New Glarus, Village of Brooklyn, Village of Belleville. **All 15 rural towns are uncovered.**

**No data:**
- Towns of Adams, Albany, Brooklyn, Cadiz, Clarno, Decatur, Exeter, Jefferson, Jordan, Monroe, Mt Pleasant, New Glarus, Spring Grove, Sylvester, Washington, York
- City of Brodhead; Villages of Albany, Browntown, Monticello

---

### Dodge County

AccurateAssessor covers 3 of 44 municipalities: City of Beaver Dam, Town of Fox Lake, City of Watertown. **22 of 23 rural towns are uncovered.**

**No data:**
- Towns of Ashippun, Beaver Dam, Burnett, Calamus, Chester, Clyman, Elba, Emmet, Herman, Hubbard, Hustisford, Lebanon, Leroy, Lomira, Lowell, Oak Grove, Portland, Rubicon, Shields, Theresa, Trenton, Westford
- Cities of Horicon, Juneau, Mayville, Waupun
- Villages of Brownsville, Clyman, Hustisford, Iron Ridge, Kekoskee, Lomira, Lowell, Neosho, Randolph, Reeseville, Theresa

---

### Rock County

AccurateAssessor covers 5 of 30 municipalities: Town of Beloit, City of Edgerton, Village of Footville, **Town of Fulton**, **Town of Union**. 17 of 20 rural towns are uncovered.

**No data:**
- Towns of Avon, Bradford, Center, Clinton, Harmony, Janesville, Johnstown, La Prairie, Lima, Magnolia, Milton, Newark, Plymouth, Porter, Rock, Spring Valley, Turtle
- Cities of Evansville, Janesville, Milton
- Villages of Clinton, Orfordville

---

### Walworth County

AccurateAssessor covers 14 of 31 municipalities, including a good share of rural towns: Geneva, Lyons, Richmond, Spring Prairie, Sugar Creek, Walworth (town), plus cities/villages of Burlington, Delavan, Elkhorn, Fontana, Walworth (village), Whitewater, Williams Bay, Darien.

**No data — 7 rural towns and several villages:**
- Towns of East Troy, La Grange, Lafayette, Linn, Sharon, Troy, Whitewater
- City of Lake Geneva
- Villages of Bloomfield, East Troy, Genoa City, Mukwonago, Sharon (and possibly Village of Darien)

---

### Jefferson County

AccurateAssessor covers 6 of 27 municipalities: City of Jefferson, City of Watertown, City of Whitewater, **Town of Oakland**, Village of Cambridge, Village of Sullivan. **15 of 16 rural towns are uncovered.**

**No data:**
- Towns of Aztalan, Cold Spring, Concord, Farmington, Hebron, Ixonia, Jefferson, Koshkonong, Lake Mills, Milford, Palmyra, Sullivan, Sumner, Waterloo, Watertown
- Cities of Fort Atkinson, Lake Mills, Waterloo
- Villages of Johnson Creek, Palmyra

---

### Waukesha County

AccurateAssessor covers 3 of ~40 municipalities: **Town of Delafield**, **Town of Lisbon**, **Town of Summit**. 10 of 13 rural towns are uncovered.

**No data:**
- Towns of Brookfield, Eagle, Genesee, Merton, Mukwonago, Oconomowoc, Ottawa, Vernon, Wales, Waukesha
- Cities of Brookfield, Muskego, New Berlin, Oconomowoc, Pewaukee, Waukesha
- Villages of Big Bend, Chenequa, Dousman, Eagle, Elm Grove, Hartland, Lac La Belle, Lannon, Menomonee Falls, Merton, Mukwonago, Nashotah, North Prairie, Oconomowoc Lake, Pewaukee, Summit, Sussex, Wales

---

### Columbia County

AccurateAssessor covers 11 of 36 municipalities, with solid rural township coverage: Towns of Caledonia, Courtland, Dekorra, Fort Winnebago, Pacific, Randolph + Villages of Cambria, Friesland, Pardeeville, Poynette + City of Portage.

**No data — 15 rural towns and several villages:**
- Towns of Arlington, Columbus, Fountain Prairie, Hampden, Leeds, Lewiston, Lodi, Lowville, Marcellon, Newport, Otsego, Scott, Springvale, West Point, Wyocena
- Cities of Columbus, Lodi, Wisconsin Dells
- Villages of Arlington, Doylestown, Fall River, Randolph, Rio, Wyocena

---

### Washington County

**Entire county — no data.** Washington County is not in AccurateAssessor. The Ascent LRS portal is a tax records system (no CAMA data), and its property detail API requires county staff authentication. None of the 4 assessor vendors (Associated Appraisal, CATALIS, Schultz Appraisal, Accurate Appraisal) have public portals. AssessorData.org does not cover Washington County. See county-by-county section above for full investigation notes.

All 21 municipalities lack bedroom data:
- Towns of Addison, Barton, Erin, Farmington, Germantown, Hartford, Jackson, Kewaskum, Polk, Trenton, Wayne, West Bend
- Cities of West Bend, Hartford
- Villages of Germantown, Jackson, Kewaskum, Newburg, Richfield, Slinger

---

### Coverage Summary

| County | Total municipalities | Have bedroom data | Missing |
|---|---|---|---|
| Dane | 60 | ~12 (11 towns + Madison) | ~48 |
| Green | 25 | 4 (all cities/villages, no towns) | 21 incl. all 15 towns |
| Dodge | 44 | 3 | 41 incl. 22 of 23 towns |
| Rock | 30 | 5 | 25 incl. 17 of 20 towns |
| Walworth | 31 | 14 | 17 incl. 7 towns |
| Jefferson | 27 | 6 | 21 incl. 15 of 16 towns |
| Waukesha | ~40 | 3 | ~37 incl. 10 of 13 towns |
| Columbia | 36 | 11 | 25 incl. 15 towns |
| Washington | 21 | 0 | all 21 |

**Worst gaps for the 4+ acre rural search:** Green, Dodge, Jefferson, and Waukesha counties each have bedroom data for essentially only 1–3 cities; nearly every rural township is missing. Washington County has no source at all.

---

## Options for Acquiring More Bedroom Data

This section covers candidate approaches to close the coverage gaps documented above. Organized by feasibility tier.

---

### Tier 1 — Most Viable (Worth Pursuing)

#### CAMA Cloud (Platinum Data / Data Technologies)
Used by several uncovered Dane County municipalities: Waunakee, DeForest, Verona, Westport, Springfield, Bristol, Burke, Cottage Grove (village).

The portal at `waukesha.camacloud.com` (and presumably `dane.camacloud.com`, etc.) performs a **browser detection check** and redirects unsupported browsers to a dead-end page. This is NOT an AWS WAF block — it's a JavaScript user-agent check that can likely be bypassed.

**Approach:** Use Playwright with a realistic Chrome `User-Agent` string and allow JavaScript execution. The portal is an Angular/React SPA; once the browser check passes, XHR calls to the underlying API can be intercepted and replicated directly.

- **Subdomain pattern:** `{county-slug}.camacloud.com` — Dane County would be `dane.camacloud.com` or `danecounty.camacloud.com`
- **Status:** Unconfirmed whether a Dane County CAMA Cloud instance exists; Waukesha (`waukesha.camacloud.com`) was confirmed to redirect
- **Potential gain:** 7–8 Dane municipalities (~15,000 parcels if the browser check can be bypassed)

#### Regrid.com
National parcel data aggregator (~150M parcels). Claims to include CAMA attributes (bedrooms, sqft, year built) where available from county sources.

- **Trial:** 30-day free trial available; no credit card required per their site
- **API:** REST API with GeoJSON output; can query by state/county FIPS code
- **Wisconsin coverage:** Unknown — CAMA attribute fill rate varies widely by county. Regrid ingests official county GIS feeds, so their WI coverage reflects what counties publish, not what's extractable from private portals
- **Potential gain:** Could fill gaps in Green, Dodge, Jefferson counties if those counties publish CAMA CSVs that Regrid ingests
- **Verification step needed:** Sign up for trial and query a known-covered township to verify bedroom field is populated before committing

#### County GIS Open Data Portals (Case-by-Case)
Some WI counties publish CAMA attributes in their parcel shapefile/GeoJSON download. Worth checking for each county with large gaps:

- **Green County:** Check `gis.co.green.wi.us` or Wisconsin Land Information Program (WLIP) submissions
- **Dodge County:** Check `dodgecounty.net/departments/gis`
- **Jefferson County:** Check Jefferson County GIS portal
- **Columbia County:** ~30% of AA records couldn't be address-matched — check if Columbia County publishes a parcel CSV with `PARCELID` + building attributes that would allow direct join

WLIP (Wisconsin Land Information Program, DNR) compiles county-submitted parcel data but the public download only has geometry + ownership fields, not CAMA.

---

### Tier 2 — Commercial (Cost vs. Coverage Trade-off)

#### ATTOM Data Solutions
Full property data platform covering all US residential parcels. Includes bedrooms, sqft, year built, sale history, AVM, and more.

- **Pricing:** Not publicly listed; typical pricing is per-record or per-county annual subscription; likely $500–$5,000/year range for the scope needed here
- **API:** REST with JSON; straightforward to bulk-pull by county
- **Coverage:** Generally complete for residential properties — would likely fill all 9 counties including Washington
- **Status during investigation:** HTTP 429 (rate limited) on initial unauthenticated probe; production API requires account + key
- **Verdict:** Overkill for a cold-mail campaign unless the economics support it

#### CoreLogic / Zillow / Realtor.com
Similar commercial data vendors. CoreLogic is the largest; ATTOM is more accessible to small buyers. Zillow and Realtor.com APIs are consumer-facing and do not provide bulk parcel exports.

---

### Tier 3 — Technically Possible but Difficult

#### Tyler Technologies iasWorld
Tyler iasWorld is the dominant WI county assessor platform. Counties that use it sometimes expose a public-facing "Ascent" portal (as Washington County does) or a dedicated property search page.

- **DNS probe results:** All attempted Tyler-hosted hostnames failed (DNS NXDOMAIN) during investigation. No single public API endpoint — each county has its own subdomain
- **Pattern to investigate:** `{county}assess.tylerhost.net`, `assess.co.{county}.wi.us`, or county-branded subdomains
- **Counties potentially on Tyler:** Washington County (confirmed Ascent LRS), possibly others
- **Approach if pursued:** Per-parcel scraping via Playwright; no bulk API available for unauthenticated users

#### DevNet Wedge
Used by a subset of WI municipalities for assessor data lookup.

- **Investigation result:** `www.devnetwedge.com/county/view/WI` returned 404 (verified with SSL disabled due to cert issues). The URL pattern may have changed.
- **Potential alternative URL:** `devnetwedge.com/parcel/view/{STATE}/{COUNTY_CODE}/{PARCELID}` — if this works, per-parcel scraping could be feasible
- **Scale concern:** Per-parcel scraping at 5,000–50,000 parcels/county is slow (~2–14 hours at 1 req/sec with politeness delay); only worthwhile for high-priority counties

#### Playwright Scraping of County Assessor Portals
For counties where the assessor uses a JS-rendered SPA (CAMA Cloud, Tyler Ascent, DevNet), headless browser automation could work:

1. Launch Chrome via Playwright
2. Navigate to the property search page
3. For each parcel of interest, submit a search by address or parcel ID
4. Extract bedroom/sqft/year from the rendered DOM

**Why this approach is last resort:**
- Slow: 1–3 seconds per parcel even with a fast connection
- Fragile: SPA structure changes break scrapers
- Rate-limited: Most portals block rapid automated requests
- Only practical for targeted lookups (properties already on the filtered list), not bulk cache-building

---

### Tier 4 — Dead Ends

| Source | Why ruled out |
|---|---|
| Wisconsin SCO ArcGIS | Geometry + ownership only; no CAMA attributes |
| Wisconsin DOR | Aggregate municipal totals only; no per-parcel data |
| AssessorData.org | Covers some WI municipalities but has sqft/year only — **no bedrooms** |
| Washington County Ascent LRS | Property detail endpoint (`api/RealEstateTaxParcelService/{id}`) requires county staff login; returns HTTP 500 for all unauthenticated requests |
| Washington County GIS (`gisdata.washcowisco.gov`) | 138 published datasets, none with CAMA attributes |
| Associated Appraisal Consultants | Domain expired (GoDaddy parking page) |
| CATALIS TAX & CAMA | No public portal |
| Schultz Appraisal LLC | Small local firm, no portal |
| Accurate Appraisal LLC | No public portal (different company from AccurateAssessor/Prolorem) |

---

### Recommended Next Steps

1. **CAMA Cloud (Dane County):** Try accessing `dane.camacloud.com` (or the correct Dane subdomain) with Playwright and a real Chrome UA. If the browser check can be bypassed, bulk-fetch would cover 7–8 municipalities and ~15,000 parcels.

2. **Regrid trial:** Sign up for the 30-day free trial and test bedroom field population for Green County townships. If fields are populated, Regrid could fill the Green/Dodge/Jefferson gaps without scraping.

3. **Columbia County GIS download:** Check whether Columbia County publishes a parcel CSV with building attributes. If so, a direct PARCELID join would improve the current ~70% address-match rate.

---

## Cache Summary After Last Run

```
Dane County (fetch_dane_assessor.py):    ~97,321 parcels
Green County:                              4,630 parcels
Dodge County:                              8,505 parcels
Rock County:                               8,402 parcels
Walworth County:                          24,552 parcels
Jefferson County:                          8,337 parcels
Waukesha County:                           8,745 parcels
Columbia County (address-matched):         6,342 parcels
Washington County:                             0 parcels (blocked — no public source)
─────────────────────────────────────────────────────────
Total:                                  ~168,100 parcels
```
