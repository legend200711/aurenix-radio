-- ═══════════════════════════════════════════════════════════════════════
-- AURENIX RADIO — Shared Station State Migration
-- aurenix-radio-station.sql
--
-- Run ONCE in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → paste → Run
--
-- What this creates:
--   radio_station   — singleton row that holds the authoritative live
--                     station state: current track, playback start
--                     timestamp, queue snapshot, next track, status.
--
-- Design:
--   • Only ONE row ever exists (id = 'live').
--   • All listeners read this row and calculate:
--       current_position = NOW() - track_started_at
--   • When a track ends the server (or first qualifying client)
--     advances the station and writes the new row.
--   • Supabase Realtime broadcasts every UPDATE to all subscribers.
--   • No per-listener state is stored here.
-- ═══════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────
-- 1. radio_station table
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS radio_station (
  -- Singleton key
  id                TEXT        PRIMARY KEY DEFAULT 'live'
                                CHECK (id = 'live'),

  -- Current track
  current_track_id  UUID        REFERENCES studio_queue(uid) ON DELETE SET NULL,
  current_track     JSONB,           -- snapshot: {uid,title,artist,album,artwork_url,url,type,duration_sec}

  -- Authoritative playback start timestamp (UTC)
  track_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Duration in seconds (null = unknown / external)
  duration_sec      NUMERIC,

  -- Next track id (hint for clients)
  next_track_id     UUID        REFERENCES studio_queue(uid) ON DELETE SET NULL,
  next_track        JSONB,

  -- Ordered queue snapshot (array of track jsonb objects)
  queue             JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Station status: 'playing' | 'paused' | 'idle'
  station_status    TEXT        NOT NULL DEFAULT 'idle'
                                CHECK (station_status IN ('playing','paused','idle')),

  -- Metadata
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ────────────────────────────────────────────────────────────────────────
-- 2. Seed the singleton row if it doesn't exist yet
-- ────────────────────────────────────────────────────────────────────────

INSERT INTO radio_station (id, station_status)
VALUES ('live', 'idle')
ON CONFLICT (id) DO NOTHING;


-- ────────────────────────────────────────────────────────────────────────
-- 3. Auto-update updated_at on every write
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _radio_station_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS radio_station_updated_at ON radio_station;
CREATE TRIGGER radio_station_updated_at
  BEFORE UPDATE ON radio_station
  FOR EACH ROW EXECUTE FUNCTION _radio_station_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────
-- 4. Row Level Security
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE radio_station ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read station state"         ON radio_station;
DROP POLICY IF EXISTS "Admin can update station state"        ON radio_station;

-- All visitors (anonymous + authenticated) can read the live station row.
CREATE POLICY "Anyone can read station state"
  ON radio_station FOR SELECT
  USING (true);

-- Only the admin (or the is_admin() helper) may write the station state.
-- The JS advance logic runs under the anon key but uses a SECURITY DEFINER
-- RPC (advance_radio_station) so it bypasses this and is safe.
CREATE POLICY "Admin can update station state"
  ON radio_station FOR UPDATE
  USING ( is_admin() )
  WITH CHECK ( is_admin() );


-- ────────────────────────────────────────────────────────────────────────
-- 5. advance_radio_station RPC
--    Called by any client when the current track ends.
--    Uses SECURITY DEFINER so the anon key can write the singleton row.
--    Guards against race conditions: only advances if the current
--    track_id in the DB still matches what the caller believes is playing.
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION advance_radio_station(
  p_finished_track_id  UUID,   -- the track the caller believes just ended
  p_next_track_id      UUID,   -- the track that should play next
  p_next_track_json    JSONB,  -- full snapshot of the next track
  p_next_next_id       UUID,   -- hint for the track after next (may be null)
  p_next_next_json     JSONB,  -- snapshot of track after next (may be null)
  p_queue_json         JSONB,  -- full updated queue snapshot
  p_duration_sec       NUMERIC -- duration of the new track (null = unknown)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_id UUID;
  v_result     JSONB;
BEGIN
  -- Read current station track under a row lock to prevent races
  SELECT current_track_id INTO v_current_id
    FROM radio_station
   WHERE id = 'live'
     FOR UPDATE;

  -- Only advance if we're still on the track the caller thinks is playing
  -- (or if station is idle/null, allow the first start)
  IF v_current_id IS NOT NULL AND v_current_id <> p_finished_track_id THEN
    -- Another client already advanced — return current state
    SELECT jsonb_build_object(
      'advanced',          false,
      'current_track_id',  current_track_id,
      'track_started_at',  track_started_at,
      'station_status',    station_status
    ) INTO v_result
      FROM radio_station WHERE id = 'live';
    RETURN v_result;
  END IF;

  -- Mark old track approved again (non-fatal)
  IF p_finished_track_id IS NOT NULL THEN
    UPDATE studio_queue
       SET status = 'approved'
     WHERE uid = p_finished_track_id
       AND status = 'playing';
  END IF;

  IF p_next_track_id IS NULL THEN
    -- Queue exhausted: set station idle
    UPDATE radio_station SET
      current_track_id  = NULL,
      current_track     = NULL,
      track_started_at  = NOW(),
      duration_sec      = NULL,
      next_track_id     = NULL,
      next_track        = NULL,
      queue             = COALESCE(p_queue_json, '[]'::jsonb),
      station_status    = 'idle'
    WHERE id = 'live';
  ELSE
    -- Mark next track as playing
    UPDATE studio_queue SET status = 'playing'
     WHERE uid = p_next_track_id;

    -- Advance station to next track
    UPDATE radio_station SET
      current_track_id  = p_next_track_id,
      current_track     = p_next_track_json,
      track_started_at  = NOW(),
      duration_sec      = p_duration_sec,
      next_track_id     = p_next_next_id,
      next_track        = p_next_next_json,
      queue             = COALESCE(p_queue_json, '[]'::jsonb),
      station_status    = 'playing'
    WHERE id = 'live';
  END IF;

  SELECT jsonb_build_object(
    'advanced',          true,
    'current_track_id',  current_track_id,
    'track_started_at',  track_started_at,
    'station_status',    station_status
  ) INTO v_result
    FROM radio_station WHERE id = 'live';

  RETURN v_result;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- 6. Enable Realtime on radio_station
--    Clients subscribe to changes and reconnect immediately on any update.
-- ────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE radio_station;
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;


-- ────────────────────────────────────────────────────────────────────────
-- 7. Verify
-- ────────────────────────────────────────────────────────────────────────

SELECT id, station_status, current_track_id, track_started_at
  FROM radio_station;

SELECT 'radio_station migration complete' AS status;
