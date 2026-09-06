# AURENIX Founder Upload Worker — Deployment Guide

## What This Is

A Cloudflare Worker that acts as a secure bridge between Firebase Auth and Supabase Storage.

**Problem it solves:**
The AURENIX app uses Firebase Authentication. Supabase Storage RLS cannot verify Firebase tokens — requests arrive as the `anon` Postgres role with no Supabase session. Any RLS policy that requires a real identity will fail with `"new row violates row-level security policy"`. Making storage publicly writable is not acceptable.

**Solution:**
1. Browser sends Firebase ID token + file to the Worker
2. Worker verifies the Firebase JWT against Google's public keys (server-side, no SDK needed)
3. Worker checks `token.email == 'christijerina46@gmail.com'`
4. Only if verified does the Worker upload to Supabase using the **service-role key**
5. The service-role key never touches browser JavaScript

---

## Prerequisites

- Node.js 18+ installed
- A Cloudflare account (free tier works)
- Supabase project `nxsyoreuwmmxtuvmeqbg` service-role key
  - Find it at: Supabase Dashboard → Settings → API → `service_role` key

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

---

## Step 2 — Set Secrets

Run these three commands. Each will prompt you to paste a value.
**Never put these values in any file that gets committed to git.**

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

---

## Step 3 — Deploy

```bash
cd upload-worker
npx wrangler deploy
```

You will see output like:
```
Published aurenix-upload (1.23 sec)
  https://aurenix-upload.YOUR_SUBDOMAIN.workers.dev
```

Copy the Worker URL.

---

## Step 4 — Update aurenix-control.js

Open `aurenix-control.js` and find this line near the top:

```js
const UPLOAD_WORKER_URL = 'https://aurenix-upload.christijerina46.workers.dev';
```

Replace `christijerina46` with your actual Cloudflare workers.dev subdomain.
Your subdomain is the part before `.workers.dev` in the URL shown after deploy.

---

## Step 5 — Apply the Supabase SQL

Open Supabase Dashboard → SQL Editor → New query.
Paste the contents of `aurenix-storage-restore.sql` and click **Run**.

This will:
- Ensure both buckets exist (`aurenix-radio`, `aurenix-media`)
- Remove the old `anon` INSERT policy for `aurenix-media` (no longer needed)
- Keep `anon` SELECT (needed for playback) and DELETE (for Founder delete action)
- Keep `aurenix-radio` policies untouched

**Existing files in both buckets are preserved.**

---

## Step 6 — Test

### MP3 test
1. Sign in as `christijerina46@gmail.com`
2. Open Founder Studio
3. Select a small MP3 (< 10 MB)
4. Upload should reach 100%
5. File should appear in Media Library
6. Play the file — audio should stream
7. Add to AURENIX MUSIC queue

### MP4 test
Same flow with a short MP4 file.

### Security test
| Scenario | Expected |
|----------|----------|
| Logged-out user opens upload URL | `401 FOUNDER AUTHENTICATION FAILED` |
| Normal signed-in user tries to upload | `403 FOUNDER ACCESS DENIED` |
| Founder uploads | `200 ok` → file in Media Library |

---

## CORS Note

The Worker's `corsHeaders()` function allows requests from:
- `https://remix-studio-4bf8a.web.app`
- `https://remix-studio-4bf8a.firebaseapp.com`
- `https://aurenix.com` / `https://www.aurenix.com`
- `http://localhost` (dev)

If your Firebase Hosting domain is different, add it to the `allowed` array in `upload-worker/src/index.js`.

---

## Architecture Summary

```
Founder Browser
  │
  │  1. Firebase login (christijerina46@gmail.com)
  │  2. Get Firebase ID token
  │  3. POST /upload  (multipart: file + Authorization: Bearer <token>)
  │
  ▼
Cloudflare Worker  [aurenix-upload.*.workers.dev]
  │
  │  4. Verify Firebase JWT (Google public keys, RS256, exp, aud, iss)
  │  5. Check token.email == 'christijerina46@gmail.com'
  │  6. Upload to Supabase via service-role key (bypasses RLS)
  │
  ▼
Supabase Storage  [nxsyoreuwmmxtuvmeqbg]
  │  aurenix-media bucket
  │  path: media/<firebase_uid>/<timestamp>_<filename>
  │
  ▼
Worker returns { ok, storagePath, publicUrl, … }
  │
  ▼
Founder Studio
  │  Saves metadata to Firestore network_media/{id}
  │  (Firestore rules also enforce isAdmin() — double protection)
  │
  ▼
Media Library updates → file can be scheduled for 24/7 broadcast
```

---

## Security Properties

| Threat | Mitigation |
|--------|------------|
| Supabase service-role key exposed to browser | **Never sent to browser** — stored as Cloudflare Worker secret |
| Regular user uploads media | Worker returns `403` — email check is cryptographic (JWT signature verified) |
| Attacker replays a valid Founder token | Firebase JWT has 1-hour expiry; token is verified on every upload request |
| Attacker forges a Firebase token | RS256 signature verified against Google's public keys — unforgeable |
| Attacker uploads oversized file | Worker enforces 500 MB limit before touching Supabase |
| Attacker uploads disallowed MIME type | Worker validates MIME type from multipart Content-Type |
