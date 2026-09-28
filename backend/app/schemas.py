from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class FarmOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    location_name: str | None = None
    created_at: datetime


class FieldCreate(BaseModel):
    farm_id: str | None = None
    name: str
    crop_type: str = "soybean"


class FieldUpdate(BaseModel):
    name: str | None = None
    crop_type: str | None = None


class FieldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    farm_id: str
    name: str
    crop_type: str
    boundary_geojson: str | None = None
    area_hectares: float | None = None
    center_lat: float | None = None
    center_lon: float | None = None
    created_at: datetime


class FieldSummary(FieldOut):
    latest_survey_id: str | None = None
    latest_survey_status: str | None = None
    healthy_area_percent: float | None = None
    attention_area_percent: float | None = None
    problem_area_percent: float | None = None
    analysis_method: str | None = None
    analysis_is_mock: bool | None = None


class SurveyCreate(BaseModel):
    field_id: str
    name: str
    drone_model: str | None = None


class SurveyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    field_id: str
    name: str
    survey_date: datetime | None = None
    drone_model: str | None = None
    image_count: int
    frame_count: int = 0
    status: str
    created_at: datetime


class SurveyImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    survey_id: str
    filename: str
    band: str
    lat: float | None = None
    lon: float | None = None
    altitude_m: float | None = None
    captured_at: datetime | None = None
    width: int | None = None
    height: int | None = None
    frame_key: str | None = None
    vegetation_fraction: float | None = None
    ndvi_mean: float | None = None
    ndre_mean: float | None = None
    gndvi_mean: float | None = None
    gimbal_yaw_deg: float | None = None
    gimbal_pitch_deg: float | None = None
    rel_altitude_m: float | None = None
    rtk_fix: str | None = None
    rtk_std_m: float | None = None


class SurveyAssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    survey_id: str
    asset_type: str
    format: str | None = None
    bounds_geojson: str | None = None
    source: str
    public_url: str | None = None
    created_at: datetime


class SurveyAssetsAvailability(BaseModel):
    rgb_images: bool
    gps_metadata: bool
    multispectral: bool
    nir: bool
    red_edge: bool
    thermal: bool
    orthomosaic: bool
    model_3d: bool
    pointcloud: bool
    gnss_ppk: bool
    dsm: bool
    vector_overlays: bool = False


class DetectionZoneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    type: str
    severity: str
    confidence: float
    geometry: dict[str, Any]
    recommended_action: str


class AnalysisResultOut(BaseModel):
    survey_id: str
    analysis_summary: dict[str, float]
    method: str  # ndvi_map | exg_map | ndvi | exg — see analysis_service
    is_mock: bool
    detections: list[DetectionZoneOut]
    # row geometry / canopy closure / weed-candidate status / detectors — see weed_service, detector_service
    metrics: dict[str, Any] = {}


class KnowledgeSource(BaseModel):
    title: str
    section: str
    snippet: str
    score: float


class AskResponseOut(BaseModel):
    question: str
    answer: str
    responder: str
    sources: list[KnowledgeSource] = []
    context_used: dict[str, Any]


class ProcessingJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    survey_id: str
    status: str
    current_step: str | None = None
    steps: list[dict[str, Any]] = []
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
