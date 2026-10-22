"""Outside data with the outside services replaced by recorded answers (no
network): the flight's weather and its flight-check line, the spray weather,
the county from the local boundary file, the soil under a field (and the
spots on it), and the satellite season record read from local scene files.

Run (from backend/):  python -m tests.test_outside_data
"""

import gzip
import json
import math
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-outside-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["AGROTWIN_EXTERNAL_DATA"] = "false"  # switched on only where a test needs it
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402
from rasterio.warp import transform_bounds  # noqa: E402
from shapely.geometry import box, mapping  # noqa: E402

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import (  # noqa: E402
    county_service,
    external_data,
    flight_check_service,
    satellite_service,
    soil_service,
    weather_service,
)

init_db()
LAT0, LON0 = 36.0969, -85.5834
FIELD = box(LON0 - 0.002, LAT0 - 0.0015, LON0 + 0.002, LAT0 + 0.0015)  # about 360 m x 330 m


class FakeWeb:
    """Stands in for external_data.get_json: answers by URL, records each call."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def __call__(self, url, params=None, body=None, timeout=30.0):
        self.calls.append({"url": url, "params": params or {}, "body": body})
        result = self.answer(url, params or {}, body)
        if isinstance(result, Exception):
            raise result
        return result


def patched_web(answer):
    fake = FakeWeb(answer)
    external_data.get_json = fake
    return fake


REAL_GET = external_data.get_json


def hourly(start: datetime, n: int, **series):
    out = {"time": [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(n)]}
    for key, fn in series.items():
        out[key] = [fn(i) for i in range(n)]
    return out


def field_with_flight(db, captured: datetime, name="Ditty Road") -> tuple[models.Field, models.Survey]:
    farm = models.Farm(name=f"farm {name}")
    db.add(farm)
    db.flush()
    field = models.Field(farm_id=farm.id, name=name, boundary_geojson=json.dumps(mapping(FIELD)),
                         center_lat=LAT0, center_lon=LON0, area_hectares=12.0)
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name="June", image_count=4, survey_date=captured)
    db.add(survey)
    db.flush()
    for i in range(4):
        db.add(models.SurveyImage(survey_id=survey.id, filename=f"DJI_{i}_D.JPG", file_path=str(_TMP / "none.jpg"), band="RGB",
                                  lat=LAT0 + i * 1e-4, lon=LON0, captured_at=captured + timedelta(minutes=7 * i)))
    db.commit()
    return field, survey


# ── weather ──────────────────────────────────────────────────────────────────


def test_flight_weather():
    start, end = datetime(2026, 6, 3, 19, 37), datetime(2026, 6, 3, 20, 0)
    hours = hourly(datetime(2026, 6, 3, 0), 24, wind_speed_10m=lambda i: 5.0 + (i == 20) * 1.8,
                   wind_gusts_10m=lambda i: 8.9, cloud_cover=lambda i: 10, temperature_2m=lambda i: 78,
                   precipitation=lambda i: 0.1 if i == 12 else 0.0)
    got = weather_service.summarize_flight(hours, start, end)
    assert got == {"wind_mph": 6.8, "gust_mph": 8.9, "cloud_pct": 10, "temp_f": 78, "rain_in": 0.0, "rain_before_in": 0.1}, got

    # the flight check line
    calm = {item["key"]: item for item in flight_check_service.check([], None, None)["items"]}
    assert "weather" not in calm
    rows = [SimpleNamespace(band="RGB", filename="a.jpg", lat=LAT0, lon=LON0, rel_altitude_m=None, gimbal_pitch_deg=None,
                            gimbal_yaw_deg=None, captured_at=start, frame_key=None, focal_px=None, width=None, height=None,
                            rtk_fix=None, path=_TMP / "none.jpg")]
    item = {i["key"]: i for i in flight_check_service.check(rows, None, got)["items"]}["weather"]
    assert item["status"] == "ok" and item["value"] == "7 mph wind, gusts 9 · 10% cloud · dry", item
    assert "rained in the 12 hours before" in item["message"]
    windy = {i["key"]: i for i in flight_check_service.check(rows, None, {**got, "wind_mph": 19.0})["items"]}["weather"]
    assert windy["status"] == "warn" and "calmer day" in windy["message"]

    # the lookup: from the photos' time and place, kept with the flight
    db = SessionLocal()
    try:
        _, survey = field_with_flight(db, datetime.now().replace(microsecond=0) - timedelta(days=3))
        web = patched_web(lambda url, p, b: {"hourly": hourly(datetime.fromisoformat(p["start_date"]), 72,
                                                              wind_speed_10m=lambda i: 4.0, wind_gusts_10m=lambda i: 7.0,
                                                              cloud_cover=lambda i: 50, temperature_2m=lambda i: 70,
                                                              precipitation=lambda i: 0.0)})
        weather_service.lookup_flight(survey.id)
        db.expire_all()
        kept = json.loads(db.get(models.Survey, survey.id).weather_json)
        assert kept["status"] == "ok" and kept["wind_mph"] == 4.0, kept
        sent = web.calls[0]
        assert sent["url"].startswith("https://api.open-meteo.com/")  # a recent flight: the regular forecast's past days
        assert sent["params"]["latitude"] == 36.1 and sent["params"]["longitude"] == -85.6  # rounded, not the field
        assert sent["params"]["wind_speed_unit"] == "mph"

        # an old flight goes to the archive of forecasts; no service: noted, tried again later
        assert weather_service._sources(datetime(2023, 5, 1).date(), datetime(2026, 10, 15).date()) == ["historical", "archive"]
        patched_web(lambda url, p, b: external_data.LookupFailed("offline"))
        weather_service.lookup_flight(survey.id)
        db.expire_all()
        survey = db.get(models.Survey, survey.id)
        assert json.loads(survey.weather_json)["status"] == "unavailable"
        assert weather_service.flight_weather(survey, start_lookup=False) == (None, False)
    finally:
        external_data.get_json = REAL_GET
        db.close()


def test_spray_weather():
    # 9 am to 7 pm local (UTC-5) on a July day: daylight throughout; rain at 7 pm
    hours = hourly(datetime(2026, 7, 1, 9), 11,
                   wind_speed_10m=lambda i: [6, 6, 6, 14, 6, 2, 6, 6, 6, 6, 6][i], wind_gusts_10m=lambda i: 9,
                   temperature_2m=lambda i: 90 if i == 4 else 78,
                   precipitation=lambda i: 0.2 if i == 10 else 0.0, precipitation_probability=lambda i: 10)
    got = weather_service.classify_hours(hours, -5 * 3600, LAT0, LON0)
    status = [h["status"] for h in got]
    assert status == ["good", "good", "good", "bad", "marginal", "marginal", "good", "bad", "bad", "bad", "bad"], status
    assert got[3]["reason"] == "Too windy" and got[4]["reason"].startswith("Hot") and got[5]["reason"].startswith("Calm")
    assert got[7]["reason"] == "Rain within 4 h"  # 4 pm: rain within the next 4 hours
    assert weather_service.windows(got) == [{"start": "2026-07-01T09:00", "end": "2026-07-01T12:00", "hours": 3}]
    night = weather_service.classify_hours(hourly(datetime(2026, 7, 2, 1), 1, wind_speed_10m=lambda i: 6), -5 * 3600, LAT0, LON0)
    assert night[0]["status"] == "night"

    web = patched_web(lambda url, p, b: {"timezone": "America/Chicago", "utc_offset_seconds": -18000, "hourly": hours})
    try:
        weather_service._spray_cache.clear()
        first = weather_service.spray_forecast(LAT0, LON0)
        again = weather_service.spray_forecast(LAT0 + 0.001, LON0)  # the same rounded place: from the cache
        assert first["available"] and first["next_window"]["hours"] == 3 and again is first and len(web.calls) == 1
        assert web.calls[0]["params"]["forecast_hours"] == 48 and web.calls[0]["params"]["timezone"] == "auto"
    finally:
        external_data.get_json = REAL_GET


# ── county ───────────────────────────────────────────────────────────────────


def test_county():
    saved = settings.counties_file
    try:
        settings.counties_file = _TMP / "reference" / "none.json.gz"
        assert county_service.county_of(LAT0, LON0) is None  # no file: not known
        path = _TMP / "reference" / "counties.json.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [{"n": "Putnam County", "s": "TN", "g": mapping(box(-85.8, 36.0, -85.5, 36.3))},
                {"n": "White County", "s": "TN", "g": mapping(box(-85.5, 35.8, -85.2, 36.1))}]
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(rows, f)
        settings.counties_file = path
        assert county_service.county_of(LAT0, LON0) == "Putnam County, TN"
        assert county_service.county_of(35.9, -85.3) == "White County, TN"
        assert county_service.county_of(36.15, -85.795) == "Putnam County, TN"
        assert county_service.county_of(36.15, -85.805) == "Putnam County, TN"  # just past a (simplified) edge
        assert county_service.county_of(40.0, -90.0) is None
    finally:
        settings.counties_file = saved


# ── soil ─────────────────────────────────────────────────────────────────────


def soil_answer(url, params, body):
    sql = body["query"]
    if "FROM mupolygon" in sql:
        west = box(LON0 - 0.01, LAT0 - 0.01, LON0 - 0.0005, LAT0 + 0.01)
        east = box(LON0 - 0.0005, LAT0 - 0.01, LON0 + 0.01, LAT0 + 0.01)
        sliver = box(LON0 + 0.00199, LAT0 - 0.0015, LON0 + 0.0021, LAT0 - 0.00149)
        return {"Table": [["mukey", "wkt"], ["100", west.wkt], ["200", east.wkt], ["300", sliver.wkt]]}
    if "FROM mapunit" in sql:
        return {"Table": [["mukey", "musym", "muname", "drclassdcd", "hydgrpdcd", "slopegraddcp", "flodfreqdcd", "wtdepannmin"],
                          ["100", "HnB", "Holston loam, 2 to 5 percent slopes", "Well drained", "B", "4", "None", None],
                          ["200", "MnB", "Monongahela silt loam, 2 to 5 percent slopes", "Moderately well drained", "C/D", "4", "None", "56"],
                          ["300", "Ln", "Lindell silt loam", "Moderately well drained", "B/D", "1", "Occasional", "38"]]}
    if "FROM component" in sql:
        return {"Table": [["mukey", "compname", "comppct_r", "om_r", "ph1to1h2o_r", "sandtotal_r", "silttotal_r", "claytotal_r", "texture"],
                          ["100", "Holston", "85", "2", "5", "43", "39.5", "17.5", "Loam"],
                          ["100", "Minor", "10", "9", "7", "1", "1", "1", "Muck"],
                          ["200", "Monongahela", "100", "2", "5", "32.1", "55.9", "12", "Silt loam"]]}
    raise AssertionError(sql)


def test_soil():
    web = patched_web(soil_answer)
    try:
        got = soil_service.fetch(FIELD)
        assert got["status"] == "ok" and [u["symbol"] for u in got["units"]] == ["MnB", "HnB"], got["units"]  # the sliver is gone
        east, west = got["units"]
        assert abs(east["share"] + west["share"] - 100) < 0.2 and abs(east["share"] - 62.5) < 1, (east, west)
        assert west["texture"] == "Loam" and west["organic_matter_pct"] == 2.0  # the main soil, not the minor one
        assert east["drainage"] == "Moderately well drained" and east["water_table_cm"] == 56
        assert abs(sum(u["acres"] for u in got["units"]) - soil_service.area_m2(FIELD) / 4046.86) < 0.05
        sent = web.calls[0]["body"]["query"]
        assert "POLYGON ((" in sent and sent.count(",") <= 12  # a box, not the outline
        assert len(got["geojson"]["features"]) == 2

        patched_web(lambda url, p, b: {})
        assert soil_service.fetch(FIELD)["status"] == "none"  # no soil survey here (outside the US)
    finally:
        external_data.get_json = REAL_GET

    db = SessionLocal()
    try:
        field, survey = field_with_flight(db, datetime(2026, 6, 3, 14, 37), "Soil field")
        bare = models.Field(farm_id=field.farm_id, name="No outline")
        db.add(bare)
        db.commit()
        assert soil_service.soil(bare)["status"] == "no_outline"
        assert soil_service.soil(field)["status"] == "off"  # outside data switched off

        settings.external_data = True
        started = []
        real_start = external_data.start
        external_data.start = lambda key, fn, *args: started.append(key) or True
        try:
            assert soil_service.soil(field) == {"status": "fetching"} and started == [f"soil:{field.id}"]
        finally:
            external_data.start = real_start
            settings.external_data = False

        patched_web(soil_answer)
        soil_service.lookup(field.id)
        db.expire_all()
        field = db.get(models.Field, field.id)
        data = soil_service.soil(field)
        assert data["status"] == "ok" and data["outline_key"] == soil_service.outline_key(field)

        # a spot on the east soil
        result = models.AnalysisResult(survey_id=survey.id, method="exg_map")
        db.add(result)
        db.flush()
        spot = box(LON0 + 0.0005, LAT0, LON0 + 0.0008, LAT0 + 0.0003)
        db.add(models.DetectionZone(analysis_result_id=result.id, type="patchy_vegetation", severity="medium", confidence=0.8,
                                    geometry_geojson=json.dumps(mapping(spot))))
        db.commit()
        db.refresh(field)
        spots = soil_service.spots_on_soil(field, data)
        assert len(spots) == 1 and spots[0]["symbol"] == "MnB" and spots[0]["share"] == 100, spots
        totals = soil_service.spots_by_soil(spots)
        assert list(totals) == ["200"] and totals["200"]["count"] == 1 and totals["200"]["acres"] == spots[0]["acres"]

        # the outline changes while the soil is looked up: that answer is not kept
        def changing(url, params, body):
            with SessionLocal() as other:
                f = other.get(models.Field, field.id)
                f.boundary_geojson = json.dumps(mapping(FIELD.buffer(0.001)))
                other.commit()
            return soil_answer(url, params, body)
        patched_web(changing)
        before = field.soil_json
        soil_service.lookup(field.id)
        db.expire_all()
        assert db.get(models.Field, field.id).soil_json == before
    finally:
        external_data.get_json = REAL_GET
        db.close()


# ── satellite ────────────────────────────────────────────────────────────────


def scene_files(folder: Path, red_dn: int, nir_dn: int, cloud_share: float = 0.0) -> dict:
    """Red, NIR (10 m) and scene classification (20 m) files over the field, in UTM 16N like the real tiles."""
    folder.mkdir(parents=True, exist_ok=True)
    left, bottom, right, top = transform_bounds("EPSG:4326", "EPSG:32616", *FIELD.buffer(0.003).bounds)
    left, top = math.floor(left / 20) * 20, math.ceil(top / 20) * 20
    w10, h10 = int((right - left) // 10) + 2, int((top - bottom) // 10) + 2
    paths = {}
    for key, res, value in (("red", 10, red_dn), ("nir", 10, nir_dn), ("scl", 20, 4)):
        w, h = (w10, h10) if res == 10 else (w10 // 2 + 1, h10 // 2 + 1)
        data = np.full((h, w), value, dtype="uint8" if key == "scl" else "uint16")
        if key == "scl" and cloud_share:
            data[:, : int(w * cloud_share)] = 9  # high-probability cloud over the west part
        path = folder / f"{key}.tif"
        with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype=data.dtype, crs="EPSG:32616",
                           transform=from_origin(left, top, res, res), nodata=0) as dst:
            dst.write(data, 1)
        paths[key] = str(path)
    return paths


def scene(item_id: str, when: str, paths: dict, platform="sentinel-2a", covers=True) -> dict:
    footprint = FIELD.buffer(0.05) if covers else box(LON0, LAT0 - 0.05, LON0 + 0.05, LAT0 + 0.05)
    band = {"raster:bands": [{"scale": 0.0001, "offset": -0.1}]}
    return {"id": item_id, "geometry": mapping(footprint),
            "properties": {"datetime": when, "platform": platform, "eo:cloud_cover": 10},
            "assets": {"red": {"href": paths["red"], **band}, "nir": {"href": paths["nir"], **band}, "scl": {"href": paths["scl"]}}}


def test_satellite():
    clear = scene_files(_TMP / "s2" / "clear", red_dn=1500, nir_dn=4500)  # reflectance 0.05 and 0.35: NDVI 0.75
    cloudy = scene_files(_TMP / "s2" / "cloudy", red_dn=1500, nir_dn=4500, cloud_share=0.5)
    june = scene("S2A_june", "2026-06-02T16:43:21Z", clear)
    got = satellite_service.read_pass(june, FIELD)
    assert got["ndvi"] == 0.75 and got["clear"] == 1.0 and got["date"] == "2026-06-02" and got["pixels"] > 500, got
    # Earth Search's copies already have ESA's +0.1 taken off (the item says so): not taken off twice
    removed = scene("S2A_removed", "2026-06-02T16:43:21Z", scene_files(_TMP / "s2" / "removed", red_dn=500, nir_dn=3500))
    removed["properties"]["earthsearch:boa_offset_applied"] = True
    assert satellite_service.read_pass(removed, FIELD)["ndvi"] == 0.75
    under_cloud = satellite_service.read_pass(scene("S2B_cloudy", "2026-06-05T16:33:00Z", cloudy), FIELD)
    assert under_cloud["ndvi"] is None and 0.3 < under_cloud["clear"] < 0.8, under_cloud

    # one pass cut into two tiles: the tile holding the field is read; a pass that holds none of it is skipped
    items = [scene("S2A_tile_a", "2026-06-02T16:43:21Z", clear, covers=False), june,
             scene("S2C_other", "2026-06-10T16:43:00Z", clear, platform="sentinel-2c", covers=False)]
    picked = satellite_service.passes(items, box(*FIELD.bounds))
    assert [i["id"] for i in picked.values()] == ["S2A_june"], picked

    db = SessionLocal()
    real_search = satellite_service.search
    try:
        field, _ = field_with_flight(db, datetime(2026, 6, 3, 14, 37), "Satellite field")
        assert satellite_service.season(field, today=datetime(2026, 10, 15).date()) == (datetime(2026, 3, 1).date(), datetime(2026, 10, 15).date())
        satellite_service.search = lambda bounds, start, end: [
            june, scene("S2B_cloudy", "2026-06-05T16:33:00Z", cloudy, platform="sentinel-2b"),
            scene("S2C_july", "2026-07-01T16:43:00Z", scene_files(_TMP / "s2" / "july", 1400, 5000), platform="sentinel-2c"),
            scene("S2A_july_same_day", "2026-07-01T16:53:00Z", cloudy)]
        satellite_service.lookup(field.id)
        db.expire_all()
        field = db.get(models.Field, field.id)
        tl = satellite_service.timeline(field, start_lookup=False)
        assert tl["status"] == "ok" and tl["passes"] == 4 and tl["cloudy"] == 2, tl
        assert [(p["date"], p["ndvi"]) for p in tl["points"]] == [("2026-06-02", 0.75), ("2026-07-01", 0.818)], tl["points"]
        assert tl["flights"] == [{"survey_id": field.surveys[0].id, "name": "June", "date": "2026-06-03"}]

        # later lookups read only the new passes
        read = []
        real_read = satellite_service.read_pass
        satellite_service.read_pass = lambda item, outline: read.append(item["id"]) or real_read(item, outline)
        try:
            satellite_service.lookup(field.id)
        finally:
            satellite_service.read_pass = real_read
        assert read == [], read

        # a field too small for 10 m pixels
        small = box(LON0, LAT0, LON0 + 0.0002, LAT0 + 0.0002)
        assert satellite_service.read_pass(june, small).get("too_small") is True
    finally:
        satellite_service.search = real_search
        db.close()


def main():
    test_flight_weather()
    test_spray_weather()
    test_county()
    test_soil()
    test_satellite()
    print("outside data: all checks passed")


if __name__ == "__main__":
    main()
