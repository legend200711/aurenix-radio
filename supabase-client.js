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
