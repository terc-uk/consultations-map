#!/usr/bin/env python3
"""
Build combined authority (strategic authority) boundaries for the map's
"Combined authorities" view.

  reads   data/lpas.geojson                       local planning authority boundaries
          data/static/strategic-authorities.csv   which LPAs make up each authority
  writes  data/strategic-authorities.geojson

Boundaries are made by joining the member LPA areas. National park authorities are
separate LPAs in the boundary data, so their land would otherwise leave holes. Each
national park is split between the councils around it (each part goes to the nearest
council), which approximates the real council boundaries inside the park. A national
park listed directly in an authority's `members` column is included whole instead.

Run:  python scripts/build_strategic_areas.py
"""

import csv
import json
import os
import sys

from shapely.geometry import MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

DATA = os.environ.get("OUT_DIR", "data")
CELL = 0.01          # grid size in degrees used to split national parks (about 0.7 x 1.1 km)
SIMPLIFY = 0.002     # degrees
COORD_DP = 4


def is_park(name):
    n = name.lower()
    return "national park" in n or "broads authority" in n


def tidy(geom, min_area=1e-4):
    """Drop slivers: holes and fragments smaller than min_area square degrees (about 0.7 km2)."""
    polys = getattr(geom, "geoms", [geom])
    kept = [
        Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= min_area])
        for p in polys if p.area >= min_area
    ]
    return kept[0] if len(kept) == 1 else MultiPolygon(kept)


def main():
    with open(os.path.join(DATA, "lpas.geojson")) as f:
        lpas = json.load(f)["features"]
    with open(os.path.join(DATA, "static", "strategic-authorities.csv"), encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    geoms, names = {}, {}
    for feat in lpas:
        code = feat["properties"]["code"]
        g = shape(feat["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        geoms[code] = g
        names[code] = feat["properties"]["name"].removesuffix(" LPA")

    parks = [c for c in geoms if is_park(names[c])]
    councils = [c for c in geoms if c not in parks]
    tree = STRtree([geoms[c] for c in councils])

    # Split each park between its neighbouring councils
    park_pieces = {}  # council code -> list of geometries
    for p in parks:
        park = geoms[p]
        minx, miny, maxx, maxy = park.bounds
        cells = {}
        y = miny
        while y < maxy:
            x = minx
            while x < maxx:
                cell = box(x, y, x + CELL, y + CELL)
                if cell.intersects(park):
                    idx = tree.nearest(cell.centroid)
                    cells.setdefault(councils[idx], []).append(cell)
                x += CELL
            y += CELL
        for code, cs in cells.items():
            piece = unary_union(cs).intersection(park)
            if not piece.is_empty:
                park_pieces.setdefault(code, []).append(piece)

    features, missing = [], []
    for row in rows:
        members = [m.strip() for m in row["members"].split(";") if m.strip()]
        parts = []
        for m in members:
            if m not in geoms:
                missing.append(f"{row['id']}: {m}")
                continue
            parts.append(geoms[m])
            if m not in parks:
                parts.extend(park_pieces.get(m, []))
        if not parts:
            print(f"  skipping {row['id']}: no boundaries found")
            continue
        # a small buffer out and back closes slivers left between simplified LPA edges
        geom = unary_union(parts).buffer(0.0008).buffer(-0.0008)
        geom = tidy(geom.simplify(SIMPLIFY, preserve_topology=True))
        gj = json.loads(json.dumps(mapping(geom)), parse_float=lambda v: round(float(v), COORD_DP))
        features.append({
            "type": "Feature",
            "properties": {
                "id": row["id"],
                "name": row["name"],
                "members": members,
                "member_names": [names.get(m, m) for m in members],
            },
            "geometry": gj,
        })

    if missing:
        print("  member codes not found in lpas.geojson:\n    " + "\n    ".join(missing))
    if not features:
        sys.exit("No strategic authority boundaries were built.")

    out = os.path.join(DATA, "strategic-authorities.geojson")
    with open(out + ".tmp", "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    os.replace(out + ".tmp", out)
    print(f"Wrote {len(features)} strategic authority boundaries to {out}")


if __name__ == "__main__":
    main()
