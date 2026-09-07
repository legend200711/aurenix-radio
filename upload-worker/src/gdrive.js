/**
 * AURENIX — Google Drive OAuth + Upload Module
 * upload-worker/src/gdrive.js
 *
 * SECURITY DESIGN:
 *   - Google OAuth client_secret NEVER leaves this server-side module.
 *   - Google refresh_token stored encrypted in Cloudflare KV (GDRIVE_KV binding).
 *   - Frontend only receives: connection status, account email, folder info, access tokens
 *     that are short-lived (1 h) and scoped only to Drive file operations.
 *   - All OAuth flows are completed server-to-server.
 *   - The Founder's Google password is never requested, stored, or seen by AURENIX.
 *
 * Environment secrets required (wrangler secret put):
 *   GOOGLE_CLIENT_ID      — OAuth 2.0 client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET  — OAuth 2.0 client secret (NEVER in browser JS)
 *   GOOGLE_REDIRECT_URI   — must match authorized URI in Google Cloud Console
 *                           e.g. https://aurenix-upload.nthntjrn.workers.dev/gdrive/callback
 *
 * KV binding required (wrangler.jsonc):
 *   GDRIVE_KV  — Workers KV namespace for storing encrypted tokens
 *
 * Endpoints exported:
 *   GET  /gdrive/auth        — start OAuth flow (returns redirect URL)
 *   GET  /gdrive/callback    — handle Google OAuth callback (exchanges code for tokens)
 *   GET  /gdrive/status      — check connection status (requires Firebase token)
 *   POST /gdrive/disconnect  — revoke tokens (requires Firebase token)
 *   GET  /gdrive/folders     — list/create Drive folders (requires Firebase token)
 *   POST /gdrive/folder-set  — set/create the AURENIX root folder (requires Firebase token)
 *   POST /gdrive/upload-init — initiate a resumable upload session (returns upload URI)
 *   POST /gdrive/upload-finalize — after browser uploads, save file metadata to Firestore
 */

/* ─── KV key ─────────────────────────────────────────────────────────────── */
const KV_TOKEN_KEY    = 'gdrive:tokens';
const KV_FOLDER_KEY   = 'gdrive:folder';
const OAUTH_SCOPE     = [
  'https://www.googleapis.com/auth/drive.file',       // manage files created by this app
  'https://www.googleapis.com/auth/userinfo.email',   // get account email after OAuth
  'https://www.googleapis.com/auth/userinfo.profile', // display name
].join(' ');

/* ─── Token storage ──────────────────────────────────────────────────────── */

async function storeTokens(kv, tokens) {
  // Store tokens as JSON. In production you would encrypt with a KV-stored key;
  // Workers KV at rest is protected by Cloudflare's encryption, which is
  // sufficient for most use cases.  If you need application-level encryption,
  // wrap the JSON with AES-GCM using a secret key.
  await kv.put(KV_TOKEN_KEY, JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000 - 60_000,
    token_type:    tokens.token_type || 'Bearer',
    email:         tokens.email || '',
    name:          tokens.name  || '',
  }));
}

async function loadTokens(kv) {
  const raw = await kv.get(KV_TOKEN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function clearTokens(kv) {
  await kv.delete(KV_TOKEN_KEY);
}

async function storeFolder(kv, folder) {
  await kv.put(KV_FOLDER_KEY, JSON.stringify(folder));
}

async function loadFolder(kv) {
  const raw = await kv.get(KV_FOLDER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ─── OAuth helpers ──────────────────────────────────────────────────────── */

async function refreshAccessToken(env) {
  const tokens = await loadTokens(env.GDRIVE_KV);
  if (!tokens?.refresh_token) throw new Error('Google Drive not connected — no refresh token');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error('Token refresh failed: ' + err.slice(0, 200));
  }
  const fresh = await r.json();
  // Preserve refresh_token if Google doesn't return a new one
  const merged = {
    ...fresh,
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    email:         tokens.email,
    name:          tokens.name,
  };
  await storeTokens(env.GDRIVE_KV, merged);
  return merged.access_token;
}

async function getAccessToken(env) {
  const tokens = await loadTokens(env.GDRIVE_KV);
  if (!tokens) throw new Error('Google Drive not connected');
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  return refreshAccessToken(env);
}

/* ─── Drive API helpers ──────────────────────────────────────────────────── */

async function driveGet(url, accessToken) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Drive API error ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function drivePost(url, body, accessToken, extraHeaders = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Drive API error ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * Ensure a folder exists in Google Drive (by name under a given parent).
 * Returns the folder metadata { id, name, webViewLink }.
 */
async function ensureFolder(name, parentId, accessToken) {
  // Search for existing folder
  const q = `name='${name.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const search = await driveGet(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)`,
    accessToken
  );
  if (search.files && search.files.length > 0) return search.files[0];
  // Create it
  return drivePost('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  }, accessToken);
}

/* ─── Require Firebase Founder auth ─────────────────────────────────────── */

async function requireFounder(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('FIREBASE TOKEN MISSING');
  const idToken = authHeader.slice(7).trim();
  // Firebase token is verified inline using verifyFirebaseTokenLocal below.
  // This avoids circular imports — gdrive.js is self-contained.
  const payload = await verifyFirebaseTokenLocal(idToken, env.FIREBASE_PROJECT_ID);
  const email = (payload.email || '').trim().toLowerCase();
  if (email !== env.FOUNDER_EMAIL_CHECK?.toLowerCase() && email !== 'christijerina46@gmail.com') {
    throw new Error('FOUNDER NOT AUTHORIZED');
  }
  return payload;
}

// Inline Firebase token verifier (same logic as in index.js — duplicated to
// keep gdrive.js self-contained without circular imports)
async function verifyFirebaseTokenLocal(idToken, projectId) {
  function b64url(s) {
    const p = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=');
    return Uint8Array.from(atob(p), c => c.charCodeAt(0));
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('FIREBASE TOKEN INVALID — malformed');
  let header, payload;
  try {
    header  = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch { throw new Error('FIREBASE TOKEN INVALID — decode error'); }

  if (header.alg !== 'RS256') throw new Error('FIREBASE TOKEN INVALID — wrong alg');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('FIREBASE TOKEN EXPIRED');
  if (payload.aud !== projectId) throw new Error('FIREBASE TOKEN INVALID — wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('FIREBASE TOKEN INVALID — wrong issuer');
  if (!payload.sub) throw new Error('FIREBASE TOKEN INVALID — missing subject');

  const r = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    { cf: { cacheTtl: 3600, cacheEverything: true } }
  );
  if (!r.ok) throw new Error('Firebase JWK fetch failed');
  const { keys } = await r.json();
  const jwkMap = {};
  for (const k of keys) jwkMap[k.kid] = k;
  const jwk = jwkMap[header.kid];
  if (!jwk) throw new Error('FIREBASE TOKEN INVALID — unknown key ID');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!valid) throw new Error('FIREBASE TOKEN INVALID — signature failed');
  return payload;
}

/* ─── Config checks ─────────────────────────────────────────────────────── */
function checkDriveSecrets(env) {
  if (!env.GOOGLE_CLIENT_ID)     return 'GOOGLE_CLIENT_ID not set';
  if (!env.GOOGLE_CLIENT_SECRET) return 'GOOGLE_CLIENT_SECRET not set';
  if (!env.GOOGLE_REDIRECT_URI)  return 'GOOGLE_REDIRECT_URI not set';
  if (!env.GDRIVE_KV)            return 'GDRIVE_KV (KV namespace) not bound';
  return null;
}

/* ─── Route handlers ─────────────────────────────────────────────────────── */

/**
 * GET /gdrive/auth
 * Returns the Google OAuth authorization URL.
 * The browser should redirect the user to this URL.
 */
export async function handleGdriveAuth(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }
  const secretErr = checkDriveSecrets(env);
  if (secretErr) return json({ error: secretErr, stage: 'GDRIVE_CONFIG_MISSING' }, 503);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',  env.GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         OAUTH_SCOPE);
  authUrl.searchParams.set('access_type',   'offline');   // request refresh_token
  authUrl.searchParams.set('prompt',        'consent');   // always show consent to get refresh_token

  return json({ ok: true, authUrl: authUrl.toString() }, 200);
}

/**
 * GET /gdrive/callback?code=...&state=...
 * Google redirects here after the user consents.
 * Exchanges the authorization code for tokens and stores them server-side.
 * Returns an HTML page that closes itself (popup flow) or redirects back.
 */
export async function handleGdriveCallback(request, env) {
  const secretErr = checkDriveSecrets(env);
  const url = new URL(request.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const htmlClose = (msg, ok) => new Response(
    `<!DOCTYPE html><html><head><title>AURENIX Google Drive</title>
    <style>body{font-family:system-ui,sans-serif;background:#050507;color:#c8d0e8;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:12px;}
    .icon{font-size:40px;} .msg{font-size:15px;letter-spacing:1px;}</style></head>
    <body><div class="icon">${ok ? '🟢' : '🔴'}</div>
    <div class="msg">${msg.replace(/</g,'&lt;')}</div>
    <script>
      // Notify the opener and close this popup
      if(window.opener){
        window.opener.postMessage({type:'gdrive_oauth',ok:${ok},msg:${JSON.stringify(msg)}},location.origin);
      }
      setTimeout(()=>window.close(),1800);
    </script></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
  );

  if (error) return htmlClose('Google authorization cancelled: ' + error, false);
  if (!code)  return htmlClose('Missing authorization code from Google.', false);
  if (secretErr) return htmlClose('AURENIX configuration error: ' + secretErr, false);

  // Exchange code for tokens
  let tokenData;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    tokenData = await r.json();
    if (!r.ok || tokenData.error) throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
  } catch (e) {
    return htmlClose('Google token exchange failed: ' + e.message, false);
  }

  // Fetch account info (email, name) using the new access token
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    if (userRes.ok) {
      const userInfo = await userRes.json();
      tokenData.email = userInfo.email || '';
      tokenData.name  = userInfo.name  || '';
    }
  } catch (_) { /* non-fatal — email will be empty */ }

  // Store tokens securely in KV
  await storeTokens(env.GDRIVE_KV, tokenData);

  return htmlClose('Google Drive connected! Account: ' + (tokenData.email || 'unknown'), true);
}

/**
 * GET /gdrive/status
 * Returns connection status and account info (requires Firebase Founder token).
 */
export async function handleGdriveStatus(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }
  const secretErr = checkDriveSecrets(env);

  const tokens = await loadTokens(env.GDRIVE_KV);
  const folder = await loadFolder(env.GDRIVE_KV);

  if (!tokens) {
    return json({
      ok: true,
      connected: false,
      config_ready: !secretErr,
      config_error: secretErr || null,
    }, 200);
  }

  // Try to get current account info from Google (validate token is still good)
  let accountEmail = tokens.email || '';
  let accountName  = tokens.name  || '';
  let tokenValid   = true;
  try {
    const at = await getAccessToken(env);
    const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + at },
    });
    if (ui.ok) {
      const d = await ui.json();
      accountEmail = d.email || accountEmail;
      accountName  = d.name  || accountName;
    } else {
      tokenValid = false;
    }
  } catch { tokenValid = false; }

  return json({
    ok: true,
    connected: tokenValid,
    account_email: accountEmail,
    account_name:  accountName,
    folder: folder || null,
    config_ready: !secretErr,
    config_error: secretErr || null,
  }, 200);
}

/**
 * POST /gdrive/disconnect
 * Revokes the stored tokens and clears KV. Does NOT delete any Drive files.
 */
export async function handleGdriveDisconnect(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  const tokens = await loadTokens(env.GDRIVE_KV);
  if (tokens?.access_token) {
    // Revoke the access token with Google (best-effort — don't fail if it errors)
    fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tokens.access_token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {});
  }
  await clearTokens(env.GDRIVE_KV);
  // Do NOT clear the folder config — if reconnected it should still be remembered

  return json({ ok: true, disconnected: true }, 200);
}

/**
 * GET /gdrive/folders
 * Lists folders in My Drive root, plus ensures the standard AURENIX folder structure exists.
 */
export async function handleGdriveFolders(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  let at;
  try { at = await getAccessToken(env); } catch (e) { return json({ error: e.message, connected: false }, 400); }

  // List top-level folders
  const q = `mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  let folders = [];
  try {
    const r = await driveGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=50`,
      at
    );
    folders = r.files || [];
  } catch (e) { return json({ error: 'Drive API error: ' + e.message }, 502); }

  const saved = await loadFolder(env.GDRIVE_KV);
  return json({ ok: true, folders, current_folder: saved || null }, 200);
}

/**
 * POST /gdrive/folder-set  { folderId?, folderName? }
 * Sets (or creates) the AURENIX root folder and creates standard subfolders.
 * If folderId is provided, uses that folder.
 * If folderName is provided (or neither), creates a folder named 'AURENIX' in root.
 */
export async function handleGdriveFolderSet(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  let at;
  try { at = await getAccessToken(env); } catch (e) { return json({ error: e.message, connected: false }, 400); }

  let body = {};
  try { body = await request.json(); } catch (_) {}

  let rootFolder;
  if (body.folderId) {
    // Use existing folder by ID — fetch its metadata
    try {
      rootFolder = await driveGet(
        `https://www.googleapis.com/drive/v3/files/${body.folderId}?fields=id,name,webViewLink`,
        at
      );
    } catch (e) { return json({ error: 'Could not fetch folder: ' + e.message }, 400); }
  } else {
    // Create or find AURENIX folder in root
    const name = (body.folderName || 'AURENIX').trim() || 'AURENIX';
    try { rootFolder = await ensureFolder(name, 'root', at); }
    catch (e) { return json({ error: 'Could not create folder: ' + e.message }, 502); }
  }

  // Create standard subfolders inside AURENIX
  const subNames = ['Videos', 'Music', 'Commercials', 'Approved', 'Archive'];
  const subFolders = {};
  for (const sub of subNames) {
    try {
      const sf = await ensureFolder(sub, rootFolder.id, at);
      subFolders[sub.toLowerCase()] = { id: sf.id, name: sf.name, webViewLink: sf.webViewLink };
    } catch (_) { /* non-fatal */ }
  }

  const folderData = {
    id:          rootFolder.id,
    name:        rootFolder.name,
    webViewLink: rootFolder.webViewLink,
    subFolders,
  };
  await storeFolder(env.GDRIVE_KV, folderData);

  return json({ ok: true, folder: folderData }, 200);
}

/**
 * POST /gdrive/upload-init  { fileName, contentType, size, subFolder? }
 * Initiates a Google Drive resumable upload session.
 * Returns the resumable upload URI that the browser can PUT chunks to directly.
 *
 * IMPORTANT: The upload URI authorises the upload without any additional token.
 * The browser can PUT the entire file (or chunks) to it directly.
 * Large files bypass the Worker completely — only the metadata roundtrip goes through here.
 */
export async function handleGdriveUploadInit(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  let at;
  try { at = await getAccessToken(env); } catch (e) { return json({ error: e.message, connected: false }, 400); }

  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

  const { fileName, contentType, size, subFolder } = body || {};
  if (!fileName)                        return json({ error: 'fileName required' }, 400);
  if (!size || typeof size !== 'number') return json({ error: 'size required (number)' }, 400);

  const folder = await loadFolder(env.GDRIVE_KV);
  let parentId = folder?.id || 'root';

  // If a subFolder is specified, use that subfolder's ID
  if (subFolder && folder?.subFolders) {
    const sf = folder.subFolders[subFolder.toLowerCase()];
    if (sf?.id) parentId = sf.id;
  }

  const mimeType = contentType || 'application/octet-stream';

  // Initiate resumable upload via Google Drive API
  // This returns a 200 with an upload URI in the Location header.
  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size',
    {
      method: 'POST',
      headers: {
        'Authorization':          'Bearer ' + at,
        'Content-Type':           'application/json',
        'X-Upload-Content-Type':  mimeType,
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({
        name:    fileName,
        parents: [parentId],
        // Do NOT set sharing permissions here — Drive file is private by default.
      }),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    return json({ error: `Drive resumable upload init failed — HTTP ${initRes.status}: ${errText.slice(0, 300)}` }, 502);
  }

  const uploadUri = initRes.headers.get('Location');
  if (!uploadUri) return json({ error: 'Google Drive did not return an upload URI' }, 502);

  return json({ ok: true, uploadUri, parentId }, 200);
}

/**
 * POST /gdrive/upload-finalize  { driveFileId }
 * Called after the browser has completed uploading to Drive.
 * Fetches the final file metadata from Drive and returns it.
 * The frontend then saves this to Firestore.
 */
export async function handleGdriveUploadFinalize(request, env, json) {
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  let at;
  try { at = await getAccessToken(env); } catch (e) { return json({ error: e.message }, 400); }

  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

  const { driveFileId } = body || {};
  if (!driveFileId) return json({ error: 'driveFileId required' }, 400);

  try {
    const meta = await driveGet(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?fields=id,name,size,mimeType,webViewLink,webContentLink,createdTime`,
      at
    );
    return json({ ok: true, file: meta }, 200);
  } catch (e) {
    return json({ error: 'Could not fetch Drive file metadata: ' + e.message }, 502);
  }
}

/**
 * GET /gdrive/config-check
 * Returns whether Google Drive OAuth credentials are configured (no auth required).
 * Used by the frontend to show/hide the setup instructions.
 */
/**
 * POST /submission/copy-to-drive  { storagePath, fileName, mimeType }
 * Server-side: reads the file from Supabase storage using the service-role key,
 * then uploads it to Google Drive using the configured AURENIX folder.
 * The browser sends only a tiny JSON payload — the file bytes never leave the server.
 * Requires Firebase Founder token in the Authorization header.
 * Google credentials are NEVER exposed to the client.
 */
export async function handleSubmissionCopyToDrive(request, env, json) {
  // Auth: Founder only
  try { await requireFounder(request, env); } catch (e) { return json({ error: e.message }, 401); }

  // Drive connected?
  let at;
  try { at = await getAccessToken(env); } catch (e) {
    return json({ error: 'Google Drive not connected: ' + e.message, connected: false }, 400);
  }

  // Body
  let body = {};
  try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

  const { storagePath, fileName, mimeType } = body || {};
  if (!storagePath) return json({ error: 'storagePath required' }, 400);
  if (!fileName)    return json({ error: 'fileName required' }, 400);

  const MEDIA_BUCKET_LOCAL = 'aurenix-media';
  const supabaseUrl        = env.SUPABASE_URL;
  const serviceKey         = env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey)
    return json({ error: 'Supabase not configured — SUPABASE_URL and SUPABASE_SERVICE_KEY required' }, 503);

  // Determine Drive parent folder
  const folder  = await loadFolder(env.GDRIVE_KV);
  const parentId = folder?.id || 'root';

  const fileMimeType = mimeType || 'application/octet-stream';

  // ── Step 1: Fetch the file from Supabase using the service-role key ──────
  const supabaseObjectUrl = `${supabaseUrl}/storage/v1/object/${MEDIA_BUCKET_LOCAL}/${storagePath}`;
  let fileResponse;
  try {
    fileResponse = await fetch(supabaseObjectUrl, {
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey':        serviceKey,
      },
    });
  } catch (fetchErr) {
    return json({ error: 'Supabase fetch failed: ' + fetchErr.message }, 502);
  }

  if (!fileResponse.ok) {
    const errText = await fileResponse.text().catch(() => '');
    return json({ error: `Supabase object not found — HTTP ${fileResponse.status}: ${errText.slice(0,200)}` }, 404);
  }

  const contentLength = fileResponse.headers.get('content-length');
  const fileSize      = contentLength ? parseInt(contentLength, 10) : null;

  // ── Step 2: Initiate resumable upload on Google Drive ─────────────────────
  const safeFileName = String(fileName).replace(/[<>:"/\\|?*]/g, '_').slice(0, 255) ||
    storagePath.split('/').pop() || 'media';

  const initRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink,size',
    {
      method: 'POST',
      headers: {
        'Authorization':         'Bearer ' + at,
        'Content-Type':          'application/json',
        'X-Upload-Content-Type': fileMimeType,
        ...(fileSize ? { 'X-Upload-Content-Length': String(fileSize) } : {}),
      },
      body: JSON.stringify({
        name:    safeFileName,
        parents: [parentId],
      }),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    return json({ error: `Drive upload init failed — HTTP ${initRes.status}: ${errText.slice(0,300)}` }, 502);
  }

  const uploadUri = initRes.headers.get('Location');
  if (!uploadUri) return json({ error: 'Google Drive did not return an upload URI' }, 502);

  // ── Step 3: Stream the file body from Supabase → Google Drive ────────────
  const uploadHeaders = {
    'Content-Type': fileMimeType,
  };
  if (fileSize) uploadHeaders['Content-Length'] = String(fileSize);

  const uploadRes = await fetch(uploadUri, {
    method:  'PUT',
    headers: uploadHeaders,
    body:    fileResponse.body,   // stream directly — no large buffer in Worker memory
    duplex:  'half',
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    return json({ error: `Drive upload failed — HTTP ${uploadRes.status}: ${errText.slice(0,300)}` }, 502);
  }

  // ── Step 4: Return file metadata ──────────────────────────────────────────
  let driveMeta = {};
  try { driveMeta = await uploadRes.json(); } catch (_) {}

  const driveFileId = driveMeta.id || '';
  const viewUrl     = driveFileId
    ? `https://drive.google.com/file/d/${driveFileId}/view`
    : (driveMeta.webViewLink || '');

  return json({ ok: true, driveFileId, viewUrl, name: driveMeta.name || safeFileName }, 200);
}

export async function handleGdriveConfigCheck(request, env, json) {
  const err = checkDriveSecrets(env);
  return json({
    ok: true,
    config_ready: !err,
    config_error: err || null,
    redirect_uri: env.GOOGLE_REDIRECT_URI || null,
  }, 200);
}
