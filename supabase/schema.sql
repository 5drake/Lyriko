-- UtaKana Studio: Shared Karaoke Analysis Cache & Revision Schema for Supabase (PostgreSQL)
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

create index if not exists idx_song_analyses_video_id
  on public.song_analyses (youtube_video_id);

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
    octet_length(lines_json::text) < 250000
    and length(youtube_video_id) between 6 and 32
  );

drop policy if exists "Public update song_analyses" on public.song_analyses;
create policy "Public update song_analyses"
  on public.song_analyses
  for update
  to anon, authenticated
  using (true)
  with check (
    octet_length(lines_json::text) < 250000
    and length(youtube_video_id) between 6 and 32
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
    octet_length(lines_json::text) < 250000
    and length(youtube_video_id) between 6 and 32
  );

drop policy if exists "Public insert song_reports" on public.song_reports;
create policy "Public insert song_reports"
  on public.song_reports
  for insert
  to anon, authenticated
  with check (
    length(youtube_video_id) between 6 and 32
    and length(note) <= 200
  );
