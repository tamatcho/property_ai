from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime, timezone
import hashlib
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Literal

from ..firebase_auth import get_current_user
from ..db import get_db
from ..models import Document, TimelineItem, TimelineItemTranslation, User
from ..property_access import get_owned_property_or_404
from ..extractors import extract_timeline
from ..rag import translate_timeline_fields
from ..timeline_service import extract_and_store_timeline_for_document

router = APIRouter(prefix="/timeline", tags=["timeline"], dependencies=[Depends(get_current_user)])

SUPPORTED_TIMELINE_LANGUAGES = {"de", "en", "fr"}

class TimelineRequest(BaseModel):
    raw_text: str


class TimelineDocumentsRequest(BaseModel):
    property_id: int
    document_ids: list[int] | None = None


@router.get("")
def list_timeline(
    property_id: int,
    document_id: int | None = None,
    language: Literal["de", "en", "fr"] = "de",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_property_or_404(db, current_user.id, property_id)
    query = db.query(TimelineItem, Document).join(Document, TimelineItem.document_id == Document.id)
    query = query.filter(TimelineItem.property_id == property_id, Document.property_id == property_id)
    if document_id is not None:
        query = query.filter(TimelineItem.document_id == document_id)
    rows = query.order_by(TimelineItem.date_iso.asc(), TimelineItem.time_24h.asc(), TimelineItem.id.asc()).all()

    if language not in SUPPORTED_TIMELINE_LANGUAGES:
        raise HTTPException(status_code=400, detail="Unsupported language. Use one of: de, en, fr")

    translated_fields: dict[int, tuple[str, str]] = {}
    if language != "de" and rows:
        item_ids = [item.id for item, _ in rows]
        source_fingerprints = {
            item.id: hashlib.sha256(
                f"{item.title}\n{item.description}".encode("utf-8")
            ).hexdigest()
            for item, _ in rows
        }

        cached_rows = (
            db.query(TimelineItemTranslation)
            .filter(
                TimelineItemTranslation.language == language,
                TimelineItemTranslation.timeline_item_id.in_(item_ids),
            )
            .all()
        )
        cache_by_item_id = {cache.timeline_item_id: cache for cache in cached_rows}

        pending_items: list[TimelineItem] = []
        for item, _ in rows:
            cached = cache_by_item_id.get(item.id)
            if cached and cached.source_fingerprint == source_fingerprints[item.id]:
                translated_fields[item.id] = (
                    cached.translated_title,
                    cached.translated_description,
                )
                continue
            pending_items.append(item)

        changed_cache = False
        for item in pending_items:
            try:
                translated = translate_timeline_fields(
                    title=item.title,
                    description=item.description,
                    target_language=language,
                )
            except RuntimeError:
                translated_fields[item.id] = (item.title, item.description)
                continue

            translated_title = translated.get("title", item.title)
            translated_description = translated.get("description", item.description)
            translated_fields[item.id] = (translated_title, translated_description)

            cached = cache_by_item_id.get(item.id)
            if cached:
                cached.translated_title = translated_title
                cached.translated_description = translated_description
                cached.source_fingerprint = source_fingerprints[item.id]
            else:
                db.add(
                    TimelineItemTranslation(
                        timeline_item_id=item.id,
                        language=language,
                        translated_title=translated_title,
                        translated_description=translated_description,
                        source_fingerprint=source_fingerprints[item.id],
                    )
                )
            changed_cache = True

        if changed_cache:
            try:
                db.commit()
            except Exception:
                db.rollback()

    return [
        {
            "timeline_item_id": item.id,
            "property_id": item.property_id,
            "document_id": item.document_id,
            "filename": doc.filename,
            "document_uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
            "title": translated_fields.get(item.id, (item.title, item.description))[0],
            "date_iso": item.date_iso,
            "time_24h": item.time_24h,
            "category": item.category,
            "amount_eur": item.amount_eur,
            "description": translated_fields.get(item.id, (item.title, item.description))[1],
            "source_quote": item.source_quote,
        }
        for item, doc in rows
    ]


@router.post("/extract")
def timeline_extract(req: TimelineRequest):
    raw_text = req.raw_text.strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="raw_text must not be empty")

    try:
        result = extract_timeline(raw_text)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Timeline extraction failed")

    return result.model_dump()


@router.post("/extract-documents")
def timeline_extract_documents(
    req: TimelineDocumentsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_property_or_404(db, current_user.id, req.property_id)
    query = db.query(Document).filter(Document.property_id == req.property_id)
    if req.document_ids:
        query = query.filter(Document.id.in_(req.document_ids))
    docs = query.order_by(Document.uploaded_at.asc()).all()
    if not docs:
        raise HTTPException(status_code=400, detail="No documents available for timeline extraction")

    merged_items: list[dict] = []
    failed_documents: list[dict] = []
    processed_documents = 0

    for doc in docs:
        try:
            items = extract_and_store_timeline_for_document(db, doc)
            if not items:
                failed_documents.append({"document_id": doc.id, "filename": doc.filename, "reason": "empty_text"})
                continue
            processed_documents += 1
            merged_items.extend(
                [
                    {
                        **item,
                        "property_id": req.property_id,
                        "document_id": doc.id,
                        "filename": doc.filename,
                        "source": f"Dokument: {doc.filename}",
                    }
                    for item in items
                ]
            )
        except RuntimeError as e:
            failed_documents.append({"document_id": doc.id, "filename": doc.filename, "reason": str(e)})
        except Exception:
            failed_documents.append(
                {"document_id": doc.id, "filename": doc.filename, "reason": "document_timeline_extraction_failed"}
            )

    if not merged_items and failed_documents:
        db.rollback()
        raise HTTPException(status_code=502, detail="Timeline extraction failed for all selected documents")

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Timeline persistence failed")

    merged_items.sort(key=lambda x: (x.get("date_iso") or "", x.get("time_24h") or "99:99", x.get("title") or ""))

    return {
        "items": merged_items,
        "documents_considered": len(docs),
        "documents_processed": processed_documents,
        "documents_failed": failed_documents,
    }


@router.post("/rebuild")
def timeline_rebuild(
    property_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    get_owned_property_or_404(db, current_user.id, property_id)
    docs = db.query(Document).filter(Document.property_id == property_id).order_by(Document.uploaded_at.asc()).all()
    if not docs:
        raise HTTPException(status_code=400, detail="No documents available for timeline rebuild")

    items_count = 0
    processed_documents = 0
    failed_documents: list[dict] = []
    for doc in docs:
        try:
            items = extract_and_store_timeline_for_document(db, doc)
            items_count += len(items)
            processed_documents += 1
        except RuntimeError:
            db.rollback()
            failed_documents.append(
                {
                    "document_id": doc.id,
                    "filename": doc.filename,
                    "reason": "document_timeline_extraction_failed",
                }
            )
        except Exception:
            db.rollback()
            failed_documents.append(
                {
                    "document_id": doc.id,
                    "filename": doc.filename,
                    "reason": "document_timeline_rebuild_failed",
                }
            )

    if processed_documents == 0 and failed_documents:
        raise HTTPException(status_code=502, detail="Timeline extraction failed for all selected documents")

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Timeline persistence failed")

    return {
        "items_count": items_count,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "documents_considered": len(docs),
        "documents_processed": processed_documents,
        "documents_failed": failed_documents,
    }
