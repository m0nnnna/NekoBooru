from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import relationship

from ..database import Base


class PostAiAnalysis(Base):
    __tablename__ = "post_ai_analysis"
    __table_args__ = (
        UniqueConstraint("post_id", "model_id", "profile", name="uq_post_ai_analysis_post_model_profile"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    post_id = Column(Integer, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    model_id = Column(String(128), nullable=False, index=True)
    model_name = Column(String(255), nullable=False, default="")
    profile = Column(String(64), nullable=False, default="default", index=True)
    prompt_hash = Column(String(64), nullable=True, index=True)
    prompt = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    rationale = Column(Text, nullable=True)
    semantic_tags_json = Column(Text, nullable=False, default="[]")
    safety = Column(String(10), nullable=True)
    raw_output = Column(Text, nullable=True)
    evidence_json = Column(Text, nullable=False, default="{}")
    search_text = Column(Text, nullable=False, default="")
    duration_ms = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    post = relationship("Post", back_populates="ai_analyses")

    def to_dict(self):
        import json

        def parse(raw, default):
            try:
                return json.loads(raw or "")
            except Exception:
                return default

        return {
            "id": self.id,
            "postId": self.post_id,
            "modelId": self.model_id,
            "modelName": self.model_name,
            "profile": self.profile,
            "promptHash": self.prompt_hash,
            "prompt": self.prompt,
            "summary": self.summary,
            "rationale": self.rationale,
            "semanticTags": parse(self.semantic_tags_json, []),
            "safety": self.safety,
            "rawOutput": self.raw_output,
            "evidence": parse(self.evidence_json, {}),
            "durationMs": self.duration_ms,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }
