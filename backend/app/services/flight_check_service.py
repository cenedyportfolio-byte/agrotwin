"""How a flight was flown, read from its photos' own data: the height and the
ground detail it gives, the camera angle, the front and side overlap, the sun's
height, GPS/RTK, the crop-health bands, the days the photos are from and — with
a flight-plan outline — how much of the field is in the photos.

The limits are in app.config (flight_*) and default to the flight guide
(frontend/app/flight-guide): 100 ft, 80 % front / 75 % side overlap, camera
straight down, near midday. A flagged item is advice for the next flight; it
never stops processing. Every message is written for the farmer.

Overlap is measured, not read from the flight app: the photo positions give the
spacing along each flight line and between lines, and the height, the image
size and the calibrated focal length give each photo's footprint on the ground.
DJI Pilot 2 plans a Mavic 3 Multispectral mission on the photo (RGB) camera, so
that camera is the one measured; the crop-health bands are placed with the
same cameras when the detailed map is made.
"""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shapely.geometry import Polygon, shape
from shapely.ops import unary_union

from app.config import settings
from app.services.metadata_service import read_dji_xmp

EARTH_RADIUS_M = 6371000.0
FT_PER_M = 3.28084
M2_PER_ACRE = 4046.86
MS_BANDS = ("GREEN", "RED", "RED_EDGE", "NIR")
NADIR_PITCH = -90.0
ALONG_TOLERANCE_DEG = 20  # a step this close to the flight lines' direction is along a line
MIN_LINE_PHOTOS = 3
MIN_PHOTOS_FOR_OVERLAP = 10


@dataclass
class Item:
    key: str
    label: str
    status: str  # ok | warn | info
    value: str
    target: str | None = None
    message: str | None = None


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _flat(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    return (
        math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M,
        math.radians(lat - lat0) * EARTH_RADIUS_M,
    )


def _axis_dev(angle: float, axis: float) -> float:
    """Degrees between a direction and an axis, ignoring which way along it (0–90)."""
    d = (angle - axis) % 180
    return min(d, 180 - d)


def _clock(t: datetime) -> str:
    return t.strftime("%I:%M %p").lstrip("0").lower()


def _span(first: datetime | None, last: datetime | None) -> str:
    """'2:37–3:00 pm' for the flight's first and last photo."""
    if not first or not last:
        return _clock(first or last) if first or last else ""
    a, b = _clock(first), _clock(last)
    if a == b:
        return a
    return f"{a[:-3] if a[-2:] == b[-2:] else a}–{b}"


# ── the sun ──────────────────────────────────────────────────────────────────


def sun_elevation_deg(utc: datetime, lat: float, lon: float) -> float:
    """The sun's height above the horizon (NOAA's general solar position
    formulas, good to about half a degree)."""
    doy = utc.timetuple().tm_yday
    hour = utc.hour + utc.minute / 60 + utc.second / 3600
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                       - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    solar_minutes = hour * 60 + eqtime + 4 * lon
    ha = math.radians(solar_minutes / 4 - 180)
    phi = math.radians(lat)
    cos_zenith = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha)
    return 90 - math.degrees(math.acos(max(-1.0, min(1.0, cos_zenith))))


def _parse_time(text) -> datetime | None:
    if isinstance(text, (list, tuple)):
        text = text[0] if text else None
    if not text:
        return None
    try:
        return datetime.fromisoformat(str(text).strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def photo_utc(path: Path, captured_at: datetime | None, lon: float) -> tuple[datetime | None, bool]:
    """(UTC time the photo was taken, exact?). DJI writes the UTC time and the
    local time with its offset in the photo's XMP. Without them the camera
    clock is taken as local time and the time zone guessed from the longitude
    (with summer time in April–October), so the sun's height is approximate."""
    xmp = read_dji_xmp(path)
    utc = _parse_time(xmp.get("UTCAtExposure"))
    if utc is not None:
        return (utc if utc.tzinfo is None else utc.astimezone(timezone.utc).replace(tzinfo=None)), True
    local = _parse_time(xmp.get("CreateDate"))
    if local is not None and local.tzinfo is not None:
        return local.astimezone(timezone.utc).replace(tzinfo=None), True
    if captured_at is None:
        return None, False
    offset_h = round(lon / 15) + (1 if 4 <= captured_at.month <= 10 else 0)
    return captured_at - timedelta(hours=offset_h), False


# ── overlap ──────────────────────────────────────────────────────────────────


def _flight_lines(xy: list[tuple[float, float]]) -> tuple[float | None, float | None, list[float]]:
    """(direction of the flight lines in degrees from north, median spacing
    between photos along a line in metres, cross-line position of each line).
    xy: photo positions in the order they were taken."""
    steps = []
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        if d > 0.3:
            steps.append((d, math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360))
    if len(steps) < MIN_PHOTOS_FOR_OVERLAP - 1:
        return None, None, []
    # the lines' direction: the most travelled 5° sector (a criss-cross grid has two)
    bins = [0.0] * 36
    for d, h in steps:
        bins[int(h % 180 // 5)] += d
    peak = max(range(36), key=lambda i: bins[i]) * 5 + 2.5
    near = [(d, h % 180) for d, h in steps if _axis_dev(h, peak) <= 10]
    s = sum(d * math.sin(math.radians(2 * h)) for d, h in near)
    c = sum(d * math.cos(math.radians(2 * h)) for d, h in near)
    axis = (math.degrees(math.atan2(s, c)) / 2) % 180

    along = [d for d, h in steps if _axis_dev(h, axis) <= ALONG_TOLERANCE_DEG]
    if not along:
        return axis, None, []
    spacing = statistics.median(along)

    # a line: consecutive photos stepping the same way along the axis
    ux, uy = math.sin(math.radians(axis)), math.cos(math.radians(axis))
    lines: list[float] = []
    run = [xy[0]]
    way = 0
    for p, q in zip(xy, xy[1:]):
        dx, dy = q[0] - p[0], q[1] - p[1]
        d = math.hypot(dx, dy)
        h = math.degrees(math.atan2(dx, dy)) % 360
        step_way = 1 if dx * ux + dy * uy > 0 else -1
        if d > 0.3 and _axis_dev(h, axis) <= ALONG_TOLERANCE_DEG and d < 3 * spacing and way in (0, step_way):
            run.append(q)
            way = step_way
            continue
        if len(run) >= MIN_LINE_PHOTOS:
            lines.append(statistics.fmean(-uy * x + ux * y for x, y in run))
        run, way = [q], 0
    if len(run) >= MIN_LINE_PHOTOS:
        lines.append(statistics.fmean(-uy * x + ux * y for x, y in run))
    return axis, spacing, sorted(lines)


def _footprint(x: float, y: float, yaw: float, width_m: float, height_m: float) -> Polygon:
    """A nadir photo's ground footprint: the image's top edge faces the gimbal yaw."""
    a = math.radians(yaw)
    ca, sa = math.cos(a), math.sin(a)
    corners = []
    for u, v in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        u, v = u * width_m / 2, v * height_m / 2
        corners.append((x + u * ca + v * sa, y - u * sa + v * ca))
    return Polygon(corners)


# ── the check ────────────────────────────────────────────────────────────────


def check(rows: list, field=None, weather: dict | None = None) -> dict:
    """rows: the flight's photos (SurveyImage rows or objects with the same
    attributes). field: its Field, for the flight-plan outline. weather: the
    weather during the flight (weather_service), when it is known."""
    s = settings
    items: list[Item] = []
    rgb = [r for r in rows if r.band == "RGB"]
    ms = [r for r in rows if r.band in MS_BANDS]
    frames = rgb or [r for r in rows if r.band not in MS_BANDS] or rows
    frames = sorted(frames, key=lambda r: (r.captured_at or datetime.min, r.filename))
    if not frames:
        return _result([], 0, "No photos in this flight yet.")

    located = [r for r in frames if r.lat is not None and r.lon is not None]
    pitched = [r for r in located if r.gimbal_pitch_deg is not None]
    nadir = [r for r in located if r.gimbal_pitch_deg is None or r.gimbal_pitch_deg <= NADIR_PITCH + s.flight_max_tilt_deg]

    # height and the ground detail it gives
    heights = [r.rel_altitude_m for r in nadir if r.rel_altitude_m is not None]
    height = statistics.median(heights) if len(heights) >= max(1, len(nadir) // 2) else None
    if height is not None:
        ft = height * FT_PER_M
        over = ft > s.flight_max_height_ft
        items.append(Item(
            "height", "Height", "warn" if over else "ok", f"{ft:.0f} ft ({height:.0f} m)",
            f"100 ft; up to {s.flight_max_height_ft:.0f} ft for big fields",
            (f"Higher than {s.flight_max_height_ft:.0f} ft shows less detail: small plants and weeds can be missed."
             + (" It is also above the FAA's 400 ft limit." if ft > 400 else "")) if over else None,
        ))
    focals = [r.focal_px for r in nadir if r.focal_px]
    focal = statistics.median(focals) if focals else None
    if height is not None and focal:
        gsd_cm = height / focal * 100
        coarse = gsd_cm > s.flight_max_gsd_cm
        items.append(Item(
            "detail", "Detail", "warn" if coarse else "ok",
            f"{gsd_cm / 2.54:.2f} in per pixel ({gsd_cm:.1f} cm)",
            f"{s.flight_max_gsd_cm / 2.54:.2f} in ({s.flight_max_gsd_cm:g} cm) or finer for weeds",
            f"Small weeds may not show at this detail. With this camera, fly at "
            f"{s.flight_max_gsd_cm / 100 * focal * FT_PER_M:.0f} ft or lower." if coarse else None,
        ))

    # camera angle
    if pitched:
        tilted = [r for r in pitched if r.gimbal_pitch_deg > NADIR_PITCH + s.flight_max_tilt_deg]
        if not tilted:
            items.append(Item("angle", "Camera angle", "ok", "Straight down", "Straight down (−90°)"))
        else:
            off = abs(statistics.median(r.gimbal_pitch_deg for r in tilted) - NADIR_PITCH)
            most = len(tilted) > len(pitched) / 2
            items.append(Item(
                "angle", "Camera angle", "warn" if most else "info",
                f"{len(tilted)} of {len(pitched)} photos tilted (about {off:.0f}°)", "Straight down (−90°)",
                "Most photos were taken with the camera tilted. A crop map needs photos straight down: set the camera to −90° for the mapping flight."
                if most else f"{_plural(len(tilted), 'photo was', 'photos were')} taken with the camera tilted; the crop map is made from the photos taken straight down.",
            ))

    # front and side overlap
    lat0 = statistics.fmean(r.lat for r in located) if located else 0.0
    lon0 = statistics.fmean(r.lon for r in located) if located else 0.0
    sized = [r for r in nadir if r.rel_altitude_m and r.focal_px and r.width and r.height]
    footprints: list[Polygon] = []
    if len(sized) >= MIN_PHOTOS_FOR_OVERLAP:
        xy = [_flat(r.lat, r.lon, lat0, lon0) for r in sized]
        axis, spacing, lines = _flight_lines(xy)
        yaws = [r.gimbal_yaw_deg for r in sized if r.gimbal_yaw_deg is not None]
        if axis is not None and spacing and yaws:
            # which side of the image lies along the lines: the top faces the gimbal yaw
            yaw_axis = statistics.median(y % 180 for y in yaws)
            r0 = sized[len(sized) // 2]
            along_px, across_px = (r0.height, r0.width) if _axis_dev(yaw_axis, axis) < 45 else (r0.width, r0.height)
            along_m = height * along_px / focal if height and focal else None
            across_m = height * across_px / focal if height and focal else None
            if along_m:
                front = max(0.0, min(99.0, (1 - spacing / along_m) * 100))
                low = front < s.flight_min_front_overlap
                items.append(Item(
                    "front_overlap", "Front overlap", "warn" if low else "ok", f"{front:.0f}%", "80%",
                    "The photos along each line overlap too little: the map can have holes or fail. "
                    "Set the front overlap to 80% in the flight app." if low else None,
                ))
            gaps = [b - a for a, b in zip(lines, lines[1:])]
            gaps = [g for g in gaps if across_m and g > 0.1 * across_m]  # a line resumed after a battery swap is the same line
            if across_m and gaps:
                side = max(0.0, min(99.0, (1 - statistics.median(gaps) / across_m) * 100))
                low = side < s.flight_min_side_overlap
                items.append(Item(
                    "side_overlap", "Side overlap", "warn" if low else "ok", f"{side:.0f}%", "75%",
                    "The flight lines are too far apart: the map can have gaps between them. "
                    "Set the side overlap to 75% in the flight app." if low else None,
                ))
        for r, (x, y) in zip(sized, xy):
            if r.gimbal_yaw_deg is not None:
                footprints.append(_footprint(x, y, r.gimbal_yaw_deg, r.rel_altitude_m * r.width / r.focal_px,
                                             r.rel_altitude_m * r.height / r.focal_px))

    # how much of the flight-plan outline is in the photos
    if field is not None and field.boundary_source == "flight_plan" and field.boundary_geojson and footprints:
        try:
            outline_ll = shape(json.loads(field.boundary_geojson))
            rings = [outline_ll.exterior, *outline_ll.interiors]
            flat = [[_flat(lat, lon, lat0, lon0) for lon, lat in ring.coords] for ring in rings]
            outline = Polygon(flat[0], flat[1:])
        except (ValueError, TypeError, AttributeError, KeyError):
            outline = None
        if outline is not None and outline.is_valid and outline.area > 0:
            covered = outline.intersection(unary_union(footprints)).area / outline.area * 100
            missing_acres = outline.area * (1 - covered / 100) / M2_PER_ACRE
            short = covered < s.flight_min_coverage
            items.append(Item(
                "coverage", "Field covered", "warn" if short else "ok", f"{covered:.0f}% of the field", "The whole field",
                f"About {missing_acres:.1f} acres of the field are in no photo. Draw the mission over the whole field, "
                "with one pass beyond each edge." if short else None,
            ))

    # the sun's height, from the photo in the middle of the flight
    if located:
        mid = located[len(located) // 2]
        utc, exact = photo_utc(mid.path, mid.captured_at, mid.lon)
        if utc is not None:
            el = sun_elevation_deg(utc, mid.lat, mid.lon)
            when = _span(frames[0].captured_at, frames[-1].captured_at)
            low = el < s.flight_min_sun_deg
            items.append(Item(
                "sun", "Sun", "warn" if low else "ok",
                f"{when + ' · ' if when else ''}sun {'' if exact else 'about '}{el:.0f}° up",
                f"{s.flight_min_sun_deg:.0f}° or higher (about 10 am–2 pm)",
                "The sun was low: long shadows can make the crop look patchy and change the crop-health numbers. "
                "Fly within about 2 hours of midday." if low else None,
            ))

    # the weather during the flight (a weather model's estimate for the area)
    if weather and weather.get("wind_mph") is not None:
        wind, gust = weather["wind_mph"], weather.get("gust_mph")
        rain = weather.get("rain_in") or 0.0
        parts = [f"{wind:.0f} mph wind" + (f", gusts {gust:.0f}" if gust is not None else "")]
        if weather.get("cloud_pct") is not None:
            parts.append(f"{weather['cloud_pct']}% cloud")
        parts.append("rain" if rain >= 0.01 else "dry")
        windy, wet = wind > s.flight_max_wind_mph, rain >= 0.01
        if windy:
            message = (f"Wind over {s.flight_max_wind_mph:.0f} mph shakes the crop and the drone: the photos can blur "
                       "and the map can have gaps. Fly on a calmer day.")
        elif wet:
            message = "It rained during the flight: wet leaves shine and drops on the lens blur the photos."
        elif (weather.get("rain_before_in") or 0) >= 0.05:
            message = "It rained in the 12 hours before: wet leaves can look different from dry ones."
        else:
            message = "Estimated by a weather model for the area, not measured at the field."
        items.append(Item("weather", "Weather", "warn" if windy or wet else "ok", " · ".join(parts),
                          f"Wind below {s.flight_max_wind_mph:.0f} mph, no rain", message))

    # position
    unlocated = len(frames) - len(located)
    fixes = [r.rtk_fix for r in located if r.rtk_fix]
    if unlocated:
        items.append(Item(
            "gps", "GPS", "warn", f"{_plural(unlocated, 'photo')} without GPS", "Every photo",
            "These photos cannot be placed on the map. Use the photos straight from the drone's memory card, not copies from a phone gallery or a message.",
        ))
    elif fixes:
        fixed = sum(f == "FIXED" for f in fixes) / len(located) * 100
        items.append(Item(
            "gps", "GPS", "ok" if fixed >= 90 else "info", f"RTK fixed on {fixed:.0f}% of photos", "RTK fixed",
            None if fixed >= 90 else "RTK was not fixed for part of the flight: those photos can be a few feet off.",
        ))
    else:
        items.append(Item(
            "gps", "GPS", "info", "Standard GPS", None,
            "Without RTK the map can be several feet off. Ground targets measured with an RTK GPS line it up.",
        ))

    # crop-health bands (DJI multispectral: four band TIFs with every photo)
    if ms and rgb:
        bands: dict[str, set[str]] = {}
        for r in ms:
            if r.frame_key:
                bands.setdefault(r.frame_key, set()).add(r.band)
        missing = sum(1 for r in rgb if len(bands.get(r.frame_key or "", ())) < len(MS_BANDS))
        if not missing:
            items.append(Item("bands", "Crop-health bands", "ok", "All 4 bands with every photo"))
        else:
            many = missing > max(2, 0.02 * len(rgb))
            items.append(Item(
                "bands", "Crop-health bands", "warn" if many else "info",
                f"{_plural(missing, 'photo')} missing bands", "All 4 bands with every photo",
                "Copy all the TIF files from the memory card together with the JPGs: crop health is measured from them.",
            ))
    elif rgb and not ms:
        items.append(Item(
            "bands", "Crop-health bands", "info", "Regular photos only", None,
            "Crop health is estimated from the colours. A drone with a crop-health (multispectral) camera measures it more reliably.",
        ))

    # one flight is one day
    days = sorted({r.captured_at.date() for r in frames if r.captured_at})
    if len(days) > 1:
        names = ", ".join(f"{d:%b} {d.day}" for d in days[:4]) + ("…" if len(days) > 4 else "")
        items.append(Item(
            "days", "Days", "warn", f"Photos from {len(days)} days", "One flight",
            f"These photos were taken on different days ({names}): probably more than one flight. Upload each flight on its own.",
        ))

    return _result(items, len(frames), "Not enough flight data in the photos to check the flight.")


def _result(items: list[Item], frames: int, empty: str) -> dict:
    warns = sum(i.status == "warn" for i in items)
    if not items:
        status, summary = "unknown", empty
    elif warns:
        status, summary = "check", f"{_plural(warns, 'thing')} to check for the next flight"
    else:
        status, summary = "good", "Flown well for a crop map"
    return {"status": status, "summary": summary, "frames": frames, "items": [asdict(i) for i in items]}
