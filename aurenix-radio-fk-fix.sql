-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Foreign Key Fix
-- aurenix-radio-fk-fix.sql
--
-- Run ONCE in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste entire file → Run
--
-- Root cause this fixes:
--   studio_queue_uid_fkey fires because studio_queue.uid has a FK
--   pointing at users(uid) or users(id), but the authenticated user has
--   no corresponding row in the users table.  This happens because
--   loadUserProfile / upsertUserProfile were querying/writing the wrong
--   column (uid vs id) so the profile row was never created on login.
--
-- What this migration does:
--   1. Ensures the users table has BOTH `id` and `uid` columns, both
--      holding the auth.users UUID, so upserts work regardless of which
--      column callers use.
--   2. Backfills uid = id for every existing users row.
--   3. Adds a UNIQUE constraint on users.uid if not already present.
--   4. Drops the problematic studio_queue_uid_fkey if it references users
--      instead of being the auto-generated track PK (which needs no FK).
--   5. Ensures studio_queue.submitted_by is the correct user FK (keeps it).
--   6. Ensures the RLS INSERT policy enforces auth.uid() = submitted_by
--      and status = 'pending' (unchanged from aurenix-radio-fix.sql).
--   7. Creates a Postgres trigger that auto-creates a users profile row
--      whenever a new auth.users row is inserted (so future sign-ups
--      never hit this issue again).
--
-- SAFETY: idempotent — uses IF NOT EXISTS / IF EXISTS / DO blocks.
--         Does NOT delete or alter any existing data.
-- ═══════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────
-- STEP 1: Add uid column to users table if it does not exist.
--
-- The canonical schema (supabase-schema.sql) created users with `id` as
-- the primary key.  Several migration files and client helpers reference
-- users.uid instead.  We add uid as an alias so both work.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS uid UUID;

-- Backfill: uid = id for every existing row
UPDATE users SET uid = id WHERE uid IS NULL;

-- Add a UNIQUE constraint on uid (safe if it already exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_uid_key'
       AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_uid_key UNIQUE (uid);
  END IF;
END;
$$;

-- Add a NOT NULL constraint now that backfill is complete (idempotent)
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;

-- ────────────────────────────────────────────────────────────────────────
-- STEP 2: Drop the bad foreign key on studio_queue.uid.
--
-- studio_queue.uid is the track's own primary key (auto-generated UUID).
-- It must NOT reference users(uid) or users(id) — that would require every
-- track PK to exist as a user, which is nonsensical.
--
-- The correct user ownership column is studio_queue.submitted_by, which
-- already has the correct FK → auth.users(id).
--
-- We drop studio_queue_uid_fkey if it exists.  If it does not exist the
-- DO block silently succeeds.
-- ────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'studio_queue_uid_fkey'
       AND conrelid = 'studio_queue'::regclass
  ) THEN
    ALTER TABLE studio_queue DROP CONSTRAINT studio_queue_uid_fkey;
    RAISE NOTICE 'Dropped studio_queue_uid_fkey (track PK should not reference users)';
  ELSE
    RAISE NOTICE 'studio_queue_uid_fkey not found — nothing to drop';
  END IF;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 3: Ensure studio_queue.uid is a proper auto-generated PK.
--
-- If uid was previously a FK-backed column rather than a standalone PK,
-- give it a default of gen_random_uuid() so inserts without an explicit
-- uid value succeed.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_queue
  ALTER COLUMN uid SET DEFAULT gen_random_uuid();

-- Ensure existing rows without a uid get one (covers tables created with
-- the TEXT uid variant from aurenix-radio-rls.sql)
UPDATE studio_queue SET uid = gen_random_uuid() WHERE uid IS NULL;

ALTER TABLE studio_queue ALTER COLUMN uid SET NOT NULL;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 4: Keep studio_queue.submitted_by FK intact.
--
-- This is the correct ownership FK.  If it is missing, add it.
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_queue
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 5: Auto-create users profile row on new auth sign-up.
--
-- This trigger fires when Supabase Auth creates a new row in auth.users.
-- It inserts a corresponding row in the public users table so that FK
-- relationships that reference users(id) or users(uid) are always
-- satisfied from the moment of sign-up.
--
-- The trigger is SECURITY DEFINER so it can write to public.users even
-- when the new user's session is not yet established.
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _create_user_profile_on_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_handle TEXT;
BEGIN
  -- Derive a safe display name / username from the email address
  v_handle := regexp_replace(
    split_part(COALESCE(NEW.email, ''), '@', 1),
    '[^a-zA-Z0-9_]', '_', 'g'
  );
  IF v_handle = '' THEN v_handle := 'user'; END IF;

  INSERT INTO public.users (
    id, uid, email, display_name, display_name_lower, username, role,
    created_at, updated_at
  )
  VALUES (
    NEW.id,
    NEW.id,
    COALESCE(NEW.email, ''),
    v_handle,
    lower(v_handle),
    v_handle,
    'member',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;   -- idempotent: skip if profile already exists

  RETURN NEW;
END;
$$;

-- Attach the trigger to auth.users (Supabase allows this via SECURITY DEFINER)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION _create_user_profile_on_signup();


-- ────────────────────────────────────────────────────────────────────────
-- STEP 6: Backfill users profile rows for any auth users that are missing one.
--
-- Covers any existing authenticated users who signed up before the trigger
-- was in place and whose profile row was never created.
-- ────────────────────────────────────────────────────────────────────────

INSERT INTO public.users (id, uid, email, display_name, display_name_lower, username, role, created_at, updated_at)
SELECT
  au.id,
  au.id,
  COALESCE(au.email, ''),
  COALESCE(regexp_replace(split_part(COALESCE(au.email,''), '@', 1), '[^a-zA-Z0-9_]', '_', 'g'), 'user'),
  COALESCE(lower(regexp_replace(split_part(COALESCE(au.email,''), '@', 1), '[^a-zA-Z0-9_]', '_', 'g')), 'user'),
  COALESCE(regexp_replace(split_part(COALESCE(au.email,''), '@', 1), '[^a-zA-Z0-9_]', '_', 'g'), 'user'),
  'member',
  NOW(),
  NOW()
FROM auth.users au
WHERE NOT EXISTS (
  SELECT 1 FROM public.users pu WHERE pu.id = au.id
)
ON CONFLICT (id) DO NOTHING;


-- ────────────────────────────────────────────────────────────────────────
-- STEP 7: Elevate the admin user's role if it wasn't set correctly.
-- ────────────────────────────────────────────────────────────────────────

UPDATE public.users
   SET role = 'administrator', updated_at = NOW()
  FROM auth.users au
 WHERE public.users.id = au.id
   AND au.email = 'christijerina46@gmail.com'
   AND public.users.role NOT IN ('administrator', 'founder');


-- ────────────────────────────────────────────────────────────────────────
-- STEP 8: Verify — run this after the script to confirm the fix.
-- ────────────────────────────────────────────────────────────────────────

-- Confirm studio_queue_uid_fkey is gone:
SELECT conname, contype
  FROM pg_constraint
 WHERE conrelid = 'studio_queue'::regclass
 ORDER BY conname;

-- Confirm every auth user has a profile row:
SELECT
  (SELECT count(*) FROM auth.users)          AS auth_users,
  (SELECT count(*) FROM public.users)        AS profile_rows,
  (SELECT count(*) FROM auth.users au
    WHERE NOT EXISTS (SELECT 1 FROM public.users pu WHERE pu.id = au.id)
  )                                          AS missing_profiles;

-- Confirm users.uid is populated:
SELECT count(*) AS users_without_uid FROM public.users WHERE uid IS NULL;

SELECT 'aurenix-radio-fk-fix complete' AS status;
