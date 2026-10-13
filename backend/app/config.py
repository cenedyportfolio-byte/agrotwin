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
