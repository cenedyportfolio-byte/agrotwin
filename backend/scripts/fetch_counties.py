#!/usr/bin/env python3
"""Downloads the US county boundaries once — the Census Bureau's cartographic
boundary file (public domain, 1:500,000) — and keeps a compact copy for
county_service, which then finds each field's county on this server without
asking any outside service.

    python -m scripts.fetch_counties            # the latest year that works
    python -m scripts.fetch_counties --year 2024

Writes AGROTWIN_COUNTIES_FILE (default data/reference/us_counties.json.gz,
about 2 MB). Needs the internet once; run again only to update.
"""

import argparse
import gzip
import io
import json
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shapely.geometry import LinearRing, Polygon, mapping  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

from app.config import settings  # noqa: E402

URL = "https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_us_county_500k.zip"
SIMPLIFY_DEG = 0.0002  # about 20 m: plenty for telling which county a field is in


def read_dbf(data: bytes) -> list[dict]:
    """The attribute table of a shapefile (dBASE III)."""
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for i in range(count):
        rec = data[header_len + i * record_len:header_len + (i + 1) * record_len]
        if rec[:1] == b"*":  # deleted
            rows.append(None)
            continue
        row, off = {}, 1
        for name, length in fields:
            row[name] = rec[off:off + length].decode("utf-8", "replace").strip()
            off += length
        rows.append(row)
    return rows


def read_shp(data: bytes) -> list[list[list[tuple[float, float]]]]:
    """The rings of each polygon record of a shapefile."""
    out, pos = [], 100
    while pos + 8 <= len(data):
        _, words = struct.unpack(">ii", data[pos:pos + 8])
        content = data[pos + 8:pos + 8 + words * 2]
        pos += 8 + words * 2
        shape_type = struct.unpack("<i", content[:4])[0]
        if shape_type == 0:
            out.append([])
            continue
        if shape_type not in (5, 15, 25):
            raise ValueError(f"not a polygon shapefile (shape type {shape_type})")
        n_parts, n_points = struct.unpack("<ii", content[36:44])
        parts = list(struct.unpack(f"<{n_parts}i", content[44:44 + 4 * n_parts]))
        base = 44 + 4 * n_parts
        coords = struct.unpack(f"<{2 * n_points}d", content[base:base + 16 * n_points])
        points = list(zip(coords[0::2], coords[1::2]))
        out.append([points[a:b] for a, b in zip(parts, [*parts[1:], n_points])])
    return out


def county_shape(rings: list[list[tuple[float, float]]]):
    """Outer rings run clockwise in a shapefile, holes (towns that are not part
    of the county, e.g. Virginia's independent cities) counter-clockwise."""
    outers, holes = [], []
    for ring in rings:
        if len(ring) < 4:
            continue
        (holes if LinearRing(ring).is_ccw else outers).append(Polygon(ring).buffer(0))
    shape = unary_union(outers)
    return shape.difference(unary_union(holes)) if holes else shape


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None)
    args = ap.parse_args()
    years = [args.year] if args.year else [2024, 2023]
    raw = None
    for year in years:
        url = URL.format(year=year)
        print(f"downloading {url}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AgroTwin/1.1"})
            with urllib.request.urlopen(req, timeout=120) as res:
                raw = res.read()
            break
        except OSError as exc:
            print(f"  not available: {exc}")
    if raw is None:
        sys.exit("No county file could be downloaded.")
    zf = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n[:-4] for n in zf.namelist() if n.endswith(".shp"))
    rows = read_dbf(zf.read(name + ".dbf"))
    shapes = read_shp(zf.read(name + ".shp"))
    counties = []
    for row, rings in zip(rows, shapes):
        if not row or not rings:
            continue
        geom = county_shape(rings).simplify(SIMPLIFY_DEG, preserve_topology=True)
        if geom.is_empty:
            continue
        g = mapping(geom)
        g["coordinates"] = json.loads(json.dumps(g["coordinates"]), parse_float=lambda v: round(float(v), 5))
        counties.append({"n": row.get("NAMELSAD") or row.get("NAME"), "s": row.get("STUSPS"), "id": row.get("GEOID"), "g": g})
    out = settings.counties_file
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(counties, f, separators=(",", ":"))
    tmp.replace(out)
    print(f"{len(counties)} counties -> {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
