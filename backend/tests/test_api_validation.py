import asyncio
import io
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
import sys
import zipfile

from fastapi import HTTPException, Response
import openai
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Ensure tests can import the local backend package regardless of pytest rootdir.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class _DummyOpenAI:
    def __init__(self, *args, **kwargs):
        pass


# Prevent real client construction during module import in tests.
openai.OpenAI = _DummyOpenAI

from app.main import validate_settings
from app.config import settings
from app.db import Base
from app.models import ChatMessage, Chunk, Document, Property, TimelineItem, TimelineItemTranslation, UploadJob, User
from app.firebase_auth import get_current_user
from app.routes.chat import ChatRequest, chat, chat_history, clear_chat_history
from app.routes.chat import router as chat_router
from app.routes.timeline import TimelineRequest, list_timeline, timeline_extract, timeline_rebuild
from app.routes.timeline import router as timeline_router
from app.routes.documents import upload_pdf, documents_status, get_source_snippet, delete_document
from app.routes.documents import router as documents_router
from app.routes.properties import CreatePropertyBody, PatchPropertyBody, create_property, delete_property, get_property_details, list_properties, update_property
from app.routes.properties import router as properties_router


class _DummyUpload:
    def __init__(self, filename: str, content: bytes):
        self.filename = filename
        self._content = content

    async def read(self):
        return self._content


def _seed_user(db, email: str = "user@example.com") -> User:
    user = User(email=email)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _seed_property(db, user_id: int, name: str = "Main") -> Property:
    property_obj = Property(user_id=user_id, name=name, address_optional=None)
    db.add(property_obj)
    db.commit()
    db.refresh(property_obj)
    return property_obj


def _make_request():
    """Minimal Starlette Request for rate-limiter-decorated route functions."""
    from starlette.requests import Request
    scope = {"type": "http", "method": "POST", "path": "/test",
              "headers": [], "query_string": b"", "client": ("127.0.0.1", 8000)}
    return Request(scope)


@pytest.fixture
def auth_db():
    fd, db_path = tempfile.mkstemp(prefix="auth-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    testing_session_local = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = testing_session_local()
    yield db
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_startup_validation_raises_when_key_missing(monkeypatch):
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "   ")
    with pytest.raises(RuntimeError):
        validate_settings()


def test_documents_upload_rejects_non_pdf_extension():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db)
    property_obj = _seed_property(db, user.id)
    file = _DummyUpload(filename="notes.txt", content=b"hello")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Nur PDF- oder ZIP-Dateien sind erlaubt."
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_documents_upload_rejects_invalid_pdf_signature():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "user2@example.com")
    property_obj = _seed_property(db, user.id)
    file = _DummyUpload(filename="fake.pdf", content=b"not-a-real-pdf")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Die hochgeladene Datei ist kein gültiges PDF."
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_documents_upload_rejects_invalid_zip_file():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "user3@example.com")
    property_obj = _seed_property(db, user.id)
    file = _DummyUpload(filename="bundle.zip", content=b"not-a-real-zip")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Die hochgeladene ZIP-Datei ist ungültig."
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_documents_upload_rejects_zip_without_pdf():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "user4@example.com")
    property_obj = _seed_property(db, user.id)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("notes.txt", "hello")
    file = _DummyUpload(filename="bundle.zip", content=buffer.getvalue())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
    assert exc.value.status_code == 400
    assert exc.value.detail == "Die ZIP-Datei enthält keine PDF-Dateien."
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_chat_rejects_empty_question(auth_db):
    user = _seed_user(auth_db, "chat-empty@example.com")
    _req = _make_request()
    with pytest.raises(HTTPException) as exc:
        chat(request=_req, req=ChatRequest(question="   "), db=auth_db, current_user=user)
    assert exc.value.status_code == 400
    assert exc.value.detail == "question must not be empty"


def test_chat_rejects_question_over_max_length(auth_db):
    user = _seed_user(auth_db, "chat-long@example.com")
    _req = _make_request()
    long_q = "a" * 2001
    with pytest.raises(HTTPException) as exc:
        chat(request=_req, req=ChatRequest(question=long_q), db=auth_db, current_user=user)
    assert exc.value.status_code == 400
    assert "zu lang" in exc.value.detail.lower()


def test_chat_maps_runtime_error_to_502(auth_db, monkeypatch):
    user = _seed_user(auth_db, "chat-runtime@example.com")

    def fake_search(_question, db, user_id, property_id=None, k=6):
        raise RuntimeError("search exploded")

    monkeypatch.setattr("app.routes.chat.search", fake_search)
    _req = _make_request()
    with pytest.raises(HTTPException) as exc:
        chat(request=_req, req=ChatRequest(question="test"), db=auth_db, current_user=user)
    assert exc.value.status_code == 502
    assert exc.value.detail == "search exploded"


def test_chat_history_empty_for_new_user(auth_db):
    user = _seed_user(auth_db, "history-new@example.com")
    result = chat_history(property_id=None, db=auth_db, current_user=user)
    assert result == []


def test_chat_history_saves_and_retrieves_by_property(auth_db):
    user = _seed_user(auth_db, "history-prop@example.com")
    prop = _seed_property(auth_db, user.id, "HistProp")
    auth_db.add(ChatMessage(user_id=user.id, property_id=prop.id, role="user", text="Frage?"))
    auth_db.add(ChatMessage(user_id=user.id, property_id=prop.id, role="assistant", text="Antwort.", sources_json="[]"))
    auth_db.commit()

    result = chat_history(property_id=prop.id, db=auth_db, current_user=user)
    assert len(result) == 2
    assert result[0]["role"] == "user"
    assert result[0]["text"] == "Frage?"
    assert result[1]["role"] == "assistant"
    assert result[1]["sources"] == []

    global_result = chat_history(property_id=None, db=auth_db, current_user=user)
    assert global_result == []


def test_chat_history_isolated_between_users(auth_db):
    user_a = _seed_user(auth_db, "history-a@example.com")
    user_b = _seed_user(auth_db, "history-b@example.com")
    prop = _seed_property(auth_db, user_a.id, "PropA")
    auth_db.add(ChatMessage(user_id=user_a.id, property_id=prop.id, role="user", text="A's message"))
    auth_db.commit()
    result_b = chat_history(property_id=None, db=auth_db, current_user=user_b)
    assert result_b == []


def test_clear_chat_history_deletes_messages(auth_db):
    user = _seed_user(auth_db, "clear-hist@example.com")
    prop = _seed_property(auth_db, user.id, "ClearProp")
    auth_db.add(ChatMessage(user_id=user.id, property_id=prop.id, role="user", text="Q"))
    auth_db.add(ChatMessage(user_id=user.id, property_id=prop.id, role="assistant", text="A", sources_json="[]"))
    auth_db.commit()
    result = clear_chat_history(property_id=prop.id, db=auth_db, current_user=user)
    assert result["deleted"] == 2
    assert chat_history(property_id=prop.id, db=auth_db, current_user=user) == []


def test_timeline_rejects_empty_raw_text():
    with pytest.raises(HTTPException) as exc:
        timeline_extract(_make_request(), TimelineRequest(raw_text="   "))
    assert exc.value.status_code == 400
    assert exc.value.detail == "raw_text must not be empty"


def test_timeline_rejects_raw_text_over_limit(monkeypatch):
    monkeypatch.setattr(settings, "TIMELINE_EXTRACTION_INPUT_CHARS", 10)
    with pytest.raises(HTTPException) as exc:
        timeline_extract(_make_request(), TimelineRequest(raw_text="a" * 100001))
    assert exc.value.status_code == 400
    assert "zu lang" in exc.value.detail.lower()


def test_timeline_maps_runtime_error_to_502(monkeypatch):
    def fake_extract(_raw_text):
        raise RuntimeError("extract exploded")
    monkeypatch.setattr("app.routes.timeline.extract_timeline", fake_extract)
    with pytest.raises(HTTPException) as exc:
        timeline_extract(_make_request(), TimelineRequest(raw_text="abc"))
    assert exc.value.status_code == 502
    assert exc.value.detail == "extract exploded"


def test_documents_status_counts(auth_db):
    user = _seed_user(auth_db, "status@example.com")
    property_obj = _seed_property(auth_db, user.id)
    auth_db.add(Document(property_id=property_obj.id, filename="a.pdf", path="/tmp/a.pdf"))
    auth_db.add(Document(property_id=property_obj.id, filename="b.pdf", path="/tmp/b.pdf"))
    auth_db.commit()
    res = documents_status(db=auth_db, current_user=user)
    assert res["documents_in_db"] == 2
    assert res["chunks_in_db"] == 0


def test_get_source_snippet_found(auth_db):
    user = _seed_user(auth_db, "snippet@example.com")
    property_obj = _seed_property(auth_db, user.id)
    doc = Document(property_id=property_obj.id, filename="sample.pdf", path="/tmp/sample.pdf")
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    auth_db.add(Chunk(document_id=doc.id, chunk_id="11-0", text="abcdef", embedding_json=None))
    auth_db.commit()
    res = get_source_snippet(document_id=doc.id, chunk_id="11-0", max_chars=3, db=auth_db, current_user=user)
    assert res["document_id"] == doc.id
    assert res["chunk_id"] == "11-0"
    assert res["snippet"] == "abc"
    assert res["filename"] == "sample.pdf"


def test_list_timeline_defaults_to_german_without_translation_call(auth_db, monkeypatch):
    user = _seed_user(auth_db, "timeline-default@example.com")
    property_obj = _seed_property(auth_db, user.id, "Timeline House")
    doc = Document(property_id=property_obj.id, filename="timeline.pdf", path="/tmp/timeline.pdf")
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    item = TimelineItem(
        document_id=doc.id, property_id=property_obj.id,
        title="Nebenkostenabrechnung prüfen", date_iso="2026-03-01", time_24h="10:00",
        category="deadline", amount_eur=125.5,
        description="Bitte die Abrechnung bis Ende der Woche kontrollieren.",
        source_quote="Bitte bis Ende der Woche kontrollieren.",
    )
    auth_db.add(item)
    auth_db.commit()

    def fail_if_called(**kwargs):
        raise AssertionError("translate_timeline_fields must not be called for language=de")

    monkeypatch.setattr("app.routes.timeline.translate_timeline_fields", fail_if_called)
    res = list_timeline(property_id=property_obj.id, db=auth_db, current_user=user)
    assert len(res) == 1
    assert res[0]["title"] == "Nebenkostenabrechnung prüfen"
    assert res[0]["date_iso"] == "2026-03-01"
    assert res[0]["category"] == "deadline"
    assert res[0]["amount_eur"] == 125.5
    assert res[0]["source_quote"] == "Bitte bis Ende der Woche kontrollieren."


def test_list_timeline_translates_and_caches_by_language(auth_db, monkeypatch):
    user = _seed_user(auth_db, "timeline-cache@example.com")
    property_obj = _seed_property(auth_db, user.id, "Timeline Cache")
    doc = Document(property_id=property_obj.id, filename="cache.pdf", path="/tmp/cache.pdf")
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    item = TimelineItem(
        document_id=doc.id, property_id=property_obj.id,
        title="Heizung warten lassen", date_iso="2026-04-15", time_24h=None,
        category="info", amount_eur=None,
        description="Wartung durch Fachbetrieb organisieren.",
        source_quote="Wartung durch Fachbetrieb.",
    )
    auth_db.add(item)
    auth_db.commit()

    calls = {"count": 0}

    def fake_translate(title: str, description: str, target_language: str):
        calls["count"] += 1
        assert target_language == "en"
        return {"title": f"{title} (EN)", "description": f"{description} (EN)"}

    monkeypatch.setattr("app.routes.timeline.translate_timeline_fields", fake_translate)

    first = list_timeline(property_id=property_obj.id, language="en", db=auth_db, current_user=user)
    assert len(first) == 1
    assert first[0]["title"] == "Heizung warten lassen (EN)"
    assert first[0]["source_quote"] == "Wartung durch Fachbetrieb."
    assert calls["count"] == 1

    cached_rows = auth_db.query(TimelineItemTranslation).filter(TimelineItemTranslation.language == "en").all()
    assert len(cached_rows) == 1
    assert cached_rows[0].translated_title == "Heizung warten lassen (EN)"

    second = list_timeline(property_id=property_obj.id, language="en", db=auth_db, current_user=user)
    assert second[0]["title"] == "Heizung warten lassen (EN)"
    assert calls["count"] == 1  # still 1 — served from cache


def test_get_source_snippet_not_found(auth_db):
    user = _seed_user(auth_db, "snippet2@example.com")
    property_obj = _seed_property(auth_db, user.id)
    doc = Document(property_id=property_obj.id, filename="sample.pdf", path="/tmp/sample.pdf")
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    with pytest.raises(HTTPException) as exc:
        get_source_snippet(document_id=doc.id, chunk_id="99-1", db=auth_db, current_user=user)
    assert exc.value.status_code == 404


def test_protected_routers_include_auth_dependency():
    from app.firebase_auth import get_current_user as firebase_get_current_user
    assert any(dep.dependency == firebase_get_current_user for dep in documents_router.dependencies)
    assert any(dep.dependency == firebase_get_current_user for dep in timeline_router.dependencies)
    assert any(dep.dependency == firebase_get_current_user for dep in chat_router.dependencies)
    assert any(dep.dependency == firebase_get_current_user for dep in properties_router.dependencies)


def test_properties_create_list_and_get_own_details(auth_db):
    user = _seed_user(auth_db, "owner@example.com")
    created = create_property(CreatePropertyBody(name="HQ", address_optional="Street 1"), db=auth_db, current_user=user)
    assert created["name"] == "HQ"
    listed = list_properties(db=auth_db, current_user=user)
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]
    detail = get_property_details(property_id=created["id"], db=auth_db, current_user=user)
    assert detail["address_optional"] == "Street 1"


def test_properties_get_forbidden_for_other_user(auth_db):
    owner = _seed_user(auth_db, "owner2@example.com")
    other = _seed_user(auth_db, "other@example.com")
    property_obj = _seed_property(auth_db, owner.id, "Private")
    with pytest.raises(HTTPException) as exc:
        get_property_details(property_id=property_obj.id, db=auth_db, current_user=other)
    assert exc.value.status_code == 404


def test_properties_rename(auth_db):
    user = _seed_user(auth_db, "rename@example.com")
    created = create_property(CreatePropertyBody(name="Old Name"), db=auth_db, current_user=user)
    updated = update_property(
        property_id=created["id"], req=PatchPropertyBody(name="New Name"),
        db=auth_db, current_user=user,
    )
    assert updated["name"] == "New Name"
    detail = get_property_details(property_id=created["id"], db=auth_db, current_user=user)
    assert detail["name"] == "New Name"


def test_properties_rename_rejects_empty_name(auth_db):
    user = _seed_user(auth_db, "rename-empty@example.com")
    created = create_property(CreatePropertyBody(name="Valid"), db=auth_db, current_user=user)
    with pytest.raises(HTTPException) as exc:
        update_property(
            property_id=created["id"], req=PatchPropertyBody(name="   "),
            db=auth_db, current_user=user,
        )
    assert exc.value.status_code == 400


def test_properties_delete_removes_property_and_all_data(auth_db):
    user = _seed_user(auth_db, "delete-prop@example.com")
    prop = _seed_property(auth_db, user.id, "ToDelete")
    doc = Document(property_id=prop.id, filename="x.pdf", path=None)
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    doc_id = doc.id  # save before delete
    auth_db.add(Chunk(document_id=doc_id, chunk_id=f"{doc_id}-0", text="txt", embedding_json=None))
    auth_db.add(TimelineItem(
        document_id=doc_id, property_id=prop.id, title="T", date_iso="2026-01-01",
        time_24h=None, category="info", amount_eur=None, description="D",
    ))
    auth_db.add(ChatMessage(user_id=user.id, property_id=prop.id, role="user", text="Q"))
    auth_db.commit()

    res = delete_property(property_id=prop.id, db=auth_db, current_user=user)
    assert res["ok"] is True
    assert auth_db.query(Property).filter(Property.id == prop.id).first() is None
    assert auth_db.query(Document).filter(Document.property_id == prop.id).count() == 0
    assert auth_db.query(Chunk).filter(Chunk.document_id == doc_id).count() == 0
    assert auth_db.query(TimelineItem).filter(TimelineItem.property_id == prop.id).count() == 0
    assert auth_db.query(ChatMessage).filter(ChatMessage.property_id == prop.id).count() == 0


def test_properties_delete_forbidden_for_other_user(auth_db):
    owner = _seed_user(auth_db, "del-owner@example.com")
    other = _seed_user(auth_db, "del-other@example.com")
    prop = _seed_property(auth_db, owner.id, "Private")
    with pytest.raises(HTTPException) as exc:
        delete_property(property_id=prop.id, db=auth_db, current_user=other)
    assert exc.value.status_code == 404


def test_properties_create_rejects_limit(auth_db, monkeypatch):
    monkeypatch.setattr(settings, "FREE_TIER_MAX_PROPERTIES_PER_USER", 2)
    user = _seed_user(auth_db, "limit-props@example.com")
    create_property(CreatePropertyBody(name="P1"), db=auth_db, current_user=user)
    create_property(CreatePropertyBody(name="P2"), db=auth_db, current_user=user)
    with pytest.raises(HTTPException) as exc:
        create_property(CreatePropertyBody(name="P3"), db=auth_db, current_user=user)
    assert exc.value.status_code == 429
    assert "Limit" in exc.value.detail


def test_upload_job_created_for_zip(auth_db, monkeypatch):
    user = _seed_user(auth_db, "upload-job@example.com")
    prop = _seed_property(auth_db, user.id, "ZipProp")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("doc.pdf", b"%PDF-1.7 content")
    zip_content = buffer.getvalue()

    monkeypatch.setattr("app.routes.documents._process_zip_in_background", lambda *a, **kw: None)

    file = _DummyUpload(filename="bundle.zip", content=zip_content)
    result = asyncio.run(upload_pdf(
        property_id=prop.id, file=file, background_tasks=None,
        db=auth_db, current_user=user,
    ))

    assert result["queued"] is True
    assert "job_id" in result
    job = auth_db.query(UploadJob).filter(UploadJob.id == result["job_id"]).first()
    assert job is not None
    assert job.property_id == prop.id


def test_timeline_list_filters_by_property(auth_db):
    user = _seed_user(auth_db, "timeline-owner@example.com")
    property_a = _seed_property(auth_db, user.id, "A")
    property_b = _seed_property(auth_db, user.id, "B")
    doc_a = Document(property_id=property_a.id, filename="a.pdf", path="/tmp/a.pdf")
    doc_b = Document(property_id=property_b.id, filename="b.pdf", path="/tmp/b.pdf")
    auth_db.add_all([doc_a, doc_b])
    auth_db.commit()
    auth_db.refresh(doc_a)
    auth_db.refresh(doc_b)
    auth_db.add_all([
        TimelineItem(document_id=doc_a.id, property_id=property_a.id, title="A item",
                     date_iso="2026-01-01", time_24h="10:00", category="info", amount_eur=None, description="A"),
        TimelineItem(document_id=doc_b.id, property_id=property_b.id, title="B item",
                     date_iso="2026-01-02", time_24h="11:00", category="info", amount_eur=None, description="B"),
    ])
    auth_db.commit()
    items = list_timeline(property_id=property_a.id, db=auth_db, current_user=user)
    assert len(items) == 1
    assert items[0]["property_id"] == property_a.id
    assert items[0]["title"] == "A item"


def test_upload_rejects_property_not_owned(auth_db):
    owner = _seed_user(auth_db, "owner-upload@example.com")
    other = _seed_user(auth_db, "other-upload@example.com")
    property_obj = _seed_property(auth_db, owner.id, "Owner property")
    file = _DummyUpload(filename="file.pdf", content=b"%PDF-1.7 minimal")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=auth_db, current_user=other))
    assert exc.value.status_code == 404


def test_upload_rejects_pdf_over_size_limit():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "limit-size@example.com")
    property_obj = _seed_property(db, user.id)
    old_limit = settings.MAX_PDF_BYTES
    try:
        settings.MAX_PDF_BYTES = 10
        file = _DummyUpload(filename="big.pdf", content=b"%PDF-1234567890-too-large")
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
        assert exc.value.status_code == 413
        assert "Datei zu groß" in str(exc.value.detail)
    finally:
        settings.MAX_PDF_BYTES = old_limit
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_upload_rejects_when_property_document_limit_reached():
    fd, db_path = tempfile.mkstemp(prefix="upload-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "limit-docs@example.com")
    property_obj = _seed_property(db, user.id)
    db.add(Document(property_id=property_obj.id, filename="existing.pdf", path=None))
    db.commit()
    old_limit = settings.FREE_TIER_MAX_DOCUMENTS_PER_PROPERTY
    try:
        settings.FREE_TIER_MAX_DOCUMENTS_PER_PROPERTY = 1
        file = _DummyUpload(filename="new.pdf", content=b"%PDF-1.7 minimal")
        with pytest.raises(HTTPException) as exc:
            asyncio.run(upload_pdf(property_id=property_obj.id, file=file, db=db, current_user=user))
        assert exc.value.status_code == 429
        assert "Limit erreicht" in str(exc.value.detail)
    finally:
        settings.FREE_TIER_MAX_DOCUMENTS_PER_PROPERTY = old_limit
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_timeline_rebuild_returns_items_count_and_updated_at(auth_db, monkeypatch):
    user = _seed_user(auth_db, "rebuild-owner@example.com")
    property_obj = _seed_property(auth_db, user.id, "Rebuild")
    doc1 = Document(property_id=property_obj.id, filename="a.pdf", path=None, extracted_text="x")
    doc2 = Document(property_id=property_obj.id, filename="b.pdf", path=None, extracted_text="y")
    auth_db.add_all([doc1, doc2])
    auth_db.commit()
    auth_db.refresh(doc1)
    auth_db.refresh(doc2)

    def fake_extract_and_store(_db, doc, raw_text=None):
        if doc.id == doc1.id:
            return [{"title": "A"}, {"title": "B"}]
        return [{"title": "C"}]

    monkeypatch.setattr("app.routes.timeline.extract_and_store_timeline_for_document", fake_extract_and_store)
    res = timeline_rebuild(request=_make_request(), property_id=property_obj.id, db=auth_db, current_user=user)
    assert res["items_count"] == 3
    assert isinstance(res["updated_at"], str) and "T" in res["updated_at"]
    assert res["documents_considered"] == 2
    assert res["documents_processed"] == 2
    assert res["documents_failed"] == []


def test_timeline_rebuild_continues_when_single_document_extraction_fails(auth_db, monkeypatch):
    user = _seed_user(auth_db, "rebuild-partial@example.com")
    property_obj = _seed_property(auth_db, user.id, "RebuildPartial")
    doc1 = Document(property_id=property_obj.id, filename="a.pdf", path=None, extracted_text="x")
    doc2 = Document(property_id=property_obj.id, filename="b.pdf", path=None, extracted_text="y")
    auth_db.add_all([doc1, doc2])
    auth_db.commit()
    auth_db.refresh(doc1)
    auth_db.refresh(doc2)

    def fake_extract_and_store(_db, doc, raw_text=None):
        if doc.id == doc1.id:
            return [{"title": "A"}, {"title": "B"}]
        raise RuntimeError("Timeline extraction response parsing failed")

    monkeypatch.setattr("app.routes.timeline.extract_and_store_timeline_for_document", fake_extract_and_store)
    res = timeline_rebuild(request=_make_request(), property_id=property_obj.id, db=auth_db, current_user=user)
    assert res["items_count"] == 2
    assert res["documents_considered"] == 2
    assert res["documents_processed"] == 1
    assert len(res["documents_failed"]) == 1
    assert res["documents_failed"][0]["document_id"] == doc2.id
    assert res["documents_failed"][0]["reason"] == "Timeline extraction response parsing failed"


def test_timeline_rebuild_all_failed_returns_detail_with_document_reason(auth_db, monkeypatch):
    user = _seed_user(auth_db, "rebuild-all-fail@example.com")
    property_obj = _seed_property(auth_db, user.id, "RebuildAllFail")
    doc = Document(property_id=property_obj.id, filename="broken.pdf", path=None, extracted_text="x")
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)

    def fake_extract_and_store(_db, _doc, raw_text=None):
        raise RuntimeError("Timeline extraction request to OpenAI failed")

    monkeypatch.setattr("app.routes.timeline.extract_and_store_timeline_for_document", fake_extract_and_store)
    with pytest.raises(HTTPException) as exc:
        timeline_rebuild(request=_make_request(), property_id=property_obj.id, db=auth_db, current_user=user)
    assert exc.value.status_code == 502
    detail = str(exc.value.detail)
    assert "failed for all selected documents" in detail
    assert "broken.pdf" in detail
    assert "OpenAI failed" in detail


def test_delete_document_removes_document_chunks_and_timeline(auth_db):
    user = _seed_user(auth_db, "del-doc-owner@example.com")
    property_obj = _seed_property(auth_db, user.id, "Delete")
    doc = Document(property_id=property_obj.id, filename="a.pdf", path=None)
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    auth_db.add(Chunk(document_id=doc.id, chunk_id=f"{doc.id}-0", text="hello", embedding_json=None))
    auth_db.add(TimelineItem(
        document_id=doc.id, property_id=property_obj.id, title="A item",
        date_iso="2026-01-01", time_24h="10:00", category="info", amount_eur=None, description="A",
    ))
    auth_db.commit()
    res = delete_document(document_id=doc.id, property_id=property_obj.id, db=auth_db, current_user=user)
    assert res["ok"] is True
    assert res["deleted_chunks"] == 1
    assert res["deleted_timeline_items"] == 1
    assert auth_db.query(Document).filter(Document.id == doc.id).first() is None


def test_delete_document_rejects_non_owned_property(auth_db):
    owner = _seed_user(auth_db, "del-doc-owner2@example.com")
    other = _seed_user(auth_db, "del-doc-other@example.com")
    property_obj = _seed_property(auth_db, owner.id, "OwnerProperty")
    doc = Document(property_id=property_obj.id, filename="a.pdf", path=None)
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    with pytest.raises(HTTPException) as exc:
        delete_document(document_id=doc.id, property_id=property_obj.id, db=auth_db, current_user=other)
    assert exc.value.status_code == 404
