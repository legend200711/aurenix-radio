/**
 * AURENIX — Founder Upload Worker  (v10 — channel auto-advance engine)
 * upload-worker/src/index.js
 *
 * ARCHITECTURE (v9):
 *   Adds Google Drive OAuth 2.0 storage as an additional upload destination.
 *   Google OAuth client secret and refresh tokens are NEVER sent to the browser.
 *   All Drive token management is handled server-side in this Worker.
 *   See gdrive.js for the full Drive module.
 *
 *   v9 CHANGE — Worker-proxied chunked upload:
 *   The browser can NOT PUT directly to googleapis.com/upload/ because Google's
 *   resumable upload endpoint has no CORS headers — the browser XHR fires onerror
 *   immediately ("network error").  v9 removes the direct browser→Google path and
 *   routes every chunk through POST /gdrive/upload-chunk.  The Worker streams each
 *   chunk to Google server-side with the Content-Range header.  No file buffering.
 *
 * Endpoints (existing Supabase):
 *   POST /authorize          — JSON: { fileName, contentType, size }
 *   GET  /health             — secrets present check
 *   GET  /diagnose           — full connectivity diagnostic
 *
 * Endpoints (channel auto-advance — any authenticated viewer):
 *   POST /channel/advance    — JSON: { channelId, currentItemId }
 *     Atomically advances network_state/{channelId} to the next program.
 *     Uses a Firestore compare-and-swap transaction so that if two viewers
 *     race, only one succeeds.  Validates that the item's scheduled duration
 *     has actually elapsed before advancing.
 *
 * Endpoints (new Google Drive — all require Firebase Founder token):
 *   GET  /gdrive/config-check     — are Drive OAuth credentials configured?
 *   GET  /gdrive/auth             — get Google OAuth authorization URL
 *   GET  /gdrive/callback         — OAuth callback (exchanges code, stores tokens)
 *   GET  /gdrive/status           — connection status + account info
 *   POST /gdrive/disconnect       — revoke + clear tokens (does NOT delete Drive files)
 *   GET  /gdrive/folders          — list Drive folders
 *   POST /gdrive/folder-set       — set/create AURENIX folder + subfolders
 *   POST /gdrive/upload-init      — initiate resumable session (returns upload_id)
 *   POST /gdrive/upload-chunk     — proxy a chunk to Google (browser→Worker→Google)
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
    'Access-Control-Allow-Headers':  'Authorization, Content-Type, Content-Range, X-Upload-Id, X-Total-Size',
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
  handleGdriveUploadChunk,
  handleGdriveUploadFinalize,
  handleGdriveConfigCheck,
  handleGdriveDiagnostic,
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

    if (request.method === 'POST' && p === '/gdrive/upload-chunk')
      return handleGdriveUploadChunk(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/gdrive/upload-finalize')
      return handleGdriveUploadFinalize(request, env, gdriveJsonHelper);

    if (request.method === 'GET'  && p === '/gdrive/diagnostic')
      return handleGdriveDiagnostic(request, env, gdriveJsonHelper);

    if (request.method === 'POST' && p === '/submission/copy-to-drive')
      return handleSubmissionCopyToDrive(request, env, gdriveJsonHelper);


    /* ── GET /health ─────────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/health') {
      const err = checkSecrets(env);
      return json({
        ok:      !err,
        worker:  'aurenix-upload',
        version: '2025-09-06-v14-channel-bootstrap',
        SUPABASE_URL:        env.SUPABASE_URL         ? '✓ set' : '✗ MISSING',
        SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID  ? '✓ set' : '✗ MISSING',
        GOOGLE_CLIENT_ID:    env.GOOGLE_CLIENT_ID     ? '✓ set' : '✗ not set (optional)',
        GOOGLE_CLIENT_SECRET:env.GOOGLE_CLIENT_SECRET ? '✓ set' : '✗ not set (optional)',
        GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI  ? '✓ set' : '✗ not set (optional)',
        GDRIVE_KV:                    env.GDRIVE_KV                    ? '✓ bound'     : '✗ not bound (optional)',
        FIREBASE_SERVICE_ACCOUNT_KEY: env.FIREBASE_SERVICE_ACCOUNT_KEY ? '✓ set'       : '✗ not set (required for auto-advance)',
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

    /* ── POST /submission/authorize — any authenticated user signed-URL upload ── */
    //
    // Unlike /authorize (Founder-only), this endpoint accepts any Firebase-authenticated
    // user.  Files are stored under submissions/{uid}/ in the same aurenix-media bucket.
    // The Founder reviews and approves submissions before they enter any channel.
    //
    // Security:
    //   - Firebase token is cryptographically verified server-side.
    //   - uid is taken from the verified token — the client cannot spoof it.
    //   - Files land in submissions/{uid}/ so the Founder can identify the submitter.
    //   - Storage is NOT publicly writable — a signed URL is required per upload.
    //   - Service-role key is never sent to the browser.
    if (request.method === 'POST' && url.pathname === '/submission/authorize') {

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

      // ── 3. Any authenticated user is allowed (no Founder check)
      const tokenEmail = (tokenPayload.email || '').trim().toLowerCase();
      const uid        = tokenPayload.sub;
      if (!uid)
        return json({ error: 'SUBMISSION AUTHORIZE FAILED — no uid in token', stage: 'AUTHORIZE_FAILED' }, 401, origin);

      // ── 4. Parse request body (tiny JSON — no file)
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'SUBMISSION AUTHORIZE FAILED — invalid JSON body', stage: 'AUTHORIZE_FAILED' }, 400, origin); }

      const { fileName, contentType, size } = body || {};

      if (!fileName || typeof fileName !== 'string')
        return json({ error: 'SUBMISSION AUTHORIZE FAILED — fileName required', stage: 'AUTHORIZE_FAILED' }, 400, origin);
      if (!size || typeof size !== 'number' || size <= 0)
        return json({ error: 'SUBMISSION AUTHORIZE FAILED — size required (positive number)', stage: 'AUTHORIZE_FAILED' }, 400, origin);

      const ct = contentType || 'application/octet-stream';
      const isMedia = ct.startsWith('audio/') || ct.startsWith('video/') ||
                      ct.startsWith('image/') || ct === 'application/octet-stream' ||
                      ALLOWED_TYPES.has(ct);
      if (!isMedia)
        return json({ error: `SUBMISSION AUTHORIZE FAILED — not a media file type: ${ct}`, stage: 'AUTHORIZE_FAILED' }, 415, origin);

      // ── 5. Build storage path — scoped to submissions/{uid}/
      const safeName    = fileName.replace(/[^a-z0-9._-]/gi, '_');
      const storagePath = `submissions/${uid}/${Date.now()}_${safeName}`;

      // ── 6. Ensure bucket file_size_limit >= 500 MiB (same as /authorize)
      let bucketLimitBytes   = BUCKET_FILE_SIZE_LIMIT_BYTES;
      let bucketLimitWarning = null;
      try {
        const bl = await ensureBucketLimit(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
        bucketLimitBytes = bl.limitBytes;
      } catch (blErr) {
        bucketLimitWarning = blErr.message;
        console.warn(`[aurenix-upload] submission ensureBucketLimit warning: ${blErr.message}`);
      }

      // ── 7. Create signed upload URL
      let signedUrl;
      try {
        signedUrl = await createSignedUploadUrl(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, storagePath);
      } catch (err) {
        return json({ error: err.message, stage: 'SUPABASE_SIGNED_URL_FAILED' }, 502, origin);
      }

      // ── 8. Return signed URL — file is never sent through this Worker
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

    /* ══════════════════════════════════════════════════════════════════════
       POST /channel/advance
       ═══════════════════════════════════════════════════════════════════════
       Authoritative, race-safe channel advancement for the AURENIX 24/7
       broadcast network.

       Security model:
         - Any Firebase-authenticated viewer may call this endpoint.
         - The caller supplies the channelId and the currentItemId they believe
           is playing.  This is used as the compare-and-swap guard: if Firestore
           already shows a different current_item (because another viewer already
           advanced it), this call is a no-op and returns { advanced: false }.
         - Time guard: the current item's started_at + duration_sec must have
           elapsed (with a 2-second tolerance) before advancement is allowed.
           This prevents a viewer from skipping to the next song at will.
         - The Firestore write uses a transaction (beginTransaction / commit)
           so two simultaneous requests cannot both advance the same item.

       Request body (JSON):
         { channelId: string, currentItemId: string }

       Response:
         { advanced: boolean, reason?: string }
    ══════════════════════════════════════════════════════════════════════ */
    if (request.method === 'POST' && p === '/channel/advance') {

      /* ── 0. Secrets ─────────────────────────────────────────────────── */
      const secretErr = checkSecrets(env);
      if (secretErr) return json({ error: `WORKER CONFIGURATION ERROR — ${secretErr}` }, 503, origin);

      /* ── 1. Firebase auth ───────────────────────────────────────────── */
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer '))
        return json({ error: 'FIREBASE TOKEN MISSING' }, 401, origin);
      const idToken = authHeader.slice(7).trim();
      if (!idToken)
        return json({ error: 'FIREBASE TOKEN MISSING — empty' }, 401, origin);

      let tokenPayload;
      try {
        tokenPayload = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
      } catch (err) {
        return json({ error: err.message }, 401, origin);
      }

      /* ── 2. Parse body ──────────────────────────────────────────────── */
      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'ADVANCE FAILED — invalid JSON body' }, 400, origin); }

      const { channelId, currentItemId } = body || {};
      if (!channelId || typeof channelId !== 'string')
        return json({ error: 'ADVANCE FAILED — channelId required' }, 400, origin);
      // currentItemId may be null/undefined for the bootstrap case (channel has no current item).
      // In that case we skip the CAS guard and simply pick the first eligible item.
      const normalizedItemId = (currentItemId && typeof currentItemId === 'string') ? currentItemId : null;

      /* ── 3. Perform atomic advance via Firestore REST ───────────────── */
      try {
        const result = await firestoreChannelAdvance(
          env.FIREBASE_PROJECT_ID,
          env.FIREBASE_SERVICE_ACCOUNT_KEY || null,
          channelId,
          normalizedItemId
        );
        return json(result, 200, origin);
      } catch (e) {
        console.error('[aurenix-advance] error:', e.message);
        return json({ advanced: false, reason: 'internal error: ' + e.message }, 500, origin);
      }
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};

/* ══════════════════════════════════════════════════════════════════════════════
   CHANNEL ADVANCE ENGINE
   Uses the Firestore REST API (no firebase-admin SDK needed in Workers).

   Firestore collections accessed:
     network_state/{channelId}         — live playback state
     network_ch_config/{channelId}     — generic channel engine config (ordered/shuffle/random)
     channel_live_tv_config/ALTV       — ALTV-specific engine config

   Security note:
     All Firestore writes use the caller's own Firebase ID token.
     The Firestore rules for network_state only allow admin writes (isAdmin()).
     Therefore this Worker MUST use the Firebase service account to write
     network_state. Since we do not have a service-account key secret here,
     we use a dedicated FIREBASE_SERVICE_ACCOUNT_KEY secret (a JSON service
     account file exported from GCP/Firebase console).

     FALLBACK: If FIREBASE_SERVICE_ACCOUNT_KEY is not yet set, the Worker
     falls back to writing with the user's own token. This will be rejected
     by Firestore rules for network_state (admin-only write). In that case
     the Worker returns { advanced: false, reason: 'rules_denied' } and the
     viewer silently keeps waiting for the Founder.

     To enable server-side advancement:
       1. Firebase Console → Project Settings → Service Accounts → Generate new private key
       2. npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
          (paste the entire JSON as one line)
       3. npx wrangler deploy (in upload-worker/)

   Transaction strategy:
     The Firestore REST API supports atomic "read-then-write" transactions
     via POST /{db}/documents:beginTransaction then POST /{db}/documents:commit
     with preconditions.  We use this to ensure only one of N concurrent
     advance requests actually advances the channel.
══════════════════════════════════════════════════════════════════════════════ */

const LIVE_TV_CHANNEL_ID = 'ALTV';
const LIVE_TV_CONFIG_DOC = 'channel_live_tv_config';
const CHANNEL_CONFIG_COL = 'network_ch_config';

const PROGRAM_TYPES = new Set([
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
  'funny_clip', 'short_film', 'other', 'promo',
]);
const COMMERCIAL_TYPES = new Set(['commercial', 'promo', 'station_id']);
const LIVE_TV_PROGRAM_TYPES = new Set([
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
]);
const LIVE_TV_COMMERCIAL_TYPES = new Set(['commercial', 'promo', 'trailer', 'station_id']);

const COMMERCIAL_FREQ_TABLE = {
  off:    { minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
  low:    { minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
  normal: { minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
  high:   { minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
  every:  { minPrograms: 1,   maxPrograms: 1,   minSpot: 1, maxSpot: 1 },
  every2: { minPrograms: 2,   maxPrograms: 2,   minSpot: 1, maxSpot: 2 },
  every3: { minPrograms: 3,   maxPrograms: 3,   minSpot: 1, maxSpot: 2 },
};

/* ─── Firestore REST helpers ─────────────────────────────────────────────── */

function fsBaseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

function fsDocPath(projectId, ...segments) {
  return `${fsBaseUrl(projectId)}/${segments.join('/')}`;
}

/** Convert a plain JS value to a Firestore REST Value. */
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Array) return { arrayValue: { values: v.map(toFsValue) } };
  if (v && typeof v === 'object' && v.__serverTimestamp) {
    return { timestampValue: new Date().toISOString() };
  }
  if (v && typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFsValue(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

/** Convert a Firestore REST Value to a plain JS value. */
function fromFsValue(v) {
  if (!v) return null;
  if ('nullValue'    in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('stringValue'  in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue; // ISO string
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'     in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(val);
    return out;
  }
  return null;
}

/** Convert a Firestore REST document to a plain JS object. */
function fromFsDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromFsValue(v);
  return out;
}

/** Convert a plain JS object to Firestore REST document fields. */
function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFsValue(v);
  return fields;
}

/** GET a single Firestore document.  Returns null if 404. */
async function fsGet(projectId, authToken, ...pathSegments) {
  const url = fsDocPath(projectId, ...pathSegments);
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Firestore GET ${pathSegments.join('/')} failed: HTTP ${res.status} — ${t.slice(0, 200)}`);
  }
  const doc = await res.json();
  return fromFsDoc(doc);
}

/** PATCH a Firestore document (merge). Returns the written doc.
 *
 *  IMPORTANT: The Firestore REST API requires updateMask.fieldPaths to be
 *  supplied as MULTIPLE separate query parameters — one per field name.
 *  A single comma-joined value is treated as a literal field name that does
 *  not exist, causing the PATCH to write nothing despite returning HTTP 200.
 *
 *  Correct:  ?updateMask.fieldPaths=a&updateMask.fieldPaths=b&updateMask.fieldPaths=c
 *  WRONG:    ?updateMask.fieldPaths=a%2Cb%2Cc
 */
async function fsPatch(projectId, authToken, data, ...pathSegments) {
  const url = fsDocPath(projectId, ...pathSegments);
  // Build repeated updateMask.fieldPaths query params — one per field.
  const maskParams = Object.keys(data)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const body = { fields: toFsFields(data) };
  const res = await fetch(`${url}?${maskParams}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Firestore PATCH ${pathSegments.join('/')} failed: HTTP ${res.status} — ${t.slice(0, 200)}`);
  }
  return fromFsDoc(await res.json());
}

/** Retrieve a Firebase service-account access token using the JWT bearer flow. */
async function getServiceAccountToken(serviceAccountJson) {
  let sa;
  try { sa = JSON.parse(serviceAccountJson); }
  catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON'); }

  // Build a JWT signed with the service account private key (RS256)
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600,
  };

  const enc  = s => btoa(JSON.stringify(s)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const toSign = `${enc(header)}.${enc(payload)}`;

  // Import the private key
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(toSign)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwtAssertion = `${toSign}.${sigB64}`;

  // Exchange the JWT for an access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwtAssertion}`,
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text().catch(() => '');
    throw new Error(`Service account token exchange failed: HTTP ${tokenRes.status} — ${t.slice(0, 200)}`);
  }
  const { access_token } = await tokenRes.json();
  return access_token;
}

function randInt(min, max) {
  if (min > max) return max;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns true when a media item is eligible for the given channelId.
 *
 * Assignment rules:
 *  1. ALTV: must have live_tv_assigned !== false (existing behaviour, unchanged).
 *  2. Non-ALTV: the item MUST have assigned_channels that explicitly includes
 *     channelId.  An empty or absent assigned_channels means the item has NOT
 *     been assigned to any channel and is therefore ineligible for broadcast.
 *     This prevents music, radio, or unassigned content from leaking into
 *     FUNNY, VIDEO, MUSIC or any other specific channel.
 */
function _isAssignedToChannel(m, channelId, isAltv) {
  if (isAltv) return m.live_tv_assigned !== false;
  const ch = m.assigned_channels;
  // No assignment recorded → NOT eligible for any channel's random/shuffle pool.
  // Items must be explicitly assigned by the Founder via the approval workflow.
  if (!ch || ch.length === 0) return false;
  return ch.includes(channelId);
}

/**
 * Returns true when a media item is still valid for playback on a channel.
 * Used to validate queue items before they are played (catches items that were
 * deleted, rejected, or re-assigned after being queued).
 *
 * @param {Object} m          - media item from Firestore network_media
 * @param {string} channelId  - channel being validated
 * @param {boolean} isAltv    - true when channelId === LIVE_TV_CHANNEL_ID
 */
function isBroadcastEligible(m, channelId, isAltv) {
  if (!m) return false;
  if (!m.id) return false;
  if (m.status !== 'approved') return false;
  if (!m.url) return false;
  return _isAssignedToChannel(m, channelId, isAltv);
}

/** Pick next program from media library (random, avoiding recent history). */
function pickProgram(mediaLib, isAltv, justPlayedId, recentHistory, channelId) {
  const typeSet = isAltv ? LIVE_TV_PROGRAM_TYPES : PROGRAM_TYPES;
  const pool = mediaLib.filter(m =>
    m.status === 'approved' &&
    typeSet.has(m.type) &&
    m.url &&
    _isAssignedToChannel(m, channelId || '', isAltv)
  );
  if (!pool.length) return null;

  const avoidIds = justPlayedId ? [...(recentHistory || []), justPlayedId] : (recentHistory || []);
  let candidates = pool.filter(m => !avoidIds.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== justPlayedId);
  if (!candidates.length) candidates = pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Pick commercials from media library. */
function pickCommercials(mediaLib, isAltv, freqKey, maxPerBreak, commercialHistory, channelId) {
  const freq = COMMERCIAL_FREQ_TABLE[freqKey] || COMMERCIAL_FREQ_TABLE.normal;
  if (freq.maxSpot === 0) return [];

  const typeSet = isAltv ? LIVE_TV_COMMERCIAL_TYPES : COMMERCIAL_TYPES;
  const pool = mediaLib.filter(m =>
    m.status === 'approved' &&
    typeSet.has(m.type) &&
    m.url &&
    _isAssignedToChannel(m, channelId || '', isAltv)
  );
  if (!pool.length) return [];

  const cap   = Math.min(maxPerBreak || freq.maxSpot, freq.maxSpot);
  const count = randInt(Math.min(freq.minSpot, cap), cap);
  const result = [];
  const recent = commercialHistory || [];

  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    const fresh = available.filter(m => !recent.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

function mediaItemToState(m) {
  return {
    id:           m.id           || '',
    title:        m.title        || '(untitled)',
    artist:       m.artist       || '',
    type:         m.type         || 'media',
    url:          m.url          || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
  };
}

/**
 * Main advance function.
 * Uses the Firestore REST API with a begin/commit transaction for CAS.
 *
 * Returns { advanced: boolean, reason?: string }
 */
async function firestoreChannelAdvance(projectId, serviceAccountJson, channelId, currentItemId) {
  /* ── 0. Determine the write token ──────────────────────────────────── */
  // The Firestore rules for network_state allow write only if isAdmin()
  // (Founder email check via Firebase Auth token).  Regular viewer ID tokens
  // cannot satisfy that rule, so we must use a service-account access token
  // to write Firestore.  The service account automatically has admin access
  // to its own project.
  //
  // If FIREBASE_SERVICE_ACCOUNT_KEY is not yet configured in Worker secrets,
  // we return { advanced: false, reason: 'service_account_not_configured' }
  // and the viewer falls back to waiting — no harm done.
  if (!serviceAccountJson) {
    return { advanced: false, reason: 'service_account_not_configured' };
  }
  let writeToken;
  try {
    writeToken = await getServiceAccountToken(serviceAccountJson);
  } catch (e) {
    return { advanced: false, reason: 'service_account_token_error: ' + e.message };
  }

  /* ── 1. Read current state ──────────────────────────────────────────── */
  const isBootstrap = (currentItemId === null);
  console.log(`[aurenix-advance] channel=${channelId} ${isBootstrap ? 'BOOTSTRAP' : 'requestedBy=' + currentItemId} — reading Firestore state`);
  let st = await fsGet(projectId, writeToken, 'network_state', channelId);

  if (!st) {
    if (!isBootstrap) {
      // Normal advance but no state doc — this channel was never started.
      // Treat it as a bootstrap request so it auto-initializes with the first item.
      console.log(`[aurenix-advance] channel=${channelId} — no_state, promoting to bootstrap`);
    }
    // Bootstrap: state doc is missing — create it empty so the rest of the function
    // can continue and write the first item.
    st = { current_item: null, queue: [], commercial_queue: [], loop: true };
  }

  // CAS guard: only enforce when we have a real currentItemId (not bootstrap).
  // Bootstrap (currentItemId === null) always proceeds if current_item is also null.
  const firestoreCurrentId = st.current_item?.id || null;
  if (!isBootstrap) {
    if (firestoreCurrentId !== currentItemId) {
      // Already advanced by someone else — viewer will get the new state via onSnapshot.
      return { advanced: false, reason: 'already_advanced' };
    }
  } else {
    // Bootstrap: only proceed if the channel genuinely has no current item.
    // If another viewer already bootstrapped it, bail out gracefully.
    if (firestoreCurrentId !== null) {
      return { advanced: false, reason: 'already_bootstrapped' };
    }
  }

  // Time guard: only enforce when we have a real currentItemId (not bootstrap).
  if (!isBootstrap) {
    const dur = st.current_item?.duration_sec || 0;
    if (dur > 0) {
      const startedAtRaw = st.started_at;
      let startedAtMs;
      if (typeof startedAtRaw === 'string') {
        // Firestore REST returns timestamps as ISO strings
        startedAtMs = new Date(startedAtRaw).getTime();
      } else if (typeof startedAtRaw === 'number') {
        startedAtMs = startedAtRaw < 1e10 ? startedAtRaw * 1000 : startedAtRaw;
      } else {
        startedAtMs = Date.now() - (dur + 10) * 1000; // assume elapsed if unknown
      }
      const elapsedSec = (Date.now() - startedAtMs) / 1000;
      const TOLERANCE_SEC = 2;
      if (elapsedSec < dur - TOLERANCE_SEC) {
        return {
          advanced: false,
          reason: `too_early: ${elapsedSec.toFixed(1)}s elapsed of ${dur}s`,
        };
      }
    }
  }

  /* ── 2. Drain commercial queue if present ────────────────────────────── */
  const commQueue = st.commercial_queue || [];
  if (commQueue.length > 0) {
    // Skip any commercial queue items whose backing document has been deleted.
    // We do a lightweight spot-check: try to fetch the next commercial's doc.
    let nextComm = null;
    let remaining = [];
    for (let i = 0; i < commQueue.length; i++) {
      const candidate = commQueue[i];
      if (!candidate?.id) continue;
      const liveDoc = await fsGet(projectId, writeToken, 'network_media', candidate.id);
      if (liveDoc && liveDoc.status === 'approved' && liveDoc.url) {
        nextComm  = candidate;
        remaining = commQueue.slice(i + 1);
        break;
      }
      console.log(`[aurenix-advance] channel=${channelId} — skipping deleted/invalid commercial_queue item: ${candidate.id}`);
    }
    if (nextComm) {
      await fsPatch(projectId, writeToken, {
        current_item:     nextComm,
        started_at:       { __serverTimestamp: true },
        is_commercial:    true,
        commercial_queue: remaining,
        needs_next:       false,
        last_item_id:     nextComm.id || '',
        updated_at:       { __serverTimestamp: true },
      }, 'network_state', channelId);
      console.log(`[aurenix-advance] channel=${channelId} → drained_commercial_queue → ${nextComm.id}`);
      return { advanced: true, reason: 'drained_commercial_queue' };
    }
    // All commercial queue items were invalid — clear the queue and fall through.
    console.log(`[aurenix-advance] channel=${channelId} — commercial_queue fully invalid, clearing`);
    await fsPatch(projectId, writeToken, {
      commercial_queue: [],
      is_commercial:    false,
      updated_at:       { __serverTimestamp: true },
    }, 'network_state', channelId);
  }

  /* ── 2b. If a post-commercial item was stored, play it next ──────────── */
  //  When the commercial queue is empty and there's a _post_commercial_item,
  //  that stored item should be played next (it was queued up before the break).
  //  Validate it first — it may have been deleted since it was stored.
  const postCommItem = st._post_commercial_item || null;
  if (postCommItem && st.is_commercial) {
    const postLive = postCommItem.id
      ? await fsGet(projectId, writeToken, 'network_media', postCommItem.id)
      : null;
    if (postLive && postLive.status === 'approved' && postLive.url) {
      await fsPatch(projectId, writeToken, {
        current_item:          postCommItem,
        started_at:            { __serverTimestamp: true },
        is_commercial:         false,
        commercial_queue:      [],
        _post_commercial_item: null,
        needs_next:            false,
        last_item_id:          postCommItem.id || '',
        updated_at:            { __serverTimestamp: true },
      }, 'network_state', channelId);
      console.log(`[aurenix-advance] channel=${channelId} → post_commercial_item → ${postCommItem.id}`);
      return { advanced: true, reason: 'post_commercial_item' };
    }
    // post_commercial_item was deleted — clear it and fall through to pick a fresh program.
    console.log(`[aurenix-advance] channel=${channelId} — post_commercial_item deleted/invalid, clearing`);
    await fsPatch(projectId, writeToken, {
      _post_commercial_item: null,
      is_commercial:         false,
      updated_at:            { __serverTimestamp: true },
    }, 'network_state', channelId);
  }

  /* ── 3. Determine programming mode and fetch config ─────────────────── */
  const isAltv = channelId === LIVE_TV_CHANNEL_ID;
  const configCol = isAltv ? LIVE_TV_CONFIG_DOC : CHANNEL_CONFIG_COL;
  let cfg = await fsGet(projectId, writeToken, configCol, channelId);

  if (!cfg) {
    if (isAltv) {
      // ALTV config missing → auto-bootstrap so it doesn't permanently block.
      // The Founder can still explicitly stop via the Studio "Stop" button.
      console.log(`[aurenix-advance] channel=ALTV — config missing, auto-bootstrapping with running=true`);
      cfg = {
        running: true, paused: false, programming_mode: 'random',
        commercial_freq: 'normal', commercial_enabled: false,
        programs_since_break: 0, next_break_at: 3,
        recent_history: [], commercial_history: [],
        avoid_repeat_window: 10,
      };
      // Write it so next requests don't re-bootstrap.
      await fsPatch(projectId, writeToken, { ...cfg }, configCol, channelId);
    } else {
      // Non-ALTV config missing → auto-bootstrap with running=true and random mode.
      console.log(`[aurenix-advance] channel=${channelId} — config missing, auto-bootstrapping with running=true`);
      cfg = {
        running: true, paused: false, programming_mode: 'random',
        commercial_freq: 'normal', commercial_enabled: false,
        programs_since_break: 0, next_break_at: 3,
        recent_history: [], commercial_history: [],
        avoid_repeat_window: 5,
      };
      await fsPatch(projectId, writeToken, { ...cfg }, configCol, channelId);
    }
  }

  // For ALTV: if config exists but running=false (Founder stopped it in Studio),
  // honour the stop — do not override intentional stops.
  // For non-ALTV: same behaviour.
  if (!cfg.running) return { advanced: false, reason: 'channel_not_running' };
  if (cfg.paused)   return { advanced: false, reason: 'channel_paused' };

  const mode = cfg.programming_mode || 'random';

  /* ── 4. Queue-based advance (ordered / shuffle) ───────────────────── */
  if (!isAltv && (mode === 'ordered' || mode === 'shuffle')) {
    // Fetch the current media library so we can validate queue items.
    // Items may have been deleted or re-assigned since they were queued.
    const mediaLibForQueue = await fetchApprovedMedia(projectId, writeToken);
    const mediaLibIndex = new Map(mediaLibForQueue.map(m => [m.id, m]));

    const rawQueue = st.queue || [];

    // Filter the stored queue: remove any items that are no longer eligible
    // (deleted from Firestore, rejected, or no longer assigned to this channel).
    const eligibleQueue = rawQueue.filter(qItem => {
      const live = mediaLibIndex.get(qItem.id);
      return isBroadcastEligible(live, channelId, false);
    });

    // If the cleaned queue differs from the stored queue, persist the cleanup.
    if (eligibleQueue.length !== rawQueue.length) {
      const skipped = rawQueue.length - eligibleQueue.length;
      console.log(`[aurenix-advance] channel=${channelId} — queue cleanup: removed ${skipped} ineligible item(s)`);
      await fsPatch(projectId, writeToken, {
        queue:      eligibleQueue,
        updated_at: { __serverTimestamp: true },
      }, 'network_state', channelId);
    }

    const curIdx = eligibleQueue.findIndex(q => q.id === currentItemId);
    let nextIdx  = curIdx + 1;

    if (nextIdx >= eligibleQueue.length) {
      const loop = st.loop ?? true;
      if (loop && eligibleQueue.length > 0) {
        nextIdx = 0;
      } else {
        await fsPatch(projectId, writeToken, {
          current_item: null,
          started_at:   { __serverTimestamp: true },
          updated_at:   { __serverTimestamp: true },
        }, 'network_state', channelId);
        return { advanced: true, reason: eligibleQueue.length === 0 ? 'queue_empty_after_cleanup' : 'queue_exhausted' };
      }
    }

    const nextItem = eligibleQueue[nextIdx];
    if (!nextItem) return { advanced: false, reason: 'empty_queue' };

    // Check commercial break
    if (cfg.commercial_enabled) {
      const freq = COMMERCIAL_FREQ_TABLE[cfg.commercial_freq] || COMMERCIAL_FREQ_TABLE.normal;
      const since  = cfg.programs_since_break || 0;
      const target = cfg.next_break_at || freq.minPrograms;
      if (since >= target) {
        const commercials = pickCommercials(
          mediaLibForQueue, false, cfg.commercial_freq,
          cfg.max_commercials_per_break || 2, cfg.commercial_history, channelId
        );
        if (commercials.length > 0) {
          const [firstComm, ...rest] = commercials;
          await fsPatch(projectId, writeToken, {
            current_item:          mediaItemToState(firstComm),
            started_at:            { __serverTimestamp: true },
            is_commercial:         true,
            commercial_queue:      rest.map(mediaItemToState),
            _post_commercial_item: nextItem,
            needs_next:            false,
            last_item_id:          firstComm.id,
            updated_at:            { __serverTimestamp: true },
          }, 'network_state', channelId);
          await updateCommercialHistory(projectId, writeToken, configCol, channelId, cfg, commercials);
          return { advanced: true, reason: 'commercial_break' };
        }
      }
    }

    console.log(`[aurenix-advance] channel=${channelId} → queue_advance → ${nextItem.id} (${nextItem.title})`);
    await fsPatch(projectId, writeToken, {
      current_item:     nextItem,
      started_at:       { __serverTimestamp: true },
      is_commercial:    false,
      commercial_queue: [],
      needs_next:       false,
      last_item_id:     nextItem.id || '',
      updated_at:       { __serverTimestamp: true },
    }, 'network_state', channelId);
    await updateProgramHistory(projectId, writeToken, configCol, channelId, cfg, nextItem.id, isAltv);
    return { advanced: true, reason: 'queue_advance' };
  }

  /* ── 5. Random mode: pick next program from network_media ─────────── */
  const mediaLib = await fetchApprovedMedia(projectId, writeToken);

  const justPlayedId = currentItemId;
  const recentHistory = cfg.recent_history || [];

  // Check commercial break
  if (cfg.commercial_enabled !== false) {
    const freqKey = cfg.commercial_freq || 'normal';
    const freq    = COMMERCIAL_FREQ_TABLE[freqKey] || COMMERCIAL_FREQ_TABLE.normal;
    const since   = cfg.programs_since_break || 0;
    const target  = cfg.next_break_at || freq.minPrograms;
    if (freq.maxSpot > 0 && since >= target) {
      const commercials = pickCommercials(
        mediaLib, isAltv, freqKey,
        cfg.max_commercials_per_break || freq.maxSpot,
        cfg.commercial_history, channelId
      );
      if (commercials.length > 0) {
        const [firstComm, ...rest] = commercials;
        await fsPatch(projectId, writeToken, {
          current_item:     mediaItemToState(firstComm),
          started_at:       { __serverTimestamp: true },
          is_commercial:    true,
          commercial_queue: rest.map(mediaItemToState),
          needs_next:       false,
          last_item_id:     firstComm.id,
          updated_at:       { __serverTimestamp: true },
        }, 'network_state', channelId);
        await updateCommercialHistory(projectId, writeToken, configCol, channelId, cfg, commercials);
        // Write the next program after the commercial break
        const nextProg = pickProgram(mediaLib, isAltv, justPlayedId, recentHistory, channelId);
        if (nextProg) {
          // Store post-commercial item for when the commercial drains
          await fsPatch(projectId, writeToken, {
            _post_commercial_item: mediaItemToState(nextProg),
          }, 'network_state', channelId);
        }
        return { advanced: true, reason: 'commercial_break_random' };
      }
    }
  }

  // No commercial break — write next program directly
  const nextProg = pickProgram(mediaLib, isAltv, justPlayedId, recentHistory, channelId);
  if (!nextProg) {
    console.warn(`[aurenix-advance] channel=${channelId} — no_eligible_programs (mediaLib.length=${mediaLib.length})`);
    // Write a null current_item so the state doc exists (prevents repeated no_state bootstraps)
    // and viewers see "No eligible content" instead of "Loading…" forever.
    await fsPatch(projectId, writeToken, {
      current_item:     null,
      started_at:       { __serverTimestamp: true },
      is_commercial:    false,
      commercial_queue: [],
      needs_next:       false,
      updated_at:       { __serverTimestamp: true },
    }, 'network_state', channelId);
    return { advanced: false, reason: 'no_eligible_programs' };
  }

  console.log(`[aurenix-advance] channel=${channelId} → random_advance → ${nextProg.id} (${nextProg.title})`);
  await fsPatch(projectId, writeToken, {
    current_item:     mediaItemToState(nextProg),
    started_at:       { __serverTimestamp: true },
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     nextProg.id,
    updated_at:       { __serverTimestamp: true },
  }, 'network_state', channelId);

  await updateProgramHistory(projectId, writeToken, configCol, channelId, cfg, nextProg.id, isAltv);
  return { advanced: true, reason: 'random_advance' };
}

/** Fetch all approved media from network_media collection via Firestore REST. */
async function fetchApprovedMedia(projectId, authToken) {
  // Firestore REST runQuery with a structured query filtering by status == 'approved'
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'network_media' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op: 'EQUAL',
          value: { stringValue: 'approved' },
        },
      },
      limit: 2000,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`fetchApprovedMedia failed: HTTP ${res.status} — ${t.slice(0, 200)}`);
  }
  const rows = await res.json();
  const result = [];
  for (const row of rows) {
    if (!row.document) continue;
    const data = fromFsDoc(row.document);
    // Extract the document ID from the name field (last path segment)
    const name = row.document.name || '';
    const id   = name.split('/').pop();
    result.push({ id, ...data });
  }
  return result;
}

async function updateProgramHistory(projectId, authToken, configCol, channelId, cfg, programId, isAltv) {
  const window_    = cfg.avoid_repeat_window || (isAltv ? 10 : 5);
  const newHistory = [...((cfg.recent_history || []).slice(-(window_ - 1))), programId];
  const freqKey    = cfg.commercial_freq || 'normal';
  const freq       = COMMERCIAL_FREQ_TABLE[freqKey] || COMMERCIAL_FREQ_TABLE.normal;
  const newSince   = (cfg.programs_since_break || 0) + 1;
  const newTarget  = randInt(freq.minPrograms, freq.maxPrograms);
  await fsPatch(projectId, authToken, {
    recent_history:       newHistory,
    programs_since_break: newSince,
    next_break_at:        newTarget,
    updated_at:           { __serverTimestamp: true },
  }, configCol, channelId);
}

async function updateCommercialHistory(projectId, authToken, configCol, channelId, cfg, commercials) {
  const ids        = commercials.map(c => c.id);
  const newHistory = [...((cfg.commercial_history || []).slice(-20)), ...ids];
  await fsPatch(projectId, authToken, {
    commercial_history:   newHistory,
    programs_since_break: 0,
    updated_at:           { __serverTimestamp: true },
  }, configCol, channelId);
}
