-- =====================================================================
-- CONTRACT NEGOTIATION PLATFORM — SUPABASE SCHEMA (MVP)
-- =====================================================================
-- Run this entire file once in: Supabase Dashboard → SQL Editor → New query
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE where possible.
--
-- Domain model (matches PRD 2.3 / 2.6 / 2.7):
--   matters              -> a single negotiation ("deal") between two sides
--   matter_participants  -> which auth.users belong to which side of a matter
--   versions             -> a "commit" (uploaded .docx) on a matter
--   comments             -> comments attached to a specific version
--   signature_requests   -> mocked e-signature status per finalized version
--   audit_log            -> append-only trail of who did what, when
-- =====================================================================

-- ---------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gives us gen_random_uuid()

-- ---------------------------------------------------------------------
-- PART 1: TABLES
-- ---------------------------------------------------------------------

-- Lightweight profile row, 1:1 with auth.users. Keeps a display name
-- without needing to touch Supabase's internal auth schema.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  law_firm    text,
  created_at  timestamptz not null default now()
);

-- A single negotiation. "drafting" side creates it; "counterparty" side
-- is invited (added to matter_participants) afterward.
create table if not exists public.matters (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  status       text not null default 'active'
               check (status in ('active', 'in_signature', 'executed', 'archived')),
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Who is on which side of a given matter.
create table if not exists public.matter_participants (
  id          uuid primary key default gen_random_uuid(),
  matter_id   uuid not null references public.matters(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  side        text not null check (side in ('drafting', 'counterparty')),
  added_at    timestamptz not null default now(),
  unique (matter_id, user_id)
);

-- A "commit": one uploaded .docx version of the contract for a matter.
create table if not exists public.versions (
  id                 uuid primary key default gen_random_uuid(),
  matter_id          uuid not null references public.matters(id) on delete cascade,
  version_number     int not null,
  file_path          text not null,      -- path inside the storage bucket
  file_name          text not null,      -- original filename, e.g. "MSA_v3.docx"
  committed_by       uuid not null references auth.users(id),
  side               text not null check (side in ('drafting', 'counterparty')),
  commit_message     text,
  status             text not null default 'draft'
                     check (status in ('draft', 'final')),
  parent_version_id  uuid references public.versions(id), -- for "revert to older version"
  created_at         timestamptz not null default now(),
  unique (matter_id, version_number)
);

-- Comments on a specific version (PR-review-comment equivalent).
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.versions(id) on delete cascade,
  matter_id   uuid not null references public.matters(id) on delete cascade, -- denormalized for simpler RLS
  user_id     uuid not null references auth.users(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Mocked e-signature status per finalized version.
create table if not exists public.signature_requests (
  id             uuid primary key default gen_random_uuid(),
  matter_id      uuid not null references public.matters(id) on delete cascade,
  version_id     uuid not null references public.versions(id) on delete cascade,
  provider       text not null default 'mock' check (provider in ('mock', 'docusign', 'adobe_sign')),
  status         text not null default 'not_sent'
                 check (status in ('not_sent', 'sent', 'viewed', 'signed', 'completed', 'declined')),
  signer_emails  jsonb,
  sent_at        timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- Append-only audit trail.
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  matter_id   uuid references public.matters(id) on delete cascade,
  actor_id    uuid references auth.users(id),
  action      text not null,      -- e.g. 'version.created', 'version.finalized', 'comment.added'
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

-- Helpful indexes
create index if not exists idx_versions_matter        on public.versions (matter_id);
create index if not exists idx_comments_version        on public.comments (version_id);
create index if not exists idx_comments_matter         on public.comments (matter_id);
create index if not exists idx_participants_matter     on public.matter_participants (matter_id);
create index if not exists idx_participants_user       on public.matter_participants (user_id);
create index if not exists idx_signature_matter        on public.signature_requests (matter_id);
create index if not exists idx_audit_matter            on public.audit_log (matter_id);


-- ---------------------------------------------------------------------
-- PART 2: FUNCTIONS & TRIGGERS
-- ---------------------------------------------------------------------

-- Reusable helper: is the current authenticated user a participant on this matter?
-- security definer so it can read matter_participants even under RLS.
create or replace function public.is_matter_participant(p_matter_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.matter_participants mp
    where mp.matter_id = p_matter_id
      and mp.user_id = auth.uid()
  );
$$;

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Whoever creates a matter is automatically its first "drafting" participant.
create or replace function public.handle_new_matter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.matter_participants (matter_id, user_id, side)
  values (new.id, new.created_by, 'drafting')
  on conflict (matter_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_matter_created on public.matters;
create trigger on_matter_created
  after insert on public.matters
  for each row execute function public.handle_new_matter();

-- Auto-increment version_number per matter so the client doesn't have to
-- compute it (and risk collisions). NOTE: fine for MVP demo traffic; a
-- true concurrent-commit race would need a sequence or advisory lock.
create or replace function public.set_version_number()
returns trigger
language plpgsql
as $$
begin
  if new.version_number is null then
    select coalesce(max(version_number), 0) + 1
      into new.version_number
      from public.versions
      where matter_id = new.matter_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_version_number on public.versions;
create trigger trg_set_version_number
  before insert on public.versions
  for each row execute function public.set_version_number();

-- keep matters.updated_at fresh
create or replace function public.touch_matter_updated_at()
returns trigger
language plpgsql
as $$
begin
  update public.matters set updated_at = now() where id = new.matter_id;
  return new;
end;
$$;

drop trigger if exists trg_touch_matter_on_version on public.versions;
create trigger trg_touch_matter_on_version
  after insert or update on public.versions
  for each row execute function public.touch_matter_updated_at();

-- Generic audit logger, reused across a few tables.
create or replace function public.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matter_id uuid;
  v_action    text;
begin
  v_matter_id := coalesce(new.matter_id, old.matter_id);
  v_action := TG_TABLE_NAME || '.' || lower(TG_OP);

  insert into public.audit_log (matter_id, actor_id, action, metadata)
  values (v_matter_id, auth.uid(), v_action, to_jsonb(new));

  return new;
end;
$$;

drop trigger if exists trg_audit_versions on public.versions;
create trigger trg_audit_versions
  after insert or update on public.versions
  for each row execute function public.log_audit_event();

drop trigger if exists trg_audit_comments on public.comments;
create trigger trg_audit_comments
  after insert on public.comments
  for each row execute function public.log_audit_event();

drop trigger if exists trg_audit_signature on public.signature_requests;
create trigger trg_audit_signature
  after insert or update on public.signature_requests
  for each row execute function public.log_audit_event();


-- ---------------------------------------------------------------------
-- PART 3: ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.matters             enable row level security;
alter table public.matter_participants enable row level security;
alter table public.versions            enable row level security;
alter table public.comments            enable row level security;
alter table public.signature_requests  enable row level security;
alter table public.audit_log           enable row level security;

-- profiles: anyone can read basic profile info of matter co-participants;
-- users can only edit their own profile.
drop policy if exists "profiles are readable by anyone signed in" on public.profiles;
create policy "profiles are readable by anyone signed in"
  on public.profiles for select
  using (auth.role() = 'authenticated');

drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
  on public.profiles for update
  using (id = auth.uid());

-- matters: visible/editable only to participants; any signed-in user may create one.
drop policy if exists "participants can view matters" on public.matters;
create policy "participants can view matters"
  on public.matters for select
  using (public.is_matter_participant(id));

drop policy if exists "signed-in users can create matters" on public.matters;
create policy "signed-in users can create matters"
  on public.matters for insert
  with check (auth.uid() = created_by);

drop policy if exists "participants can update matters" on public.matters;
create policy "participants can update matters"
  on public.matters for update
  using (public.is_matter_participant(id));
  -- NOTE (known gap from PRD review): this allows either side to change
  -- matter status, including moving to "in_signature". If you want a
  -- stricter model later (e.g. only the side that receives a "final"
  -- version can trigger signature), tighten this policy then.

-- matter_participants: participants can see who else is on the matter;
-- only existing participants can add new ones (i.e. invite the counterparty).
drop policy if exists "participants can view participant list" on public.matter_participants;
create policy "participants can view participant list"
  on public.matter_participants for select
  using (public.is_matter_participant(matter_id));

drop policy if exists "participants can add participants" on public.matter_participants;
create policy "participants can add participants"
  on public.matter_participants for insert
  with check (public.is_matter_participant(matter_id) or auth.uid() = user_id);

-- versions: only visible/insertable by participants of the parent matter.
drop policy if exists "participants can view versions" on public.versions;
create policy "participants can view versions"
  on public.versions for select
  using (public.is_matter_participant(matter_id));

drop policy if exists "participants can commit versions" on public.versions;
create policy "participants can commit versions"
  on public.versions for insert
  with check (public.is_matter_participant(matter_id) and committed_by = auth.uid());

drop policy if exists "participants can update versions" on public.versions;
create policy "participants can update versions"
  on public.versions for update
  using (public.is_matter_participant(matter_id));

-- comments: same participant-only pattern.
drop policy if exists "participants can view comments" on public.comments;
create policy "participants can view comments"
  on public.comments for select
  using (public.is_matter_participant(matter_id));

drop policy if exists "participants can add comments" on public.comments;
create policy "participants can add comments"
  on public.comments for insert
  with check (public.is_matter_participant(matter_id) and user_id = auth.uid());

-- signature_requests: participant-only, read + insert/update.
drop policy if exists "participants can view signature requests" on public.signature_requests;
create policy "participants can view signature requests"
  on public.signature_requests for select
  using (public.is_matter_participant(matter_id));

drop policy if exists "participants can manage signature requests" on public.signature_requests;
create policy "participants can manage signature requests"
  on public.signature_requests for all
  using (public.is_matter_participant(matter_id))
  with check (public.is_matter_participant(matter_id));

-- audit_log: read-only for participants, never writable directly by clients
-- (only the trigger function, running as security definer, writes to it).
drop policy if exists "participants can view audit log" on public.audit_log;
create policy "participants can view audit log"
  on public.audit_log for select
  using (public.is_matter_participant(matter_id));


-- ---------------------------------------------------------------------
-- PART 4: STORAGE BUCKET FOR .DOCX FILES
-- ---------------------------------------------------------------------
-- Convention: objects are stored at   {matter_id}/{version_id}_{filename}
-- so the first "folder" in the path always equals the matter's UUID.
-- This lets us reuse is_matter_participant() for storage RLS too.

insert into storage.buckets (id, name, public)
values ('contract-documents', 'contract-documents', false)
on conflict (id) do nothing;

drop policy if exists "participants can read contract files" on storage.objects;
create policy "participants can read contract files"
  on storage.objects for select
  using (
    bucket_id = 'contract-documents'
    and public.is_matter_participant(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "participants can upload contract files" on storage.objects;
create policy "participants can upload contract files"
  on storage.objects for insert
  with check (
    bucket_id = 'contract-documents'
    and public.is_matter_participant(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "participants can update contract files" on storage.objects;
create policy "participants can update contract files"
  on storage.objects for update
  using (
    bucket_id = 'contract-documents'
    and public.is_matter_participant(((storage.foldername(name))[1])::uuid)
  );

-- =====================================================================
-- END OF SCHEMA
-- =====================================================================
