"""Extracts real EXIF/GPS and DJI XMP metadata from drone images. No fabricated values.

DJI writes flight state into XMP (drone-dji namespace): gimbal yaw/pitch,
altitude above takeoff, RTK fix quality and 1σ, the calibrated focal length /
optical centre per camera, and — for the multispectral TIFs — the per-band
radiometric calibration (black level, gain, exposure, sun-sensor irradiance,
vignetting polynomial) and the band-alignment homography. `read_dji_xmp`
returns the raw key/value map; `extract_image_metadata` lifts the geometry
that direct georeferencing needs into typed fields.
"""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import ExifTags, Image
from PIL.ExifTags import GPSTAGS, TAGS

RTK_FLAG = {50: "FIXED", 34: "FLOAT", 16: "SINGLE", 0: "NONE"}


@dataclass
class ImageMetadata:
    width: int | None
    height: int | None
    lat: float | None
    lon: float | None
    altitude_m: float | None
    captured_at: datetime | None
    make: str | None
    model: str | None
    gimbal_yaw_deg: float | None = None
    gimbal_pitch_deg: float | None = None
    rel_altitude_m: float | None = None
    focal_px: float | None = None
    cx_px: float | None = None
    cy_px: float | None = None
    rtk_fix: str | None = None
    rtk_std_m: float | None = None


def _dms_to_decimal(dms, ref: str) -> float:
    degrees, minutes, seconds = dms
    value = float(degrees) + float(minutes) / 60 + float(seconds) / 3600
    if ref in ("S", "W"):
        value = -value
    return value


def read_dji_xmp(path: Path) -> dict:
    """Flat dict of the DJI XMP Description (keys like 'GimbalYawDegree'). {} if absent."""
    try:
        with Image.open(path) as im:
            return dji_xmp_from_image(im)
    except Exception:
        return {}


def dji_xmp_from_image(im: Image.Image) -> dict:
    """read_dji_xmp for an image that is already open (saves re-reading the file)."""
    try:
        xmp = im.getxmp()
    except Exception:
        return {}
    try:
        desc = xmp["xmpmeta"]["RDF"]["Description"]
    except (KeyError, TypeError):
        return {}
    if isinstance(desc, list):
        merged: dict = {}
        for d in desc:
            if isinstance(d, dict):
                merged.update(d)
        desc = merged
    return desc if isinstance(desc, dict) else {}


def xmp_float(d: dict, key: str) -> float | None:
    v = d.get(key)
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        v = v[0]
    try:
        return float(str(v).replace("+", ""))
    except ValueError:
        return None


def extract_image_metadata(path: Path) -> ImageMetadata:
    with Image.open(path) as img:
        width, height = img.size
        exif = img.getexif()

        lat = lon = altitude_m = None
        captured_at = None
        make = model = None

        if exif:
            tagged = {TAGS.get(k, k): v for k, v in exif.items()}
            make = tagged.get("Make")
            model = tagged.get("Model")

            date_str = tagged.get("DateTimeOriginal") or tagged.get("DateTime")
            if date_str:
                try:
                    captured_at = datetime.strptime(date_str, "%Y:%m:%d %H:%M:%S")
                except ValueError:
                    captured_at = None

            gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo) if hasattr(exif, "get_ifd") else None
            if gps_ifd:
                gps = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
                if "GPSLatitude" in gps and "GPSLatitudeRef" in gps:
                    lat = _dms_to_decimal(gps["GPSLatitude"], gps["GPSLatitudeRef"])
                if "GPSLongitude" in gps and "GPSLongitudeRef" in gps:
                    lon = _dms_to_decimal(gps["GPSLongitude"], gps["GPSLongitudeRef"])
                if "GPSAltitude" in gps:
                    try:
                        altitude_m = float(gps["GPSAltitude"])
                    except (TypeError, ValueError):
                        altitude_m = None

    meta = ImageMetadata(
        width=width, height=height, lat=lat, lon=lon, altitude_m=altitude_m,
        captured_at=captured_at, make=make, model=model,
    )

    xmp = read_dji_xmp(path)
    if xmp:
        # XMP carries the RTK position at full precision; EXIF DMS is rounded.
        xlat, xlon = xmp_float(xmp, "GpsLatitude"), xmp_float(xmp, "GpsLongitude")
        if xlat is not None and xlon is not None:
            meta.lat, meta.lon = xlat, xlon
        meta.gimbal_yaw_deg = xmp_float(xmp, "GimbalYawDegree")
        meta.gimbal_pitch_deg = xmp_float(xmp, "GimbalPitchDegree")
        meta.rel_altitude_m = xmp_float(xmp, "RelativeAltitude")
        meta.focal_px = xmp_float(xmp, "CalibratedFocalLength")
        meta.cx_px = xmp_float(xmp, "CalibratedOpticalCenterX")
        meta.cy_px = xmp_float(xmp, "CalibratedOpticalCenterY")
        flag = xmp_float(xmp, "RtkFlag")
        if flag is not None:
            meta.rtk_fix = RTK_FLAG.get(int(flag), f"FLAG_{int(flag)}")
        std_lat, std_lon = xmp_float(xmp, "RtkStdLat"), xmp_float(xmp, "RtkStdLon")
        if std_lat is not None and std_lon is not None:
            meta.rtk_std_m = round((std_lat**2 + std_lon**2) ** 0.5, 4)

    return meta
