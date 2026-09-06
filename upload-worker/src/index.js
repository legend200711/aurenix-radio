/**
 * AURENIX — Founder Upload Worker
 * upload-worker/src/index.js
 *
 * Cloudflare Worker — secure server-side bridge between Firebase Auth
 * and Supabase Storage for Founder-only media uploads.
 *
 * SECURITY MODEL:
 *   1. Browser sends: Firebase ID token + file (multipart form-data)
 *   2. Worker verifies the Firebase JWT against Google's public keys
 *   3. Worker checks token email == FOUNDER_EMAIL
 *   4. Only then does it upload to Supabase using the service-role key
 *   5. The service-role key NEVER leaves the server
 *
 * Environment secrets (set via `wrangler secret put`):
 *   SUPABASE_URL          — https://nxsyoreuwmmxtuvmeqbg.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service-role key (never in browser)
 *   FIREBASE_PROJECT_ID   — remix-studio-4bf8a
 *
 * Endpoints:
 *   POST /upload    — multipart upload (Authorization: Bearer <firebase-token>)
 *   GET  /health    — diagnostic (checks secrets are present; never reveals values)
 *   GET  /diagnose  — deep diagnostic (tests Supabase connection; never reveals key)
 *
 * Deploy:
 *   cd upload-worker && npx wrangler deploy
 */

/* ─── Constants ───────────────────────────────────────────────────────────── */
const FOUNDER_EMAIL  = 'christijerina46@gmail.com';
const MEDIA_BUCKET   = 'aurenix-media';
const MAX_BYTES      = 524_288_000;  // 500 MiB — matches aurenix-control.js MAX_FILE_MB

// Allowed MIME types (mirrors aurenix-storage-restore.sql)
const ALLOWED_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/aac', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-ms-wmv', 'video/mpeg',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
]);

/* ─── CORS helper ─────────────────────────────────────────────────────────── */
function corsHeaders(origin) {
  // Only allow AURENIX origins — adjust if you add a custom domain
  const allowed = [
    'https://remix-studio-4bf8a.web.app',
    'https://remix-studio-4bf8a.firebaseapp.com',
    'https://aurenix.com',
    'https://www.aurenix.com',
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1',
  ];
  const h = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name, X-File-Path',
    'Access-Control-Max-Age':       '86400',
  };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
  } else {
    // For development / testing convenience — tighten to exact domain in prod
    h['Access-Control-Allow-Origin'] = '*';
  }
  return h;
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

/* ─── Firebase JWT verification ───────────────────────────────────────────── */

/**
 * Fetch Google's Firebase public keys as JWKs.
 *
 * We use the JWK endpoint (not the x509 endpoint) because:
 *   - The x509 endpoint returns full X.509 certificates (DER starts with 30 82)
 *   - Web Crypto importKey('spki') requires a SubjectPublicKeyInfo DER, NOT a full cert
 *   - The JWK endpoint gives us RSA key parameters (n, e) directly as JWK objects
 *   - importKey('jwk', ...) works natively with those parameters — no DER parsing needed
 *
 * Keys are indexed by `kid` for O(1) lookup.
 */
async function getFirebasePublicKeys() {
  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    { cf: { cacheTtl: 3600, cacheEverything: true } }
  );
  if (!res.ok) throw new Error('Failed to fetch Firebase public JWKs — HTTP ' + res.status);
  const { keys } = await res.json();
  // Index by kid for fast lookup
  const map = {};
  for (const k of keys) map[k.kid] = k;
  return map;
}

/**
 * Import a JWK RSA public key as a CryptoKey for RS256 signature verification.
 *
 * @param {object} jwk — JWK object with kty, n, e, alg, use fields
 * @returns {Promise<CryptoKey>}
 */
async function importJwkKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

/**
 * Decode a base64url-encoded string to a Uint8Array.
 */
function b64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

/**
 * Verify a Firebase ID token and return its payload.
 * Throws a descriptive Error on any verification failure.
 *
 * @param {string} idToken   — raw JWT string from Authorization: Bearer <token>
 * @param {string} projectId — Firebase project ID (env.FIREBASE_PROJECT_ID)
 * @returns {Promise<object>} verified JWT payload
 */
async function verifyFirebaseToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('FIREBASE TOKEN INVALID — malformed token (not 3 parts)');

  let header, payload;
  try {
    header  = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new Error('FIREBASE TOKEN INVALID — token decode error');
  }

  // Algorithm must be RS256
  if (header.alg !== 'RS256') {
    throw new Error('FIREBASE TOKEN INVALID — unexpected algorithm: ' + header.alg);
  }

  // Verify timing claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp  && payload.exp  < now)       throw new Error('FIREBASE TOKEN EXPIRED — please sign out and sign in again');
  if (payload.iat  && payload.iat  > now + 300) throw new Error('FIREBASE TOKEN INVALID — token issued in future');
  if (payload.auth_time && payload.auth_time > now + 300) throw new Error('FIREBASE TOKEN INVALID — auth_time in future');

  // Audience must match project ID
  if (payload.aud !== projectId) {
    throw new Error('FIREBASE TOKEN INVALID — wrong audience: ' + payload.aud + ' (expected: ' + projectId + ')');
  }

  // Issuer must match project
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('FIREBASE TOKEN INVALID — wrong issuer: ' + payload.iss);
  }

  // Subject must be present
  if (!payload.sub) throw new Error('FIREBASE TOKEN INVALID — missing subject (uid)');

  // Fetch Google's JWK public keys and find the one matching this token's key ID
  const keyMap = await getFirebasePublicKeys();
  const jwk    = keyMap[header.kid];
  if (!jwk) throw new Error('FIREBASE TOKEN INVALID — unknown key ID: ' + header.kid);

  // Import the JWK and verify the RS256 signature
  const key       = await importJwkKey(jwk);
  const sigInput  = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const signature = b64urlDecode(parts[2]);
  const valid     = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, sigInput);
  if (!valid) throw new Error('FIREBASE TOKEN INVALID — signature verification failed');

  return payload;
}

/* ─── Supabase Storage upload (service-role) ──────────────────────────────── */

/**
 * Upload a file to Supabase Storage using the service-role key.
 * The service-role key bypasses RLS entirely — this is intentional and
 * safe because the caller has already verified the Founder identity above.
 *
 * @param {string}     supabaseUrl   — env.SUPABASE_URL
 * @param {string}     serviceKey    — env.SUPABASE_SERVICE_KEY
 * @param {string}     storagePath   — e.g. "media/uid123/1234_file.mp3"
 * @param {ReadableStream|ArrayBuffer} body — file body
 * @param {string}     contentType   — MIME type
 * @returns {Promise<{ publicUrl: string, storagePath: string }>}
 */
async function supabaseUpload(supabaseUrl, serviceKey, storagePath, body, contentType) {
  const url = `${supabaseUrl}/storage/v1/object/${MEDIA_BUCKET}/${storagePath}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${serviceKey}`,
      'apikey':          serviceKey,
      'Content-Type':    contentType,
      'x-upsert':       'true',
      'Cache-Control':  '3600',
    },
    body,
    // Stream the body — do not buffer 500 MB files in memory
    duplex: 'half',
  });

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`SUPABASE STORAGE UPLOAD FAILED — HTTP ${res.status}: ${detail}`);
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;
  return { publicUrl, storagePath };
}

/* ─── Supabase service-key shape check ────────────────────────────────────── */

/**
 * Check the shape of the service key WITHOUT revealing it.
 * Returns a safe diagnostic string only.
 *
 * A valid Supabase service-role key is a JWT:
 *   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<signature>
 *
 * Common mistakes:
 *   - Using the anon/publishable key instead of service-role key
 *   - Using the sb_publishable_... format key (not a JWT)
 *   - Copying with extra whitespace or newlines
 *   - Truncated key
 */
function describeKeyShape(key) {
  if (!key) return 'MISSING';
  const trimmed = key.trim();
  if (trimmed !== key) return 'HAS_LEADING_OR_TRAILING_WHITESPACE';
  if (trimmed.startsWith('sb_publishable_')) return 'WRONG_KEY — this is the anon/publishable key, not the service-role key. Go to Supabase Dashboard → Settings → API and copy the service_role key (starts with eyJ...)';
  if (trimmed.startsWith('sb_secret_'))     return 'WRONG_KEY — sb_secret_ format keys do NOT work for Storage uploads. Go to Supabase Dashboard → Settings → API and copy the service_role key (starts with eyJ...). The sb_secret_ key is a new Supabase format that Supabase Storage does not yet accept as a Bearer token.';
  const parts = trimmed.split('.');
  if (parts.length !== 3) return `NOT_A_JWT — only ${parts.length} dot-separated part(s) (expected 3)`;
  if (!trimmed.startsWith('eyJ')) return 'NOT_A_JWT — does not start with eyJ (expected JWT header)';
  // Try to decode the payload to check the role claim
  try {
    const payloadStr = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      parts[1].length + (4 - parts[1].length % 4) % 4, '='
    ));
    const payload = JSON.parse(payloadStr);
    const role = payload.role || '(no role claim)';
    if (role === 'service_role') return 'OK — JWT with role=service_role';
    if (role === 'anon')         return `WRONG_KEY — JWT has role=${role} (this is the anon key, not service-role)`;
    return `JWT_ROLE=${role} — expected service_role`;
  } catch {
    return 'JWT_PAYLOAD_UNREADABLE — possibly truncated or corrupted';
  }
}

/* ─── Secret validation ───────────────────────────────────────────────────── */

/**
 * Validate that all required secrets are present.
 * Returns a descriptive error string, or null if all are present.
 * NEVER returns the actual secret values.
 */
function checkSecrets(env) {
  if (!env.SUPABASE_URL)         return 'SUPABASE_URL secret is not configured in this Worker';
  if (!env.SUPABASE_SERVICE_KEY) return 'SUPABASE_SERVICE_KEY secret is not configured in this Worker';
  if (!env.FIREBASE_PROJECT_ID)  return 'FIREBASE_PROJECT_ID secret is not configured in this Worker';
  return null;
}

/* ─── Worker entry point ──────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    // ── GET /health — basic diagnostic endpoint ────────────────────────────
    // Returns whether each secret is present (never the value itself).
    if (request.method === 'GET' && url.pathname === '/health') {
      const secretErr = checkSecrets(env);
      return jsonResponse({
        ok:                  !secretErr,
        worker:              'aurenix-upload',
        version:             '2025-09-06-v3',
        SUPABASE_URL:        env.SUPABASE_URL         ? '✓ set' : '✗ MISSING',
        SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID  ? '✓ set' : '✗ MISSING',
        FIREBASE_PROJECT_ID_value: env.FIREBASE_PROJECT_ID || null,   // safe to reveal (not a secret)
        SUPABASE_URL_value:        env.SUPABASE_URL || null,           // safe to reveal (not a secret)
        error:               secretErr || null,
      }, secretErr ? 503 : 200, origin);
    }

    // ── GET /diagnose — deep diagnostic endpoint ───────────────────────────
    // Tests:
    //   1. Whether all secrets are present
    //   2. Whether SUPABASE_SERVICE_KEY looks like a valid service-role JWT
    //   3. Whether the Supabase connection actually works (bucket list)
    //   4. Whether Firebase public keys are reachable
    // NEVER reveals the actual key value.
    if (request.method === 'GET' && url.pathname === '/diagnose') {
      const diag = {
        worker:  'aurenix-upload',
        version: '2025-09-06-v3',
        steps:   {},
      };

      // Step 1: Check secrets present
      const secretErr = checkSecrets(env);
      diag.steps.secrets_present = secretErr ? `FAIL — ${secretErr}` : 'OK';

      // Step 2: Inspect service key shape (safe — never reveals value)
      diag.steps.service_key_shape = describeKeyShape(env.SUPABASE_SERVICE_KEY);

      // Step 3: Test Supabase connection (list buckets — quick, no file needed)
      try {
        const sbRes = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket`, {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey':         env.SUPABASE_SERVICE_KEY,
          },
        });
        const body = await sbRes.text();
        if (sbRes.ok) {
          let buckets = [];
          try { buckets = JSON.parse(body).map(b => b.id || b.name); } catch { /* ignore */ }
          diag.steps.supabase_connection = `OK — HTTP ${sbRes.status}, buckets: ${JSON.stringify(buckets)}`;
        } else {
          diag.steps.supabase_connection = `FAIL — HTTP ${sbRes.status}: ${body}`;
        }
      } catch (err) {
        diag.steps.supabase_connection = `FAIL — fetch error: ${err.message}`;
      }

      // Step 4: Confirm aurenix-media bucket exists
      try {
        const bucketRes = await fetch(`${env.SUPABASE_URL}/storage/v1/bucket/${MEDIA_BUCKET}`, {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey':         env.SUPABASE_SERVICE_KEY,
          },
        });
        const body = await bucketRes.text();
        if (bucketRes.ok) {
          diag.steps.media_bucket = `OK — ${MEDIA_BUCKET} exists (HTTP ${bucketRes.status})`;
        } else {
          diag.steps.media_bucket = `FAIL — HTTP ${bucketRes.status}: ${body}`;
        }
      } catch (err) {
        diag.steps.media_bucket = `FAIL — fetch error: ${err.message}`;
      }

      // Step 5: Test Firebase public keys reachability
      try {
        const fbRes = await fetch(
          'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
        );
        if (fbRes.ok) {
          const keys = await fbRes.json();
          const keyIds = Object.keys(keys);
          diag.steps.firebase_public_keys = `OK — ${keyIds.length} key(s) available`;
        } else {
          diag.steps.firebase_public_keys = `FAIL — HTTP ${fbRes.status}`;
        }
      } catch (err) {
        diag.steps.firebase_public_keys = `FAIL — ${err.message}`;
      }

      // Overall status
      const allOk = Object.values(diag.steps).every(v => v.startsWith('OK'));
      diag.overall = allOk ? 'ALL OK — Worker is fully operational' : 'ISSUES DETECTED — see steps above';

      // Provide fix instructions for the most common problem
      if (diag.steps.service_key_shape && !diag.steps.service_key_shape.startsWith('OK')) {
        diag.fix = [
          'The SUPABASE_SERVICE_KEY is wrong.',
          '1. Go to: https://supabase.com/dashboard/project/nxsyoreuwmmxtuvmeqbg/settings/api',
          '2. Copy the "service_role" key (starts with eyJ..., NOT sb_publishable_...)',
          '3. Run: cd upload-worker && npx wrangler secret put SUPABASE_SERVICE_KEY',
          '4. Paste the service_role key when prompted',
          '5. Run: npx wrangler deploy',
          '6. Test this /diagnose endpoint again',
        ];
      }

      return jsonResponse(diag, allOk ? 200 : 503, origin);
    }

    // ── Only accept POST to /upload ────────────────────────────────────────
    if (request.method !== 'POST' || url.pathname !== '/upload') {
      return jsonResponse({ error: 'Not found' }, 404, origin);
    }

    // ── Step 0: Validate secrets are present ──────────────────────────────
    const secretErr = checkSecrets(env);
    if (secretErr) {
      return jsonResponse({
        error: `WORKER CONFIGURATION ERROR — ${secretErr}`,
        stage: 'WORKER_CONFIGURATION',
      }, 503, origin);
    }

    // ── Diagnostics object (server-side only — returned in error responses) ─
    const diag = {
      firebase_token_received:      false,
      firebase_token_verification:  'PENDING',
      firebase_uid:                 null,
      firebase_email:               null,
      founder_authorized:           false,
      supabase_request_started:     false,
      supabase_operation_result:    'PENDING',
    };

    // ── Step 1: Extract Firebase ID token ─────────────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse({
        error: 'FIREBASE TOKEN MISSING — no Authorization: Bearer header found',
        stage: 'FIREBASE_TOKEN_MISSING',
        diag,
      }, 401, origin);
    }
    const idToken = authHeader.slice(7).trim();
    if (!idToken) {
      return jsonResponse({
        error: 'FIREBASE TOKEN MISSING — empty token in Authorization header',
        stage: 'FIREBASE_TOKEN_MISSING',
        diag,
      }, 401, origin);
    }
    diag.firebase_token_received = true;

    // ── Step 2: Verify Firebase ID token ──────────────────────────────────
    let tokenPayload;
    try {
      tokenPayload = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
      diag.firebase_token_verification = 'SUCCESS';
      diag.firebase_uid   = tokenPayload.sub;
      // Truncate email for diagnostics (show first 4 chars + domain)
      const em = (tokenPayload.email || '');
      diag.firebase_email = em.length > 8
        ? em.slice(0, 4) + '***@' + (em.split('@')[1] || '')
        : '(present)';
    } catch (err) {
      diag.firebase_token_verification = 'FAIL — ' + err.message;
      return jsonResponse({
        error: err.message,
        stage: 'FIREBASE_TOKEN_INVALID',
        diag,
      }, 401, origin);
    }

    // ── Step 3: Verify Founder email ──────────────────────────────────────
    const tokenEmail = (tokenPayload.email || '').trim().toLowerCase();
    if (!tokenEmail) {
      return jsonResponse({
        error: 'FOUNDER NOT AUTHORIZED — token has no email claim',
        stage: 'FOUNDER_NOT_AUTHORIZED',
        diag,
      }, 403, origin);
    }
    if (tokenEmail !== FOUNDER_EMAIL.toLowerCase()) {
      return jsonResponse({
        error: `FOUNDER NOT AUTHORIZED — this account is not the Founder`,
        stage: 'FOUNDER_NOT_AUTHORIZED',
        diag,
      }, 403, origin);
    }
    diag.founder_authorized = true;

    // ── Step 4: Parse multipart form data ─────────────────────────────────
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return jsonResponse({
        error: 'SUPABASE STORAGE FAILED — could not parse multipart form data',
        stage: 'SUPABASE_STORAGE_FAILED',
        diag,
      }, 400, origin);
    }

    const fileEntry = formData.get('file');
    if (!fileEntry || typeof fileEntry === 'string') {
      return jsonResponse({
        error: 'SUPABASE STORAGE FAILED — no file field in multipart request',
        stage: 'SUPABASE_STORAGE_FAILED',
        diag,
      }, 400, origin);
    }

    // fileEntry is a File/Blob
    const contentType = fileEntry.type || 'application/octet-stream';
    const fileName    = fileEntry.name  || 'upload';
    const fileSize    = fileEntry.size;

    // Validate MIME type
    if (!ALLOWED_TYPES.has(contentType)) {
      return jsonResponse({
        error: `SUPABASE STORAGE FAILED — file type not allowed: ${contentType}`,
        stage: 'SUPABASE_STORAGE_FAILED',
        diag,
      }, 415, origin);
    }

    // Validate size
    if (fileSize > MAX_BYTES) {
      return jsonResponse({
        error: `SUPABASE STORAGE FAILED — file exceeds 500 MB limit (${fileSize} bytes)`,
        stage: 'SUPABASE_STORAGE_FAILED',
        diag,
      }, 413, origin);
    }

    // Build storage path: media/<uid>/<timestamp>_<safename>
    const uid      = tokenPayload.sub;
    const safeName = fileName.replace(/[^a-z0-9._-]/gi, '_');
    const path     = `media/${uid}/${Date.now()}_${safeName}`;

    // ── Step 5: Upload to Supabase with service-role key ──────────────────
    diag.supabase_request_started = true;
    let result;
    try {
      result = await supabaseUpload(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_KEY,
        path,
        fileEntry.stream(),
        contentType
      );
      diag.supabase_operation_result = 'SUCCESS';
    } catch (err) {
      diag.supabase_operation_result = 'FAIL — ' + err.message;
      return jsonResponse({
        error: err.message,
        stage: 'SUPABASE_STORAGE_FAILED',
        diag,
      }, 502, origin);
    }

    // ── Step 6: Return upload details to Founder Studio ───────────────────
    return jsonResponse({
      ok:           true,
      storagePath:  result.storagePath,
      publicUrl:    result.publicUrl,
      fileName,
      contentType,
      size:         fileSize,
      uploadedBy:   tokenEmail,
      uploadedAt:   new Date().toISOString(),
    }, 200, origin);
  },
};
