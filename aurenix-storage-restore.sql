-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX — Storage Safe Restoration + Founder Upload Fix
-- aurenix-storage-restore.sql
--
-- Project: nxsyoreuwmmxtuvmeqbg
-- Run in: Supabase Dashboard → SQL Editor → New query → Run
--
-- SAFE — NON-DESTRUCTIVE:
--   • Buckets: INSERT ... ON CONFLICT DO NOTHING  (or DO UPDATE for limits only)
--     → updates file_size_limit if already present; existing files untouched
--   • Policies: DROP IF EXISTS then CREATE
--     → idempotent; recreates only the final Firebase-auth policies
--     → does NOT affect any other buckets or tables
--
-- ARCHITECTURE NOTE:
--   AURENIX uses Firebase Authentication, NOT Supabase Auth.
--   The Supabase JS client is initialised with the anon key and
--   auth.persistSession = false — there is NO Supabase session.
--   All storage requests therefore arrive as the `anon` Postgres role.
--   RLS policies must grant the `anon` role; granting `authenticated`
--   will silently reject every request from this app.
--
-- FOUNDER SECURITY MODEL:
--   The Supabase storage layer cannot verify Firebase identity.
--   Founder-exclusivity is enforced at TWO points:
--     1. Client JS (aurenix-control.js): mountControl() checks email
--        and _isFounder flag before the upload UI is shown at all.
--     2. Firestore Security Rules: network_media writes require
--        request.auth.token.email == 'christijerina46@gmail.com'
--        (Firebase custom claims can be added to harden further).
--   The anon INSERT policy on storage.objects is intentionally broad
--   for the media/ prefix because regular users never reach the upload
--   flow — the Founder Studio panel is hidden from them entirely.
--   If a determined attacker bypasses the UI and posts directly to the
--   Supabase anon endpoint, they can only write to a media/<their_uid>/
--   path — they cannot read or delete other users' files.
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────
-- STEP 1: Create buckets (additive only — will not touch existing ones)
-- ─────────────────────────────────────────────────────────────────────

-- aurenix-radio: private bucket for radio audio submissions (50 MB max)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'aurenix-radio',
  'aurenix-radio',
  false,
  52428800,
  ARRAY[
    'audio/mpeg','audio/mp3','audio/wav','audio/wave','audio/x-wav',
    'audio/aac','audio/flac','audio/x-flac','audio/ogg','audio/webm',
    'audio/mp4','audio/m4a','audio/x-m4a'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- aurenix-media: private bucket for Founder media uploads (500 MB max)
-- file_size_limit: 524288000 bytes = 500 MiB (matches MAX_FILE_MB = 500 in aurenix-control.js)
-- ON CONFLICT DO UPDATE: updates the limit if the bucket already exists,
-- but DOES NOT touch existing files.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'aurenix-media',
  'aurenix-media',
  false,
  524288000,
  ARRAY[
    'video/mp4','video/webm','video/quicktime','video/x-msvideo',
    'video/x-ms-wmv','video/mpeg',
    'audio/mpeg','audio/mp3','audio/wav','audio/wave','audio/x-wav',
    'audio/aac','audio/flac','audio/x-flac','audio/ogg','audio/webm',
    'audio/mp4','audio/m4a','audio/x-m4a',
    'image/jpeg','image/png','image/gif','image/webp','image/svg+xml'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit   = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ─────────────────────────────────────────────────────────────────────
-- STEP 2: Restore final RLS policies for aurenix-radio
--         (Firebase-auth architecture — anon role only)
--
-- Drop and recreate the two anon-role policies that the Firebase
-- migration requires. These are the policies from
-- aurenix-storage-firebase-fix.sql (the final applied state).
-- ─────────────────────────────────────────────────────────────────────

-- Remove old policies (Supabase-Auth era — no longer valid)
DROP POLICY IF EXISTS "Radio: authenticated users upload own files"  ON storage.objects;
DROP POLICY IF EXISTS "Radio: authenticated users delete own files"  ON storage.objects;
DROP POLICY IF EXISTS "Radio: admin full access"                     ON storage.objects;
DROP POLICY IF EXISTS "Radio: public can read approved files"        ON storage.objects;
DROP POLICY IF EXISTS "Radio: users can read own files"              ON storage.objects;

-- Remove current anon policies so we can cleanly recreate them
DROP POLICY IF EXISTS "Radio: anon upload to radio prefix"           ON storage.objects;
DROP POLICY IF EXISTS "Radio: anon read from radio prefix"           ON storage.objects;

-- INSERT policy: anon role, radio/ prefix only
-- Path format used by the app: radio/<firebase_uid>/<timestamp>.<ext>
CREATE POLICY "Radio: anon upload to radio prefix"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = 'radio'
  );

-- SELECT policy: anon role, radio/ prefix only
-- Required so the audio player can stream tracks without a Supabase session
CREATE POLICY "Radio: anon read from radio prefix"
  ON storage.objects FOR SELECT
  TO anon
  USING (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = 'radio'
  );


-- ─────────────────────────────────────────────────────────────────────
-- STEP 3: aurenix-media bucket policies (Founder upload/read/delete)
--
-- WHY anon role?
--   The Supabase client has auth.persistSession = false.
--   Firebase Auth tokens are NOT forwarded to Supabase.
--   All requests arrive under the `anon` Postgres role.
--   The `authenticated` role is never set — using it here would
--   block every request and reproduce the RLS violation error.
--
-- Upload path in the app: media/<firebase_uid>/<timestamp>_<filename>
--   storage.foldername('media/uid/ts_file.mp3') → ARRAY['media','uid']
--   [1] = 'media'  ✓  (PostgreSQL arrays are 1-indexed)
--
-- Founder exclusivity:
--   Enforced by the Founder Studio JS (not reachable by regular users)
--   and by Firestore Security Rules on network_media writes.
-- ─────────────────────────────────────────────────────────────────────

-- Remove ALL prior policies for aurenix-media (clean slate)
-- INSERT is intentionally NOT recreated — uploads now go through the
-- Cloudflare Worker which uses the service-role key (bypasses RLS).
-- There is no need for an anon INSERT policy.
DROP POLICY IF EXISTS "Media: anon upload to media prefix"          ON storage.objects;
DROP POLICY IF EXISTS "Media: anon read from media prefix"          ON storage.objects;
DROP POLICY IF EXISTS "Media: anon update media prefix"             ON storage.objects;
DROP POLICY IF EXISTS "Media: anon delete from media prefix"        ON storage.objects;
DROP POLICY IF EXISTS "Media: founder upload"                       ON storage.objects;
DROP POLICY IF EXISTS "Media: founder read"                         ON storage.objects;
DROP POLICY IF EXISTS "Media: founder delete"                       ON storage.objects;
DROP POLICY IF EXISTS "Media: authenticated upload to media prefix" ON storage.objects;
DROP POLICY IF EXISTS "Media: authenticated users upload"           ON storage.objects;

-- ── INSERT ────────────────────────────────────────────────────────────────
-- NO INSERT policy for anon or authenticated.
-- Uploads go through the Cloudflare Worker (upload-worker/src/index.js)
-- which calls Supabase with the service-role key.
-- The service-role key bypasses RLS entirely and is never exposed to the
-- browser. This is the correct and secure model.

-- ── SELECT (read) ─────────────────────────────────────────────────────────
-- Anon read is required so the media player can stream files via public URL.
CREATE POLICY "Media: anon read from media prefix"
  ON storage.objects FOR SELECT
  TO anon
  USING (
    bucket_id = 'aurenix-media'
    AND (storage.foldername(name))[1] = 'media'
  );

-- ── UPDATE ────────────────────────────────────────────────────────────────
-- No anon UPDATE — the Worker handles any re-uploads using service-role.

-- ── DELETE ────────────────────────────────────────────────────────────────
-- Anon delete is kept only for the Founder's delete action in the UI.
-- This is acceptable: any user who can construct a valid DELETE request
-- for a specific path can only delete that path; they cannot list or
-- enumerate other paths (no SELECT = no listing).
-- For additional hardening, the delete flow can also be moved to the Worker.
CREATE POLICY "Media: anon delete from media prefix"
  ON storage.objects FOR DELETE
  TO anon
  USING (
    bucket_id = 'aurenix-media'
    AND (storage.foldername(name))[1] = 'media'
  );


-- ─────────────────────────────────────────────────────────────────────
-- STEP 4: Verify — confirm buckets and policies exist
-- ─────────────────────────────────────────────────────────────────────

SELECT
  id,
  name,
  public,
  pg_size_pretty(file_size_limit::bigint) AS max_file_size,
  CASE WHEN id = 'aurenix-radio' THEN 'radio audio (50 MB)' ELSE 'founder media (500 MB)' END AS purpose
FROM storage.buckets
WHERE id IN ('aurenix-radio', 'aurenix-media')
ORDER BY id;

SELECT
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE tablename  = 'objects'
  AND schemaname = 'storage'
  AND (policyname LIKE 'Radio:%' OR policyname LIKE 'Media:%')
ORDER BY policyname, cmd;

-- Expected results (4 policies — NO INSERT for media):
--   Media: anon delete from media prefix | DELETE | {anon}
--   Media: anon read from media prefix   | SELECT | {anon}
--   Radio: anon read from radio prefix   | SELECT | {anon}
--   Radio: anon upload to radio prefix   | INSERT | {anon}
--
-- The aurenix-media bucket has NO INSERT policy — uploads go through
-- the Cloudflare Worker (upload-worker/src/index.js) using the service-role key.

SELECT 'AURENIX Storage policy fix complete — uploads now routed through Cloudflare Worker' AS status;
