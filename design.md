# Wisconsin Parcel Search Tool — Design Document

*Last updated: 2026-05-30. Planning phase complete.* This document captures all decisions made during the initial planning session and can be used to resume work if the session is interrupted.*

---

## 1. The Problem

The buyer wants to purchase a rural Wisconsin property — 4+ acres, a livable house, priced under $900,000 — but does not want to compete with other buyers on the open market. Searching Zillow or working with a realtor only surfaces properties whose owners have already decided to sell; the best properties may never reach the market at all. The solution is to go directly to the source: Wisconsin's statewide property database contains every assessed parcel in the state, including owner names and mailing addresses, all freely available under Wisconsin's Public Records Law. By filtering this database for matching properties and mailing letters directly to owners, the buyer can identify off-market opportunities that no other buyer is seeing. This tool automates the search and filtering step, producing a prioritized list of properties and their owners to contact.

### Tool Scope
**In scope:** Finding, filtering, and displaying matching properties; surfacing owner contact information; enriching results with flood zone, wetlands, and assessor data; exporting results as CSV.

**Out of scope:** Drafting letters, sending letters, tracking responses, deduplicating owners across parcels, managing the campaign. These are handled externally by the buyer.

---

## 2. The Technical Plan

The tool runs entirely on the buyer's own computer — no cloud hosting, no ongoing costs. It has three components:

**Filter panel** — The buyer sets search criteria (price ceiling, acreage, county, property class, water proximity, etc.) and clicks Search.

**Local proxy server** — A small Node.js program running in the background. Required because the Wisconsin parcel API, FEMA flood zone API, and federal wetlands API all block direct browser requests. The proxy forwards requests from the browser to these external APIs and returns the results.

**Map** — An interactive map takes up the full right side of the screen. Matching properties appear as color-coded, clustered dots. Clicking a dot opens a detailed popup. Clicking a result in the sidebar list centers and highlights the corresponding dot on the map.

### Request Flow

When the user clicks Search:
1. Browser sends filter criteria to the local proxy server
2. Proxy fetches all matching parcels from Wisconsin parcel API, paginating in batches of 2,000 until all records are retrieved
3. Proxy queries FEMA and USFWS APIs against the full result set to get flood zone and wetlands data
4. Browser renders all results on the map and in the table simultaneously

### Block Diagram

```
                   ┌─ Startup ──────────────────────────┐
                   │  WI DOR  →  assessment ratio cache  │
                   │  hidden.json  →  initialize if new  │
                   └────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────┐
│          Local Proxy Server (server.js :3000)        │
│                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌───────┐ │
│  │/init-data  │ │/parcel-    │ │/flood- │ │/wet-  │ │
│  │(DOR ratios │ │query       │ │query   │ │lands- │ │
│  │from cache) │ │(paginated  │ │        │ │query  │ │
│  └─────┬──────┘ │+ neighbor  │ └───┬────┘ └───┬───┘ │
│  ┌─────┴──────┐ │bounding box│     │          │     │
│  │/assessor-  │ │query)      │     │          │     │
│  │query       │ └─────┬──────┘     │          │     │
│  └─────┬──────┘       │            │          │     │
│  ┌─────┴──────┐        │            │          │     │
│  │/hidden     │        │            │          │     │
│  │(CRUD,      │        │            │          │     │
│  │hidden.json)│        │            │          │     │
│  └────────────┘        │            │          │     │
└───────────────────────┼────────────┼──────────┼─────┘
                        │            │          │
             ┌──────────┘     ┌──────┘    ┌─────┘
             ▼                ▼           ▼
      SCO ArcGIS API     FEMA NFHL    USFWS NWI
      (parcels +         Flood Zones  Wetlands
       neighbor query)

      County Assessors   WI DOR
      (9 counties,       (startup
       Phase 1)           fetch only)

┌──────────────────────────────────────────────────────┐
│                 Browser (index.html)                 │
│  ┌──────────────────┐     ┌────────────────────────┐ │
│  │   Left Panel     │     │                        │ │
│  │  ┌────────────┐  │     │      Leaflet Map        │ │
│  │  │Filter Panel│  │◀───▶│   (Canvas + Cluster)   │ │
│  │  │(DOR ratios │  │     │                        │ │
│  │  │pre-filled) │  │     └────────────────────────┘ │
│  │  └────────────┘  │                                │
│  │  ┌────────────┐  │                                │
│  │  │Sidebar List│  │                                │
│  │  │(sortable,  │  │                                │
│  │  │ Export CSV)│  │                                │
│  │  └────────────┘  │                                │
│  └──────────────────┘                                │
└──────────────────────────────────────────────────────┘
```

---

## 3. Buyer Profile

| Attribute | Value |
|---|---|
| Purchase budget | $900,000 |
| Down payment | ~$300,000 |
| Financing | Conventional mortgage (pre-approval expected; no agricultural loan needed) |
| Credit | Excellent |
| Commute constraint | None — both spouses work from home |
| Timeline | 6–18 months acceptable; no urgency |
| Real estate agent | None — will use a Wisconsin real estate attorney instead |
| Wisconsin familiarity | Grew up there; has local family for property evaluation support |
| Temporary housing | Will move to temporary housing first, then evaluate properties |

### Property Requirements

| Attribute | Requirement |
|---|---|
| Min acreage | 4 acres (GIS) |
| Max acreage | None |
| Bedrooms | 3+ minimum (from county assessor integration — Phase 1) |
| Property class | Class 1 Residential (Class 4 Agricultural optional — see filter notes) |
| Water proximity | Nice-to-have; start search with water-adjacent properties, expand after |
| Animals/agriculture | Nice-to-have, not make-or-break; not worth pursuing agricultural financing |
| School district | Not a current filter; noted as future feature |
| Broadband | Critical for remote work; must be checked manually per property |

### Target Counties
Dane, Jefferson, Waukesha, Green, Rock, Walworth, Columbia, Dodge, Washington

---

## 4. Architecture

Three files. Run with `node server.js`, open `http://localhost:3000`.

| File | Role |
|---|---|
| `server.js` | Node.js/Express proxy — on startup, fetches WI DOR assessment ratio data and caches it. Forwards requests to Wisconsin SCO, FEMA NFHL, and USFWS NWI APIs. Serves `index.html` at `/` and `hidden.json` state via `/hidden` routes. |
| `index.html` | Frontend — filter panel, Leaflet map, results table. All API calls go to the local proxy. CDN dependencies: Leaflet 1.9.4, Leaflet.markercluster. |
| `package.json` | Dependencies: `express`, `cors`. Node 18+ native fetch (no `node-fetch` needed). |

### Proxy Endpoints

| Local Route | Proxied To |
|---|---|
| `GET /init-data` | Returns WI DOR assessment ratios (fetched at startup, cached in memory) |
| `/parcel-query` | SCO ArcGIS FeatureServer (parcel data, paginated) |
| `/flood-query` | FEMA NFHL MapServer (flood zones) |
| `/wetlands-query` | USFWS NWI MapServer (wetlands) |
| `/assessor-query` | County assessor APIs (one per county — routes TBD after research) |
| `GET /hidden` | Returns array of hidden parcel IDs from `hidden.json` |
| `POST /hidden/:parcelfid` | Adds a parcel ID to `hidden.json` |
| `DELETE /hidden/:parcelfid` | Removes a parcel ID from `hidden.json` |
| `DELETE /hidden` | Clears all hidden parcel IDs from `hidden.json` |

---

## 5. Data Sources

### Primary: Wisconsin Statewide Parcel Map (SCO)
- **Endpoint:** `https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels/FeatureServer/0`
- **Current version:** V11 (service name `V1100_WisconsinParcels_2025_0925_2`), loaded Feb 2025. Tax roll year 2024.
- Free under Wisconsin Public Records Law.
- Hard limit: 2,000 records per query with geometry; 32,000 per query without geometry — **pagination required in v1**.
- Does **not** include: bedrooms, sq footage, year built, condition, listing status, broadband, zoning. Bedroom data sourced from county assessor scraping (Phase 1).
- **All field names are uppercase in V11.** This is a breaking change from V10.
- **Field list confirmed via live API query.** Key fields:

| Field (V11) | Alias | Notes |
|---|---|---|
| `PARCELID` | Parcel ID | Unique identifier (replaces V10 `parcelfid`) |
| `STATEID` | State ID | Statewide unique parcel ID |
| `OWNERNME1` | Primary Owner Name | Use for letter personalization |
| `OWNERNME2` | Secondary Owner Name | Joint ownership, spouse, etc. |
| `PSTLADRESS` | Owner Mailing Address | Full formatted — use for cold-mail targeting |
| `SITEADRESS` | Property Physical Address | Full formatted; null for some parcels |
| `ESTFMKVALUE` | Estimated Fair Market Value | Basis for budget filter |
| `LNDVALUE` | Assessed Value of Land | Display only |
| `IMPVALUE` | Assessed Value of Improvements | Display only; 0 = no structure |
| `CNTASSDVALUE` | Total Assessed Value | Display only |
| `GISACRES` | GIS Acres | **Null for some counties** (see acreage note below) |
| `ASSDACRES` | Assessed Acres | Fallback when GISACRES is null |
| `DEEDACRES` | Deeded Acres | Second fallback |
| `PROPCLASS` | Class of Property | String: `'1'` residential, `'4'` agricultural |
| `CONAME` | County Name | Uppercase, no "COUNTY" suffix — e.g., `'DANE'` |
| `PLACENAME` | Place Name | Municipality name **with type prefix** — e.g., `'TOWN OF PERRY'`, `'CITY OF MADISON'` |
| `NETPRPTA` | Net Property Tax | Annual dollar amount |
| `LATITUDE` | Latitude | Parcel centroid latitude (WGS84) — **use instead of computing from geometry** |
| `LONGITUDE` | Longitude | Parcel centroid longitude (WGS84) — **use instead of computing from geometry** |
| `ADDNUMPREFIX` | Address Number Prefix | Address assembly fallback |
| `ADDNUM` | Address Number | Address assembly fallback |
| `ADDNUMSUFFIX` | Address Number Suffix | Address assembly fallback |
| `PREFIX` | Prefix direction | Replaces V10 `addressdir` |
| `STREETNAME` | Street Name | Address assembly fallback |
| `STREETTYPE` | Street Type | Replaces V10 `sttype` |
| `SUFFIX` | Suffix direction | Replaces V10 `sufdir` |
| `SCHOOLDIST` | School District | Name of school district — available now, future filter candidate |
| `SCHOOLDISTNO` | School District Number | Numeric ID for school district |

**Acreage filter note:** `GISACRES` is null for at least Dane and Green counties in V11. `ASSDACRES` is populated for most counties; `DEEDACRES` is the final fallback. All WHERE clause acreage comparisons must use `COALESCE(GISACRES, ASSDACRES, DEEDACRES)`:
```sql
COALESCE(GISACRES, ASSDACRES, DEEDACRES) >= 4
```
Acreage field population observed per county (sample):

| County | GISACRES | ASSDACRES | DEEDACRES |
|---|---|---|---|
| Dane | null | ✓ | ✓ |
| Green | null | ✓ | null |
| Jefferson | ✓ | ✓ | ✓ |
| Waukesha | ✓ | ✓ | 0 (use ASSDACRES) |
| Rock | ✓ | ✓ | ✓ |
| Walworth | ✓ | ✓ | ✓ |
| Columbia | ✓ | ✓ | ✓ |
| Dodge | ✓ | null | null |
| Washington | ✓ | ✓ | ✓ |

**PLACENAME format:** Includes municipality type prefix. Strip `'TOWN OF '`, `'CITY OF '`, `'VILLAGE OF '` before matching against the WI DOR table (which stores names without prefix). Example: `'TOWN OF PERRY'` → `'PERRY'` for DOR lookup.

**CONAME format:** County name only, no "COUNTY" suffix (e.g., `'DANE'`, not `'DANE COUNTY'`). Use in WHERE clause as: `CONAME IN ('DANE', 'JEFFERSON', ...)` — no `UPPER()` needed since data is already uppercase.

**LATITUDE/LONGITUDE fields:** V11 provides centroid coordinates directly as fields. For all centroid-dependent operations (map placement, neighbor distance), request these fields with `returnGeometry=false` instead of fetching polygon geometry. This enables the 32,000-record-per-page limit for neighbor queries.

*Note: `PSTLADRESS` is the owner's mailing address (where tax bills are sent), not the property address. An absentee owner will show a different `PSTLADRESS` vs. `SITEADRESS`. Confirmed against live data — cold-mail targeting via `PSTLADRESS` is viable directly from the API.*

### Secondary: FEMA National Flood Hazard Layer (NFHL)
- **Endpoint (use this):** `https://services.arcgis.com/2gdL2gxYNFY2TOUb/arcgis/rest/services/FEMA_National_Flood_Hazard_Layer/FeatureServer/0` — single-layer FeatureServer, simpler to query
- **Alternate:** `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer` Layer 28 "Flood Hazard Zones"
- Confirmed: `supportsSpatialFilter: true`, maxRecordCount 2000, supports GeoJSON output
- Query: does any part of the parcel polygon intersect a flood zone polygon?
- Display: flood zone designation (A/AE = high risk, X = minimal risk) in popup and list. Not a filter.
- **Query strategy:** One bulk spatial query per result set — pass the union envelope of all result parcels. maxRecordCount 2000 means large result sets may need tiling.

### Tertiary: USFWS National Wetlands Inventory (NWI)
- **Endpoint:** `https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer`
- Confirmed: `supportsSpatialFilter: true`, maxRecordCount 2000, supports GeoJSON output, polygon geometry
- Query: does any part of the parcel polygon intersect a wetland polygon?
- Display: "Wetlands: Yes/No" in popup and list. Not a filter.
- **Why it matters:** Wetlands cannot be built on, graded, or fenced. A parcel showing 6 usable acres may have 2–4 acres of wetland. Distinct from flood zones.
- **Query strategy:** Same bulk spatial envelope approach as FEMA. Same 2000-record tiling constraint applies.

### Initialization: Wisconsin DOR Assessment Ratios
- **Source:** Wisconsin DOR Statement of Assessment — annual Excel file download.
  - 2025 data: `https://www.revenue.wi.gov/SLFReportscotvc/2025sumagg.xlsx`
  - 2024 data: `https://www.revenue.wi.gov/SLFReportscotvc/2024sumagg.XLSX`
  - No API — server fetches the Excel file at startup and parses it using the `xlsx` npm package.
- **File structure (confirmed):** Columns: TAX YEAR, AUTH, CO-MUNI CODE (5-digit: 2-digit county + 3-digit municipality), MUNICIPALITY TYPE (T/V/C), MUNICIPALITY NAME, COUNTY NAME, MFG ADMIN, EQ ADMIN, **AGGREGATE RATIO**
- **Matching to parcel data:** Join WI DOR `MUNICIPALITY NAME` + `COUNTY NAME` → parcel `PLACENAME` (stripped of type prefix) + `CONAME` (normalize to uppercase, strip punctuation)
- **Parsing quirks discovered during build (all four must be handled):**
  1. **Embedded newline in column header:** The "AGGREGATE RATIO" column header is stored as `"AGGREGATE\r\nRATIO"` with a literal carriage-return + newline. Header detection must normalize `[\r\n]+` → space before matching.
  2. **Typo in municipality name column:** The header is `"MINUCIPALITY NAME"` (not "MUNICIPALITY NAME" — note "MINU" not "MUNI"). The common substring between the typo and the correct spelling is `"CIPALITY"`. Use regex `/CIPALITY NAME/` to match either variant.
  3. **Ratio stored as decimal, not percent:** AGGREGATE RATIO values are in the range 0–1 (e.g., `0.9647`). Multiply by 100 before storing or displaying as a percentage.
  4. **COUNTY NAME includes " COUNTY" suffix:** DOR stores `"DANE COUNTY"` but parcel `CONAME` is `"DANE"`. Strip the trailing ` COUNTY` suffix when building the municipality/county lookup key.
- **Timing:** Fetched once at server startup, held in memory. Served to frontend via `GET /init-data`.
- **Fallback:** If fetch or parse fails, all municipalities default to **95%**.
- **How it's used:**
  - **Filter input:** Pre-filled on page load with weighted average ratio across selected counties. Updates when county checkboxes change. User can override.
  - **Per-parcel display:** Each parcel's estimated market value uses its specific municipality's ratio from the DOR table — more accurate than the filter average.
- **WHERE clause:** Uses single filter input ratio (budget × ratio ÷ 100) for the `estfmkvalue` ceiling.

### Phase 1: Neighbor Distance Computation
- **Data source:** SCO ArcGIS parcel API — same endpoint already in use.
- **Method:** After all result pages are fetched, compute the bounding box of the full result set and make one additional query to the SCO API: all parcels within that bounding box with `impvalue > 0` and `returnGeometry=false`.
- **Key finding:** SCO API returns up to **32,000 records per query when `returnGeometry=false`** (vs. 2,000 with geometry). Use this for the neighbor query to minimize pagination.
- **Coordinates without geometry:** V11 provides `LATITUDE` and `LONGITUDE` fields directly (WGS84 centroid). Request these two fields with `returnGeometry=false` — no `returnCentroid=true` parameter or geometry-based centroid computation needed. This is what enables the 32,000-record-per-page limit for the neighbor query.
- **Computation:** For each result parcel, find the nearest neighbor centroid (excluding itself). Compute straight-line distance in feet and miles. Done server-side.
- **Display:** "Nearest house: X ft (Y mi)" in popup and sidebar list item. Drives the min distance filter.
- **Edge cases:** Very remote parcels with no neighbors within the bounding box — show "No nearby structures found."
- **Performance:** One bounding-box query (possibly paginated). Distance computation O(n × m) — acceptable with spatial binning for large result sets.

### Phase 1: County Assessor Databases — DECISION: Scrape county CAMA web interfaces
**Critical finding:** All 9 county FeatureServer APIs expose the same fields as the statewide SCO API. Building characteristics (bedrooms, sq ft, year built) are in each county's CAMA (Computer-Assisted Mass Appraisal) system, which is **not publicly accessible via API** in any of the 9 target counties. County GIS portals provide land/ownership data only.

**Decision: Option B — Scrape individual county CAMA web interfaces.** Each county's web-based property lookup will be reverse-engineered and scraped server-side to retrieve bedrooms, sq ft, and year built per parcel. Scrapers are brittle (break when county sites change their HTML) and county-specific. Green County may need manual fallback. Implement scraper per county during Phase 1 build; test against live county sites before wiring to the filter.

| County | Public API | Bulk Download | Bedrooms via API |
|---|---|---|---|
| Dane | ArcGIS FeatureServer (Open Data) | CSV/GeoJSON | No |
| Jefferson | ArcGIS Open Data | CSV/GeoJSON | No |
| Waukesha | ArcGIS FeatureServer (confirmed) | CSV/GeoJSON | No — field list verified |
| Green | Web viewer only | Custom request | No — manual only |
| Rock | ArcGIS via statewide | CSV/GeoJSON | No |
| Walworth | ArcGIS FeatureServer | CSV/GeoJSON | No |
| Columbia | ArcGIS Open Data | CSV/GeoJSON | No |
| Dodge | ArcGIS Open Data + Beacon | CSV/GeoJSON | No |
| Washington | ArcGIS Open Data | CSV/GeoJSON | No |

**Decision: B — Scrape individual county CAMA web interfaces** (see Section 14). One scraper per county, run server-side during the assessor enrichment pass. Brittle; treated as best-effort — parcels in counties whose scraper fails are excluded from the bedrooms filter with a per-county warning shown in the results header.

---

## 6. Filter Panel Specification

### Value Filters
| Filter | Field | Type | Default |
|---|---|---|---|
| Purchase budget | (derived) | Number input | 900,000 |
| Assessment ratio (%) | (derived) | Number input | 80 |
| *Computed max estfmkvalue* | `estfmkvalue` | *(budget × ratio ÷ 100)* | 720,000 |
| Min estimated FMV | `estfmkvalue` | Number input | 0 |
| Min GIS acres | `COALESCE(GISACRES, ASSDACRES, DEEDACRES)` | Number input | 4 |
| Max GIS acres | `COALESCE(GISACRES, ASSDACRES, DEEDACRES)` | Number input | (none) |

**Assessment ratio:** Pre-filled on page load from WI DOR data (average across selected counties). Updates when county selection changes. Editable — user can override. Used to compute the `estfmkvalue` filter ceiling. Display the derived ceiling prominently (e.g., *"Filter ceiling: $720,000"*). Tooltip: *"Pre-filled from Wisconsin DOR assessment data. Each parcel's displayed market value uses its municipality-specific ratio for accuracy."* Fallback value if DOR data unavailable: **95%**.

### Structure Filter
- Checkbox: **"Include properties with no structure (impvalue = $0)"**
- Default: **unchecked** (only show properties with a structure)
- When unchecked: adds `AND impvalue > 0` to the WHERE clause
- When checked: no impvalue filter applied (vacant land included)

### Absentee Owner Filter
- Checkbox: **"Absentee owners only"**
- Default: **unchecked**
- When checked: client-side filter — show only records where `pstladress` does not match `siteadress`
- *Note: string comparison may have edge-case mismatches due to formatting. Treat as a strong signal, not a guarantee.*

### Hide Feature
- Any parcel can be marked hidden via the [Hide this property] / [Unhide] button in its popup.
- **Persistence:** hidden state lives in `hidden.json` on disk, managed by the local server. The server loads it on startup and writes to it on every hide/unhide action. Survives browser cache clears, browser changes, and machine restarts. No localStorage used.
- **Server endpoints for hide management:**
  - `GET /hidden` — returns current array of hidden `parcelfid` values from `hidden.json`
  - `POST /hidden/:parcelfid` — adds a parcel ID to `hidden.json`
  - `DELETE /hidden/:parcelfid` — removes a parcel ID from `hidden.json`
- **On page load:** frontend fetches `/hidden` and applies hidden state immediately when results render.
- **Map appearance:** hidden parcels render at ~25% opacity in gray regardless of property class. They remain on the map as faded dots for spatial context.
- **Filter panel controls:**
  - Toggle: **"Show hidden properties"** — when off (default), hidden parcels are invisible on the map. When on, they appear faded.
  - Button: **"Clear all hidden"** — empties `hidden.json` via a `DELETE /hidden` call.
- *Rationale: hiding doesn't delete — the user may want to reconsider a parcel later, or simply confirm a faded dot was already reviewed.*

### Property Class
- Multi-select checkboxes
- Class 1 Residential: checked by default
- Class 4 Agricultural: unchecked by default, with inline warning: *"Agricultural parcels may require agricultural financing — verify with your lender."*
- Other classes available but not pre-selected

### County Checkboxes
Individual checkbox per county, all checked by default. A **"Check all / Uncheck all"** toggle sits above the list to select or clear all counties at once.

### Water Proximity
- Checkbox: **"Water-adjacent parcels only"**
- When checked: spatial filter — parcel polygon directly touches or intersects a lake, river, or stream polygon (Wisconsin DNR or USGS NHD hydrography). Physical contact only — no distance buffer.
- Default: unchecked. Intended use: run water-adjacent search first, then uncheck to expand

### Minimum Distance to Nearest House
- Number input: **"Min distance to nearest house"** with unit toggle (feet / miles), default blank (no filter)
- Applied client-side after the neighbor enrichment pass completes
- If enrichment is still loading, the filter is greyed out with a loading indicator

### Minimum Bedrooms
- Number input: **"Min bedrooms"**, default 3
- Powered by county assessor data (Phase 1 integration — see Section 5)
- Applied as a client-side filter after results are fetched and enriched with assessor data
- If assessor data is unavailable for a given county, parcels in that county are excluded from bedroom filtering and a warning is shown

### Result Display Limit
No limit dropdown. Pagination always fetches the full matching set. Clustering and Canvas rendering handle display performance regardless of result count. A progress indicator shows fetch status during pagination ("Fetching… 2,000 / ~6,400 records").

---

## 7. Pagination

The ArcGIS API returns at most 2,000 records per request. With 4+ acre residential parcels across 9 counties, the total matching set could be 5,000–10,000+. Pagination is **required in v1** — not a future feature.

Implementation: use `resultOffset` and `resultRecordCount=2000` to page through results sequentially. Show a progress indicator ("Fetching page 2 of ~5…") while loading. After all pages are retrieved, enrich with flood/wetlands data, then render.

---

## 8. Map Specification

- **Library:** Leaflet.js 1.9.4 (CDN)
- **Clustering:** Leaflet.markercluster plugin — groups nearby markers into a count circle at high zoom levels; breaks apart into individual dots as you zoom in. Handles thousands of markers without cluttering the map or losing the geographic overview.
- **Rendering:** Canvas-based markers (`L.canvas()` renderer) instead of default SVG — required for smooth performance with 5,000–10,000+ markers.
- **Basemap:** CartoDB light (`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`)
- **Default view:** Center `[43.1, -89.4]`, zoom 8 (south-central Wisconsin)
- **After search:** Auto-fit bounds to full result set

### Markers
Circle markers, centroid computed from polygon geometry (average of all coordinates). Clicking a dot opens the popup — hovering is not required.

| Property Class | Color |
|---|---|
| Class 1 Residential | Blue `#185FA5` |
| Class 2 Commercial | Green `#3B6D11` |
| Class 4 Agricultural | Amber `#BA7517` |
| Class 5 Undeveloped | Red/coral `#993C1D` |
| Other | Gray `#5F5E5A` |

**Absentee-owner parcels:** render with a white border or slightly larger radius to make them visually distinguishable without requiring a click.

**Hidden parcels:** render at low opacity (≈25%) in gray regardless of property class. Hidden state is toggled via the popup button. Remains visible on the map as a faded dot so the user retains spatial context — the property isn't gone, it's deprioritized.

### Click Popup
No hover interaction. Clicking a dot opens the popup. Clicking elsewhere closes it.

Popup contents:
- **Absentee owner badge** — prominent orange "ABSENTEE" label at top if `pstladress ≠ siteadress`
- **Hidden badge** — gray "HIDDEN" label at top if the parcel has been hidden
- Owner Name (`ownernme1` + `ownernme2` if present)
- Owner Mailing Address (`pstladress`)
- Property Address (`siteadress`)
- County / City/Town
- Estimated FMV (`estfmkvalue`) and Est. Market Value (FMV ÷ ratio) — labeled as estimate
- Bedrooms (from county assessor — blank if unavailable)
- Nearest house: shown as **"1,250 ft (0.24 mi)"** — both units always displayed. Below 500 ft shown in feet only; above 0.1 mi shown in miles to one decimal. "—" placeholder while neighbor pass is loading.
- Land Value (`lndvalue`) / Improvement Value (`impvalue`) — side by side
- GIS Acres
- Net Property Tax (annual, `netprpta`)
- Property Class
- Parcel ID
- Flood Zone (A/AE = high risk, X = minimal)
- Wetlands: Yes / No
- [Check Zillow] link — opens Zillow search for the property address in a new tab
- **[Hide this property] / [Unhide] button** — toggles hidden state for this parcel

---

## 9. UI Layout

### Panel Open
```
┌─────────────────┬──────────────────────────────────────┐
│  Left Panel  [◀]│                                      │
│                 │                                      │
│  ┌─Filter────┐  │                                      │
│  │ Budget    │↕ │           Map                        │
│  │ Acres     │  │         (Leaflet)                    │
│  │ ...       │  │                                      │
│  │ [Search]  │  │                                      │
│  └───────────┘  │                                      │
│  ══════════════ │                                      │
│  ┌─Results───┐  │                                      │
│  │1,847 · 412│↕ │                                      │
│  │Sort: FMV▲ │  │                                      │
│  │[ExportCSV]│  │                                      │
│  │─────────  │  │                                      │
│  │123 Main   │  │                                      │
│  │~$562K ✉   │  │                                      │
│  └───────────┘  │                                      │
└─────────────────┴──────────────────────────────────────┘
```

### Panel Collapsed
```
┌──┬─────────────────────────────────────────────────────┐
│[▶]│                                                    │
│   │               Map (full width)                    │
└───┴─────────────────────────────────────────────────────┘
```

### Panel Behavior
- A **collapse/expand toggle** (◀/▶ chevron) is fixed to the right edge of the left panel. When collapsed, only the toggle button remains — the map expands to fill full width.
- The panel has two **independently scrollable** sections separated by a fixed horizontal divider:
  - **Top: Filter section** — scrolls independently. Contains all filter inputs and the Search button.
  - **Bottom: Results list** — scrolls independently. Contains result count, sort toggle, Export CSV, and the property list.
- The divider is fixed at a reasonable split height (e.g., 45%/55%) so both sections are usable without manual resizing.
- The map fills the entire right side and is not page-scrollable — zoom and pan only.

---

## 10. Results Sidebar List

Located in the lower section of the left panel, below the filters. Scrollable independently of the filter section.

### Progressive Loading
Results render incrementally as each paginated batch arrives — dots appear on the map and entries appear in the sidebar list page by page. The header shows a live count: *"Loading… 2,000 of ~8,400"*.

After all pages are fetched, three enrichment passes run **in parallel**. Each fills in its values as it completes — the user does not wait for all three before seeing results:

| Pass | Fills in | Source |
|---|---|---|
| Flood + wetlands | Flood zone, wetlands fields in popup | FEMA NFHL + USFWS NWI |
| County assessor | Bedrooms field in popup and list | County assessor APIs |
| Neighbor distance | Nearest house distance in popup and list | SCO bounding-box query |

While a pass is still loading, its fields show a subtle spinner or "—" placeholder. The minimum bedrooms and minimum distance filters are greyed out until their respective passes complete.

### List Item (per property)
Each entry shows:
- Property address (`siteadress`, or assembled fallback)
- Estimated market value (FMV ÷ assessment ratio) — primary sort field
- Nearest house distance (e.g., "0.4 mi" — "—" while loading)
- **ABSENTEE** badge (orange) if `pstladress ≠ siteadress`
- Visual dimming if hidden (only visible when "Show hidden" is on)

**Interaction is bidirectional:**
- Clicking a list entry centers the map on that dot and opens its popup
- Clicking a dot on the map scrolls the sidebar list to that property and highlights its entry

### Header
- Result count and absentee count: e.g., *"1,847 results · 412 absentee"*
- Sort toggle: **Est. Market Value ▲/▼** (ascending/descending, default ascending)
- Per-county assessor status: small indicator showing which counties have bedroom data loaded
- **[Export CSV]** button — exports all currently visible (non-hidden) results with all fields: owner name, owner mailing address, property address, county, city/town, estimated FMV, estimated market value, GIS acres, net tax, improvement value, bedrooms (if available), flood zone, wetlands, parcel ID

---

## 11. Address Display Logic

When `SITEADRESS` is present, use it directly. If empty, concatenate individual fields in this order, skipping empty parts:
`ADDNUMPREFIX`, `ADDNUM`, `ADDNUMSUFFIX`, `PREFIX`, `STREETNAME`, `STREETTYPE`, `SUFFIX`

Fall back to `(no address)` if all parts are empty.

---

## 12. ArcGIS Query Parameters

| Parameter | Value |
|---|---|
| `where` | SQL WHERE clause (see below) |
| `outFields` | All fields listed in Section 5 |
| `returnGeometry` | `true` |
| `outSR` | `4326` (WGS84) |
| `f` | `geojson` |
| `resultRecordCount` | `2000` (per page) |
| `resultOffset` | `0`, `2000`, `4000`, … |
| `orderByFields` | `estfmkvalue ASC` |

### Example WHERE Clause
```sql
ESTFMKVALUE >= 0
AND ESTFMKVALUE <= 720000
AND COALESCE(GISACRES, ASSDACRES, DEEDACRES) >= 4
AND IMPVALUE > 0
AND CONAME IN ('DANE', 'JEFFERSON', 'WAUKESHA')
AND PROPCLASS = '1'
```

---

## 13. What This Tool Does NOT Do (Current Version)

| Gap | Status |
|---|---|
| Owner mailing address | **Solved** — `pstladress` confirmed in API |
| Bedrooms (filter) | Phase 1: county assessor integration required first |
| Sq ft / year built / condition | Display-only once assessor data is available; no filter planned |
| House-to-house distance | Phase 1: neighbor bounding-box query against SCO API |
| Listing status (on MLS?) | Zillow link per result; future: paid ATTOM/PropStream API |
| Zoning | Manual check with township before sending letter |
| Broadband availability | Manual check via FCC / Wisconsin broadband map |
| School district | Future feature: Wisconsin DPI report card overlay |
| Building condition | Manual triage after owner responds |
| Comparable sales data | Manual: county register of deeds records |

---

## 14. Pre-Build Research — Results

| Task | Status | Finding |
|---|---|---|
| WI DOR assessment ratios | **Resolved** | Annual Excel at `revenue.wi.gov/SLFReportscotvc/2025sumagg.xlsx`. Parse with `xlsx` npm package. CO-MUNI CODE + MUNICIPALITY NAME are the identifiers. AGGREGATE RATIO is the value column. |
| FEMA NFHL query method | **Resolved** | Use FeatureServer: `services.arcgis.com/2gdL2gxYNFY2TOUb/.../FEMA_National_Flood_Hazard_Layer/FeatureServer/0`. Confirmed `supportsSpatialFilter: true`, maxRecordCount 2000. Bulk spatial query feasible; tile for large result sets. |
| USFWS NWI query method | **Resolved** | Confirmed `supportsSpatialFilter: true`, maxRecordCount 2000, polygon geometry. Bulk spatial query feasible; same tiling approach as FEMA. |
| SCO neighbor query limits | **Resolved** | maxRecordCount 2000 with geometry, **32,000 without geometry**. Use `returnGeometry=false` for neighbor query. V11 `LATITUDE`/`LONGITUDE` fields provide centroid directly — `returnCentroid=true` not needed. |
| V11 field name migration (build-time) | **Resolved** | All field names are **uppercase** in V11 — breaking change from V10. Key renames: `PARCELID` (was `parcelfid`), `PLACENAME` (was `cityname`), `PREFIX`/`STREETTYPE`/`SUFFIX` (were `addressdir`/`sttype`/`sufdir`). `PLACENAME` includes municipality type prefix (`'TOWN OF PERRY'`) — strip prefix before DOR lookup. `GISACRES` is null for Dane and Green counties — use `COALESCE(GISACRES, ASSDACRES, DEEDACRES)` in all acreage comparisons. `CONAME` is uppercase, no suffix (`'DANE'` not `'Dane County'`). |
| County assessor bedroom data | **Resolved** | **No public API provides bedroom data for any of the 9 counties.** County FeatureServers expose only the same fields as the statewide SCO API. Bedroom data is in CAMA systems. **Decision: scrape county CAMA web interfaces (Option B).** Each county gets its own server-side scraper; failures are per-county best-effort. Green County may need manual fallback. |

---

## 15. Future Features (Phase 2 and Beyond)

- School district layer — Wisconsin DPI report card data overlaid per parcel
- Mail-merge CSV export — owner name + mailing address + property details, formatted for Word mail merge or a letter-printing service (e.g., LetterStream, PostcardMania). Define letter template first; CSV schema follows from merge fields used.
- Paid MLS listing-status API — ATTOM or PropStream (~$100–$300/month) to auto-flag listed properties
- Parcel polygon outlines instead of centroid dots
- Proximity to town / amenities filter
