-- Run this once in the Supabase SQL editor (Dashboard -> SQL -> New query).

create extension if not exists vector;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null,
  session_id text,                          -- anonymous owner; null for demo docs
  page_count int,
  status text not null default 'pending',   -- pending | processing | ready | failed
  error_message text,
  claimed_at timestamptz,                   -- when a worker took it; also a heartbeat
  chunks_done int default 0,
  chunks_total int default 0,
  is_demo boolean default false,
  starter_questions text[],                 -- suggested questions, shown for the demo document
  created_at timestamptz default now()
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  content text not null,
  page_number int not null,
  chunk_index int not null,
  embedding vector(384)
);

-- HNSW, not ivfflat: ivfflat derives its centroids from the rows present when the index is
-- built, so an index created on an empty table stays quietly bad forever. HNSW builds
-- incrementally as rows arrive.
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_document_id_idx on chunks (document_id);
create index if not exists documents_session_id_idx on documents (session_id);

-- Top-k cosine matches for one document, ranked in Postgres (not in JS).
create or replace function match_chunks(
  query_embedding vector(384),
  doc_id uuid,
  match_count int
)
returns table (
  id uuid,
  content text,
  page_number int,
  chunk_index int,
  similarity float
)
language sql stable
as $$
  select c.id, c.content, c.page_number, c.chunk_index,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.document_id = doc_id and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The anon key ships to the browser, so the client is read-only and scoped:
-- demo documents are public, everything else is visible only to the anonymous
-- session that uploaded it. The session id is an unguessable UUID the browser
-- sends as an `x-session-id` header. All writes go through the service role
-- (API routes and the worker).
-- ---------------------------------------------------------------------------

create or replace function request_session_id()
returns text
language sql stable
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-session-id', '');
$$;

-- security definer so the chunks policy can look at documents without
-- recursing into the documents policy.
create or replace function can_read_document(doc uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from documents d
    where d.id = doc
      and (d.is_demo or (d.session_id is not null and d.session_id = request_session_id()))
  );
$$;

alter table documents enable row level security;
alter table chunks enable row level security;

drop policy if exists documents_public_read on documents;
drop policy if exists documents_read on documents;
create policy documents_read on documents for select
  using (is_demo or (session_id is not null and session_id = request_session_id()));

drop policy if exists chunks_public_read on chunks;
drop policy if exists chunks_read on chunks;
create policy chunks_read on chunks for select
  using (can_read_document(document_id));

-- Private bucket for the raw PDFs; served to the viewer via signed URLs.
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;
