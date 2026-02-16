from sqlalchemy import (
    Column,
    Integer,
    String,
    DateTime,
    Text,
    ForeignKey,
    Float,
    LargeBinary,
    UniqueConstraint,
)
from datetime import datetime
from .db import Base


class Document(Base):
    __tablename__ = "documents"
    id = Column(Integer, primary_key=True, index=True)
    property_id = Column(Integer, ForeignKey("properties.id"), index=True, nullable=False)
    filename = Column(String, nullable=False)
    path = Column(String, nullable=True)
    file_bytes = Column(LargeBinary, nullable=True)
    content_type = Column(String, nullable=True)
    extracted_text = Column(Text, nullable=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow)

class Chunk(Base):
    __tablename__ = "chunks"
    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id"), index=True, nullable=False)
    chunk_id = Column(String, index=True)
    text = Column(Text, nullable=False)
    embedding_json = Column(Text, nullable=True)


class TimelineItem(Base):
    __tablename__ = "timeline_items"
    id = Column(Integer, primary_key=True, index=True)
    document_id = Column(Integer, ForeignKey("documents.id"), index=True, nullable=False)
    property_id = Column(Integer, ForeignKey("properties.id"), index=True, nullable=False)
    title = Column(String, nullable=False)
    date_iso = Column(String, nullable=False)
    time_24h = Column(String, nullable=True)
    category = Column(String, nullable=False)
    amount_eur = Column(Float, nullable=True)
    description = Column(Text, nullable=False)
    source_quote = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TimelineItemTranslation(Base):
    __tablename__ = "timeline_item_translations"
    __table_args__ = (
        UniqueConstraint("timeline_item_id", "language", name="uq_timeline_item_language"),
    )

    id = Column(Integer, primary_key=True, index=True)
    timeline_item_id = Column(
        Integer,
        ForeignKey("timeline_items.id"),
        index=True,
        nullable=False,
    )
    language = Column(String(2), index=True, nullable=False)
    translated_title = Column(Text, nullable=False)
    translated_description = Column(Text, nullable=False)
    source_fingerprint = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class LoginToken(Base):
    __tablename__ = "login_tokens"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    used_at = Column(DateTime, nullable=True, index=True)


class Property(Base):
    __tablename__ = "properties"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    name = Column(String, nullable=False)
    address_optional = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
