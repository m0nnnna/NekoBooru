from __future__ import annotations

import asyncio
import json
import shutil
import threading
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import async_session, get_db
from ..dependencies import get_current_user
from ..models import UploadArtifact, User
from ..services import upload_jobs as jobs
from . import posts, uploads


router = APIRouter(prefix="/api", tags=["upload-jobs"])


class SelectionRequest(BaseModel):
    startMs: int
    endMs: int


class CreateUploadJobRequest(BaseModel):
    kind: str = "remote_clip"
    sourceUrl: str | None = None
    selection: SelectionRequest | None = None
    profile: str = "x-standard"
    filename: str | None = None
    size: int | None = None
    mimeType: str | None = None


class SampleRequest(SelectionRequest):
    revision: int


class RenderRequest(BaseModel):
    revision: int
    profile: str = "x-standard"


class PublishRequest(BaseModel):
    artifactId: str
    revision: int
    tags: list[str] = Field(default_factory=list)
    safety: str = "safe"
    source: str | None = None
    autoTag: bool = False
    autoTagProfile: str | None = None


def _http_error(exc: jobs.JobError) -> HTTPException:
    status = 404 if exc.code in {"job_not_found", "artifact_not_found"} else 409 if exc.code in {"job_busy", "stale_revision", "preview_required"} else 400
    return HTTPException(status_code=status, detail=exc.to_dict())


@router.post("/upload-jobs", status_code=202)
async def create_upload_job(request: CreateUploadJobRequest, idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    try:
        if request.kind == "remote_clip":
            if not request.sourceUrl:
                raise jobs.JobError("invalid_url", "A sourceUrl is required for remote clips.")
            return await jobs.create_remote_job(
                request.sourceUrl,
                request.selection.model_dump() if request.selection else None,
                request.profile,
                idempotency_key,
            )
        return await jobs.create_ingest_job(
            request.kind,
            request.sourceUrl,
            request.filename,
            request.size,
            request.mimeType,
            idempotency_key,
        )
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.put("/upload-jobs/{job_id}/content")
async def put_upload_job_content(job_id: str, request: Request):
    raw_length = request.headers.get("content-length")
    try:
        content_length = int(raw_length) if raw_length is not None else None
    except ValueError:
        raise HTTPException(status_code=400, detail={"code": "invalid_content_length", "message": "Content-Length is invalid."})
    try:
        return await jobs.store_local_content(job_id, request.stream(), content_length)
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.get("/upload-jobs/{job_id}")
async def get_upload_job(job_id: str):
    result = await jobs.snapshot(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "Upload job not found."})
    return result


@router.get("/upload-jobs/{job_id}/events")
async def upload_job_events(job_id: str):
    if await jobs.snapshot(job_id) is None:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "Upload job not found."})

    async def stream():
        first = True
        async for payload in jobs.subscribe(job_id):
            if payload is None:
                yield ": heartbeat\n\n"
            else:
                if first:
                    event = "snapshot"
                    first = False
                elif payload.get("status") == "failed":
                    event = "error"
                elif payload.get("status") in jobs.ACTIVE_STATES:
                    event = "progress"
                else:
                    event = "state"
                yield f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/upload-jobs/{job_id}/sample", status_code=202)
async def sample_upload_job(job_id: str, request: SampleRequest):
    try:
        return await jobs.request_sample(job_id, request.startMs, request.endMs, request.revision)
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.post("/upload-jobs/{job_id}/render", status_code=202)
async def render_upload_job(job_id: str, request: RenderRequest):
    try:
        return await jobs.request_render(job_id, request.revision, request.profile)
    except jobs.JobError as exc:
        raise _http_error(exc)


async def _publish(job_id: str, request: PublishRequest, cancel_event: threading.Event, owner_id: int) -> None:
    copied_path = None
    token = None
    try:
        job = await jobs.get_job(job_id)
        if not job:
            raise jobs.JobError("job_not_found", "Upload job not found.")
        if request.revision != job.revision:
            raise jobs.JobError("stale_revision", "The reviewed clip changed; review the latest render before publishing.")
        allowed_role = "render" if job.kind == "remote_clip" else "source"
        artifact = next((item for item in job.artifacts if item.id == request.artifactId and item.role == allowed_role), None)
        if not artifact:
            raise jobs.JobError("artifact_not_found", "The reviewed render artifact was not found.")
        source_path = jobs.artifact_path(artifact)
        if not source_path.exists():
            raise jobs.JobError("artifact_missing", "The reviewed render file has expired.", retryable=True)
        if cancel_event.is_set():
            raise jobs.JobCancelled()
        await jobs.update_job(job_id, status="publishing", operation="publish", ready_for=None, overall_progress=0, stages=jobs._stages("publish"), metrics={}, error=None)
        await jobs.set_progress(job_id, "publish", "validate", 5, "Validating reviewed clip")
        digest = await asyncio.to_thread(jobs.sha256_file, source_path)
        if digest != artifact.sha256:
            raise jobs.JobError("artifact_changed", "The reviewed clip changed on disk and will not be published.")
        await jobs.set_progress(job_id, "publish", "hash", 15, "Checking for duplicates")
        token = str(uuid.uuid4())
        settings.uploads_dir.mkdir(parents=True, exist_ok=True)
        copied_path = settings.uploads_dir / f"{token}{source_path.suffix.lower()}"
        await asyncio.to_thread(shutil.copy2, source_path, copied_path)
        if cancel_event.is_set():
            raise jobs.JobCancelled()
        uploads.upload_tokens[token] = copied_path
        await jobs.set_progress(job_id, "publish", "store", 30, "Storing reviewed media")
        await jobs.set_progress(job_id, "publish", "inspect", 40, "Inspecting media")
        await jobs.set_progress(job_id, "publish", "thumbnail", 50, "Generating thumbnail")
        await jobs.set_progress(job_id, "publish", "phash", 60, "Generating similarity hash")
        if request.autoTag:
            await jobs.set_progress(job_id, "publish", "ai", 70, "Analyzing clip with AI")
        else:
            await jobs.set_progress(job_id, "publish", "ai", 90, "AI tagging disabled")
        async with async_session() as session:
            if cancel_event.is_set():
                raise jobs.JobCancelled()
            owner = await session.get(User, owner_id)
            if owner is None:
                raise jobs.JobError("owner_not_found", "The user who started this job no longer exists.")
            created = await posts.create_post(
                posts.CreatePostRequest(
                    contentToken=token,
                    tags=request.tags,
                    safety=request.safety,
                    source=request.source or job.source_url,
                    autoTag=request.autoTag,
                    autoTagProfile=request.autoTagProfile,
                ),
                current_user=owner,
                db=session,
            )
        await jobs.set_progress(job_id, "publish", "commit", 98, "Committing post")
        remaining = await _mark_published_artifact(job_id, artifact.id, created["id"])
        terminal = job.kind == "remote_clip" or remaining == 0
        await jobs.update_job(
            job_id,
            status="completed" if terminal else "content_ready",
            ready_for=None if terminal else "publish",
            result_post_id=created["id"],
            overall_progress=100,
            message=f"Post #{created['id']} created" if terminal else f"Post #{created['id']} created — {remaining} attachment(s) remain",
            stages=jobs.completed_stages("publish"),
            metrics={},
        )
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        if exc.status_code == 409 and detail.get("code") == "duplicate_post" and detail.get("postId"):
            remaining = await _mark_published_artifact(job_id, request.artifactId, detail["postId"])
            current = await jobs.get_job(job_id)
            terminal = current is None or current.kind == "remote_clip" or remaining == 0
            await jobs.update_job(job_id, status="completed" if terminal else "content_ready", ready_for=None if terminal else "publish", result_post_id=detail["postId"], overall_progress=100, message=f"Media already exists as post #{detail['postId']}", error=None)
        else:
            await jobs._fail(job_id, jobs.JobError("publish_failed", detail.get("message") or str(exc.detail), retryable=True))
    except Exception as exc:
        await jobs._fail(job_id, exc)
    finally:
        if token:
            uploads.remove_upload_token(token)
        if copied_path:
            copied_path.unlink(missing_ok=True)


async def _mark_published_artifact(job_id: str, artifact_id: str, post_id: int) -> int:
    async with async_session() as session:
        stored = await session.get(UploadArtifact, artifact_id)
        if stored:
            metadata = json.loads(stored.metadata_json or "{}")
            metadata["resultPostId"] = post_id
            stored.metadata_json = json.dumps(metadata, separators=(",", ":"))
            stored.claimed_at = datetime.utcnow()
        await session.commit()
        remaining = await session.scalar(
            select(func.count()).select_from(UploadArtifact).where(
                UploadArtifact.job_id == job_id,
                UploadArtifact.role == "source",
                UploadArtifact.claimed_at.is_(None),
            )
        )
        return int(remaining or 0)


@router.post("/upload-jobs/{job_id}/publish", status_code=202)
async def publish_upload_job(
    job_id: str,
    request: PublishRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    current_user: User = Depends(get_current_user),
):
    job = await jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "job_not_found", "message": "Upload job not found."})
    if job.status == "completed" and job.result_post_id:
        return job.to_dict()
    if job.status == "publishing":
        return job.to_dict()
    required_status = "render_ready" if job.kind == "remote_clip" else "content_ready"
    if job.status != required_status:
        raise HTTPException(status_code=409, detail={"code": "artifact_not_ready", "message": "Review a completed upload artifact before publishing."})
    await jobs.update_job(
        job_id,
        status="publishing",
        operation="publish",
        ready_for=None,
        overall_progress=0,
        message="Queued for publication",
        stages=jobs._stages("publish"),
        metrics={},
        error=None,
        cancel_requested=False,
    )
    try:
        await jobs.launch_custom(
            job_id, lambda cancel_event: _publish(job_id, request, cancel_event, current_user.id)
        )
    except jobs.JobError as exc:
        raise _http_error(exc)
    result = await jobs.snapshot(job_id)
    assert result is not None
    return result


@router.post("/upload-jobs/{job_id}/cancel", status_code=202)
async def cancel_upload_job(job_id: str):
    try:
        return await jobs.cancel(job_id)
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.post("/upload-jobs/{job_id}/retry", status_code=202)
async def retry_upload_job(job_id: str):
    try:
        return await jobs.retry(job_id)
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.delete("/upload-jobs/{job_id}", status_code=204)
async def remove_upload_job(job_id: str):
    try:
        await jobs.delete_job(job_id)
    except jobs.JobError as exc:
        raise _http_error(exc)


@router.get("/upload-artifacts/{artifact_id}/content")
async def get_upload_artifact(artifact_id: str, download: bool = Query(False), db: AsyncSession = Depends(get_db)):
    artifact = await db.get(UploadArtifact, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail={"code": "artifact_not_found", "message": "Upload artifact not found."})
    try:
        path = jobs.artifact_path(artifact)
    except jobs.JobError as exc:
        raise _http_error(exc)
    if not path.exists():
        raise HTTPException(status_code=404, detail={"code": "artifact_missing", "message": "Upload artifact expired."})
    disposition = "attachment" if download else "inline"
    return FileResponse(path, media_type=artifact.mime_type, filename=artifact.filename, content_disposition_type=disposition)
