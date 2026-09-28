"""Pluggable trained-model detectors (weed / disease / pest) — the interface
the spec's YOLO / SAM step plugs into.

Nothing here runs a model unless one is installed: a detector is a folder
under data/models/<name>/ holding a manifest.json

    {"name": "soy-weeds-v1", "task": "weed_detection", "framework": "ultralytics",
     "weights": "best.pt", "labels": ["waterhemp", "palmer_amaranth", ...],
     "trained_on": "…", "input_gsd_m": 0.02}

plus the weights file. The registry lists what is installed so the UI can say
so honestly; `run_detectors` is the hook analysis_service calls and returns
nothing when no detector is installed. A trained model needs labelled imagery
of this crop — this project has none yet, which is why the list is empty.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from app.config import settings

# Ultralytics writes settings.json (and would download assets) under the
# user profile on C: by default; everything project-related stays on E:.
# Must be set before the package is first imported, which only happens lazily
# below, and the directory must already exist or Ultralytics silently falls
# back to the current working directory.
_YOLO_CONFIG_DIR = settings.data_dir.parent / ".cache" / "ultralytics"
_YOLO_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(_YOLO_CONFIG_DIR))

log = logging.getLogger(__name__)

SUPPORTED_TASKS = ("weed_detection", "disease_detection", "pest_detection", "crop_segmentation")


@dataclass
class DetectorInfo:
    name: str
    task: str
    framework: str
    weights: Path
    labels: list[str] = field(default_factory=list)
    trained_on: str = ""
    input_gsd_m: float | None = None
    ready: bool = False
    problem: str | None = None


@dataclass
class ModelDetection:
    type: str  # label from the model
    confidence: float
    geometry: dict  # GeoJSON, EPSG:4326
    detector: str


class Detector(Protocol):
    info: DetectorInfo

    def detect(self, orthomosaic: Path) -> list[ModelDetection]: ...


def list_detectors() -> list[DetectorInfo]:
    out: list[DetectorInfo] = []
    root: Path = settings.models_dir
    if not root.exists():
        return out
    for manifest in sorted(root.glob("*/manifest.json")):
        try:
            m = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            out.append(DetectorInfo(manifest.parent.name, "unknown", "unknown", manifest.parent, problem=f"unreadable manifest: {exc}"))
            continue
        info = DetectorInfo(
            name=str(m.get("name") or manifest.parent.name),
            task=str(m.get("task") or "unknown"),
            framework=str(m.get("framework") or "unknown"),
            weights=manifest.parent / str(m.get("weights") or ""),
            labels=[str(x) for x in m.get("labels") or []],
            trained_on=str(m.get("trained_on") or ""),
            input_gsd_m=m.get("input_gsd_m"),
        )
        if info.task not in SUPPORTED_TASKS:
            info.problem = f"unsupported task '{info.task}'"
        elif not info.weights.is_file():
            info.problem = f"weights file missing: {info.weights.name}"
        elif info.framework != "ultralytics":
            info.problem = f"no runner for framework '{info.framework}'"
        else:
            try:
                import ultralytics  # noqa: F401
                info.ready = True
            except ImportError:
                info.problem = "ultralytics is not installed in the backend environment"
        out.append(info)
    return out


def _load(info: DetectorInfo) -> Detector:
    from app.services.detectors.ultralytics_runner import UltralyticsDetector

    return UltralyticsDetector(info)


def run_detectors(orthomosaic: Path) -> list[ModelDetection]:
    """Runs every ready detector on the orthomosaic. Empty when none is installed."""
    detections: list[ModelDetection] = []
    for info in list_detectors():
        if not info.ready:
            continue
        try:
            detections.extend(_load(info).detect(orthomosaic))
        except Exception:
            log.exception("detector %s failed", info.name)
    return detections


def status() -> dict:
    infos = list_detectors()
    return {
        "models_dir": str(settings.models_dir),
        "installed": [
            {
                "name": i.name, "task": i.task, "framework": i.framework, "labels": i.labels,
                "trained_on": i.trained_on, "input_gsd_m": i.input_gsd_m, "ready": i.ready, "problem": i.problem,
            }
            for i in infos
        ],
        "note": (
            "No trained detector is installed: weed species, disease and pest detection need a model trained on "
            "labelled imagery of this crop, which this project does not have yet. The analysis you see is a "
            "measured vegetation index, not a detector."
            if not any(i.ready for i in infos)
            else "Trained detectors run on the orthomosaic during analysis; their results are labelled by model name."
        ),
    }
