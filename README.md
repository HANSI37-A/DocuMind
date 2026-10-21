# DocuMind

DocuMind is a document Q&A application with accounts, private per-user libraries, PDF previews, selectable-text extraction plus OCR, streamed answers, page citations, and PostgreSQL/pgvector retrieval.

## Requirements

- Node.js 20 or newer
- Docker Desktop for the local PostgreSQL option, or a Supabase PostgreSQL project with the `vector` extension enabled
- A Gemini API key from Google AI Studio, or an OpenAI API key

## Run locally with Docker

1. If `.env` does not exist, copy `.env.example` to `.env`. If it already exists, keep it and add the missing settings below so you don't overwrite your API key. The sample `DATABASE_URL` matches the included local Docker database. Create a session secret in PowerShell:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

   Paste the generated value into `SESSION_SECRET` in `.env`. Keep `.env` private; it is ignored by Git.

2. Start PostgreSQL with pgvector:

   ```powershell
   docker compose up -d db
   ```

3. Install the application dependencies and create the database tables:

   ```powershell
   npm install
   npm run db:migrate
   ```

4. Start the web application and open [http://localhost:3000](http://localhost:3000):

   ```powershell
   npm start
   ```

Create an account in the sign-in screen. Upload a document, select it, then ask a question. PDF files show a built-in preview. Scanned pages are rendered and passed through Tesseract OCR when PDF.js finds little selectable text.

The original local-only MVP kept extracted text under `data/` but did not save the original PDF bytes. After you create an account, stop the server and import any previous library with `npm run db:import-local -- your-account@example.com`. It preserves the searchable text as `.txt` documents; the original PDFs cannot be reconstructed from the extracted text.

## Dependencies

- `pg`: PostgreSQL connection pool
- `pdfjs-dist`: PDF text extraction, page count, and rasterization for scanned pages
- `@napi-rs/canvas`: server-side PDF page rendering for OCR
- `tesseract.js`: OCR for image-only PDF pages

The app supports Gemini and OpenAI. Gemini is the default: it uses `gemini-embedding-001` reduced to 1536 dimensions and normalized for pgvector, plus streamed `gemini-2.5-flash` answers. Set `AI_PROVIDER=openai` and `OPENAI_API_KEY` to use OpenAI instead. The schema uses pgvector cosine distance and HNSW indexing. The frontend uses browser APIs and has no build step. If you change providers after uploading documents, re-upload them so their stored vectors use the same embedding model as chat retrieval.

## Hosted database with Supabase

Create a Supabase project, enable the `vector` extension from **Database → Extensions**, and copy the database connection string from **Project Settings → Database**. Use the direct connection for migrations and set `DATABASE_URL` to that value. Use `DATABASE_SSL=require`. Run `npm run db:migrate` once against the hosted database. The migration enables RLS on documents and chunks; app queries set the signed-in user ID inside each transaction.

## Deploy on Render

The included `render.yaml` describes one web service. The application serves its frontend and API together, and keeps uploaded file bytes in PostgreSQL, so it does not need a separate frontend host or a persistent Render disk.

1. Push this repository to a GitHub repository you control.
2. Create a Supabase PostgreSQL project and enable `vector`.
3. In Render, choose **New → Blueprint**, connect the GitHub repository, and apply `render.yaml`.
4. Set the prompted `DATABASE_URL` to the Supabase connection string and `GEMINI_API_KEY` to your Google AI Studio key. Render generates `SESSION_SECRET` from the blueprint.
5. Deploy. The build command installs the locked dependencies, runs the database migration, and checks `/api/health` after startup.

Render's free web services can spin down after inactivity, and free-tier service/database limits can change. Check the provider's current plan details before relying on a public demo.

## Privacy and limits

Passwords are stored as salted scrypt hashes. Session cookies are signed, HTTP-only, and SameSite. Documents and vector chunks are owned by a user ID, and PostgreSQL RLS enforces that scope inside each transaction. PDF bytes and extracted text are stored in PostgreSQL. Selected text passages and questions are sent to the selected AI provider for embeddings and chat. The default limits are 20 MB per file and 150 PDF pages; OCR language defaults to English. The app does not include email verification, password resets, organization roles, or billing.
