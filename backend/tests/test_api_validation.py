import asyncio
import io
from pathlib import Path
import sys
import zipfile

from fastapi import HTTPException
import openai
import pytest

# Ensure tests can import the local backend package regardless of pytest rootdir.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _DummyOpenAI:
    def __init__(self, *args, **kwargs):
        pass


# Prevent real client construction during module import in tests.
openai.OpenAI = _DummyOpenAI

from app.main import validate_settings
from app.config import settings
from app.routes.chat import ChatRequest, chat
from app.routes.timeline import TimelineRequest, timeline_extract
from app.routes.documents import upload_pdf, documents_status, get_source_snippet


class _DummyUpload:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content

    async def read(self):
        return self._content


def test_startup_validation_raises_when_key_missing(monkeypatch):
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "   ")
    with pytest.raises(RuntimeError):
        validate_settings()


def test_documents_upload_rejects_non_pdf_extension():
    file = _DummyUpload(filename="notes.txt", content=b"hello")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(file=file, db=None))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Only PDF or ZIP files are supported"


def test_documents_upload_rejects_invalid_pdf_signature():
    file = _DummyUpload(filename="fake.pdf", content=b"not-a-real-pdf")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(file=file, db=None))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Uploaded file is not a valid PDF"


def test_documents_upload_rejects_invalid_zip_file():
    file = _DummyUpload(filename="bundle.zip", content=b"not-a-real-zip")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(file=file, db=None))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Uploaded ZIP file is invalid"


def test_documents_upload_rejects_zip_without_pdf():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("notes.txt", "hello")
    file = _DummyUpload(filename="bundle.zip", content=buffer.getvalue())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(file=file, db=None))

    assert exc.value.status_code == 400
    assert exc.value.detail == "ZIP contains no PDF files"


def test_chat_rejects_empty_question():
    with pytest.raises(HTTPException) as exc:
        chat(ChatRequest(question="   "))
    assert exc.value.status_code == 400
    assert exc.value.detail == "question must not be empty"


def test_chat_maps_runtime_error_to_502(monkeypatch):
    def fake_search(_question, _faiss_dir, k=6):
        raise RuntimeError("search exploded")

    monkeypatch.setattr("app.routes.chat.search", fake_search)
    with pytest.raises(HTTPException) as exc:
        chat(ChatRequest(question="test"))
    assert exc.value.status_code == 502
    assert exc.value.detail == "search exploded"


def test_timeline_rejects_empty_raw_text():
    with pytest.raises(HTTPException) as exc:
        timeline_extract(TimelineRequest(raw_text="   "))
    assert exc.value.status_code == 400
    assert exc.value.detail == "raw_text must not be empty"


def test_timeline_maps_runtime_error_to_502(monkeypatch):
    def fake_extract(_raw_text):
        raise RuntimeError("extract exploded")

    monkeypatch.setattr("app.routes.timeline.extract_timeline", fake_extract)
    with pytest.raises(HTTPException) as exc:
        timeline_extract(TimelineRequest(raw_text="abc"))
    assert exc.value.status_code == 502
    assert exc.value.detail == "extract exploded"


def test_documents_status_counts(monkeypatch):
    class _FakeQuery:
        def count(self):
            return 7

    class _FakeDb:
        def query(self, _model):
            return _FakeQuery()

    monkeypatch.setattr("app.routes.documents._count_uploaded_pdfs", lambda _p: 9)
    monkeypatch.setattr(
        "app.routes.documents._load_faiss_meta_entries",
        lambda: [
            {"document_id": 1, "chunk_id": "1-0"},
            {"document_id": 1, "chunk_id": "1-1"},
            {"document_id": 2, "chunk_id": "2-0"},
        ],
    )
    monkeypatch.setattr("app.routes.documents.os.path.exists", lambda _p: True)

    res = documents_status(db=_FakeDb())
    assert res["documents_in_db"] == 7
    assert res["pdf_files_in_upload_dir"] == 9
    assert res["faiss_index_exists"] is True
    assert res["faiss_meta_entries"] == 3
    assert res["faiss_indexed_documents"] == 2


def test_get_source_snippet_found(monkeypatch):
    monkeypatch.setattr(
        "app.routes.documents._load_faiss_meta_entries",
        lambda: [{"document_id": 11, "chunk_id": "11-0", "text": "abcdef"}],
    )

    class _FakeDoc:
        filename = "sample.pdf"

    class _FakeFilter:
        def first(self):
            return _FakeDoc()

    class _FakeQuery:
        def filter(self, _expr):
            return _FakeFilter()

    class _FakeDb:
        def query(self, _model):
            return _FakeQuery()

    res = get_source_snippet(document_id=11, chunk_id="11-0", max_chars=3, db=_FakeDb())
    assert res["document_id"] == 11
    assert res["chunk_id"] == "11-0"
    assert res["snippet"] == "abc"
    assert res["filename"] == "sample.pdf"


def test_get_source_snippet_not_found(monkeypatch):
    monkeypatch.setattr("app.routes.documents._load_faiss_meta_entries", lambda: [])

    class _FakeDb:
        def query(self, _model):
            return None

    with pytest.raises(HTTPException) as exc:
        get_source_snippet(document_id=99, chunk_id="99-1", db=_FakeDb())
    assert exc.value.status_code == 404
