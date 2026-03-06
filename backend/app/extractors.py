import json
import re
from datetime import datetime
from openai import OpenAI
from pydantic import BaseModel, Field, field_validator
from typing import List, Literal, Optional
from .config import settings

client = OpenAI(api_key=settings.OPENAI_API_KEY)


CATEGORY_PRIORITY = {"deadline": 0, "payment": 1, "meeting": 2, "info": 3}
DATE_PATTERN = re.compile(
    r"\b(?:"
    r"\d{4}-\d{2}-\d{2}"                           # ISO: 2026-01-15
    r"|\d{1,2}\.\d{1,2}\.\d{2,4}"                  # German numeric: 15.01.2026
    r"|\d{1,2}\.\s*(?:Januar|Februar|M[aä]rz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4}"  # German spelled: 15. Januar 2026
    r")\b",
    re.IGNORECASE,
)
TIMELINE_KEYWORD_PATTERN = re.compile(
    r"\b(f[aä]llig|frist|sp[aä]testens|zahlung|nachzahlung|versammlung|etv|termin|sitzung|widerspruch|einreichung)\b",
    re.IGNORECASE,
)
MEETING_KEYWORDS = ("versammlung", "sitzung", "termin", "begehung", "etv")
PAYMENT_KEYWORDS = ("zahlung", "nachzahlung", "hausgeld", "vorschuss", "ueberweisen", "überweisen")
DEADLINE_KEYWORDS = ("frist", "faellig", "fällig", "spaetestens", "spätestens", "widerspruch", "einspruch")
GERMAN_MONTHS = {
    "januar": 1,
    "februar": 2,
    "maerz": 3,
    "märz": 3,
    "april": 4,
    "mai": 5,
    "juni": 6,
    "juli": 7,
    "august": 8,
    "september": 9,
    "oktober": 10,
    "november": 11,
    "dezember": 12,
}


class TimelineItem(BaseModel):
    title: str
    date_iso: str = Field(description="YYYY-MM-DD")
    time_24h: Optional[str] = Field(default=None, description="HH:MM")
    category: Literal["meeting", "payment", "deadline", "info"]
    amount_eur: Optional[float] = None
    description: str
    source_quote: Optional[str] = Field(
        default=None,
        max_length=160,
        description="Kurzes Originalzitat aus dem Text (max 160 Zeichen)",
    )


    @field_validator("date_iso")
    @classmethod
    def validate_date_iso(cls, value: str) -> str:
        # Enforce precise calendar dates and reject month-only style values.
        datetime.strptime(value, "%Y-%m-%d")
        return value

class TimelineExtraction(BaseModel):
    items: List[TimelineItem]


def _compress_document_for_timeline(document_text: str, max_chars: int) -> str:
    text = (document_text or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text

    lines = [line.strip() for line in text.splitlines()]
    hit_indexes: set[int] = set()
    for index, line in enumerate(lines):
        if not line:
            continue
        if DATE_PATTERN.search(line) or TIMELINE_KEYWORD_PATTERN.search(line):
            start = max(0, index - 2)
            end = min(len(lines), index + 3)
            hit_indexes.update(range(start, end))

    selected_lines = [lines[i] for i in sorted(hit_indexes) if lines[i]]
    condensed = "\n".join(selected_lines)
    if len(condensed) < min(4000, max_chars // 4):
        head = text[: max_chars // 2]
        tail = text[- max_chars // 4 :]
        condensed = f"{head}\n...\n{condensed}\n...\n{tail}".strip()

    return condensed[:max_chars]


def _extract_json_payload(content: str) -> dict:
    normalized = (content or "").strip()
    if not normalized:
        raise ValueError("empty_response")

    # Some models still wrap JSON in markdown fences despite json_object mode.
    if normalized.startswith("```"):
        normalized = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", normalized)
        normalized = re.sub(r"\s*```$", "", normalized)

    data = json.loads(normalized)
    if isinstance(data, list):
        return {"items": data}
    if not isinstance(data, dict):
        raise ValueError("invalid_json_root")

    items = data.get("items")
    if isinstance(items, list):
        return {"items": items}

    for alias in ("timeline", "events", "entries", "results"):
        alias_items = data.get(alias)
        if isinstance(alias_items, list):
            return {"items": alias_items}

    raise ValueError("missing_items_array")


def _normalize_date_token(token: str) -> str | None:
    raw = (token or "").strip()
    if not raw:
        return None

    # ISO format: YYYY-MM-DD
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        try:
            datetime.strptime(raw, "%Y-%m-%d")
            return raw
        except ValueError:
            return None

    # German numeric: DD.MM.YY(YY)
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})", raw)
    if m:
        day = int(m.group(1))
        month = int(m.group(2))
        year = int(m.group(3))
        if year < 100:
            year += 2000 if year < 70 else 1900
        try:
            return datetime(year, month, day).strftime("%Y-%m-%d")
        except ValueError:
            return None

    # German spelled: DD. Monat YYYY
    m = re.fullmatch(r"(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})", raw)
    if m:
        day = int(m.group(1))
        month_token = m.group(2).strip().lower()
        year = int(m.group(3))
        month = GERMAN_MONTHS.get(month_token)
        if month is None:
            return None
        try:
            return datetime(year, month, day).strftime("%Y-%m-%d")
        except ValueError:
            return None

    return None


def _infer_category_from_line(line: str) -> Literal["meeting", "payment", "deadline", "info"]:
    lowered = (line or "").lower()
    if any(keyword in lowered for keyword in DEADLINE_KEYWORDS):
        return "deadline"
    if any(keyword in lowered for keyword in PAYMENT_KEYWORDS):
        return "payment"
    if any(keyword in lowered for keyword in MEETING_KEYWORDS):
        return "meeting"
    return "info"


def _fallback_extract_timeline(document_text: str) -> TimelineExtraction:
    lines = [re.sub(r"\s+", " ", line).strip() for line in (document_text or "").splitlines()]
    items: list[TimelineItem] = []
    seen_keys: set[tuple[str, str]] = set()

    for line in lines:
        if not line:
            continue
        date_tokens = DATE_PATTERN.findall(line)
        if not date_tokens:
            continue
        for token in date_tokens:
            date_iso = _normalize_date_token(token)
            if not date_iso:
                continue

            clean_line = line.strip()
            title = clean_line[:80] if len(clean_line) > 80 else clean_line
            key = (date_iso, title.lower())
            if key in seen_keys:
                continue

            seen_keys.add(key)
            items.append(
                TimelineItem(
                    title=title or "Termin",
                    date_iso=date_iso,
                    time_24h=None,
                    category=_infer_category_from_line(clean_line),
                    amount_eur=None,
                    description=clean_line[:220],
                    source_quote=clean_line[:160],
                )
            )
            if len(items) >= settings.TIMELINE_EXTRACTION_MAX_ITEMS:
                break
        if len(items) >= settings.TIMELINE_EXTRACTION_MAX_ITEMS:
            break

    sorted_items = sorted(
        items,
        key=lambda item: (
            CATEGORY_PRIORITY.get(item.category, 99),
            item.date_iso,
            item.time_24h or "99:99",
            item.title.lower(),
        ),
    )
    return TimelineExtraction(items=sorted_items[: settings.TIMELINE_EXTRACTION_MAX_ITEMS])


def extract_timeline(document_text: str) -> TimelineExtraction:
    user_text = _compress_document_for_timeline(
        document_text, settings.TIMELINE_EXTRACTION_INPUT_CHARS
    )
    try:
        resp = client.chat.completions.create(
            model=settings.OPENAI_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": """
Du extrahierst handlungsrelevante Ereignisse aus deutschen WEG/Immobilien-Dokumenten (Hausgeldabrechnung, Wirtschaftsplan, Einladung/Protokoll ETV, Infoblätter).
Ziel: Eine kurze Timeline, die dem Eigentümer hilft, nichts zu verpassen.

Regeln:
1) NUR Einträge mit präzisem Datum (YYYY-MM-DD). Wenn kein exaktes Datum, NICHT aufnehmen.
2) Priorisiere: deadline > payment > meeting > info. Nimm pro Dokument maximal 25 Items.
3) Schreibe title kurz (max 80 Zeichen). description 1–2 Sätze, klar und laienverständlich.
4) Nutze TABELLEN explizit:
   - Wenn ein Abschnitt "TABLES:" vorhanden ist, nutze ihn aktiv für Beträge, Fristen und Bezeichnungen.
   - Gleiche Informationen aus Fließtext und TABLES ab; bevorzuge die präzisere/konkretere Tabellenzeile.
5) Beträge:
   - amount_eur nur setzen, wenn ein konkreter Eurobetrag im Text steht, sonst null.
   - Verwende Punkt als Dezimaltrennzeichen (z.B. 219.29).
   - Verknüpfe jeden Betrag immer mit seinem Zeilenlabel/Kontext (z.B. "Nachzahlung", "Hausgeld", "Abrechnungsspitze", "Rücklage").
   - Nenne in title/description nie einen isolierten Betrag ohne zugehörige Position.
6) Summen/Totalen:
   - Behandle "Summe", "Gesamtsumme", "Total", "Zwischensumme" NICHT als eigene Zahlung,
     außer der Text beschreibt diese Summe explizit als fällige Zahlung (z.B. "fällig", "zu zahlen bis", "zahlbar bis", "bitte überweisen").
7) Datum:
   - date_iso im Format YYYY-MM-DD.
   - Konvertiere ausgeschriebene deutsche Monatsnamen: "15. Januar 2026" → "2026-01-15", "3. März 2025" → "2025-03-03".
   - Wenn nur Monat/Jahr angegeben (kein Tag): NICHT aufnehmen (zu ungenau).
8) Uhrzeit:
   - time_24h nur wenn im Text vorhanden, sonst null.
9) Kategorien:
   - meeting: Versammlung, Termin, Sitzung, Begehung
   - payment: Hausgeld, Vorschuss, Nachzahlung, Erstattung, Umlage, Rücklage-Zuführung
   - deadline: fällig bis, Frist, spätestens, Widerspruch bis, Einreichung bis
   - info: nur wenn ein konkreter Termin/Datum genannt wird, aber keine Zahlung/Frist/Meeting ist
10) Keine Spekulation: nichts erfinden, keine Annahmen.
11) source_quote:
   - Wenn möglich, gib ein kurzes direktes Zitat aus dem Text, das den Eintrag belegt.
   - Maximal 160 Zeichen.
12) Gib ausschließlich valides JSON gemäß Schema zurück.

Ausgabeformat:
{"items":[{"title":"...","date_iso":"YYYY-MM-DD","time_24h":null,"category":"meeting|payment|deadline|info","amount_eur":null,"description":"...","source_quote":"..."}]}
""",
                },
                {"role": "user", "content": user_text},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=settings.TIMELINE_EXTRACTION_RESPONSE_TOKENS,
            timeout=settings.TIMELINE_EXTRACTION_TIMEOUT_SECONDS,
        )
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error("Timeline extraction OpenAI request failed; using fallback parser: %s", str(e))
        return _fallback_extract_timeline(user_text)

    try:
        content = (resp.choices[0].message.content or "").strip()
        data = _extract_json_payload(content)
        valid_items: List[TimelineItem] = []
        for raw_item in data.get("items", []):
            try:
                valid_items.append(TimelineItem.model_validate(raw_item))
            except Exception:
                continue
        result = TimelineExtraction(items=valid_items)
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error("Timeline extraction response parsing failed; using fallback parser: %s", str(e))
        return _fallback_extract_timeline(user_text)

    sorted_items = sorted(
        result.items,
        key=lambda item: (
            CATEGORY_PRIORITY.get(item.category, 99),
            item.date_iso,
            item.time_24h or "99:99",
            item.title.lower(),
        ),
    )
    return TimelineExtraction(items=sorted_items[: settings.TIMELINE_EXTRACTION_MAX_ITEMS])
