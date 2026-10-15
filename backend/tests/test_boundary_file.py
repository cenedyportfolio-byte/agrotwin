"""The field outline from a flight-plan file: DJI Pilot 2 mapping-mission KMZ,
KML outlines from other apps, the files that must be refused (a waypoint
route, entity tricks, wrong coordinates, …), the check that the outline is
where the photos were taken, and the field keeping it through processing.

Run (from backend/):  python -m tests.test_boundary_file
"""

import io
import math
import os
import sys
import tempfile
import zipfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-boundary-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.datastructures import UploadFile  # noqa: E402

from app import models  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import boundary_file_service as bfs  # noqa: E402

init_db()

LAT0, LON0 = 36.0969, -85.5834  # the Ditty Road field


def square(side_m: float, lat0: float = LAT0, lon0: float = LON0) -> list[tuple[float, float]]:
    """A side_m x side_m square (lon, lat) centred on lat0/lon0."""
    dlat = math.degrees(side_m / 2 / bfs.EARTH_RADIUS_M)
    dlon = math.degrees(side_m / 2 / (bfs.EARTH_RADIUS_M * math.cos(math.radians(lat0))))
    return [(lon0 - dlon, lat0 - dlat), (lon0 + dlon, lat0 - dlat), (lon0 + dlon, lat0 + dlat), (lon0 - dlon, lat0 + dlat)]


def coords(points, alt: float | None = None) -> str:
    ring = [*points, points[0]]
    return " ".join(f"{x:.7f},{y:.7f}" + (f",{alt}" if alt is not None else "") for x, y in ring)


def kml(body: str, extra_ns: str = "") -> bytes:
    return f'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"{extra_ns}><Document>{body}</Document></kml>'.encode()


def polygon(points) -> str:
    return f"<Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>{coords(points, 0)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"


def dji_kmz(template_type: str = "mapping2d", with_area: bool = True) -> bytes:
    """Shaped like DJI Pilot 2's mission KMZ: wpmz/template.kml (the drawn area)
    and wpmz/waylines.wpml (the route the drone flies)."""
    ns = ' xmlns:wpml="http://www.dji.com/wpmz/1.0.2"'
    area = (f"<Folder><wpml:templateType>{template_type}</wpml:templateType>"
            + (polygon(square(200)) if with_area else "") + "</Folder>")
    # the route: an open path over the area (here ending where it began, as a lawnmower pattern can)
    path = " ".join(f"{x:.7f},{y:.7f}" for x, y in [*square(260), square(260)[0]])
    route = f"<Folder><Placemark><LineString><coordinates>{path}</coordinates></LineString></Placemark></Folder>"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("wpmz/waylines.wpml", kml(route, ns))
        zf.writestr("wpmz/template.kml", kml(area, ns))
    return buf.getvalue()


def refused(raw: bytes, *words: str) -> None:
    try:
        bfs.parse(raw)
    except bfs.BoundaryFileError as exc:
        assert all(w.lower() in str(exc).lower() for w in words), (str(exc), words)
        return
    raise AssertionError(f"accepted, expected a refusal mentioning {words}")


def test_dji_mission():
    b = bfs.parse(dji_kmz())
    assert b.kind == "DJI mapping mission", b.kind
    # 200 m x 200 m = 4 ha (the drawn area, not the larger route)
    assert abs(b.area_hectares - 4.0) < 0.04, b.area_hectares
    assert abs(b.center_lat - LAT0) < 1e-5 and abs(b.center_lon - LON0) < 1e-5
    assert b.geometry["type"] == "Polygon" and len(b.geometry["coordinates"][0]) == 5
    refused(dji_kmz("waypoint", with_area=False), "waypoint route")


def test_other_kml():
    two = bfs.parse(kml(polygon(square(100)) + polygon(square(300))))
    assert abs(two.area_hectares - 9.0) < 0.09 and two.kind == "KML outline"
    assert any("2 outlines" in n for n in two.notes), two.notes
    # a field edge drawn as a closed line (sprayers, GIS)
    line = bfs.parse(kml(f"<Placemark><LineString><coordinates>{coords(square(150))}</coordinates></LineString></Placemark>"))
    assert abs(line.area_hectares - 2.25) < 0.03, line.area_hectares
    # an open line is a route, not an outline
    refused(kml(f"<Placemark><LineString><coordinates>{coords(square(150))[:-30]}</coordinates></LineString></Placemark>"), "no field outline")


def test_refusals():
    refused(b"", "empty")
    refused(b"name,lat,lon\nA,36.1,-85.5\n", "could not be read")
    refused(b"PK\x03\x04 not really a zip", "damaged")
    refused(kml(polygon(square(10))), "too small")
    refused(kml(polygon([(500.0, 3995800.0), (600.0, 3995800.0), (600.0, 3995900.0)])), "latitude/longitude")
    bomb = (b'<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>'
            b'<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>&b;</name></Document></kml>')
    refused(bomb, "could not be read")


def test_near_the_photos():
    b = bfs.parse(kml(polygon(square(200))))
    on_field = [(LON0 + 0.0003 * i, LAT0) for i in range(-3, 4)]
    bfs.check_near(b, on_field, None)  # no error
    away = [(LON0 + 0.15, LAT0 + 0.05)] * 5
    try:
        bfs.check_near(b, away, None)
        raise AssertionError("an outline 10 miles from the photos was accepted")
    except bfs.BoundaryFileError as exc:
        assert "miles from where the photos were taken" in str(exc), exc
    try:
        bfs.check_near(b, [], (LAT0 + 0.2, LON0))
        raise AssertionError("an outline 14 miles from the field was accepted")
    except bfs.BoundaryFileError as exc:
        assert "from this field" in str(exc), exc


def test_field_keeps_the_flight_plan():
    from app.routers import fields as fields_router
    from app.services import job_runner
    from app.services.survey_service import update_field_boundary_from_images

    db = SessionLocal()
    try:
        farm = models.Farm(name="f")
        db.add(farm)
        db.flush()
        field = models.Field(farm_id=farm.id, name="Ditty Road")
        db.add(field)
        db.flush()
        survey = models.Survey(field_id=field.id, name="June")
        db.add(survey)
        db.flush()
        for i, (lon, lat) in enumerate([(LON0 - 0.0004, LAT0 - 0.0004), (LON0 + 0.0004, LAT0 - 0.0004),
                                        (LON0 + 0.0004, LAT0 + 0.0004), (LON0 - 0.0004, LAT0 + 0.0004)]):
            db.add(models.SurveyImage(survey_id=survey.id, filename=f"p{i}.jpg", file_path=f"/x/p{i}.jpg",
                                      band="RGB", lat=lat, lon=lon))
        db.commit()
        db.refresh(field)
        update_field_boundary_from_images(db, field, survey.images)
        db.commit()
        photo_area = field.area_hectares

        queued = []
        real = job_runner.enqueue
        job_runner.enqueue = lambda db_, s, steps, fn, job=None: queued.append(s.id)
        try:
            res = fields_router.attach_boundary_file(field.id, UploadFile(io.BytesIO(dji_kmz()), filename="ditty_road.kmz"), db)
            assert res["field"].boundary_source == "flight_plan" and res["field"].boundary_file == "ditty_road.kmz"
            assert abs(res["field"].area_hectares - 4.0) < 0.04 and res["rechecking"] == 0  # nothing analysed yet
            assert (fields_router._flight_plan_dir(field.id) / "flight_plan.kmz").exists()

            # processing redraws the photo outline — but not over the flight plan
            update_field_boundary_from_images(db, field, survey.images)
            db.commit()
            db.refresh(field)
            assert abs(field.area_hectares - 4.0) < 0.04, field.area_hectares

            # a finished, analysed flight is checked again on the new outline
            survey.status = "COMPLETED"
            db.add(models.AnalysisResult(survey_id=survey.id, healthy_area_percent=50, attention_area_percent=40,
                                         problem_area_percent=10, method="exg_map"))
            db.commit()
            res = fields_router.attach_boundary_file(field.id, UploadFile(io.BytesIO(dji_kmz()), filename="v2.kmz"), db)
            assert res["rechecking"] == 1 and queued == [survey.id], (res["rechecking"], queued)

            res = fields_router.remove_boundary_file(field.id, db)
            assert res["field"].boundary_source is None and res["field"].boundary_file is None
            assert abs(res["field"].area_hectares - photo_area) < 1e-6
            assert not fields_router._flight_plan_dir(field.id).exists()
        finally:
            job_runner.enqueue = real
    finally:
        db.close()


def main():
    test_dji_mission()
    test_other_kml()
    test_refusals()
    test_near_the_photos()
    test_field_keeps_the_flight_plan()
    print("boundary file: all checks passed")


if __name__ == "__main__":
    main()
