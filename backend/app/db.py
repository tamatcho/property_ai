from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker, declarative_base
from pathlib import Path
from .config import settings

db_url = settings.DATABASE_URL
if db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql+psycopg://", 1)
elif db_url.startswith("postgresql+psycopg2://"):
    db_url = db_url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)
elif db_url.startswith("postgresql://") and "+psycopg" not in db_url and "+psycopg2" not in db_url:
    db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)

def _prepare_sqlite_path(url: str) -> None:
    parsed = make_url(url)
    if parsed.get_backend_name() != "sqlite":
        return

    database = parsed.database
    if not database or database == ":memory:" or database.startswith("file:"):
        return

    db_file = Path(database)
    if not db_file.is_absolute():
        db_file = Path.cwd() / db_file

    try:
        db_file.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(
            f"SQLite path is not writable: {db_file.parent}. "
            "Set DATABASE_URL to a writable location or use hosted Postgres."
        ) from exc

connect_args = {}
if db_url.startswith("sqlite"):
    _prepare_sqlite_path(db_url)
    connect_args = {"check_same_thread": False}

engine = create_engine(db_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
