"""A field outline from a flight-plan file: the area a pilot drew for a mapping
mission — DJI Pilot 2 keeps it in the mission's KMZ (wpmz/template.kml) — or an
outline another app exports as KML/KMZ (Google Earth, farm-management software).
It replaces the outline estimated around the camera positions, so the acres and
the health shares are measured on the real field.

Every message is written for the pilot or farmer who chose the file.
"""

from __future__ import annotations

import io
import math
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from shapely.geometry import MultiPolygon, Point, Polygon

from app.config import settings

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_UNZIPPED_BYTES = 50 * 1024 * 1024
MIN_AREA_M2 = 400  # about 0.1 acre: smaller is not a field
MAX_AREA_M2 = 40_000_000  # about 10,000 acres
NEAR_M = 300  # photos this close to the outline count as taken over the field
FAR_FROM_FIELD_M = 5000
EARTH_RADIUS_M = 6371000.0
M2_PER_ACRE = 4046.86


def flight_plan_dir(field_id: str) -> Path:
    """Where a field's flight-plan file is kept."""
    return settings.data_dir / "fields" / field_id


class BoundaryFileError(ValueError):
    """The file cannot be used; the message says why, in plain words."""


@dataclass
class Boundary:
    geometry: dict  # GeoJSON Polygon in longitude/latitude (WGS84)
    area_hectares: float
    center_lat: float
    center_lon: float
    kind: str  # "DJI mapping mission" or "KML outline"
    notes: list[str] = field(default_factory=list)

    @property
    def acres(self) -> float:
        return self.area_hectares * 10_000 / M2_PER_ACRE


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _documents(raw: bytes) -> list[tuple[str, bytes]]:
    """The KML documents in the file. A KMZ is a zip of them; DJI's drawn area
    (wpmz/template.kml) comes before its flight route (waylines.wpml)."""
    if raw[:4] != b"PK\x03\x04":
        return [("file", raw)]
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise BoundaryFileError("This KMZ file is damaged. Export the flight plan again.") from exc
    entries = [i for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith((".kml", ".wpml"))]
    if not entries:
        raise BoundaryFileError("This KMZ has no map data in it (no KML inside).")
    if sum(i.file_size for i in entries) > MAX_UNZIPPED_BYTES:
        raise BoundaryFileError("This KMZ is too large to be a flight plan.")
    entries.sort(key=lambda i: (not i.filename.lower().endswith("template.kml"), i.filename.lower().endswith(".wpml"), i.filename))
    return [(i.filename, zf.read(i)) for i in entries]


def _points(text: str | None) -> list[tuple[float, float]]:
    """KML coordinates ("lon,lat[,alt] lon,lat[,alt] …") without repeats."""
    out: list[tuple[float, float]] = []
    for token in (text or "").split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            continue
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise BoundaryFileError(
                "The outline's coordinates are not latitude/longitude. Export it in WGS84, the usual GPS format."
            )
        if not out or (lon, lat) != out[-1]:
            out.append((lon, lat))
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def _ring_text(polygon_el, boundary_tag: str) -> list[str]:
    texts = []
    for b in polygon_el:
        if _local(b.tag) != boundary_tag:
            continue
        for el in b.iter():
            if _local(el.tag) == "coordinates":
                texts.append(el.text or "")
    return texts


def _flat(points, lat0: float, lon0: float) -> list[tuple[float, float]]:
    k = math.cos(math.radians(lat0))
    return [(math.radians(lon - lon0) * k * EARTH_RADIUS_M, math.radians(lat - lat0) * EARTH_RADIUS_M) for lon, lat in points]


def _polygon(outer, holes) -> Polygon | None:
    """A valid polygon (a crossed outline is untangled), or None."""
    if len(outer) < 3:
        return None
    poly = Polygon(outer, [h for h in holes if len(h) >= 3])
    if not poly.is_valid:
        fixed = poly.buffer(0)
        if isinstance(fixed, MultiPolygon):
            fixed = max(fixed.geoms, key=lambda g: g.area)
        poly = fixed
    return poly if isinstance(poly, Polygon) and not poly.is_empty else None


def _area_m2(poly: Polygon) -> float:
    c = poly.centroid
    outer = Polygon(_flat(poly.exterior.coords, c.y, c.x), [_flat(r.coords, c.y, c.x) for r in poly.interiors])
    return outer.area


def parse(raw: bytes) -> Boundary:
    """The field outline in a flight-plan file (KMZ or KML). Raises BoundaryFileError."""
    if not raw:
        raise BoundaryFileError("The file is empty.")
    if len(raw) > MAX_FILE_BYTES:
        raise BoundaryFileError("This file is too large to be a flight plan (over 20 MB).")

    polygons: list[Polygon] = []
    route_only = False
    dji = False
    for name, data in _documents(raw):
        try:
            root = SafeET.fromstring(data)
        except (SafeET.ParseError, DefusedXmlException, ValueError) as exc:
            raise BoundaryFileError("This is not a KML or KMZ flight plan; it could not be read.") from exc
        in_polygon: set[int] = set()
        for el in root.iter():
            tag = _local(el.tag)
            if isinstance(el.tag, str) and "dji.com/wpmz" in el.tag:
                dji = True
            if tag == "templateType" and (el.text or "").strip().lower().startswith("waypoint"):
                route_only = True
            elif tag == "Polygon":
                for sub in el.iter():
                    in_polygon.add(id(sub))
                outer = [_points(t) for t in _ring_text(el, "outerBoundaryIs")]
                holes = [_points(t) for t in _ring_text(el, "innerBoundaryIs")]
                if outer:
                    poly = _polygon(outer[0], holes)
                    if poly is not None:
                        polygons.append(poly)
        # some apps (sprayers, GIS) draw the field edge as a closed line — but
        # the lines in a DJI route file (.wpml) are the flight path, never the field
        if name.lower().endswith(".wpml"):
            continue
        for el in root.iter():
            if _local(el.tag) in ("LineString", "LinearRing") and id(el) not in in_polygon:
                coords = next((c for c in el.iter() if _local(c.tag) == "coordinates"), None)
                text = coords.text if coords is not None else ""
                raw_pts = [t for t in (text or "").split() if "," in t]
                if len(raw_pts) >= 4 and raw_pts[0] == raw_pts[-1]:
                    poly = _polygon(_points(text), [])
                    if poly is not None:
                        polygons.append(poly)

    if not polygons:
        if route_only:
            raise BoundaryFileError(
                "This flight plan is a waypoint route, not an area. Use the mapping mission's KMZ (the area you drew for the flight)."
            )
        raise BoundaryFileError("No field outline found in this file. It needs an area (polygon), such as the one drawn for a mapping mission.")

    areas = [_area_m2(p) for p in polygons]
    best = max(range(len(polygons)), key=lambda i: areas[i])
    poly, area = polygons[best], areas[best]
    notes: list[str] = []
    if len(polygons) > 1:
        notes.append(f"The file has {len(polygons)} outlines; the largest ({area / M2_PER_ACRE:.1f} acres) is used.")
    if area < MIN_AREA_M2:
        raise BoundaryFileError("This outline is too small to be a field (under a tenth of an acre).")
    if area > MAX_AREA_M2:
        raise BoundaryFileError("This outline is too large to be one field (over 10,000 acres). Is it the right file?")

    c = poly.centroid
    return Boundary(
        geometry={
            "type": "Polygon",
            "coordinates": [[[round(x, 7), round(y, 7)] for x, y in ring.coords] for ring in (poly.exterior, *poly.interiors)],
        },
        area_hectares=round(area / 10_000, 4),
        center_lat=c.y,
        center_lon=c.x,
        kind="DJI mapping mission" if dji else "KML outline",
        notes=notes,
    )


def _distance_text(m: float) -> str:
    miles = m / 1609.34
    return f"{miles:.1f} miles" if miles >= 0.5 else f"{m * 3.28084:,.0f} ft"


def check_near(boundary: Boundary, photos: list[tuple[float, float]], field_center: tuple[float, float] | None) -> None:
    """The outline must be where the field is: most of the flight's photos
    (lon, lat) over it, or — before any photos — near the field's earlier
    position (lat, lon). Raises BoundaryFileError otherwise."""
    lat0, lon0 = boundary.center_lat, boundary.center_lon
    ring = boundary.geometry["coordinates"]
    flat = Polygon(_flat(ring[0], lat0, lon0), [_flat(r, lat0, lon0) for r in ring[1:]])
    if photos:
        pts = [Point(xy) for xy in _flat(photos, lat0, lon0)]
        near = flat.buffer(NEAR_M)
        if sum(near.contains(p) for p in pts) < 0.5 * len(pts):
            mid = Point(sum(p.x for p in pts) / len(pts), sum(p.y for p in pts) / len(pts))
            raise BoundaryFileError(
                f"This outline is {_distance_text(flat.distance(mid))} from where the photos were taken. Is it the flight plan for this field?"
            )
    elif field_center is not None:
        (x, y), = _flat([(field_center[1], field_center[0])], lat0, lon0)
        d = flat.distance(Point(x, y))
        if d > FAR_FROM_FIELD_M:
            raise BoundaryFileError(f"This outline is {_distance_text(d)} from this field. Is it the right file?")

