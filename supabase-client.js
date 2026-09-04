/**
 * AURENIX — Supabase Client (STORAGE ONLY)
 * supabase-client.js
 *
 * ██████████████████████████████████████████████████████████
 * IMPORTANT — READ BEFORE EDITING
 *
 * This client is used ONLY for Supabase Storage.
 * Authentication and database have been moved to Firebase.
 * See firebase-client.js.
 *
 * DO NOT:
 *  - Add auth calls here
 *  - Add database queries here
 *  - Replace this with Firebase Storage
 *  - Delete or rename the 'aurenix-radio' bucket
 *  - Move or copy the audio files
 *
 * Supabase project: nxsyoreuwmmxtuvmeqbg
 * Bucket: aurenix-radio
 * ██████████████████████████████████████████████████████████
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ── Supabase project credentials (Storage only) ──────────────────────── */
const SUPABASE_URL      = 'https://nxsyoreuwmmxtuvmeqbg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nVGMJKoZGduKTt5Vh6P7cg_H692tMxL';

/* ── Detect unconfigured state ─────────────────────────────────────────── */
const _configured = !SUPABASE_URL.includes('YOUR_PROJECT_REF');

/* ── Create a real client or a no-op stub ──────────────────────────────── */
function _makeStub() {
  return {
    storage: {
      from: () => ({
        upload:       () => Promise.resolve({ data: null, error: { message: 'Supabase Storage not configured' } }),
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
        remove:       () => Promise.resolve({ data: null, error: null }),
      }),
    },
  };
}

/**
 * Supabase client — Storage access only.
 * Use supabase.storage.from('aurenix-radio') to upload/retrieve audio files.
 *
 * All authentication and database queries must go through firebase-client.js.
 */
export const supabase = _configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // Disable Supabase Auth completely — Firebase handles auth.
        persistSession:  false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : _makeStub();

if (!_configured) {
  console.warn(
    '[AURENIX] Supabase Storage credentials not set. ' +
    'Open supabase-client.js and set SUPABASE_URL + SUPABASE_ANON_KEY. ' +
    'Audio uploads will be disabled until configured.'
  );
}

/* ── STORAGE BUCKET CONSTANT ───────────────────────────────────────────── */

/** The name of the existing Supabase Storage bucket for audio files. */
export const RADIO_BUCKET = 'aurenix-radio';

/* ── Storage helpers ───────────────────────────────────────────────────── */

/**
 * Upload an audio file to the existing Supabase Storage bucket.
 *
 * Path format: radio/<firebase_uid>/<timestamp>.<ext>
 * This path is the same format used before the migration — existing files
 * are untouched.
 *
 * @param {string} firebaseUid  — Firebase Auth UID of the uploader
 * @param {File}   file         — audio File object from file input
 * @param {(pct: number) => void} [onProgress]  — optional progress callback
 * @returns {Promise<{ storagePath: string, publicUrl: string }>}
 */
export async function uploadAudioFile(firebaseUid, file, onProgress) {
  const ext      = (file.name.split('.').pop() || 'mp3').toLowerCase();
  const fileName = `radio/${firebaseUid}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from(RADIO_BUCKET)
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert:       false,
      onUploadProgress: p => {
        if (onProgress) onProgress(Math.round((p.loaded / p.total) * 100));
      },
    });

  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage
    .from(RADIO_BUCKET)
    .getPublicUrl(fileName);

  return { storagePath: fileName, publicUrl };
}

/**
 * Get the public URL for an existing storage path.
 * Use this to construct playback URLs from stored paths.
 * @param {string} storagePath  — e.g. "radio/<uid>/<timestamp>.mp3"
 */
export function getStorageUrl(storagePath) {
  const { data: { publicUrl } } = supabase.storage
    .from(RADIO_BUCKET)
    .getPublicUrl(storagePath);
  return publicUrl;
}

/* ══════════════════════════════════════════════════════════════
   COMPATIBILITY SHIMS
   These functions were previously implemented here using Supabase
   Auth / Database. They now delegate to firebase-client.js so
   that existing callers (live.js, community, media, etc.) continue
   to work without code changes while the backend is Firebase.

   STORAGE helpers (uploadAudioFile, getStorageUrl) remain above
   and continue to use Supabase Storage directly.
══════════════════════════════════════════════════════════════ */
import {
  auth        as _fbAuth,
  db          as _fbDb,
  onAuthChange       as _fbOnAuthChange,
  loadUserProfile    as _fbLoadUserProfile,
  upsertUserProfile  as _fbUpsertUserProfile,
  doc         as _fbDoc,
  getDoc      as _fbGetDoc,
  setDoc      as _fbSetDoc,
  collection  as _fbCollection,
  query       as _fbQuery,
  where       as _fbWhere,
  getDocs     as _fbGetDocs,
  serverTimestamp as _fbServerTs,
} from './firebase-client.js';

/**
 * Subscribe to Firebase auth state changes.
 * Drop-in replacement for the old Supabase onAuthChange().
 * Callers receive a Firebase User (with .uid, .email, .emailVerified)
 * instead of a Supabase User.
 * @param {(user: import('firebase/auth').User | null) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onAuthChange(cb) {
  return _fbOnAuthChange(cb);
}

/**
 * Returns the currently signed-in Firebase user, or null.
 * Drop-in replacement for the old Supabase getUser().
 */
export async function getUser() {
  return _fbAuth.currentUser;
}

/**
 * Returns the Firebase ID token for the current session.
 * Drop-in replacement for the old Supabase getAccessToken().
 * @returns {Promise<string | null>}
 */
export async function getAccessToken() {
  try {
    const user = _fbAuth.currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch (_) {
    return null;
  }
}

/**
 * Load a user's profile document from Firestore `users/{uid}`.
 * Drop-in replacement for the old Supabase loadUserProfile().
 *
 * NOTE: The old Supabase profile used { id, uid, display_name, … }.
 * The Firebase profile uses the same shape. Callers that access
 * profile.id or profile.uid will still get the correct value
 * because upsertUserProfile() writes both `uid` and `id` fields.
 *
 * @param {string} uid — Firebase Auth UID
 */
export async function loadUserProfile(uid) {
  return _fbLoadUserProfile(uid);
}

/**
 * Create or merge-update a user profile in Firestore `users/{uid}`.
 * Drop-in replacement for the old Supabase upsertUserProfile().
 *
 * Accepts the same shape as before:
 *   { uid, id, display_name, username, email, avatar, bio, role, … }
 *
 * Normalises `id` and `uid` so existing callers that pass either field work.
 */
export async function upsertUserProfile(profile) {
  const authId = profile.uid || profile.id;
  if (!authId) { console.warn('[supabase-client compat] upsertUserProfile: no uid/id'); return; }
  await _fbUpsertUserProfile(authId, { ...profile, uid: authId, id: authId });
}

/**
 * Read a feature flag from Firestore `site_settings/config`.
 * Drop-in replacement for the old Supabase getFeatureFlag().
 * Returns `defaultValue` if the document or field is missing.
 */
export async function getFeatureFlag(key, defaultValue = true) {
  try {
    const snap = await _fbGetDoc(_fbDoc(_fbDb, 'site_settings', 'config'));
    if (!snap.exists()) return defaultValue;
    const val = snap.data()[key];
    return val !== undefined ? val : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}
