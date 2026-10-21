create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  mime_type text not null,
  file_data bytea not null,
  extracted_text text not null,
  page_count integer not null default 1,
  uploaded_at timestamptz not null default now(),
  unique (user_id, id)
);

create table if not exists document_chunks (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  document_id uuid not null,
  chunk_index integer not null,
  page_number integer not null default 1,
  content text not null,
  embedding extensions.vector(1536) not null,
  foreign key (user_id, document_id) references documents(user_id, id) on delete cascade
);

create index if not exists documents_user_uploaded_idx on documents(user_id, uploaded_at desc);
create index if not exists document_chunks_user_document_idx on document_chunks(user_id, document_id);
create index if not exists document_chunks_embedding_idx on document_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table users enable row level security;
alter table documents enable row level security;
alter table document_chunks enable row level security;
alter table documents force row level security;
alter table document_chunks force row level security;

drop policy if exists documents_owner_policy on documents;
create policy documents_owner_policy on documents
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

drop policy if exists chunks_owner_policy on document_chunks;
create policy chunks_owner_policy on document_chunks
  using (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
