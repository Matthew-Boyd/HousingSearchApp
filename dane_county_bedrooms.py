"""
Dane County Bedroom Data Extractor
-----------------------------------
Reads the Wisconsin Statewide Parcel shapefile and extracts
bedroom counts for all residential parcels in Dane County.

Requirements:
    pip install geopandas pandas

Usage:
    python dane_county_bedrooms.py --shapefile path/to/your.shp
    python dane_county_bedrooms.py --shapefile path/to/your.shp --output bedrooms.csv
"""

import argparse
import sys
import geopandas as gpd
import pandas as pd


def find_bedroom_column(columns):
    """
    Searches column names for the bedroom field, which may vary slightly
    depending on the shapefile version (e.g., BEDRMS, BEDROOMS, NO_BEDRMS).
    """
    candidates = [c for c in columns if "BED" in c.upper()]
    if not candidates:
        return None
    # Prefer exact match first, then fall back to first candidate
    for name in ["BEDRMS", "BEDROOMS", "NO_BEDRMS", "NUM_BEDRMS"]:
        if name in candidates:
            return name
    return candidates[0]


def main():
    parser = argparse.ArgumentParser(description="Extract bedroom counts from a Dane County parcel shapefile.")
    parser.add_argument("--shapefile", required=True, help="Path to the .shp file")
    parser.add_argument("--output", default="dane_county_bedrooms.csv", help="Output CSV file path (default: dane_county_bedrooms.csv)")
    parser.add_argument("--residential-only", action="store_true", help="Filter to residential parcels only (excludes nulls/zeros)")
    args = parser.parse_args()

    # ── Load shapefile ──────────────────────────────────────────────────────────
    print(f"Loading shapefile: {args.shapefile}")
    try:
        gdf = gpd.read_file(args.shapefile)
    except Exception as e:
        print(f"ERROR: Could not read shapefile: {e}")
        sys.exit(1)

    print(f"  Loaded {len(gdf):,} parcels")
    print(f"  Columns: {list(gdf.columns)}\n")

    # ── Find bedroom column ─────────────────────────────────────────────────────
    bed_col = find_bedroom_column(list(gdf.columns))
    if not bed_col:
        print("ERROR: Could not find a bedroom column. Available columns:")
        for col in gdf.columns:
            print(f"  {col}")
        print("\nRe-run the script and pass the correct column name manually.")
        sys.exit(1)

    print(f"Found bedroom column: '{bed_col}'")

    # ── Build result dataframe ──────────────────────────────────────────────────
    # Keep useful identifier columns if they exist
    keep_cols = []
    for candidate in ["PARCELID", "PARCEL_ID", "PIN", "TAXPIN", "ADDRCITY", "SITUSADD",
                       "SITEADDR", "ADDRESS", "OWNER", "OWNERNAME", "PROPCLASS", "PROPTYPE"]:
        if candidate in gdf.columns:
            keep_cols.append(candidate)

    keep_cols.append(bed_col)
    df = gdf[keep_cols].copy()
    df = df.rename(columns={bed_col: "BEDROOMS"})

    # Convert to numeric, coercing any non-numeric values to NaN
    df["BEDROOMS"] = pd.to_numeric(df["BEDROOMS"], errors="coerce")

    # ── Optional: residential filter ───────────────────────────────────────────
    if args.residential_only:
        before = len(df)
        df = df[df["BEDROOMS"] > 0].dropna(subset=["BEDROOMS"])
        print(f"Filtered to residential parcels with bedrooms > 0: {len(df):,} of {before:,} parcels\n")

    # ── Summary stats ───────────────────────────────────────────────────────────
    print("── Bedroom Summary ────────────────────────────────")
    total = len(df)
    with_bedrooms = df["BEDROOMS"].notna() & (df["BEDROOMS"] > 0)
    print(f"  Total parcels:               {total:>10,}")
    print(f"  Parcels with bedroom data:   {with_bedrooms.sum():>10,}")
    print(f"  Parcels with null/zero:      {(~with_bedrooms).sum():>10,}")
    print()
    print("  Bedroom count distribution:")
    counts = df[with_bedrooms]["BEDROOMS"].value_counts().sort_index()
    for beds, n in counts.items():
        print(f"    {int(beds)} bedroom(s): {n:,}")
    print(f"\n  Mean bedrooms (where > 0):   {df.loc[with_bedrooms, 'BEDROOMS'].mean():.2f}")
    print("───────────────────────────────────────────────────\n")

    # ── Save output ─────────────────────────────────────────────────────────────
    df.to_csv(args.output, index=False)
    print(f"Saved {len(df):,} rows to: {args.output}")


if __name__ == "__main__":
    main()