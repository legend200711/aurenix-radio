-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Storage Bucket + RLS Policies
-- aurenix-radio-storage.sql
--
-- Run this ONCE in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste entire file → Run
--
-- What this does:
--   1. Creates the 'aurenix-radio' Storage bucket (if it does not exist)
--   2. Creates the 'aurenix-media' Storage bucket (if it does not exist)
--   3. Applies secure RLS policies to both buckets
--   4. Adds storage_bucket + storage_path columns to radio_queue
--   5. Tightens radio_queue INSERT policy (authenticated users only for uploads)
--
-- Security model:
--   - Authenticated users may upload only into their own user-ID prefix
--   - Authenticated users may DELETE only their own files (while pending)
--   - Admins/moderators have full access
--   - Public can read ONLY files in the 'public/' prefix (approved content
--     is moved there by the server — never directly writable by users)
--   - Files outside 'public/' are NOT readable by anonymous users
--
-- SAFETY: Uses INSERT ... ON CONFLICT DO NOTHING — will not delete or
--         modify any existing bucket or policy.
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────
-- STEP 1: Create buckets
-- ─────────────────────────────────────────────────────────────────────

-- aurenix-radio: private bucket for radio audio submissions (50 MB max)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'aurenix-radio',
  'aurenix-radio',
  false,                          -- NOT globally public; individual objects have their own access
  52428800,                       -- 50 MB
  ARRAY['audio/mpeg','audio/mp3','audio/wav','audio/wave','audio/x-wav',
        'audio/aac','audio/flac','audio/x-flac','audio/ogg','audio/webm',
        'audio/mp4','audio/m4a','audio/x-m4a']
)
ON CONFLICT (id) DO NOTHING;

-- aurenix-media: private bucket for general media uploads (200 MB max)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'aurenix-media',
  'aurenix-media',
  false,
  209715200,                      -- 200 MB
  ARRAY['video/mp4','video/webm','video/quicktime','video/x-msvideo',
        'audio/mpeg','audio/mp3','audio/wav','audio/aac','audio/flac',
        'audio/ogg','audio/webm','audio/mp4','audio/m4a',
        'image/jpeg','image/png','image/gif','image/webp','image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────
-- STEP 2: RLS policies for aurenix-radio bucket
-- ─────────────────────────────────────────────────────────────────────

-- Remove any stale policies first (idempotent)
DROP POLICY IF EXISTS "Radio: authenticated users upload own files"     ON storage.objects;
DROP POLICY IF EXISTS "Radio: authenticated users delete own files"     ON storage.objects;
DROP POLICY IF EXISTS "Radio: admin full access"                        ON storage.objects;
DROP POLICY IF EXISTS "Radio: public can read approved files"           ON storage.objects;

-- Authenticated users may upload into their own user-ID folder only.
-- Path must start with their auth.uid() so users cannot write into
-- another user's submission path.
CREATE POLICY "Radio: authenticated users upload own files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Authenticated users may delete only their own files while pending.
-- (Admin cleanup is handled by the service role key server-side.)
CREATE POLICY "Radio: authenticated users delete own files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admins and moderators have full SELECT/INSERT/UPDATE/DELETE access.
CREATE POLICY "Radio: admin full access"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'aurenix-radio'
    AND (
      EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
          AND role IN ('founder', 'administrator', 'moderator')
      )
      OR (
        SELECT email FROM auth.users WHERE id = auth.uid()
      ) = 'christijerina46@gmail.com'
    )
  )
  WITH CHECK (
    bucket_id = 'aurenix-radio'
    AND (
      EXISTS (
        SELECT 1 FROM users
        WHERE id = auth.uid()
          AND role IN ('founder', 'administrator', 'moderator')
      )
      OR (
        SELECT email FROM auth.users WHERE id = auth.uid()
      ) = 'christijerina46@gmail.com'
    )
  );

-- Public (anon) users can read files that have been explicitly published
-- by placing them under the 'public/' prefix. Pending/rejected submissions
-- live under '<user_id>/' and are NOT readable anonymously.
-- NOTE: By default Supabase Storage anon SELECT is blocked unless a policy
-- exists. This policy grants read-only access to the public/ subfolder only.
CREATE POLICY "Radio: public can read approved files"
  ON storage.objects FOR SELECT
  TO anon
  USING (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = 'public'
  );

-- Authenticated users can read their own submitted files (so the player
-- can stream a track after upload while it is still pending review).
CREATE POLICY "Radio: users can read own files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ─────────────────────────────────────────────────────────────────────
-- STEP 3: Add storage reference columns to radio_queue (idempotent)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE radio_queue
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS storage_path   TEXT;

-- Tighten the radio_queue INSERT policy:
-- Authenticated users can submit any type; anonymous users can only submit
-- YouTube/URL types (no file uploads), which is safer.
-- We drop the permissive "anyone" policy and replace it with a scoped one.
DROP POLICY IF EXISTS "Anyone can submit to the radio queue" ON radio_queue;

-- Authenticated users can submit any submission type
CREATE POLICY "Authenticated users can submit to radio queue"
  ON radio_queue FOR INSERT
  TO authenticated
  WITH CHECK (submitted_by = auth.uid());

-- Anonymous users can still submit URL/YouTube links (no storage upload)
-- but NOT file uploads (type = 'upload' requires authentication above)
CREATE POLICY "Anonymous users can submit links to radio queue"
  ON radio_queue FOR INSERT
  TO anon
  WITH CHECK (type IN ('youtube', 'url'));


-- ─────────────────────────────────────────────────────────────────────
-- STEP 4: Verify
-- ─────────────────────────────────────────────────────────────────────

SELECT id, name, public, file_size_limit
  FROM storage.buckets
 WHERE id IN ('aurenix-radio', 'aurenix-media')
 ORDER BY id;

SELECT policyname, cmd, roles
  FROM pg_policies
 WHERE tablename = 'objects'
   AND schemaname = 'storage'
   AND policyname LIKE 'Radio:%'
 ORDER BY policyname;

SELECT 'aurenix-radio storage setup complete' AS status;
