## NDIAH MVP

FastAPI backend for:
- PDF upload and chunking
- Vector retrieval with DB-backed embeddings
- Context-grounded chat
- Timeline extraction from raw text

## Project Structure

- `backend/app`: API, ingestion, RAG, timeline extraction
- `backend/storage`: optional local data for development only
- `frontend`: React (Vite + TypeScript) UI (upload, chat, timeline, status)

## Prerequisites

- Python 3.11+ recommended
- OpenAI API key

## Setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set `OPENAI_API_KEY` in `backend/.env`.
Set `DATABASE_URL` in `backend/.env` for hosted Postgres, for example:

```bash
DATABASE_URL=postgresql+psycopg://user:password@host:5432/dbname
```

## Run API

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

## Run Frontend

```bash
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Open: `http://127.0.0.1:5173`

## Hosting (Railway + Supabase + Vercel)

### Backend on Railway, Database on Supabase

1. Create Supabase project and copy `Connection string` (`URI`).
2. In Supabase, use the pooled Postgres URL as `DATABASE_URL`.
   Example:
   `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
3. Push this repo to GitHub.
4. Create a Railway project and connect this repo.
5. Railway reads `railway.toml` in repo root (build + start are preconfigured for `backend`).
6. Set Railway environment variables:
   - `DATABASE_URL` = Supabase Postgres URL
   - `OPENAI_API_KEY` = your key
   - optional: `OPENAI_MODEL`, `EMBED_MODEL`, `CORS_ORIGINS`
   - if Firebase auth is used: `FIREBASE_SERVICE_ACCOUNT_JSON`
7. Deploy and copy backend URL.

### Frontend on Vercel

1. Import repo in Vercel, set Root Directory to `frontend`.
2. Set `VITE_API_BASE_URL` to the Railway backend URL.
3. Deploy.

### One-time DB migration (existing deployments)

If your database already has `timeline_items`, run once:

```sql
ALTER TABLE timeline_items
ADD COLUMN IF NOT EXISTS source_quote TEXT;
```

## API Usage

Upload PDF:

```bash
curl -X POST "http://localhost:8000/documents/upload" \
  -F "property_id=1" \
  -F "file=@/absolute/path/to/file.pdf"
```

Upload ZIP (with multiple PDFs):

```bash
curl -X POST "http://localhost:8000/documents/upload" \
  -F "property_id=1" \
  -F "file=@/absolute/path/to/files.zip"
```

Ask a question (uses DB-stored chunk embeddings):

```bash
curl -X POST "http://localhost:8000/chat" \
  -H "Content-Type: application/json" \
  -d '{"question":"Welche Zahlungen sind 2026 fällig?", "property_id": 1}'
```

Extract timeline from raw text:

```bash
curl -X POST "http://localhost:8000/timeline/extract" \
  -H "Content-Type: application/json" \
  -d '{"raw_text":"..."}'
```

List timeline items for a property:

```bash
curl "http://localhost:8000/timeline?property_id=1"
```

Index/document status:

```bash
curl "http://localhost:8000/documents/status"
```

## Notes

- API startup fails fast if `OPENAI_API_KEY` is missing.
- Upload accepts single PDF files and ZIP archives containing PDFs.
- `DATABASE_URL` should point to Postgres in hosted environments (Railway).
- On startup, the app runs `Base.metadata.create_all()` for MVP schema creation.
- For production schema evolution, use migrations (e.g., Alembic).

## Tests

```bash
cd backend
source .venv/bin/activate
pytest -q tests
```

## Bulk Ingest Existing Uploads (Optional)

If you manually copied PDFs into `backend/storage/uploads`, ingest and index all missing files with:

```bash
cd backend
source .venv/bin/activate
python scripts/bulk_ingest_uploads.py
```

Recompute chunk embeddings from all PDFs in `UPLOAD_DIR`:

```bash
cd backend
source .venv/bin/activate
python scripts/bulk_ingest_uploads.py --property-id 1 --reindex
```

Behavior:
- Reads all `.pdf` files in `UPLOAD_DIR`
- Skips files already present in the `documents` table (by file path)
- Creates DB rows and chunk embeddings for new files
- With `--reindex`, recomputes chunk embeddings for all PDFs
