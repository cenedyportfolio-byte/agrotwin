"""Reading a ground-control-point file: the surveyed positions of the targets
laid out for a flight, as a farmer's GPS or survey software exports them.

Accepted:
- CSV (comma, semicolon or tab) with latitude / longitude in decimal degrees
  (WGS84), with or without a header, in either order (a value beyond ±90 is
  a longitude); a name and an elevation column are optional;
- CSV with projected coordinates (easting / northing — UTM, State Plane, …):
  the coordinate system as an EPSG code, from the form or from the header
  ("Easting (EPSG:6576)"); feet are converted, the elevation too;
- OpenDroneMap's gcp_list.txt (first line the coordinate system, then
  "x y z pixel_x pixel_y image [name]"): each target once, and the file is
  kept as it is for ODM itself (it already marks the targets in the photos).

Every message is written for the farmer who exported the file.
"""

from __future__ import annotations

import csv
import io
import math
import re
from dataclasses import dataclass, field

NAME_COLS = ("name", "id", "point", "pointname", "pointid", "label", "target", "gcp", "station", "pt", "description")
LAT_COLS = ("lat", "latitude")
LON_COLS = ("lon", "long", "lng", "longitude")
EAST_COLS = ("easting", "east", "x", "e")
NORTH_COLS = ("northing", "north", "y", "n")
ELEV_COLS = ("elevation", "elev", "ele", "height", "h", "alt", "altitude", "z", "ellipsoidalheight",
             "orthometricheight", "ellipsoidheight", "heightft", "elevationft", "altft", "elevft")
FEET_M = 0.3048
_FEET = re.compile(r"(\bft\b|feet|foot|_ft\b)", re.IGNORECASE)
_EPSG = re.compile(r"EPSG\D{0,3}(\d{4,6})", re.IGNORECASE)
_UTM_WORDS = re.compile(r"WGS\s*84\s+UTM\s+(\d{1,2})\s*([NS])", re.IGNORECASE)


class GcpFileError(ValueError):
    """The file cannot be read as ground control points; the message says why and what to do."""


@dataclass
class SurveyedPoint:
    name: str
    lat: float
    lon: float
    elevation_m: float | None = None


@dataclass
class GcpFile:
    points: list[SurveyedPoint]
    format: str  # csv-latlon | csv-projected | odm
    crs: str  # the file's coordinate system, e.g. EPSG:4326
    odm_observations: int = 0  # target marks in photos (ODM files only)
    notes: list[str] = field(default_factory=list)


def _num(s: str) -> float | None:
    s = s.strip().replace("−", "-")
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _key(header: str) -> str:
    """'Easting (EPSG:6576) [ftUS]' -> 'easting'."""
    return re.sub(r"[^a-z]", "", re.sub(r"[\(\[].*?[\)\]]", "", header.lower()))


def _crs(code: str):
    from rasterio.crs import CRS
    from rasterio.errors import CRSError

    try:
        return CRS.from_user_input(code)
    except CRSError as exc:
        raise GcpFileError(f"“{code}” is not a coordinate system AgroTwin knows. Use its EPSG number, "
                           "e.g. 6576 for Tennessee State Plane (US feet) or 32616 for UTM zone 16N.") from exc


def _crs_from_text(text: str) -> str | None:
    if m := _EPSG.search(text):
        return f"EPSG:{m.group(1)}"
    if m := _UTM_WORDS.search(text):
        return f"EPSG:{(32600 if m.group(2).upper() == 'N' else 32700) + int(m.group(1))}"
    if "+proj=" in text:
        return text[text.index("+proj="):].strip()
    return None


def _to_wgs84(crs_code: str, xs: list[float], ys: list[float], zs: list[float | None]):
    from rasterio.warp import transform

    crs = _crs(crs_code)
    if not crs.is_projected:
        return xs, ys, zs, None  # geographic already: x = lon, y = lat
    lons, lats = transform(crs, "EPSG:4326", xs, ys)
    unit, factor = crs.linear_units_factor
    note = None
    if abs(factor - 1.0) > 1e-9:
        # a file in feet gives its elevations in the same feet
        zs = [z * factor if z is not None else None for z in zs]
        note = f"Coordinates and elevations converted from {unit} units."
    return list(lons), list(lats), zs, note


def _unique_names(points: list[SurveyedPoint]) -> list[SurveyedPoint]:
    seen: dict[str, int] = {}
    for p in points:
        n = seen.get(p.name, 0)
        seen[p.name] = n + 1
        if n:
            p.name = f"{p.name} ({n + 1})"
    return points


def _check(points: list[SurveyedPoint]) -> list[SurveyedPoint]:
    if not points:
        raise GcpFileError("No points found. The file needs one line per target with its position.")
    for p in points:
        if not (-90 <= p.lat <= 90 and -180 <= p.lon <= 180):
            raise GcpFileError(f"{p.name}: {p.lat}, {p.lon} is not a position on Earth — check the coordinate system.")
    return _unique_names(points)


# --- OpenDroneMap gcp_list.txt ----------------------------------------------


def _parse_odm(lines: list[str]) -> GcpFile:
    crs_code = _crs_from_text(lines[0])
    if crs_code is None:
        raise GcpFileError("The first line of an OpenDroneMap GCP file must name the coordinate system "
                           "(e.g. “EPSG:32616” or “WGS84 UTM 16N”).")
    by_name: dict[str, tuple[float, float, float | None]] = {}
    marks = 0
    for i, line in enumerate(lines[1:], start=2):
        parts = line.split()
        if len(parts) < 6:
            raise GcpFileError(f"Line {i}: expected “x y z pixel_x pixel_y photo [name]”, found “{line[:60]}”.")
        x, y, z = _num(parts[0]), _num(parts[1]), _num(parts[2])
        if x is None or y is None:
            raise GcpFileError(f"Line {i}: “{parts[0]} {parts[1]}” are not coordinates.")
        marks += 1
        name = parts[6] if len(parts) > 6 else f"{x:.2f} {y:.2f}"
        by_name.setdefault(name, (x, y, z))
    names = list(by_name)
    xs = [by_name[n][0] for n in names]
    ys = [by_name[n][1] for n in names]
    lons, lats, zs, note = _to_wgs84(crs_code, xs, ys, [by_name[n][2] for n in names])
    points = [SurveyedPoint(n, la, lo, z) for n, la, lo, z in zip(names, lats, lons, zs)]
    return GcpFile(_check(points), "odm", crs_code, marks, [note] if note else [])


# --- CSV ----------------------------------------------------------------------


def _find(headers: list[str], names: tuple[str, ...]) -> int | None:
    keys = [_key(h) for h in headers]
    for want in names:
        if want in keys:
            return keys.index(want)
    return None


def _parse_csv(text: str, epsg: str | None, near: tuple[float, float] | None) -> GcpFile:
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)]
    rows = [r for r in rows if not r[0].lstrip().startswith("#")]
    if not rows:
        raise GcpFileError("The file is empty.")

    first = rows[0]
    has_header = sum(1 for c in first if _num(c) is None) >= max(2, len(first) - 1) or \
        any(_key(c) in LAT_COLS + LON_COLS + EAST_COLS + NORTH_COLS for c in first)
    headers = first if has_header else []
    body = rows[1:] if has_header else rows
    crs_code = epsg and (f"EPSG:{epsg.strip()}" if epsg.strip().isdigit() else epsg.strip())
    crs_code = crs_code or (_crs_from_text(" ".join(headers)) if headers else None)

    i_name = _find(headers, NAME_COLS) if headers else None
    i_lat, i_lon = (_find(headers, LAT_COLS), _find(headers, LON_COLS)) if headers else (None, None)
    i_e, i_n = (_find(headers, EAST_COLS), _find(headers, NORTH_COLS)) if headers else (None, None)
    i_z = _find(headers, ELEV_COLS) if headers else None
    projected_cols = i_lat is None and i_e is not None and i_n is not None

    if not headers or (i_lat is None and not projected_cols):
        # no usable header: the numeric columns, in order, are the position (and elevation)
        numeric = [j for j in range(len(body[0])) if _num(body[0][j]) is not None]
        if len(numeric) < 2:
            raise GcpFileError("Could not find the coordinates. Give the file a header line, e.g. "
                               "“name,latitude,longitude,elevation”.")
        texts = [j for j in range(len(body[0])) if j not in numeric]
        i_name = i_name if i_name is not None else (texts[0] if texts else None)
        a, b = numeric[0], numeric[1]
        i_z = numeric[2] if len(numeric) > 2 else None
        va = [_num(r[a]) for r in body if len(r) > b]
        vb = [_num(r[b]) for r in body if len(r) > b]
        if any(v is None or abs(v) > 180 for v in va + vb):
            i_e, i_n, i_lat, i_lon, projected_cols = a, b, None, None, True
        elif any(abs(v) > 90 for v in va):  # a longitude first
            i_lon, i_lat = a, b
        elif any(abs(v) > 90 for v in vb):
            i_lat, i_lon = a, b
        elif near is not None:
            # both orders are positions on Earth (in the US a longitude like -85 is within ±90):
            # the one at the flight is right
            lat_first = distance_m(va[0], vb[0], *near) <= distance_m(vb[0], va[0], *near)
            i_lat, i_lon = (a, b) if lat_first else (b, a)
        else:
            i_lat, i_lon = a, b

    names, xs, ys, zs = [], [], [], []
    for k, r in enumerate(body, start=2 if has_header else 1):
        get = lambda j: _num(r[j]) if j is not None and j < len(r) else None  # noqa: E731
        x = get(i_e if projected_cols else i_lon)
        y = get(i_n if projected_cols else i_lat)
        if x is None or y is None:
            raise GcpFileError(f"Line {k}: the position is missing or not a number.")
        xs.append(x)
        ys.append(y)
        zs.append(get(i_z))
        names.append((r[i_name].strip() if i_name is not None and i_name < len(r) else "") or f"Point {len(names) + 1}")

    notes = []
    if headers and i_z is not None and _FEET.search(headers[i_z]):
        zs = [z * FEET_M if z is not None else None for z in zs]
        notes.append("Elevations converted from feet.")
    if projected_cols:
        if all(abs(x) <= 180 for x in xs) and all(abs(y) <= 90 for y in ys):
            fmt, crs_code = "csv-latlon", "EPSG:4326"  # "x/y" columns holding degrees
        elif not crs_code:
            raise GcpFileError("These look like easting/northing coordinates (UTM or State Plane). Enter the "
                               "coordinate system's EPSG code — e.g. 6576 for Tennessee State Plane in US feet.")
        else:
            fmt = "csv-projected"
        xs, ys, zs, note = _to_wgs84(crs_code, xs, ys, zs)
        if note:
            notes.append(note)
    else:
        fmt, crs_code = "csv-latlon", "EPSG:4326"
    points = [SurveyedPoint(n, la, lo, z) for n, la, lo, z in zip(names, ys, xs, zs)]
    return GcpFile(_check(points), fmt, crs_code, 0, notes)


def parse(raw: bytes, epsg: str | None = None, near: tuple[float, float] | None = None) -> GcpFile:
    """Reads the file (see the module docstring); GcpFileError with a plain reason
    otherwise. `near` (lat, lon of the flight) settles a header-less file whose
    columns could be latitude-longitude either way round."""
    if len(raw) > 2_000_000:
        raise GcpFileError("This file is too big for a list of ground control points.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        raise GcpFileError("The file is empty.")
    head = lines[0]
    looks_odm = (_crs_from_text(head) is not None and _num(head.split()[0]) is None and len(lines) > 1
                 and len(lines[1].split()) >= 6 and "," not in lines[1] and ";" not in lines[1])
    return _parse_odm(lines) if looks_odm else _parse_csv("\n".join(lines), epsg, near)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dn = math.radians(lat2 - lat1) * 6371000.0
    de = math.radians(lon2 - lon1) * 6371000.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(de, dn)


def check_near(points: list[SurveyedPoint], lat: float, lon: float, limit_m: float = 3000.0) -> None:
    """The points must be at the flight: a typical sign of swapped columns or the
    wrong coordinate system is a point kilometres (or a continent) away."""
    far = max(points, key=lambda p: distance_m(p.lat, p.lon, lat, lon))
    d = distance_m(far.lat, far.lon, lat, lon)
    if d > limit_m:
        where = f"{d / 1000:.0f} km" if d < 1_000_000 else "very far"
        raise GcpFileError(f"{far.name} is {where} from where the photos were taken — check the coordinate "
                           "system (EPSG code) and that latitude and longitude are not swapped.")
