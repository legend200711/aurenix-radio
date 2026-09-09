# AURENIX Upload Worker — Deployment Guide

**Version:** v11 — Shadow Nexus storage only  
**Google Drive: REMOVED.** All media is stored in Shadow Nexus (Supabase `aurenix-media` bucket).

---

## Required Secrets

Set these with `wrangler secret put` — **never put real values in source code or Git**:

```sh
cd upload-worker

# Supabase
npx wrangler secret put SUPABASE_URL
# → enter: https://nxsyoreuwmmxtuvmeqbg.supabase.co

npx wrangler secret put SUPABASE_SERVICE_KEY
# → enter: <service-role key from Supabase Dashboard → Settings → API>

# Firebase
npx wrangler secret put FIREBASE_PROJECT_ID
# → enter: remix-studio-4bf8a

npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
# → enter: <full JSON from Firebase Console → Project Settings → Service Accounts → Generate new private key>
# Required for server-side channel auto-advance.
```

## Optional Secrets

```sh
# Supabase Management API — raises the project-level upload limit automatically
npx wrangler secret put SUPABASE_MANAGEMENT_TOKEN
# → get a personal access token from https://supabase.com/dashboard/account/tokens
```

---

## Deploy

```sh
cd upload-worker
npx wrangler deploy
```

---

## Secrets Checklist

| Secret | Required | Purpose |
|--------|----------|---------|
| SUPABASE_URL | ✓ Required | Supabase project URL |
| SUPABASE_SERVICE_KEY | ✓ Required | Service-role JWT (never use anon key) |
| FIREBASE_PROJECT_ID | ✓ Required | Firebase project ID |
| FIREBASE_SERVICE_ACCOUNT_KEY | ✓ Required for auto-advance | Service account JSON |
| SUPABASE_MANAGEMENT_TOKEN | Optional | Auto-raises project-level storage limit |

---

## Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | None | Worker status + secret presence |
| `/diagnose` | GET | None | Full connectivity diagnostic |
| `/authorize` | POST | Firebase Founder | Get signed URL for Founder media upload |
| `/submission/authorize` | POST | Firebase (any user) | Get signed URL for user submission upload |
| `/verify` | POST | Firebase Founder | Check if object exists in storage |
| `/probe-limit` | GET | None | Test effective upload limit |
| `/probe-signed-url` | GET | None | Debug signed URL generation |
| `/set-storage-limit` | GET | None | Raise Supabase storage limits |
| `/channel/advance` | POST | Firebase (any user) | Atomic 24/7 channel advance |

---

## Upload Architecture

```
Browser → POST /authorize (Firebase token + filename + size)
Worker:  1. Verifies Firebase token
         2. Checks Founder email
         3. Ensures bucket file_size_limit ≥ 500 MB
         4. Creates signed upload URL
         → Returns: { signedUrl, storagePath, publicUrl }

Browser → PUT signedUrl (actual file bytes, no proxy)
Supabase: stores file at media/{uid}/{timestamp}_{filename}
```

The service-role key **never reaches the browser**. The worker only issues a single-use signed URL.

---

## Storage

All media files are stored in the Supabase `aurenix-media` bucket:

- Founder uploads: `media/{uid}/{timestamp}_{filename}`
- User submissions: `submissions/{uid}/{timestamp}_{filename}`

No Google Drive. No external storage dependency.

---

## Security Notes

- Service-role key is a Worker secret only — never in JS, HTML, CSS, or Git
- Firebase ID tokens are cryptographically verified server-side on every request
- Founder access is enforced both in the Worker and in Firestore Security Rules
- Media files require authorization to access (not publicly writable)
