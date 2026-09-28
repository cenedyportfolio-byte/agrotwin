import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """Present for the eventual multi-user SaaS migration. Auth is
    intentionally not implemented for the local MVP (dev rule #13) — there is
    no login flow and no FK from Farm enforces an owner yet. A single
    row is enough to prove the schema/relationship shape out."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Farm(Base):
    __tablename__ = "farms"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String)
    location_name: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    fields: Mapped[list["Field"]] = relationship(back_populates="farm", cascade="all, delete-orphan")


class Field(Base):
    __tablename__ = "fields"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    farm_id: Mapped[str] = mapped_column(ForeignKey("farms.id"))
    name: Mapped[str] = mapped_column(String)
    crop_type: Mapped[str] = mapped_column(String, default="soybean")
    boundary_geojson: Mapped[str | None] = mapped_column(Text, nullable=True)
    area_hectares: Mapped[float | None] = mapped_column(Float, nullable=True)
    center_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    center_lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    farm: Mapped[Farm] = relationship(back_populates="fields")
    surveys: Mapped[list["Survey"]] = relationship(back_populates="field", cascade="all, delete-orphan")


class Survey(Base):
    __tablename__ = "surveys"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    field_id: Mapped[str] = mapped_column(ForeignKey("fields.id"))
    name: Mapped[str] = mapped_column(String)
    survey_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    drone_model: Mapped[str | None] = mapped_column(String, nullable=True)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="PENDING")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    field: Mapped[Field] = relationship(back_populates="surveys")
    images: Mapped[list["SurveyImage"]] = relationship(back_populates="survey", cascade="all, delete-orphan")

    @property
    def frame_count(self) -> int:
        """Shutter releases (a multispectral frame is 5 files)."""
        return len({img.frame_key or img.id for img in self.images})
    assets: Mapped[list["SurveyAsset"]] = relationship(back_populates="survey", cascade="all, delete-orphan")
    jobs: Mapped[list["ProcessingJob"]] = relationship(back_populates="survey", cascade="all, delete-orphan")
    analysis_results: Mapped[list["AnalysisResult"]] = relationship(
        back_populates="survey", cascade="all, delete-orphan"
    )


class SurveyImage(Base):
    __tablename__ = "survey_images"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    survey_id: Mapped[str] = mapped_column(ForeignKey("surveys.id"))
    filename: Mapped[str] = mapped_column(String)
    file_path: Mapped[str] = mapped_column(String)
    # RGB | GREEN | RED | RED_EDGE | NIR (DJI M3M layout) | THERMAL (future)
    band: Mapped[str] = mapped_column(String, default="RGB")
    # Groups the files of one shutter release (DJI_<datetime>_<seq>): the RGB
    # JPG and its four multispectral TIFs share a frame_key.
    frame_key: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    altitude_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Measured from this frame's own pixels during analysis — null until it
    # has actually run. vegetation_fraction comes from NDVI when NIR/RED
    # bands exist, otherwise from the RGB Excess Green Index; the *_mean
    # columns are only set when the corresponding bands exist.
    vegetation_fraction: Mapped[float | None] = mapped_column(Float, nullable=True)
    ndvi_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    ndre_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    gndvi_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    # Camera geometry from DJI XMP — what direct georeferencing needs.
    gimbal_yaw_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    gimbal_pitch_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    rel_altitude_m: Mapped[float | None] = mapped_column(Float, nullable=True)  # AGL from takeoff
    focal_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    cx_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    cy_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    rtk_fix: Mapped[str | None] = mapped_column(String, nullable=True)  # FIXED | FLOAT | SINGLE | none
    rtk_std_m: Mapped[float | None] = mapped_column(Float, nullable=True)  # horizontal 1σ

    survey: Mapped[Survey] = relationship(back_populates="images")

    @property
    def path(self) -> Path:
        """file_path re-rooted onto the current mount (see storage_service.resolve_path)."""
        from app.services.storage_service import resolve_path

        return resolve_path(self.file_path)


class SurveyAsset(Base):
    __tablename__ = "survey_assets"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    survey_id: Mapped[str] = mapped_column(ForeignKey("surveys.id"))
    asset_type: Mapped[str] = mapped_column(String)
    # orthomosaic | ndvi | ndre | gndvi | thermal | model3d | pointcloud | tileset | boundary
    file_path: Mapped[str] = mapped_column(String)
    format: Mapped[str | None] = mapped_column(String, nullable=True)
    bounds_geojson: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String, default="manual_import")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    survey: Mapped[Survey] = relationship(back_populates="assets")

    @property
    def path(self) -> Path:
        """file_path re-rooted onto the current mount (see storage_service.resolve_path)."""
        from app.services.storage_service import resolve_path

        return resolve_path(self.file_path)

    @property
    def public_url(self) -> str | None:
        """URL the viewer loads this asset from: files under frontend/public are
        served statically by Next.js (tile pyramids, generated 3D Tilesets);
        manual imports are served by the API from their import folder. None
        for files only the backend reads."""
        from urllib.parse import quote

        from app.config import AGROTWIN_ROOT
        from app.services.storage_service import asset_import_dir

        path = self.path.resolve()
        try:
            return "/" + path.relative_to((AGROTWIN_ROOT / "frontend" / "public").resolve()).as_posix()
        except ValueError:
            pass
        try:
            rel = path.relative_to(asset_import_dir(self.survey_id, self.id).resolve())
        except ValueError:
            return None
        return f"/api/surveys/{self.survey_id}/assets/{self.id}/files/{quote(rel.as_posix())}"


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    survey_id: Mapped[str] = mapped_column(ForeignKey("surveys.id"))
    status: Mapped[str] = mapped_column(String, default="PENDING")
    current_step: Mapped[str | None] = mapped_column(String, nullable=True)
    steps_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    survey: Mapped[Survey] = relationship(back_populates="jobs")


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    survey_id: Mapped[str] = mapped_column(ForeignKey("surveys.id"))
    healthy_area_percent: Mapped[float] = mapped_column(Float, default=0)
    attention_area_percent: Mapped[float] = mapped_column(Float, default=0)
    problem_area_percent: Mapped[float] = mapped_column(Float, default=0)
    # ndvi_map | exg_map (5 m cells on a georeferenced mosaic) or ndvi | exg (one sample per frame)
    method: Mapped[str] = mapped_column(String, default="exg")
    is_mock: Mapped[bool] = mapped_column(Boolean, default=True)
    # Extra measured metrics (row geometry, canopy closure, weed-candidate status, detectors run) — see weed_service
    metrics_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    survey: Mapped[Survey] = relationship(back_populates="analysis_results")
    detections: Mapped[list["DetectionZone"]] = relationship(
        back_populates="analysis_result", cascade="all, delete-orphan"
    )


class DetectionZone(Base):
    __tablename__ = "detection_zones"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    analysis_result_id: Mapped[str] = mapped_column(ForeignKey("analysis_results.id"))
    type: Mapped[str] = mapped_column(String)
    severity: Mapped[str] = mapped_column(String)  # low | medium | high
    confidence: Mapped[float] = mapped_column(Float)
    geometry_geojson: Mapped[str] = mapped_column(Text)
    recommended_action: Mapped[str] = mapped_column(String, default="Ground inspection recommended")

    analysis_result: Mapped[AnalysisResult] = relationship(back_populates="detections")
