/**
 * AURENIX — Founder Upload Worker  (v8 — Google Drive OAuth + resumable upload)
 * upload-worker/src/index.js
 *
 * ARCHITECTURE (v8):
 *   Adds Google Drive OAuth 2.0 storage as an additional upload destination.
 *   Google OAuth client secret and refresh tokens are NEVER sent to the browser.
 *   All Drive token management is handled server-side in this Worker.
 *   See gdrive.js for the full Drive module.
 *
 * Endpoints (existing Supabase):
 *   POST /authorize  — JSON: { fileName, contentType, size }
 *   GET  /health     — secrets present check
 *   GET  /diagnose   — full connectivity diagnostic
 *
 * Endpoints (new Google Drive — all require Firebase Founder token):
 *   GET  /gdrive/config-check     — are Drive OAuth credentials configured?
 *   GET  /gdrive/auth             — get Google OAuth authorization URL
 *   GET  /gdrive/callback         — OAuth callback (exchanges code, stores tokens)
 *   GET  /gdrive/status           — connection status + account info
 *   POST /gdrive/disconnect       — revoke + clear tokens (does NOT delete Drive files)
 *   GET  /gdrive/folders          — list Drive folders
 *   POST /gdrive/folder-set       — set/create AURENIX folder + subfolders
 *   POST /gdrive/upload-init      — initiate resumable upload (returns upload URI)
 *   POST /gdrive/upload-finalize  — finalize + return Drive file metadata
 *
 * Environment secrets (set via `wrangler secret put`):
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_KEY  — Supabase service-role JWT
 *   FIREBASE_PROJECT_ID   — Firebase project ID
 *   GOOGLE_CLIENT_ID      — Google OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET  — Google OAuth 2.0 client secret (NEVER in browser JS)
 *   GOOGLE_REDIRECT_URI   — authorized redirect URI (e.g. .../gdrive/callback)
 *
 * KV binding (wrangler.jsonc):
 *   GDRIVE_KV  — Workers KV namespace for Drive token storage
 */

/* ─── Constants ───────────────────────────────────────────────────────────── */
const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const MEDIA_BUCKET  = 'aurenix-media';

// Broad MIME type allowlist — covers all standard audio, video, and image types.
// Content classification (person, face, cat, music video, slideshow, etc.)
// is NOT performed here and does NOT affect upload acceptance.
// All accepted files enter the Founder's PENDING APPROVAL queue.
const ALLOWED_TYPES = new Set([
  // Audio
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/opus',
  // Video — all standard containers accepted regardless of visual content
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-ms-wmv', 'video/mpeg', 'video/3gpp', 'video/3gpp2',
  'video/x-matroska', 'video/ogg', 'video/x-flv', 'video/mp2t',
  // Image (used as still-photo music videos, thumbnails, slideshows, etc.)
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic',
]);

// No application-level MAX_BYTES cap is imposed.
// The effective upload limit is the Supabase bucket file_size_limit (set below)
// combined with the project-level STORAGE_FILE_SIZE_LIMIT.
// Real technical errors from Supabase are surfaced as-is.

// Target bucket file_size_limit.  The Worker will PATCH the bucket to this
// value whenever the stored limit is lower (or unset).  This is the actual
// Supabase-side limit that prevents "The object exceeded the maximum allowed
// size" HTTP 400 errors.
const BUCKET_FILE_SIZE_LIMIT_BYTES = 524_288_000; // 500 MiB

/* ─── CORS ────────────────────────────────────────────────────────────────── */
function corsHeaders(origin) {
  const allowed = [
    'https://legend200711.github.io',            // AURENIX production frontend
    'https://remix-studio-4bf8a.web.app',
    'https://remix-studio-4bf8a.firebaseapp.com',
    'https://aurenix.com',
    'https://www.aurenix.com',
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1',
  ];
  return {
    'Access-Control-Allow-Methods':  'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':  'Authorization, Content-Type',
    'Access-Control-Max-Age':        '86400',
    'Access-Control-Allow-Origin':   (origin && allowed.includes(origin)) ? origin : '*',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

/* ─── Firebase JWT verification (JWK endpoint) ────────────────────────────── */

async function fetchFirebaseJwks() {
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    { cf: { cacheTtl: 3600, cacheEverything: true } }
  );
  if (!res.ok) throw new Error('Failed to fetch Firebase JWKs — HTTP ' + res.status);
  const { keys } = await res.json();
  const map = {};
  for (const k of keys) map[k.kid] = k;
  return map;
}

function b64url(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=');
  return Uint8Array.from(atob(p), c => c.charCodeAt(0));
}

async function verifyFirebaseToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('FIREBASE TOKEN INVALID — malformed (not 3 parts)');

  let header, payload;
  try {
    header  = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    throw new Error('FIREBASE TOKEN INVALID — decode error');
  }

  if (header.alg !== 'RS256')
    throw new Error('FIREBASE TOKEN INVALID — unexpected algorithm: ' + header.alg);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now)
    throw new Error('FIREBASE TOKEN EXPIRED — please sign in again');
  if (payload.iat && payload.iat > now + 300)
    throw new Error('FIREBASE TOKEN INVALID — issued in future');
  if (payload.aud !== projectId)
    throw new Error('FIREBASE TOKEN INVALID — wrong audience: ' + payload.aud);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
    throw new Error('FIREBASE TOKEN INVALID — wrong issuer');
  if (!payload.sub)
    throw new Error('FIREBASE TOKEN INVALID — missing subject');

  const jwks = await fetchFirebaseJwks();
  const jwk  = jwks[header.kid];
  if (!jwk) throw new Error('FIREBASE TOKEN INVALID — unknown key ID: ' + header.kid);

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!valid) throw new Error('FIREBASE TOKEN INVALID — signature failed');

  return payload;
}

/* ─── Ensure Supabase bucket file_size_limit ──────────────────────────────── */

/**
 * Reads the current file_size_limit on the aurenix-media bucket and PATCHes it
 * to BUCKET_FILE_SIZE_LIMIT_BYTES if the stored value is lower (or null/0).
 *
 * Root cause of "HTTP 400: The object exceeded the maximum allowed size":
 *   The Supabase Storage bucket has a file_size_limit field.  The Supabase
 *   Dashboard default is often 50 MB.  If a 93 MB file is PUT via a signed URL
 *   the transfer completes (progress reaches 100 %) but Supabase then rejects
 *   the object server-side and returns HTTP 400 with that message.
 *
 * This function is idempotent — if the limit is already >= the target it is a
 * single GET (bucket read) with no write.
 *
 * @param {string} supabaseUrl
 * @param {string} serviceKey  — service-role JWT
 * @returns {Promise<{ limitBytes: number|null, updated: boolean }>}
 */
async function ensureBucketLimit(supabaseUrl, serviceKey) {
  const bucketUrl = `${supabaseUrl}/storage/v1/bucket/${MEDIA_BUCKET}`;
  const headers   = { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey };

  // Read current bucket config
  const getRes = await fetch(bucketUrl, { headers });
  if (!getRes.ok) {
    const t = await getRes.text().catch(() => '');
    throw new Error(`BUCKET READ FAILED — HTTP ${getRes.status}: ${t.slice(0, 200)}`);
  }
  const bucket = await getRes.json();
  const current = bucket.file_size_limit || 0;

  if (current >= BUCKET_FILE_SIZE_LIMIT_BYTES) {
    // Already at or above the target — nothing to do.
    return { limitBytes: current, updated: false };
  }

  // Bucket limit is too low (or unset) — raise it.
  const patchRes = await fetch(bucketUrl, {
    method:  'PUT',   // Supabase Storage Management API uses PUT to update a bucket
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ file_size_limit: BUCKET_FILE_SIZE_LIMIT_BYTES }),
  });

  if (!patchRes.ok) {
    const t = await patchRes.text().catch(() => '');
    // Non-fatal: log and continue — the upload may still succeed if the platform
    // limit allows it.  The error is surfaced in the authorize response.
    throw new Error(`BUCKET LIMIT UPDATE FAILED — HTTP ${patchRes.status}: ${t.slice(0, 200)}`);
  }

  return { limitBytes: BUCKET_FILE_SIZE_LIMIT_BYTES, updated: true };
}

/* ─── Raise Supabase project-level storage limit ──────────────────────────── */

/**
 * Raises the Supabase project-level "Upload File Size Limit" (STORAGE_FILE_SIZE_LIMIT)
 * to BUCKET_FILE_SIZE_LIMIT_BYTES using the Supabase Management API.
 *
 * WHAT THIS FIXES:
 *   The Supabase project has TWO independent file-size limits:
 *     1. Bucket file_size_limit  — per-bucket app cap (set via Storage API)
 *     2. Project-level storage file_size_limit — global platform cap
 *        (set via Dashboard → Storage → Configuration → Upload File Size Limit)
 *   Effective limit = min(project_level, bucket_level).
 *   If the project-level limit is 50 MB (Supabase Free default) and the bucket
 *   cap is 500 MB, the effective limit is STILL 50 MB.  This is what causes
 *   the HTTP 400 "The object exceeded the maximum allowed size" error when
 *   uploading a 93 MB video via a signed URL.
 *
 * HOW TO USE:
 *   1. Generate a Supabase personal access token:
 *      https://supabase.com/dashboard/account/tokens
 *   2. Add it as a Worker secret:
 *      cd upload-worker && npx wrangler secret put SUPABASE_MANAGEMENT_TOKEN
 *   3. Deploy: npx wrangler deploy
 *   4. Call GET /set-storage-limit to raise the project-level limit to 500 MB.
 *      The Worker also calls this automatically on every /authorize if the token
 *      is present.
 *
 * NOTE: On Supabase Free plan, the project-level limit cannot exceed 50 MB
 * regardless of what this call sets.  Upgrade to Pro plan for up to 5 GB.
 *
 * @param {string} projectRef       — Supabase project ref (e.g. "nxsyoreuwmmxtuvmeqbg")
 * @param {string} managementToken  — Supabase personal access token
 * @returns {Promise<{ ok: boolean, previous: number|null, current: number, updated: boolean, note: string }>}
 */
async function ensureProjectStorageLimit(projectRef, managementToken) {
  const mgmtUrl = `https://api.supabase.com/v1/projects/${projectRef}/config/storage`;
  const headers  = {
    'Authorization': `Bearer ${managementToken}`,
    'Content-Type': 'application/json',
  };

  // Read current project-level setting
  let current = null;
  try {
    const getRes = await fetch(mgmtUrl, { headers });
    if (getRes.ok) {
      const cfg = await getRes.json();
      current = cfg.file_size_limit || null;
    }
  } catch (_) {}

  if (current !== null && current >= BUCKET_FILE_SIZE_LIMIT_BYTES) {
    return { ok: true, previous: current, current, updated: false,
      note: `Project-level limit already ${Math.round(current/1048576)} MB — no change needed.` };
  }

  // Raise the project-level limit
  const patchRes = await fetch(mgmtUrl, {
    method:  'PATCH',
    headers,
    body: JSON.stringify({ file_size_limit: BUCKET_FILE_SIZE_LIMIT_BYTES }),
  });

  if (!patchRes.ok) {
    const t = await patchRes.text().catch(() => '');
    const note = patchRes.status === 400
      ? `Project plan does not allow limit > current max. ` +
        `On Free plan the maximum is 50 MB. Upgrade to Supabase Pro for up to 5 GB. ` +
        `Response: ${t.slice(0, 200)}`
      : `Management API PATCH failed — HTTP ${patchRes.status}: ${t.slice(0, 200)}`;
    return { ok: false, previous: current, current, updated: false, note };
  }

  const result = await patchRes.json().catch(() => ({}));
  const newLimit = result.file_size_limit || BUCKET_FILE_SIZE_LIMIT_BYTES;
  return {
    ok:       true,
    previous: current,
    current:  newLimit,
    updated:  true,
    note:     `Project-level limit updated from ${current ? Math.round(current/1048576) : '?'} MB to ${Math.round(newLimit/1048576)} MB.`,
  };
}

/* ─── Extract Supabase project ref from URL ────────────────────────────────── */
function extractProjectRef(supabaseUrl) {
  // URL format: https://<ref>.supabase.co
  try { return new URL(supabaseUrl).hostname.split('.')[0]; } catch (_) { return null; }
}

/* ─── Supabase signed upload URL ──────────────────────────────────────────── */

/**
 * Creates a Supabase signed upload URL using the service-role key.
 *
 * TWO-STEP PROCESS:
 *
 *   Step 1 — POST to /storage/v1/object/upload/sign/<bucket>/<path>
 *             with service-role key.  Supabase returns:
 *               { url: "/object/upload/sign/<bucket>/<path>?token=..." }
 *
 *   Step 2 — Browser PUTs the file directly to:
 *               /storage/v1/object/upload/sign/<bucket>/<path>?token=...
 *             This is the SAME path prefix returned by Supabase, with the
 *             ?token= query parameter.  No Authorization header is needed —
 *             the token in the URL query string is the authorisation.
 *
 *             WARNING: Do NOT rewrite /object/upload/sign/ → /object/sign/.
 *             /object/sign/ is the download-URL path (GET only) and requires
 *             an Authorization header — sending a PUT there returns HTTP 400
 *             "headers must have required property 'authorization'".
 *
 * @param {string} supabaseUrl
 * @param {string} serviceKey    — service-role JWT
 * @param {string} storagePath   — e.g. "media/<uid>/<ts>_file.mp4"
 * @returns {Promise<string>}    — full signed upload URL for browser PUT
 */
async function createSignedUploadUrl(supabaseUrl, serviceKey, storagePath) {
  const endpoint = `${supabaseUrl}/storage/v1/object/upload/sign/${MEDIA_BUCKET}/${storagePath}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'apikey':         serviceKey,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),  // 1-hour window
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SUPABASE SIGNED URL FAILED — HTTP ${res.status}: ${detail}`);
  }

  const data = await res.json();

  // Supabase returns { url: "/object/upload/sign/<bucket>/<path>?token=..." }
  // Some Supabase versions use "signedURL" key instead of "url".
  // We MUST preserve the /object/upload/sign/ path prefix — it is the upload endpoint.
  // /object/sign/ (without "upload/") is the DOWNLOAD URL endpoint and returns HTTP 400
  // "headers must have required property 'authorization'" when receiving a PUT.
  const rawPath = data.url || data.signedURL || data.signed_url || null;
  if (!rawPath) throw new Error(`SUPABASE SIGNED URL FAILED — no url in response: ${JSON.stringify(data).slice(0, 200)}`);

  // Normalise: ensure path uses /object/upload/sign/ (not the download /object/sign/ path)
  let safePath = rawPath;
  if (safePath.includes('/object/sign/') && !safePath.includes('/object/upload/sign/')) {
    // Wrong path returned — would cause HTTP 400 on PUT.  Re-request using the correct endpoint.
    // This should not happen with the /upload/sign endpoint above, but guard defensively.
    throw new Error(`SUPABASE SIGNED URL FAILED — received download-sign path instead of upload-sign path: ${safePath.slice(0, 120)}`);
  }

  // If Supabase returned an absolute URL already, use it directly
  if (safePath.startsWith('http://') || safePath.startsWith('https://')) {
    return safePath;
  }

  // Relative path — prepend Supabase base URL + /storage/v1
  // The path from Supabase already begins with /object/upload/sign/...
  if (safePath.startsWith('/storage/v1')) {
    return `${supabaseUrl}${safePath}`;
  }
  return `${supabaseUrl}/storage/v1${safePath}`;
}

/* ─── Service key shape check ─────────────────────────────────────────────── */
function describeKeyShape(key) {
  if (!key) return 'MISSING';
  const t = key.trim();
  if (t !== key)                    return 'HAS_WHITESPACE';
  if (t.startsWith('sb_publishable_')) return 'WRONG — anon/publishable key (need service_role JWT eyJ...)';
  if (t.startsWith('sb_secret_'))     return 'WRONG — sb_secret_ format (need service_role JWT eyJ...)';
  if (t.split('.').length !== 3)      return `NOT_A_JWT — ${t.split('.').length} parts (need 3)`;
  if (!t.startsWith('eyJ'))           return 'NOT_A_JWT — does not start with eyJ';
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')
      .padEnd(t.split('.')[1].length + (4 - t.split('.')[1].length % 4) % 4, '=')));
    if (p.role === 'service_role') return 'OK — JWT role=service_role';
    if (p.role === 'anon')         return 'WRONG — JWT role=anon (need service_role)';
    return `JWT role=${p.role || '(none)'} — expected service_role`;
  } catch { return 'JWT_UNREADABLE — possibly truncated'; }
}

function checkSecrets(env) {
  if (!env.SUPABASE_URL)         return 'SUPABASE_URL missing';
  if (!env.SUPABASE_SERVICE_KEY) return 'SUPABASE_SERVICE_KEY missing';
  if (!env.FIREBASE_PROJECT_ID)  return 'FIREBASE_PROJECT_ID missing';
  return null;
}

/* ─── Worker entry point ──────────────────────────────────────────────────── */
import {
  handleGdriveAuth,
  handleGdriveCallback,
  handleGdriveStatus,
  handleGdriveDisconnect,
  handleGdriveFolders,
  handleGdriveFolderSet,
  handleGdriveUploadInit,
  handleGdriveUploadFinalize,
  handleGdriveConfigCheck,
  handleSubmissionCopyToDrive,
} from './gdrive.js';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    const p   = url.pathname;

    /* ── Google Drive OAuth routes ──────────────────────────────────────── */
    // These are all server-side — no client secrets in browser JS.
    const gdriveJsonHelper = (body, status) => json(body, status, origin);

    if (request.method === 'GET'  && p === '/gdrive/config-check')
      return handleGdriveConfigCheck(request, env, gdriveJsonHelper);

    if (request.method === 'GET'  && p === '/gdrive/auth')
      return handleGdriveAuth(request, env, gdriveJsonHelper);

    if (request.method === 'GET'  && p === '/gdrive/callback')
      return handleGdriveCallback(request, env);

    if (request.method === 'GET'  && p === '/gdrive/status')
      return handleGdriveStatus(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/gdrive/disconnect')
      return handleGdriveDisconnect(request, env, gdriveJsonHelper);

    if (request.method === 'GET'  && p === '/gdrive/folders')
      return handleGdriveFolders(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/gdrive/folder-set')
      return handleGdriveFolderSet(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/gdrive/upload-init')
      return handleGdriveUploadInit(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/gdrive/upload-finalize')
      return handleGdriveUploadFinalize(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/submission/copy-to-drive')
      return handleSubmissionCopyToDrive(request, env, gdriveJsonHelper);


    /* ── GET /health ─────────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/health') {
      const err = checkSecrets(env);
      return json({
        ok:      !err,
        worker:  'aurenix-upload',
        version: '2025-09-06-v8-gdrive',
        SUPABASE_URL:        env.SUPABASE_URL         ? '✓ set' : '✗ MISSING',
        SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID  ? '✓ set' : '✗ MISSING',
        GOOGLE_CLIENT_ID:    env.GOOGLE_CLIENT_ID     ? '✓ set' : '✗ not set (optional)',
        GOOGLE_CLIENT_SECRET:env.GOOGLE_CLIENT_SECRET ? '✓ set' : '✗ not set (optional)',
        GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI  ? '✓ set' : '✗ not set (optional)',
        GDRIVE_KV:           env.GDRIVE_KV            ? '✓ bound' : '✗ not bound (optional)',
        FIREBASE_PROJECT_ID_value: env.FIREBASE_PROJECT_ID || null,
        SUPABASE_URL_value:        env.SUPABASE_URL || null,
        architecture: 'Signed URL — browser PUT to /object/upload/sign/<bucket>/<path>?token=',
        gdrive_architecture: 'OAuth PKCE — browser redirects to Google, server stores tokens in KV',
        error: err || null,
      }, err ? 503 : 200, origin);
    }

    /* ── GET /diagnose ───────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/diagnose') {
      const diag = { worker: 'aurenix-upload', version: '2025-09-06-v6-bucket-limit', steps: {} };

      diag.steps.secrets_present   = checkSecrets(env) ? `FAIL — ${checkSecrets(env)}` : 'OK';
      diag.steps.service_key_shape = describeKeyShape(env.SUPABASE_SERVICE_KEY);

      // Supabase bucket list
      try {
        const r = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket`, {
          headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, apikey: env.SUPABASE_SERVICE_KEY },
        });
        const body = await r.text();
        if (r.ok) {
          const ids = JSON.parse(body).map(b => b.id);
          diag.steps.supabase_connection = `OK — buckets: ${JSON.stringify(ids)}`;
        } else {
          diag.steps.supabase_connection = `FAIL — HTTP ${r.status}: ${body}`;
        }
      } catch (e) { diag.steps.supabase_connection = `FAIL — ${e.message}`; }

      // aurenix-media bucket detail (shows file_size_limit)
      try {
        const r = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${MEDIA_BUCKET}`, {
          headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, apikey: env.SUPABASE_SERVICE_KEY },
        });
        const body = await r.text();
        if (r.ok) {
          const b = JSON.parse(body);
          const limitMB = b.file_size_limit ? Math.round(b.file_size_limit / 1048576) + ' MB' : 'unlimited / default';
          diag.steps.media_bucket = `OK — exists, file_size_limit=${limitMB}, public=${b.public}`;
          diag.bucket_file_size_limit_bytes = b.file_size_limit || null;
        } else {
          diag.steps.media_bucket = `FAIL — HTTP ${r.status}: ${body}`;
        }
      } catch (e) { diag.steps.media_bucket = `FAIL — ${e.message}`; }

      // Firebase JWKs
      try {
        const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
        if (r.ok) {
          const { keys } = await r.json();
          diag.steps.firebase_jwks = `OK — ${keys.length} key(s)`;
        } else {
          diag.steps.firebase_jwks = `FAIL — HTTP ${r.status}`;
        }
      } catch (e) { diag.steps.firebase_jwks = `FAIL — ${e.message}`; }

      // Probe the EFFECTIVE upload limit by testing a real upload.
      // The bucket file_size_limit (app-level cap) can be higher than the
      // Supabase project's STORAGE_FILE_SIZE_LIMIT (platform-level cap).
      // The effective limit is min(platform, bucket).
      // If uploads > ~50 MB fail despite the bucket showing 500 MB,
      // the platform cap (controlled via Dashboard → Storage → Configuration)
      // is what's rejecting them.
      //
      // We probe by doing a real PUT of a small dummy payload via a signed URL.
      // This confirms signed-URL uploads work at all; the exact platform cap
      // must be checked in: Supabase Dashboard → Storage → Configuration →
      //   "Upload File Size Limit"
      diag.upload_size_note = [
        'The bucket file_size_limit above is the PER-BUCKET app-level cap.',
        'There is also a project-level STORAGE_FILE_SIZE_LIMIT (the "Upload File Size Limit"',
        'setting in Supabase Dashboard → Storage → Configuration).',
        'The effective maximum is min(project_level, bucket_level).',
        'If large uploads fail despite the bucket showing 500 MB, the project-level',
        'setting may be lower. To fix:',
        '  Supabase Dashboard → Storage → Configuration → Upload File Size Limit → 500 MB (or higher)',
        'On Supabase Free plan the maximum project-level limit is 50 MB.',
        'On Supabase Pro plan the maximum project-level limit is 5 GB.',
        'See: https://supabase.com/docs/guides/storage/uploads/standard-uploads#file-limits',
      ];

      const allOk = Object.values(diag.steps).every(v => String(v).startsWith('OK'));
      diag.overall = allOk ? 'ALL OK' : 'ISSUES DETECTED';
      if (!diag.steps.service_key_shape.startsWith('OK')) {
        diag.fix = [
          'SUPABASE_SERVICE_KEY is wrong.',
          '1. Supabase Dashboard → Settings → API → service_role key (starts with eyJ...)',
          '2. cd upload-worker && npx wrangler secret put SUPABASE_SERVICE_KEY',
          '3. npx wrangler deploy',
        ];
      }
      return json(diag, allOk ? 200 : 503, origin);
    }

    /* ── GET /probe-limit — test effective upload limit via a real signed PUT ─── */
    if (request.method === 'GET' && url.pathname === '/probe-limit') {
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: secretErr }, 503, origin);

      // Get the bucket's configured file_size_limit
      let bucketLimit = null;
      try {
        const r = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${MEDIA_BUCKET}`, {
          headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, apikey: env.SUPABASE_SERVICE_KEY },
        });
        if (r.ok) { const b = await r.json(); bucketLimit = b.file_size_limit || null; }
      } catch (_) {}

      // Create a signed upload URL for a probe file
      const probePath = `probe/limit-probe_${Date.now()}.bin`;
      let signedUrl = null;
      try {
        signedUrl = await createSignedUploadUrl(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, probePath);
      } catch (e) {
        return json({ error: `Could not create signed URL for probe: ${e.message}` }, 502, origin);
      }

      // Try uploading probe payloads of increasing sizes to find the effective limit.
      // Sizes: 1 KB, 1 MB, 10 MB, 50 MB, 100 MB (stop at first failure).
      const sizes = [1024, 1048576, 10 * 1048576, 50 * 1048576, 100 * 1048576];
      const results = [];
      let lastSuccessBytes = 0;
      let firstFailBytes   = null;

      for (const sz of sizes) {
        // Need a fresh signed URL for each attempt (single-use token)
        let url_ = signedUrl;
        if (sz !== sizes[0]) {
          try {
            url_ = await createSignedUploadUrl(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY,
              `probe/limit-probe_${Date.now()}_${sz}.bin`);
          } catch (_) { break; }
        }

        // PUT a synthetic payload (repeated 0x00 bytes)
        const payload = new Uint8Array(sz); // zero-filled
        let putStatus = null;
        let putBody   = '';
        try {
          const pr = await fetch(url_, {
            method:  'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
            body:    payload,
          });
          putStatus = pr.status;
          putBody   = (await pr.text().catch(() => '')).slice(0, 200);
        } catch (e) {
          putStatus = -1;
          putBody   = e.message;
        }

        const ok = putStatus >= 200 && putStatus < 300;
        results.push({ sizeBytes: sz, sizeMB: +(sz / 1048576).toFixed(2), status: putStatus, ok, body: putBody });
        if (ok) { lastSuccessBytes = sz; }
        else    { firstFailBytes = sz; break; }
      }

      return json({
        bucket_file_size_limit_bytes: bucketLimit,
        bucket_file_size_limit_MB:    bucketLimit ? Math.round(bucketLimit / 1048576) : null,
        last_successful_upload_bytes: lastSuccessBytes,
        last_successful_upload_MB:    +(lastSuccessBytes / 1048576).toFixed(2),
        first_failed_upload_bytes:    firstFailBytes,
        first_failed_upload_MB:       firstFailBytes ? +(firstFailBytes / 1048576).toFixed(2) : null,
        effective_limit_note: firstFailBytes
          ? `Effective upload limit is between ${+(lastSuccessBytes/1048576).toFixed(1)} MB and ${+(firstFailBytes/1048576).toFixed(1)} MB. ` +
            `The bucket file_size_limit is ${bucketLimit ? Math.round(bucketLimit/1048576) + ' MB' : '(not set)'}. ` +
            `If these differ, the project-level STORAGE_FILE_SIZE_LIMIT is lower than the bucket cap. ` +
            `Fix: Supabase Dashboard → Storage → Configuration → Upload File Size Limit.`
          : `All probe sizes succeeded. Effective limit is at least ${+(lastSuccessBytes/1048576).toFixed(1)} MB.`,
        probe_results: results,
      }, 200, origin);
    }

    /* ── GET /probe-signed-url — diagnostic: shows raw Supabase data.url ─── */
    if (request.method === 'GET' && url.pathname === '/probe-signed-url') {
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: secretErr }, 503, origin);

      const testPath = `probe/test_${Date.now()}.mp4`;
      const endpoint = `${env.SUPABASE_URL}/storage/v1/object/upload/sign/${MEDIA_BUCKET}/${testPath}`;
      let rawData, rawStatus, rawText;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: 60 }),
        });
        rawStatus = r.status;
        rawText   = await r.text();
        try { rawData = JSON.parse(rawText); } catch (_) { rawData = null; }
      } catch (e) {
        return json({ error: e.message }, 500, origin);
      }

      const dataUrl      = rawData?.url || rawData?.signedURL || rawData?.signed_url || null;
      const constructed  = dataUrl
        ? (dataUrl.startsWith('http') ? dataUrl
           : dataUrl.startsWith('/storage/v1') ? `${env.SUPABASE_URL}${dataUrl}`
           : `${env.SUPABASE_URL}/storage/v1${dataUrl}`)
        : null;
      return json({
        supabase_http_status: rawStatus,
        raw_response:         rawText.slice(0, 500),
        data_url_field:       dataUrl,
        constructed_put_url:  constructed,
        note: 'constructed_put_url is what the browser will PUT to',
      }, 200, origin);
    }

    /* ── POST /verify — check whether an object already exists in storage ── */
    if (request.method === 'POST' && url.pathname === '/verify') {

      // ── 0. Secrets present
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: `WORKER CONFIGURATION ERROR — ${secretErr}`, stage: 'WORKER_CONFIGURATION' }, 503, origin);

      // ── 1. Extract Firebase token
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer '))
        return json({ error: 'FIREBASE TOKEN MISSING', stage: 'FIREBASE_TOKEN_MISSING' }, 401, origin);
      const idToken = authHeader.slice(7).trim();
      if (!idToken)
        return json({ error: 'FIREBASE TOKEN MISSING — empty', stage: 'FIREBASE_TOKEN_MISSING' }, 401, origin);

      // ── 2. Verify Firebase token
      let tokenPayload;
      try {
        tokenPayload = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
      } catch (err) {
        return json({ error: err.message, stage: 'FIREBASE_TOKEN_INVALID' }, 401, origin);
      }

      // ── 3. Verify Founder email
      const tokenEmail = (tokenPayload.email || '').trim().toLowerCase();
      if (!tokenEmail || tokenEmail !== FOUNDER_EMAIL.toLowerCase())
        return json({ error: 'FOUNDER NOT AUTHORIZED', stage: 'FOUNDER_NOT_AUTHORIZED' }, 403, origin);

      // ── 4. Parse body
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'VERIFY FAILED — invalid JSON body' }, 400, origin); }

      const { storagePath } = body || {};
      if (!storagePath || typeof storagePath !== 'string')
        return json({ error: 'VERIFY FAILED — storagePath required' }, 400, origin);

      // ── 5. HEAD the object in Supabase Storage to check existence
      const objectUrl = `${env.SUPABASE_URL}/storage/v1/object/${MEDIA_BUCKET}/${storagePath}`;
      let exists = false;
      let sizeBytes = null;
      try {
        const r = await fetch(objectUrl, {
          method: 'HEAD',
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
          },
        });
        exists = r.ok; // 200 = exists, 404 = not found
        sizeBytes = r.headers.get('content-length') ? parseInt(r.headers.get('content-length'), 10) : null;
      } catch (e) {
        return json({ error: `VERIFY FAILED — Supabase HEAD request failed: ${e.message}` }, 502, origin);
      }

      const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;
      return json({ ok: true, exists, storagePath, publicUrl, sizeBytes }, 200, origin);
    }

    /* ── POST /authorize — Founder-only signed-URL authorisation ─────────── */
    if (request.method === 'POST' && url.pathname === '/authorize') {

      // ── 0. Secrets present
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: `WORKER CONFIGURATION ERROR — ${secretErr}`, stage: 'WORKER_CONFIGURATION' }, 503, origin);

      // ── 1. Extract Firebase token
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer '))
        return json({ error: 'FIREBASE TOKEN MISSING', stage: 'FIREBASE_TOKEN_MISSING' }, 401, origin);
      const idToken = authHeader.slice(7).trim();
      if (!idToken)
        return json({ error: 'FIREBASE TOKEN MISSING — empty', stage: 'FIREBASE_TOKEN_MISSING' }, 401, origin);

      // ── 2. Verify Firebase token
      let tokenPayload;
      try {
        tokenPayload = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
      } catch (err) {
        return json({ error: err.message, stage: 'FIREBASE_TOKEN_INVALID' }, 401, origin);
      }

      // ── 3. Verify Founder email (from cryptographically-verified token only)
      const tokenEmail = (tokenPayload.email || '').trim().toLowerCase();
      if (!tokenEmail)
        return json({ error: 'FOUNDER NOT AUTHORIZED — no email in token', stage: 'FOUNDER_NOT_AUTHORIZED' }, 403, origin);
      if (tokenEmail !== FOUNDER_EMAIL.toLowerCase())
        return json({ error: 'FOUNDER NOT AUTHORIZED — wrong account', stage: 'FOUNDER_NOT_AUTHORIZED' }, 403, origin);

      // ── 4. Parse request body (tiny JSON — no file)
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'AUTHORIZE FAILED — invalid JSON body', stage: 'AUTHORIZE_FAILED' }, 400, origin); }

      const { fileName, contentType, size } = body || {};

      if (!fileName || typeof fileName !== 'string')
        return json({ error: 'AUTHORIZE FAILED — fileName required', stage: 'AUTHORIZE_FAILED' }, 400, origin);
      if (!size || typeof size !== 'number' || size <= 0)
        return json({ error: 'AUTHORIZE FAILED — size required (positive number)', stage: 'AUTHORIZE_FAILED' }, 400, origin);

      // Content-based rejection is intentionally absent.
      // Any video, audio, or image file is accepted into the Founder's
      // PENDING APPROVAL queue regardless of what it visually contains.
      // If the MIME type is unrecognised we still allow it — Supabase will
      // reject truly invalid payloads at the storage level.
      const ct = contentType || 'application/octet-stream';
      // Only block genuinely non-media MIME prefixes to prevent abuse
      // (e.g. text/html, application/javascript).  All audio/*, video/*,
      // image/*, and application/octet-stream are accepted.
      const isMedia = ct.startsWith('audio/') || ct.startsWith('video/') ||
                      ct.startsWith('image/') || ct === 'application/octet-stream' ||
                      ALLOWED_TYPES.has(ct);
      if (!isMedia)
        return json({ error: `AUTHORIZE FAILED — not a media file type: ${ct}`, stage: 'AUTHORIZE_FAILED' }, 415, origin);
      // No application-level file-size cap is imposed here.
      // The Supabase bucket file_size_limit (500 MiB, set in step 6 below) is
      // the real technical limit.  If the storage provider rejects the upload
      // we surface its actual error — we do not invent a smaller limit.

      // ── 5. Build storage path
      const uid      = tokenPayload.sub;
      const safeName = fileName.replace(/[^a-z0-9._-]/gi, '_');
      const storagePath = `media/${uid}/${Date.now()}_${safeName}`;

      // ── 6. Ensure bucket and project-level file_size_limit are >= 500 MiB ──
      //
      //    ROOT CAUSE of "The object exceeded the maximum allowed size" HTTP 400:
      //
      //    Supabase has TWO independent file-size limits:
      //      A. Bucket file_size_limit (set via Storage API) — per-bucket app cap
      //      B. Project-level STORAGE_FILE_SIZE_LIMIT — global platform cap
      //         (set in Dashboard → Storage → Configuration → Upload File Size Limit)
      //    Effective limit = min(A, B).
      //
      //    Even with bucket = 500 MB, if the project-level limit is 50 MB
      //    (the Supabase Free plan default), all files > 50 MB will fail.
      //    The probe at /probe-limit confirmed: 50 MB succeeds, 100 MB fails.
      //
      //    We fix BOTH limits here:
      //      - ensureBucketLimit: raises bucket.file_size_limit to 500 MB
      //      - ensureProjectStorageLimit: raises the project-level limit to 500 MB
      //        (requires SUPABASE_MANAGEMENT_TOKEN secret; no-op if absent)
      //
      //    On Free plan, the Management API will return 400 when trying to raise
      //    the project limit above 50 MB — in that case, upgrade to Supabase Pro.
      let bucketLimitBytes = BUCKET_FILE_SIZE_LIMIT_BYTES;
      let bucketLimitWarning = null;

      // A. Bucket file_size_limit
      try {
        const bl = await ensureBucketLimit(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
        bucketLimitBytes = bl.limitBytes;
        if (bl.updated) {
          console.log(`[aurenix-upload] Bucket file_size_limit updated to ${bl.limitBytes} bytes`);
        }
      } catch (blErr) {
        bucketLimitWarning = blErr.message;
        console.warn(`[aurenix-upload] ensureBucketLimit warning: ${blErr.message}`);
      }

      // B. Project-level STORAGE_FILE_SIZE_LIMIT (requires management token)
      if (env.SUPABASE_MANAGEMENT_TOKEN) {
        const projectRef = extractProjectRef(env.SUPABASE_URL);
        if (projectRef) {
          try {
            const pl = await ensureProjectStorageLimit(projectRef, env.SUPABASE_MANAGEMENT_TOKEN);
            if (pl.updated) {
              console.log(`[aurenix-upload] Project-level storage limit updated: ${pl.note}`);
              bucketLimitBytes = pl.current;
            } else if (!pl.ok) {
              const planWarn = `PROJECT STORAGE LIMIT UPDATE FAILED — ${pl.note}`;
              bucketLimitWarning = (bucketLimitWarning ? bucketLimitWarning + ' | ' : '') + planWarn;
              console.warn(`[aurenix-upload] ${planWarn}`);
            }
          } catch (plErr) {
            console.warn(`[aurenix-upload] ensureProjectStorageLimit warning: ${plErr.message}`);
          }
        }
      }

      // ── 7. Create signed upload URL (service-role key, server-side only)
      //    Browser PUTs directly to this URL — no Authorization header needed,
      //    the ?token= query parameter is the authorisation.
      let signedUrl;
      try {
        signedUrl = await createSignedUploadUrl(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, storagePath);
      } catch (err) {
        return json({ error: err.message, stage: 'SUPABASE_SIGNED_URL_FAILED' }, 502, origin);
      }

      // ── 8. Return signed URL + paths to browser — file is never sent here
      const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;
      return json({
        ok:               true,
        signedUrl,
        storagePath,
        publicUrl,
        uploadedBy:       tokenEmail,
        authorizedAt:     new Date().toISOString(),
        bucketLimitBytes,
        bucketLimitWarning: bucketLimitWarning || undefined,
      }, 200, origin);
    }

    /* ── GET /set-storage-limit — one-shot: raise project-level upload limit ── */
    if (request.method === 'GET' && url.pathname === '/set-storage-limit') {
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: secretErr }, 503, origin);

      // Bucket limit
      let bucketResult = null;
      try {
        bucketResult = await ensureBucketLimit(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
      } catch (e) { bucketResult = { error: e.message }; }

      // Project-level limit
      let projectResult = null;
      if (env.SUPABASE_MANAGEMENT_TOKEN) {
        const projectRef = extractProjectRef(env.SUPABASE_URL);
        if (projectRef) {
          try {
            projectResult = await ensureProjectStorageLimit(projectRef, env.SUPABASE_MANAGEMENT_TOKEN);
          } catch (e) { projectResult = { ok: false, note: e.message }; }
        } else {
          projectResult = { ok: false, note: 'Could not extract project ref from SUPABASE_URL' };
        }
      } else {
        projectResult = {
          ok: false,
          note: [
            'SUPABASE_MANAGEMENT_TOKEN not set — project-level limit cannot be raised automatically.',
            'To fix manually: Supabase Dashboard → Storage → Configuration → Upload File Size Limit.',
            'To fix automatically: cd upload-worker && npx wrangler secret put SUPABASE_MANAGEMENT_TOKEN',
            '  (get a personal access token from https://supabase.com/dashboard/account/tokens)',
            'Then: npx wrangler deploy',
          ].join(' '),
        };
      }

      return json({
        bucket:  bucketResult,
        project: projectResult,
        instructions: projectResult?.ok === false ? [
          'MANUAL FIX (if no management token):',
          '  1. Supabase Dashboard → Storage → Configuration → Upload File Size Limit',
          '  2. Set to 500 MB (or max your plan allows)',
          '  3. On Free plan max is 50 MB — upgrade to Pro for 5 GB',
          '',
          'AUTOMATED FIX (adds management token):',
          '  1. https://supabase.com/dashboard/account/tokens → Create new token',
          '  2. cd upload-worker && npx wrangler secret put SUPABASE_MANAGEMENT_TOKEN',
          '  3. npx wrangler deploy',
          '  4. GET /set-storage-limit — this endpoint will then do it automatically',
        ] : ['Limit already at target — no action needed.'],
      }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
