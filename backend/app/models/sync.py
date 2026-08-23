from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime

from ..database import Base


class SyncLog(Base):
    """Append-only change log driving two-way sync.

    Every meaningful write (from the web UI or the API) appends a row here via
    SQLAlchemy ORM event listeners (see ``app/services/sync.py``). The
    autoincrement ``id`` is a strictly increasing cursor the client uses to ask
    "what changed since N?".

    ``entity_key`` is the *stable, cross-device* identifier for the row:
      - post     -> sha256
      - tag      -> name
      - pool     -> uuid
      - note     -> uuid
      - comment  -> uuid
      - favorite -> the favorited post's sha256
    """

    __tablename__ = "sync_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entity_type = Column(String(20), nullable=False)
    entity_key = Column(String(255), nullable=False, index=True)
    op = Column(String(10), nullable=False)  # "upsert" | "delete"
    ts = Column(DateTime, default=datetime.utcnow, nullable=False)
    # NULL = a global/shared-vocabulary change (tags), visible to every
    # syncing client. Non-NULL scopes the row to that user's own library.
    user_id = Column(Integer, nullable=True, index=True)
