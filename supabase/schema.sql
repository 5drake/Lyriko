-- Lyriko: Shared Karaoke Analysis Cache & Revision Schema for Supabase (PostgreSQL)
-- Run this once in your Supabase SQL Editor.

create table if not exists public.song_analyses (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null unique,
  lyrics_hash text not null,
  pipeline_version text not null default 'v1',
  title text not null default '',
  artist text not null default '',
  duration double precision not null default 0,
  artwork_url text,
  mr_youtube_id text,
  mr_sync_offset double precision not null default 0,
  karaoke_youtube_id text,
  karaoke_sync_offset double precision not null default 0,
  lines_json jsonb not null,
  disambiguated_count integer not null default 0,
  device_label text,
  upvotes integer not null default 1,
  status text not null default 'auto',
  locked boolean not null default false,
  author_name text not null default 'AI 자동 분석',
  edit_note text not null default '',
  active_revision_id text,
  revision_count integer not null default 1,
  report_count integer not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.song_analyses add column if not exists artwork_url text;
alter table public.song_analyses add column if not exists status text not null default 'auto';
alter table public.song_analyses add column if not exists locked boolean not null default false;
alter table public.song_analyses add column if not exists author_name text not null default 'AI 자동 분석';
alter table public.song_analyses add column if not exists edit_note text not null default '';
alter table public.song_analyses add column if not exists active_revision_id text;
alter table public.song_analyses add column if not exists revision_count integer not null default 1;
alter table public.song_analyses add column if not exists report_count integer not null default 0;
alter table public.song_analyses add column if not exists hidden boolean not null default false;

create table if not exists public.song_revisions (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null references public.song_analyses(youtube_video_id) on delete cascade,
  rev_id text not null,
  version integer not null default 1,
  status text not null default 'edited',
  author_name text not null default '익명 기여자',
  edit_note text not null default '',
  lyrics_hash text not null,
  mr_youtube_id text,
  mr_sync_offset double precision not null default 0,
  karaoke_youtube_id text,
  karaoke_sync_offset double precision not null default 0,
  lines_json jsonb not null,
  disambiguated_count integer not null default 0,
  device_label text,
  created_at timestamptz not null default now(),
  unique (youtube_video_id, rev_id)
);

create table if not exists public.song_reports (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null references public.song_analyses(youtube_video_id) on delete cascade,
  reason text not null default 'other',
  note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_song_analyses_updated_at
  on public.song_analyses (updated_at desc);

create index if not exists idx_song_analyses_title_artist
  on public.song_analyses (title, artist);

create index if not exists idx_song_revisions_video_version
  on public.song_revisions (youtube_video_id, version desc);

create index if not exists idx_song_reports_video_id
  on public.song_reports (youtube_video_id, created_at desc);

create or replace function public.set_song_analyses_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_song_analyses_updated_at on public.song_analyses;
create trigger trg_song_analyses_updated_at
before update on public.song_analyses
for each row
execute function public.set_song_analyses_updated_at();

create or replace function public.guard_song_analyses_public_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.youtube_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'Invalid YouTube video ID';
  end if;

  if jsonb_typeof(new.lines_json) <> 'array'
     or jsonb_array_length(new.lines_json) < 1
     or jsonb_array_length(new.lines_json) > 800
     or octet_length(new.lines_json::text) >= 250000 then
    raise exception 'Invalid lines_json payload';
  end if;

  if length(coalesce(new.title, '')) > 200
     or length(coalesce(new.artist, '')) > 200
     or length(coalesce(new.author_name, '')) > 64
     or length(coalesce(new.edit_note, '')) > 200 then
    raise exception 'Metadata field too long';
  end if;

  if new.artwork_url is not null
     and new.artwork_url <> ''
     and new.artwork_url !~ '^https?://' then
    raise exception 'Invalid artwork URL';
  end if;

  if TG_OP = 'INSERT' then
    new.status := case when new.status = 'auto' then 'auto' else 'edited' end;
    new.locked := false;
    new.hidden := false;
    new.upvotes := 1;
    new.report_count := 0;
    -- Preserve EXCLUDED.revision_count only when ON CONFLICT DO UPDATE will follow
    if not exists (
      select 1 from public.song_analyses s
      where s.youtube_video_id = new.youtube_video_id
    ) then
      new.revision_count := 1;
    end if;
    return new;
  end if;

  if new.locked is distinct from old.locked then
    raise exception 'Cannot modify locked state';
  end if;

  if new.status = 'verified' and old.status is distinct from 'verified' then
    raise exception 'Cannot self-verify song';
  end if;
  if old.status = 'verified' then
    new.status := 'verified';
  end if;
  if new.status not in ('auto', 'edited', 'verified') then
    raise exception 'Invalid status';
  end if;

  if new.upvotes is distinct from old.upvotes then
    if new.upvotes < 0 or abs(new.upvotes - old.upvotes) > 1 then
      raise exception 'Invalid upvote change';
    end if;
  end if;

  if new.report_count is distinct from old.report_count then
    if new.report_count <> old.report_count + 1 then
      raise exception 'Invalid report_count increment';
    end if;
  end if;

  if old.hidden = true and new.hidden = false then
    raise exception 'Cannot unhide moderated song';
  end if;
  if old.hidden = false and new.hidden = true then
    if old.locked or old.status = 'verified' or new.report_count < 3 or new.report_count <> old.report_count + 1 then
      raise exception 'Cannot hide song directly';
    end if;
  end if;

  if new.revision_count is distinct from old.revision_count then
    if new.revision_count <> old.revision_count + 1 then
      raise exception 'Invalid revision_count increment';
    end if;
  end if;

  if old.locked = true and (
    new.lines_json is distinct from old.lines_json
    or new.lyrics_hash is distinct from old.lyrics_hash
    or new.title is distinct from old.title
    or new.artist is distinct from old.artist
    or new.duration is distinct from old.duration
    or new.artwork_url is distinct from old.artwork_url
    or new.mr_youtube_id is distinct from old.mr_youtube_id
    or new.mr_sync_offset is distinct from old.mr_sync_offset
    or new.karaoke_youtube_id is distinct from old.karaoke_youtube_id
    or new.karaoke_sync_offset is distinct from old.karaoke_sync_offset
    or new.active_revision_id is distinct from old.active_revision_id
    or new.author_name is distinct from old.author_name
    or new.edit_note is distinct from old.edit_note
  ) then
    raise exception 'Song is locked and cannot be overwritten directly';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_song_analyses_public_write on public.song_analyses;
create trigger trg_guard_song_analyses_public_write
before insert or update on public.song_analyses
for each row
execute function public.guard_song_analyses_public_write();

alter table public.song_analyses enable row level security;
alter table public.song_revisions enable row level security;
alter table public.song_reports enable row level security;

drop policy if exists "Public read song_analyses" on public.song_analyses;
create policy "Public read song_analyses"
  on public.song_analyses
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public insert song_analyses" on public.song_analyses;
create policy "Public insert song_analyses"
  on public.song_analyses
  for insert
  to anon, authenticated
  with check (
    youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    and jsonb_typeof(lines_json) = 'array'
    and jsonb_array_length(lines_json) between 1 and 800
    and octet_length(lines_json::text) < 250000
  );

drop policy if exists "Public update song_analyses" on public.song_analyses;
create policy "Public update song_analyses"
  on public.song_analyses
  for update
  to anon, authenticated
  using (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$')
  with check (
    youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    and jsonb_typeof(lines_json) = 'array'
    and jsonb_array_length(lines_json) between 1 and 800
    and octet_length(lines_json::text) < 250000
  );

drop policy if exists "Public read song_revisions" on public.song_revisions;
create policy "Public read song_revisions"
  on public.song_revisions
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public insert song_revisions" on public.song_revisions;
create policy "Public insert song_revisions"
  on public.song_revisions
  for insert
  to anon, authenticated
  with check (
    youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    and status in ('auto', 'edited')
    and jsonb_typeof(lines_json) = 'array'
    and jsonb_array_length(lines_json) between 1 and 800
    and octet_length(lines_json::text) < 250000
    and length(coalesce(author_name, '')) <= 64
    and length(coalesce(edit_note, '')) <= 200
  );

drop policy if exists "Public insert song_reports" on public.song_reports;
create policy "Public insert song_reports"
  on public.song_reports
  for insert
  to anon, authenticated
  with check (
    youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'
    and reason in ('sync', 'pronunciation', 'lyrics', 'other')
    and length(coalesce(note, '')) <= 200
  );

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.song_analyses to anon, authenticated;
grant select, insert on public.song_revisions to anon, authenticated;
grant insert on public.song_reports to anon, authenticated;

-- Private salted-bcrypt admin credential store (overridable by LYRIKO_ADMIN_KEY Edge Function secret)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.lyriko_admin_credentials (
  id text primary key,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

alter table private.lyriko_admin_credentials enable row level security;
revoke all on table private.lyriko_admin_credentials from public, anon, authenticated;
grant select, insert, update on table private.lyriko_admin_credentials to service_role;

drop policy if exists "Service role manages admin credentials" on private.lyriko_admin_credentials;
create policy "Service role manages admin credentials"
  on private.lyriko_admin_credentials
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.verify_lyriko_admin_key(candidate text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  stored_hash text;
begin
  if candidate is null or length(trim(candidate)) = 0 then
    return false;
  end if;
  select password_hash into stored_hash
  from private.lyriko_admin_credentials
  where id = 'default';
  if stored_hash is null then
    return false;
  end if;
  return stored_hash = extensions.crypt(trim(candidate), stored_hash);
end;
$$;

revoke all on function public.verify_lyriko_admin_key(text) from public, anon, authenticated;
grant execute on function public.verify_lyriko_admin_key(text) to service_role;

create or replace function public.set_lyriko_admin_key(new_key text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  clean text := trim(coalesce(new_key, ''));
begin
  if length(clean) < 4 or length(clean) > 128 then
    raise exception 'Admin key must be between 4 and 128 characters';
  end if;
  insert into private.lyriko_admin_credentials (id, password_hash, updated_at)
  values ('default', extensions.crypt(clean, extensions.gen_salt('bf', 10)), now())
  on conflict (id) do update
    set password_hash = excluded.password_hash,
        updated_at = now();
end;
$$;

revoke all on function public.set_lyriko_admin_key(text) from public, anon, authenticated;
grant execute on function public.set_lyriko_admin_key(text) to service_role;
