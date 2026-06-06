from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from ..database import Base


class AutoTagJob(Base):
    __tablename__ = "auto_tag_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    status = Column(String(20), nullable=False, default="queued", index=True)
    mode = Column(String(32), nullable=False, default="lightly_tagged")
    dry_run = Column(Boolean, default=False)
    total = Column(Integer, default=0)
    processed = Column(Integer, default=0)
    tagged = Column(Integer, default=0)
    skipped = Column(Integer, default=0)
    failed = Column(Integer, default=0)
    cancel_requested = Column(Boolean, default=False)
    settings_snapshot = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    error = Column(Text, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "status": self.status,
            "mode": self.mode,
            "dryRun": bool(self.dry_run),
            "total": self.total or 0,
            "processed": self.processed or 0,
            "tagged": self.tagged or 0,
            "skipped": self.skipped or 0,
            "failed": self.failed or 0,
            "cancelRequested": bool(self.cancel_requested),
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "startedAt": self.started_at.isoformat() if self.started_at else None,
            "finishedAt": self.finished_at.isoformat() if self.finished_at else None,
            "error": self.error,
        }


class AutoTagSuggestion(Base):
    __tablename__ = "auto_tag_suggestions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    job_id = Column(Integer, ForeignKey("auto_tag_jobs.id", ondelete="SET NULL"), nullable=True, index=True)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="suggested", index=True)
    suggested_tags = Column(Text, nullable=False, default="[]")
    suggested_safety = Column(String(10), nullable=True)
    evidence = Column(Text, nullable=False, default="{}")
    model = Column(String(128), default="")
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    applied_at = Column(DateTime, nullable=True)

    def to_dict(self):
        import json

        def parse(raw, default):
            try:
                return json.loads(raw or "")
            except Exception:
                return default

        return {
            "id": self.id,
            "jobId": self.job_id,
            "postId": self.post_id,
            "status": self.status,
            "suggestedTags": parse(self.suggested_tags, []),
            "suggestedSafety": self.suggested_safety,
            "evidence": parse(self.evidence, {}),
            "model": self.model,
            "error": self.error,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "appliedAt": self.applied_at.isoformat() if self.applied_at else None,
        }
