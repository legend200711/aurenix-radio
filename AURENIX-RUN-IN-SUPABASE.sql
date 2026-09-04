-- ============================================================
-- AURENIX — Run this ONCE in Supabase SQL Editor
-- 
-- How to run:
--   1. Go to https://supabase.com/dashboard
--   2. Click your project
--   3. Left sidebar → SQL Editor
--   4. Click "+ New query"
--   5. Paste this entire file
--   6. Click "Run"
-- ============================================================

-- ── studio_queue: add missing columns ──────────────────────
-- First ensure uid PK has a default so inserts without explicit uid work
alter table studio_queue alter column uid set default gen_random_uuid();

alter table studio_queue
  add column if not exists title        text not null default '',
  add column if not exists artist       text not null default '',
  add column if not exists album        text,
  add column if not exists genre        text,
  add column if not exists artwork_url  text,
  add column if not exists type         text not null default 'upload',
  add column if not exists url          text not null default '',
  add column if not exists notes        text not null default '',
  add column if not exists status       text not null default 'pending',
  add column if not exists play_count   integer not null default 0,
  add column if not exists likes        integer not null default 0,
  add column if not exists submitted_by uuid references auth.users(id) on delete set null,
  add column if not exists created_at   timestamptz not null default now();

-- ── radio_plays: play tracking table (new) ─────────────────
create table if not exists radio_plays (
  id         bigint generated always as identity primary key,
  track_uid  uuid not null references studio_queue(uid) on delete cascade,
  session_id text not null,
  user_uid   uuid references auth.users(id) on delete set null,
  played_at  timestamptz not null default now()
);
alter table radio_plays enable row level security;
-- Only admins can read play analytics; anyone can insert (fire-and-forget)
create policy "Admins can read radio plays" on radio_plays for select using (
  exists (select 1 from users where uid = auth.uid() and role in ('founder','administrator'))
);
create policy "Anyone can record a play" on radio_plays for insert with check (true);

-- ── community: add missing columns ─────────────────────────
alter table community
  add column if not exists uid           uuid references auth.users(id) on delete cascade,
  add column if not exists author_name   text not null default '',
  add column if not exists author_handle text not null default '',
  add column if not exists author_avatar text not null default '',
  add column if not exists text          text not null default '',
  add column if not exists likes         integer not null default 0,
  add column if not exists comment_count integer not null default 0,
  add column if not exists created_at    timestamptz not null default now();

-- ── media_files: add missing columns ───────────────────────
alter table media_files
  add column if not exists title         text not null default '',
  add column if not exists description   text not null default '',
  add column if not exists thumbnail_url text not null default '',
  add column if not exists creator_name  text not null default '',
  add column if not exists status        text not null default 'approved',
  add column if not exists views         integer not null default 0,
  add column if not exists likes         integer not null default 0,
  add column if not exists created_at    timestamptz not null default now();

-- ── notifications: add missing columns ─────────────────────
alter table notifications
  add column if not exists title      text not null default '',
  add column if not exists body       text not null default '',
  add column if not exists created_at timestamptz not null default now();

-- ── users: add missing columns ─────────────────────────────
-- Note: followers/following are already jsonb[] arrays in the real schema.
-- We only add columns that don't exist yet.
alter table users
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists banner      text not null default '';

-- ── post_comments table (new) ──────────────────────────────
create table if not exists post_comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references community(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  user_name  text   not null default '',
  text       text   not null,
  created_at timestamptz not null default now()
);
alter table post_comments enable row level security;
create policy "Anyone can read post comments"   on post_comments for select using (true);
create policy "Authed users can post comments"  on post_comments for insert with check (auth.uid() = user_id);
create policy "Authors can delete own comments" on post_comments for delete using (auth.uid() = user_id);

-- ── media_comments table (new) ─────────────────────────────
create table if not exists media_comments (
  id         bigint generated always as identity primary key,
  media_id   bigint not null references media_files(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  user_name  text   not null default '',
  text       text   not null,
  created_at timestamptz not null default now()
);
alter table media_comments enable row level security;
create policy "Anyone can read media comments"   on media_comments for select using (true);
create policy "Authed users can add media comments" on media_comments for insert with check (auth.uid() = user_id);
create policy "Authors can delete own media comments" on media_comments for delete using (auth.uid() = user_id);

-- ── RLS policies (safe to run even if already exist) ───────
-- studio_queue
alter table studio_queue enable row level security;
drop policy if exists "Anyone can read radio queue"           on studio_queue;
drop policy if exists "Anyone can submit to radio queue"      on studio_queue;
drop policy if exists "Moderators can update queue status"    on studio_queue;
create policy "Anyone can read radio queue"        on studio_queue for select using (true);
create policy "Anyone can submit to radio queue"   on studio_queue for insert with check (true);
create policy "Moderators can update queue status" on studio_queue for update using (
  exists (select 1 from users where uid = auth.uid() and role in ('founder','administrator','moderator'))
);

-- community
alter table community enable row level security;
drop policy if exists "Anyone can read posts"    on community;
drop policy if exists "Authed users can post"    on community;
drop policy if exists "Authors can update posts" on community;
drop policy if exists "Authors can delete posts" on community;
create policy "Anyone can read posts"    on community for select using (true);
create policy "Authed users can post"    on community for insert with check (auth.uid() = uid);
create policy "Authors can update posts" on community for update using (auth.uid() = uid);
create policy "Authors can delete posts" on community for delete using (auth.uid() = uid);

-- media_files
alter table media_files enable row level security;
drop policy if exists "Anyone can read approved media" on media_files;
drop policy if exists "Authed users can upload media"  on media_files;
drop policy if exists "Admins can moderate media"      on media_files;
create policy "Anyone can read approved media" on media_files for select using (status = 'approved' or auth.uid() = owner_uid);
create policy "Authed users can upload media"  on media_files for insert with check (auth.uid() = owner_uid);
create policy "Admins can moderate media"      on media_files for update using (
  auth.uid() = owner_uid or
  exists (select 1 from users where uid = auth.uid() and role in ('founder','administrator','moderator'))
);

-- ── Realtime ───────────────────────────────────────────────
alter publication supabase_realtime add table studio_queue;
alter publication supabase_realtime add table community;

-- ── Helper RPCs ────────────────────────────────────────────
create or replace function increment_media_views(item_id bigint)
returns void language plpgsql security definer as $$
begin update media_files set views = views + 1 where id = item_id; end; $$;

create or replace function increment_post_comments(post_id bigint)
returns void language plpgsql security definer as $$
begin update community set comment_count = comment_count + 1 where id = post_id; end; $$;

create or replace function increment_radio_play_count(track_uid uuid)
returns void language plpgsql security definer as $$
begin update studio_queue set play_count = play_count + 1 where uid = track_uid; end; $$;

-- Done! All tables are ready.
select 'AURENIX schema ready' as status;
