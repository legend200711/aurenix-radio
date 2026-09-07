# AURENIX Founder Upload Worker — Deployment Guide

## What This Is

A Cloudflare Worker that acts as a secure bridge between Firebase Auth, Supabase Storage, and Google Drive.

**Google Drive security model:**
- Google OAuth client secret **never touches browser JavaScript** — it lives only in this Worker as a Cloudflare secret.
- Google refresh tokens are stored server-side in Cloudflare KV (encrypted at rest by Cloudflare).
- The Founder's Google password is never requested, stored, or seen by AURENIX.
- Drive files are private — no public sharing is set on uploaded files.
- Playback is handled securely through the AURENIX media delivery layer.

---

## ✅ CURRENT STATUS (as of last deploy)

| Item | Status |
|------|--------|
| Worker URL | `https://aurenix-upload.nthntjrn.workers.dev` |
| SUPABASE_URL | ✓ Set |
| SUPABASE_SERVICE_KEY | ✓ Set |
| FIREBASE_PROJECT_ID | ✓ Set (`remix-studio-4bf8a`) |
| GOOGLE_CLIENT_ID | ✓ Set |
| GOOGLE_CLIENT_SECRET | ✓ Set (server-side only, never in source code) |
| GOOGLE_REDIRECT_URI | ✓ Set (`https://aurenix-upload.nthntjrn.workers.dev/gdrive/callback`) |
| GDRIVE_KV namespace | ✓ Bound (`2c5a879a99c64aaeaf59bc1ed99db0f8`) |
| Worker version | `2025-09-06-v8-gdrive` |
| Last deploy | Version ID `9216b14d-50c6-4514-aad9-131085397a91` |

---

## ⚠️ ACTION REQUIRED — Google Cloud Console

The OAuth redirect URI registered in Google Cloud Console must match the Worker URL exactly.

**Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → your OAuth 2.0 client → Edit**

Under **Authorized redirect URIs**, add:
```
https://aurenix-upload.nthntjrn.workers.dev/gdrive/callback
```

⚠️ The downloaded JSON contained `https://upload.nshmjs.workers.dev/gdrive/callback` — this was from a different Worker URL and will cause a `redirect_uri_mismatch` error. **Add the correct URL above** (or replace the old one).

Also confirm under **Authorized JavaScript origins**:
```
https://legend200711.github.io
https://remix-studio-4bf8a.web.app
https://remix-studio-4bf8a.firebaseapp.com
```

---

## Prerequisites

- Node.js 18+ installed
- A Cloudflare account (free tier works)
- Supabase project `nxsyoreuwmmxtuvmeqbg` service-role key
  - Find it at: Supabase Dashboard → Settings → API → `service_role` key

---

## Part A — Supabase + Firebase Setup (existing — already done)

### Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### Step 2 — Set Supabase + Firebase Secrets (already set)

```bash
cd upload-worker

npx wrangler secret put SUPABASE_URL
# Paste: https://nxsyoreuwmmxtuvmeqbg.supabase.co

npx wrangler secret put SUPABASE_SERVICE_KEY
# Paste: <service_role key from Supabase Dashboard → Settings → API>
# Starts with: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

npx wrangler secret put FIREBASE_PROJECT_ID
# Paste: remix-studio-4bf8a
```

### Step 3 — Deploy

```bash
cd upload-worker
npx wrangler deploy
```

Output: `https://aurenix-upload.nthntjrn.workers.dev`

### Step 4 — aurenix-control.js Worker URL

Already set in the frontend:
```js
const UPLOAD_WORKER_URL = 'https://aurenix-upload.nthntjrn.workers.dev';
```

---

## Part B — Google Drive OAuth Setup (✅ completed)

### Step 5 — Google Cloud Project & Drive API (already done)

The OAuth credentials were created in project `hrs-82459`.

If you need to create from scratch:
1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. Create a new project (or select an existing one).
3. Go to **APIs & Services → Library**.
4. Search for **Google Drive API** → **Enable** it.

### Step 6 — Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External** (or Internal if using Google Workspace).
3. Fill in:
   - App name: **AURENIX**
   - User support email: your email
   - Developer contact email: your email
4. On **Scopes** tab, add:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
5. On **Test users** tab, add your Google account email (needed while app is in "Testing" mode).
6. Save.

### Step 7 — ⚠️ UPDATE Authorized Redirect URI in Google Cloud

The current `wrangler.jsonc` / Worker URL is:
```
https://aurenix-upload.nthntjrn.workers.dev
```

The correct redirect URI to register is:
```
https://aurenix-upload.nthntjrn.workers.dev/gdrive/callback
```

Go to: **Google Cloud Console → APIs & Services → Credentials → [your OAuth client] → Edit**

Add this exact URI to **Authorized redirect URIs**. Without this step, the OAuth flow will fail with `redirect_uri_mismatch`.

### Step 8 — KV Namespace (✅ created)

Already created:
```
binding = "GDRIVE_KV"
id = "2c5a879a99c64aaeaf59bc1ed99db0f8"
```

If you need to recreate:
```bash
cd upload-worker
npx wrangler kv namespace create GDRIVE_KV
# Copy the output id into wrangler.jsonc
```

### Step 9 — Google Drive Secrets (✅ already set)

These are set as Cloudflare Worker secrets (server-side only — never in source):

```bash
cd upload-worker

npx wrangler secret put GOOGLE_CLIENT_ID
# ✓ Already set — OAuth client ID from project hrs-82459

npx wrangler secret put GOOGLE_CLIENT_SECRET
# ✓ Already set — NEVER put this value in any file
# ⚠ This MUST stay server-side. Never paste it into JS, HTML, or any source file.

npx wrangler secret put GOOGLE_REDIRECT_URI
# ✓ Already set → https://aurenix-upload.nthntjrn.workers.dev/gdrive/callback
```

### Step 10 — Redeploy (✅ done)

```bash
cd upload-worker
npx wrangler deploy
```

Current version: `2025-09-06-v8-gdrive`

### Step 11 — Connect Google Drive in AURENIX

1. Open AURENIX → Founder Studio → **Storage → Google Drive**.
2. Click **CONNECT GOOGLE DRIVE**.
3. A popup opens Google's official login page.
4. Sign in with your Google account **directly on Google's page** (AURENIX never sees your password).
5. Grant the requested Drive permissions.
6. The popup closes and AURENIX shows: **🟢 GOOGLE DRIVE CONNECTED**.

---

## CORS Note

The Worker allows requests from:
- `https://remix-studio-4bf8a.web.app`
- `https://remix-studio-4bf8a.firebaseapp.com`
- `https://aurenix.com` / `https://www.aurenix.com`
- `https://legend200711.github.io`
- `http://localhost` (dev)

---

## Architecture Summary

```
Founder Browser
  │
  │  1. Firebase login (christijerina46@gmail.com)
  │  2. Click CONNECT GOOGLE DRIVE
  │  3. GET /gdrive/auth → Worker returns Google OAuth URL
  │  4. Popup opens google.com/oauth/authorize
  │  5. Founder signs in DIRECTLY ON GOOGLE (AURENIX never sees password)
  │  6. Google redirects to Worker /gdrive/callback?code=...
  │
  ▼
Cloudflare Worker  [aurenix-upload.nthntjrn.workers.dev]
  │
  │  7. Worker exchanges code for { access_token, refresh_token } (server-to-server)
  │  8. Worker stores tokens in Workers KV (encrypted at rest)
  │  9. Worker returns HTML that sends postMessage to opener and closes popup
  │
  ▼
Founder Studio shows: 🟢 GOOGLE DRIVE CONNECTED — account: founder@gmail.com

══ Upload flow ══

Founder Browser
  │
  │  1. Select video file
  │  2. POST /gdrive/upload-init (Firebase token + fileName + size)
  │
  ▼
Cloudflare Worker
  │  3. Verify Firebase JWT
  │  4. Check token.email == Founder email
  │  5. Load stored access_token (refresh if expired)
  │  6. POST to Google Drive resumable upload API → get upload URI
  │  7. Return upload URI to browser (large file never passes through Worker)
  │
  ▼
Founder Browser
  │  8. PUT large file DIRECTLY to Google Drive upload URI (XHR with progress)
  │  9. After completion, POST /gdrive/upload-finalize { driveFileId }
  │
  ▼
Cloudflare Worker
  │  10. Fetch Drive file metadata
  │  11. Return { id, name, size, webViewLink, ... }
  │
  ▼
Founder Browser
  │  12. Save to Firestore network_media with status: 'pending_approval'
  │      + drive_file_id, drive_web_view_link stored alongside
  │
  ▼
AURENIX Media Library — file awaits Founder approval before broadcast
```

---

## Security Properties

| Threat | Mitigation |
|--------|------------|
| Google client secret exposed | **Stored only as Cloudflare Worker secret** — never in JS/HTML/CSS/GitHub |
| Google refresh token exposed | **Stored in Cloudflare KV (encrypted at rest)** — never sent to browser |
| Founder's Google password exposed | **Founder logs in directly on Google's page** — AURENIX never sees it |
| Attacker steals Drive tokens from KV | Tokens scoped to `drive.file` only — only sees files AURENIX created |
| Attacker uploads unauthorized files | Worker verifies Firebase JWT + Founder email before issuing upload URI |
| Drive files publicly exposed | Files are private by default — no public sharing is set |
| Large video proxied through Worker | **Files go directly browser → Drive** via resumable upload URI |
| Token expiry | Worker auto-refreshes using stored refresh_token when access_token expires |
| OAuth JSON committed to git | `.gitignore` blocks `client_secret*.json` — JSON is not tracked |

---

## Git Security

The OAuth client JSON (`client_secret_*.json`) is in `.gitignore` and has never been committed.

Before pushing to GitHub, verify:
```bash
git status | grep -i client_secret   # should show nothing
git ls-files | grep -i client_secret  # should show nothing
grep -r "GOCSPX" . --include="*.js" --include="*.html" --include="*.json"  # should show nothing
grep -r "GOOGLE_CLIENT_SECRET" . --include="*.js" --include="*.html"  # should show nothing
```
