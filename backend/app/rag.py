import json
import math
from openai import OpenAI
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .models import Chunk, Document, Property

client = OpenAI(api_key=settings.OPENAI_API_KEY)


class ChatSource(BaseModel):
    document_id: int
    chunk_id: str


class ChatAnswer(BaseModel):
    answer: str
    key_points: list[str]
    sources: list[ChatSource]
    missing_info: list[str]


class TimelineTextTranslation(BaseModel):
    title: str
    description: str


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    try:
        resp = client.embeddings.create(model=settings.EMBED_MODEL, input=texts)
    except Exception as e:
        raise RuntimeError("Embedding request to OpenAI failed") from e
    return [list(d.embedding) for d in resp.data]


def upsert_chunks(db: Session, chunks: list[dict]):
    """
    chunks: [{ "document_id": 1, "chunk_id": "1-0", "text": "..." }]
    """
    if not chunks:
        return
    texts = [c["text"] for c in chunks]
    vecs = embed_texts(texts)

    doc_id = chunks[0]["document_id"]
    db.query(Chunk).filter(Chunk.document_id == doc_id).delete(synchronize_session=False)
    for chunk, vec in zip(chunks, vecs):
        db.add(
            Chunk(
                document_id=chunk["document_id"],
                chunk_id=chunk["chunk_id"],
                text=chunk["text"],
                embedding_json=json.dumps(vec, ensure_ascii=False),
            )
        )


def _cosine_similarity(query_vec: list[float], embeddings: list[list[float]]) -> list[float]:
    q_norm = math.sqrt(sum(v * v for v in query_vec))
    if q_norm == 0:
        return [0.0 for _ in embeddings]

    scores: list[float] = []
    for emb in embeddings:
        emb_norm = math.sqrt(sum(v * v for v in emb))
        denom = emb_norm * q_norm
        if denom == 0:
            scores.append(0.0)
            continue
        dot = sum(e * q for e, q in zip(emb, query_vec))
        scores.append(dot / denom)
    return scores


def search(query: str, db: Session, user_id: int, property_id: int | None = None, k: int = 6) -> list[dict]:
    qv = embed_texts([query])
    if not qv:
        return []
    query_vec = qv[0]

    sql = (
        db.query(Chunk, Document.property_id, Document.document_type, Document.summary, Document.financials_json, Document.tax_data_json)
        .join(Document, Chunk.document_id == Document.id)
        .join(Property, Document.property_id == Property.id)
        .filter(Property.user_id == user_id)
    )
    if property_id is not None:
        sql = sql.filter(Document.property_id == property_id)
    rows = sql.all()
    if not rows:
        return []

    candidates: list[dict] = []
    vectors: list[list[float]] = []
    for chunk, doc_property_id, doc_type, doc_summary, doc_financials, doc_tax in rows:
        if not chunk.embedding_json:
            continue
        try:
            vectors.append(json.loads(chunk.embedding_json))
        except Exception:
            continue
        candidates.append(
            {
                "document_id": chunk.document_id,
                "property_id": doc_property_id,
                "chunk_id": chunk.chunk_id,
                "text": chunk.text,
                "doc_type": doc_type or "sonstiges",
                "doc_financials": doc_financials or "{}",
                "doc_tax": doc_tax or "{}",
            }
        )
    if not candidates:
        return []

    scores = _cosine_similarity(query_vec, vectors)
    top_k = max(1, k)
    best_idx = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
    return [
        {**candidates[i], "score": float(scores[i])}
        for i in best_idx
        if scores[i] >= settings.MIN_SIMILARITY_SCORE
    ]


def answer_with_context(question: str, contexts: list[dict], language: str = "de") -> dict:
    language_labels = {
        "de": "Deutsch",
        "en": "English",
        "fr": "Francais",
    }
    output_language = language_labels.get(language)
    if output_language is None:
        raise RuntimeError("Unsupported language. Use one of: de, en, fr")

    if not contexts:
        fallback_answer = {
            "de": "Im bereitgestellten Kontext wurden keine passenden Informationen gefunden.",
            "en": "No matching information was found in the provided context.",
            "fr": "Aucune information correspondante n'a ete trouvee dans le contexte fourni.",
        }.get(language, "Im bereitgestellten Kontext wurden keine passenden Informationen gefunden.")
        fallback_missing = {
            "de": f"Keine relevanten Kontextstellen zur Frage vorhanden: {question}",
            "en": f"No relevant context passages available for the question: {question}",
            "fr": f"Aucun passage de contexte pertinent disponible pour la question: {question}",
        }.get(language, f"Keine relevanten Kontextstellen zur Frage vorhanden: {question}")
        return {
            "answer": fallback_answer,
            "key_points": [],
            "sources": [],
            "missing_info": [fallback_missing],
        }

    # Group chunks by document to avoid repeating the huge JSON strings
    docs_metadata = {}
    for c in contexts:
        doc_id = c['document_id']
        if doc_id not in docs_metadata:
            docs_metadata[doc_id] = {
                "type": c.get("doc_type", "sonstiges"),
                "financials": c.get("doc_financials", "{}"),
                "tax": c.get("doc_tax", "{}")
            }

    metadata_text = "\n\n".join(
        [f"[METADATA DOC {doc_id} | Typ: {meta['type']}]\nFinanzen: {meta['financials']}\nSteuerdaten: {meta['tax']}" 
         for doc_id, meta in docs_metadata.items()]
    )

    context_text = "\n\n".join(
        [f"[DOC {c['document_id']} | {c['chunk_id']}]\n{c['text']}" for c in contexts]
    )
    
    full_context = f"DOKUMENT-METADATEN (Strukturierte Finanz- und Steuerdaten):\n{metadata_text}\n\nTEXT-AUSZÜGE:\n{context_text}"

    out_of_scope_phrase = {
        "de": "Diese Frage liegt ausserhalb meines Aufgabenbereichs.",
        "en": "This question is outside my area of responsibility.",
        "fr": "Cette question est en dehors de mon domaine de responsabilite.",
    }.get(language, "Diese Frage liegt ausserhalb meines Aufgabenbereichs.")

    allowed_sources = {(int(c["document_id"]), str(c["chunk_id"])) for c in contexts}
    system_prompt = (
        "Du bist ein spezialisierter Assistent fuer Wohnungseigentuemer (WEG). "
        "Deine einzige Wissensquelle ist der unten bereitgestellte Dokumentenkontext.\n\n"
        "REGELN:\n"
        "1. Beantworte NUR Fragen, die sich auf den bereitgestellten Kontext beziehen. "
        f"Allgemeine Fragen (Wetter, Politik, etc.) beantworte mit: '{out_of_scope_phrase}'\n"
        "2. Nutze AUSSCHLIESSLICH den Kontext. Rate nicht. Erfinde keine Zahlen oder Daten.\n"
        "3. Behalte Zahlen, Daten, Betraege und Bezeichnungen exakt wie im Kontext.\n"
        "4. Wenn Informationen fehlen, nenne sie in missing_info. Antworte trotzdem mit dem, was vorhanden ist.\n"
        "5. Erklaere Fachbegriffe (juristisch, finanziell) in einfacher Sprache.\n"
        f"6. Antworte komplett auf {output_language}. Schreibe key_points als knappe, vollstaendige Saetze (max 5 Punkte).\n"
        "7. Uebersetze DOC/chunk-Bezeichner nicht; sie muessen unveraendert in sources bleiben.\n\n"
        "Ausgabe ausschliesslich als JSON:\n"
        "{\"answer\":\"...\",\"key_points\":[\"...\"],\"sources\":[{\"document_id\":0,\"chunk_id\":\"...\"}],\"missing_info\":[\"...\"]}\n"
        "sources darf nur Labels aus dem bereitgestellten Kontext enthalten."
    )

    try:
        resp = client.chat.completions.create(
            model=settings.OPENAI_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"KONTEXT:\n{full_context}\n\nFRAGE:\n{question}"},
            ],
            response_format={"type": "json_object"},
        )
    except Exception as e:
        raise RuntimeError("Chat completion request to OpenAI failed") from e
    try:
        content = (resp.choices[0].message.content or "").strip()
        data = json.loads(content)
        result = ChatAnswer.model_validate(data)
        filtered_sources = [
            source
            for source in result.sources
            if (int(source.document_id), str(source.chunk_id)) in allowed_sources
        ]
        return {
            "answer": result.answer,
            "key_points": result.key_points,
            "sources": [source.model_dump() for source in filtered_sources],
            "missing_info": result.missing_info,
        }
    except Exception as e:
        raise RuntimeError("Chat completion response parsing failed") from e


def translate_timeline_fields(title: str, description: str, target_language: str) -> dict:
    target_label = {"de": "German", "en": "English", "fr": "French"}.get(target_language)
    if not target_label:
        raise RuntimeError("Unsupported translation language")

    system_prompt = (
        "You are a strict translation engine.\n"
        f"Translate German source text to {target_label}.\n"
        "Rules:\n"
        "1) Translate only, no paraphrasing.\n"
        "2) Keep meaning, tone, and level of detail exactly.\n"
        "3) Keep numbers, units, and punctuation unchanged unless grammar requires adaptation.\n"
        "4) Return only JSON with keys title and description.\n"
        "5) Do not add comments, notes, or extra keys."
    )
    payload = {"title": title, "description": description}

    def _parse_translation_payload(content: str) -> dict:
        normalized = (content or "").strip()
        if not normalized:
            raise RuntimeError("Empty translation response")

        if normalized.startswith("```"):
            normalized = normalized.removeprefix("```json").removeprefix("```").strip()
            if normalized.endswith("```"):
                normalized = normalized[:-3].strip()

        try:
            data = json.loads(normalized)
            translated = TimelineTextTranslation.model_validate(data)
            return translated.model_dump()
        except Exception:
            pass

        title_match = None
        desc_match = None
        for line in normalized.splitlines():
            lower = line.lower()
            if lower.startswith("title:"):
                title_match = line.split(":", 1)[1].strip()
            elif lower.startswith("description:"):
                desc_match = line.split(":", 1)[1].strip()

        if title_match is None or desc_match is None:
            raise RuntimeError("Unparseable translation response")

        translated = TimelineTextTranslation(title=title_match, description=desc_match)
        return translated.model_dump()

    primary_error: Exception | None = None
    try:
        resp = client.chat.completions.create(
            model=settings.TIMELINE_TRANSLATION_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            response_format={"type": "json_object"},
            timeout=20.0,
        )
        content = (resp.choices[0].message.content or "").strip()
        return _parse_translation_payload(content)
    except Exception as e:
        primary_error = e

    # Fallback for models/endpoints that do not reliably support json_object translation mode.
    fallback_prompt = (
        f"Translate the following JSON from German to {target_label}. "
        "Return exactly two lines:\n"
        "TITLE: <translated title>\n"
        "DESCRIPTION: <translated description>\n"
        "No extra text."
    )

    try:
        fallback = client.chat.completions.create(
            model=settings.TIMELINE_TRANSLATION_MODEL,
            messages=[
                {"role": "system", "content": fallback_prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            timeout=20.0,
        )
        fallback_content = (fallback.choices[0].message.content or "").strip()
        return _parse_translation_payload(fallback_content)
    except Exception as e:
        if primary_error is not None:
            raise RuntimeError(
                f"Timeline translation failed (primary={type(primary_error).__name__}, fallback={type(e).__name__})"
            ) from e
        raise RuntimeError("Timeline translation failed") from e
