import json
import re
from openai import OpenAI
from pydantic import BaseModel, Field
from typing import Literal, Optional
from .config import settings

client = OpenAI(api_key=settings.OPENAI_API_KEY)


class FinancialsData(BaseModel):
    totalAmount: Optional[float] = None
    balance: Optional[float] = None
    monthlyFee: Optional[float] = None


class TaxData(BaseModel):
    maintenanceCosts: Optional[float] = None
    adminFees: Optional[float] = None
    insurance: Optional[float] = None
    serviceCharges35a: Optional[float] = None
    handyman35a: Optional[float] = None
    otherDeductible: Optional[float] = None


class DocumentExtractionData(BaseModel):
    type: Literal["abrechnung", "versammlung", "wirtschaftsplan", "vertrag", "beschluss", "sonstiges"]
    summary: str
    financials: Optional[FinancialsData] = None
    taxData: Optional[TaxData] = None


def extract_financial_data(document_text: str) -> DocumentExtractionData:
    text = (document_text or "").strip()
    if len(text) > settings.TIMELINE_EXTRACTION_INPUT_CHARS:
         text = text[:settings.TIMELINE_EXTRACTION_INPUT_CHARS]

    system_prompt = """
Du analysierst dieses Dokument einer deutschen Hausverwaltung oder eines Immobilienservice.
    
    1. Bestimme den Typ (type): 
       - 'abrechnung' (Hausgeldabrechnung, Nutzerabrechnung, Heizkosten)
       - 'versammlung' (Einladung, Protokoll)
       - 'wirtschaftsplan' (Einzelwirtschaftsplan, Gesamtplan)
       - 'vertrag' (Verwaltervertrag, Wartungsvertrag, Reinigungsvertrag)
       - 'beschluss' (Umlaufbeschluss, Beschlusssammlung)
       - 'sonstiges'
       
    2. Erstelle eine kurze, verständliche Zusammenfassung (summary) in max 3 Sätzen.
    
    3. Extrahiere Finanzdaten (financials):
       - 'totalAmount': Gesamtsumme der Abrechnung oder des Plans.
       - 'balance': Abrechnungssaldo (Nachzahlung ist positiv, Guthaben ist negativ).
       - 'monthlyFee': Neues monatliches Hausgeld (falls angegeben).
       
    4. Extrahiere steuerlich relevante Daten (taxData) besonders nach §35a EStG:
       - 'maintenanceCosts': Instandhaltung/Reparaturen.
       - 'adminFees': Verwaltergebühren.
       - 'insurance': Versicherungen.
       - 'serviceCharges35a': Haushaltsnahe Dienstleistungen (anrechenbarer Betrag nach §35a).
       - 'handyman35a': Handwerkerleistungen (anrechenbarer Betrag nach §35a).
       - 'otherDeductible': Sonstige absetzbare Kosten.
    
    Lass Werte auf null, falls sie nicht im Text existieren. 
    Verwende Punkt als Dezimaltrennzeichen (z.B. 219.29).
    Antworte ausschließlich im JSON-Format.
    
    Ausgabeformat:
    {"type": "abrechnung", "summary": "...", "financials": {"totalAmount": 1000.0, "balance": 50.0, "monthlyFee": null}, "taxData": {"maintenanceCosts": 200.0, "adminFees": null, "insurance": null, "serviceCharges35a": null, "handyman35a": null, "otherDeductible": null}}
    """

    try:
        resp = client.chat.completions.create(
            model=settings.EXTRACTION_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        content = (resp.choices[0].message.content or "").strip()
        data = json.loads(content)
        return DocumentExtractionData.model_validate(data)
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Failed to extract financial data")
        return DocumentExtractionData(type="sonstiges", summary="Extraktion fehlgeschlagen.")

