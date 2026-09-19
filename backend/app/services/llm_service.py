"""AI assistant abstraction (§18: LLM/RAG architecture).

Correct architecture, per spec: Drone Data -> Computer Vision -> Structured
Results -> Database -> LLM/RAG -> Farmer-Friendly Explanation. The LLM must
never be responsible for image segmentation or precise detection — that's
`vision_service.py` / `analysis_service.py`. This module only explains
already-structured, already-computed results in plain language.

`answer_question` asks a local Ollama model (settings.ollama_*) when one is
reachable, and otherwise falls back to a template responder over the same
structured context — it answers the question categories §18 lists (field
status, problem areas, weed/inspection areas, survey comparison) using only
real numbers from the DB, never inventing findings. It reports which of the
two answered, so the UI never implies an LLM that isn't running. The
context-assembly function (`build_field_context`) is the stable interface:
another model provider plugs in beside `_query_ollama` without changing any
caller.

RAG (agricultural knowledge base, regional best practices) is intentionally
not implemented — §18 says not to build it until needed.
"""

import json
import logging
import urllib.error
import urllib.request

from app import models
from app.config import settings

logger = logging.getLogger(__name__)

TYPE_LABEL = {
    "bare_soil": "bare soil",
    "low_crop_density": "low crop density",
    "patchy_vegetation": "patchy/uneven vegetation",
    "weed_candidate": "vegetation between crop rows (weed candidate)",
}


METHOD_LABEL = {
    "ndvi_map": "a georeferenced NDVI map built from the multispectral bands",
    "exg_map": "an RGB vegetation index (Excess Green) measured on the georeferenced field photo map",
    "ndvi": "per-frame NDVI from the multispectral NIR/Red bands",
    "exg": "an RGB-only vegetation index (Excess Green) measured per photo",
}

TIER_RULE = (
    "Each 5 m patch (or photo) is compared with the vegetation cover the field's own best ground reaches: "
    "healthy = at least 80% of that cover, needs attention = 50-80%, problem = below 50%."
)


def _latest_result(survey: models.Survey) -> models.AnalysisResult | None:
    return max(survey.analysis_results, key=lambda r: r.created_at, default=None)


def build_field_context(
    survey: models.Survey, field: models.Field, result: models.AnalysisResult | None
) -> dict:
    """Structured context an LLM (or this template responder) explains — mirrors §18's example shape.
    Includes the field's previous analysed survey (if any) so comparison questions are answerable."""
    context: dict = {
        "field_name": field.name,
        "crop_type": field.crop_type,
        "area_hectares": field.area_hectares,
        "survey_name": survey.name,
        "survey_date": survey.survey_date.isoformat() if survey.survey_date else None,
        "image_count": survey.image_count,
    }

    if result is None:
        context["analysis_available"] = False
        return context

    context["analysis_available"] = True
    context["is_mock"] = result.is_mock
    context["method"] = result.method
    context["method_description"] = METHOD_LABEL.get(result.method, result.method)
    context["tier_rule"] = TIER_RULE
    metrics = json.loads(result.metrics_json) if result.metrics_json else {}
    rows = metrics.get("rows") or {}
    if rows:
        context["rows"] = {
            "status": rows.get("status"),
            "explanation": rows.get("reason"),
            "row_spacing_m": rows.get("row_spacing_m"),
            "row_bearing_deg": rows.get("row_orientation_deg"),
            "canopy_closure_percent": rows.get("canopy_closure_percent"),
            "vegetation_cover_percent": rows.get("vegetation_cover_percent"),
            "weed_candidate_count": rows.get("candidate_count", 0),
        }
    detectors = metrics.get("detectors") or {}
    context["trained_detectors"] = {
        "installed": detectors.get("installed", []),
        "note": detectors.get("note", "No trained weed/disease detector is installed; the analysis is a vegetation index."),
    }
    context["healthy_area_percent"] = result.healthy_area_percent
    context["attention_area_percent"] = result.attention_area_percent
    context["problem_area_percent"] = result.problem_area_percent
    context["detected_issues"] = [
        {
            "type": TYPE_LABEL.get(d.type, d.type),
            "severity": d.severity,
            "confidence": d.confidence,
            "recommended_action": d.recommended_action,
        }
        for d in result.detections
    ]

    previous = [
        s for s in field.surveys
        if s.id != survey.id and _latest_result(s) is not None
        and (s.survey_date or s.created_at) <= (survey.survey_date or survey.created_at)
    ]
    if previous:
        prev = max(previous, key=lambda s: s.survey_date or s.created_at)
        pr = _latest_result(prev)
        context["previous_survey"] = {
            "survey_name": prev.name,
            "survey_date": prev.survey_date.isoformat() if prev.survey_date else None,
            "method": pr.method,
            "healthy_area_percent": pr.healthy_area_percent,
            "attention_area_percent": pr.attention_area_percent,
            "problem_area_percent": pr.problem_area_percent,
            "zone_count": len(pr.detections),
        }
    return context


def _query_ollama(question: str, context: dict, passages: list) -> str | None:
    """Queries local Ollama instance running the offline model (e.g. llama3.2:3b)."""
    system_prompt = (
        "You are AgroTwin's AI Agricultural Assistant, an expert in precision agriculture, "
        "drone remote sensing, and soybean agronomy. You communicate in clear, farmer-friendly, "
        "and practical language.\n\n"
        "Guidelines:\n"
        "1. Ground your answers strictly in the structured field and survey data provided below.\n"
        "2. Do not invent diagnoses, crop diseases, or specific chemical/pesticide recommendations without ground confirmation.\n"
        "3. Explain vegetation metrics (NDVI, NDRE, ExG, health percentages) clearly and provide practical actionable advice (e.g., ground truthing, checking drainage, scouting weed patches or soil compaction in problem zones).\n"
        "4. If asked about who you are or general agronomy questions, introduce yourself politely and provide helpful context about the field.\n"
        "5. This reply is shown in a phone-sized chat bubble, not a printed report. Write it like a text message: "
        "short plain sentences, 2-4 short paragraphs at most. Do NOT use markdown headings (no #, ##, ###) or "
        "horizontal rules, and do not bold whole sentences. Use a short bullet list (plain \"-\" lines, no bold) "
        "only when there are three or more genuinely separate items to list; otherwise just write sentences. "
        "You may bold ONE or two key numbers or terms with **like this** if it truly helps, never more."
    )

    field_summary = json.dumps(context, indent=2)
    notes = "\n\n".join(f"[{p.title} — {p.section}]\n{p.text}" for p in passages)
    prompt = (
        f"Field & Survey Context:\n```json\n{field_summary}\n```\n\n"
        + (f"Reference notes from the AgroTwin knowledge base (general agronomy; cite them when used):\n{notes}\n\n" if notes else "")
        + f"Farmer Question: {question}\n\n"
        "AgroTwin Assistant Response:"
    )

    payload = {
        "model": settings.ollama_model,
        "prompt": prompt,
        "system": system_prompt,
        "stream": False,
        "options": {
            "temperature": 0.3,
            "num_predict": 512,
        },
    }

    url = f"{settings.ollama_base_url.rstrip('/')}/api/generate"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=settings.ollama_timeout_s) as response:
            if response.status == 200:
                res_data = json.loads(response.read().decode("utf-8"))
                ans = res_data.get("response", "").strip()
                if ans:
                    return ans
    except Exception as e:
        logger.warning("Ollama query to %s failed (%s), falling back to template responder", url, e)
        return None


def _template_answer(question: str, context: dict) -> str:
    """Deterministic fallback responder over structured data."""
    if not context.get("analysis_available"):
        return (
            f"There's no analysis yet for {context['field_name']}'s survey "
            f"\"{context['survey_name']}\" — it needs geotagged RGB images and a "
            "processing run before I can tell you anything about field health."
        )

    q = question.lower()
    healthy = context["healthy_area_percent"]
    attention = context["attention_area_percent"]
    problem = context["problem_area_percent"]
    issues = context["detected_issues"]

    if any(k in q for k in ("weed", "where are the")):
        rows = context.get("rows") or {}
        weeds = [i for i in issues if i["type"] == TYPE_LABEL["weed_candidate"]]
        if rows.get("status") == "measured" and weeds:
            return (
                f"{len(weeds)} patches of vegetation growing between the crop rows were flagged as weed candidates "
                f"(rows are {rows.get('row_spacing_m')} m apart). I can't tell the species from the image — walk to "
                "them, identify what is growing and how big it is, and record it."
            )
        if rows.get("status") in ("canopy_closed", "rows_not_locked", "rows_not_found"):
            text = f"Weed candidates could not be measured on this survey: {rows.get('explanation')}."
            if rows.get("status") == "canopy_closed":
                text += " For weed mapping, fly the field early in the season (about V2–V4) while the rows are still separate."
            if issues:
                text += "\n\nThe zones that were flagged are areas of lower vegetation cover, not weeds:\n" + "\n".join(
                    f"- {i['type']} ({i['severity']} severity): {i['recommended_action']}" for i in issues
                )
            return text
        if not issues:
            return "No specific zones were flagged in this survey — vegetation coverage looked consistent across the field."
        lines = [f"- {i['type']} ({i['severity']} severity, {round(i['confidence']*100)}% confidence): {i['recommended_action']}" for i in issues]
        return "I can't identify weed species from drone imagery alone (that needs a trained detector), but these zones showed measurably lower vegetation coverage:\n" + "\n".join(lines)

    if any(k in q for k in ("row", "canopy", "spacing")):
        rows = context.get("rows") or {}
        if rows.get("row_spacing_m"):
            text = f"Rows run at a bearing of {rows.get('row_bearing_deg')}° and are {rows.get('row_spacing_m')} m apart"
            if rows.get("canopy_closure_percent") is not None:
                text += f"; the canopy covers {rows.get('canopy_closure_percent')}% of the ground between rows"
            return text + f". Vegetation cover across the field is {rows.get('vegetation_cover_percent')}%."
        return "Row spacing could not be measured on this survey" + (f": {rows.get('explanation')}." if rows.get("explanation") else ".")

    if any(k in q for k in ("compare", "previous", "changed", "last survey")):
        prev = context.get("previous_survey")
        if not prev:
            return (
                "I don't have an earlier analysed survey for this field to compare against — "
                "run another survey and I'll be able to tell you what changed."
            )
        delta = round(healthy - prev["healthy_area_percent"], 1)
        direction = "up" if delta > 0 else "down" if delta < 0 else "unchanged"
        text = (
            f"Compared with \"{prev['survey_name']}\": healthy coverage is {direction} "
            f"({prev['healthy_area_percent']}% → {healthy}%), attention {prev['attention_area_percent']}% → {attention}%, "
            f"problem {prev['problem_area_percent']}% → {problem}%; flagged zones {prev['zone_count']} → {len(issues)}."
        )
        if prev["method"] != context["method"]:
            text += (
                f"\n\nCaution: the two surveys were measured differently — the earlier one used "
                f"{METHOD_LABEL.get(prev['method'], prev['method'])}, this one used "
                f"{METHOD_LABEL.get(context['method'], context['method'])} — and each survey's tiers are relative "
                "to its own best-growing ground, so treat this as a rough trend, not a like-for-like change."
            )
        return text

    if any(k in q for k in ("inspect", "problem", "issue", "attention")):
        if not issues:
            return f"Nothing needs inspection right now — {healthy}% of sampled coverage looks healthy."
        return (
            f"{len(issues)} area(s) are flagged for a look: "
            + "; ".join(f"{TYPE_LABEL.get(i['type'], i['type'])} ({i['severity']})" for i in issues)
            + ". None of this is a diagnosis — it's based on measured vegetation cover, so ground inspection is the next step."
        )

    # default: overall status
    return (
        f"{context['field_name']} ({context['crop_type']}) — survey \"{context['survey_name']}\": "
        f"🟢 {healthy}% healthy, 🟡 {attention}% needs attention, 🔴 {problem}% flagged as a problem area, "
        f"measured with {METHOD_LABEL.get(context.get('method'), 'a vegetation index')}.\n\n{TIER_RULE}"
    )


def answer_question(question: str, context: dict) -> tuple[str, str, list[dict]]:
    """(answer, responder, sources): the local Ollama model when reachable,
    else the template responder over the same structured data; both get the
    knowledge-base passages that match the question, returned as sources."""
    from app.services import rag_service

    passages = rag_service.search(question, k=3)
    sources = [p.as_dict() for p in passages]

    if context.get("analysis_available"):
        ollama_response = _query_ollama(question, context, passages)
        if ollama_response:
            return ollama_response, f"ollama:{settings.ollama_model}", sources

    answer = _template_answer(question, context)
    if passages:
        top = passages[0]
        answer += f"\n\nFrom the knowledge base — {top.title}, {top.section}: {top.snippet()}"
    return answer, "template", sources
