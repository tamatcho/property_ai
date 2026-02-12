from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .db import Base, engine
from .config import settings
from .routes import auth, documents, chat, timeline, properties

Base.metadata.create_all(bind=engine)

app = FastAPI(title="NDIAH MVP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def validate_settings():
    if not settings.OPENAI_API_KEY.strip():
        raise RuntimeError(
            "OPENAI_API_KEY is missing. Set it in backend/.env before starting the API."
        )

app.include_router(auth.router)
app.include_router(properties.router)
app.include_router(documents.router)
app.include_router(chat.router)
app.include_router(timeline.router)

@app.get("/health")
def health():
    return {"ok": True}
