# Docsense

**Ask a PDF a question and get an answer you can check.** Every claim in every answer carries the
page number it came from, and clicking that page number opens the document beside the answer, on
that page, highlighted.

| | |
| --- | --- |
| **Live** | `https://TODO.vercel.app` — replace after deploying |
| **Demo video** | 90-second walkthrough — _TODO: record and link_ |
| **Stack** | Next.js 16 · TypeScript · Tailwind v4 · Supabase (Postgres + pgvector + Storage) · transformers.js · Groq / Gemini |

<!-- Add docs/screenshot.png, then uncomment:
![Docsense — an answer with page citations open beside the source document](docs/screenshot.png)
-->

## The problem this solves

Businesses keep their real operating knowledge in long PDFs — policy handbooks, supplier
contracts, compliance manuals, technical specifications — and answering a single question means
someone opening a 200-page file and knowing roughly where to look. General-purpose chatbots make
that worse rather than better: they answer fluently from training data, blend it with the
document, and give you no way to tell which is which, so every answer has to be verified from
scratch anyway. Docsense answers **only** from the document you gave it, refuses outright when
the document doesn't contain the answer, and attaches a page citation to every claim that takes
one click to check. That last part is the product: the value isn't the answer, it's that
verifying the answer takes two seconds instead of twenty minutes.

It runs entirely on free tiers, with no paid API anywhere. Embeddings are computed locally with
transformers.js rather than bought per token, so the running cost of an internal deployment is
the cost of a small container.

## How it works

| Piece | Runs on | Job |
| --- | --- | --- |
| Next.js app | Vercel | Upload, ask, chat UI, PDF viewer |
| Worker (`/worker`) | Render / Railway / local | Indexes documents; also embeds questions |
| Supabase | Supabase free tier | Postgres + pgvector, and private Storage for the PDFs |

Ingestion lives in a separate long-running worker because embedding a 200-page PDF locally takes
minutes, which no serverless platform will allow. The app writes a `pending` row; the worker
picks it up and reports progress the UI polls for.

### Uploads

The browser never gets blanket write access, and the bytes never pass through a serverless
function (a Vercel request body caps out around 4.5 MB — far under the 50 MB limit we accept):

1. `POST /api/upload` validates the file and returns a **single-use signed upload URL** scoped to
   exactly one storage path, minted with the service role.
2. The browser sends the bytes straight to Supabase Storage using that URL.
3. `POST /api/upload/complete` confirms the object landed, then inserts the `documents` row as
   `pending`. Writing the row last means the worker never sees a document whose file is missing.

### Indexing

1. Reclaim any document stuck in `processing` for more than 15 minutes.
2. Claim the oldest `pending` document with a **conditional update** (`status = 'pending'` in the
   `WHERE`). That update *is* the lock — two worker instances can never claim the same row.
3. Extract text **per page** with `unpdf`, chunk each page separately, embed locally with
   `Xenova/all-MiniLM-L6-v2`, insert in batches, bumping `chunks_done` as it goes.

**Page numbers are the whole product.** A chunk belongs to exactly one page and never spans a
page boundary. The page number is attached at extraction and carried through chunking to
insertion — never re-derived, never looked up later. `npm run verify:pages -- some.pdf` prints
the chunks grouped by page for checking against the real document.

**Crash recovery is reprocessing, not resuming.** When the worker picks up a document it deletes
that document's existing chunks and starts over. Resuming would be faster, but a resume that goes
subtly wrong produces a half-indexed document that answers confidently and incompletely, with no
symptom anyone would notice. Minutes of recomputation is the cheaper failure. Progress updates
double as a heartbeat, so a genuinely long document is never mistaken for a stalled one.

**Pages with no text** (scans, image-only pages) are skipped with a warning and don't break page
numbering. If *no* page yields text, the document fails with a message saying it looks like a
scan needing OCR.

### Chunk size

220 tokens with 40 tokens of overlap, sized against a hard ceiling: **all-MiniLM-L6-v2 truncates
its input at 256 tokens**, so text past that is stored and shown as context but contributes
nothing to the vector. Raising `CHUNK_TOKENS` above ~250 degrades retrieval silently; changing it
meaningfully means changing the embedding model.

### Asking

`POST /api/ask` embeds the question, retrieves the top 12 chunks through the `match_chunks` RPC,
builds the excerpt block, and streams the answer back as plain text.

**One embedding module, two callers.** `lib/embed.mts` is the only place a vector is produced.
A mismatch in model, pooling or normalisation between indexing and querying wouldn't raise
anything — it would quietly return the wrong chunks — so neither side gets its own copy.

**Where the question is embedded.** The worker exposes a bearer-authenticated `POST /embed`, and
the ask route calls it. A cold serverless instance would otherwise fetch ~90 MB of model before
it could answer, and `/tmp` doesn't survive between instances — on a low-traffic demo that means
the *first* question a visitor asks is the one that stalls. If the worker is unreachable the
route embeds in-process instead, so local development works with the worker stopped and a worker
outage costs latency rather than search.

**Retrieval is unfiltered on purpose.** `match_chunks` is pure top-k with no similarity floor.
Weak context still goes to the model, which will refuse honestly having read it — better than
refusing before it sees anything. Empty results are therefore never "everything scored too low";
they mean the document has no indexed chunks or every match collapsed into overlap. Both are
counted and logged with the best score available, because a confident refusal looks identical to
a correct one from outside.

**Excerpts are deduplicated and put in document order,** each labelled `[p. N]`. Chunks arrive
ranked by similarity and overlap each other by design, so consecutive hits would otherwise repeat
the same sentences inside one prompt.

**Providers.** Groq first, Gemini as fallback, model ids from the environment because free-tier
availability changes without notice. A 429 is retried with exponential backoff and jitter (3
attempts); two consecutive failures move the request to the other provider; anything
non-retryable switches immediately. If every provider is exhausted the endpoint still streams a
friendly sentence — a rate limit never reaches the visitor as an error.

### Citations

The interaction the whole app exists for:

- `[p. N]` markers are parsed out of the answer and rendered as inline chips where they appear.
  Markers routinely arrive split across stream chunks — `"...clause [p. 1"` then `"4] applies"` —
  so an unfinished marker at the end of the buffer is **held back** rather than briefly rendered
  as literal text. Once the stream closes, a trailing `[` really was just a bracket and is shown.
- The retrieved page set also renders as **Sources** chips under each answer, taken from the
  `x-source-pages` response header rather than from the answer text.
- Clicking any chip opens the viewer beside the chat (full screen on small viewports), on that
  page, with a highlight that replays even if you click the same citation twice.
- The viewer renders **one page at a time** on purpose. A citation jump has to land instantly and
  unmistakably; scrolling a 150-page continuous view to an offset is slower, less certain, and
  renders pages nobody asked for. Prev/next, direct page entry and zoom are all there.
- The PDF is fetched through a 30-minute signed URL scoped to the session. The bucket stays
  private and the browser never holds credentials for it.

### Access control

Each visitor mints an anonymous session id (a UUID) on first visit, kept in a cookie and sent as
an `x-session-id` header. Row level security scopes reads to `is_demo = true` or a matching
`session_id`, so one visitor's uploaded contract is not readable by anyone else. All writes go
through the service role. The session id is a bearer capability, like a signed URL — unguessable,
not an identity.

## Setup, from clone to running

Requires **Node 22.18+** (the worker is TypeScript run directly, with no build step).

```bash
git clone <your-repo-url> docqa && cd docqa
npm install
cp .env.example .env.local
```

1. **Create a Supabase project** (free tier, no card) at https://supabase.com.
2. **Run the schema.** Dashboard → SQL Editor → New query → paste all of `supabase/schema.sql` →
   Run. This creates the tables, the `match_chunks` RPC, the RLS policies and the private `pdfs`
   bucket.
3. **Fill in `.env.local`.** Supabase Dashboard → Project Settings → API:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `GROQ_API_KEY` from https://console.groq.com and/or `GEMINI_API_KEY` from
     https://aistudio.google.com/apikey — either alone works
   - `WORKER_EMBED_TOKEN` — any random string; the app and worker must agree
   - `WORKER_EMBED_URL=http://localhost:8080` for local use
4. **Start the worker** in one terminal: `npm run worker`. The first boot downloads the ~90 MB
   embedding model. Wait for `model ready`.
5. **Start the app** in another: `npm run dev` → http://localhost:3000
6. **Seed the demo document** (optional but recommended): `npm run seed:demo`. It downloads IRS
   Publication 17, queues it, and the running worker indexes it. Takes a few minutes.
7. Upload a PDF, or ask one of the demo's starter questions.

```bash
npm run test                          # chunker, context, citations, rate limit
npm run verify:pages -- file.pdf 42   # what page 42 actually indexed
```

## Migrating an existing database

If your project predates any of these changes, run this once instead of re-running the schema:

```sql
-- 1. ivfflat -> hnsw. ivfflat centroids are built from the rows present at creation time,
--    so an index created on an empty table stays quietly bad forever.
drop index if exists chunks_embedding_idx;
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

-- 2. Session-scoped reads instead of world-readable documents.
alter table documents add column if not exists session_id text;
create index if not exists documents_session_id_idx on documents (session_id);

create or replace function request_session_id()
returns text language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-session-id', '');
$$;

create or replace function can_read_document(doc uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from documents d
    where d.id = doc
      and (d.is_demo or (d.session_id is not null and d.session_id = request_session_id()))
  );
$$;

drop policy if exists documents_public_read on documents;
drop policy if exists documents_read on documents;
create policy documents_read on documents for select
  using (is_demo or (session_id is not null and session_id = request_session_id()));

drop policy if exists chunks_public_read on chunks;
drop policy if exists chunks_read on chunks;
create policy chunks_read on chunks for select using (can_read_document(document_id));

-- 3. Worker claim timestamp, used for the stale-document reclaim.
alter table documents add column if not exists claimed_at timestamptz;

-- 4. Starter questions carried by the demo document.
alter table documents add column if not exists starter_questions text[];
```

Changing `CHUNK_TOKENS` invalidates existing chunks. Re-index by setting affected documents back
to `pending`; the worker deletes old chunks when it claims them.

## Deployment

Deploy the **worker first** — the app wants its URL.

### Worker → Render (free tier)

It binds `PORT` for the embed endpoint, so it deploys as an ordinary **Web Service**, not a
background worker (which Render doesn't offer on the free plan).

| Setting | Value |
| --- | --- |
| Build command | `npm install` |
| Start command | `npm run worker` |
| Health check path | `/health` |
| Environment | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_EMBED_TOKEN` |

Free instances sleep when idle; the first request wakes them, and the app falls back to embedding
in-process while that happens. Railway works the same way, with no health check needed.

### App → Vercel

| Setting | Value |
| --- | --- |
| Framework | Next.js (auto-detected) |
| Environment | everything in `.env.example` except `PORT`, plus `WORKER_EMBED_URL=https://your-worker.onrender.com` |

`SUPABASE_SERVICE_ROLE_KEY` and `WORKER_EMBED_TOKEN` are server-only — never prefix them with
`NEXT_PUBLIC_`.

### After deploying

Run `npm run seed:demo` locally against the production Supabase project (it only needs the URL
and the service role key), and the deployed worker will index it.

## Known limits

Stated plainly, because these are the things that will bite:

- **No OCR.** A scanned PDF has no extractable text, so it fails with a message saying so rather
  than indexing nothing. Text-based PDFs only.
- **Free-tier LLM rate limits are real.** Groq and Gemini both throttle without warning. The app
  retries, falls back between providers, and degrades to a friendly message — but under sustained
  use you will hit them.
- **Rate limiting is in memory.** 20 questions per hour per IP, per process. It resets on
  redeploy and isn't shared between serverless instances, so the real ceiling is roughly
  20 × instances. Enough to stop one visitor draining a key; not a hard guarantee.
- **Retrieval quality is bounded by the embedding model.** all-MiniLM-L6-v2 is small, fast and
  free; it is not as good as a paid embedding API on nuanced or domain-specific phrasing.
- **Sessions are anonymous and cookie-based.** Clearing cookies loses access to your uploads.
  There are no accounts.
- **Conversation history lives in the browser tab.** Reloading starts a fresh thread.
- **Cold starts.** Free Render instances sleep; the first question after an idle period is slower
  while the worker wakes.
- **The demo document is public** by design. Anything else you upload is scoped to your session.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run test` | Chunker, context, citation and rate-limit tests (`node:test`, no framework) |
| `npm run worker` | Indexing worker and embed endpoint — leave it running |
| `npm run seed:demo` | Seed or replace the demo document (repeatable) |
| `npm run verify:pages -- file.pdf [page]` | Print extracted chunks grouped by page |

Tuning knobs live in `.env.example`, each with a comment explaining what it trades off.
