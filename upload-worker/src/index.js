/**
 * AURENIX — Founder Upload Worker  (v4 — TUS authorisation gate)
 * upload-worker/src/index.js
 *
 * ARCHITECTURE CHANGE (v4):
 *   Previous versions proxied the entire file through this Worker.
 *   That caused HTTP 413 on files > the Supabase bucket's default 50 MB limit,
 *   and would hit the Cloudflare Workers 100 MB request-body ceiling on large media.
 *
 *   v4 never touches the file.  The Worker is an AUTHORISATION GATE only:
 *     1. Browser sends:  Firebase ID token + desired storage path + file size (tiny JSON)
 *     2. Worker verifies the Firebase JWT against Google's JWK public keys
 *     3. Worker checks token.email == FOUNDER_EMAIL
 *     4. Worker creates a TUS upload resource on Supabase Storage using the
 *        service-role key and returns the resulting Location URL
 *     5. Browser streams the file directly to that TUS URL (no Worker in the path)
 *
 *   Result: arbitrarily large files, real resumable uploads, zero Worker body limit.
 *
 * Endpoints:
 *   POST /authorize  — JSON body: { path, size, contentType }
 *                      Returns: { tusUrl, storagePath, publicUrl }
 *   GET  /health     — checks secrets present (never reveals values)
 *   GET  /diagnose   — deep diagnostic (Supabase + Firebase connectivity)
 *
 * Environment secrets (set via `wrangler secret put`):
 *   SUPABASE_URL          — https://nxsyoreuwmmxtuvmeqbg.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service-role JWT (eyJ..., NOT sb_secret_...)
 *   FIREBASE_PROJECT_ID   — remix-studio-4bf8a
 */

/* ─── Constants ───────────────────────────────────────────────────────────── */
const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const MEDIA_BUCKET  = 'aurenix-media';

// Allowed MIME types
const ALLOWED_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-ms-wmv', 'video/mpeg',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
]);

const MAX_BYTES = 524_288_000; // 500 MiB — enforced at authorisation time

/* ─── CORS ────────────────────────────────────────────────────────────────── */
function corsHeaders(origin) {
  const allowed = [
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

/* ─── Supabase TUS: create an upload resource ─────────────────────────────── */

/**
 * Creates a TUS upload resource on Supabase Storage using the service-role key.
 * Returns the Location header value — that is the URL the browser uploads to directly.
 *
 * The file never passes through this Worker.
 *
 * @param {string} supabaseUrl
 * @param {string} serviceKey   — must be the JWT service-role key (eyJ...)
 * @param {string} storagePath  — e.g. "media/<uid>/<ts>_file.mp4"
 * @param {number} fileSize     — total byte length
 * @param {string} contentType  — MIME type
 * @returns {Promise<string>}   — TUS Location URL
 */
async function createTusUpload(supabaseUrl, serviceKey, storagePath, fileSize, contentType) {
  // TUS metadata values must be base64-encoded
  const b64 = v => btoa(unescape(encodeURIComponent(v)));

  const metadata = [
    `bucketName ${b64(MEDIA_BUCKET)}`,
    `objectName ${b64(storagePath)}`,
    `contentType ${b64(contentType)}`,
    `cacheControl ${b64('3600')}`,
  ].join(',');

  const res = await fetch(`${supabaseUrl}/storage/v1/upload/resumable`, {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${serviceKey}`,
      'apikey':           serviceKey,
      'Tus-Resumable':   '1.0.0',
      'Upload-Length':    String(fileSize),
      'Upload-Metadata':  metadata,
      'Content-Length':  '0',
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SUPABASE TUS CREATE FAILED — HTTP ${res.status}: ${detail}`);
  }

  const location = res.headers.get('Location');
  if (!location) throw new Error('SUPABASE TUS CREATE FAILED — no Location header in response');
  return location;
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
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);

    /* ── GET /health ─────────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/health') {
      const err = checkSecrets(env);
      return json({
        ok:      !err,
        worker:  'aurenix-upload',
        version: '2025-09-06-v4-tus',
        SUPABASE_URL:        env.SUPABASE_URL         ? '✓ set' : '✗ MISSING',
        SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID  ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID_value: env.FIREBASE_PROJECT_ID || null,
        SUPABASE_URL_value:        env.SUPABASE_URL || null,
        architecture: 'TUS — Worker authorises only; browser uploads directly to Supabase',
        error: err || null,
      }, err ? 503 : 200, origin);
    }

    /* ── GET /diagnose ───────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/diagnose') {
      const diag = { worker: 'aurenix-upload', version: '2025-09-06-v4-tus', steps: {} };

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

    /* ── POST /authorize — Founder-only TUS authorisation ────────────────── */
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
      if (!contentType || !ALLOWED_TYPES.has(contentType))
        return json({ error: `AUTHORIZE FAILED — file type not allowed: ${contentType}`, stage: 'AUTHORIZE_FAILED' }, 415, origin);
      if (!size || typeof size !== 'number' || size <= 0)
        return json({ error: 'AUTHORIZE FAILED — size required (positive number)', stage: 'AUTHORIZE_FAILED' }, 400, origin);
      if (size > MAX_BYTES)
        return json({ error: `FILE TOO LARGE — ${Math.round(size/1048576)} MB exceeds 500 MB limit`, stage: 'AUTHORIZE_FAILED' }, 413, origin);

      // ── 5. Build storage path
      const uid      = tokenPayload.sub;
      const safeName = fileName.replace(/[^a-z0-9._-]/gi, '_');
      const storagePath = `media/${uid}/${Date.now()}_${safeName}`;

      // ── 6. Create TUS upload resource on Supabase (service-role key, server-side)
      let tusLocation;
      try {
        tusLocation = await createTusUpload(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, storagePath, size, contentType);
      } catch (err) {
        return json({ error: err.message, stage: 'SUPABASE_TUS_CREATE_FAILED' }, 502, origin);
      }

      // ── 7. Return TUS URL + storage path to browser — file is never sent here
      const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;
      return json({
        ok:           true,
        tusUrl:       tusLocation,
        storagePath,
        publicUrl,
        uploadedBy:   tokenEmail,
        authorizedAt: new Date().toISOString(),
      }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
