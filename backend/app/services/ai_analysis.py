from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Post, PostAiAnalysis


SEMANTIC_KINDS = {"qwen", "qwen_gguf"}


def _as_dict(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _as_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _clean_text(value: Any, *, limit: int = 12000) -> str:
    text_value = str(value or "").replace("\x00", " ").strip()
    text_value = re.sub(r"\s+", " ", text_value)
    return text_value[:limit]


def _semantic_tag_names(parsed: dict, fallback_tags: list[str] | None = None) -> list[str]:
    raw_tags = parsed.get("tags") or parsed.get("keywords") or parsed.get("search_tags") or fallback_tags or []
    tags = []
    seen = set()
    for value in _as_list(raw_tags):
        tag = re.sub(r"[^\w:.-]+", "_", str(value).strip().lower()).strip("_")
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags


def _prompt_for_options(opts: Any | None) -> str:
    if not opts:
        return ""
    if getattr(opts, "semanticPromptEnabled", True) is False:
        try:
            from .auto_tagger import DEFAULT_SEMANTIC_PROMPT

            return DEFAULT_SEMANTIC_PROMPT
        except Exception:
            return ""
    return _clean_text(getattr(opts, "semanticPrompt", "") or "")


def _prompt_hash(prompt: str) -> str | None:
    if not prompt:
        return None
    return hashlib.sha256(prompt.encode("utf-8", errors="ignore")).hexdigest()


def _iter_model_evidence(preview_or_result: Any):
    if hasattr(preview_or_result, "evidence"):
        evidence = getattr(preview_or_result, "evidence") or {}
        model_name = getattr(preview_or_result, "model", "") or ""
        duration_ms = int(getattr(preview_or_result, "duration_ms", 0) or 0)
    else:
        payload = _as_dict(preview_or_result)
        evidence = _as_dict(payload.get("evidence"))
        model_name = payload.get("model") or ""
        duration_ms = int(payload.get("durationMs") or 0)

    if isinstance(evidence.get("models"), list):
        for item in evidence["models"]:
            model_payload = _as_dict(item)
            yield {
                "model": model_payload.get("model") or "",
                "durationMs": int(model_payload.get("durationMs") or 0),
                "evidence": _as_dict(model_payload.get("evidence")),
                "error": model_payload.get("error"),
            }
        return

    yield {
        "model": model_name,
        "durationMs": duration_ms,
        "evidence": evidence,
        "error": None,
    }


def _analysis_payloads(preview_or_result: Any, *, opts: Any | None = None, profile: str | None = None) -> list[dict]:
    prompt = _prompt_for_options(opts)
    prompt_hash = _prompt_hash(prompt)
    payloads = []
    for item in _iter_model_evidence(preview_or_result):
        evidence = _as_dict(item.get("evidence"))
        kind = str(evidence.get("kind") or "").lower()
        model_name = str(item.get("model") or evidence.get("model") or "").strip()
        model_id = str(evidence.get("modelId") or model_name or kind).strip()
        model_key = f"{kind} {model_id} {model_name}".lower()
        if kind not in SEMANTIC_KINDS and "qwen" not in model_key:
            continue
        if item.get("error") or evidence.get("error"):
            continue

        parsed = _as_dict(evidence.get("parsed"))
        raw_output = _clean_text(evidence.get("raw") or parsed.get("raw") or "")
        semantic_tags = _semantic_tag_names(parsed)
        try:
            from .auto_tagger import normalize_safety_label

            safety = normalize_safety_label(parsed.get("safety"))
        except Exception:
            safety = parsed.get("safety") if parsed.get("safety") in {"safe", "sketchy", "unsafe"} else None
        rationale = _clean_text(parsed.get("rationale") or parsed.get("reason") or "")
        summary = _clean_text(
            parsed.get("summary")
            or parsed.get("description")
            or parsed.get("caption")
            or parsed.get("scene")
            or rationale
            or raw_output,
            limit=4000,
        )
        if not any([semantic_tags, summary, rationale, raw_output]):
            continue

        search_text = _clean_text(
            " ".join(
                part
                for part in [
                    model_name,
                    model_id,
                    profile or "default",
                    safety or "",
                    " ".join(semantic_tags),
                    summary,
                    rationale,
                    raw_output,
                ]
                if part
            ),
            limit=20000,
        )
        payloads.append(
            {
                "model_id": model_id or "qwen",
                "model_name": model_name or model_id or "Qwen",
                "profile": profile or "default",
                "prompt_hash": prompt_hash,
                "prompt": prompt,
                "summary": summary,
                "rationale": rationale,
                "semantic_tags": semantic_tags,
                "safety": safety,
                "raw_output": raw_output,
                "evidence": evidence,
                "search_text": search_text,
                "duration_ms": int(item.get("durationMs") or evidence.get("durationMs") or 0),
            }
        )
    return payloads


async def _sync_fts_row(db: AsyncSession, analysis: PostAiAnalysis) -> None:
    try:
        await db.execute(
            text("DELETE FROM post_ai_analysis_fts WHERE rowid = :rowid"),
            {"rowid": analysis.id},
        )
        await db.execute(
            text(
                "INSERT INTO post_ai_analysis_fts(rowid, post_id, search_text) "
                "VALUES (:rowid, :post_id, :search_text)"
            ),
            {
                "rowid": analysis.id,
                "post_id": analysis.post_id,
                "search_text": analysis.search_text or "",
            },
        )
    except Exception:
        pass


async def save_analysis_from_result(
    db: AsyncSession,
    post_id: int,
    preview_or_result: Any,
    *,
    opts: Any | None = None,
    profile: str | None = None,
) -> list[PostAiAnalysis]:
    saved = []
    for payload in _analysis_payloads(preview_or_result, opts=opts, profile=profile):
        result = await db.execute(
            select(PostAiAnalysis).where(
                PostAiAnalysis.post_id == post_id,
                PostAiAnalysis.model_id == payload["model_id"],
                PostAiAnalysis.profile == payload["profile"],
            )
        )
        analysis = result.scalars().first()
        if not analysis:
            analysis = PostAiAnalysis(
                post_id=post_id,
                model_id=payload["model_id"],
                profile=payload["profile"],
            )
            db.add(analysis)
        analysis.model_name = payload["model_name"]
        analysis.prompt_hash = payload["prompt_hash"]
        analysis.prompt = payload["prompt"]
        analysis.summary = payload["summary"]
        analysis.rationale = payload["rationale"]
        analysis.semantic_tags_json = json.dumps(payload["semantic_tags"], ensure_ascii=False)
        analysis.safety = payload["safety"]
        analysis.raw_output = payload["raw_output"]
        analysis.evidence_json = json.dumps(payload["evidence"], ensure_ascii=False)
        analysis.search_text = payload["search_text"]
        analysis.duration_ms = payload["duration_ms"]
        analysis.updated_at = datetime.utcnow()
        await db.flush()
        await _sync_fts_row(db, analysis)
        saved.append(analysis)
    return saved


def _analysis_search_text(analysis: PostAiAnalysis) -> str:
    try:
        semantic_tags = json.loads(analysis.semantic_tags_json or "[]")
    except Exception:
        semantic_tags = []
    if not isinstance(semantic_tags, list):
        semantic_tags = []
    return _clean_text(
        " ".join(
            part
            for part in [
                analysis.model_name,
                analysis.model_id,
                analysis.profile,
                analysis.safety or "",
                " ".join(str(tag) for tag in semantic_tags),
                analysis.summary or "",
                analysis.rationale or "",
                analysis.raw_output or "",
            ]
            if part
        ),
        limit=20000,
    )


async def update_post_analysis_description(
    db: AsyncSession,
    post_id: int,
    analysis_id: int,
    description: Any,
) -> PostAiAnalysis | None:
    result = await db.execute(
        select(PostAiAnalysis).where(
            PostAiAnalysis.id == analysis_id,
            PostAiAnalysis.post_id == post_id,
        )
    )
    analysis = result.scalars().first()
    if not analysis:
        return None

    cleaned = _clean_text(description, limit=4000)
    analysis.summary = cleaned
    analysis.rationale = cleaned
    analysis.search_text = _analysis_search_text(analysis)
    analysis.updated_at = datetime.utcnow()
    await db.flush()
    await _sync_fts_row(db, analysis)
    return analysis


async def list_post_analysis(db: AsyncSession, post_id: int) -> list[dict]:
    rows = (
        await db.execute(
            select(PostAiAnalysis)
            .where(PostAiAnalysis.post_id == post_id)
            .order_by(PostAiAnalysis.updated_at.desc(), PostAiAnalysis.id.desc())
        )
    ).scalars().all()
    return [row.to_dict() for row in rows]


async def delete_post_analysis(db: AsyncSession, post_id: int) -> int:
    rows = (
        await db.execute(select(PostAiAnalysis.id).where(PostAiAnalysis.post_id == post_id))
    ).scalars().all()
    if rows:
        try:
            for row_id in rows:
                await db.execute(text("DELETE FROM post_ai_analysis_fts WHERE rowid = :rowid"), {"rowid": row_id})
        except Exception:
            pass
    result = await db.execute(delete(PostAiAnalysis).where(PostAiAnalysis.post_id == post_id))
    return int(result.rowcount or 0)


def semantic_analysis_condition(word: str):
    normalized = re.sub(r"[^\w:.-]+", " ", str(word or "").lower()).strip()
    if len(normalized) < 2:
        return None
    escaped = (
        normalized
        .replace("\\", "\\\\")
        .replace("%", "\\%")
        .replace("_", "\\_")
    )

    def boundary_match(column):
        lowered = func.lower(column)
        return or_(
            lowered == normalized,
            lowered.like(f"{escaped} %", escape="\\"),
            lowered.like(f"% {escaped}", escape="\\"),
            lowered.like(f"% {escaped} %", escape="\\"),
            lowered.like(f"{escaped}\\_%", escape="\\"),
            lowered.like(f"%\\_{escaped}", escape="\\"),
            lowered.like(f"%\\_{escaped}\\_%", escape="\\"),
        )

    return Post.id.in_(
        select(PostAiAnalysis.post_id).where(
            or_(
                boundary_match(PostAiAnalysis.search_text),
                boundary_match(PostAiAnalysis.summary),
                boundary_match(PostAiAnalysis.rationale),
                boundary_match(PostAiAnalysis.raw_output),
                boundary_match(PostAiAnalysis.semantic_tags_json),
            )
        )
    )
