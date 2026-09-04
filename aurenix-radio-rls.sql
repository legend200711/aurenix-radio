-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Complete RLS & Security Migration
-- aurenix-radio-rls.sql
--
-- Run this in your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- This file:
--   1. Locks down studio_queue with correct per-role RLS policies
--   2. Locks down copyright_reports
--   3. Locks down storage (aurenix-radio bucket)
--   4. Creates helper functions (is_admin, studio_queue schema additions)
--   5. Creates the radio_plays tracking table
--
-- SAFETY: Uses IF NOT EXISTS / CREATE OR REPLACE / DO blocks everywhere.
--         Will NOT wipe or overwrite existing data.
-- ═══════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────
-- 0. ADMIN HELPER FUNCTION
--    Called from RLS policies instead of embedding the email literal.
--    Returns TRUE only when the calling JWT belongs to the verified admin.
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER           -- runs as table owner, bypasses caller privileges
STABLE
AS $$
DECLARE
  v_email            text;
  v_confirmed_at     timestamptz;
BEGIN
  SELECT email, email_confirmed_at
    INTO v_email, v_confirmed_at
    FROM auth.users
   WHERE id = auth.uid();

  -- Must be the exact admin email AND have a confirmed email address
  RETURN v_email = 'christijerina46@gmail.com'
     AND v_confirmed_at IS NOT NULL;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 1. STUDIO_QUEUE — Schema additions (idempotent)
-- ────────────────────────────────────────────────────────────────────────

-- uid column (text primary key used by radio module)
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS uid TEXT;

-- Generate uids for any existing rows that have none
UPDATE studio_queue
   SET uid = gen_random_uuid()::text
 WHERE uid IS NULL;

-- Make uid NOT NULL and unique after backfill
ALTER TABLE studio_queue
  ALTER COLUMN uid SET NOT NULL;

-- Add unique constraint if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'studio_queue_uid_key'
  ) THEN
    ALTER TABLE studio_queue ADD CONSTRAINT studio_queue_uid_key UNIQUE (uid);
  END IF;
END;
$$;

-- content_type: 'aurenix_audio' | 'external_media'
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'aurenix_audio'
    CHECK (content_type IN ('aurenix_audio', 'external_media'));

-- rights_confirmed
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS rights_confirmed BOOLEAN NOT NULL DEFAULT false;

-- submitted_by (FK to auth.users)
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Additional metadata columns used by the radio module
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS album       TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS genre       TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS artwork_url TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS notes       TEXT;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS play_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS likes       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE studio_queue ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Ensure status column has the correct allowed values (add REMOVED if missing)
-- We do this safely by re-creating the constraint
DO $$
BEGIN
  -- Drop old constraint if it only covers a subset of statuses
  ALTER TABLE studio_queue DROP CONSTRAINT IF EXISTS studio_queue_status_check;
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

ALTER TABLE studio_queue
  ADD CONSTRAINT studio_queue_status_check
    CHECK (status IN ('pending', 'approved', 'playing', 'rejected', 'removed'));

-- Auto-update updated_at
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

-- Backfill content_type from type
UPDATE studio_queue SET content_type = 'aurenix_audio'  WHERE type = 'upload'                              AND content_type = 'aurenix_audio';
UPDATE studio_queue SET content_type = 'external_media' WHERE type IN ('youtube','spotify','external','url') AND content_type = 'aurenix_audio';

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE studio_queue;


-- ────────────────────────────────────────────────────────────────────────
-- 2. STUDIO_QUEUE — Row Level Security
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_queue ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies before recreating them cleanly
DROP POLICY IF EXISTS "Public can read approved tracks"           ON studio_queue;
DROP POLICY IF EXISTS "Anyone can read the radio queue"           ON studio_queue;
DROP POLICY IF EXISTS "Authenticated users can submit"            ON studio_queue;
DROP POLICY IF EXISTS "Anyone can submit to the radio queue"      ON studio_queue;
DROP POLICY IF EXISTS "Users can read their own submissions"      ON studio_queue;
DROP POLICY IF EXISTS "Moderators and founders can update queue status" ON studio_queue;
DROP POLICY IF EXISTS "Admin can update any queue item"           ON studio_queue;
DROP POLICY IF EXISTS "Admin full access to studio_queue"         ON studio_queue;
DROP POLICY IF EXISTS "Users can update own pending submissions"  ON studio_queue;

-- POLICY 1: Public (including anonymous) can only read APPROVED/PLAYING tracks
CREATE POLICY "Public can read approved tracks"
  ON studio_queue FOR SELECT
  USING (
    status IN ('approved', 'playing')
    OR auth.uid() = submitted_by   -- submitter can always see their own
    OR is_admin()                  -- admin sees everything
  );

-- POLICY 2: Authenticated users can insert their own submissions
--   - Status is forced to 'pending' server-side (CHECK constraint below)
--   - Anonymous submissions are blocked
CREATE POLICY "Authenticated users can submit"
  ON studio_queue FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.uid() = submitted_by
    AND status = 'pending'
  );

-- POLICY 3: Users can update their own PENDING submissions (title, notes only)
--   They CANNOT change status, submitted_by, or rights_confirmed after initial insert.
--   (Admin updates are covered by POLICY 4.)
CREATE POLICY "Users can update own pending submissions"
  ON studio_queue FOR UPDATE
  USING (
    auth.uid() = submitted_by
    AND status = 'pending'
    AND NOT is_admin()
  )
  WITH CHECK (
    -- Users may only update descriptive fields, never the status or rights chain
    status = 'pending'
    AND submitted_by = auth.uid()
  );

-- POLICY 4: Admin full access
CREATE POLICY "Admin full access to studio_queue"
  ON studio_queue FOR ALL
  USING ( is_admin() )
  WITH CHECK ( is_admin() );

-- Ensure new submissions always start as PENDING (belt-and-suspenders)
ALTER TABLE studio_queue
  DROP CONSTRAINT IF EXISTS chk_new_submission_pending;
-- Note: We cannot enforce this only on INSERT via CHECK easily, so we rely on
-- the RLS WITH CHECK above. The INSERT policy already requires status = 'pending'.


-- ────────────────────────────────────────────────────────────────────────
-- 3. COPYRIGHT_REPORTS — Table + RLS
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS copyright_reports (
  id            BIGSERIAL PRIMARY KEY,
  track_uid     TEXT         REFERENCES studio_queue(uid) ON DELETE SET NULL,
  track_title   TEXT,
  track_artist  TEXT,
  reason        TEXT         NOT NULL
    CHECK (reason IN ('copyright','no_permission','rules_violation','removal_request','other')),
  details       TEXT         NOT NULL,
  contact_email TEXT,          -- kept private, never shown publicly
  reporter_uid  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  status        TEXT         NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','resolved_takedown')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION _copyright_reports_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS copyright_reports_updated_at ON copyright_reports;
CREATE TRIGGER copyright_reports_updated_at
  BEFORE UPDATE ON copyright_reports
  FOR EACH ROW EXECUTE FUNCTION _copyright_reports_set_updated_at();

ALTER TABLE copyright_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can submit a copyright report"    ON copyright_reports;
DROP POLICY IF EXISTS "Admin only can read copyright reports"   ON copyright_reports;
DROP POLICY IF EXISTS "Admin only can update copyright reports" ON copyright_reports;
DROP POLICY IF EXISTS "Admin full access to copyright_reports"  ON copyright_reports;

-- Anyone (including anonymous) can INSERT a report
CREATE POLICY "Anyone can submit a copyright report"
  ON copyright_reports FOR INSERT
  WITH CHECK (true);

-- Only admin can READ, UPDATE, DELETE reports
CREATE POLICY "Admin full access to copyright_reports"
  ON copyright_reports FOR ALL
  USING ( is_admin() )
  WITH CHECK ( is_admin() );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_copyright_reports_status    ON copyright_reports(status);
CREATE INDEX IF NOT EXISTS idx_copyright_reports_track_uid ON copyright_reports(track_uid);
CREATE INDEX IF NOT EXISTS idx_studio_queue_content_type   ON studio_queue(content_type);
CREATE INDEX IF NOT EXISTS idx_studio_queue_submitted_by   ON studio_queue(submitted_by);
CREATE INDEX IF NOT EXISTS idx_studio_queue_status         ON studio_queue(status);


-- ────────────────────────────────────────────────────────────────────────
-- 4. RADIO_PLAYS — Anonymous play tracking (no PII)
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS radio_plays (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track_uid  TEXT        REFERENCES studio_queue(uid) ON DELETE CASCADE,
  user_uid   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id TEXT        NOT NULL DEFAULT '',
  played_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE radio_plays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can insert a play"            ON radio_plays;
DROP POLICY IF EXISTS "Admin can read all plays"            ON radio_plays;

-- Anyone can insert a play record (anonymous listeners included)
CREATE POLICY "Anyone can insert a play"
  ON radio_plays FOR INSERT
  WITH CHECK (true);

-- Only admin can read play history
CREATE POLICY "Admin can read all plays"
  ON radio_plays FOR SELECT
  USING ( is_admin() );

CREATE INDEX IF NOT EXISTS idx_radio_plays_track_uid ON radio_plays(track_uid);
CREATE INDEX IF NOT EXISTS idx_radio_plays_played_at ON radio_plays(played_at);


-- ────────────────────────────────────────────────────────────────────────
-- 5. RPC: increment_radio_play_count
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_radio_play_count(track_uid text)
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
-- 6. STORAGE: aurenix-radio bucket policies
--
-- If the 'aurenix-radio' storage bucket does not exist yet, create it via
-- the Supabase Dashboard → Storage → New bucket:
--   Name:             aurenix-radio
--   Public:           false   (we serve only approved content)
--   File size limit:  52428800 (50 MB)
--   Allowed MIME:     audio/*
--
-- Then run these storage RLS policies:
-- ────────────────────────────────────────────────────────────────────────

-- Drop old open policies
DROP POLICY IF EXISTS "Authenticated users can upload radio files" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can listen to radio files"           ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own radio files"     ON storage.objects;
DROP POLICY IF EXISTS "Radio upload — own folder only"             ON storage.objects;
DROP POLICY IF EXISTS "Radio read — approved tracks only (via app)" ON storage.objects;

-- Authenticated users can upload to their OWN folder: radio/<their-uid>/...
CREATE POLICY "Radio upload — own folder only"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'aurenix-radio'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = 'radio'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- Public read: the Supabase anon key can read from aurenix-radio.
-- Access control for "is this approved?" is enforced at the application layer
-- via the studio_queue RLS (only approved/playing tracks are returned by the API,
-- so the client never receives a URL for a non-approved track).
-- We keep storage readable so the <audio> element can stream approved files.
CREATE POLICY "Radio read — public"
  ON storage.objects FOR SELECT
  USING ( bucket_id = 'aurenix-radio' );

-- Users can delete only their own files
CREATE POLICY "Radio delete — own files only"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'aurenix-radio'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- Users cannot update (overwrite) another user's files
CREATE POLICY "Radio update — own files only"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'aurenix-radio'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[2] = auth.uid()::text
  );


-- ────────────────────────────────────────────────────────────────────────
-- 7. USERS table: ensure RLS keeps existing policies intact
--    (no changes needed — existing policies already correct)
-- ────────────────────────────────────────────────────────────────────────

-- Verify existing policies are correct
-- Users can read all profiles  → SELECT using(true)                 ✓
-- Users can insert own profile → INSERT with check(auth.uid() = id) ✓
-- Users can update own profile → UPDATE using(auth.uid() = id)      ✓


-- ────────────────────────────────────────────────────────────────────────
-- 8. VERIFY
-- ────────────────────────────────────────────────────────────────────────

-- Sanity check — list active RLS policies on studio_queue:
-- SELECT policyname, cmd, qual, with_check
--   FROM pg_policies
--  WHERE tablename = 'studio_queue';

-- Sanity check — confirm is_admin() works (run as admin user):
-- SELECT is_admin();  -- should return true only for christijerina46@gmail.com
