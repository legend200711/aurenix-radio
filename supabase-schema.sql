-- ============================================================
-- AURENIX — Supabase Schema
-- supabase-schema.sql
--
-- Replaces all Firebase Firestore collections and RTDB paths
-- used across live.js, live-hub.html, cloud-stream.js, and
-- aurenix-radio.js.
--
-- Run this in your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- Supabase org: tzypauptizcsokgckpts
-- ============================================================

-- Enable the Realtime publication (required for real-time subscriptions)
-- Supabase enables this by default; the ALTER statements below
-- add specific tables to the publication.

-- ──────────────────────────────────────────────────────────
-- 1. USERS (profiles)
--    Mirrors Firestore `users/{uid}` docs.
--    Uses auth.uid() as the primary key so Supabase Auth rows
--    and profile rows are always in sync.
-- ──────────────────────────────────────────────────────────
create table if not exists users (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text    not null default '',
  display_name_lower text   not null default '',
  username          text    not null default '',
  email             text    not null default '',
  avatar            text    not null default '',
  bio               text    not null default '',
  role              text    not null default 'member', -- 'member' | 'moderator' | 'administrator' | 'founder'
  followers         uuid[]  not null default '{}',
  following         uuid[]  not null default '{}',
  follower_count    integer not null default 0,
  following_count   integer not null default 0,
  is_live           boolean not null default false,
  live_room_id      text,
  push_queue        jsonb   not null default '[]',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table users enable row level security;

create policy "Users can read all profiles"
  on users for select using (true);

create policy "Users can update their own profile"
  on users for update using (auth.uid() = id);

create policy "Users can insert their own profile"
  on users for insert with check (auth.uid() = id);

-- ──────────────────────────────────────────────────────────
-- 2. SITE SETTINGS
--    Mirrors Firestore `siteSettings/{doc}` docs.
-- ──────────────────────────────────────────────────────────
create table if not exists site_settings (
  id               text primary key,  -- e.g. 'config', 'features'
  live_enabled     boolean not null default true,
  live_hub_enabled boolean not null default true,
  data             jsonb   not null default '{}'
);

-- Only founders/admins write; everyone can read
alter table site_settings enable row level security;

create policy "Anyone can read site settings"
  on site_settings for select using (true);

create policy "Admins can write site settings"
  on site_settings for all using (
    exists (
      select 1 from users
      where id = auth.uid()
      and role in ('founder', 'administrator')
    )
  );

-- Insert default rows
insert into site_settings (id, live_enabled, live_hub_enabled)
values ('config', true, true), ('features', true, true)
on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────
-- 3. LIVE ROOMS
--    Replaces Firestore `liveRooms/{uid}` docs +
--    RTDB `liveRooms/{roomId}` nodes.
--    One row per active broadcast; row deleted / status='ended'
--    when the stream ends.
-- ──────────────────────────────────────────────────────────
create table if not exists live_rooms (
  id            text    primary key,  -- composite key: safeUid_timestamp36
  host_id       uuid    not null references auth.users(id) on delete cascade,
  host_name     text    not null default '',
  host_username text    not null default '',
  host_avatar   text    not null default '',
  title         text    not null default '',
  status        text    not null default 'live', -- 'live' | 'ended'
  is_live       boolean not null default true,
  viewers       integer not null default 0,
  likes         integer not null default 0,
  type          text    not null default 'live', -- 'live' | '24hour_cloudstream'
  cloud_stream_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  ended_at      timestamptz
);

alter table live_rooms enable row level security;

create policy "Anyone can read live rooms"
  on live_rooms for select using (true);

create policy "Hosts can insert their own room"
  on live_rooms for insert with check (auth.uid() = host_id);

create policy "Hosts can update their own room"
  on live_rooms for update using (auth.uid() = host_id);

create policy "Hosts can delete their own room"
  on live_rooms for delete using (auth.uid() = host_id);

-- Real-time: subscribe to INSERT/UPDATE/DELETE on live_rooms
alter publication supabase_realtime add table live_rooms;

-- ──────────────────────────────────────────────────────────
-- 4. LIVE MESSAGES (chat)
--    Replaces Firestore `liveRooms/{roomId}/liveMessages`
-- ──────────────────────────────────────────────────────────
create table if not exists live_messages (
  id          bigint  generated always as identity primary key,
  room_id     text    not null references live_rooms(id) on delete cascade,
  user_id     uuid    not null references auth.users(id) on delete cascade,
  user_name   text    not null default '',
  text        text    not null,
  type        text    not null default 'chat', -- 'chat' | 'system'
  created_at  timestamptz not null default now()
);

alter table live_messages enable row level security;

create policy "Anyone can read live messages"
  on live_messages for select using (true);

create policy "Authenticated users can insert messages"
  on live_messages for insert with check (auth.uid() = user_id);

-- Index for fast time-ordered queries per room
create index if not exists live_messages_room_created
  on live_messages (room_id, created_at asc);

alter publication supabase_realtime add table live_messages;

-- ──────────────────────────────────────────────────────────
-- 5. STORIES
--    Replaces Firestore `stories/{live_<uid>}` docs.
-- ──────────────────────────────────────────────────────────
create table if not exists stories (
  id            text    primary key,  -- 'live_<uid>'
  uid           uuid    not null references auth.users(id) on delete cascade,
  author_name   text    not null default '',
  author_handle text    not null default '',
  author_avatar text    not null default '',
  type          text    not null default 'live',
  live_room_id  text,
  title         text    not null default '',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

alter table stories enable row level security;

create policy "Anyone can read stories"
  on stories for select using (true);

create policy "Users can manage their own stories"
  on stories for all using (auth.uid() = uid);

-- ──────────────────────────────────────────────────────────
-- 6. NOTIFICATIONS
--    Replaces Firestore `notifications/{uid}/items` sub-collection.
-- ──────────────────────────────────────────────────────────
create table if not exists notifications (
  id            bigint  generated always as identity primary key,
  recipient_id  uuid    not null references auth.users(id) on delete cascade,
  type          text    not null,  -- 'live' | 'follow' | etc.
  from_uid      uuid,
  from_name     text    not null default '',
  from_avatar   text    not null default '',
  room_id       text,
  room_title    text    not null default '',
  title         text    not null default '',
  body          text    not null default '',
  url           text    not null default '',
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table notifications enable row level security;

create policy "Users can read their own notifications"
  on notifications for select using (auth.uid() = recipient_id);

create policy "Authenticated users can insert notifications"
  on notifications for insert with check (auth.uid() = from_uid);

create policy "Users can update their own notifications (mark read)"
  on notifications for update using (auth.uid() = recipient_id);

-- ──────────────────────────────────────────────────────────
-- 7. CLOUD STREAMS (24H Cloud Stream)
--    Replaces Firestore `cloudStreams/{streamId}` docs.
-- ──────────────────────────────────────────────────────────
create table if not exists cloud_streams (
  id                text    primary key,  -- uid_timestamp
  uid               uuid    not null references auth.users(id) on delete cascade,
  display_name      text    not null default '',
  stream_name       text    not null default '',
  description       text    not null default '',
  category          text    not null default 'Music',
  theme             text    not null default 'shadow-nexus',
  duration_minutes  integer not null default 1440,
  status            text    not null default 'starting', -- 'starting'|'active'|'recovering'|'stopping'|'stopped'|'failed'|'ended'
  viewer_count      integer not null default 0,
  cover_art         text    not null default '',
  music_playlist_id text    not null default '',
  worker_status     text    not null default 'pending',
  last_heartbeat    timestamptz,
  started_at        timestamptz,
  expires_at        timestamptz,
  stopped_at        timestamptz,
  created_at        timestamptz not null default now()
);

alter table cloud_streams enable row level security;

create policy "Anyone can read active cloud streams"
  on cloud_streams for select using (true);

create policy "Owners can manage their cloud streams"
  on cloud_streams for all using (auth.uid() = uid);

-- ──────────────────────────────────────────────────────────
-- 8. CLOUD STREAM NOW PLAYING
--    Written by the CloudStream Worker (service-role key) via REST UPSERT.
--    stream_id is the unique key — matches cloud_streams.id.
-- ──────────────────────────────────────────────────────────
create table if not exists cloud_stream_now_playing (
  stream_id           text    primary key references cloud_streams(id) on delete cascade,
  user_id             uuid    references auth.users(id) on delete cascade,
  current_track_id    text    default null,
  current_title       text    not null default '',
  current_artist      text    not null default '',
  current_track_url   text    not null default '',
  current_duration    integer not null default 0,
  next_track_id       text    default null,
  next_title          text    not null default '',
  next_artist         text    not null default '',
  queue_index         integer not null default 0,
  status              text    not null default 'playing', -- 'playing'|'paused'|'ended'
  updated_at          timestamptz not null default now()
);

alter table cloud_stream_now_playing enable row level security;

create policy "Anyone can read now playing"
  on cloud_stream_now_playing for select using (true);

-- Service-role key bypasses RLS; this policy covers browser writes (none expected)
create policy "Owner can write now playing"
  on cloud_stream_now_playing for all using (auth.uid() = user_id);

alter publication supabase_realtime add table cloud_stream_now_playing;

-- ──────────────────────────────────────────────────────────
-- 9. RADIO QUEUE (AURENIX Radio)
--    New table — replaces local in-memory state in aurenix-radio.js.
-- ──────────────────────────────────────────────────────────
create table if not exists radio_queue (
  id            bigint  generated always as identity primary key,
  title         text    not null,
  artist        text    not null default '',
  type          text    not null default 'upload', -- 'upload'|'youtube'|'url'
  url           text    not null default '',
  notes         text    not null default '',
  status        text    not null default 'pending', -- 'pending'|'approved'|'playing'|'rejected'
  submitted_by  uuid    references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

alter table radio_queue enable row level security;

create policy "Anyone can read the radio queue"
  on radio_queue for select using (true);

create policy "Anyone can submit to the radio queue"
  on radio_queue for insert with check (true);

create policy "Moderators and founders can update queue status"
  on radio_queue for update using (
    exists (
      select 1 from users
      where id = auth.uid()
      and role in ('founder', 'administrator', 'moderator')
    )
  );

alter publication supabase_realtime add table radio_queue;

-- ──────────────────────────────────────────────────────────
-- 10. BOX REQUESTS (viewer-to-host guest box requests)
--     Replaces Firestore `boxRequests/{roomId}_{uid}` docs.
-- ──────────────────────────────────────────────────────────
create table if not exists box_requests (
  id          text    primary key,  -- '{roomId}_{viewerUid}'
  room_id     text    not null,
  viewer_uid  uuid    not null references auth.users(id) on delete cascade,
  viewer_name text    not null default '',
  status      text    not null default 'pending', -- 'pending'|'accepted'|'declined'
  created_at  timestamptz not null default now()
);

alter table box_requests enable row level security;

create policy "Hosts and requesters can read box requests"
  on box_requests for select using (
    auth.uid() = viewer_uid
    or exists (
      select 1 from live_rooms lr
      where lr.id = room_id and lr.host_id = auth.uid()
    )
  );

create policy "Authenticated viewers can insert box requests"
  on box_requests for insert with check (auth.uid() = viewer_uid);

create policy "Hosts can update box request status"
  on box_requests for update using (
    exists (
      select 1 from live_rooms lr
      where lr.id = room_id and lr.host_id = auth.uid()
    )
  );

create policy "Users can delete their own box requests"
  on box_requests for delete using (auth.uid() = viewer_uid);

alter publication supabase_realtime add table box_requests;

-- ──────────────────────────────────────────────────────────
-- 11. POSTS (feed posts — used for live share posts)
-- ──────────────────────────────────────────────────────────
create table if not exists posts (
  id            bigint  generated always as identity primary key,
  type          text    not null default 'post', -- 'post'|'live'|'live_share'
  uid           uuid    not null references auth.users(id) on delete cascade,
  author_name   text    not null default '',
  author_handle text    not null default '',
  author_avatar text    not null default '',
  live_room_id  text,
  is_live       boolean not null default false,
  title         text    not null default '',
  text          text    not null default '',
  likes         integer not null default 0,
  created_at    timestamptz not null default now()
);

alter table posts enable row level security;

create policy "Anyone can read posts"
  on posts for select using (true);

create policy "Authenticated users can create posts"
  on posts for insert with check (auth.uid() = uid);

create policy "Authors can update their posts"
  on posts for update using (auth.uid() = uid);

create policy "Authors can delete their posts"
  on posts for delete using (auth.uid() = uid);

-- ──────────────────────────────────────────────────────────
-- 12. STUDIO PLAYLISTS (replaces Firestore `studioPlaylists/{uid}/playlists/{plId}`)
-- ──────────────────────────────────────────────────────────
create table if not exists studio_playlists (
  id          text    primary key default gen_random_uuid()::text,
  uid         uuid    not null references auth.users(id) on delete cascade,
  name        text    not null default 'Untitled Playlist',
  track_ids   text[]  not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table studio_playlists enable row level security;

create policy "Users can read their own playlists"
  on studio_playlists for select using (auth.uid() = uid);

create policy "Users can manage their own playlists"
  on studio_playlists for all using (auth.uid() = uid);

-- ──────────────────────────────────────────────────────────
-- 13. CLOUD STREAM TRACKS (replaces Firestore `cloudStreamTracks/{uid}/tracks/{trackId}`)
-- ──────────────────────────────────────────────────────────
create table if not exists cloud_stream_tracks (
  id           text    primary key default gen_random_uuid()::text,
  uid          uuid    not null references auth.users(id) on delete cascade,
  title        text    not null default 'Untitled',
  artist       text    not null default '',
  url          text    not null default '',
  duration     integer not null default 0,  -- seconds
  status       text    not null default 'ready',
  created_at   timestamptz not null default now()
);

alter table cloud_stream_tracks enable row level security;

create policy "Users can read their own tracks"
  on cloud_stream_tracks for select using (auth.uid() = uid);

create policy "Users can manage their own tracks"
  on cloud_stream_tracks for all using (auth.uid() = uid);

-- ──────────────────────────────────────────────────────────
-- 14. CLOUD STREAM HISTORY
--     Written by the CloudStream Worker when a broadcast ends.
--     Replaces Firestore `cloudStreamHistory/{histId}` collection.
-- ──────────────────────────────────────────────────────────
create table if not exists cloud_stream_history (
  history_id      text        primary key,   -- '{streamId}_{timestamp}'
  stream_id       text        not null,
  user_id         uuid        references auth.users(id) on delete set null,
  display_name    text        not null default '',
  stream_name     text        not null default '',
  description     text        not null default '',
  category        text        not null default '',
  started_at      timestamptz,
  stopped_at      timestamptz,
  duration_secs   integer     not null default 0,
  peak_listeners  integer     not null default 0,
  final_status    text        not null default 'stopped',
  stop_reason     text        not null default 'unknown',
  created_at      timestamptz not null default now()
);

alter table cloud_stream_history enable row level security;

create policy "Users can read their own broadcast history"
  on cloud_stream_history for select using (auth.uid() = user_id);

create policy "Founders can read all broadcast history"
  on cloud_stream_history for select using (
    exists (
      select 1 from users where id = auth.uid() and role = 'founder'
    )
  );

-- Service-role key (used by the Worker) bypasses RLS for INSERT — no browser insert policy needed.
