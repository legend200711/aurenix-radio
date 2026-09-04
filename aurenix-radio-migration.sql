-- ═══════════════════════════════════════════════════════════════
-- AURENIX RADIO — Rights-Aware Model Database Migration
-- Run these statements in your Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. New columns on studio_queue
-- ────────────────────────────────────────────────────────────────

-- content_type: 'aurenix_audio' | 'external_media'
--   aurenix_audio  = uploaded file the submitter owns/has rights to.
--                    Eligible for AURENIX's own continuous audio player.
--   external_media = YouTube, Spotify, or other third-party links.
--                    Never downloaded or rebroadcast through AURENIX.
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'aurenix_audio'
    CHECK (content_type IN ('aurenix_audio', 'external_media'));

-- rights_confirmed: true when submitter checked the rights checkbox.
-- Stored as part of the submission record.
-- NOTE: This is NOT legal verification — it is a record of what was submitted.
ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS rights_confirmed BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing upload-type rows
UPDATE studio_queue
SET content_type = 'aurenix_audio'
WHERE type = 'upload';

-- Backfill existing non-upload rows (youtube, url, etc.)
UPDATE studio_queue
SET content_type = 'external_media'
WHERE type IN ('youtube', 'spotify', 'external', 'url');

-- ────────────────────────────────────────────────────────────────
-- 2. copyright_reports table
-- ────────────────────────────────────────────────────────────────
-- Stores public copyright/content reports submitted by users.
-- Reporter contact info (contact_email, reporter_uid) is never shown
-- publicly — admin only.
CREATE TABLE IF NOT EXISTS copyright_reports (
  id            BIGSERIAL PRIMARY KEY,
  track_uid     UUID         REFERENCES studio_queue(uid) ON DELETE SET NULL,
  track_title   TEXT,
  track_artist  TEXT,
  reason        TEXT         NOT NULL
    CHECK (reason IN ('copyright','no_permission','rules_violation','removal_request','other')),
  details       TEXT         NOT NULL,
  contact_email TEXT,                         -- kept private, never exposed publicly
  reporter_uid  UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  status        TEXT         NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','resolved','resolved_takedown')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_copyright_reports_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS copyright_reports_updated_at ON copyright_reports;
CREATE TRIGGER copyright_reports_updated_at
  BEFORE UPDATE ON copyright_reports
  FOR EACH ROW EXECUTE FUNCTION update_copyright_reports_updated_at();

-- ────────────────────────────────────────────────────────────────
-- 3. Row Level Security
-- ────────────────────────────────────────────────────────────────

ALTER TABLE copyright_reports ENABLE ROW LEVEL SECURITY;

-- Anyone (including anon) can INSERT a report.
CREATE POLICY "Anyone can submit a copyright report"
  ON copyright_reports FOR INSERT
  WITH CHECK (true);

-- Only the admin account (christijerina46@gmail.com) can SELECT reports.
CREATE POLICY "Admin only can read copyright reports"
  ON copyright_reports FOR SELECT
  USING (
    auth.email() = 'christijerina46@gmail.com'
  );

-- Only the admin account can UPDATE (resolve/takedown) reports.
CREATE POLICY "Admin only can update copyright reports"
  ON copyright_reports FOR UPDATE
  USING (
    auth.email() = 'christijerina46@gmail.com'
  );

-- ────────────────────────────────────────────────────────────────
-- 4. studio_queue RLS additions
-- ────────────────────────────────────────────────────────────────

-- IMPORTANT: Your existing studio_queue RLS policies should already ensure:
--   - Public SELECT only sees status IN ('approved','playing')
--   - INSERT requires authentication
--   - UPDATE of status (approve/reject/remove) requires admin email
--
-- The new columns (content_type, rights_confirmed) are set client-side
-- on insert and are covered by existing policies.
-- If you want server-side enforcement add a check:

-- Optional: Enforce that external_media submissions cannot have status='playing'
-- (External media is shown but not played by AURENIX's continuous queue)
-- ALTER TABLE studio_queue ADD CONSTRAINT chk_external_not_playing
--   CHECK (NOT (content_type = 'external_media' AND status = 'playing'));

-- ────────────────────────────────────────────────────────────────
-- 5. Index for reports lookup
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_copyright_reports_status
  ON copyright_reports(status);

CREATE INDEX IF NOT EXISTS idx_copyright_reports_track_uid
  ON copyright_reports(track_uid);

CREATE INDEX IF NOT EXISTS idx_studio_queue_content_type
  ON studio_queue(content_type);
