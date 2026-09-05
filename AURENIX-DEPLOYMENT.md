# AURENIX — Deployment & Configuration Guide

## Overview

AURENIX is a complete platform combining:
- **AURENIX CORE** — cinematic home with section navigation
- **LIVE** — real-time WebRTC live streaming (Supabase Broadcast/Presence)
- **AURENIX RADIO** — community radio with moderated submissions
- **24-HOUR CLOUD STREAM** — independent continuous cloud broadcast (Cloudflare Workers)
- **MEDIA** — video/audio upload, playback, comments
- **COMMUNITY** — profiles, posts, follows, notifications
- **Admin Dashboard** — admin-only (christijerina46@gmail.com)
- **PWA** — installable, offline shell, service worker

---

## Required Configuration

### 1. Supabase Project (Storage only)

> **Architecture note:** AURENIX uses **Firebase** for Authentication and the
> database (Firestore). Supabase is used **only for Storage** (audio and media
> files). No Supabase Auth session exists in the browser.

1. Open `supabase-client.js` — credentials are already set:
```js
const SUPABASE_URL      = 'https://nxsyoreuwmmxtuvmeqbg.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_nVGMJKoZGduKTt5Vh6P7cg_H692tMxL';
```

2. Run the Storage RLS fix in **Supabase → SQL Editor**:

   **`aurenix-storage-firebase-fix.sql`** ← **Run this first / again if uploads fail**

   This file replaces the old `auth.uid()`-based storage policies with anon-role
   policies that work without a Supabase Auth session. Without this, every audio
   upload returns: *"new row violates row-level security policy"*.

3. Supabase database schema files are **historical reference only** — radio
   submissions now live in Firestore, not Supabase tables.

### 2. Supabase Storage Buckets

Run **`aurenix-storage-firebase-fix.sql`** in the Supabase SQL Editor. It will:

- Drop the old `auth.uid()`-based storage policies (which break without Supabase Auth)
- Add anon-role INSERT policy for `radio/` prefix uploads
- Add anon-role SELECT policy for `radio/` prefix playback
- Leave `aurenix-media` bucket policies unchanged

| Bucket | Public | Max Size | Used by |
|--------|--------|----------|---------|
| `aurenix-radio` | ✗ (private) | 50 MB | Radio audio submissions |
| `aurenix-media` | ✗ (private) | 200 MB | Media uploads |

> **Important:** Both buckets are **private** (not globally public). Uploaded files
> are stored under `radio/<firebase_uid>/<timestamp>.<ext>`. The anon-role policy
> restricts uploads to the `radio/` prefix only. Playback URLs are constructed from
> Firestore `storage_path` field via `getPublicUrl()`.
> Do **not** make these buckets globally public — that would expose pending/rejected audio.

### 3. Admin Account

The only AURENIX administrator is **christijerina46@gmail.com**.

1. Sign in (or register) with this exact email through the AURENIX sign-in form
2. **Verify the email address** — Firebase Auth sends a verification link to the inbox.
   This step is mandatory. Without `emailVerified = true`, the admin dashboard will
   show **"EMAIL NOT VERIFIED"** even after signing in with the correct credentials.
3. To manually force-verify in the Firebase Console:
   - Open [Firebase Console → Authentication → Users](https://console.firebase.google.com/project/remix-studio-4bf8a/authentication/users)
   - Find `christijerina46@gmail.com`
   - If the Email Verified column shows ✗, click the three-dot menu → **Edit user** → tick "Email verified" → Save
4. The admin UI (admin button in nav, full dashboard, Radio Moderation controls) appears automatically after sign-in

**Identity check order (aurenix-admin.js):**
1. If `auth.currentUser === null` → Firebase Auth not yet resolved → shows "Verifying…" (NOT Access Denied)
2. If email matches `ADMIN_EMAIL` but `emailVerified === false` → shows "EMAIL NOT VERIFIED" with console link
3. If wrong email → ACCESS DENIED
4. If email matches AND verified → Admin Dashboard rendered

**Security model:**
- Admin identity is verified via Firebase JWT (`user.email` + `user.emailVerified` from Firebase Auth object)
- **Never** uses localStorage, URL params, username, or any client-controlled value
- Firestore Security Rules enforce permissions server-side independently of JS
- Client-side code only controls UI visibility — not actual access
- Unauthorized users receive **ACCESS DENIED** regardless of JS manipulation

### 4. 24-Hour Cloud Stream (Cloudflare)

The Cloud Stream is a completely separate system in `24-hour-cloud-stream/`.
It uses Cloudflare Durable Objects. See `24-hour-cloud-stream/README.md` for its own setup.

**Do not merge it with AURENIX Radio.**

---

## Project Structure

```
/
├── aurenix.html              # Main AURENIX shell (all sections)
├── aurenix-core.css          # Core visual system (Egyptian+Horror+Futuristic)
├── aurenix-extensions.css    # Auth, Admin, Media, Community CSS additions
├── aurenix-nav.js            # Client-side routing
├── aurenix-bg.js             # Particle background system
├── aurenix-crow.js           # Flying Crow event system
├── aurenix-auth.js           # Authentication (Supabase Auth)
├── aurenix-radio.js          # AURENIX Radio (queue, player, submissions)
├── aurenix-live-section.js   # Live section (reads live_rooms)
├── aurenix-media.js          # Media vault (upload, playback, comments)
├── aurenix-community.js      # Community (posts, profiles, follows)
├── aurenix-admin.js          # Admin dashboard (admin-only)
├── aurenix-sw.js             # Service Worker (PWA)
├── aurenix-manifest.json     # PWA manifest
├── aurenix-favicon.svg       # SVG favicon
├── aurenix-radio.html        # Full-page AURENIX Radio station
├── live.html                 # Live stream page (host + viewer)
├── live-hub.html             # Live Hub (discovery)
├── live.js                   # Live stream engine
├── live.css                  # Live stream CSS
├── supabase-client.js        # Supabase client (CONFIGURE THIS)
├── supabase-schema.sql       # Original schema (reference only)
├── AURENIX-RUN-IN-SUPABASE.sql # Run this ONCE to prepare your live DB
└── 24-hour-cloud-stream/     # Independent 24H Cloud Stream system
    ├── index.html
    ├── js/cloud-stream.js
    ├── css/cloud-stream.css
    └── workers/cloudstream-worker.js
```

---

## Security Architecture

### Admin Enforcement (Multi-Layer)

1. **Email verification** — Only `christijerina46@gmail.com` with `emailVerified=true` gets admin flag
2. **Firebase JWT check** — `aurenix-auth.js` checks `user.email` + `user.emailVerified` from Firebase Auth
3. **Firestore Security Rules** — enforce permissions server-side independently:
   - Radio submissions: only admin can change status away from `pending`
   - Radio reports: only admin can read or resolve
   - Site settings: only admin can write
4. **Double verification** — `aurenix-admin.js` calls `_verifyAdmin()` (re-reads `auth.currentUser`) before every sensitive operation
5. **UI hiding** — Elements with `data-admin-only` hidden via CSS/JS (defense-in-depth only)

### What Regular Users Cannot Access
- Admin dashboard (shows ACCESS DENIED)
- Radio moderation (Firestore rules reject status changes)
- Approve/reject radio submissions (Firestore rules protected)
- Other users' private data (Firestore rules: `submitted_by == request.auth.uid`)
- Other users' pending audio (Supabase Storage: only `radio/` prefix readable)

### Direct URL Attack Protection
- Accessing `#admin` while not admin: shows ACCESS DENIED UI
- Direct Firestore writes without auth: rejected by Security Rules
- Editing localStorage/client state: has no effect on server-side rules

---

## PWA Icons

The manifest references `aurenix-icon-192.png` and `aurenix-icon-512.png`.
Generate these from the SVG favicon:

```bash
# Using Inkscape
inkscape aurenix-favicon.svg -w 192 -h 192 -o aurenix-icon-192.png
inkscape aurenix-favicon.svg -w 512 -h 512 -o aurenix-icon-512.png
```

Or use any online SVG-to-PNG converter.

---

## Feature Checklist

### Already Working (preserved)
- [x] AURENIX CORE — cinematic hero, section cards, navigation
- [x] Flying Crow — mechanical crow event with transmissions
- [x] Background particles — gold/cyan atmospheric system
- [x] Scan line effect — CRT-style visual overlay
- [x] Navigation — hash routing, mobile drawer
- [x] 24-Hour Cloud Stream — completely separate, untouched
- [x] Live streaming — WebRTC via Supabase Broadcast (live.html)
- [x] Live Hub — discovery page (live-hub.html)
- [x] AURENIX Radio — queue display with Supabase Realtime

### New in This Build
- [x] Authentication — Sign In / Register / Password Reset modal
- [x] User profile pill in navigation
- [x] Admin button (admin-only, verified)
- [x] Admin Dashboard — radio queue, media, users, crow settings, site settings
- [x] Real audio player — `<audio>` element with progress, mute, volume
- [x] YouTube embed player — official embed, no download
- [x] Audio file upload to Supabase Storage
- [x] Radio queue: only approved tracks shown publicly
- [x] Media section — upload, browse, playback, likes, comments
- [x] Community section — feed, posts, likes, comments, profiles, follow, notifications
- [x] PWA Service Worker — app shell caching, offline fallback
- [x] PWA install banner — real BeforeInstallPromptEvent
- [x] Admin-only sections — ACCESS DENIED for unauthorized users
- [x] Professional error messages — no raw backend errors exposed

---

## QA Checklist

### Admin Flow (christijerina46@gmail.com)
- [ ] Sign in → admin button appears in nav
- [ ] Navigate to Admin → dashboard mounts
- [ ] Approve/reject radio submissions
- [ ] View all users
- [ ] Crow settings controls work
- [ ] Site settings save

### Normal User Flow
- [ ] Register new account
- [ ] Sign in
- [ ] Navigate to Community → post content
- [ ] Like posts, add comments
- [ ] Submit radio track (shows pending confirmation)
- [ ] Upload media (video/audio)
- [ ] Navigate to Admin → ACCESS DENIED shown
- [ ] Approve/reject endpoints → Supabase returns RLS error

### Guest (Logged Out) Flow
- [ ] Community → sign-in prompt shown (no content creation)
- [ ] Radio queue visible (approved only)
- [ ] Media browse visible
- [ ] Admin URL → ACCESS DENIED shown
- [ ] Live → discovery works, "Go Live" requires auth

### Preserved Systems
- [ ] 24-Hour Cloud Stream still works independently
- [ ] Flying Crow still fires on schedule
- [ ] Live streaming (live.html) unchanged
- [ ] Live Hub (live-hub.html) unchanged

---

## Notes

- **No credentials in frontend code** — the Supabase anon key is the public API key; it is safe to include as it's scoped by RLS. Never include the service role key in client code.
- **File uploads require Storage buckets** to be created before they work.
- **YouTube embeds** use official iframe embed — audio is never downloaded or re-broadcast.
- **The 24-Hour Cloud Stream** has its own Supabase + Cloudflare Workers configuration. See its own README.
