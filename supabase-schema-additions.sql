-- ============================================================
-- AURENIX — Additional Schema Additions
-- supabase-schema-additions.sql
--
-- Run AFTER supabase-schema.sql
-- Adds: community_posts, post_comments, media_items, media_comments
-- Plus: Supabase RPCs, Storage buckets guidance, and admin RLS
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. COMMUNITY POSTS
-- ──────────────────────────────────────────────────────────
create table if not exists community_posts (
  id            bigint  generated always as identity primary key,
  uid           uuid    not null references auth.users(id) on delete cascade,
  author_name   text    not null default '',
  author_handle text    not null default '',
  author_avatar text    not null default '',
  text          text    not null,
  likes         integer not null default 0,
  comment_count integer not null default 0,
  created_at    timestamptz not null default now()
);

alter table community_posts enable row level security;

create policy "Anyone can read posts"
  on community_posts for select using (true);

create policy "Authenticated users can create posts"
  on community_posts for insert with check (auth.uid() = uid);

create policy "Authors can update their own posts"
  on community_posts for update using (auth.uid() = uid);

create policy "Authors can delete their own posts"
  on community_posts for delete using (auth.uid() = uid);

alter publication supabase_realtime add table community_posts;

-- ──────────────────────────────────────────────────────────
-- 2. POST COMMENTS
-- ──────────────────────────────────────────────────────────
create table if not exists post_comments (
  id        bigint  generated always as identity primary key,
  post_id   bigint  not null references community_posts(id) on delete cascade,
  user_id   uuid    not null references auth.users(id) on delete cascade,
  user_name text    not null default '',
  text      text    not null,
  created_at timestamptz not null default now()
);

alter table post_comments enable row level security;

create policy "Anyone can read post comments"
  on post_comments for select using (true);

create policy "Authenticated users can insert post comments"
  on post_comments for insert with check (auth.uid() = user_id);

create policy "Authors can delete their own comments"
  on post_comments for delete using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 3. MEDIA ITEMS
-- ──────────────────────────────────────────────────────────
create table if not exists media_items (
  id            bigint  generated always as identity primary key,
  creator_id    uuid    not null references auth.users(id) on delete cascade,
  creator_name  text    not null default '',
  title         text    not null,
  description   text    not null default '',
  type          text    not null default 'video',  -- 'video' | 'audio'
  media_url     text    not null default '',
  thumbnail_url text    not null default '',
  status        text    not null default 'approved', -- 'approved' | 'pending' | 'removed'
  views         integer not null default 0,
  likes         integer not null default 0,
  created_at    timestamptz not null default now()
);

alter table media_items enable row level security;

create policy "Anyone can read approved media"
  on media_items for select using (status = 'approved' or auth.uid() = creator_id);

create policy "Authenticated users can insert media"
  on media_items for insert with check (auth.uid() = creator_id);

create policy "Admins can update media status"
  on media_items for update using (
    auth.uid() = creator_id
    or exists (
      select 1 from users
      where id = auth.uid()
      and role in ('founder', 'administrator', 'moderator')
    )
  );

-- ──────────────────────────────────────────────────────────
-- 4. MEDIA COMMENTS
-- ──────────────────────────────────────────────────────────
create table if not exists media_comments (
  id        bigint  generated always as identity primary key,
  media_id  bigint  not null references media_items(id) on delete cascade,
  user_id   uuid    not null references auth.users(id) on delete cascade,
  user_name text    not null default '',
  text      text    not null,
  created_at timestamptz not null default now()
);

alter table media_comments enable row level security;

create policy "Anyone can read media comments"
  on media_comments for select using (true);

create policy "Authenticated users can insert media comments"
  on media_comments for insert with check (auth.uid() = user_id);

create policy "Authors can delete their own media comments"
  on media_comments for delete using (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 5. RPCs (helper functions for atomic increments)
-- ──────────────────────────────────────────────────────────

-- Increment media views
create or replace function increment_media_views(item_id bigint)
returns void language plpgsql security definer as $$
begin
  update media_items set views = views + 1 where id = item_id;
end;
$$;

-- Increment post comment count
create or replace function increment_post_comments(post_id bigint)
returns void language plpgsql security definer as $$
begin
  update community_posts set comment_count = comment_count + 1 where id = post_id;
end;
$$;

-- Increment follower count (called when a user follows another)
create or replace function increment_follower_count(target_uid uuid)
returns void language plpgsql security definer as $$
begin
  update users set follower_count = follower_count + 1 where id = target_uid;
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 6. STORAGE BUCKETS
--
-- Create these in Supabase Dashboard → Storage:
--
--   Bucket name:  aurenix-media
--   Public:       true
--   File size limit: 200 MB
--   Allowed MIME types: video/*, audio/*, image/*
--
--   Bucket name:  aurenix-radio
--   Public:       true
--   File size limit: 50 MB
--   Allowed MIME types: audio/*
--
-- RLS policies for storage (run in SQL editor):
-- ──────────────────────────────────────────────────────────

-- aurenix-media bucket: authenticated users can upload to their own folder
create policy "Authenticated users can upload media"
  on storage.objects for insert
  with check (
    bucket_id = 'aurenix-media'
    and auth.uid() is not null
    and (storage.foldername(name))[1] in ('media', 'thumbs')
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "Anyone can view media files"
  on storage.objects for select
  using (bucket_id = 'aurenix-media');

-- aurenix-radio bucket: authenticated users can upload to their own folder
create policy "Authenticated users can upload radio files"
  on storage.objects for insert
  with check (
    bucket_id = 'aurenix-radio'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = 'radio'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "Anyone can listen to radio files"
  on storage.objects for select
  using (bucket_id = 'aurenix-radio');

-- ──────────────────────────────────────────────────────────
-- 7. ADMIN ROLE ENFORCEMENT
--
-- The only AURENIX administrator is christijerina46@gmail.com.
-- This function can be called to verify admin status server-side.
-- ──────────────────────────────────────────────────────────

create or replace function is_admin()
returns boolean language plpgsql security definer as $$
declare
  v_email text;
begin
  select email into v_email
  from auth.users
  where id = auth.uid();
  return v_email = 'christijerina46@gmail.com';
end;
$$;

-- Use is_admin() in policies where needed, e.g.:
-- create policy "Admin can do anything to radio_queue"
--   on radio_queue for all using (is_admin());

-- ──────────────────────────────────────────────────────────
-- 8. REALTIME ADDITIONS
-- ──────────────────────────────────────────────────────────
alter publication supabase_realtime add table community_posts;
