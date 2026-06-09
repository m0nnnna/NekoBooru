import json
import tempfile
from ipaddress import ip_address
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import desc, select

from ..config import settings
from ..database import async_session
from ..models import AutoTagJob, AutoTagSuggestion
from ..services import auto_tag_jobs
from ..services.auto_tagger import (
    _infer_local,
    cancel_model_download,
    delete_model_cache,
    delete_huggingface_token,
    delete_tagger_worker_token,
    download_all_model_ids,
    download_model,
    load_options,
    current_download_job,
    current_model_load_job,
    model_statuses,
    result_to_json,
    save_huggingface_token,
    save_options,
    save_tagger_worker_token,
    start_model_load,
    start_model_download,
    status as tagger_status,
    tagger_worker_token,
    unload_model,
    validate_options,
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


class WorkerTokenBody(BaseModel):
    token: str


def _require_worker_token(x_tagger_token: Optional[str]) -> None:
    """Authenticate inbound worker calls.

    Loopback-only development can omit a token, but any worker bound to a
    network interface must configure NEKO_TAGGER_WORKER_TOKEN or the saved
    worker token before accepting inference uploads.
    """
    expected = tagger_worker_token()
    if not expected and not _host_is_loopback(settings.host):
        raise HTTPException(
            status_code=403,
            detail="Remote tagger worker token is required when NEKO_HOST is not loopback",
        )
    if expected and x_tagger_token != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing tagger worker token")


def _host_is_loopback(host: str) -> bool:
    normalized = str(host or "").strip().lower()
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


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
        ids = download_all_model_ids()
        return start_model_download(ids)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/models/download-job")
async def get_auto_tag_download_job():
    return current_download_job()


@router.post("/models/download-job/cancel")
async def cancel_auto_tag_download_job():
    try:
        return cancel_model_download()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


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


@router.delete("/models/{model_id}")
async def delete_one_auto_tag_model(model_id: str):
    try:
        return delete_model_cache(model_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


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


@router.put("/worker-token")
async def put_worker_token(body: WorkerTokenBody):
    try:
        save_tagger_worker_token(body.token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return tagger_status()


@router.delete("/worker-token")
async def delete_worker_token_endpoint():
    delete_tagger_worker_token()
    return tagger_status()


@router.post("/infer")
async def infer_media(
    file: UploadFile = File(...),
    options: str = Form("{}"),
    x_tagger_token: Optional[str] = Header(None),
):
    """Stateless inference endpoint served by a GPU worker instance.

    Accepts a media file plus JSON options, runs the model pipeline locally in
    this process, and returns the tag result. Used by another NekoBooru instance
    that has remote inference enabled.
    """
    _require_worker_token(x_tagger_token)

    try:
        parsed = json.loads(options or "{}")
        if not isinstance(parsed, dict):
            parsed = {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="options must be valid JSON")

    # Force local inference so a misconfigured worker can't bounce the request on.
    opts = validate_options({**load_options().__dict__, **parsed, "remoteEnabled": False, "enabled": True})

    suffix = Path(file.filename or "").suffix or ".bin"
    infer_dir = settings.cache_dir / "infer"
    infer_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=suffix, dir=infer_dir)
    tmp_path = Path(tmp_name)
    try:
        with open(fd, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        result = _infer_local(tmp_path, opts)
        return json.loads(result_to_json(result))
    finally:
        tmp_path.unlink(missing_ok=True)


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
