"""The flight check: a DJI-style mapping grid flown as the guide says passes;
too high, too little overlap, a tilted camera, missing band TIFs, photos
without GPS, two days and a field the photos do not cover are flagged; the
sun's height matches the almanac.

Run (from backend/):  python -m tests.test_flight_check
"""

import json
import math
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-flightcheck-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import flight_check_service as fc  # noqa: E402

LAT0, LON0 = 36.0969, -85.5834  # the Ditty Road field
# DJI Mavic 3 Multispectral photo camera: 5280 x 3956 px, calibrated focal length 3725 px
FOCAL, W, H = 3725.0, 5280, 3956


def to_latlon(x: float, y: float) -> tuple[float, float]:
    return (LAT0 + math.degrees(y / fc.EARTH_RADIUS_M),
            LON0 + math.degrees(x / (fc.EARTH_RADIUS_M * math.cos(math.radians(LAT0)))))


def grid(height_m=30.5, front=0.80, side=0.75, width_m=200.0, length_m=150.0, start=datetime(2026, 6, 3, 11, 0),
         pitch=-90.0, bands=True, heading=0.0):
    """A lawnmower mission: lines along `heading`, the camera's top facing the
    way it flies (DJI turns it round on the way back), 2 s between photos."""
    along = height_m * H / FOCAL * (1 - front)  # the image's height lies along the lines
    across = height_m * W / FOCAL * (1 - side)
    a = math.radians(heading)
    rows, t, n = [], start, 0
    for line in range(int(width_m // across) + 1):
        back = line % 2 == 1
        steps = [i * along for i in range(int(length_m // along) + 1)]
        for s in reversed(steps) if back else steps:
            u, v = line * across - width_m / 2, s - length_m / 2  # u across, v along
            lat, lon = to_latlon(u * math.cos(a) + v * math.sin(a), -u * math.sin(a) + v * math.cos(a))
            key = f"m:{n:04d}"
            yaw = (heading + (180 if back else 0) + 180) % 360 - 180  # DJI writes -180..180
            common = dict(lat=lat, lon=lon, rel_altitude_m=height_m, gimbal_pitch_deg=pitch, gimbal_yaw_deg=yaw,
                          captured_at=t, frame_key=key, rtk_fix="FIXED", path=_TMP / "missing.jpg")
            rows.append(SimpleNamespace(band="RGB", filename=f"DJI_{n:04d}_D.JPG", focal_px=FOCAL, width=W, height=H, **common))
            if bands:
                for b in fc.MS_BANDS:
                    rows.append(SimpleNamespace(band=b, filename=f"DJI_{n:04d}_MS_{b}.TIF", focal_px=2170.0, width=2592, height=1944, **common))
            t += timedelta(seconds=2)
            n += 1
        t += timedelta(seconds=15)  # the turn
    return rows


def items(result) -> dict:
    return {i["key"]: i for i in result["items"]}


def test_good_flight():
    res = fc.check(grid())
    got = items(res)
    assert res["status"] == "good", res
    assert got["height"]["value"].startswith("100 ft"), got["height"]
    assert got["detail"]["status"] == "ok" and "0.32 in" in got["detail"]["value"], got["detail"]
    assert abs(float(got["front_overlap"]["value"].rstrip("%")) - 80) <= 2, got["front_overlap"]
    assert abs(float(got["side_overlap"]["value"].rstrip("%")) - 75) <= 2, got["side_overlap"]
    assert got["angle"]["value"] == "Straight down"
    assert got["bands"]["status"] == "ok" and got["gps"]["status"] == "ok"
    # no XMP to read: the camera clock (11 am) in the guessed time zone (CDT) — sun high, marked approximate
    assert got["sun"]["status"] == "ok" and "about" in got["sun"]["value"], got["sun"]
    # the overlap does not depend on the lines' direction
    turned = items(fc.check(grid(heading=126.8)))
    assert abs(float(turned["side_overlap"]["value"].rstrip("%")) - 75) <= 2, turned["side_overlap"]
    assert abs(float(turned["front_overlap"]["value"].rstrip("%")) - 80) <= 2, turned["front_overlap"]


def test_flagged():
    high = items(fc.check(grid(height_m=90)))  # 295 ft
    assert high["height"]["status"] == "warn" and high["detail"]["status"] == "warn", (high["height"], high["detail"])
    assert "fly at 244 ft or lower" in high["detail"]["message"], high["detail"]["message"]

    sparse = fc.check(grid(front=0.55, side=0.45))
    got = items(sparse)
    assert got["front_overlap"]["status"] == "warn" and got["side_overlap"]["status"] == "warn", sparse
    assert sparse["status"] == "check" and sparse["summary"].startswith("2 things"), sparse["summary"]

    tilted = items(fc.check(grid(pitch=-45)))["angle"]
    assert tilted["status"] == "warn" and "about 45°" in tilted["value"], tilted

    rows = grid()
    tifs = [r for r in rows if r.band != "RGB"]
    rows = [r for r in rows if r.band == "RGB"] + tifs[: len(tifs) // 2]  # half the TIFs not copied
    assert items(fc.check(rows))["bands"]["status"] == "warn"

    rows = grid(bands=False)
    for r in rows[:5]:
        r.lat = r.lon = None
    got = items(fc.check(rows))
    assert got["gps"]["status"] == "warn" and got["gps"]["value"] == "5 photos without GPS", got["gps"]
    assert got["bands"]["value"] == "Regular photos only"

    rows = grid(bands=False) + grid(bands=False, start=datetime(2026, 5, 28, 10, 10))
    assert items(fc.check(rows))["days"]["value"] == "Photos from 2 days"

    late = items(fc.check(grid(start=datetime(2026, 10, 15, 17, 45))))["sun"]
    assert late["status"] == "warn", late


def test_field_coverage():
    def field(width_m, length_m):
        corners = [to_latlon(x, y) for x, y in ((-width_m / 2, -length_m / 2), (width_m / 2, -length_m / 2),
                                                 (width_m / 2, length_m / 2), (-width_m / 2, length_m / 2))]
        ring = [[lon, lat] for lat, lon in corners]
        return SimpleNamespace(boundary_source="flight_plan",
                               boundary_geojson=json.dumps({"type": "Polygon", "coordinates": [ring + ring[:1]]}))

    covered = items(fc.check(grid(), field(200, 150)))["coverage"]
    assert covered["status"] == "ok", covered
    # the plan's outline is twice as wide as the flown area
    half = items(fc.check(grid(), field(450, 150)))["coverage"]
    assert half["status"] == "warn" and "acres of the field are in no photo" in half["message"], half
    # an outline estimated from the photos is covered by definition: not checked
    est = field(450, 150)
    est.boundary_source = None
    assert "coverage" not in items(fc.check(grid(), est))


def test_sun():
    # solar noon on the June solstice at the field: 90 - 36.1 + 23.44 = 77.3°
    assert abs(fc.sun_elevation_deg(datetime(2026, 6, 21, 17, 44), LAT0, LON0) - 77.3) < 0.7
    # an hour before sunset in mid-October is low
    assert fc.sun_elevation_deg(datetime(2026, 10, 15, 22, 30), LAT0, LON0) < 15
    utc, exact = fc.photo_utc(_TMP / "missing.jpg", datetime(2026, 6, 3, 11, 0), LON0)
    assert utc == datetime(2026, 6, 3, 16, 0) and not exact, utc


def test_empty():
    assert fc.check([])["status"] == "unknown"
    # photos from a camera without flight data: only what can be known is listed
    rows = [SimpleNamespace(band="RGB", filename=f"IMG_{i}.JPG", lat=None, lon=None, rel_altitude_m=None,
                            gimbal_pitch_deg=None, gimbal_yaw_deg=None, captured_at=None, frame_key=None,
                            focal_px=None, width=4000, height=3000, rtk_fix=None, path=_TMP / "x.jpg") for i in range(3)]
    got = items(fc.check(rows))
    assert set(got) == {"gps", "bands"}, got


def main():
    test_good_flight()
    test_flagged()
    test_field_coverage()
    test_sun()
    test_empty()
    print("flight check: all checks passed")


if __name__ == "__main__":
    main()
