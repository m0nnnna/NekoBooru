from __future__ import annotations

import json
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from ..database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _json_load(value: str | None, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


class UploadJob(Base):
    """Durable state for interactive uploads and remote clip renders."""

    __tablename__ = "upload_jobs"

    id = Column(String(36), primary_key=True, default=_uuid)
    kind = Column(String(32), nullable=False, index=True)
    status = Column(String(32), nullable=False, default="created", index=True)
    operation = Column(String(32), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    ready_for = Column(String(32), nullable=True)
    overall_progress = Column(Integer, nullable=False, default=0)
    message = Column(Text, nullable=False, default="Created")
    source_url = Column(Text, nullable=True)
    profile = Column(String(32), nullable=False, default="x-standard")
    selection_start_ms = Column(Integer, nullable=True)
    selection_end_ms = Column(Integer, nullable=True)
    source_metadata_json = Column(Text, nullable=False, default="{}")
    stages_json = Column(Text, nullable=False, default="[]")
    metrics_json = Column(Text, nullable=False, default="{}")
    error_json = Column(Text, nullable=True)
    result_post_id = Column(Integer, ForeignKey("posts.id", ondelete="SET NULL"), nullable=True)
    idempotency_key = Column(String(255), nullable=True, unique=True, index=True)
    cancel_requested = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True, index=True)

    artifacts = relationship(
        "UploadArtifact",
        back_populates="job",
        cascade="all, delete-orphan",
        order_by="UploadArtifact.created_at",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "operation": self.operation,
            "revision": self.revision,
            "readyFor": self.ready_for,
            "overallProgress": self.overall_progress,
            "message": self.message,
            "sourceUrl": self.source_url,
            "profile": self.profile,
            "selection": (
                {"startMs": self.selection_start_ms, "endMs": self.selection_end_ms}
                if self.selection_start_ms is not None and self.selection_end_ms is not None
                else None
            ),
            "source": _json_load(self.source_metadata_json, {}),
            "stages": _json_load(self.stages_json, []),
            "metrics": _json_load(self.metrics_json, {}),
            "error": _json_load(self.error_json, None),
            "resultPostId": self.result_post_id,
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            "canCancel": self.status in {"probing", "sampling", "rendering", "publishing", "uploading", "downloading"},
            "canRetry": self.status in {"failed", "cancelled", "interrupted"},
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
            "expiresAt": self.expires_at.isoformat() if self.expires_at else None,
        }


class UploadArtifact(Base):
    __tablename__ = "upload_artifacts"

    id = Column(String(36), primary_key=True, default=_uuid)
    job_id = Column(String(36), ForeignKey("upload_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(32), nullable=False, index=True)
    relative_path = Column(Text, nullable=False)
    filename = Column(String(255), nullable=False)
    mime_type = Column(String(100), nullable=False, default="application/octet-stream")
    file_size = Column(Integer, nullable=False, default=0)
    sha256 = Column(String(64), nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    duration = Column(Float, nullable=True)
    metadata_json = Column(Text, nullable=False, default="{}")
    claimed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True, index=True)

    job = relationship("UploadJob", back_populates="artifacts")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "role": self.role,
            "filename": self.filename,
            "mimeType": self.mime_type,
            "fileSize": self.file_size,
            "sha256": self.sha256,
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "metadata": _json_load(self.metadata_json, {}),
            "contentUrl": f"/api/upload-artifacts/{self.id}/content",
            "downloadUrl": f"/api/upload-artifacts/{self.id}/content?download=1",
            "claimedAt": self.claimed_at.isoformat() if self.claimed_at else None,
            "expiresAt": self.expires_at.isoformat() if self.expires_at else None,
        }
