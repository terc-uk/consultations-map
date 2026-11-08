#!/usr/bin/env python3
"""
Build simplified outlines of England, Wales, Scotland and Northern Ireland for the
map's "National" view. Run once; the output is static.

  reads   data/lpas.geojson                                England (local planning authorities)
          data/static/scotland-wales-councils.geojson      Scotland and Wales
          Northern Ireland local government districts      from Martin Chorley's UK-GeoJSON
                                                           (downloaded from GitHub)
  writes  data/static/nations.geojson

Run:  python scripts/build_nations.py
"""

import json
import os
import urllib.request

from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union

DATA = os.environ.get("OUT_DIR", "data")
NI_URL = "https://raw.githubusercontent.com/martinjc/UK-GeoJSON/master/json/administrative/ni/lgd.json"
SIMPLIFY = 0.004   # degrees, about 300 to 450 m
MIN_AREA = 2e-4    # drop islands and holes smaller than about 1.5 km2
COORD_DP = 3


def load(path):
    with open(path) as f:
        return json.load(f)["features"]


def union(features):
    geoms = []
    for f in features:
        g = shape(f["geometry"])
        geoms.append(g if g.is_valid else g.buffer(0))
    # a small buffer closes slivers between neighbouring areas
    return unary_union(geoms).buffer(0.002).buffer(-0.002)


def tidy(geom):
    polys = [p for p in getattr(geom, "geoms", [geom]) if p.area >= MIN_AREA]
    polys = [Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= MIN_AREA]) for p in polys]
    g = MultiPolygon(polys).simplify(SIMPLIFY, preserve_topology=True)
    return json.loads(json.dumps(mapping(g)), parse_float=lambda x: round(float(x), COORD_DP))


def main():
    england = load(os.path.join(DATA, "lpas.geojson"))
    devolved = load(os.path.join(DATA, "static", "scotland-wales-councils.geojson"))
    with urllib.request.urlopen(NI_URL, timeout=120) as r:
        ni = json.load(r)["features"]

    nations = {
        "England": union(england),
        "Wales": union([f for f in devolved if f["properties"].get("nation") == "Wales"]),
        "Scotland": union([f for f in devolved if f["properties"].get("nation") == "Scotland"]),
        "Northern Ireland": union(ni),
    }
    features = [{"type": "Feature", "properties": {"name": n}, "geometry": tidy(g)} for n, g in nations.items()]
    out = os.path.join(DATA, "static", "nations.geojson")
    with open(out, "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))
    print(f"Wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
