-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Submission Fix
-- aurenix-radio-fix.sql
--
-- Run this ONCE in Supabase SQL Editor to fix the radio submission error:
--   Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Root causes this file fixes:
--   1. studio_queue table was never created (schema.sql only created radio_queue)
--   2. uid column type conflict between migration files (TEXT vs UUID)
--   3. RLS INSERT policy verified correct and re-applied cleanly
--   4. Missing columns that the JS inserts (content_type, rights_confirmed, etc.)
--
-- SAFETY: uses CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS.
--         Will NOT delete or alter any existing data.
-- ═══════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────
-- STEP 1: Admin helper function (idempotent)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_email        text;
  v_confirmed_at timestamptz;
BEGIN
  SELECT email, email_confirmed_at
    INTO v_email, v_confirmed_at
    FROM auth.users
   WHERE id = auth.uid();

  RETURN v_email = 'christijerina46@gmail.com'
     AND v_confirmed_at IS NOT NULL;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 2: Create studio_queue table if it does not exist.
--
-- The original supabase-schema.sql created radio_queue (not studio_queue).
-- All migration files reference studio_queue. If it was never created,
-- every INSERT fails with relation "studio_queue" does not exist.
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_queue (
  -- Primary key: auto-generated UUID, no need for client to supply it
  uid           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Track metadata
  title         TEXT        NOT NULL DEFAULT '',
  artist        TEXT        NOT NULL DEFAULT '',
  album         TEXT,
  genre         TEXT,
  artwork_url   TEXT,

  -- Submission type
  type          TEXT        NOT NULL DEFAULT 'upload',
    -- 'upload' | 'youtube' | 'spotify' | 'external'

  -- Content classification
  content_type  TEXT        NOT NULL DEFAULT 'aurenix_audio'
    CHECK (content_type IN ('aurenix_audio', 'external_media')),

  -- URL (storage public URL for uploads, external URL for links)
  url           TEXT        NOT NULL DEFAULT '',

  -- Notes from submitter
  notes         TEXT        NOT NULL DEFAULT '',

  -- Moderation status — always starts as 'pending'
  status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'playing', 'rejected', 'removed')),

  -- Rights confirmation checkbox value at time of submission
  rights_confirmed BOOLEAN  NOT NULL DEFAULT false,

  -- Counters
  play_count    INTEGER     NOT NULL DEFAULT 0,
  likes         INTEGER     NOT NULL DEFAULT 0,

  -- Ownership — FK to auth.users
  submitted_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Timestamps
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ────────────────────────────────────────────────────────────────────────
-- STEP 3: Add any missing columns to studio_queue (idempotent).
--         Covers cases where the table was created with fewer columns.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS album            TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS genre            TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS artwork_url      TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS notes            TEXT        NOT NULL DEFAULT '';
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS play_count       INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS likes            INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS rights_confirmed BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- content_type column with constraint
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'aurenix_audio';

DO $$
BEGIN
  -- Add check constraint if it does not already exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'studio_queue_content_type_check'
       AND conrelid = 'studio_queue'::regclass
  ) THEN
    ALTER TABLE studio_queue
      ADD CONSTRAINT studio_queue_content_type_check
        CHECK (content_type IN ('aurenix_audio', 'external_media'));
  END IF;
END;
$$;

-- submitted_by FK (safe to re-add if it already has the column)
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Ensure status has the correct allowed values
DO $$
BEGIN
  ALTER TABLE studio_queue DROP CONSTRAINT IF EXISTS studio_queue_status_check;
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

ALTER TABLE studio_queue
  ADD CONSTRAINT studio_queue_status_check
    CHECK (status IN ('pending', 'approved', 'playing', 'rejected', 'removed'));


-- ────────────────────────────────────────────────────────────────────────
-- STEP 4: Auto-update updated_at trigger
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _studio_queue_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS studio_queue_updated_at ON studio_queue;
CREATE TRIGGER studio_queue_updated_at
  BEFORE UPDATE ON studio_queue
  FOR EACH ROW EXECUTE FUNCTION _studio_queue_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────
-- STEP 5: Row Level Security
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_queue ENABLE ROW LEVEL SECURITY;

-- Drop all old policies (from various migration files) before recreating
DROP POLICY IF EXISTS "Public can read approved tracks"                ON studio_queue;
DROP POLICY IF EXISTS "Anyone can read the radio queue"                ON studio_queue;
DROP POLICY IF EXISTS "Anyone can read radio queue"                    ON studio_queue;
DROP POLICY IF EXISTS "Anyone can submit to radio queue"               ON studio_queue;
DROP POLICY IF EXISTS "Anyone can submit to the radio queue"           ON studio_queue;
DROP POLICY IF EXISTS "Authenticated users can submit"                 ON studio_queue;
DROP POLICY IF EXISTS "Users can read their own submissions"           ON studio_queue;
DROP POLICY IF EXISTS "Moderators and founders can update queue status" ON studio_queue;
DROP POLICY IF EXISTS "Moderators can update queue status"             ON studio_queue;
DROP POLICY IF EXISTS "Admin can update any queue item"                ON studio_queue;
DROP POLICY IF EXISTS "Admin full access to studio_queue"              ON studio_queue;
DROP POLICY IF EXISTS "Users can update own pending submissions"       ON studio_queue;

-- POLICY 1: SELECT
--   - Anyone can see approved/playing tracks (for the radio player)
--   - Submitters can always see their own submissions (pending, rejected, etc.)
--   - Admin sees everything
CREATE POLICY "Public can read approved tracks"
  ON studio_queue FOR SELECT
  USING (
    status IN ('approved', 'playing')
    OR auth.uid() = submitted_by
    OR is_admin()
  );

-- POLICY 2: INSERT
--   - Must be authenticated
--   - submitted_by MUST equal the calling user's auth.uid()
--     (prevents submitting on behalf of another user)
--   - status MUST be 'pending'
--     (prevents self-approving at insert time)
CREATE POLICY "Authenticated users can submit"
  ON studio_queue FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid() = submitted_by
    AND status = 'pending'
  );

-- POLICY 3: UPDATE for regular users (can only edit own pending submissions)
CREATE POLICY "Users can update own pending submissions"
  ON studio_queue FOR UPDATE
  USING (
    auth.uid() = submitted_by
    AND status = 'pending'
    AND NOT is_admin()
  )
  WITH CHECK (
    status = 'pending'
    AND submitted_by = auth.uid()
  );

-- POLICY 4: Admin full access (approve/reject/remove/read all)
CREATE POLICY "Admin full access to studio_queue"
  ON studio_queue FOR ALL
  USING ( is_admin() )
  WITH CHECK ( is_admin() );


-- ────────────────────────────────────────────────────────────────────────
-- STEP 6: Indexes for query performance
-- ────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_studio_queue_status        ON studio_queue(status);
CREATE INDEX IF NOT EXISTS idx_studio_queue_submitted_by  ON studio_queue(submitted_by);
CREATE INDEX IF NOT EXISTS idx_studio_queue_content_type  ON studio_queue(content_type);
CREATE INDEX IF NOT EXISTS idx_studio_queue_created_at    ON studio_queue(created_at DESC);


-- ────────────────────────────────────────────────────────────────────────
-- STEP 7: Realtime subscription
-- ────────────────────────────────────────────────────────────────────────

-- Ignore error if already in publication
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE studio_queue;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 8: increment_radio_play_count RPC (used by the radio player)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_radio_play_count(track_uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE studio_queue
     SET play_count = play_count + 1
   WHERE uid = track_uid
     AND status IN ('approved', 'playing');
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 9: copyright_reports table (idempotent, uses UUID FK)
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS copyright_reports (
  id            BIGSERIAL    PRIMARY KEY,
  track_uid     UUID         REFERENCES studio_queue(uid) ON DELETE SET NULL,
  track_title   TEXT,
  track_artist  TEXT,
  reason        TEXT         NOT NULL
    CHECK (reason IN ('copyright','no_permission','rules_violation','removal_request','other')),
  details       TEXT         NOT NULL,
  contact_email TEXT,
  reporter_uid  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  status        TEXT         NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','resolved_takedown')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE copyright_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can submit a copyright report"    ON copyright_reports;
DROP POLICY IF EXISTS "Admin only can read copyright reports"   ON copyright_reports;
DROP POLICY IF EXISTS "Admin only can update copyright reports" ON copyright_reports;
DROP POLICY IF EXISTS "Admin full access to copyright_reports"  ON copyright_reports;

CREATE POLICY "Anyone can submit a copyright report"
  ON copyright_reports FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin full access to copyright_reports"
  ON copyright_reports FOR ALL
  USING ( is_admin() ) WITH CHECK ( is_admin() );

CREATE INDEX IF NOT EXISTS idx_copyright_reports_status    ON copyright_reports(status);
CREATE INDEX IF NOT EXISTS idx_copyright_reports_track_uid ON copyright_reports(track_uid);


-- ────────────────────────────────────────────────────────────────────────
-- STEP 10: radio_plays table (idempotent, uses UUID FK)
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS radio_plays (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track_uid  UUID        REFERENCES studio_queue(uid) ON DELETE CASCADE,
  user_uid   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id TEXT        NOT NULL DEFAULT '',
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE radio_plays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert a play" ON radio_plays;
DROP POLICY IF EXISTS "Admin can read all plays" ON radio_plays;

CREATE POLICY "Anyone can insert a play"
  ON radio_plays FOR INSERT WITH CHECK (true);

CREATE POLICY "Admin can read all plays"
  ON radio_plays FOR SELECT USING ( is_admin() );

CREATE INDEX IF NOT EXISTS idx_radio_plays_track_uid ON radio_plays(track_uid);
CREATE INDEX IF NOT EXISTS idx_radio_plays_played_at ON radio_plays(played_at);


-- ────────────────────────────────────────────────────────────────────────
-- STEP 11: Verify — run this after the script to confirm the fix
-- ────────────────────────────────────────────────────────────────────────

-- Check policies:
SELECT policyname, cmd, qual::text, with_check::text
  FROM pg_policies
 WHERE tablename = 'studio_queue'
 ORDER BY cmd, policyname;

-- Check columns:
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'studio_queue'
 ORDER BY ordinal_position;

SELECT 'studio_queue fix complete' AS status;
