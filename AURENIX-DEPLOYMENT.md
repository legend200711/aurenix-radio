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

### 1. Supabase Project

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Go to **Settings → API** and copy:
   - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - **Anon public key**

3. Open `supabase-client.js` and replace the placeholders:
```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

4. Run the schema migrations in **Supabase → SQL Editor** (in order):
   1. `AURENIX-RUN-IN-SUPABASE.sql` — core schema, RLS, RPCs (idempotent)
   2. `aurenix-radio-fix.sql` — radio queue table and policies (idempotent)
   3. **`aurenix-radio-station.sql`** — **NEW** shared continuous station state table, `advance_radio_station` RPC, Realtime subscription (run this once to enable the shared radio station)

   All files are idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`). Safe to re-run.

5. Enable **Email Auth** in **Authentication → Providers**

6. Set **Site URL** in **Authentication → URL Configuration** to your domain

### 2. Supabase Storage Buckets

Create two buckets in **Storage**:

| Bucket | Public | Max Size | MIME Types |
|--------|--------|----------|------------|
| `aurenix-media` | ✓ | 200 MB | `video/*, audio/*, image/*` |
| `aurenix-radio` | ✓ | 50 MB | `audio/*` |

Storage policies are already applied by `AURENIX-RUN-IN-SUPABASE.sql` — no additional SQL needed.

### 3. Admin Account

The only AURENIX administrator is **christijerina46@gmail.com**.

1. Register this email through the AURENIX sign-in form
2. Confirm the email via the verification link
3. The admin UI (admin button, dashboard, moderation) will appear automatically

**Security model:**
- Admin identity is verified via Supabase JWT (email in token)
- Supabase RLS enforces permissions server-side independently
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

1. **Email verification** — Only `christijerina46@gmail.com` with confirmed email gets admin flag
2. **JWT-based check** — `aurenix-auth.js` checks `user.email` from verified Supabase JWT
3. **Supabase RLS** — Row Level Security policies enforce permissions independently:
   - Radio moderation: only `role IN ('founder', 'administrator', 'moderator')`
   - Media moderation: same
   - Site settings: only `role IN ('founder', 'administrator')`
4. **Double verification** — `aurenix-admin.js` re-fetches user from Supabase before mounting
5. **UI hiding** — Elements with `data-admin-only` hidden via CSS/JS (defense-in-depth only)

### What Regular Users Cannot Access
- Admin dashboard (shows ACCESS DENIED)
- Radio moderation panel (RLS rejects writes)
- Approve/reject radio submissions (RLS protected)
- Media moderation (RLS protected)
- Other users' private data (RLS: `auth.uid() = id`)
- Other users' uploaded files (Storage RLS: folder = uid)

### Direct URL Attack Protection
- Accessing `#admin` while not admin: shows ACCESS DENIED UI
- Direct Supabase API calls without auth: rejected by RLS
- Editing localStorage/client state: has no effect on server-side RLS

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
