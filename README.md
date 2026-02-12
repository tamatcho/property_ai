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

## Free Hosting (Phone Test)

### Option A (recommended): Render (Backend) + Vercel (Frontend)

This setup is free to start and easy to upgrade later.

1. Push this repo to GitHub.
2. Deploy backend on Render:
   - In Render: `New +` -> `Blueprint`
   - Select your repo (Render reads `render.yaml`)
   - Set secret env var: `OPENAI_API_KEY`
   - Deploy and copy backend URL (example: `https://ndiah-backend.onrender.com`)
3. Deploy frontend on Vercel:
   - Import project from GitHub, set Root Directory to `frontend`
   - Add env var `VITE_API_BASE_URL` = your Render backend URL
   - Deploy
4. Open Vercel URL on your phone and run `Health prüfen` in the app.

Notes:
- Render free web services can sleep after inactivity, so first request may take ~30-60s.
- Render Free filesystem is ephemeral (not persistent across restarts/redeploys), and free services spin down on idle.
- This app stores required runtime state in the hosted database (documents/chunks/timeline/auth/properties), so it does not depend on local filesystem persistence.

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
- `DATABASE_URL` should point to Postgres in hosted environments.
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
