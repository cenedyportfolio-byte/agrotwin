from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    name: str | None = None
    role: str
    is_active: bool = True
    created_at: datetime
    consent_version: str | None = None  # the data agreement accepted (a hash of its text)
    consent_at: datetime | None = None
    consent_required: bool = False  # a farmer who must accept the current agreement first


class AgreementOut(BaseModel):
    """The data agreement in force (agreement_service)."""
    version: str
    title: str
    text: str
    accepted: bool  # by the signed-in user, this version
    accepted_at: datetime | None = None


class AgreementAccept(BaseModel):
    version: str  # the version read: a changed agreement is read again


class AccountDelete(BaseModel):
    password: str
    confirm: str  # the word DELETE, typed


class AccountDeleteByAdmin(BaseModel):
    confirm: str  # the account's email, typed


class LoginRequest(BaseModel):
    email: str
    password: str
    # the web sign-in's "Keep this device signed in": off (a shared computer),
    # the cookie ends with the browser session instead of lasting session_days
    remember: bool = True


class LoginResponse(BaseModel):
    user: UserOut
    token: str  # the mobile app sends it as a Bearer header; the web app uses the cookie


class HandoffRedeem(BaseModel):
    code: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class UserCreate(BaseModel):
    email: str
    name: str | None = None
    role: str = "farmer"
    password: str


class UserUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    password: str | None = None  # an admin setting a new password (signs the user out everywhere)


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
    owner_id: str | None = None  # staff creating a field for a farmer


class FieldUpdate(BaseModel):
    name: str | None = None
    crop_type: str | None = None
    owner_id: str | None = None  # staff only: move the field to this farmer's farm


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
    boundary_source: str | None = None  # None: estimated from the photos; "flight_plan"
    boundary_file: str | None = None
    created_at: datetime


class FieldSummary(FieldOut):
    owner_id: str | None = None
    owner_name: str | None = None
    latest_survey_id: str | None = None
    latest_survey_status: str | None = None
    healthy_area_percent: float | None = None
    attention_area_percent: float | None = None
    problem_area_percent: float | None = None
    analysis_method: str | None = None
    analysis_is_mock: bool | None = None
    county: str | None = None  # "Putnam County, TN" (county_service; US only)


class BoundaryFileInfo(BaseModel):
    """What was read from a flight-plan file (boundary_file_service)."""
    filename: str | None = None
    kind: str
    area_hectares: float
    notes: list[str] = []


class BoundaryFileResult(BaseModel):
    field: FieldSummary
    kind: str | None = None
    notes: list[str] = []
    rechecking: int = 0  # flights whose crop health is being checked again on the new outline


class FlightCheckItem(BaseModel):
    key: str  # height | detail | angle | front_overlap | side_overlap | coverage | sun | weather | gps | bands | days
    label: str
    status: str  # ok | warn (advice for the next flight) | info
    value: str
    target: str | None = None
    message: str | None = None


class FlightCheckOut(BaseModel):
    """How the flight was flown, from its photos' own data (flight_check_service)."""
    status: str  # good | check (something to fix next time) | unknown (no flight data)
    summary: str
    frames: int
    items: list[FlightCheckItem]
    pending: bool = False  # the flight's weather is being looked up: ask again shortly


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


class GroundControlPointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    lat: float
    lon: float
    height_m: float | None = None
    source: str
    score: float | None = None
    size_m: float | None = None
    rtk: bool | None = None


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


class JobQueuePlace(BaseModel):
    """Where a waiting job is in line (queue_service.position)."""
    ahead: int  # jobs running or queued before it on its queue
    wait_minutes: int | None = None  # estimate from recent jobs; None without history
    hours: str | None = None  # "8 pm–6 am": the hours detailed maps start in
    starts_at: str | None = None  # "8 pm": waiting for those hours


class ProcessingJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    survey_id: str
    status: str
    current_step: str | None = None
    steps: list[dict[str, Any]] = []
    error_message: str | None = None
    error_detail: str | None = None  # technical; the web app shows it to staff only
    created_at: datetime | None = None
    updated_at: datetime | None = None
    queued_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    queue: JobQueuePlace | None = None  # only while it waits


class QueueJobOut(BaseModel):
    """A job in the staff queue view (queue_service.overview)."""
    id: str
    survey_id: str
    survey_name: str | None = None
    field_id: str | None = None
    field_name: str | None = None
    owner: str | None = None
    queue: str  # quick | detailed
    kind: str  # "Field map", "Detailed map", …
    status: str
    step: str | None = None
    note: str | None = None
    photos: int = 0
    place: int | None = None  # 1 = next to start on its queue
    wait_minutes: int | None = None
    queued_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error_message: str | None = None


class QueueSettingsOut(BaseModel):
    detailed_enabled: bool
    detailed_workers: int
    detailed_hours: str | None = None  # "8 pm–6 am"; None: any time
    detailed_hours_setting: str | None = None  # AGROTWIN_ODM_HOURS as written
    detailed_open_now: bool


class QueueOut(BaseModel):
    jobs: list[QueueJobOut]  # running, then waiting in the order they will run
    recent: list[QueueJobOut]  # finished in the last few days, newest first
    settings: QueueSettingsOut
