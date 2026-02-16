from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Literal
from ..firebase_auth import get_current_user
from ..db import get_db
from ..models import User
from ..property_access import get_owned_property_or_404
from ..rag import search, answer_with_context
from sqlalchemy.orm import Session

router = APIRouter(prefix="/chat", tags=["chat"], dependencies=[Depends(get_current_user)])

class ChatRequest(BaseModel):
    question: str
    property_id: int | None = None
    language: Literal["de", "en", "fr"] = "de"

@router.post("")
def chat(
    req: ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question must not be empty")
    if req.property_id is not None:
        get_owned_property_or_404(db, current_user.id, req.property_id)

    try:
        contexts = search(question, db=db, user_id=current_user.id, property_id=req.property_id, k=6)
        answer_json = answer_with_context(question, contexts, language=req.language)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception:
        raise HTTPException(status_code=500, detail="Chat request failed")

    return answer_json
