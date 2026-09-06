/**
 * AURENIX — Founder Upload Worker  (v5 — signed-URL authorisation gate)
 * upload-worker/src/index.js
 *
 * ARCHITECTURE (v5):
 *   The Worker is an authorisation gate only — it never touches the file.
 *
 *   Why not TUS PATCH?
 *     Supabase TUS PATCH requires Authorization: Bearer <service-role-key> on
 *     every chunk.  The browser cannot hold the service-role key.
 *     TUS PATCH without it returns 403 "Invalid Compact JWS".
 *
 *   Solution — Supabase signed upload URL:
 *     1. Browser sends Firebase ID token + fileName + contentType + size (tiny JSON)
 *     2. Worker verifies Firebase JWT (Google JWK, RS256)
 *     3. Worker checks token.email == FOUNDER_EMAIL
 *     4. Worker calls POST /storage/v1/object/upload/sign/<bucket>/<path>
 *        using the service-role key — returns a signed URL with ?token=...
 *     5. Worker returns the full signed URL to the browser
 *     6. Browser PUTs the file directly to that signed URL
 *        — no Authorization header needed, the token is in the URL query string
 *        — supports up to 500 MB (bucket file_size_limit)
 *        — XHR upload.onprogress gives byte-accurate progress
 *
 * Endpoints:
 *   POST /authorize  — JSON: { fileName, contentType, size }
 *                      Returns: { signedUrl, storagePath, publicUrl }
 *   GET  /health     — secrets present check (never reveals values)
 *   GET  /diagnose   — full connectivity diagnostic
 *
 * Environment secrets (set via `wrangler secret put`):
 *   SUPABASE_URL          — https://nxsyoreuwmmxtuvmeqbg.supabase.co
 *   SUPABASE_SERVICE_KEY  — service-role JWT (eyJ..., NOT sb_secret_...)
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
        version: '2025-09-06-v5-signed-url',
        SUPABASE_URL:        env.SUPABASE_URL         ? '✓ set' : '✗ MISSING',
        SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID  ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID_value: env.FIREBASE_PROJECT_ID || null,
        SUPABASE_URL_value:        env.SUPABASE_URL || null,
        architecture: 'Signed URL — browser PUT to /object/upload/sign/<bucket>/<path>?token=',
        error: err || null,
      }, err ? 503 : 200, origin);
    }

    /* ── GET /diagnose ───────────────────────────────────────────────────── */
    if (request.method === 'GET' && url.pathname === '/diagnose') {
      const diag = { worker: 'aurenix-upload', version: '2025-09-06-v5-signed-url', steps: {} };

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

      // ── 6. Create signed upload URL (service-role key, server-side only)
      //    Browser PUTs directly to this URL — no Authorization header needed,
      //    the ?token= query parameter is the authorisation.
      let signedUrl;
      try {
        signedUrl = await createSignedUploadUrl(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, storagePath);
      } catch (err) {
        return json({ error: err.message, stage: 'SUPABASE_SIGNED_URL_FAILED' }, 502, origin);
      }

      // ── 7. Return signed URL + paths to browser — file is never sent here
      const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;
      return json({
        ok:          true,
        signedUrl,
        storagePath,
        publicUrl,
        uploadedBy:  tokenEmail,
        authorizedAt: new Date().toISOString(),
      }, 200, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};
