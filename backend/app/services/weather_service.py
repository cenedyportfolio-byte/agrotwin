"""Weather from Open-Meteo (a weather model for the area, not a station at the
field): the weather during a flight — wind, gusts, cloud, rain and
temperature, and rain in the 12 hours before — for the flight check, and the
spray weather for the next two days.

Past hours come from the regular forecast for recent flights, from Open-Meteo's
archive of high-resolution forecasts for older ones (2022 on), else from its
reanalysis archive. Positions are rounded (AGROTWIN_WEATHER_ROUND_DEG). The
free API is for non-commercial use; AGROTWIN_OPEN_METEO_API_KEY switches to
the paid one.
"""

from __future__ import annotations

import json
import logging
import statistics
import threading
import time
from datetime import date, datetime, timedelta, timezone

from app import models
from app.config import settings
from app.database import SessionLocal
from app.services import external_data
from app.services.external_data import LookupFailed

log = logging.getLogger(__name__)

UNITS = {"wind_speed_unit": "mph", "temperature_unit": "fahrenheit", "precipitation_unit": "inch"}
FLIGHT_HOURLY = "temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m"
SPRAY_HOURLY = "temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m"
SOURCE = "Open-Meteo weather model"
HOSTS = {
    "forecast": "api.open-meteo.com/v1/forecast",
    "historical": "historical-forecast-api.open-meteo.com/v1/forecast",
    "archive": "archive-api.open-meteo.com/v1/archive",
}
RAIN_IN = 0.01  # an hour with at least this much is a wet hour
RAIN_CHANCE = 50  # % chance of rain that counts as rain expected
SPRAY_CACHE_S = 30 * 60
_spray_cache: dict[tuple[float, float], tuple[float, dict]] = {}
_spray_lock = threading.Lock()


def _url(kind: str) -> str:
    host = HOSTS[kind]
    return f"https://{'customer-' if settings.open_meteo_api_key else ''}{host}"


def _params(**p) -> dict:
    p.update(UNITS)
    if settings.open_meteo_api_key:
        p["apikey"] = settings.open_meteo_api_key
    return p


def rounded(lat: float, lon: float) -> tuple[float, float]:
    """The position sent for weather: rounded, so the field itself is not given away."""
    step = settings.weather_round_deg or 0.0001
    return round(round(lat / step) * step, 4), round(round(lon / step) * step, 4)


def _sources(day: date, today: date) -> list[str]:
    out = []
    if (today - day).days <= 60:
        out.append("forecast")
    if day >= date(2022, 1, 1):
        out.append("historical")
    out.append("archive")
    return out


def fetch_hours(lat: float, lon: float, start: date, end: date, hourly: str) -> dict:
    """Hourly values (UTC) for the days start..end, from the first source that has them."""
    errors = []
    for kind in _sources(start, external_data.now().date()):
        try:
            data = external_data.get_json(_url(kind), _params(
                latitude=lat, longitude=lon, start_date=start.isoformat(), end_date=end.isoformat(),
                hourly=hourly, timezone="GMT"))
        except LookupFailed as exc:
            errors.append(str(exc))
            continue
        hours = data.get("hourly") or {}
        if any(v is not None for v in hours.get("wind_speed_10m") or []):
            return hours
        errors.append(f"{kind}: no values")
    raise LookupFailed("; ".join(errors) or "no weather source answered")


# ── the weather during a flight ──────────────────────────────────────────────


def flight_window(survey: models.Survey) -> tuple[datetime, datetime, float, float] | None:
    """(first photo, last photo) in UTC and the flight's middle position."""
    from app.services.flight_check_service import photo_utc

    frames = [i for i in survey.images if i.band == "RGB"] or list(survey.images)
    located = sorted((i for i in frames if i.lat is not None and i.lon is not None and i.captured_at),
                     key=lambda i: i.captured_at)
    if not located:
        return None
    first, last = located[0], located[-1]
    utc_first, _ = photo_utc(first.path, first.captured_at, first.lon)
    if utc_first is None:
        return None
    utc_last = utc_first + (last.captured_at - first.captured_at)
    return (utc_first, utc_last, statistics.fmean(i.lat for i in located), statistics.fmean(i.lon for i in located))


def summarize_flight(hours: dict, start: datetime, end: datetime) -> dict | None:
    """Wind, gusts, cloud, rain and temperature over the flight's hours, and the rain in the 12 hours before."""
    times = [datetime.fromisoformat(t) for t in hours.get("time", [])]
    first_hour = start.replace(minute=0, second=0, microsecond=0)
    during = [i for i, t in enumerate(times) if first_hour <= t <= end + timedelta(hours=1)]
    before = [i for i, t in enumerate(times) if first_hour - timedelta(hours=12) < t <= first_hour]

    def values(key, idx):
        series = hours.get(key) or []
        return [series[i] for i in idx if i < len(series) and series[i] is not None]

    wind = values("wind_speed_10m", during)
    if not wind:
        return None
    gusts = values("wind_gusts_10m", during)
    cloud = values("cloud_cover", during)
    temp = values("temperature_2m", during)
    return {
        "wind_mph": round(max(wind), 1),
        "gust_mph": round(max(gusts), 1) if gusts else None,
        "cloud_pct": round(statistics.fmean(cloud)) if cloud else None,
        "temp_f": round(statistics.fmean(temp)) if temp else None,
        "rain_in": round(sum(values("precipitation", during)), 2),
        "rain_before_in": round(sum(values("precipitation", before)), 2),
    }


def lookup_flight(survey_id: str) -> None:
    """Background: the weather during the flight, kept in survey.weather_json."""
    db = SessionLocal()
    try:
        survey = db.get(models.Survey, survey_id)
        if survey is None:
            return
        window = flight_window(survey)
    finally:
        db.close()  # no database transaction open while the network is asked
    if window is None:
        data = {"status": "unknown", "checked_at": external_data.stamp()}
    else:
        start, end, lat, lon = window
        rlat, rlon = rounded(lat, lon)
        try:
            hours = fetch_hours(rlat, rlon, (start - timedelta(hours=12)).date(), end.date(), FLIGHT_HOURLY)
            summary = summarize_flight(hours, start, end)
            data = ({"status": "ok", "source": SOURCE, "checked_at": external_data.stamp(), **summary} if summary
                    else {"status": "unavailable", "checked_at": external_data.stamp(), "reason": "no hours for the flight"})
        except LookupFailed as exc:
            log.warning("flight weather for %s: %s", survey_id, exc)
            data = {"status": "unavailable", "checked_at": external_data.stamp(), "reason": str(exc)[:300]}
    db = SessionLocal()
    try:
        survey = db.get(models.Survey, survey_id)
        if survey is not None:
            survey.weather_json = json.dumps(data)
            db.commit()
    finally:
        db.close()


def flight_weather(survey: models.Survey, start_lookup: bool = True) -> tuple[dict | None, bool]:
    """(the flight's weather, being looked up now). Starts the lookup when there
    is none yet, or when the last one failed a while ago."""
    data = json.loads(survey.weather_json) if survey.weather_json else None
    retry = data is None or (data.get("status") == "unavailable" and external_data.stale(data.get("checked_at"), external_data.RETRY_AFTER))
    pending = False
    if retry and start_lookup and survey.images:
        pending = external_data.start(f"weather:{survey.id}", lookup_flight, survey.id)
    return (data if data and data.get("status") == "ok" else None), pending


# ── spray weather ────────────────────────────────────────────────────────────


def classify_hours(hours: dict, utc_offset_s: int, lat: float, lon: float) -> list[dict]:
    """Each forecast hour: good / marginal / bad / night for spraying, with the reason."""
    from app.services.flight_check_service import sun_elevation_deg

    s = settings
    times = hours.get("time") or []
    n = len(times)

    def at(key, i):
        values = hours.get(key) or []
        return values[i] if i < len(values) else None

    out = []
    for i, t in enumerate(times):
        local = datetime.fromisoformat(t)
        wind, gust, temp = at("wind_speed_10m", i), at("wind_gusts_10m", i), at("temperature_2m", i)
        rain = at("precipitation", i) or 0.0
        chance = at("precipitation_probability", i)
        ahead = range(i, min(i + max(1, s.spray_rain_free_hours), n))
        wet = any((at("precipitation", j) or 0) >= RAIN_IN or (at("precipitation_probability", j) or 0) >= RAIN_CHANCE for j in ahead)
        utc = local - timedelta(seconds=utc_offset_s)
        if sun_elevation_deg(utc, lat, lon) < 0:
            status, reason = "night", "Dark"
        elif wind is None:
            status, reason = "bad", "No forecast"
        elif wet:
            status, reason = "bad", f"Rain within {s.spray_rain_free_hours} h"
        elif wind > s.spray_wind_max_mph or (gust or 0) > s.spray_gust_max_mph:
            status, reason = "bad", "Too windy"
        elif wind < s.spray_wind_min_mph:
            status, reason = "marginal", "Calm: drift risk from a temperature inversion"
        elif temp is not None and temp > s.spray_max_temp_f:
            status, reason = "marginal", "Hot: some herbicides can turn to vapour"
        else:
            status, reason = "good", "Good"
        out.append({
            "time": t, "status": status, "reason": reason,
            "wind_mph": wind, "gust_mph": gust, "temp_f": temp, "rain_in": rain, "rain_chance": chance,
        })
    return out


def windows(hours: list[dict], min_hours: int = 2) -> list[dict]:
    """Runs of good hours, at least min_hours long."""
    out, run = [], []
    for h in [*hours, None]:
        if h is not None and h["status"] == "good":
            run.append(h)
            continue
        if len(run) >= min_hours:
            end = datetime.fromisoformat(run[-1]["time"]) + timedelta(hours=1)
            out.append({"start": run[0]["time"], "end": end.isoformat(timespec="minutes"), "hours": len(run)})
        run = []
    return out


def spray_forecast(lat: float, lon: float) -> dict:
    """The next 48 hours for spraying at the field. Raises LookupFailed."""
    key = rounded(lat, lon)
    with _spray_lock:
        hit = _spray_cache.get(key)
        if hit and time.monotonic() - hit[0] < SPRAY_CACHE_S:
            return hit[1]
    data = external_data.get_json(_url("forecast"), _params(
        latitude=key[0], longitude=key[1], hourly=SPRAY_HOURLY, forecast_hours=48, timezone="auto"), timeout=15)
    hours = classify_hours(data.get("hourly") or {}, int(data.get("utc_offset_seconds") or 0), lat, lon)
    if not hours:
        raise LookupFailed("the forecast had no hours")
    found = windows(hours)
    s = settings
    result = {
        "available": True,
        "source": SOURCE,
        "timezone": data.get("timezone"),
        "updated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "hours": hours,
        "windows": found,
        "next_window": found[0] if found else None,
        "limits": {"wind_min_mph": s.spray_wind_min_mph, "wind_max_mph": s.spray_wind_max_mph,
                   "gust_max_mph": s.spray_gust_max_mph, "max_temp_f": s.spray_max_temp_f,
                   "rain_free_hours": s.spray_rain_free_hours},
    }
    with _spray_lock:
        _spray_cache[key] = (time.monotonic(), result)
    return result
