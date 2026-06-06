from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, select

from ..database import async_session
from ..models import AutoTagJob, AutoTagSuggestion
from ..services import auto_tag_jobs
from ..services.auto_tagger import (
    delete_huggingface_token,
    download_model,
    load_options,
    current_download_job,
    current_model_load_job,
    model_statuses,
    save_huggingface_token,
    save_options,
    start_model_load,
    start_model_download,
    status as tagger_status,
    unload_model,
)

router = APIRouter(prefix="/api/auto-tags", tags=["auto-tags"])


class AutoTagSettingsBody(BaseModel):
    settings: dict


class JobCreateBody(BaseModel):
    mode: str = "lightly_tagged"
    dryRun: bool = True
    postIds: list[int] = []
    settings: dict = {}


class ApplyPostBody(BaseModel):
    tags: Optional[list[str]] = None
    safety: Optional[str] = None
    categories: dict = {}
    settings: dict = {}


class HuggingFaceTokenBody(BaseModel):
    token: str


@router.get("/settings")
async def get_auto_tag_settings():
    return load_options().__dict__


@router.put("/settings")
async def put_auto_tag_settings(body: AutoTagSettingsBody):
    return save_options(body.settings).__dict__


@router.get("/status")
async def get_auto_tag_status():
    return tagger_status()


@router.post("/model/download")
async def download_auto_tag_model():
    try:
        return download_model()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Model download failed: {exc}")


@router.get("/models")
async def get_auto_tag_models():
    return {
        "models": model_statuses(),
        "downloadJob": current_download_job(),
    }


@router.post("/models/{model_id}/download")
async def download_one_auto_tag_model(model_id: str):
    try:
        return start_model_download([model_id])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/models/download-all")
async def download_all_auto_tag_models():
    try:
        ids = [model["id"] for model in model_statuses()]
        return start_model_download(ids)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/models/download-job")
async def get_auto_tag_download_job():
    return current_download_job()


@router.post("/models/{model_id}/load")
async def load_one_auto_tag_model(model_id: str):
    try:
        return start_model_load(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/models/load-job")
async def get_auto_tag_load_job():
    return current_model_load_job()


@router.post("/models/{model_id}/unload")
async def unload_one_auto_tag_model(model_id: str):
    try:
        return unload_model(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/huggingface-token")
async def put_huggingface_token(body: HuggingFaceTokenBody):
    try:
        save_huggingface_token(body.token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return tagger_status()


@router.delete("/huggingface-token")
async def delete_huggingface_token_endpoint():
    delete_huggingface_token()
    return tagger_status()


@router.get("/estimate")
async def estimate_auto_tag_job(mode: str = Query("lightly_tagged")):
    return await auto_tag_jobs.estimate(mode)


@router.post("/jobs")
async def create_auto_tag_job(body: JobCreateBody):
    try:
        job = await auto_tag_jobs.create_job(
            mode=body.mode,
            dry_run=body.dryRun,
            post_ids=body.postIds,
            overrides=body.settings,
        )
        return job.to_dict()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/jobs/current")
async def current_auto_tag_job():
    async with async_session() as db:
        result = await db.execute(
            select(AutoTagJob)
            .where(AutoTagJob.status.in_(["queued", "running", "cancelling"]))
            .order_by(desc(AutoTagJob.created_at))
            .limit(1)
        )
        job = result.scalars().first()
        return job.to_dict() if job else None


@router.get("/jobs/{job_id}")
async def get_auto_tag_job(job_id: int):
    async with async_session() as db:
        job = await db.get(AutoTagJob, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job.to_dict()


@router.get("/jobs/{job_id}/suggestions")
async def get_auto_tag_suggestions(job_id: int, page: int = 1, limit: int = 100):
    async with async_session() as db:
        result = await db.execute(
            select(AutoTagSuggestion)
            .where(AutoTagSuggestion.job_id == job_id)
            .order_by(AutoTagSuggestion.id)
            .offset((page - 1) * limit)
            .limit(limit)
        )
        return [row.to_dict() for row in result.scalars().all()]


@router.post("/jobs/{job_id}/cancel")
async def cancel_auto_tag_job(job_id: int):
    try:
        return await auto_tag_jobs.cancel_job(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")


@router.post("/jobs/{job_id}/apply")
async def apply_auto_tag_job_suggestions(job_id: int):
    try:
        return await auto_tag_jobs.apply_job_suggestions(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
