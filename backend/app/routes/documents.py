import os
import re
import json
import io
import zipfile
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import Document
from ..config import settings
from ..pdf_ingest import extract_text_from_pdf, simple_chunk
from ..rag import upsert_chunks
from ..timeline_service import extract_and_store_timeline_for_document

router = APIRouter(prefix="/documents", tags=["documents"])
MAX_ZIP_PDF_FILES = 100
MAX_ZIP_TOTAL_PDF_BYTES = 200 * 1024 * 1024


def _sanitize_filename(filename: str) -> str:
    name = os.path.basename(filename or "").strip()
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return safe


def _count_uploaded_pdfs(upload_dir: str) -> int:
    if not os.path.isdir(upload_dir):
        return 0
    return sum(
        1
        for name in os.listdir(upload_dir)
        if os.path.isfile(os.path.join(upload_dir, name)) and name.lower().endswith(".pdf")
    )


def _load_faiss_meta_entries() -> list[dict]:
    meta_path = os.path.join(settings.FAISS_DIR, "meta.json")
    if not os.path.exists(meta_path):
        return []
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _resolve_unique_upload_name(filename: str) -> tuple[str, str]:
    base, ext = os.path.splitext(filename)
    candidate = filename
    counter = 1
    while os.path.exists(os.path.join(settings.UPLOAD_DIR, candidate)):
        counter += 1
        candidate = f"{base}_{counter}{ext}"
    return candidate, os.path.join(settings.UPLOAD_DIR, candidate)


def _ingest_pdf_content(db: Session, filename: str, content: bytes) -> dict:
    safe_filename = _sanitize_filename(filename)
    if not safe_filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    if not content.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF")

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    final_filename, save_path = _resolve_unique_upload_name(safe_filename)
    with open(save_path, "wb") as f:
        f.write(content)

    doc = Document(filename=final_filename, path=save_path)
    try:
        db.add(doc)
        db.commit()
        db.refresh(doc)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Could not persist document metadata")

    text = extract_text_from_pdf(save_path)
    chunks = simple_chunk(text)

    payload = []
    for i, ch in enumerate(chunks):
        payload.append({
            "document_id": doc.id,
            "chunk_id": f"{doc.id}-{i}",
            "text": ch
        })

    try:
        upsert_chunks(payload, settings.FAISS_DIR)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Vector indexing failed")

    try:
        timeline_items = extract_and_store_timeline_for_document(db, doc, raw_text=text)
        db.commit()
    except RuntimeError as e:
        db.rollback()
        raise HTTPException(status_code=502, detail=str(e))
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Timeline extraction failed")

    return {
        "document_id": doc.id,
        "filename": final_filename,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
        "chunks_indexed": len(payload),
        "timeline_items_stored": len(timeline_items),
    }


@router.get("/status")
def documents_status(db: Session = Depends(get_db)):
    docs_count = db.query(Document).count()
    upload_pdf_count = _count_uploaded_pdfs(settings.UPLOAD_DIR)
    meta = _load_faiss_meta_entries()
    indexed_doc_ids = {item.get("document_id") for item in meta if item.get("document_id") is not None}
    index_exists = os.path.exists(os.path.join(settings.FAISS_DIR, "index.faiss"))
    return {
        "documents_in_db": docs_count,
        "pdf_files_in_upload_dir": upload_pdf_count,
        "faiss_index_exists": index_exists,
        "faiss_meta_entries": len(meta),
        "faiss_indexed_documents": len(indexed_doc_ids),
        "upload_dir": settings.UPLOAD_DIR,
        "faiss_dir": settings.FAISS_DIR,
    }


@router.get("")
def list_documents(db: Session = Depends(get_db)):
    docs = db.query(Document).order_by(Document.uploaded_at.desc()).all()
    return [
        {
            "document_id": d.id,
            "filename": d.filename,
            "path": d.path,
            "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
        }
        for d in docs
    ]


@router.get("/source")
def get_source_snippet(
    document_id: int,
    chunk_id: str,
    max_chars: int = 1200,
    db: Session = Depends(get_db),
):
    meta = _load_faiss_meta_entries()
    hit = None
    for item in meta:
        if item.get("document_id") == document_id and item.get("chunk_id") == chunk_id:
            hit = item
            break

    if hit is None:
        raise HTTPException(status_code=404, detail="Source chunk not found")

    text = hit.get("text") or ""
    safe_max_chars = max(1, min(max_chars, 5000))
    doc = db.query(Document).filter(Document.id == document_id).first()
    return {
        "document_id": document_id,
        "chunk_id": chunk_id,
        "filename": doc.filename if doc else None,
        "snippet": text[:safe_max_chars],
        "total_chars": len(text),
    }


@router.post("/upload")
async def upload_pdf(file: UploadFile = File(...), db: Session = Depends(get_db)):
    safe_filename = _sanitize_filename(file.filename)
    content = await file.read()

    if safe_filename.lower().endswith(".pdf"):
        return _ingest_pdf_content(db, safe_filename, content)

    if not safe_filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only PDF or ZIP files are supported")

    if not zipfile.is_zipfile(io.BytesIO(content)):
        raise HTTPException(status_code=400, detail="Uploaded ZIP file is invalid")

    with zipfile.ZipFile(io.BytesIO(content), "r") as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        pdf_entries = [entry for entry in entries if entry.filename.lower().endswith(".pdf")]

        if not pdf_entries:
            raise HTTPException(status_code=400, detail="ZIP contains no PDF files")
        if len(pdf_entries) > MAX_ZIP_PDF_FILES:
            raise HTTPException(
                status_code=400,
                detail=f"ZIP contains too many PDFs (max {MAX_ZIP_PDF_FILES})",
            )

        total_pdf_size = sum(entry.file_size for entry in pdf_entries)
        if total_pdf_size > MAX_ZIP_TOTAL_PDF_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"ZIP PDF content exceeds size limit ({MAX_ZIP_TOTAL_PDF_BYTES} bytes)",
            )

        processed_docs = []
        failed_docs = []
        for entry in pdf_entries:
            inner_name = _sanitize_filename(entry.filename)
            try:
                inner_content = archive.read(entry)
                if not inner_content.startswith(b"%PDF"):
                    raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF")
                processed_docs.append(_ingest_pdf_content(db, inner_name, inner_content))
            except HTTPException as e:
                failed_docs.append({
                    "filename": inner_name,
                    "reason": str(e.detail),
                })
            except Exception:
                failed_docs.append({
                    "filename": inner_name,
                    "reason": "Failed to process PDF from ZIP",
                })

    if not processed_docs:
        raise HTTPException(status_code=400, detail="No valid PDFs could be processed from ZIP")

    return {
        "archive_filename": safe_filename,
        "processed_count": len(processed_docs),
        "failed_count": len(failed_docs),
        "documents": processed_docs,
        "failed_documents": failed_docs,
    }
