# Deferred Decisions & Next Steps

Items that need resolution before or during the home purchase process. These are not tool features — they are process and strategy decisions.

---

## Cold-Mail Campaign Strategy

### Letter Content
- **Include offer amount or not?** Tradeoff: a specific dollar amount gets fewer responses but more serious ones; an expression-of-interest letter gets more responses but more tire-kickers. Decide before sending the first batch.
- **What does the letter say?** Draft a template. Key elements to decide: introduce yourself, why you want their specific property, what you're offering (certainty of close, cash-like speed with mortgage pre-approval), call to action (call/email), no obligation framing.

### Response Process
When an owner responds to a letter, you need a defined process:
1. Initial conversation — gauge seller motivation and rough price expectations
2. Property visit — schedule a walkthrough (bring a checklist)
3. Preliminary pricing — pull county assessor records + recent comparable sales to form an offer range
4. Formal offer — use Wisconsin WB-11 Offer to Purchase form (standard form, available from Wisconsin Realtors Association or a real estate attorney)
5. Due diligence — home inspection, well/septic inspection (critical for rural Wisconsin), survey if acreage boundaries are unclear
6. Closing — title company handles closing in Wisconsin; attorney reviews contract

### Legal Process
- Wisconsin requires sellers to complete a **Real Estate Condition Report** (RECR) disclosing known defects. This applies to private/off-market sales too.
- Engage a Wisconsin real estate attorney **before making a formal offer**, not after. Cost is typically $500–$1,500 for a transaction review.
- Without a buyer's agent, you are responsible for all due diligence, deadlines, and contingency management.

### Pricing an Unlisted Property
- Assessed value ≠ market value. Use recent comparable sales (county register of deeds records are public in Wisconsin) to establish comps.
- Consider hiring an independent appraiser ($400–$600) before or as a contingency in the offer.

---

## Technical / Tool Decisions

### WI DOR Assessment Ratio Data — Pre-Build Research
Confirm before writing server startup code:
- URL and format of the Wisconsin DOR Statement of Assessment data (likely at revenue.wi.gov)
- Is it a live API endpoint or an annual file download (Excel/CSV/JSON)?
- What identifier links each row to a municipality? (Municipality name, FIPS code, or other)
- Does the data include all ~1,900 Wisconsin municipalities, or only a subset?
- If it's a file download, it may need to be bundled with the project rather than fetched at runtime.

---

### County Assessor Research — CRITICAL PATH
**Must be completed before writing any code.** The bedroom filter depends entirely on county assessor data, and the implementation approach is unknown until each county's data availability is confirmed.

For each of the 9 counties (Dane, Jefferson, Waukesha, Green, Rock, Walworth, Columbia, Dodge, Washington), determine:
- Does the county expose a public REST API for assessor/property data?
- Is there a bulk data download (CSV, shapefile)?
- Is there a web-based parcel lookup that could be scraped?
- Is there no programmatic access at all (manual lookup only)?

Record the findings in a table before starting any integration work. Counties with no API will need a fallback strategy — either manual bedroom lookup during triage or exclusion from bedroom filtering.

---

### Mail-Merge CSV Export (Later Feature)
- The tool has all data needed for a mail-merge: owner name (`ownernme1`/`ownernme2`), owner mailing address (`pstladress`), property address (`siteadress`), county, acreage, estimated value.
- Export a CSV formatted for direct import into Word mail merge or a commercial letter-printing service (e.g., PostcardMania, LetterStream).
- Column order should match the merge fields in the letter template, so define the letter template first before building the export.
- Do not build until the letter template is finalized — the CSV schema depends on what merge fields the letter uses.

### MLS Listing Status
- Base tool includes a "Check Zillow" link per result (free, semi-automated).
- Full automation requires a paid data API (ATTOM, PropStream — ~$100–$300/month) that returns listing status per address.
- Upgrade to paid API when the cold-mail list is ready to send — no point paying monthly during the build phase.

### Bedrooms Filter
- Bedroom count is not in the statewide parcel API. It requires county assessor integration (see below).
- Until county assessor data is integrated, bedrooms cannot be filtered at search time.
- Triage bedrooms manually after an owner responds, using county assessor records or a walkthrough.

### County Assessor Data Integration
- Full building data (sq footage, bedrooms, year built, condition) requires county-by-county integration.
- The 9 target counties are: Dane, Jefferson, Waukesha, Green, Rock, Walworth, Columbia, Dodge, Washington.
- Each county has its own assessor database. Research needed: which counties expose a queryable API vs. require scraping vs. require manual lookup.
- This is a significant engineering effort. Assess per-county data availability before committing to scope.

### Dane County — Remaining Bedroom Gap (CAMA Cloud municipalities)

**Background:** Dane County has no county-level CAMA system. Building data is held per-municipality. Three assessor systems are in use; two are implemented:
- **AccurateAssessor** (Prolorem Dataverse API) — implemented, has bedrooms. Covers towns: Albion, Berry, Blooming Grove, Cottage Grove, Cross Plains, Deerfield, Medina, Oregon, Perry, Pleasant Springs, Primrose, and several villages.
- **City of Madison ArcGIS MapServer** — implemented, has bedrooms.
- **AssessorData.org** — not implemented for bedrooms because their public portal doesn't expose bedroom count (only sqft and year built). Covers: Town of York, Springdale, Vermont, Montrose, Roxbury, Rutland, Christiana, Vienna, Mazomanie, Middleton, Fitchburg, Sun Prairie, Dane.

**CAMA Cloud** (`camacloudtech.com`) — covers municipalities including Town of Bristol, Springfield, Westport, Burke, Cottage Grove (village), Waunakee, DeForest, Verona, and others. These are mostly villages and cities (fewer 4+ acre properties), but some rural towns are included.

**Why CAMA Cloud is blocked:** Their site is a Next.js SPA. The HTML shell loads fine, but their AWS WAF returns 403 Forbidden on all JavaScript bundle files. Without the JS executing, the API endpoint the site uses to fetch property data cannot be identified, so it can't be called directly.

**Potential workaround:** Use a headless browser (Playwright or Puppeteer) to:
1. Load the CAMA Cloud search page for a specific municipality
2. Enter a parcel number into the search form
3. Intercept the XHR/fetch network request the page makes to retrieve property data
4. Extract the API endpoint URL and parameters from that intercepted request
5. Implement a direct API call to that endpoint (bypassing the browser entirely going forward)

This is a one-time reverse-engineering task, not a permanent dependency on headless browsing. Once the API endpoint is known, a simple `fetch()` call should work.

### School District Quality Layer
- Wisconsin DPI publishes annual school report cards with district-level ratings.
- School district boundaries are available as GIS data and could be overlaid on the map.
- Planned as a future feature: show district name and report card link per parcel.

### Proximity to Town / Amenities
- No filter planned for the tool.
- Before sending a cold-mail letter, buyer should manually assess distance to nearest grocery store, hospital, and hardware store using Google Maps.
- Acceptable threshold not yet defined — decide during property triage.

### Campaign Response Tracking (Later Feature)
- Once letters are sent, you will need to track: which properties were contacted, which owners responded, which were visited, which received offers, and the outcome of each.
- Not built into the tool currently — manage via a spreadsheet for now.
- If the volume of responses warrants it, consider adding a lightweight per-parcel status column (Contacted / Responded / Visited / Offer Made / Closed / Passed) that persists between sessions using local storage or a simple JSON file.

---

## Pre-Purchase Checklist Items (Per Property)

Items marked **[AUTO]** are handled by the tool. All others require manual verification.

### Before Sending a Letter
- [ ] **[AUTO]** Flood zone status (FEMA NFHL — shown in tool)
- [ ] **[AUTO]** Wetlands presence (USFWS NWI — shown in tool)
- [ ] Not currently listed on MLS — check Zillow/Redfin; awkward to cold-mail an active listing
- [ ] Broadband/internet availability — check FCC broadband map or Wisconsin broadband office map
- [ ] Road access — paved or unpaved? Is the road publicly maintained in winter? Gravel roads with no county maintenance can be impassable.
- [ ] Distance to nearest town for daily needs (grocery, hardware, hospital) — use Google Maps

### After an Owner Responds (Before Making an Offer)
- [ ] Property visit and walkthrough
- [ ] Confirm house is stick-built (not mobile/manufactured on a non-permanent foundation — affects mortgage eligibility and resale)
- [ ] Check for active agricultural leases that run with the land — seller must disclose, but ask directly
- [ ] Check for recent parcel splits in county records — may indicate boundary disputes or subdivision activity
- [ ] Check for easements: utility corridors, shared driveways, hunting rights, road access easements — review title abstract
- [ ] Zoning confirmation — contact township directly; verify animals, outbuildings, and intended use are permitted
- [ ] Well condition and water quality test
- [ ] Septic system inspection and permit status (Wisconsin POWTS records held by county)
- [ ] HOA or deed restrictions — uncommon on rural parcels but verify in title search
- [ ] Comparable sales in the area — county register of deeds records are public; establish a price range before making an offer
