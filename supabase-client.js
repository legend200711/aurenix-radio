/**
 * AURENIX — Supabase Client
 * supabase-client.js
 *
 * Single shared Supabase client for the entire AURENIX project.
 * Replaces all Firebase (Firestore + Auth + Realtime Database) usage.
 *
 * Org: tzypauptizcsokgckpts
 * Project URL and anon key are set below — replace with your project's values
 * from https://supabase.com/dashboard/project/<project-ref>/settings/api
 *
 * Usage (ES module):
 *   import { supabase, getUser, onAuthChange } from './supabase-client.js';
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ── Project credentials ─────────────────────────────────────────────────────
   Set SUPABASE_URL and SUPABASE_ANON_KEY to your project values from:
   https://supabase.com/dashboard/project/<ref>/settings/api
──────────────────────────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'https://nxsyoreuwmmxtuvmeqbg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nVGMJKoZGduKTt5Vh6P7cg_H692tMxL';

/* ── Detect unconfigured state ── */
const _configured = !SUPABASE_URL.includes('YOUR_PROJECT_REF');

/* ── Create a real client or a no-op stub ──────────────────────────────────── */
function _makeStub() {
  const _noop   = () => Promise.resolve({ data: null, error: { message: 'Supabase not configured' } });
  const _noopQ  = () => ({ select: _noopQ, insert: _noop, update: _noop, upsert: _noop, delete: _noop, eq: _noopQ, neq: _noopQ, gt: _noopQ, order: _noopQ, limit: _noopQ, range: _noopQ, ilike: _noopQ, single: _noop, maybeSingle: _noop, then: (r) => r({ data: null, error: null }) });
  return {
    from:    () => _noopQ(),
    rpc:     () => _noop(),
    storage: { from: () => ({ upload: _noop, getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
    channel: () => ({ on: function() { return this; }, subscribe: function() { return this; }, send: _noop }),
    removeChannel: () => {},
    auth: {
      getUser:             () => Promise.resolve({ data: { user: null }, error: null }),
      getSession:          () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange:   (cb) => { cb('INITIAL_SESSION', null); return { data: { subscription: { unsubscribe: () => {} } } }; },
      signInWithPassword:  () => Promise.resolve({ data: null, error: { message: 'Supabase not configured — add credentials to supabase-client.js' } }),
      signUp:              () => Promise.resolve({ data: null, error: { message: 'Supabase not configured — add credentials to supabase-client.js' } }),
      signOut:             () => Promise.resolve({}),
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
    },
  };
}

export const supabase = _configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      realtime: {
        params: { eventsPerSecond: 20 },
      },
    })
  : _makeStub();

if (!_configured) {
  console.warn(
    '[AURENIX] Supabase credentials not set. ' +
    'Open supabase-client.js and set SUPABASE_URL + SUPABASE_ANON_KEY. ' +
    'The UI will render but all backend features are disabled until configured.'
  );
}

/* ── Auth helpers ──────────────────────────────────────────────────────────── */

/**
 * Returns the currently signed-in user, or null if not authenticated.
 * @returns {Promise<import('@supabase/supabase-js').User | null>}
 */
export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Subscribe to auth state changes (mirrors Firebase onAuthStateChanged).
 * @param {(user: import('@supabase/supabase-js').User | null) => void} cb
 * @returns {{ data: { subscription: { unsubscribe: () => void } } }}
 */
export function onAuthChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.user ?? null);
  });
}

/**
 * Load the user's profile row from the `users` table.
 * Returns null if the row doesn't exist yet.
 * @param {string} uid
 * @returns {Promise<Record<string, any> | null>}
 */
export async function loadUserProfile(uid) {
  // The canonical users table uses `id` as PK (references auth.users).
  // Some deployments also have a `uid` column; try `id` first, fall back to `uid`.
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', uid)
    .maybeSingle();
  if (error) console.warn('[Supabase] loadUserProfile error:', error.message);
  if (data) return data;

  // Fallback for deployments where uid is the stored column
  const { data: data2, error: err2 } = await supabase
    .from('users')
    .select('*')
    .eq('uid', uid)
    .maybeSingle();
  if (err2) console.warn('[Supabase] loadUserProfile (uid fallback) error:', err2.message);
  return data2 ?? null;
}

/**
 * Upsert (create-or-update) a user profile row.
 * @param {Record<string, any>} profile  — must include `uid` or `id`
 *
 * The users table primary key is `id` (uuid references auth.users).
 * Some callers pass `uid` instead of `id`; normalise both directions so
 * the upsert always targets the correct PK column.
 */
export async function upsertUserProfile(profile) {
  // Normalise: whichever of `id` / `uid` is present, set both so the row
  // lands correctly whether the live table uses `id` or `uid` as PK.
  const authId = profile.id || profile.uid;
  if (!authId) {
    console.warn('[Supabase] upsertUserProfile: no id/uid provided');
    return;
  }
  const normalised = { ...profile, id: authId, uid: authId };

  // Try PK = 'id' first (canonical schema).  If the table was created with
  // 'uid' as PK instead, the fallback below catches the conflict error.
  const { error } = await supabase
    .from('users')
    .upsert(normalised, { onConflict: 'id' });

  if (error) {
    // Fallback: some deployments have uid as the unique/PK column.
    const { error: err2 } = await supabase
      .from('users')
      .upsert(normalised, { onConflict: 'uid' });
    if (err2) console.warn('[Supabase] upsertUserProfile error:', err2.message);
  }
}

/**
 * Returns an access token for the current session (replaces Firebase getIdToken).
 * @returns {Promise<string | null>}
 */
export async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/* ── Feature-flag helper ───────────────────────────────────────────────────── */

/**
 * Read a single feature flag from the `site_settings` table.
 * Returns the default value if the row is missing or the column is null.
 * @param {string} key
 * @param {*} defaultValue
 */
export async function getFeatureFlag(key, defaultValue = true) {
  const { data, error } = await supabase
    .from('site_settings')
    .select(key)
    .eq('id', 'config')
    .maybeSingle();
  if (error || !data) return defaultValue;
  return data[key] ?? defaultValue;
}
