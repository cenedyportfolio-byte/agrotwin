from pathlib import Path

from pydantic_settings import BaseSettings

BACKEND_DIR = Path(__file__).resolve().parent.parent
AGROTWIN_ROOT = BACKEND_DIR.parent
DATA_DIR = AGROTWIN_ROOT / "data"


def _default_raw_data_root() -> Path:
    """Folder holding the DJI mission folders. When the project lives on the
    survey drive (…/Agro/agrotwin) that is simply the parent folder, so the
    whole drive can move between machines / mount points."""
    parent = AGROTWIN_ROOT.parent
    if any(parent.glob("DJI_*")):
        return parent
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
