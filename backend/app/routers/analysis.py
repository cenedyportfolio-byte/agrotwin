import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.services import detector_service, job_runner, llm_service, processing_service, rag_service

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.get("/detectors")
def list_detectors():
    """Trained detector models installed under data/models/ (none by default) —
    what the app would use for weed/disease/pest identification."""
    return detector_service.status()


@router.get("/knowledge")
def list_knowledge(q: str | None = None):
    """The assistant's local knowledge base: topics, or the passages matching `q`."""
    if q:
        return {"query": q, "passages": [p.as_dict() for p in rag_service.search(q, k=5)]}
    return {"topics": rag_service.topics()}


@router.get("/{survey_id}", response_model=schemas.AnalysisResultOut)
def get_analysis(survey_id: str, db: Session = Depends(get_db)):
    survey = db.get(models.Survey, survey_id)
    if not survey:
        raise HTTPException(404, "Survey not found")

    result = max(survey.analysis_results, key=lambda r: r.created_at, default=None)
    if not result:
        raise HTTPException(404, "No analysis available for this survey yet")

    detections = [
        schemas.DetectionZoneOut(
            id=d.id,
            type=d.type,
            severity=d.severity,
            confidence=d.confidence,
            geometry=json.loads(d.geometry_geojson),
            recommended_action=d.recommended_action,
        )
        for d in result.detections
    ]

    return schemas.AnalysisResultOut(
        survey_id=survey.id,
        analysis_summary={
            "healthy_area_percent": result.healthy_area_percent,
            "attention_area_percent": result.attention_area_percent,
            "problem_area_percent": result.problem_area_percent,
        },
        method=result.method,
        is_mock=result.is_mock,
        detections=detections,
        metrics=json.loads(result.metrics_json) if result.metrics_json else {},
    )


@router.post("/{survey_id}/recompute", response_model=schemas.ProcessingJobOut, status_code=202)
def recompute_analysis(survey_id: str, db: Session = Depends(get_db)):
    """Queues a fresh vegetation analysis from the survey's own imagery (see
    analysis_service). Poll GET /api/surveys/{id}/job for progress."""
    survey = db.get(models.Survey, survey_id)
    if not survey:
        raise HTTPException(404, "Survey not found")
    try:
        job = job_runner.enqueue(db, survey, processing_service.ANALYSIS_STEPS, processing_service.run_analysis_job)
    except job_runner.JobAlreadyRunning as exc:
        raise HTTPException(409, "This survey is being processed — wait for the current job to finish") from exc
    return processing_service.job_to_dict(job)


class AskRequest(BaseModel):
    question: str


@router.post("/{survey_id}/ask", response_model=schemas.AskResponseOut)
def ask_assistant(survey_id: str, payload: AskRequest, db: Session = Depends(get_db)):
    """Farmer-friendly Q&A grounded in this survey's structured analysis plus
    matching passages from the local knowledge base. The response names its
    responder (local Ollama model or the template) and its sources."""
    survey = db.get(models.Survey, survey_id)
    if not survey:
        raise HTTPException(404, "Survey not found")

    result = max(survey.analysis_results, key=lambda r: r.created_at, default=None)
    context = llm_service.build_field_context(survey, survey.field, result)
    answer, responder, sources = llm_service.answer_question(payload.question, context)
    return schemas.AskResponseOut(
        question=payload.question, answer=answer, responder=responder, sources=sources, context_used=context
    )
