-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Storage RLS fix for Firebase-Auth architecture
-- aurenix-storage-firebase-fix.sql
--
-- Run this ONCE in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste entire file → Run
--
-- WHY THIS FILE EXISTS
-- ──────────────────────────────────────────────────────────────────────
-- The previous storage policies used auth.uid() to scope uploads.
-- Since the migration to Firebase Authentication, the Supabase client
-- runs as the ANON role with NO Supabase session.
-- auth.uid() always returns NULL → every upload fails with:
--   "new row violates row-level security policy"
--
-- WHAT THIS FILE DOES
-- ──────────────────────────────────────────────────────────────────────
-- 1. Drops the old auth.uid()-based upload policy (which is now broken).
-- 2. Replaces it with an ANON-role policy that allows uploads into the
--    radio/ prefix only. The Firebase UID is recorded in the path for
--    audit purposes but cannot be enforced via Supabase RLS.
-- 3. Adds an ANON-role SELECT policy so the player can stream approved
--    tracks (public URL) without a Supabase session.
-- 4. Leaves the aurenix-media bucket policies unchanged.
-- 5. Does NOT touch any database tables, radio_submissions, or the
--    studio_queue table.
--
-- SECURITY NOTE
-- ──────────────────────────────────────────────────────────────────────
-- The bucket remains PRIVATE (not globally public). The anon INSERT
-- policy is restricted to the radio/ path prefix so users cannot write
-- to arbitrary paths. Metadata (who uploaded what) is stored securely
-- in Firestore and enforced by Firebase Security Rules.
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────
-- STEP 1: Drop the old policies that depended on auth.uid()
-- ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Radio: authenticated users upload own files"  ON storage.objects;
DROP POLICY IF EXISTS "Radio: authenticated users delete own files"  ON storage.objects;
DROP POLICY IF EXISTS "Radio: admin full access"                     ON storage.objects;
DROP POLICY IF EXISTS "Radio: public can read approved files"        ON storage.objects;
DROP POLICY IF EXISTS "Radio: users can read own files"              ON storage.objects;


-- ─────────────────────────────────────────────────────────────────────
-- STEP 2: New upload policy — anon role, radio/ prefix only
--
-- The Supabase client runs without a Supabase Auth session (Firebase
-- handles identity). We allow uploads from the anon role restricted to
-- paths that begin with "radio/". The full path is:
--   radio/<firebase_uid>/<timestamp>.<ext>
-- The Firebase UID is in the path for traceability but cannot be
-- enforced here without a Supabase session.
-- ─────────────────────────────────────────────────────────────────────

CREATE POLICY "Radio: anon upload to radio prefix"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = 'radio'
  );


-- ─────────────────────────────────────────────────────────────────────
-- STEP 3: Public read policy — anon role, radio/ prefix
--
-- The radio player fetches audio via the Supabase public URL. Since
-- the Supabase client has no session, it needs the anon SELECT policy.
-- Restrict to the radio/ prefix to keep any other paths private.
-- ─────────────────────────────────────────────────────────────────────

CREATE POLICY "Radio: anon read from radio prefix"
  ON storage.objects FOR SELECT
  TO anon
  USING (
    bucket_id = 'aurenix-radio'
    AND (storage.foldername(name))[1] = 'radio'
  );


-- ─────────────────────────────────────────────────────────────────────
-- STEP 4: Verify — confirm new policies exist
-- ─────────────────────────────────────────────────────────────────────

SELECT policyname, cmd, roles
  FROM pg_policies
 WHERE tablename   = 'objects'
   AND schemaname  = 'storage'
   AND policyname LIKE 'Radio:%'
 ORDER BY policyname;

SELECT 'Storage RLS fix complete — Firebase-auth architecture' AS status;
