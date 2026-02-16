import asyncio
import io
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
from app.models import Chunk, Document, LoginToken, Property, TimelineItem, TimelineItemTranslation, User
from app.auth import get_current_user, hash_login_token
from app.routes.auth import RequestLinkBody, logout, me, request_link, verify_magic_link
from app.routes.chat import ChatRequest, chat
from app.routes.chat import router as chat_router
from app.routes.timeline import TimelineRequest, list_timeline, timeline_extract, timeline_rebuild
from app.routes.timeline import router as timeline_router
from app.routes.documents import upload_pdf, documents_status, get_source_snippet, delete_document
from app.routes.documents import router as documents_router
from app.routes.properties import CreatePropertyBody, create_property, get_property_details, list_properties
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


@pytest.fixture
def auth_db(monkeypatch):
    monkeypatch.setattr(settings, "ENV", "DEV")
    monkeypatch.setattr(settings, "SESSION_SECRET", "test-session-secret")
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


def test_chat_rejects_empty_question():
    fd, db_path = tempfile.mkstemp(prefix="chat-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "chat-empty@example.com")
    with pytest.raises(HTTPException) as exc:
        chat(ChatRequest(question="   "), db=db, current_user=user)
    assert exc.value.status_code == 400
    assert exc.value.detail == "question must not be empty"
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


def test_chat_maps_runtime_error_to_502(monkeypatch):
    fd, db_path = tempfile.mkstemp(prefix="chat-test-", suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    test_session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = test_session()
    user = _seed_user(db, "chat-runtime@example.com")

    def fake_search(_question, db, user_id, property_id=None, k=6):
        raise RuntimeError("search exploded")

    monkeypatch.setattr("app.routes.chat.search", fake_search)
    with pytest.raises(HTTPException) as exc:
        chat(ChatRequest(question="test"), db=db, current_user=user)
    assert exc.value.status_code == 502
    assert exc.value.detail == "search exploded"
    db.close()
    Base.metadata.drop_all(bind=engine)
    os.remove(db_path)


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
        document_id=doc.id,
        property_id=property_obj.id,
        title="Nebenkostenabrechnung prüfen",
        date_iso="2026-03-01",
        time_24h="10:00",
        category="deadline",
        amount_eur=125.5,
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
    assert res[0]["description"] == "Bitte die Abrechnung bis Ende der Woche kontrollieren."
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
        document_id=doc.id,
        property_id=property_obj.id,
        title="Heizung warten lassen",
        date_iso="2026-04-15",
        time_24h=None,
        category="info",
        amount_eur=None,
        description="Wartung durch Fachbetrieb organisieren.",
        source_quote="Wartung durch Fachbetrieb.",
    )
    auth_db.add(item)
    auth_db.commit()

    calls = {"count": 0}

    def fake_translate_timeline_fields(title: str, description: str, target_language: str):
        calls["count"] += 1
        assert target_language == "en"
        return {
            "title": f"{title} (EN)",
            "description": f"{description} (EN)",
        }

    monkeypatch.setattr("app.routes.timeline.translate_timeline_fields", fake_translate_timeline_fields)

    first = list_timeline(property_id=property_obj.id, language="en", db=auth_db, current_user=user)
    assert len(first) == 1
    assert first[0]["title"] == "Heizung warten lassen (EN)"
    assert first[0]["description"] == "Wartung durch Fachbetrieb organisieren. (EN)"
    assert first[0]["date_iso"] == "2026-04-15"
    assert first[0]["category"] == "info"
    assert first[0]["source_quote"] == "Wartung durch Fachbetrieb."
    assert calls["count"] == 1

    cached_rows = auth_db.query(TimelineItemTranslation).filter(TimelineItemTranslation.language == "en").all()
    assert len(cached_rows) == 1
    assert cached_rows[0].translated_title == "Heizung warten lassen (EN)"
    assert cached_rows[0].translated_description == "Wartung durch Fachbetrieb organisieren. (EN)"

    second = list_timeline(property_id=property_obj.id, language="en", db=auth_db, current_user=user)
    assert len(second) == 1
    assert second[0]["title"] == "Heizung warten lassen (EN)"
    assert second[0]["description"] == "Wartung durch Fachbetrieb organisieren. (EN)"
    assert second[0]["source_quote"] == "Wartung durch Fachbetrieb."
    assert calls["count"] == 1


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


def test_auth_request_link_dev_returns_magic_link_and_hashed_token(auth_db):
    body = request_link(RequestLinkBody(email="User@Example.com"), db=auth_db)
    assert body["ok"] is True
    assert body["magic_link"].startswith("/auth/verify?token=")

    raw_token = body["magic_link"].split("token=", 1)[1]
    user = auth_db.query(User).filter(User.email == "user@example.com").first()
    assert user is not None
    token_row = auth_db.query(LoginToken).filter(LoginToken.user_id == user.id).first()
    assert token_row is not None
    assert token_row.token_hash == hash_login_token(raw_token)
    assert token_row.expires_at > datetime.utcnow()
    assert token_row.used_at is None


def test_auth_verify_sets_cookie_marks_token_used_and_logout_clears(auth_db):
    link = request_link(RequestLinkBody(email="alice@example.com"), db=auth_db)
    token = link["magic_link"].split("token=", 1)[1]

    verify_response = Response()
    verify = verify_magic_link(token=token, response=verify_response, db=auth_db)
    assert verify["user"]["email"] == "alice@example.com"
    assert settings.SESSION_COOKIE_NAME in verify_response.headers.get("set-cookie", "")

    session_cookie = verify_response.headers.get("set-cookie", "").split("=", 1)[1].split(";", 1)[0]
    current_user = get_current_user(session_cookie=session_cookie, db=auth_db)
    me_result = me(current_user=current_user)
    assert me_result["email"] == "alice@example.com"

    with pytest.raises(HTTPException) as exc:
        verify_magic_link(token=token, response=Response(), db=auth_db)
    assert exc.value.status_code == 400

    row = auth_db.query(LoginToken).filter(LoginToken.token_hash == hash_login_token(token)).first()
    assert row is not None
    assert row.used_at is not None

    logout_response = Response()
    logout_result = logout(response=logout_response)
    assert logout_result["ok"] is True
    assert settings.SESSION_COOKIE_NAME in logout_response.headers.get("set-cookie", "")

    with pytest.raises(HTTPException) as logout_exc:
        get_current_user(session_cookie=None, db=auth_db)
    assert logout_exc.value.status_code == 401


def test_protected_routers_include_auth_dependency():
    assert any(dep.dependency == get_current_user for dep in documents_router.dependencies)
    assert any(dep.dependency == get_current_user for dep in timeline_router.dependencies)
    assert any(dep.dependency == get_current_user for dep in chat_router.dependencies)
    assert any(dep.dependency == get_current_user for dep in properties_router.dependencies)


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

    auth_db.add_all(
        [
            TimelineItem(
                document_id=doc_a.id,
                property_id=property_a.id,
                title="A item",
                date_iso="2026-01-01",
                time_24h="10:00",
                category="info",
                amount_eur=None,
                description="A",
            ),
            TimelineItem(
                document_id=doc_b.id,
                property_id=property_b.id,
                title="B item",
                date_iso="2026-01-02",
                time_24h="11:00",
                category="info",
                amount_eur=None,
                description="B",
            ),
        ]
    )
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
    res = timeline_rebuild(property_id=property_obj.id, db=auth_db, current_user=user)
    assert res["items_count"] == 3
    assert isinstance(res["updated_at"], str) and "T" in res["updated_at"]


def test_delete_document_removes_document_chunks_and_timeline(auth_db):
    user = _seed_user(auth_db, "delete-owner@example.com")
    property_obj = _seed_property(auth_db, user.id, "Delete")
    doc = Document(property_id=property_obj.id, filename="a.pdf", path=None)
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)
    auth_db.add(Chunk(document_id=doc.id, chunk_id=f"{doc.id}-0", text="hello", embedding_json=None))
    auth_db.add(
        TimelineItem(
            document_id=doc.id,
            property_id=property_obj.id,
            title="A item",
            date_iso="2026-01-01",
            time_24h="10:00",
            category="info",
            amount_eur=None,
            description="A",
        )
    )
    auth_db.commit()

    res = delete_document(document_id=doc.id, property_id=property_obj.id, db=auth_db, current_user=user)
    assert res["ok"] is True
    assert res["deleted_chunks"] == 1
    assert res["deleted_timeline_items"] == 1
    assert auth_db.query(Document).filter(Document.id == doc.id).first() is None


def test_delete_document_rejects_non_owned_property(auth_db):
    owner = _seed_user(auth_db, "delete-owner2@example.com")
    other = _seed_user(auth_db, "delete-other@example.com")
    property_obj = _seed_property(auth_db, owner.id, "OwnerProperty")
    doc = Document(property_id=property_obj.id, filename="a.pdf", path=None)
    auth_db.add(doc)
    auth_db.commit()
    auth_db.refresh(doc)

    with pytest.raises(HTTPException) as exc:
        delete_document(document_id=doc.id, property_id=property_obj.id, db=auth_db, current_user=other)
    assert exc.value.status_code == 404
