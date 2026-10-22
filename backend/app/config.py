import os
from pathlib import Path

from pydantic_settings import BaseSettings

# GDAL (de)compresses GeoTIFF blocks on every core instead of one: a full
# read of a survey orthomosaic drops from ~1.0 s to ~0.12 s. Lossless, so
# the pixels are identical. Set here because every entry point imports config.
os.environ.setdefault("GDAL_NUM_THREADS", "ALL_CPUS")

BACKEND_DIR = Path(__file__).resolve().parent.parent
AGROTWIN_ROOT = BACKEND_DIR.parent
# AGROTWIN_DATA_DIR moves all data (database, uploads, maps) elsewhere, e.g. a
# big disk on the server; every folder below follows it
DATA_DIR = Path(os.environ.get("AGROTWIN_DATA_DIR") or AGROTWIN_ROOT / "data")


def _default_raw_data_root() -> Path:
    """Folder holding the DJI mission folders. When the project lives on the
    survey drive (…/Agro/agrotwin) that is simply the parent folder, so the
    whole drive can move between machines / mount points. Also checks this
    checkout's own Data/ folder, where mission folders can be dropped directly."""
    parent = AGROTWIN_ROOT.parent
    if any(parent.glob("DJI_*")):
        return parent
    project_data = AGROTWIN_ROOT / "Data"
    if any(project_data.glob("DJI_*")):
        return project_data
    return Path("/media/cdev/Personal1/Development/Agro")


class Settings(BaseSettings):
    """Local-first settings. Everything defaults to paths on disk next to the repo.

    Kept as a single source of truth so storage/db locations can later move to
    env-driven cloud config without touching call sites.
    """

    app_name: str = "AgroTwin API"
    database_url: str = f"sqlite:///{DATA_DIR / 'agrotwin.db'}"

    data_dir: Path = DATA_DIR
    raw_data_root: Path = _default_raw_data_root()
    uploads_dir: Path = DATA_DIR / "uploads"
    surveys_dir: Path = DATA_DIR / "surveys"
    orthomosaics_dir: Path = DATA_DIR / "orthomosaics"
    multispectral_dir: Path = DATA_DIR / "multispectral"
    models_dir: Path = DATA_DIR / "models"
    pointclouds_dir: Path = DATA_DIR / "pointclouds"
    analysis_dir: Path = DATA_DIR / "analysis"
    tiles_dir: Path = DATA_DIR / "tiles"
    # XYZ tile pyramids are served as static files by Next.js (/tiles/<survey>/<layer>/{z}/{x}/{y})
    public_tiles_dir: Path = AGROTWIN_ROOT / "frontend" / "public" / "tiles"
    thumbs_cache_dir: Path = DATA_DIR / "cache" / "thumbs"
    asset_previews_cache_dir: Path = DATA_DIR / "cache" / "asset_previews"
    band_display_cache_dir: Path = DATA_DIR / "cache" / "band_display"
    index_preview_cache_dir: Path = DATA_DIR / "cache" / "index_previews"

    cors_origins: list[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://agency.cenedypalma.com",
        "http://agency.cenedypalma.com",
        "https://bayazid.cenedypalma.com",
        "http://bayazid.cenedypalma.com",
    ]

    # Local / Offline LLM via Ollama. Model chosen for this machine's specs
    # (RTX 4060 Ti 16GB VRAM, 32GB RAM, i5-13600K): qwen2.5:14b-instruct-q4_K_M
    # fits comfortably in VRAM (~9GB) with headroom for a concurrent GPU job,
    # and Qwen2.5 stays noticeably more faithful to the retrieved knowledge-base
    # passages / structured field JSON than smaller models — see docs/DEV_NOTES.md.
    # Ollama's own default port is 11434 (not 11435 — a prior mismatch here
    # meant the assistant could never reach Ollama even once installed).
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:14b-instruct-q4_K_M"
    ollama_timeout_s: float = 90.0

    # Sign-in (app/auth.py). Farmers mostly use phones: a long session saves
    # them typing a password in the field. Set AGROTWIN_COOKIE_SECURE=true
    # once the server is behind https, so the cookie is never sent in clear.
    session_days: int = 60
    session_cookie: str = "agrotwin_session"
    cookie_secure: bool = False

    # Detailed map (app/services/odm_service.py): after the quick map, OpenDroneMap
    # runs in Docker on the RGB photos and its results replace the quick ones.
    # Off by default (a laptop may lack Docker or the hours); on for the server.
    odm_enabled: bool = False
    odm_image: str = "opendronemap/odm:latest"  # opendronemap/odm:gpu with odm_gpus on an NVIDIA server
    odm_gpus: bool = False  # docker --gpus all (needs the NVIDIA Container Toolkit)
    odm_min_photos: int = 20  # fewer cannot make a map worth hours of processing
    odm_timeout_hours: float = 12.0
    odm_build_3d: bool = True  # also the 3D reality mesh and point cloud for the 3D view
    # The detailed-map queue (app/services/queue_service.py). Each map takes most
    # of the GPU and memory for hours: one at a time unless the server has room
    # for more. odm_hours keeps them to quiet hours, e.g. "20-6": a map starts
    # only between 8 pm and 6 am server time (one that is running carries on);
    # empty, any time.
    odm_workers: int = 1
    odm_hours: str = ""

    # Flight check after an upload (app/services/flight_check_service.py): what
    # is flagged for the next flight. The defaults follow the flight guide
    # (100 ft, 80 % front / 75 % side overlap, camera straight down, near
    # midday), less a margin for measuring overlap from the photo positions.
    # Advice only: a flagged flight is processed all the same.
    flight_max_height_ft: float = 200.0  # higher shows too little detail
    flight_max_gsd_cm: float = 2.0  # coarser cannot show small weeds
    flight_min_front_overlap: float = 70.0  # %
    flight_min_side_overlap: float = 65.0  # %
    flight_max_tilt_deg: float = 10.0  # from straight down
    flight_min_sun_deg: float = 30.0  # a lower sun casts long shadows
    flight_min_coverage: float = 97.0  # % of a flight-plan outline in the photos
    flight_max_wind_mph: float = 15.0  # the flight guide: wind below about 15 mph

    # Outside data (app/services/external_data.py): the weather (Open-Meteo),
    # the soil (USDA Soil Data Access) and the satellite passes (Sentinel-2 via
    # Earth Search). Looked up in the background and kept with the field or
    # flight. Switch off for a server without internet, or to keep every
    # field's position on this server.
    external_data: bool = True
    weather_round_deg: float = 0.05  # positions sent for weather are rounded (0.05° ≈ 5 km)
    # Open-Meteo's free API is for non-commercial use (research is fine); with a
    # key the paid one (customer-*.open-meteo.com) is used
    open_meteo_api_key: str | None = None
    soil_data_url: str = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest"
    stac_url: str = "https://earth-search.aws.element84.com/v1"
    satellite_max_cloud: float = 60.0  # % of a whole scene; the field itself is then checked pixel by pixel
    # US county boundaries (Census Bureau), downloaded once by scripts/fetch_counties.py
    counties_file: Path = DATA_DIR / "reference" / "us_counties.json.gz"

    # Spray weather (weather_service.spray_forecast): a guide, the label decides
    spray_wind_min_mph: float = 3.0  # calmer: drift risk from a temperature inversion
    spray_wind_max_mph: float = 10.0
    spray_gust_max_mph: float = 15.0
    spray_max_temp_f: float = 85.0  # hotter: some herbicides turn to vapour
    spray_rain_free_hours: int = 4  # no rain expected for this long after spraying

    # The data agreement farmers accept before they use AgroTwin
    # (app/services/agreement_service.py): a text or Markdown file. Editing the
    # file makes it a new version, which everyone accepts again. Not set: no
    # agreement is asked for.
    agreement_file: Path | None = None

    # Optional e-mail when a map is ready (no server: no e-mail). public_url is
    # the address farmers open, for the link in the message.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str = "AgroTwin <no-reply@localhost>"
    smtp_starttls: bool = True
    public_url: str = "http://localhost:3000"

    class Config:
        env_prefix = "AGROTWIN_"


settings = Settings()

for d in (
    settings.data_dir,
    settings.uploads_dir,
    settings.surveys_dir,
    settings.orthomosaics_dir,
    settings.multispectral_dir,
    settings.models_dir,
    settings.pointclouds_dir,
    settings.analysis_dir,
    settings.tiles_dir,
    settings.thumbs_cache_dir,
    settings.asset_previews_cache_dir,
    settings.band_display_cache_dir,
    settings.index_preview_cache_dir,
):
    d.mkdir(parents=True, exist_ok=True)
