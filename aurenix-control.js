/**
 * AURENIX FOUNDER PANEL
 * aurenix-control.js
 *
 * Founder-only. Loaded lazily when Founder clicks FOUNDER PANEL.
 * Authorization is enforced BOTH here (email check) AND in Firestore
 * Security Rules (isAdmin() function checks email + email_verified).
 *
 * Firestore collections:
 *   network_media/{id}     — media library (all uploads)
 *   network_state/{id}     — live playback state per channel
 *   network_channels/{id}  — channel definitions
 *   founder_stats/global   — broadcast statistics
 *
 * Storage: Supabase aurenix-media bucket — uploads go via the secure
 *   Cloudflare Worker (UPLOAD_WORKER_URL) which verifies the Firebase
 *   ID token server-side and uses the Supabase service-role key.
 *   The service-role key NEVER touches browser JavaScript.
 */

import {
  auth, db,
  doc, getDoc, setDoc, collection, getDocs, addDoc,
  updateDoc, deleteDoc, onSnapshot, serverTimestamp,
  query, orderBy, where, limit,
} from './firebase-client.js';

import {
  ONE_CHANNEL_ID,
  COMMERCIAL_FREQ,
  startOneEngine,
  stopOneEngine,
  pauseOneEngine,
  resumeOneEngine,
  forceCommercialBreak,
  skipCurrentProgram as oneSkipProgram,
  updateMediaLib as oneUpdateMedia,
  saveOneConfig,
  getOneConfig,
  getOneHistory,
  getOneState,
} from './aurenix-one-engine.js';

// Supabase client is used ONLY for the delete action (anon DELETE policy
// on storage.objects is kept intentionally). Uploads go through the
// Cloudflare Worker instead — supabase is not used for INSERT here.
import { supabase } from './supabase-client.js';

/* ═══════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════ */
const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const MEDIA_BUCKET  = 'aurenix-media';
// No client-side file-size cap is imposed.
// The Supabase bucket file_size_limit (enforced by the Worker) is the real limit.
// Surfacing the actual storage-provider error is better than an arbitrary app limit.
const MAX_FILE_MB   = null; // intentionally unset — no artificial limit

/**
 * URL of the deployed Cloudflare Worker that brokers uploads.
 * Set this to your Worker's URL after running:
 *   cd upload-worker && npx wrangler deploy
 *
 * Example: 'https://aurenix-upload.YOUR_SUBDOMAIN.workers.dev'
 *
 * The Worker verifies the Firebase ID token, confirms the Founder email,
 * then uploads to Supabase using the server-side service-role key.
 * Regular users are rejected at the Worker with HTTP 403.
 */
const UPLOAD_WORKER_URL = 'https://aurenix-upload.nthntjrn.workers.dev';

// Channels are loaded from Firestore `network_channels` — NOT hardcoded.
// _dbChannels is the live list; _channels() returns it.
let _dbChannels = [];     // loaded from Firestore
let _dbChUnsub  = null;   // unsubscribe for network_channels listener

function _channels() { return _dbChannels; }

const MEDIA_CATEGORIES = [
  { id: 'music',         label: '🎵 MUSIC',            accept: 'audio/*',                  type: 'audio'  },
  { id: 'video',         label: '🎬 VIDEO',             accept: 'video/*',                  type: 'video'  },
  // music_video accepts video AND image/* — a still photo used as artwork for a song
  // is a valid music video format (static image + audio track).
  { id: 'music_video',   label: '🎞 MUSIC VIDEO',       accept: 'video/*,image/*',          type: 'music_video' },
  { id: 'show',          label: '📺 SHOW',              accept: 'video/*',                  type: 'show'   },
  { id: 'broadcast_clip',label: '🎥 BROADCAST CLIP',    accept: 'video/*,audio/*',          type: 'broadcast_clip' },
  { id: 'podcast',       label: '🎙 PODCAST',           accept: 'audio/*',                  type: 'podcast' },
  { id: 'audio_program', label: '🎧 AUDIO PROGRAM',     accept: 'audio/*',                  type: 'audio_program' },
  { id: 'station_id',    label: '📢 STATION ID / INTRO',accept: 'audio/*,video/*',          type: 'station_id' },
  { id: 'thumbnail',     label: '🖼 THUMBNAIL',          accept: 'image/*',                  type: 'thumbnail' },
  { id: 'trailer',       label: '🎞 TRAILER',            accept: 'video/*',                  type: 'trailer' },
  { id: 'archive',       label: '📼 ARCHIVED BROADCAST', accept: 'video/*,audio/*',         type: 'archive' },
];

const LIB_FILTERS = [
  { id: 'all',           label: 'ALL'      },
  { id: 'audio',         label: 'MUSIC'    },
  { id: 'video',         label: 'VIDEOS'   },
  { id: 'show',          label: 'SHOWS'    },
  { id: 'podcast',       label: 'AUDIO'    },
  { id: 'broadcast_clip',label: 'CLIPS'    },
  { id: 'archive',       label: 'ARCHIVE'  },
];

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let _user            = null;
let _isFounder       = false;
let _mediaLib        = [];
let _channelStates   = {};
let _schedChannelId  = 'A1';
let _stateUnsubs     = {};
let _libUnsub        = null;
let _libFilter       = 'all';
let _libSearch       = '';
let _uploadCategory  = 'music';
let _pendingMeta     = {};   // fileKey → metadata fields
let _activePane      = 'dashboard';
let _broadcastTarget = null; // { channelId, mediaId, mode }
let _oneEngineRunning = false;
let _oneConfigUnsub   = null;
let _oneStateUnsub    = null;

/* ═══════════════════════════════════════
   ENTRY POINT
═══════════════════════════════════════ */
export function mountControl(user, isAdmin) {
  _user      = user;
  _isFounder = isAdmin;

  // Double-check founder email (normalized comparison)
  const userEmail = (_user?.email || '').trim().toLowerCase();

  let ctrl = document.getElementById('ax-control');
  if (!ctrl) {
    ctrl = document.createElement('div');
    ctrl.id = 'ax-control';
    document.body.appendChild(ctrl);
  }

  if (!_isFounder || !_user || userEmail !== FOUNDER_EMAIL.toLowerCase()) {
    console.warn('[AURENIX] Founder access denied for:', userEmail);
    ctrl.innerHTML = `
      <div class="ax-ctrl-error">
        <div style="font-size:clamp(20px,3vw,32px);font-weight:900;letter-spacing:0.2em;color:#c8d0e8;">
          AURE<span style="color:#4d7aff">NIX</span>
        </div>
        <div style="font-size:11px;letter-spacing:3px;color:#4d7aff;text-transform:uppercase;margin-bottom:8px;">
          ACCESS DENIED
        </div>
        <div class="ax-ctrl-error-msg">
          This area is restricted to the Founder account only.<br>
          <span style="color:#6870a0;font-size:11px;">Signed in as: ${_esc(userEmail)}</span>
        </div>
        <button onclick="document.getElementById('ax-control').classList.remove('visible');const h=document.getElementById('ax-hero');if(h)h.style.display='';"
                style="margin-top:8px;padding:10px 24px;background:#1e1e34;color:#c8d0e8;border:1px solid rgba(30,80,255,0.35);border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
          ← BACK TO BROADCAST
        </button>
      </div>`;
    return;
  }

  const _restoreHero = () => {
    ctrl.classList.remove('visible');
    const h = document.getElementById('ax-hero');
    if (h) h.style.display = '';
  };

  try {
    ctrl.innerHTML = _buildFounderHTML();
    ctrl.classList.add('visible');
    const hero = document.getElementById('ax-hero');
    if (hero) hero.style.display = 'none';

    // Subscribe to channels from DB, then subscribe to their states + render
    _subscribeDBChannels(() => {
      _channels().forEach(ch => _subscribeChannelState(ch.id));
      _rebuildDynamicPanes();
      _renderDashboard();
      _renderChannels();
      _bindLiveControl();
      _renderStats();
    });

    _subscribeMedia();
    _subscribeSubmissions();

    // AURENIX ONE engine pane
    _bindOnePane();

    // Bind nav
    ctrl.querySelectorAll('.ax-ctrl-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pane = btn.dataset.pane;
        if (!pane) return;
        _switchPane(pane);
      });
    });

    _bindUploadPane();
    _bindSchedulePane();
    _bindLibraryPane();
    _bindChannelManager();
    _bindApprovalPane();

    // Close button
    ctrl.querySelector('#ax-ctrl-close')?.addEventListener('click', _restoreHero);

    // Refresh btn
    ctrl.querySelector('#ax-ov-refresh-btn')?.addEventListener('click', () => {
      _renderChannels();
      _renderDashboard();
      _toast('Refreshed.');
    });

    // Worker health check
    _checkWorkerHealth();
    ctrl.querySelector('#ax-sec-recheck-btn')?.addEventListener('click', _checkWorkerHealth);

    // Probe upload limit button
    ctrl.querySelector('#ax-sec-probe-limit-btn')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('ax-sec-limit-result');
      const effEl    = document.getElementById('ax-sec-eff-limit');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = 'Probing…'; }
      if (effEl)    { effEl.textContent = 'probing…'; effEl.style.color = ''; }
      try {
        const res  = await fetch(UPLOAD_WORKER_URL + '/probe-limit');
        const data = await res.json();
        const lastMB  = data.last_successful_upload_MB || 0;
        const firstMB = data.first_failed_upload_MB;
        const limText = firstMB
          ? `${lastMB} MB ✓ / ${firstMB} MB ✗ — limit between ${lastMB} and ${firstMB} MB`
          : `≥ ${lastMB} MB (all tested sizes OK)`;
        if (effEl) { effEl.textContent = limText; effEl.style.color = firstMB ? 'var(--orange,#f90)' : 'var(--green)'; }
        if (resultEl) resultEl.textContent = JSON.stringify(data, null, 2);
        _toast(`Upload limit probe complete: ${limText}`);
      } catch (e) {
        if (effEl) { effEl.textContent = '✗ Probe failed'; effEl.style.color = 'var(--red)'; }
        if (resultEl) { resultEl.textContent = 'Error: ' + e.message; }
        _toast('Probe failed: ' + e.message, 'err');
      }
    });

    // Set storage limit button
    ctrl.querySelector('#ax-sec-fix-limit-btn')?.addEventListener('click', async () => {
      const resultEl = document.getElementById('ax-sec-limit-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = 'Calling /set-storage-limit…'; }
      try {
        const res  = await fetch(UPLOAD_WORKER_URL + '/set-storage-limit');
        const data = await res.json();
        if (resultEl) resultEl.textContent = JSON.stringify(data, null, 2);
        const projectOk = data.project?.ok;
        const note      = data.project?.note || '';
        if (projectOk) {
          _toast('Storage limit set successfully: ' + note);
        } else {
          _toast('Storage limit update: ' + (note.slice(0, 120) || 'see result panel'), 'warn');
        }
      } catch (e) {
        if (resultEl) { resultEl.textContent = 'Error: ' + e.message; }
        _toast('Set storage limit failed: ' + e.message, 'err');
      }
    });

    // Seed initial channels if none exist yet
    _seedInitialChannels();

  } catch (err) {
    console.error('[AURENIX] Founder Studio mount error:', err);
    ctrl.innerHTML = `
      <div class="ax-ctrl-error">
        <div style="font-size:clamp(20px,3vw,32px);font-weight:900;letter-spacing:0.2em;color:#c8d0e8;">
          AURE<span style="color:#4d7aff">NIX</span>
        </div>
        <div style="font-size:11px;letter-spacing:3px;color:#4d7aff;text-transform:uppercase;margin-bottom:8px;">
          FOUNDER STUDIO — ERROR
        </div>
        <div class="ax-ctrl-error-msg">
          <strong>Studio failed to initialize</strong><br>
          ${err?.message ? String(err.message).replace(/</g,'&lt;') : 'An unexpected error occurred.'}<br>
          <span style="color:#6870a0;font-size:11px;">Open the browser console for more details.</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:4px;">
          <button onclick="document.getElementById('ax-control').classList.remove('visible');const h=document.getElementById('ax-hero');if(h)h.style.display='';"
                  style="padding:10px 24px;background:#1e1e34;color:#c8d0e8;border:1px solid rgba(30,80,255,0.35);border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
            ← BACK TO BROADCAST
          </button>
          <button onclick="location.reload()"
                  style="padding:10px 24px;background:#1e50ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
            RETRY
          </button>
        </div>
      </div>`;
    _toast('FOUNDER STUDIO ERROR — ' + (err?.message || 'See console.'), 'err');
  }
}

function _switchPane(pane) {
  _activePane = pane;
  const ctrl = document.getElementById('ax-control');
  if (!ctrl) return;
  ctrl.querySelectorAll('.ax-ctrl-nav-btn').forEach(b => b.classList.remove('active'));
  ctrl.querySelector(`[data-pane="${pane}"]`)?.classList.add('active');
  ctrl.querySelectorAll('.ax-ctrl-pane').forEach(p => p.classList.remove('active'));
  ctrl.querySelector(`#ax-pane-${pane}`)?.classList.add('active');
}

/* ═══════════════════════════════════════
   HTML SHELL
═══════════════════════════════════════ */
function _buildFounderHTML() {
  return `
<div class="ax-ctrl-layout">
  <aside class="ax-ctrl-sidebar">
    <div class="ax-ctrl-founder-badge">
      <div style="flex-shrink:0;">
        <svg viewBox="0 0 64 64" fill="none" width="28" height="28">
          <polygon points="32,6 58,56 6,56" fill="none" stroke="#b8860b" stroke-width="1.5" opacity="0.9"/>
          <ellipse cx="32" cy="38" rx="13" ry="9" fill="none" stroke="#1e50ff" stroke-width="1.3"/>
          <circle cx="32" cy="38" r="2.5" fill="#1e50ff"/>
        </svg>
      </div>
      <div>
        <div class="ax-ctrl-founder-title">AURENIX</div>
        <div class="ax-ctrl-founder-sub">⚡ FOUNDER STUDIO</div>
      </div>
    </div>
    <div class="ax-ctrl-section-label">CONTROL CENTER</div>
    <button class="ax-ctrl-nav-btn active" data-pane="dashboard">
      <span class="ax-ctrl-nav-icon">🏠</span> Dashboard
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="approval" id="ax-nav-approval">
      <span class="ax-ctrl-nav-icon">🔍</span> Pending Approval <span id="ax-approval-badge" style="display:none;background:var(--orange,#f0a500);color:#000;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:4px;font-weight:900;"></span>
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="network">
      <span class="ax-ctrl-nav-icon">📡</span> Network Control
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="live">
      <span class="ax-ctrl-nav-icon">🔴</span> Live Control
    </button>
    <div class="ax-ctrl-section-label">MEDIA</div>
    <button class="ax-ctrl-nav-btn" data-pane="upload">
      <span class="ax-ctrl-nav-icon">⬆️</span> Upload Center
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="library">
      <span class="ax-ctrl-nav-icon">📚</span> Media Library
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="music-lib">
      <span class="ax-ctrl-nav-icon">🎵</span> Music Library
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="video-lib">
      <span class="ax-ctrl-nav-icon">🎬</span> Video Library
    </button>
    <div class="ax-ctrl-section-label">BROADCAST</div>
    <button class="ax-ctrl-nav-btn" data-pane="aurenix-one">
      <span class="ax-ctrl-nav-icon">🔴</span> AURENIX ONE <span id="ax-one-engine-badge" style="display:none;background:var(--red);color:#fff;border-radius:10px;padding:1px 6px;font-size:9px;margin-left:4px;font-weight:900;letter-spacing:0.5px;">LIVE</span>
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="channels">
      <span class="ax-ctrl-nav-icon">📺</span> Channel Manager
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="schedule">
      <span class="ax-ctrl-nav-icon">📅</span> Broadcast Scheduler
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="submissions" id="ax-nav-submissions">
      <span class="ax-ctrl-nav-icon">📥</span> Submissions <span id="ax-submissions-badge" style="display:none;background:var(--red);color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:4px;"></span>
    </button>
    <div class="ax-ctrl-section-label">SYSTEM</div>
    <button class="ax-ctrl-nav-btn" data-pane="stats">
      <span class="ax-ctrl-nav-icon">📊</span> Statistics
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="security">
      <span class="ax-ctrl-nav-icon">🛡️</span> Security / Access
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="settings">
      <span class="ax-ctrl-nav-icon">⚙️</span> AURENIX Settings
    </button>
    <div style="flex:1;"></div>
    <button class="ax-ctrl-nav-btn ax-ctrl-exit-btn" id="ax-ctrl-close">
      <span class="ax-ctrl-nav-icon">✕</span> Exit Panel
    </button>
  </aside>

  <main class="ax-ctrl-content">

    <!-- ══ DASHBOARD ══ -->
    <div class="ax-ctrl-pane active" id="ax-pane-dashboard">
      <div class="ax-founder-header">
        <div class="ax-founder-header-title">AURENIX <span>FOUNDER STUDIO</span></div>
        <div class="ax-founder-header-sub" style="font-size:13px;letter-spacing:3px;color:var(--blue-bright);font-weight:700;text-transform:uppercase;margin-top:2px;">CONTROL THE BROADCAST</div>
        <div class="ax-founder-header-sub" style="margin-top:6px;">Network Status: <span class="ax-badge-online">🟢 ONLINE</span></div>
      </div>
      <div class="ax-dash-channels" id="ax-dash-channels"></div>
      <div class="ax-dash-grid">
        <div class="ax-dash-card">
          <div class="ax-dash-card-title">NOW PLAYING</div>
          <div id="ax-dash-nowplaying"><div style="color:var(--text-dim);font-size:12px;">Loading channels…</div></div>
        </div>
        <div class="ax-dash-card">
          <div class="ax-dash-card-title">QUEUE STATUS</div>
          <div id="ax-dash-queues"><div style="color:var(--text-dim);font-size:12px;">Loading…</div></div>
        </div>
        <div class="ax-dash-card">
          <div class="ax-dash-card-title">RECENT UPLOADS</div>
          <div id="ax-dash-recent" style="display:flex;flex-direction:column;gap:6px;">
            <div style="color:var(--text-dim);font-size:12px;">Loading…</div>
          </div>
        </div>
        <div class="ax-dash-card">
          <div class="ax-dash-card-title">24/7 WARNINGS</div>
          <div id="ax-dash-warnings"></div>
        </div>
      </div>
    </div>

    <!-- ══ NETWORK CONTROL ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-network">
      <div class="ax-section-title">Network <span>Control</span></div>
      <div class="ax-status-bar">
        <div class="ax-status-item"><div class="ax-status-dot online"></div>AURENIX NETWORK ONLINE</div>
        <div class="ax-status-item"><div class="ax-status-dot live"></div><span id="ax-ov-live-count">—</span> CHANNELS BROADCASTING</div>
      </div>
      <div class="ax-channels-grid" id="ax-ov-channels"></div>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
        <button class="ax-btn-sm" id="ax-ov-refresh-btn">↺ Refresh All</button>
      </div>
    </div>

    <!-- ══ LIVE CONTROL — cards injected dynamically ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-live">
      <div class="ax-section-title">🔴 Live <span>Control</span></div>
      <div class="ax-live-grid" id="ax-live-grid">
        <div style="color:var(--text-dim);font-size:12px;padding:24px;">Loading channels…</div>
      </div>
    </div>

    <!-- ══ PENDING APPROVAL PANE ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-approval">
      <div class="ax-section-title">Pending <span>Approval</span></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-dim);">
        <strong style="color:var(--text);">UPLOAD → PENDING APPROVAL → APPROVE / REJECT → BROADCAST</strong><br>
        Every uploaded file lands here first. Preview it, then approve or reject.<br>
        Only <strong style="color:var(--green);">APPROVED</strong> media can be added to a channel, playlist, or broadcast schedule.
      </div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;" id="ax-approval-filter-bar">
        <button class="ax-btn-sm ax-approval-filter active" data-status="pending_approval">PENDING</button>
        <button class="ax-btn-sm ax-approval-filter" data-status="approved">APPROVED</button>
        <button class="ax-btn-sm ax-approval-filter" data-status="rejected">REJECTED</button>
        <button class="ax-btn-sm ax-approval-filter" data-status="all">ALL</button>
      </div>
      <div id="ax-approval-list">
        <div style="color:var(--text-dim);font-size:12px;padding:24px;">Loading…</div>
      </div>
    </div>

    <!-- ══ UPLOAD CENTER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-upload">
      <div class="ax-section-title">Upload <span>Center</span></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-dim);">
        <strong style="color:var(--text);">Upload anything you have the legal right to submit.</strong><br>
        All submissions are reviewed by the Founder before they can be broadcast.<br>
        Accepted: moving video, people, faces, music videos, slideshows, cat videos, podcasts, funny clips, large MP4s — any technically-supported file.<br>
        <strong style="color:var(--orange,#f0a500);">Uploading does not broadcast.</strong> The Founder reviews and approves each file before it enters any channel or playlist.
      </div>
      <div class="ax-upload-categories">
        ${MEDIA_CATEGORIES.map(cat => `
          <button class="ax-upload-cat-btn ${cat.id === 'music' ? 'active' : ''}" data-cat="${cat.id}" data-accept="${cat.accept}">
            ${cat.label}
          </button>`).join('')}
      </div>
      <div class="ax-upload-zone" id="ax-upload-zone">
        <div class="ax-upload-icon">🎬</div>
        <div class="ax-upload-title">DROP MEDIA HERE</div>
        <div class="ax-upload-sub">or SELECT FILES — multiple files supported</div>
        <div class="ax-upload-sub" style="margin-top:6px;font-size:11px;opacity:0.6;">
          Audio: MP3 WAV AAC OGG FLAC M4A &nbsp;|&nbsp; Video: MP4 WebM MOV AVI MKV &nbsp;|&nbsp; Images: JPG PNG WebP GIF
        </div>
        <input type="file" id="ax-file-input" multiple accept="audio/*,video/*,image/*" style="display:none;">
      </div>
      <div class="ax-upload-progress-list" id="ax-upload-list"></div>
    </div>

    <!-- ══ MEDIA LIBRARY ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-library">
      <div class="ax-section-title">Media <span>Library</span></div>
      <div class="ax-lib-toolbar">
        <div class="ax-lib-filters" id="ax-lib-filter-row">
          ${LIB_FILTERS.map(f => `<button class="ax-btn-sm ax-lib-filter ${f.id === 'all' ? 'active' : ''}" data-type="${f.id}">${f.label}</button>`).join('')}
        </div>
        <input class="ax-lib-search" id="ax-lib-search" type="search" placeholder="Search title, artist, creator…">
      </div>
      <div class="ax-lib-grid" id="ax-lib-grid">
        <div class="ax-empty"><div class="ax-empty-icon">📚</div><div class="ax-empty-title">Loading library…</div></div>
      </div>
    </div>

    <!-- ══ MUSIC LIBRARY ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-music-lib">
      <div class="ax-section-title">Music <span>Library</span></div>
      <div class="ax-lib-grid" id="ax-music-lib-grid">
        <div class="ax-empty"><div class="ax-empty-icon">🎵</div><div class="ax-empty-title">Loading…</div></div>
      </div>
    </div>

    <!-- ══ VIDEO LIBRARY ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-video-lib">
      <div class="ax-section-title">Video <span>Library</span></div>
      <div class="ax-lib-grid" id="ax-video-lib-grid">
        <div class="ax-empty"><div class="ax-empty-icon">🎬</div><div class="ax-empty-title">Loading…</div></div>
      </div>
    </div>

    <!-- ══ AURENIX ONE — LIVE TV ENGINE ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-aurenix-one">
      <div class="ax-section-title">🔴 AURENIX <span>ONE</span></div>

      <!-- Status Bar -->
      <div class="ax-one-status-bar" id="ax-one-status-bar">
        <div class="ax-one-status-live" id="ax-one-status-live">
          <span class="ax-one-live-dot" id="ax-one-live-dot"></span>
          <span id="ax-one-status-text">CHANNEL OFFLINE</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);" id="ax-one-engine-state">Engine not started</div>
      </div>

      <!-- Engine Controls -->
      <div class="ax-one-section-label">LIVE CHANNEL CONTROL</div>
      <div class="ax-one-controls-grid">
        <button class="ax-one-ctrl-btn ax-one-btn-start" id="ax-one-start-btn">▶ START CHANNEL</button>
        <button class="ax-one-ctrl-btn ax-one-btn-stop"  id="ax-one-stop-btn">■ STOP CHANNEL</button>
        <button class="ax-one-ctrl-btn" id="ax-one-pause-btn">⏸ PAUSE BROADCAST</button>
        <button class="ax-one-ctrl-btn" id="ax-one-resume-btn">▶ RESUME BROADCAST</button>
        <button class="ax-one-ctrl-btn" id="ax-one-skip-btn">⏭ SKIP CURRENT PROGRAM</button>
        <button class="ax-one-ctrl-btn" id="ax-one-force-comm-btn">📢 FORCE COMMERCIAL BREAK</button>
      </div>

      <!-- Now Playing / Up Next -->
      <div class="ax-one-section-label">ON AIR</div>
      <div class="ax-one-on-air-grid">
        <div class="ax-one-now-card">
          <div class="ax-one-card-label"><span class="ax-one-live-dot"></span> NOW PLAYING</div>
          <div class="ax-one-now-title" id="ax-one-now-title">—</div>
          <div class="ax-one-now-meta"  id="ax-one-now-meta">No broadcast active</div>
          <div class="ax-one-progress-wrap">
            <div class="ax-one-progress-bar">
              <div class="ax-one-progress-fill" id="ax-one-progress-fill"></div>
            </div>
            <div class="ax-one-progress-times">
              <span id="ax-one-elapsed">0:00</span>
              <span id="ax-one-remain">—</span>
            </div>
          </div>
          <div class="ax-one-comm-indicator" id="ax-one-comm-indicator" style="display:none;">
            <span style="color:var(--gold);font-weight:700;font-size:11px;letter-spacing:1px;">📢 COMMERCIAL BREAK</span>
          </div>
        </div>
        <div class="ax-one-upnext-card">
          <div class="ax-one-card-label">UP NEXT</div>
          <div class="ax-one-now-title" id="ax-one-next-title">—</div>
          <div class="ax-one-now-meta"  id="ax-one-next-meta"></div>
        </div>
      </div>

      <!-- Broadcast History -->
      <div class="ax-one-section-label" style="margin-top:20px;display:flex;align-items:center;justify-content:space-between;">
        <span>BROADCAST HISTORY</span>
        <button class="ax-btn-sm" id="ax-one-refresh-hist">↺ Refresh</button>
      </div>
      <div id="ax-one-history-list" style="margin-bottom:20px;">
        <div style="color:var(--text-dim);font-size:12px;">History will appear here.</div>
      </div>

      <!-- Commercial Frequency -->
      <div class="ax-one-section-label">COMMERCIAL FREQUENCY</div>
      <div class="ax-one-freq-grid">
        <button class="ax-one-freq-btn" data-freq="off">OFF</button>
        <button class="ax-one-freq-btn" data-freq="low">LOW</button>
        <button class="ax-one-freq-btn active" data-freq="normal">NORMAL</button>
        <button class="ax-one-freq-btn" data-freq="high">HIGH</button>
      </div>

      <!-- Custom Frequency Settings -->
      <div class="ax-one-settings-grid" style="margin-top:14px;">
        <div class="ax-field-group">
          <label class="ax-field-label">Min programs between breaks</label>
          <input class="ax-field-input" type="number" id="ax-one-min-prog" min="1" max="99" value="2">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Max programs between breaks</label>
          <input class="ax-field-input" type="number" id="ax-one-max-prog" min="1" max="99" value="4">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Min commercials per break</label>
          <input class="ax-field-input" type="number" id="ax-one-min-spots" min="0" max="10" value="1">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Max commercials per break</label>
          <input class="ax-field-input" type="number" id="ax-one-max-spots" min="0" max="10" value="2">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Avoid-repeat window (# items)</label>
          <input class="ax-field-input" type="number" id="ax-one-repeat-window" min="0" max="100" value="10">
        </div>
      </div>
      <button class="ax-btn-sm" id="ax-one-save-settings" style="margin-top:10px;">💾 Save Commercial Settings</button>

      <!-- Eligible Content Categories -->
      <div class="ax-one-section-label" style="margin-top:20px;">ELIGIBLE CONTENT TYPES</div>
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">
        Only Founder-approved media of these types can play on AURENIX ONE.
        Commercials use a separate pool (promo/trailer/station_id).
      </div>
      <div id="ax-one-pool-info" style="font-size:12px;color:var(--text-dim);">Loading pool info…</div>
    </div>

    <!-- ══ CHANNEL MANAGER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-channels">
      <div class="ax-section-title">Channel <span>Manager</span></div>
      <div style="margin-bottom:16px;">
        <button class="ax-btn-primary" id="ax-create-channel-btn" style="font-size:13px;padding:10px 22px;">+ CREATE CHANNEL</button>
      </div>
      <div class="ax-channels-grid" id="ax-ch-manager-grid">
        <div style="color:var(--text-dim);font-size:12px;">Loading channels…</div>
      </div>
    </div>

    <!-- ══ BROADCAST SCHEDULER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-schedule">
      <div class="ax-section-title">Broadcast <span>Scheduler</span></div>
      <div class="ax-channel-picker" id="ax-sched-ch-picker">
        <div style="color:var(--text-dim);font-size:12px;">Loading channels…</div>
      </div>
      <label class="ax-loop-toggle">
        <input type="checkbox" id="ax-loop-toggle" checked>
        Loop playlist continuously (24/7 broadcast — channel never stops)
      </label>
      <div class="ax-sched-builder">
        <div>
          <div class="ax-sched-queue" id="ax-sched-queue">
            <div class="ax-sched-queue-header">
              <span class="ax-sched-queue-title" id="ax-sched-ch-label">Select a channel above</span>
              <div style="display:flex;gap:6px;">
                <button class="ax-btn-sm" id="ax-sched-push-btn">▶ GO LIVE</button>
                <button class="ax-btn-sm ax-btn-danger" id="ax-sched-clear-btn">✕ CLEAR</button>
              </div>
            </div>
            <div id="ax-sched-items"><div class="ax-sched-empty">No items — add from library →</div></div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="ax-on-air-widget" id="ax-on-air-widget">
            <div class="ax-on-air-label"><span class="ax-live-dot"></span> NOW ON AIR</div>
            <div class="ax-on-air-title" id="ax-oa-title">—</div>
            <div class="ax-on-air-meta" id="ax-oa-meta">Select a channel above</div>
          </div>
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;padding:0 2px;">Add from Library</div>
          <input class="ax-lib-search" id="ax-sched-search" type="search" placeholder="Search media…" style="margin-bottom:6px;">
          <div id="ax-sched-mini-lib" style="display:flex;flex-direction:column;gap:6px;max-height:480px;overflow-y:auto;">
            <div style="color:var(--text-muted);font-size:12px;padding:8px;">Loading library…</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ SUBMISSIONS ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-submissions">
      <div class="ax-section-title">User <span>Submissions</span></div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;" id="ax-sub-filter-bar">
        <button class="ax-btn-sm ax-sub-filter active" data-status="all">ALL</button>
        <button class="ax-btn-sm ax-sub-filter" data-status="pending">PENDING</button>
        <button class="ax-btn-sm ax-sub-filter" data-status="approved">APPROVED</button>
        <button class="ax-btn-sm ax-sub-filter" data-status="rejected">REJECTED</button>
      </div>
      <div id="ax-submissions-list">
        <div style="color:var(--text-dim);font-size:12px;padding:24px;">Loading submissions…</div>
      </div>
    </div>

    <!-- ══ STATISTICS ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-stats">
      <div class="ax-section-title">Broadcast <span>Statistics</span></div>
      <div class="ax-stats-grid" id="ax-stats-grid">
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-total">—</div><div class="ax-stat-label">Total Media</div></div>
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-audio">—</div><div class="ax-stat-label">Audio Tracks</div></div>
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-video">—</div><div class="ax-stat-label">Videos</div></div>
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-live">—</div><div class="ax-stat-label">Live Channels</div></div>
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-queued">—</div><div class="ax-stat-label">Items Queued</div></div>
        <div class="ax-stat-card"><div class="ax-stat-val" id="ax-stat-duration">—</div><div class="ax-stat-label">Total Duration</div></div>
      </div>
      <div style="margin-top:24px;">
        <div class="ax-section-title" style="font-size:13px;margin-bottom:12px;">Channel Breakdown</div>
        <div id="ax-stats-channels"></div>
      </div>
    </div>

    <!-- ══ SECURITY ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-security">
      <div class="ax-section-title">Security / <span>Access</span></div>
      <div class="ax-security-panel">
        <div class="ax-security-card">
          <div class="ax-security-title">🛡 FOUNDER ACCOUNT</div>
          <div class="ax-security-row"><span>Email</span><span class="ax-security-val">${FOUNDER_EMAIL}</span></div>
          <div class="ax-security-row"><span>Role</span><span class="ax-security-val ax-badge-founder">FOUNDER</span></div>
          <div class="ax-security-row"><span>Auth Backend</span><span class="ax-security-val">Firebase Authentication</span></div>
          <div class="ax-security-row"><span>DB Authorization</span><span class="ax-security-val">Firestore Rules — isAdmin()</span></div>
          <div class="ax-security-row"><span>Email Verified</span><span class="ax-security-val" id="ax-sec-verified">checking…</span></div>
          <div class="ax-security-row"><span>Storage Backend</span><span class="ax-security-val">Supabase (aurenix-media)</span></div>
        </div>
        <div class="ax-security-card">
          <div class="ax-security-title">🔒 ACCESS CONTROLS</div>
          <div class="ax-security-row"><span>Upload Media</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Approve / Reject</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Delete Media</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Modify Schedules</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Channel Control</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Play Now / Interrupt</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Add to Channel/Playlist</span><span class="ax-security-val" style="color:var(--orange,#f0a500)">APPROVED ONLY</span></div>
          <div class="ax-security-row"><span>View Public Broadcast</span><span class="ax-security-val" style="color:var(--green)">ALL VISITORS</span></div>
          <div class="ax-security-row"><span>Firestore Write Guard</span><span class="ax-security-val" style="color:var(--green)">SERVER-SIDE ✓</span></div>
        </div>
        <div class="ax-security-card" style="grid-column:1/-1;">
          <div class="ax-security-title">🔧 WORKER DIAGNOSTICS</div>
          <div class="ax-security-row"><span>Upload Worker URL</span><span class="ax-security-val" style="font-size:11px;word-break:break-all;">${UPLOAD_WORKER_URL}</span></div>
          <div class="ax-security-row"><span>Worker Status</span><span class="ax-security-val" id="ax-sec-worker">checking…</span></div>
          <div class="ax-security-row"><span>SUPABASE_URL</span><span class="ax-security-val" id="ax-sec-sup-url">…</span></div>
          <div class="ax-security-row"><span>SUPABASE_SERVICE_KEY</span><span class="ax-security-val" id="ax-sec-sup-key">…</span></div>
          <div class="ax-security-row"><span>FIREBASE_PROJECT_ID</span><span class="ax-security-val" id="ax-sec-fb-id">…</span></div>
          <div class="ax-security-row"><span>Bucket file_size_limit</span><span class="ax-security-val" id="ax-sec-bucket-limit">…</span></div>
          <div class="ax-security-row"><span>Effective Upload Limit</span><span class="ax-security-val" id="ax-sec-eff-limit">…</span></div>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <button class="ax-btn-sm" id="ax-sec-recheck-btn">↺ Re-check Worker</button>
            <button class="ax-btn-sm" id="ax-sec-probe-limit-btn">🔍 Probe Upload Limit</button>
            <button class="ax-btn-sm" id="ax-sec-fix-limit-btn" title="Raise project-level storage limit (requires SUPABASE_MANAGEMENT_TOKEN)">⬆ Set Storage Limit</button>
          </div>
          <div id="ax-sec-limit-result" style="margin-top:8px;font-size:11px;color:var(--text-dim);display:none;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;background:var(--surface-hi);border-radius:4px;padding:8px;"></div>
        </div>
      </div>
    </div>

    <!-- ══ SETTINGS — dynamic per-channel cards ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-settings">
      <div class="ax-section-title">AURENIX <span>Settings</span></div>
      <div class="ax-settings-grid" id="ax-settings-ch-grid">
        <div style="color:var(--text-dim);font-size:12px;">Loading channel settings…</div>
      </div>
    </div>

  </main>
</div>

<!-- PLAY NOW MODAL -->
<div class="ax-modal-overlay" id="ax-playnow-modal" style="display:none;">
  <div class="ax-modal-box ax-playnow-box">
    <div class="ax-modal-title">🔴 PLAY NOW</div>
    <div id="ax-playnow-channel-label" style="font-size:12px;color:var(--text-dim);margin-bottom:12px;"></div>
    <div style="font-size:11px;color:var(--text-dim);font-weight:700;letter-spacing:1px;margin-bottom:8px;">CURRENTLY PLAYING</div>
    <div id="ax-playnow-current" style="font-size:13px;color:var(--text);padding:10px;background:var(--surface-hi);border-radius:6px;margin-bottom:14px;">—</div>
    <div style="font-size:11px;color:var(--text-dim);font-weight:700;letter-spacing:1px;margin-bottom:8px;">SELECT NEW MEDIA</div>
    <input class="ax-lib-search" id="ax-playnow-search" type="search" placeholder="Search…" style="margin-bottom:8px;">
    <div id="ax-playnow-list" style="max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;"></div>
    <div class="ax-modal-actions" style="margin-top:16px;">
      <button class="ax-btn-ghost" id="ax-playnow-cancel">CANCEL</button>
      <button class="ax-btn-primary" id="ax-playnow-confirm" disabled>🔴 INTERRUPT & PLAY NOW</button>
    </div>
  </div>
</div>

<!-- BROADCAST MODAL -->
<div class="ax-modal-overlay" id="ax-broadcast-modal" style="display:none;">
  <div class="ax-modal-box">
    <div class="ax-modal-title">📡 ADD TO BROADCAST</div>
    <div id="ax-bcast-media-title" style="font-size:13px;color:var(--text);margin-bottom:14px;"></div>
    <div style="font-size:11px;color:var(--text-dim);font-weight:700;letter-spacing:1px;margin-bottom:8px;">SELECT CHANNEL</div>
    <div class="ax-channel-picker" id="ax-bcast-ch-picker"></div>
    <div style="font-size:11px;color:var(--text-dim);font-weight:700;letter-spacing:1px;margin:14px 0 8px;">ACTION</div>
    <div class="ax-bcast-actions">
      <button class="ax-bcast-action-btn" id="ax-bcast-playnow">🔴 PLAY NOW</button>
      <button class="ax-bcast-action-btn active" id="ax-bcast-addqueue">+ ADD TO QUEUE</button>
      <button class="ax-bcast-action-btn" id="ax-bcast-schedule">📅 SCHEDULE</button>
    </div>
    <div class="ax-modal-actions" style="margin-top:16px;">
      <button class="ax-btn-ghost" id="ax-bcast-cancel">CANCEL</button>
      <button class="ax-btn-primary" id="ax-bcast-confirm">CONFIRM</button>
    </div>
  </div>
</div>

<!-- CREATE / EDIT CHANNEL MODAL -->
<div class="ax-modal-overlay" id="ax-channel-modal" style="display:none;">
  <div class="ax-modal-box" style="max-width:480px;">
    <div class="ax-modal-title" id="ax-ch-modal-title">➕ CREATE CHANNEL</div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Channel Name *</label>
      <input class="ax-field-input" id="ax-ch-name" placeholder="e.g. AURENIX GAMING" maxlength="40">
    </div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Short Label *</label>
      <input class="ax-field-input" id="ax-ch-label" placeholder="e.g. GAMING" maxlength="16">
    </div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Description</label>
      <input class="ax-field-input" id="ax-ch-desc" placeholder="What this channel broadcasts">
    </div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Channel Type</label>
      <select class="ax-field-input" id="ax-ch-type">
        <option value="mixed">MIXED</option>
        <option value="music">MUSIC</option>
        <option value="video">VIDEO</option>
        <option value="audio">AUDIO</option>
        <option value="custom">CUSTOM</option>
      </select>
    </div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Programming Mode</label>
      <select class="ax-field-input" id="ax-ch-mode">
        <option value="ordered">ORDERED</option>
        <option value="shuffle">SHUFFLE</option>
        <option value="random">RANDOM</option>
        <option value="scheduled">SCHEDULED</option>
      </select>
    </div>
    <div class="ax-field-group" style="margin-bottom:10px;">
      <label class="ax-field-label">Accent Color</label>
      <input type="color" class="ax-field-input" id="ax-ch-color" value="#1e50ff" style="height:38px;padding:4px 8px;cursor:pointer;">
    </div>
    <label class="ax-loop-toggle" style="margin-bottom:10px;">
      <input type="checkbox" id="ax-ch-enabled" checked>
      Channel enabled (visible to users)
    </label>
    <div class="ax-auth-err" id="ax-ch-err" style="margin-bottom:8px;"></div>
    <div class="ax-modal-actions">
      <button class="ax-btn-ghost" id="ax-ch-modal-cancel">CANCEL</button>
      <button class="ax-btn-primary" id="ax-ch-modal-save">CREATE CHANNEL</button>
    </div>
  </div>
</div>

<!-- META FORM MODAL -->
<div class="ax-modal-overlay" id="ax-meta-modal" style="display:none;">
  <div class="ax-modal-box ax-meta-box">
    <div class="ax-modal-title">✏️ EDIT METADATA</div>
    <div id="ax-meta-content"></div>
    <div class="ax-modal-actions" style="margin-top:16px;">
      <button class="ax-btn-ghost" id="ax-meta-cancel">CANCEL</button>
      <button class="ax-btn-primary" id="ax-meta-save">SAVE</button>
    </div>
  </div>
</div>
  `;
}

/* ═══════════════════════════════════════
   SUBSCRIPTIONS
═══════════════════════════════════════ */

/* ═══════════════════════════════════════
   AURENIX ONE — FOUNDER STUDIO PANE
═══════════════════════════════════════ */
let _oneTickTimer    = null;
let _oneCurrentFreq  = 'normal';

function _bindOnePane() {
  // Start Channel
  document.getElementById('ax-one-start-btn')?.addEventListener('click', async () => {
    const approvedLib = _mediaLib.filter(m => m.status === 'approved');
    if (!approvedLib.length) { _toast('No approved media — approve content first.', 'err'); return; }
    try {
      await startOneEngine(_mediaLib);
      _oneEngineRunning = true;
      _updateOneBadge(true);
      _renderOneStatus(true, false);
      _startOneTick();
      _toast('AURENIX ONE channel started.');
    } catch (e) { _toast('Start failed: ' + e.message, 'err'); }
  });

  // Stop Channel
  document.getElementById('ax-one-stop-btn')?.addEventListener('click', async () => {
    if (!confirm('Stop AURENIX ONE? The channel will go dark for all viewers.')) return;
    try {
      await stopOneEngine();
      _oneEngineRunning = false;
      _stopOneTick();
      _updateOneBadge(false);
      _renderOneStatus(false, false);
      _toast('AURENIX ONE stopped.');
    } catch (e) { _toast('Stop failed: ' + e.message, 'err'); }
  });

  // Pause
  document.getElementById('ax-one-pause-btn')?.addEventListener('click', async () => {
    try {
      await pauseOneEngine();
      _renderOneStatus(true, true);
      _toast('AURENIX ONE paused.');
    } catch (e) { _toast('Pause failed: ' + e.message, 'err'); }
  });

  // Resume
  document.getElementById('ax-one-resume-btn')?.addEventListener('click', async () => {
    try {
      await resumeOneEngine();
      _renderOneStatus(true, false);
      _toast('AURENIX ONE resumed.');
    } catch (e) { _toast('Resume failed: ' + e.message, 'err'); }
  });

  // Skip
  document.getElementById('ax-one-skip-btn')?.addEventListener('click', async () => {
    try {
      await oneSkipProgram();
      _toast('Skipped — loading next program…');
    } catch (e) { _toast('Skip failed: ' + e.message, 'err'); }
  });

  // Force commercial break
  document.getElementById('ax-one-force-comm-btn')?.addEventListener('click', async () => {
    try {
      const ok = await forceCommercialBreak();
      _toast(ok ? '📢 Commercial break started.' : 'No commercials available yet.', ok ? '' : 'err');
    } catch (e) { _toast('Force break failed: ' + e.message, 'err'); }
  });

  // Refresh broadcast history
  document.getElementById('ax-one-refresh-hist')?.addEventListener('click', _renderOneHistory);

  // Commercial frequency buttons
  document.querySelectorAll('.ax-one-freq-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.ax-one-freq-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _oneCurrentFreq = btn.dataset.freq;
      const freq = COMMERCIAL_FREQ[_oneCurrentFreq] || COMMERCIAL_FREQ.normal;
      // Update input fields
      const minProg = document.getElementById('ax-one-min-prog');
      const maxProg = document.getElementById('ax-one-max-prog');
      const minSpot = document.getElementById('ax-one-min-spots');
      const maxSpot = document.getElementById('ax-one-max-spots');
      if (minProg) minProg.value = freq.minPrograms === 999 ? 0 : freq.minPrograms;
      if (maxProg) maxProg.value = freq.maxPrograms === 999 ? 0 : freq.maxPrograms;
      if (minSpot) minSpot.value = freq.minSpot;
      if (maxSpot) maxSpot.value = freq.maxSpot;
    });
  });

  // Save settings
  document.getElementById('ax-one-save-settings')?.addEventListener('click', async () => {
    const updates = {
      commercial_freq:       _oneCurrentFreq,
      min_programs:          parseInt(document.getElementById('ax-one-min-prog')?.value) || 2,
      max_programs:          parseInt(document.getElementById('ax-one-max-prog')?.value) || 4,
      min_spots:             parseInt(document.getElementById('ax-one-min-spots')?.value) || 1,
      max_spots:             parseInt(document.getElementById('ax-one-max-spots')?.value) || 2,
      avoid_repeat_window:   parseInt(document.getElementById('ax-one-repeat-window')?.value) || 10,
    };
    try {
      await saveOneConfig(updates);
      _toast('AURENIX ONE settings saved.');
    } catch (e) { _toast('Save failed: ' + e.message, 'err'); }
  });

  // Subscribe to A1 state for the on-air panel
  _subscribeOneStateForPanel();

  // Initial renders
  _renderOnePoolInfo();
  _renderOneHistory();
}

/** Subscribe to network_state/A1 to update the on-air panel in real time. */
function _subscribeOneStateForPanel() {
  if (_oneStateUnsub) return;
  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);
  _oneStateUnsub = onSnapshot(stateRef, snap => {
    if (!snap.exists()) return;
    const st = snap.data();
    const cur = st?.current_item;
    const isComm = !!(st?.is_commercial);

    const titleEl   = document.getElementById('ax-one-now-title');
    const metaEl    = document.getElementById('ax-one-now-meta');
    const commEl    = document.getElementById('ax-one-comm-indicator');
    const nextTitle = document.getElementById('ax-one-next-title');
    const nextMeta  = document.getElementById('ax-one-next-meta');

    if (titleEl) titleEl.textContent = cur ? cur.title : '—';
    if (metaEl)  metaEl.textContent  = cur ? (cur.artist || cur.type || 'media') : 'No broadcast active';
    if (commEl)  commEl.style.display = isComm ? '' : 'none';

    // "Up next" — if commercial_queue has items show first; else nothing known yet
    const commQ = st?.commercial_queue || [];
    if (nextTitle) {
      if (isComm && commQ.length > 0) {
        nextTitle.textContent = commQ[0].title;
        if (nextMeta) nextMeta.textContent = 'Commercial';
      } else if (isComm) {
        nextTitle.textContent = 'Program (auto-selected)';
        if (nextMeta) nextMeta.textContent = 'After commercial break';
      } else {
        nextTitle.textContent = 'Auto-selected next';
        if (nextMeta) nextMeta.textContent = 'Random from approved pool';
      }
    }

    // Status bar
    const isRunning = !!(cur);
    _renderOneStatus(isRunning, false);
    _updateOneBadge(isRunning);
  });
}

function _renderOneStatus(running, paused) {
  const dotEl    = document.getElementById('ax-one-live-dot');
  const textEl   = document.getElementById('ax-one-status-text');
  const stateEl  = document.getElementById('ax-one-engine-state');
  if (dotEl)  dotEl.className  = `ax-one-live-dot ${running && !paused ? 'live' : ''}`;
  if (textEl) textEl.textContent = paused ? 'PAUSED' : (running ? 'BROADCASTING' : 'CHANNEL OFFLINE');
  if (stateEl) stateEl.textContent = _oneEngineRunning
    ? (paused ? 'Engine active — paused' : 'Engine running — 24/7 mode')
    : 'Engine not started — click START CHANNEL';
}

function _updateOneBadge(live) {
  const badge = document.getElementById('ax-one-engine-badge');
  if (badge) badge.style.display = live ? '' : 'none';
}

function _startOneTick() {
  if (_oneTickTimer) return;
  _oneTickTimer = setInterval(_oneTickFn, 800);
}

function _stopOneTick() {
  if (_oneTickTimer) { clearInterval(_oneTickTimer); _oneTickTimer = null; }
}

function _oneTickFn() {
  const st  = _channelStates[ONE_CHANNEL_ID];
  const cur = st?.current_item;
  if (!cur) return;

  const startedAt = st.started_at?.toMillis?.() || Date.now();
  const elapsed   = (Date.now() - startedAt) / 1000;
  const dur       = cur.duration_sec || 0;

  const fill    = document.getElementById('ax-one-progress-fill');
  const elapsed_ = document.getElementById('ax-one-elapsed');
  const remain  = document.getElementById('ax-one-remain');

  if (dur > 0) {
    const pct = Math.min(100, (elapsed / dur) * 100);
    if (fill)    fill.style.width    = pct + '%';
    if (elapsed_) elapsed_.textContent = _fmtTime(elapsed);
    if (remain)  remain.textContent  = '-' + _fmtTime(Math.max(0, dur - elapsed));
  } else {
    if (fill)    fill.style.width    = '0%';
    if (elapsed_) elapsed_.textContent = _fmtTime(elapsed);
    if (remain)  remain.textContent  = '—';
  }
}

async function _renderOneHistory() {
  const listEl = document.getElementById('ax-one-history-list');
  if (!listEl) return;
  try {
    const history = await getOneHistory();
    if (!history.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">No broadcast history yet.</div>';
      return;
    }
    // Look up titles from the library
    const rows = history.slice().reverse().map((id, i) => {
      const item = _mediaLib.find(m => m.id === id);
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:10px;color:var(--text-muted);min-width:22px;text-align:right;">${history.length - i}</span>
          <span style="font-size:13px;">${_typeIcon(item?.type)}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${_esc(item?.title || id)}
            </div>
            <div style="font-size:10px;color:var(--text-dim);">${_esc(item?.type || '—')}</div>
          </div>
        </div>`;
    });
    listEl.innerHTML = rows.join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:12px;">Could not load history: ${_esc(e.message)}</div>`;
  }
}

function _renderOnePoolInfo() {
  const el = document.getElementById('ax-one-pool-info');
  if (!el) return;
  const approved = _mediaLib.filter(m => m.status === 'approved');
  const PROG_TYPES = ['video','music_video','show','broadcast_clip','audio_program','podcast','station_id','archive','trailer','audio','music'];
  const COMM_TYPES = ['commercial','promo','trailer','station_id'];
  const programs    = approved.filter(m => PROG_TYPES.includes(m.type));
  const commercials = approved.filter(m => COMM_TYPES.includes(m.type));
  el.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px;">
      <div><span style="font-size:18px;font-weight:900;color:var(--blue-bright);">${programs.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Programs eligible</span></div>
      <div><span style="font-size:18px;font-weight:900;color:var(--gold);">${commercials.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Commercials available</span></div>
      <div><span style="font-size:18px;font-weight:900;color:var(--green);">${approved.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Total approved</span></div>
    </div>
    ${programs.length === 0 ? '<div style="color:var(--orange,#f0a500);font-size:12px;">⚠ No eligible programs — approve media in Pending Approval first.</div>' : ''}
    ${commercials.length === 0 ? '<div style="color:var(--text-dim);font-size:11px;margin-top:4px;">No commercials/promos — commercial breaks will be skipped.</div>' : ''}`;
}


function _subscribeChannelState(channelId) {
  if (_stateUnsubs[channelId]) return;
  _stateUnsubs[channelId] = onSnapshot(doc(db, 'network_state', channelId), snap => {
    _channelStates[channelId] = snap.exists() ? snap.data() : null;
    _renderChannelCard(channelId);
    _renderLiveCard(channelId);
    if (channelId === _schedChannelId) _renderOnAir();
    _renderDashboard();
    _checkQueueWarnings();
  });
}

function _subscribeMedia() {
  if (_libUnsub) return;
  const q = query(collection(db, 'network_media'), orderBy('uploaded_at', 'desc'));
  _libUnsub = onSnapshot(q, snap => {
    _mediaLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderLibrary();
    _renderMusicLib();
    _renderVideoLib();
    _renderMiniLib();
    _renderSchedItems();
    _renderStats();
    _renderDashboardRecent();
    _renderApproval();     // keep approval pane in sync
    _updateApprovalBadge();
    // Keep AURENIX ONE engine pool in sync
    if (_oneEngineRunning) oneUpdateMedia(_mediaLib);
    _renderOnePoolInfo();
  });
}

/* ─── DB CHANNELS ─── */

let _submissionsLib = [];
let _subsUnsub      = null;
let _subFilter      = 'all';

/**
 * Subscribe to network_channels (ordered) and call onReady once on first snapshot.
 * Subsequent snapshots rebuild all dynamic panes automatically.
 */
function _subscribeDBChannels(onReady) {
  if (_dbChUnsub) _dbChUnsub();
  let firstCall = true;
  const q = query(collection(db, 'network_channels'), orderBy('sort_order', 'asc'));
  _dbChUnsub = onSnapshot(q, snap => {
    _dbChannels = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.enabled !== false);
    if (firstCall) {
      firstCall = false;
      onReady();
    } else {
      // Channels changed — subscribe to any new channels and rebuild dynamic panes
      _dbChannels.forEach(ch => _subscribeChannelState(ch.id));
      _rebuildDynamicPanes();
      _renderDashboard();
      _renderChannels();
      _bindLiveControl();
      _renderStats();
    }
  }, err => {
    console.warn('[AURENIX] network_channels snapshot error:', err);
    if (firstCall) { firstCall = false; onReady(); }
  });
}

/**
 * Rebuild all pane areas that depend on the channel list
 * (scheduler pickers, settings cards, broadcast modal channel picker).
 */
function _rebuildDynamicPanes() {
  // Schedule channel picker
  const picker = document.getElementById('ax-sched-ch-picker');
  if (picker) {
    const chs = _channels();
    if (!chs.length) {
      picker.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">No channels yet — create one in Channel Manager.</div>';
    } else {
      picker.innerHTML = chs.map((ch, i) => {
        const active = ch.id === _schedChannelId || (i === 0 && !chs.find(c => c.id === _schedChannelId));
        if (active && i === 0 && !chs.find(c => c.id === _schedChannelId)) _schedChannelId = ch.id;
        return `<button class="ax-ch-pick-btn ${active ? 'active' : ''}" data-chid="${ch.id}"
                        style="${active ? `border-color:${ch.color || '#1e50ff'};color:${ch.color || '#1e50ff'};` : ''}">
                  ${_esc(ch.label || ch.id)} — ${_esc(ch.name)}
                </button>`;
      }).join('');
      picker.querySelectorAll('.ax-ch-pick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const chid = btn.dataset.chid;
          const ch   = _channels().find(c => c.id === chid);
          picker.querySelectorAll('.ax-ch-pick-btn').forEach(b => {
            b.classList.remove('active');
            b.style.borderColor = '';
            b.style.color       = '';
          });
          btn.classList.add('active');
          btn.style.borderColor = ch?.color || '';
          btn.style.color       = ch?.color || '';
          _schedChannelId = chid;
          const lbl = document.getElementById('ax-sched-ch-label');
          if (lbl) lbl.textContent = `${ch?.name || chid} — Schedule`;
          _renderSchedItems();
          _renderOnAir();
        });
      });
      // Set schedule label
      const first = _channels().find(c => c.id === _schedChannelId) || _channels()[0];
      if (first) {
        const lbl = document.getElementById('ax-sched-ch-label');
        if (lbl) lbl.textContent = `${first.name} — Schedule`;
        _schedChannelId = first.id;
      }
    }
  }

  // Settings grid
  const settingsGrid = document.getElementById('ax-settings-ch-grid');
  if (settingsGrid) {
    settingsGrid.innerHTML = _channels().map(ch => `
      <div class="ax-settings-card">
        <div class="ax-settings-ch-header" style="color:${ch.color || '#1e50ff'}">${_esc(ch.id)} — ${_esc(ch.name)}</div>
        <div class="ax-field-group" style="margin-top:10px;">
          <label class="ax-field-label">Channel Description</label>
          <input class="ax-field-input ax-settings-desc" data-chid="${ch.id}" type="text"
                 value="${_esc(ch.description || '')}" placeholder="${_esc(ch.name)} — 24/7 broadcast">
        </div>
        <label class="ax-loop-toggle" style="margin-top:10px;">
          <input type="checkbox" class="ax-settings-loop" data-chid="${ch.id}" ${ch.loop !== false ? 'checked' : ''}>
          Loop continuously
        </label>
        <button class="ax-btn-sm" style="margin-top:10px;" onclick="window._AXC.saveChannelSettings('${ch.id}')">Save</button>
      </div>`).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet.</div>';
  }

  // Broadcast modal channel picker
  const bcastPicker = document.getElementById('ax-bcast-ch-picker');
  if (bcastPicker) {
    bcastPicker.innerHTML = _channels().map(ch => `
      <button class="ax-ch-pick-btn" data-chid="${ch.id}" style="color:${ch.color || '#1e50ff'}">
        ${_esc(ch.label || ch.id)} — ${_esc(ch.name)}
      </button>`).join('');
    bcastPicker.querySelectorAll('.ax-ch-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        bcastPicker.querySelectorAll('.ax-ch-pick-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _bcastChannelId = btn.dataset.chid;
      });
    });
    if (bcastPicker.firstElementChild) {
      bcastPicker.firstElementChild.classList.add('active');
      _bcastChannelId = bcastPicker.firstElementChild.dataset.chid;
    }
  }
}

/** Seed the 5 initial channels if the network_channels collection is empty. */
async function _seedInitialChannels() {
  try {
    const snap = await getDocs(collection(db, 'network_channels'));
    if (!snap.empty) return; // Already seeded
    const seeds = [
      { id: 'A1', name: 'AURENIX ONE',        label: 'ONE',        color: '#1e50ff', channel_type: 'mixed',  mode: 'shuffle',  sort_order: 1, description: 'Mixed programming — music, videos, clips, and more.',         enabled: true, loop: true },
      { id: 'A2', name: 'AURENIX MUSIC',       label: 'MUSIC',      color: '#b8860b', channel_type: 'music',  mode: 'ordered',  sort_order: 2, description: 'Music-only channel with Founder-curated tracks.',             enabled: true, loop: true },
      { id: 'A3', name: 'AURENIX VIDEO',       label: 'VIDEO',      color: '#8b00ff', channel_type: 'video',  mode: 'ordered',  sort_order: 3, description: 'Video broadcast channel — films, shows, music videos.',        enabled: true, loop: true },
      { id: 'A4', name: 'AURENIX FUNNY',       label: 'FUNNY',      color: '#ff9500', channel_type: 'mixed',  mode: 'shuffle',  sort_order: 4, description: 'Comedy and funny clip channel — approved clips only.',         enabled: true, loop: true },
      { id: 'A5', name: 'AURENIX AFTER DARK',  label: 'AFTER DARK', color: '#9b59b6', channel_type: 'mixed',  mode: 'ordered',  sort_order: 5, description: 'Nighttime independent programming — its own media pool.',      enabled: true, loop: true },
    ];
    for (const seed of seeds) {
      const { id, ...data } = seed;
      await setDoc(doc(db, 'network_channels', id), { ...data, created_at: serverTimestamp() });
    }
    console.log('[AURENIX] Seeded 5 initial channels.');
  } catch (e) {
    console.warn('[AURENIX] Channel seed failed (may already exist or no permission):', e.message);
  }
}

function _subscribeSubmissions() {
  if (_subsUnsub) return;
  const q = query(collection(db, 'media_submissions'), orderBy('submitted_at', 'desc'));
  _subsUnsub = onSnapshot(q, snap => {
    _submissionsLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const pending = _submissionsLib.filter(s => s.status === 'pending').length;
    const badge = document.getElementById('ax-submissions-badge');
    if (badge) {
      badge.style.display = pending > 0 ? '' : 'none';
      badge.textContent   = pending;
    }
    _renderSubmissions();
  }, err => {
    console.warn('[AURENIX] media_submissions snapshot error:', err.message);
  });
}

function _renderSubmissions() {
  const listEl = document.getElementById('ax-submissions-list');
  if (!listEl) return;
  const items = _subFilter === 'all'
    ? _submissionsLib
    : _submissionsLib.filter(s => s.status === _subFilter);

  if (!items.length) {
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:24px;text-align:center;">${_subFilter === 'pending' ? 'No pending submissions.' : 'No submissions yet.'}</div>`;
    return;
  }

  const statusColor = { pending:'#f0a500', approved:'var(--green)', rejected:'var(--red)' };
  listEl.innerHTML = items.map(s => `
    <div class="ax-sub-card" id="ax-sub-${s.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text);">${_esc(s.title || '(untitled)')}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">
            ${_esc(s.artist || '')}${s.artist ? ' · ' : ''}${_esc(s.type || 'media')} · submitted by ${_esc(s.submitted_email || s.submitted_by || '?')}
          </div>
          ${s.url ? `<div style="font-size:11px;color:var(--blue-bright);margin-top:4px;word-break:break-all;"><a href="${_esc(s.url)}" target="_blank" rel="noopener" style="color:var(--blue-bright);">🔗 ${_esc(s.url.slice(0,60))}…</a></div>` : ''}
          ${s.description ? `<div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.5;">${_esc(s.description)}</div>` : ''}
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Rights confirmed: ${s.rights_confirmed ? '✓ YES' : '✗ NO'}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <span style="font-size:11px;font-weight:700;letter-spacing:1px;color:${statusColor[s.status] || 'var(--text-dim)'};">${(s.status || 'pending').toUpperCase()}</span>
          ${s.status === 'pending' ? `
            <button class="ax-btn-sm" style="background:var(--green);color:#000;" onclick="window._AXC.approveSubmission('${s.id}')">✓ APPROVE</button>
            <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.rejectSubmission('${s.id}')">✗ REJECT</button>
          ` : s.status === 'approved' ? `
            <button class="ax-btn-sm" onclick="window._AXC.importSubmission('${s.id}')">📥 Import to Library</button>
          ` : ''}
        </div>
      </div>
    </div>`).join('');
}

function _bindChannelManager() {
  document.getElementById('ax-create-channel-btn')?.addEventListener('click', () => _openChannelModal(null));

  // Sub-filter buttons on Submissions pane
  document.getElementById('ax-sub-filter-bar')?.querySelectorAll('.ax-sub-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-sub-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _subFilter = btn.dataset.status;
      _renderSubmissions();
    });
  });
}

/* ─── CHANNEL MODAL ─── */
let _editChannelId = null;

function _openChannelModal(channelId) {
  _editChannelId = channelId;
  const modal    = document.getElementById('ax-channel-modal');
  const titleEl  = document.getElementById('ax-ch-modal-title');
  const saveBtn  = document.getElementById('ax-ch-modal-save');
  const errEl    = document.getElementById('ax-ch-err');
  if (!modal) return;

  if (channelId) {
    const ch = _channels().find(c => c.id === channelId);
    if (!ch) return;
    if (titleEl) titleEl.textContent = '✏️ EDIT CHANNEL';
    if (saveBtn) saveBtn.textContent = 'SAVE CHANGES';
    document.getElementById('ax-ch-name').value    = ch.name    || '';
    document.getElementById('ax-ch-label').value   = ch.label   || '';
    document.getElementById('ax-ch-desc').value    = ch.description || '';
    document.getElementById('ax-ch-type').value    = ch.channel_type || 'mixed';
    document.getElementById('ax-ch-mode').value    = ch.mode    || 'ordered';
    document.getElementById('ax-ch-color').value   = ch.color   || '#1e50ff';
    document.getElementById('ax-ch-enabled').checked = ch.enabled !== false;
  } else {
    if (titleEl) titleEl.textContent = '➕ CREATE CHANNEL';
    if (saveBtn) saveBtn.textContent = 'CREATE CHANNEL';
    document.getElementById('ax-ch-name').value    = '';
    document.getElementById('ax-ch-label').value   = '';
    document.getElementById('ax-ch-desc').value    = '';
    document.getElementById('ax-ch-type').value    = 'mixed';
    document.getElementById('ax-ch-mode').value    = 'ordered';
    document.getElementById('ax-ch-color').value   = '#1e50ff';
    document.getElementById('ax-ch-enabled').checked = true;
  }
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }
  modal.style.display = 'flex';

  document.getElementById('ax-ch-modal-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; }, { once: true });
  document.getElementById('ax-ch-modal-save')?.addEventListener('click', async () => {
    const name    = document.getElementById('ax-ch-name').value.trim();
    const label   = document.getElementById('ax-ch-label').value.trim();
    if (!name)  { errEl.textContent = 'Channel Name is required.'; errEl.classList.add('visible'); return; }
    if (!label) { errEl.textContent = 'Short Label is required.';  errEl.classList.add('visible'); return; }

    const data = {
      name,
      label:        label.toUpperCase(),
      description:  document.getElementById('ax-ch-desc').value.trim(),
      channel_type: document.getElementById('ax-ch-type').value,
      mode:         document.getElementById('ax-ch-mode').value,
      color:        document.getElementById('ax-ch-color').value,
      enabled:      document.getElementById('ax-ch-enabled').checked,
      loop:         true,
      updated_at:   serverTimestamp(),
    };
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      if (_editChannelId) {
        await setDoc(doc(db, 'network_channels', _editChannelId), data, { merge: true });
        _toast(`Channel updated: ${name}`);
      } else {
        // Auto-generate an ID like "A6", "A7", etc.
        const existingIds = _channels().map(c => c.id);
        let newIdx = existingIds.length + 1;
        let newId  = `A${newIdx}`;
        while (existingIds.includes(newId)) { newIdx++; newId = `A${newIdx}`; }
        data.sort_order = newIdx;
        data.created_at = serverTimestamp();
        await setDoc(doc(db, 'network_channels', newId), data);
        _toast(`Channel created: ${name}`);
      }
      modal.style.display = 'none';
    } catch (e) {
      if (errEl) { errEl.textContent = 'Save failed: ' + e.message; errEl.classList.add('visible'); }
      _toast('Channel save failed: ' + e.message, 'err');
    }
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = _editChannelId ? 'SAVE CHANGES' : 'CREATE CHANNEL'; }
  }, { once: true });
}

/* ═══════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════ */
function _renderDashboard() {
  const chs = _channels();
  // Channel status badges
  const dashCh = document.getElementById('ax-dash-channels');
  if (dashCh) {
    dashCh.innerHTML = chs.map(ch => {
      const st  = _channelStates[ch.id];
      const live = !!(st?.current_item);
      return `
        <div class="ax-dash-ch-badge" style="border-color:${ch.color || '#1e50ff'}44;">
          <div class="ax-dash-ch-id" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
          <div class="ax-dash-ch-name">${_esc(ch.name)}</div>
          <div class="ax-dash-ch-state ${live ? 'on-air' : ''}">
            ${live ? '🔴 ON AIR' : '⚫ STANDBY'}
          </div>
        </div>`;
    }).join('');
  }
  // Now playing rows (fully dynamic)
  const npEl = document.getElementById('ax-dash-nowplaying');
  if (npEl) {
    npEl.innerHTML = chs.map(ch => {
      const st  = _channelStates[ch.id];
      const cur = st?.current_item;
      return `
        <div class="ax-dash-np-row" id="ax-dash-np-${ch.id}">
          <div class="ax-dash-np-badge" style="background:${ch.color || '#1e50ff'}22;color:${ch.color || '#1e50ff'};border-color:${ch.color || '#1e50ff'}44;">${_esc(ch.label || ch.id)}</div>
          <div class="ax-dash-np-info">
            <div class="ax-dash-np-title" id="ax-dash-title-${ch.id}">${cur ? _esc(cur.title) : 'Standby…'}</div>
            <div class="ax-dash-np-meta"  id="ax-dash-meta-${ch.id}">${cur ? _esc(cur.artist || cur.type || 'media') : '—'}</div>
          </div>
        </div>`;
    }).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet.</div>';
  }
  // Queue bars (fully dynamic)
  const qEl = document.getElementById('ax-dash-queues');
  if (qEl) {
    qEl.innerHTML = chs.map(ch => {
      const st    = _channelStates[ch.id];
      const queue = st?.queue || [];
      // AURENIX ONE uses a live-TV engine with no fixed queue
      if (ch.id === ONE_CHANNEL_ID) {
        const isLive = !!(st?.current_item);
        return `
          <div class="ax-dash-q-row">
            <div class="ax-dash-q-label" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
            <div class="ax-dash-q-bar-wrap">
              <div class="ax-dash-q-bar" style="width:${isLive ? 100 : 0}%;background:${isLive ? 'var(--red)' : ch.color || '#1e50ff'}"></div>
            </div>
            <div class="ax-dash-q-count" style="color:${isLive ? 'var(--red)' : 'var(--text-dim)'};">${isLive ? '🔴 LIVE TV' : '⚫ ENGINE OFF'}</div>
          </div>`;
      }
      const max   = 20;
      const pct   = Math.min(100, (queue.length / max) * 100);
      return `
        <div class="ax-dash-q-row">
          <div class="ax-dash-q-label" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
          <div class="ax-dash-q-bar-wrap">
            <div class="ax-dash-q-bar" id="ax-qbar-${ch.id}" style="width:${pct}%;background:${ch.color || '#1e50ff'}"></div>
          </div>
          <div class="ax-dash-q-count" id="ax-qcount-${ch.id}">${queue.length + (queue.length === 1 ? ' item' : ' items')}</div>
        </div>`;
    }).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet.</div>';
  }
}

function _renderDashboardRecent() {
  const el = document.getElementById('ax-dash-recent');
  if (!el) return;
  const recent = _mediaLib.slice(0, 8);
  if (!recent.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">No uploads yet.</div>'; return; }
  el.innerHTML = recent.map(m => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:13px;">${_typeIcon(m.type)}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(m.title)}</div>
        <div style="font-size:10px;color:var(--text-dim);">${m.type || 'media'} · ${_relDate(m.uploaded_at)}</div>
      </div>
    </div>`).join('');
}

function _checkQueueWarnings() {
  const el = document.getElementById('ax-dash-warnings');
  if (!el) return;
  const chs = _channels();
  const warnings = [];
  chs.forEach(ch => {
    // AURENIX ONE uses a live-TV engine — it has no queue; skip queue warnings.
    if (ch.id === ONE_CHANNEL_ID) return;
    const st    = _channelStates[ch.id];
    const queue = st?.queue || [];
    const cur   = st?.current_item;
    if (!cur && !queue.length) {
      warnings.push({ ch, level: 'empty', msg: `${ch.name} has no content scheduled.` });
    } else if (queue.length <= 2) {
      warnings.push({ ch, level: 'low', msg: `${ch.name} queue low — only ${queue.length} items remaining.` });
    }
  });
  if (!warnings.length) {
    el.innerHTML = chs.length
      ? '<div style="color:var(--green);font-size:12px;">✓ All channels have content scheduled.</div>'
      : '<div style="color:var(--text-dim);font-size:12px;">No channels yet — create one in Channel Manager.</div>';
    return;
  }
  el.innerHTML = warnings.map(w => `
    <div class="ax-warning-row ${w.level === 'empty' ? 'ax-warn-empty' : 'ax-warn-low'}">
      <div>${w.level === 'empty' ? '🔴' : '⚠️'} <strong>${_esc(w.ch.label || w.ch.id)}</strong> — ${_esc(w.msg)}</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${w.ch.id}')">+ ADD MEDIA</button>
        <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${w.ch.id}')">📅 SCHEDULE</button>
      </div>
    </div>`).join('');
}

/* ═══════════════════════════════════════
   NETWORK CONTROL PANE
═══════════════════════════════════════ */
function _renderChannelCard(_unused) {
  const chs = _channels();
  const container = document.getElementById('ax-ov-channels');
  if (!container) return;
  container.innerHTML = chs.map(c => {
    const s   = _channelStates[c.id];
    const cur = s?.current_item;
    const q   = s?.queue || [];
    return `
      <div class="ax-channel-card">
        <div class="ax-channel-card-header">
          <div class="ax-channel-card-id" style="color:${c.color || '#1e50ff'}">${_esc(c.label || c.id)}</div>
          <div>
            <div class="ax-channel-card-name">${_esc(c.name)}</div>
            <div class="ax-channel-card-status">${cur ? `<span style="color:var(--red)">● LIVE</span>` : `<span style="color:var(--text-muted)">● STANDBY</span>`}</div>
          </div>
        </div>
        <div class="ax-channel-card-np">${cur ? _esc(cur.title) : 'No scheduled content'}</div>
        <div style="font-size:10px;color:var(--text-dim);margin-top:4px;">${q.length} items in queue</div>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${c.id}')">📅 Manage</button>
          <button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openPlayNow('${c.id}')">🔴 Play Now</button>
          ${cur ? `<button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.stopChannel('${c.id}')">■ Stop</button>` : ''}
        </div>
      </div>`;
  }).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet.</div>';
  const liveCount = chs.filter(c => _channelStates[c.id]?.current_item).length;
  const lc = document.getElementById('ax-ov-live-count');
  if (lc) lc.textContent = liveCount;
}

function _renderChannels() {
  _renderChannelCard(null);
  // channel manager grid
  const mgr = document.getElementById('ax-ch-manager-grid');
  if (mgr) {
    const chs = _channels();
    mgr.innerHTML = chs.map(c => {
      const s   = _channelStates[c.id];
      const cur = s?.current_item;
      const q   = s?.queue || [];
      const nextItem = cur && q.length ? q[q.findIndex(x => x.id === cur.id) + 1] || null : q[0] || null;
      return `
        <div class="ax-channel-card" style="border-color:${c.color || '#1e50ff'}33;">
          <div class="ax-channel-card-header">
            <div class="ax-channel-card-id" style="color:${c.color || '#1e50ff'};font-size:20px;">${_esc(c.label || c.id)}</div>
            <div>
              <div class="ax-channel-card-name" style="font-size:14px;">${_esc(c.name)}</div>
              <div class="ax-channel-card-status">${cur ? `<span style="color:var(--red)">● ON AIR</span>` : `<span style="color:var(--text-muted)">● OFFLINE</span>`}</div>
            </div>
          </div>
          <div style="margin:8px 0;font-size:11px;color:var(--text-dim);">${_esc(c.description || '')} · ${_esc(c.channel_type || '')} · ${_esc(c.mode || '')}</div>
          <div style="margin:8px 0;font-size:11px;font-weight:700;letter-spacing:1px;color:var(--text-dim);">CURRENT PROGRAM</div>
          <div class="ax-channel-card-np">${cur ? _esc(cur.title) : '—'}</div>
          <div style="margin:8px 0;font-size:11px;font-weight:700;letter-spacing:1px;color:var(--text-dim);">UP NEXT</div>
          <div class="ax-channel-card-np" style="color:var(--text-dim)">${nextItem ? _esc(nextItem.title) : '—'}</div>
          <div style="margin:8px 0;font-size:11px;color:var(--text-dim);">${q.length} items · ${s?.loop !== false ? 'Looping' : 'Linear'}</div>
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${c.id}')">📅 Schedule</button>
            <button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openPlayNow('${c.id}')">🔴 Play Now</button>
            <button class="ax-btn-sm" onclick="window._AXC.skipChannel('${c.id}')">⏭ Skip</button>
            <button class="ax-btn-sm" onclick="window._AXC.restartChannel('${c.id}')">🔄 Restart</button>
            <button class="ax-btn-sm" onclick="window._AXC.editChannel('${c.id}')">✏️ Edit</button>
            <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.deleteChannel('${c.id}')">🗑 Delete</button>
            <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.stopChannel('${c.id}')">■ Stop</button>
          </div>
        </div>`;
    }).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet — click CREATE CHANNEL above.</div>';
  }
}

/* ═══════════════════════════════════════
   LIVE CONTROL PANE
═══════════════════════════════════════ */
function _renderLiveCard(channelId) {
  const ch  = _channels().find(c => c.id === channelId);
  const st  = _channelStates[channelId];
  const cur = st?.current_item;
  const q   = st?.queue || [];

  const statusEl = document.getElementById(`ax-live-status-${channelId}`);
  const titleEl  = document.getElementById(`ax-live-title-${channelId}`);
  const metaEl   = document.getElementById(`ax-live-meta-${channelId}`);
  const nextEl   = document.getElementById(`ax-live-next-${channelId}`);
  const queueEl  = document.getElementById(`ax-live-queue-${channelId}`);

  if (statusEl) {
    statusEl.textContent = cur ? '● ON AIR' : '● STANDBY';
    statusEl.style.color = cur ? 'var(--red)' : 'var(--text-muted)';
  }
  if (titleEl) titleEl.textContent = cur ? cur.title : '—';
  if (metaEl)  metaEl.textContent  = cur ? (cur.artist || cur.type || 'media') : 'No content broadcasting';

  const curIdx  = cur ? q.findIndex(x => x.id === cur.id) : -1;
  const nextItem = q[curIdx + 1] || null;
  if (nextEl) nextEl.textContent = nextItem ? nextItem.title : '—';

  if (queueEl) {
    const upcoming = q.slice(curIdx + 1, curIdx + 4);
    queueEl.innerHTML = upcoming.length ? `
      <div class="ax-live-queue-label">QUEUE</div>
      ${upcoming.map((item, i) => `
        <div class="ax-live-q-row">
          <span class="ax-live-q-num">${i + 1}</span>
          <span class="ax-live-q-title">${_esc(item.title)}</span>
          <span class="ax-live-q-dur">${_fmtTime(item.duration_sec)}</span>
        </div>`).join('')}` : '';
  }
}

function _bindLiveControl() {
  const chs = _channels();
  const grid = document.getElementById('ax-live-grid');
  if (!grid) return;
  // Inject live channel cards dynamically
  grid.innerHTML = chs.map(ch => `
    <div class="ax-live-channel-card" id="ax-live-card-${ch.id}">
      <div class="ax-live-ch-header" style="border-color:${ch.color || '#1e50ff'}44;">
        <div class="ax-live-ch-id" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
        <div class="ax-live-ch-name">${_esc(ch.name)}</div>
        <div class="ax-live-ch-status" id="ax-live-status-${ch.id}">● STANDBY</div>
      </div>
      <div class="ax-live-np">
        <div class="ax-live-np-label">CURRENT PROGRAM</div>
        <div class="ax-live-np-title" id="ax-live-title-${ch.id}">—</div>
        <div class="ax-live-np-meta" id="ax-live-meta-${ch.id}">No content scheduled</div>
      </div>
      <div class="ax-live-upnext">
        <div class="ax-live-np-label">UP NEXT</div>
        <div class="ax-live-next-title" id="ax-live-next-${ch.id}">—</div>
      </div>
      <div class="ax-live-controls">
        <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${ch.id}')">📅 Schedule</button>
        <button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openPlayNow('${ch.id}')">🔴 PLAY NOW</button>
        <button class="ax-btn-sm" onclick="window._AXC.skipChannel('${ch.id}')">⏭ Skip</button>
        <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.stopChannel('${ch.id}')">■ Stop</button>
      </div>
      <div class="ax-live-queue-preview" id="ax-live-queue-${ch.id}"></div>
    </div>`).join('') || '<div style="color:var(--text-dim);font-size:12px;padding:24px;">No channels yet.</div>';
  // Now update state for each card
  chs.forEach(ch => _renderLiveCard(ch.id));
}

/* ═══════════════════════════════════════
   UPLOAD PANE
═══════════════════════════════════════ */
function _bindUploadPane() {
  const zone    = document.getElementById('ax-upload-zone');
  const fileInp = document.getElementById('ax-file-input');
  if (!zone || !fileInp) return;

  // Category buttons
  document.querySelectorAll('.ax-upload-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-upload-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _uploadCategory = btn.dataset.cat;
      fileInp.accept  = btn.dataset.accept;
    });
  });

  zone.addEventListener('click', (e) => {
    if (e.target.closest('.ax-upload-cat-btn')) return;
    fileInp.click();
  });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    _handleFiles([...e.dataTransfer.files]);
  });
  fileInp.addEventListener('change', () => {
    _handleFiles([...fileInp.files]);
    fileInp.value = '';
  });
}

async function _handleFiles(files) {
  if (!files.length) return;
  // Accept any audio, video, or image file regardless of visual content.
  // Content classification (people, faces, music videos, slideshows, etc.)
  // is NOT performed here and does NOT block upload.
  const valid = files.filter(f =>
    f.type.startsWith('audio/') ||
    f.type.startsWith('video/') ||
    f.type.startsWith('image/') ||
    !f.type  // unknown MIME — let the Worker decide
  );
  if (!valid.length) { _toast('No supported media files selected.', 'err'); return; }
  // No client-side size limit — the storage provider enforces the real cap.
  // Upload concurrently (max 3 at a time)
  for (let i = 0; i < valid.length; i += 3) {
    await Promise.allSettled(valid.slice(i, i + 3).map(f => _uploadFile(f)));
  }
}

/**
 * Upload a single file using the Supabase signed-URL architecture:
 *
 *   Phase 1 — Worker /authorize (tiny JSON, no file body)
 *     → Firebase token verified server-side
 *     → Founder email confirmed from verified token
 *     → Worker PATCHes bucket file_size_limit to 500 MiB if needed
 *       (fixes "The object exceeded the maximum allowed size" HTTP 400)
 *     → Worker POSTs to /storage/v1/object/upload/sign/<bucket>/<path>
 *       using the service-role key
 *     → Supabase returns { url: "/object/upload/sign/<bucket>/<path>?token=..." }
 *     → Worker prepends supabaseUrl + "/storage/v1" — path is NOT rewritten
 *     → Returns signedUrl + storagePath + publicUrl + bucketLimitBytes
 *
 *   Phase 2 — PUT directly to Supabase signed URL (no Worker in the data path)
 *     → XHR PUT to /storage/v1/object/upload/sign/<bucket>/<path>?token=
 *     → No Authorization header needed — ?token= in URL is the authorisation
 *     → IMPORTANT: must PUT to /object/upload/sign/ NOT /object/sign/
 *       (/object/sign/ is the download path and returns HTTP 400 without Auth)
 *     → File never passes through the Worker → no Cloudflare request-body limit
 *     → Size limit is enforced by the Supabase bucket's file_size_limit (500 MiB)
 *     → Progress: TRANSFER 0–99% → FINALIZING (waiting for server response) → VERIFIED
 *
 *   Phase 3 — Firestore metadata record
 */
async function _uploadFile(file) {
  const listEl  = document.getElementById('ax-upload-list');
  const itemKey = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  const cat     = MEDIA_CATEGORIES.find(c => c.id === _uploadCategory) || MEDIA_CATEGORIES[0];
  let   mediaType = cat.type || (isVideo ? 'video' : isImage ? 'thumbnail' : 'audio');

  // ── UI row ─────────────────────────────────────────────────────────────
  if (listEl) {
    const row = document.createElement('div');
    row.className = 'ax-upload-item';
    row.id = itemKey;
    row.innerHTML = `
      <div class="ax-upload-item-info">
        <span class="ax-upload-name">${_esc(file.name)}</span>
        <span class="ax-upload-type-badge">${mediaType}</span>
        <span class="ax-upload-size">${_fmtSize(file.size)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
        <div class="ax-upload-bar-wrap" style="flex:1;">
          <div class="ax-upload-bar" id="bar-${itemKey}" style="width:0%"></div>
        </div>
        <span class="ax-upload-pct" id="pct-${itemKey}" style="white-space:nowrap;min-width:36px;text-align:right;">0%</span>
      </div>
      <span class="ax-upload-bytes" id="bytes-${itemKey}" style="font-size:10px;color:var(--text-dim,#6870a0);white-space:nowrap;"></span>
      <span class="ax-upload-status" id="st-${itemKey}">AUTHENTICATING…</span>
      <span class="ax-upload-dest" id="dest-${itemKey}">${MEDIA_BUCKET}</span>
    `;
    listEl.prepend(row);
  }

  // setProgress: clamp visual bar at 99 % during transfer; only setProgress(total,total)
  // (or the post-verify call) advances to 100 % so the bar never shows complete
  // while Supabase is still processing the object server-side.
  const setProgress = (loaded, total) => {
    // Cap at 99 % while bytes are still transferring so the bar clearly differs
    // from the verified-complete state (100 %).  The storage finalization step
    // advances to 100 % only after server confirmation.
    const rawPct = total > 0 ? Math.round(loaded / total * 100) : 0;
    const pct    = (loaded < total) ? Math.min(99, rawPct) : rawPct;
    const bar    = document.getElementById(`bar-${itemKey}`);
    const pctEl  = document.getElementById(`pct-${itemKey}`);
    const bytes  = document.getElementById(`bytes-${itemKey}`);
    if (bar)   bar.style.width   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (bytes && total > 0) bytes.textContent = `${_fmtSize(loaded)} / ${_fmtSize(total)}`;
  };
  const setStatus = (msg, color = '') => {
    const el = document.getElementById(`st-${itemKey}`);
    if (el) { el.textContent = msg; if (color) el.style.color = color; }
  };
  // storagePath is set once /authorize succeeds; used by intelligent retry.
  let _storagePath   = null;
  let _publicUrl     = null;
  let _retryCallback = null; // set per-failure to the right recovery action

  const addRetry = () => {
    const row = document.getElementById(itemKey);
    if (!row) return;
    row.querySelector('.ax-retry-btn')?.remove();
    const btn = document.createElement('button');
    btn.className   = 'ax-btn-sm ax-btn-danger ax-retry-btn';
    btn.textContent = '↺ Retry';
    btn.style.marginLeft = '8px';
    btn.onclick = () => {
      if (_retryCallback) {
        // Intelligent retry: run only the failed phase
        row.querySelector('.ax-retry-btn')?.remove();
        _retryCallback();
      } else {
        // No smart callback — full re-upload
        row.remove();
        _uploadFile(file);
      }
    };
    row.appendChild(btn);
  };

  // ── Pre-flight: duration ───────────────────────────────────────────────
  let duration_sec = 0;
  if (isAudio || isVideo) {
    try { duration_sec = await _getMediaDuration(file); } catch (_) {}
  }

  // ── Phase 1: Worker /authorize — get signed upload URL ───────────────
  // Sends only a tiny JSON body (fileName, contentType, size).
  // The file is NOT sent here. The Worker verifies the Firebase token and
  // creates a Supabase signed upload URL using the service-role key.
  let authResult;
  try {
    if (!auth.currentUser) throw new Error('FIREBASE SESSION NOT FOUND — please sign in again');
    const idToken = await auth.currentUser.getIdToken(true);

    const res = await fetch(UPLOAD_WORKER_URL + '/authorize', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + idToken,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        fileName:    file.name,
        contentType: file.type || 'application/octet-stream',
        size:        file.size,
      }),
    });

    const data = await res.json();

    if (res.status === 401) throw new Error(data.error || 'FIREBASE TOKEN INVALID — sign in again');
    if (res.status === 403) throw new Error(data.error || 'FOUNDER NOT AUTHORIZED');
    if (res.status === 413) throw new Error(`FILE TOO LARGE FOR STORAGE PROVIDER — ${data.error || ''}`);
    if (res.status === 415) throw new Error(data.error || 'FILE TYPE NOT ALLOWED');
    if (res.status === 503) throw new Error(data.error || 'WORKER CONFIGURATION ERROR');
    if (!res.ok || !data.ok) throw new Error(data.error || `WORKER AUTHORIZATION FAILED — HTTP ${res.status}`);

    authResult = data; // { signedUrl, storagePath, publicUrl }
  } catch (authErr) {
    setStatus('✗ AUTH FAILED — click retry', 'var(--red)');
    addRetry();
    _toast(authErr.message, 'err');
    return;
  }

  // Store auth results so retry can use them
  _storagePath = authResult.storagePath;
  _publicUrl   = authResult.publicUrl;

  // ── Phase 2: PUT directly to Supabase signed URL ──────────────────────
  // The signed URL must be /storage/v1/object/upload/sign/<bucket>/<path>?token=...
  // No Authorization header needed — the token in the URL is the authorisation.

  // Guard: validate the signed URL before sending 93 MB to the wrong endpoint.
  // If the URL is missing /object/upload/sign/ or token=, the PUT would hit an
  // endpoint that requires Authorization and return HTTP 400.
  const _surl = authResult.signedUrl || '';
  if (!_surl.includes('/object/upload/sign/') || !_surl.includes('token=')) {
    const _msg = `SIGNED URL INVALID — Worker returned unexpected URL format: ${_surl.slice(0, 120)}`;
    setStatus('✗ SIGNED URL INVALID — click retry', 'var(--red)');
    addRetry();
    _toast(_msg, 'err');
    console.error('[AURENIX UPLOAD] ' + _msg);
    return;
  }

  setStatus('TRANSFERRING…', '');
  setProgress(0, file.size);

  try {
    await _signedUpload(file, authResult.signedUrl, (loaded, total) => {
      setProgress(loaded, total);
      // When all bytes have been sent to Supabase, show FINALIZING state.
      // The bar stays at 99 % until Supabase confirms the object was accepted.
      if (total > 0 && loaded >= total) {
        setStatus('FINALIZING…', 'var(--blue-bright)');
      }
    });
    // PUT returned 2xx — Supabase accepted the object.
    // Now advance bar to 100 % and show verified.
    setProgress(file.size, file.size);
    setStatus('✓ STORAGE VERIFIED — SAVING…', 'var(--blue-bright)');
  } catch (uploadErr) {
    // The XHR completed (bytes transferred) but Supabase returned a non-2xx status.
    // Determine whether this is a size-limit rejection or another error.

    // Detect the "exceeded the maximum allowed size" error from Supabase HTTP 400.
    // The raw error message from _signedUpload contains the Supabase response body,
    // e.g.: "SUPABASE STORAGE UPLOAD FAILED — HTTP 400: The object exceeded the maximum..."
    const rawErrMsg = uploadErr.message || '';
    const isSizeLimitError =
      rawErrMsg.toLowerCase().includes('exceeded the maximum') ||
      rawErrMsg.toLowerCase().includes('maximum allowed size') ||
      rawErrMsg.toLowerCase().includes('file size limit') ||
      rawErrMsg.toLowerCase().includes('payload too large');

    if (isSizeLimitError) {
      // Surface a clear size-limit error — no need to verify storage.
      //
      // IMPORTANT: Supabase has TWO independent file-size limits:
      //   A. Bucket file_size_limit  — per-bucket cap (Worker ensures this is 500 MB)
      //   B. Project-level STORAGE_FILE_SIZE_LIMIT — global platform cap
      //      (Supabase Dashboard → Storage → Configuration → "Upload File Size Limit")
      //      Default on Free plan: 50 MB (cannot be raised without upgrading to Pro)
      //
      // Effective limit = min(A, B).  Even with bucket = 500 MB, if the project-level
      // cap is 50 MB all files larger than 50 MB will be rejected by Supabase.
      const fileMB   = Math.round(file.size / 1048576);
      const bucketLimitBytes = authResult.bucketLimitBytes || 524_288_000; // 500 MiB
      const bucketMB = Math.round(bucketLimitBytes / 1048576);

      // Determine whether the file genuinely exceeds the configured bucket cap,
      // or whether it is within the bucket cap but rejected by the lower project-level limit.
      const genuinelyTooLarge = file.size > bucketLimitBytes;

      let statusMsg, toastMsg;
      if (genuinelyTooLarge) {
        // File is larger than the configured per-file maximum — correct rejection.
        statusMsg = `✕ VIDEO TOO LARGE — File: ${fileMB} MB | Maximum: ${bucketMB} MB`;
        toastMsg  =
          `VIDEO TOO LARGE — File size: ${fileMB} MB. Maximum allowed: ${bucketMB} MB. ` +
          `Please use a smaller file.`;
      } else {
        // File is WITHIN the bucket cap but Supabase rejected it at the project level.
        // Supabase has TWO independent limits:
        //   A. Bucket file_size_limit (500 MB — this is fine)
        //   B. Project-level "Upload File Size Limit" in the Supabase Dashboard
        //      (Supabase Free plan default: 50 MB — this is what is rejecting the upload)
        // AURENIX imposes NO application-level size or content gate beyond these.
        // Fix: Supabase Dashboard → Storage → Configuration → Upload File Size Limit → 500 MB
        //      (requires Supabase Pro plan; Free plan is hard-capped at 50 MB by Supabase)
        statusMsg = `✕ SUPABASE PROJECT LIMIT TOO LOW — File: ${fileMB} MB exceeds Supabase project cap`;
        toastMsg  =
          `Upload blocked by Supabase (${fileMB} MB file). ` +
          `The AURENIX bucket allows ${bucketMB} MB, but your Supabase project has a separate ` +
          `"Upload File Size Limit" (Dashboard → Storage → Configuration) that is set below ${fileMB} MB. ` +
          `On the Supabase Free plan this project-level cap is 50 MB and cannot be raised. ` +
          `To upload files larger than 50 MB: upgrade to Supabase Pro (allows up to 5 GB). ` +
          `AURENIX itself has no content or size gate — this limit is enforced by Supabase.`;
      }

      console.error('[AURENIX UPLOAD] Size limit rejection:', rawErrMsg,
        '| fileMB:', fileMB, '| bucketMB:', bucketMB,
        '| genuinelyTooLarge:', genuinelyTooLarge);
      setStatus(statusMsg, 'var(--red)');
      setProgress(0, file.size); // reset bar — the object was not stored
      _retryCallback = null;
      addRetry();
      _toast(toastMsg, 'err');
      return;
    }

    // Non-size error: before showing a hard failure, check whether the object
    // actually landed in storage (handles unexpected 2xx/3xx mis-classification).
    console.error('[AURENIX UPLOAD] PUT completed with error:', rawErrMsg,
      '— verifying storage object before reporting failure…');
    setStatus('VERIFYING STORAGE…', 'var(--blue-bright)');

    let objectExists = false;
    try {
      if (!auth.currentUser) throw new Error('no session');
      const verifyToken = await auth.currentUser.getIdToken(true);
      const vRes = await fetch(UPLOAD_WORKER_URL + '/verify', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + verifyToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ storagePath: authResult.storagePath }),
      });
      const vData = await vRes.json();
      console.log('[AURENIX UPLOAD] /verify response:', JSON.stringify(vData));
      objectExists = vRes.ok && vData.exists === true;
    } catch (vErr) {
      console.warn('[AURENIX UPLOAD] /verify request failed:', vErr.message);
    }

    if (objectExists) {
      // Object IS in storage despite the non-2xx response — proceed to save metadata.
      console.log('[AURENIX UPLOAD] Object found in storage — proceeding to save metadata');
      setProgress(file.size, file.size);
      setStatus('✓ STORAGE VERIFIED — SAVING…', 'var(--blue-bright)');
      // fall through to Phase 3 below
    } else {
      // Object genuinely not in storage — show failure with smart retry.
      const errMsg = rawErrMsg || 'SUPABASE STORAGE UPLOAD FAILED';
      setStatus('✗ TRANSFER FAILED — click retry', 'var(--red)');
      setProgress(0, file.size); // reset bar — nothing was stored
      // Smart retry: re-request a fresh signed URL and re-upload (old token is single-use)
      _retryCallback = () => { _uploadFile(file); };
      addRetry();
      _toast(errMsg, 'err');
      return;
    }
  }

  // ── Phase 3: Firestore metadata record ───────────────────────────────
  // Force-refresh token before writing so the Firestore SDK has a valid
  // session even after a long upload.
  try { await auth.currentUser?.getIdToken(true); } catch (_) {}

  const _saveMetadata = async () => {
    setStatus('SAVING MEDIA RECORD…', 'var(--blue-bright)');
    try {
      const docRef = await addDoc(collection(db, 'network_media'), {
        title:        file.name.replace(/\.[^.]+$/, ''),
        artist:       '',
        creator:      _user.email,
        description:  '',
        category:     _uploadCategory,
        type:         mediaType,
        url:          _publicUrl,
        storage_path: _storagePath,
        duration_sec,
        size_bytes:   file.size,
        mime_type:    file.type || 'application/octet-stream',
        // APPROVAL WORKFLOW: all uploads start as pending_approval.
        // Only the Founder can move this to 'approved'.
        // Only approved media can enter a channel or broadcast schedule.
        status:       'pending_approval',
        channel:      '',
        tags:         [],
        year:         new Date().getFullYear(),
        uploaded_by:  _user.uid,
        uploaded_at:  serverTimestamp(),
      });

      setStatus('✓ UPLOADED  ✓ STORAGE VERIFIED  ✓ RECORD SAVED  — PENDING APPROVAL', 'var(--orange,#f0a500)');
      const destEl = document.getElementById(`dest-${itemKey}`);
      if (destEl) destEl.textContent = `${MEDIA_BUCKET} › ${docRef.id}`;
      _toast(`✓ Uploaded — pending Founder approval: ${file.name}`);

      // Always open the metadata modal after upload so the founder can set title,
      // channel, etc. — except for pure thumbnail uploads (type === 'thumbnail'),
      // which are support assets that don't need a media record edited.
      if (mediaType !== 'thumbnail') {
        setTimeout(() => _openMetaModal(docRef.id, file.name.replace(/\.[^.]+$/, '')), 400);
      }

    } catch (metaErr) {
      // Metadata save failed — storage object exists; retry should only redo this step.
      setStatus('✗ MEDIA RECORD FAILED — click retry', 'var(--orange,#f90)');
      _retryCallback = _saveMetadata; // retry only the metadata step
      addRetry();
      _toast('MEDIA DATABASE RECORD FAILED — ' + (metaErr.message || metaErr), 'err');
    }
  };

  await _saveMetadata();
}

/**
 * Upload a file via a Supabase signed upload URL using a single XHR PUT.
 *
 * The signed URL contains a ?token= query parameter — no Authorization header
 * is sent by the browser.  Supabase validates the token server-side.
 *
 * XHR upload.onprogress fires frequently, giving byte-accurate progress.
 * On network error, the caller retries by requesting a fresh signed URL
 * from the Worker (the old signed URL is single-use and cannot be reused).
 *
 * @param {File}     file        — the file to upload
 * @param {string}   signedUrl   — signed upload URL from Worker /authorize
 * @param {function} onProgress  — callback(loadedBytes, totalBytes)
 */
function _signedUpload(file, signedUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Log the URL path (not the full token) so browser console shows if it's wrong
    const _urlPath = signedUrl.split('?')[0];
    console.log('[AURENIX UPLOAD] PUT', _urlPath, '(token omitted)');

    xhr.open('PUT', signedUrl, true);
    // No Authorization header — the ?token= in the URL is the authorisation.
    // Setting Content-Type is required for Supabase to store with the right MIME.
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    // x-upsert: true — overwrite if an object at this path already exists
    // (safe for retries; the signed URL token controls authorisation)
    xhr.setRequestHeader('x-upsert', 'true');

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });

    xhr.addEventListener('load', () => {
      // Supabase signed-URL PUT returns 200 (new object) or 200 (upsert).
      // Accept 200, 201, and 204 to handle any Supabase response variant.
      if (xhr.status >= 200 && xhr.status < 300) {
        console.log('[AURENIX UPLOAD] PUT succeeded — HTTP', xhr.status, _urlPath);
        resolve();
      } else {
        // Surface the exact Supabase error message (never contains secrets)
        let detail = xhr.responseText ? xhr.responseText.slice(0, 500) : '(empty response)';
        try {
          const j = JSON.parse(xhr.responseText);
          detail = j.message || j.error || detail;
        } catch (_) {}
        const msg = `SUPABASE STORAGE UPLOAD FAILED — HTTP ${xhr.status}: ${detail}`;
        console.error('[AURENIX UPLOAD] PUT failed —', _urlPath,
          '— status:', xhr.status,
          '— response:', xhr.responseText ? xhr.responseText.slice(0, 500) : '(empty)');
        reject(new Error(msg));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('SUPABASE STORAGE UPLOAD FAILED — network error')));
    xhr.addEventListener('abort', () => reject(new Error('SUPABASE STORAGE UPLOAD FAILED — upload aborted')));

    xhr.send(file);
  });
}

function _getMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el  = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('audio');

    // Always resolve — never reject or hang.
    // duration_sec is optional metadata; it must never block or fail the upload.
    const cleanup = (sec) => {
      el.onloadedmetadata = null;
      el.onerror          = null;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(sec);
    };

    // 8-second safety timeout: if the browser cannot determine duration in time
    // (e.g. MP4 with moov atom at end, slow disk, large file) we resolve with 0
    // so the upload can proceed immediately.  The duration field will be 0/unknown
    // but the file itself will be stored correctly.
    const timer = setTimeout(() => cleanup(0), 8000);

    el.preload = 'metadata';
    el.onloadedmetadata = () => cleanup(isFinite(el.duration) ? Math.round(el.duration) : 0);
    el.onerror          = () => cleanup(0);
    el.src = url;
  });
}

/* ═══════════════════════════════════════
   METADATA EDITOR
═══════════════════════════════════════ */
function _openMetaModal(mediaId, defaultTitle) {
  const item = _mediaLib.find(m => m.id === mediaId) || { id: mediaId, title: defaultTitle, type: _uploadCategory };
  const isVideo = ['video','show','music_video','trailer','archive','broadcast_clip'].includes(item.type);
  const modal   = document.getElementById('ax-meta-modal');
  const content = document.getElementById('ax-meta-content');
  if (!modal || !content) return;

  content.innerHTML = `
    <div class="ax-meta-grid">
      <div class="ax-field-group">
        <label class="ax-field-label">Title *</label>
        <input class="ax-field-input" id="ax-meta-title" value="${_esc(item.title || '')}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Artist / Performer</label>
        <input class="ax-field-input" id="ax-meta-artist" value="${_esc(item.artist || '')}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Creator / Director</label>
        <input class="ax-field-input" id="ax-meta-creator" value="${_esc(item.creator || '')}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Genre</label>
        <input class="ax-field-input" id="ax-meta-genre" value="${_esc(item.genre || '')}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Year</label>
        <input class="ax-field-input" id="ax-meta-year" type="number" value="${item.year || new Date().getFullYear()}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Tags (comma-separated)</label>
        <input class="ax-field-input" id="ax-meta-tags" value="${(item.tags || []).join(', ')}">
      </div>
      <div class="ax-field-group" style="grid-column:1/-1;">
        <label class="ax-field-label">Description</label>
        <textarea class="ax-field-input" id="ax-meta-desc" rows="3" style="resize:vertical;">${_esc(item.description || '')}</textarea>
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Category</label>
        <select class="ax-field-input" id="ax-meta-category">
          ${MEDIA_CATEGORIES.map(c => `<option value="${c.id}" ${c.id === item.category ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Assign to Channel</label>
        <select class="ax-field-input" id="ax-meta-channel">
          <option value="">— Multiple / Unassigned —</option>
          <option value="">— No channel —</option>
          ${_channels().map(ch => `<option value="${ch.id}" ${ch.id === item.channel ? 'selected' : ''}>${_esc(ch.name)}</option>`).join('')}
        </select>
      </div>
      ${isVideo ? `
      <div class="ax-field-group">
        <label class="ax-field-label">Series / Show</label>
        <input class="ax-field-input" id="ax-meta-series" value="${_esc(item.series || '')}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Season</label>
        <input class="ax-field-input" id="ax-meta-season" type="number" value="${item.season || ''}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Episode</label>
        <input class="ax-field-input" id="ax-meta-episode" type="number" value="${item.episode || ''}">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Content Rating</label>
        <select class="ax-field-input" id="ax-meta-rating">
          ${['G','PG','PG-13','R','TV-G','TV-PG','TV-14','TV-MA'].map(r => `<option value="${r}" ${r === item.rating ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
      </div>` : ''}
    </div>
  `;

  modal.style.display = 'flex';

  document.getElementById('ax-meta-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });

  document.getElementById('ax-meta-save')?.addEventListener('click', async () => {
    const updates = {
      title:       document.getElementById('ax-meta-title')?.value.trim() || item.title,
      artist:      document.getElementById('ax-meta-artist')?.value.trim() || '',
      creator:     document.getElementById('ax-meta-creator')?.value.trim() || '',
      genre:       document.getElementById('ax-meta-genre')?.value.trim() || '',
      year:        parseInt(document.getElementById('ax-meta-year')?.value) || new Date().getFullYear(),
      tags:        (document.getElementById('ax-meta-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean),
      description: document.getElementById('ax-meta-desc')?.value.trim() || '',
      category:    document.getElementById('ax-meta-category')?.value || item.category,
      channel:     document.getElementById('ax-meta-channel')?.value || '',
    };
    if (isVideo) {
      updates.series  = document.getElementById('ax-meta-series')?.value.trim() || '';
      updates.season  = parseInt(document.getElementById('ax-meta-season')?.value) || null;
      updates.episode = parseInt(document.getElementById('ax-meta-episode')?.value) || null;
      updates.rating  = document.getElementById('ax-meta-rating')?.value || '';
    }
    try {
      await updateDoc(doc(db, 'network_media', mediaId), { ...updates, updated_at: serverTimestamp() });
      _toast('Metadata saved.');
      modal.style.display = 'none';
    } catch (e) {
      _toast('Save failed: ' + e.message, 'err');
    }
  });
}

/* ═══════════════════════════════════════
   LIBRARY PANE
═══════════════════════════════════════ */
function _bindLibraryPane() {
  const searchEl = document.getElementById('ax-lib-search');
  searchEl?.addEventListener('input', () => {
    _libSearch = searchEl.value.toLowerCase();
    _renderLibrary();
  });
  document.querySelectorAll('.ax-lib-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-lib-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _libFilter = btn.dataset.type;
      _renderLibrary();
    });
  });
}

/* ═══════════════════════════════════════
   APPROVAL PANE
   UPLOAD → PENDING APPROVAL → APPROVE/REJECT → BROADCAST
═══════════════════════════════════════ */
let _approvalFilter = 'pending_approval';

function _updateApprovalBadge() {
  const count = _mediaLib.filter(m => m.status === 'pending_approval').length;
  const badge = document.getElementById('ax-approval-badge');
  if (badge) {
    badge.style.display = count > 0 ? '' : 'none';
    badge.textContent   = count;
  }
}

function _bindApprovalPane() {
  document.getElementById('ax-approval-filter-bar')?.querySelectorAll('.ax-approval-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-approval-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _approvalFilter = btn.dataset.status;
      _renderApproval();
    });
  });
}

function _renderApproval() {
  const listEl = document.getElementById('ax-approval-list');
  if (!listEl) return;

  const items = _approvalFilter === 'all'
    ? _mediaLib
    : _mediaLib.filter(m => (m.status || 'pending_approval') === _approvalFilter);

  if (!items.length) {
    const emptyMsg = _approvalFilter === 'pending_approval'
      ? 'No pending uploads — all clear!'
      : `No ${_approvalFilter} media.`;
    listEl.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:24px;text-align:center;">${emptyMsg}</div>`;
    return;
  }

  const statusColors = { pending_approval:'#f0a500', approved:'var(--green)', rejected:'var(--red)', ready:'var(--green)' };

  listEl.innerHTML = items.map(m => {
    const st = m.status || 'pending_approval';
    const stLabel = st === 'pending_approval' ? 'PENDING APPROVAL' : st.toUpperCase();
    const isPending  = st === 'pending_approval';
    const isApproved = st === 'approved' || st === 'ready';
    const isVideo = m.mime_type?.startsWith('video/') || ['video','music_video','show','trailer','archive','broadcast_clip'].includes(m.type);
    const isAudio = m.mime_type?.startsWith('audio/') || ['audio','music','audio_program','podcast','station_id'].includes(m.type);

    // Build thumbnail preview area
    const thumbHtml = m.url
      ? (isVideo
          ? `<video src="${_esc(m.url)}" style="width:100%;max-height:220px;border-radius:6px;background:#000;display:block;" controls preload="metadata"></video>`
          : isAudio
            ? `<audio src="${_esc(m.url)}" style="width:100%;margin:4px 0;" controls preload="metadata"></audio>`
            : m.thumbnail_url
              ? `<img src="${_esc(m.thumbnail_url)}" style="width:100%;max-height:140px;object-fit:cover;border-radius:6px;" loading="lazy">`
              : '')
      : '';

    return `
    <div class="ax-sub-card" id="ax-appr-${m.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:260px;">
          <!-- Header row -->
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="font-size:18px;">${_typeIcon(m.type)}</span>
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--text);">${_esc(m.title || '(untitled)')}</div>
              ${m.artist ? `<div style="font-size:11px;color:var(--text-dim);">${_esc(m.artist)}</div>` : ''}
            </div>
            <span style="font-size:10px;font-weight:700;letter-spacing:1px;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,0.5);color:${statusColors[st] || 'var(--text-dim)'};">${stLabel}</span>
          </div>

          <!-- Media preview -->
          ${thumbHtml}

          <!-- Metadata grid -->
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:4px 12px;margin-top:10px;font-size:11px;color:var(--text-dim);">
            <div><strong style="color:var(--text);">File</strong><br>${_esc(m.title || '—')}</div>
            <div><strong style="color:var(--text);">Type</strong><br>${_esc(m.type || '—')}</div>
            <div><strong style="color:var(--text);">MIME</strong><br>${_esc(m.mime_type || '—')}</div>
            <div><strong style="color:var(--text);">Size</strong><br>${m.size_bytes ? _fmtSize(m.size_bytes) : '—'}</div>
            <div><strong style="color:var(--text);">Duration</strong><br>${m.duration_sec ? _fmtTime(m.duration_sec) : '—'}</div>
            <div><strong style="color:var(--text);">Uploader</strong><br>${_esc(m.creator || m.uploaded_by || '—')}</div>
            <div><strong style="color:var(--text);">Uploaded</strong><br>${m.uploaded_at ? _relDate(m.uploaded_at) : '—'}</div>
            <div><strong style="color:var(--text);">Category</strong><br>${_esc(m.category || '—')}</div>
          </div>
        </div>

        <!-- Action buttons -->
        <div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0;min-width:140px;">
          ${isPending ? `
            <button class="ax-btn-sm" style="background:var(--green);color:#000;font-weight:900;letter-spacing:0.5px;padding:8px 16px;"
                    onclick="window._AXC.approveMedia('${m.id}')">✓ APPROVE</button>
            <button class="ax-btn-sm ax-btn-danger" style="font-weight:700;padding:8px 16px;"
                    onclick="window._AXC.rejectMedia('${m.id}')">✕ REJECT</button>
            <button class="ax-btn-sm" style="font-weight:700;padding:8px 16px;"
                    onclick="window._AXC.requestChanges('${m.id}')">↻ REQUEST CHANGES</button>
          ` : isApproved ? `
            <div style="font-size:11px;font-weight:700;color:var(--green);text-align:center;margin-bottom:4px;">✓ APPROVED</div>
            <button class="ax-btn-sm" onclick="window._AXC.openBroadcast('${m.id}')">📡 Add to Broadcast</button>
            <button class="ax-btn-sm" onclick="window._AXC.addToSched('${m.id}')">📅 Schedule</button>
            <button class="ax-btn-sm ax-btn-danger" style="font-size:10px;"
                    onclick="window._AXC.rejectMedia('${m.id}')">✕ Revoke Approval</button>
          ` : `
            <div style="font-size:11px;font-weight:700;color:var(--red);text-align:center;">✕ REJECTED</div>
            <button class="ax-btn-sm" style="font-weight:700;padding:8px 16px;"
                    onclick="window._AXC.approveMedia('${m.id}')">✓ APPROVE ANYWAY</button>
          `}
          <button class="ax-btn-sm" onclick="window._AXC.openMeta('${m.id}')" style="margin-top:4px;">✏ Edit Metadata</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function _getFilteredLib(filter, search) {
  let items = _mediaLib;
  if (filter && filter !== 'all') {
    // Map filter IDs to type groups
    const typeMap = {
      audio:         ['audio','music','audio_program','podcast','station_id'],
      video:         ['video','music_video','trailer'],
      show:          ['show'],
      podcast:       ['podcast','audio_program'],
      broadcast_clip:['broadcast_clip'],
      archive:       ['archive'],
    };
    const types = typeMap[filter] || [filter];
    items = items.filter(m => types.includes(m.type));
  }
  if (search) {
    items = items.filter(m =>
      (m.title  || '').toLowerCase().includes(search) ||
      (m.artist || '').toLowerCase().includes(search) ||
      (m.creator|| '').toLowerCase().includes(search) ||
      (m.category||'').toLowerCase().includes(search)
    );
  }
  return items;
}

function _renderLibrary() {
  const grid = document.getElementById('ax-lib-grid');
  if (!grid) return;
  const items = _getFilteredLib(_libFilter, _libSearch);
  _renderMediaGrid(grid, items, true);
}

function _renderMusicLib() {
  const grid = document.getElementById('ax-music-lib-grid');
  if (!grid) return;
  const items = _mediaLib.filter(m => ['audio','music','audio_program','podcast','station_id'].includes(m.type));
  _renderMediaGrid(grid, items, true);
}

function _renderVideoLib() {
  const grid = document.getElementById('ax-video-lib-grid');
  if (!grid) return;
  const items = _mediaLib.filter(m => ['video','music_video','show','trailer','archive','broadcast_clip'].includes(m.type));
  _renderMediaGrid(grid, items, true);
}

function _renderMediaGrid(grid, items, showActions) {
  if (!items.length) {
    grid.innerHTML = `
      <div class="ax-empty" style="grid-column:1/-1;">
        <div class="ax-empty-icon">📚</div>
        <div class="ax-empty-title">No media found</div>
        <div class="ax-empty-sub">Upload audio and video from the Upload Center.</div>
      </div>`;
    return;
  }
  const statusColors = { pending_approval:'#f0a500', approved:'var(--green)', rejected:'var(--red)', ready:'var(--green)' };
  grid.innerHTML = items.map(m => {
    const st = m.status || 'pending_approval';
    const isApproved = st === 'approved' || st === 'ready';
    const stLabel = st === 'pending_approval' ? 'PENDING APPROVAL' : st.toUpperCase();
    return `
    <div class="ax-media-card" data-id="${m.id}">
      <div class="ax-media-card-thumb">
        ${m.thumbnail_url
          ? `<img src="${_esc(m.thumbnail_url)}" alt="" loading="lazy">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;opacity:0.5;">${_typeIcon(m.type)}</div>`}
        <span class="ax-media-card-type">${m.type || 'media'}</span>
        ${m.duration_sec ? `<span class="ax-media-card-dur">${_fmtTime(m.duration_sec)}</span>` : ''}
        ${m.channel ? `<span class="ax-media-card-ch" style="position:absolute;bottom:4px;left:4px;font-size:9px;background:rgba(0,0,0,0.7);color:#4d7aff;padding:1px 4px;border-radius:3px;">${m.channel}</span>` : ''}
        <span style="position:absolute;top:4px;right:4px;font-size:9px;font-weight:700;letter-spacing:0.5px;padding:2px 5px;border-radius:3px;background:rgba(0,0,0,0.75);color:${statusColors[st] || 'var(--text-dim)'};">${stLabel}</span>
      </div>
      <div class="ax-media-card-body">
        <div class="ax-media-card-title" title="${_esc(m.title)}">${_esc(m.title)}</div>
        <div class="ax-media-card-meta">${_esc(m.artist || m.creator || '')}${m.uploaded_at ? ' · ' + _relDate(m.uploaded_at) : ''}</div>
      </div>
      ${showActions ? `
      <div class="ax-media-card-actions">
        <button class="ax-btn-sm" onclick="window._AXC.playPreview('${m.id}')" title="Preview">▶</button>
        <button class="ax-btn-sm" onclick="window._AXC.openMeta('${m.id}')" title="Edit">✏</button>
        ${isApproved
          ? `<button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openBroadcast('${m.id}')" title="Broadcast">📡</button>
             <button class="ax-btn-sm" onclick="window._AXC.addToSched('${m.id}')" title="Schedule">📅</button>`
          : `<button class="ax-btn-sm" style="opacity:0.4;cursor:not-allowed;" disabled title="Approve before broadcasting">📡</button>
             <button class="ax-btn-sm" style="opacity:0.4;cursor:not-allowed;" disabled title="Approve before scheduling">📅</button>`}
        ${m.url ? `<button class="ax-btn-sm" onclick="window._AXC.downloadMedia('${m.id}')" title="Download">⬇</button>` : ''}
        <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.deleteMedia('${m.id}')" title="Delete">🗑</button>
      </div>` : ''}
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════
   SCHEDULE PANE
═══════════════════════════════════════ */
function _bindSchedulePane() {
  // Channel picker bindings are set up in _rebuildDynamicPanes().
  // Here we only bind the push/clear buttons and search.
  document.getElementById('ax-sched-push-btn')?.addEventListener('click', _pushScheduleLive);
  document.getElementById('ax-sched-clear-btn')?.addEventListener('click', async () => {
    if (!confirm(`Clear the schedule for ${_schedChannelId}?`)) return;
    await _saveQueue([]);
    _toast('Schedule cleared.');
  });

  const schedSearch = document.getElementById('ax-sched-search');
  schedSearch?.addEventListener('input', () => _renderMiniLib(schedSearch.value.toLowerCase()));
}

function _renderMiniLib(search = '') {
  const container = document.getElementById('ax-sched-mini-lib');
  if (!container) return;
  const items = search
    ? _mediaLib.filter(m => (m.title || '').toLowerCase().includes(search) || (m.artist || '').toLowerCase().includes(search))
    : _mediaLib;
  if (!items.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;">No media in library yet.</div>';
    return;
  }
  // Only approved media can enter the schedule
  const approved = items.filter(m => m.status === 'approved');
  if (!approved.length) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px;">${items.length ? 'No approved media yet — approve uploads in the Pending Approval pane.' : 'No media in library yet.'}</div>`;
    return;
  }
  container.innerHTML = approved.map(m => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;"
         onclick="window._AXC.addToSched('${m.id}')">
      <span style="font-size:14px;">${_typeIcon(m.type)}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(m.title)}</div>
        <div style="font-size:10px;color:var(--text-dim);">${m.type} · ${_fmtTime(m.duration_sec)}</div>
      </div>
      <button class="ax-btn-sm" style="flex-shrink:0;" title="Add to schedule">+</button>
    </div>`).join('');
}

function _renderSchedItems() {
  const container = document.getElementById('ax-sched-items');
  if (!container) return;
  const st    = _channelStates[_schedChannelId];
  const queue = st?.queue || [];
  if (!queue.length) {
    container.innerHTML = '<div class="ax-sched-empty">No items — add from library →</div>';
    return;
  }
  const curId = st?.current_item?.id;
  container.innerHTML = queue.map((item, idx) => `
    <div class="ax-sched-item ${item.id === curId ? 'is-current' : ''}" data-idx="${idx}">
      <span class="ax-sched-drag" title="Drag to reorder">⠿</span>
      <span class="ax-sched-pos">${item.id === curId ? '▶' : idx + 1}</span>
      <div class="ax-sched-item-info">
        <div class="ax-sched-item-title">${_esc(item.title)}</div>
        <div class="ax-sched-item-meta">${_esc(item.artist || '')} · ${item.type || 'media'}</div>
      </div>
      <span class="ax-sched-item-dur">${_fmtTime(item.duration_sec)}</span>
      <button class="ax-sched-item-rm" title="Remove" onclick="window._AXC.removeFromSched(${idx})">✕</button>
    </div>`).join('');
  _bindSchedDnD(container, queue);
}

function _renderOnAir() {
  const st  = _channelStates[_schedChannelId];
  const cur = st?.current_item;
  const titleEl = document.getElementById('ax-oa-title');
  const metaEl  = document.getElementById('ax-oa-meta');
  if (titleEl) titleEl.textContent = cur ? cur.title : '—';
  if (metaEl)  metaEl.textContent  = cur ? `${cur.artist || ''} · ${cur.type || 'media'}` : 'Channel offline';
}

function _bindSchedDnD(container, queue) {
  let dragged = null;
  container.querySelectorAll('.ax-sched-item').forEach(row => {
    row.draggable = true;
    row.addEventListener('dragstart', () => { dragged = row; row.style.opacity = '0.4'; });
    row.addEventListener('dragend',   () => { row.style.opacity = ''; dragged = null; });
    row.addEventListener('dragover',  e => e.preventDefault());
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragged || dragged === row) return;
      const fromIdx = parseInt(dragged.dataset.idx);
      const toIdx   = parseInt(row.dataset.idx);
      const newQueue = [...queue];
      const [moved] = newQueue.splice(fromIdx, 1);
      newQueue.splice(toIdx, 0, moved);
      await _saveQueue(newQueue);
    });
  });
}

async function _saveQueue(queue) {
  const loop = document.getElementById('ax-loop-toggle')?.checked ?? true;
  const st   = _channelStates[_schedChannelId];
  const ref  = doc(db, 'network_state', _schedChannelId);
  await setDoc(ref, { ...(st || {}), queue, loop, updated_at: serverTimestamp() }, { merge: true });
}

async function _pushScheduleLive() {
  const st    = _channelStates[_schedChannelId];
  const queue = st?.queue || [];
  if (!queue.length) { _toast('Add media to the schedule first.', 'err'); return; }
  const loop = document.getElementById('ax-loop-toggle')?.checked ?? true;
  const ref  = doc(db, 'network_state', _schedChannelId);
  await setDoc(ref, {
    current_item: queue[0],
    started_at:   serverTimestamp(),
    queue,
    loop,
    updated_at:   serverTimestamp(),
  }, { merge: true });
  const chName = _channels().find(c => c.id === _schedChannelId)?.name || _schedChannelId;
  _toast(`${chName} is now LIVE.`);
}

/* ═══════════════════════════════════════
   STATISTICS
═══════════════════════════════════════ */
function _renderStats() {
  const chs     = _channels();
  const total   = _mediaLib.length;
  const audios  = _mediaLib.filter(m => ['audio','music','podcast','audio_program','station_id'].includes(m.type)).length;
  const videos  = _mediaLib.filter(m => ['video','music_video','show','trailer','archive','broadcast_clip'].includes(m.type)).length;
  const live    = chs.filter(c => _channelStates[c.id]?.current_item).length;
  const queued  = chs.reduce((acc, c) => acc + (_channelStates[c.id]?.queue?.length || 0), 0);
  const totalSec= _mediaLib.reduce((acc, m) => acc + (m.duration_sec || 0), 0);

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setVal('ax-stat-total', total);
  setVal('ax-stat-audio', audios);
  setVal('ax-stat-video', videos);
  setVal('ax-stat-live',  live);
  setVal('ax-stat-queued', queued);
  setVal('ax-stat-duration', _fmtTimeLong(totalSec));

  const statsChEl = document.getElementById('ax-stats-channels');
  if (statsChEl) {
    statsChEl.innerHTML = chs.map(ch => {
      const st    = _channelStates[ch.id];
      const cur   = st?.current_item;
      const q     = st?.queue || [];
      const qSec  = q.reduce((a, i) => a + (i.duration_sec || 0), 0);
      return `
        <div class="ax-stats-ch-row">
          <div class="ax-stats-ch-id" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
          <div class="ax-stats-ch-name">${_esc(ch.name)}</div>
          <div class="ax-stats-ch-val">${q.length} items</div>
          <div class="ax-stats-ch-val">${_fmtTimeLong(qSec)} queued</div>
          <div class="ax-stats-ch-state ${cur ? 'live' : ''}">${cur ? '● LIVE' : '● STANDBY'}</div>
        </div>`;
    }).join('') || '<div style="color:var(--text-dim);font-size:12px;">No channels yet.</div>';
  }

  // Update security panel verified status
  const verEl = document.getElementById('ax-sec-verified');
  if (verEl) verEl.textContent = _user?.emailVerified ? '✓ YES' : '✗ NO';
}

/* ═══════════════════════════════════════
   WORKER HEALTH CHECK
═══════════════════════════════════════ */
/**
 * Calls the Worker /health endpoint and updates the Security pane
 * diagnostics without revealing secret values.
 */
async function _checkWorkerHealth() {
  const setCell = (id, text, ok) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? 'var(--green)' : 'var(--red, #ff2d55)';
  };

  const workerEl = document.getElementById('ax-sec-worker');
  if (workerEl) { workerEl.textContent = 'checking…'; workerEl.style.color = ''; }

  try {
    const res  = await fetch(UPLOAD_WORKER_URL + '/health');
    const data = await res.json();

    setCell('ax-sec-worker',  data.ok ? '✓ ONLINE' : `✗ ${data.error || 'NOT OK'}`, data.ok);
    setCell('ax-sec-sup-url', data.SUPABASE_URL  || '?', data.SUPABASE_URL  === '✓ set');
    setCell('ax-sec-sup-key', data.SUPABASE_SERVICE_KEY || '?', data.SUPABASE_SERVICE_KEY === '✓ set');
    setCell('ax-sec-fb-id',   data.FIREBASE_PROJECT_ID  || '?', data.FIREBASE_PROJECT_ID  === '✓ set');

    if (!data.ok) {
      console.error('[AURENIX] Worker health check failed:', data);
    } else {
      console.log('[AURENIX] Worker healthy. Project:', data.FIREBASE_PROJECT_ID_value,
                  'Supabase:', data.SUPABASE_URL_value);
    }
  } catch (err) {
    setCell('ax-sec-worker', '✗ UNREACHABLE — ' + err.message, false);
    console.error('[AURENIX] Worker /health fetch failed:', err);
  }

  // Also fetch /diagnose to show bucket file_size_limit
  try {
    const diagRes  = await fetch(UPLOAD_WORKER_URL + '/diagnose');
    const diagData = await diagRes.json();
    const bucketMB = diagData.bucket_file_size_limit_bytes
      ? Math.round(diagData.bucket_file_size_limit_bytes / 1048576) + ' MB'
      : '(not set)';
    const bucketEl = document.getElementById('ax-sec-bucket-limit');
    if (bucketEl) {
      bucketEl.textContent = bucketMB;
      bucketEl.style.color = diagData.bucket_file_size_limit_bytes >= 52428800
        ? 'var(--green)' : 'var(--orange,#f90)';
    }
    // Effective limit not known without probing, hint user
    const effEl = document.getElementById('ax-sec-eff-limit');
    if (effEl && effEl.textContent === '…') {
      effEl.textContent = `≤ ${bucketMB} (click 🔍 Probe to find exact limit)`;
      effEl.style.color = 'var(--text-dim)';
    }
  } catch (_) {}
}

/* ═══════════════════════════════════════
   PLAY NOW MODAL
═══════════════════════════════════════ */
let _playNowChannelId  = null;
let _playNowSelectedId = null;

function _openPlayNowModal(channelId) {
  _playNowChannelId  = channelId;
  _playNowSelectedId = null;
  const modal   = document.getElementById('ax-playnow-modal');
  const chanLbl = document.getElementById('ax-playnow-channel-label');
  const curEl   = document.getElementById('ax-playnow-current');
  const listEl  = document.getElementById('ax-playnow-list');
  const confirmBtn = document.getElementById('ax-playnow-confirm');
  const searchEl= document.getElementById('ax-playnow-search');
  if (!modal) return;

  const ch  = _channels().find(c => c.id === channelId);
  const st  = _channelStates[channelId];
  const cur = st?.current_item;

  if (chanLbl) chanLbl.textContent = `Channel: ${ch?.name || channelId}`;
  if (curEl) curEl.textContent = cur ? cur.title : '(Nothing playing)';
  if (confirmBtn) confirmBtn.disabled = true;

  const renderList = (search = '') => {
    const items = search
      ? _mediaLib.filter(m => (m.title || '').toLowerCase().includes(search) || (m.artist || '').toLowerCase().includes(search))
      : _mediaLib;
    if (!listEl) return;
    listEl.innerHTML = items.slice(0, 60).map(m => `
      <div class="ax-playnow-item ${_playNowSelectedId === m.id ? 'selected' : ''}" data-id="${m.id}">
        <span>${_typeIcon(m.type)}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(m.title)}</div>
          <div style="font-size:10px;color:var(--text-dim);">${m.type} · ${_fmtTime(m.duration_sec)}</div>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('.ax-playnow-item').forEach(row => {
      row.addEventListener('click', () => {
        listEl.querySelectorAll('.ax-playnow-item').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        _playNowSelectedId = row.dataset.id;
        if (confirmBtn) confirmBtn.disabled = false;
      });
    });
  };

  renderList();
  searchEl?.addEventListener('input', () => renderList(searchEl.value.toLowerCase()));

  modal.style.display = 'flex';

  document.getElementById('ax-playnow-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });
  confirmBtn?.addEventListener('click', async () => {
    if (!_playNowSelectedId || !_playNowChannelId) return;
    const item = _mediaLib.find(m => m.id === _playNowSelectedId);
    if (!item) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Applying…';
    try {
      const st    = _channelStates[_playNowChannelId];
      const queue = st?.queue || [];
      const loop  = st?.loop ?? true;
      const ref   = doc(db, 'network_state', _playNowChannelId);
      // Put selected item at front of queue
      const newQueue = [
        { id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0, mime_type: item.mime_type || '' },
        ...queue.filter(q => q.id !== item.id),
      ];
      await setDoc(ref, {
        current_item: newQueue[0],
        started_at:   serverTimestamp(),
        queue:        newQueue,
        loop,
        updated_at:   serverTimestamp(),
      }, { merge: true });
      _toast(`Now playing: ${item.title}`);
      modal.style.display = 'none';
    } catch (e) {
      _toast('Failed: ' + e.message, 'err');
    }
    confirmBtn.disabled = false;
    confirmBtn.textContent = '🔴 INTERRUPT & PLAY NOW';
  });
}

/* ═══════════════════════════════════════
   BROADCAST MODAL
═══════════════════════════════════════ */
let _bcastMediaId    = null;
let _bcastChannelId  = null;
let _bcastMode       = 'queue';

function _openBroadcastModal(mediaId) {
  _bcastMediaId   = mediaId;
  _bcastMode      = 'queue';
  const item  = _mediaLib.find(m => m.id === mediaId);
  if (!item) return;
  const modal = document.getElementById('ax-broadcast-modal');
  if (!modal) return;
  const titleEl = document.getElementById('ax-bcast-media-title');
  if (titleEl) titleEl.textContent = `${_typeIcon(item.type)} ${item.title}`;
  // Rebuild channel picker with current channels then reset selection
  _rebuildDynamicPanes();
  // Reset pickers
  document.querySelectorAll('#ax-bcast-ch-picker .ax-ch-pick-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#ax-bcast-ch-picker .ax-ch-pick-btn')?.classList.add('active');
  _bcastChannelId = document.querySelector('#ax-bcast-ch-picker .ax-ch-pick-btn')?.dataset.chid || (_channels()[0]?.id || '');

  document.querySelectorAll('.ax-bcast-action-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('ax-bcast-addqueue')?.classList.add('active');
  _bcastMode = 'queue';

  modal.style.display = 'flex';

  document.querySelectorAll('#ax-bcast-ch-picker .ax-ch-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ax-bcast-ch-picker .ax-ch-pick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _bcastChannelId = btn.dataset.chid;
    });
  });
  document.getElementById('ax-bcast-playnow')?.addEventListener('click', () => {
    document.querySelectorAll('.ax-bcast-action-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('ax-bcast-playnow')?.classList.add('active');
    _bcastMode = 'playnow';
  });
  document.getElementById('ax-bcast-addqueue')?.addEventListener('click', () => {
    document.querySelectorAll('.ax-bcast-action-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('ax-bcast-addqueue')?.classList.add('active');
    _bcastMode = 'queue';
  });
  document.getElementById('ax-bcast-schedule')?.addEventListener('click', () => {
    document.querySelectorAll('.ax-bcast-action-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('ax-bcast-schedule')?.classList.add('active');
    _bcastMode = 'schedule';
  });
  document.getElementById('ax-bcast-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });
  document.getElementById('ax-bcast-confirm')?.addEventListener('click', async () => {
    modal.style.display = 'none';
    if (_bcastMode === 'playnow') {
      _openPlayNowModal(_bcastChannelId);
      // Pre-select the item
      _playNowSelectedId = _bcastMediaId;
      setTimeout(() => {
        document.querySelectorAll('.ax-playnow-item').forEach(r => {
          r.classList.toggle('selected', r.dataset.id === _bcastMediaId);
        });
        const confirmBtn = document.getElementById('ax-playnow-confirm');
        if (confirmBtn) confirmBtn.disabled = false;
      }, 100);
    } else {
      // queue or schedule — both just add to queue
      await window._AXC.addToSchedChannel(_bcastMediaId, _bcastChannelId);
    }
  });
}

/* ═══════════════════════════════════════
   WINDOW ACTIONS (callable from inline HTML)
═══════════════════════════════════════ */
window._AXC = {
  goToSchedule(channelId) {
    _schedChannelId = channelId;
    const ch = _channels().find(c => c.id === channelId);
    document.querySelectorAll('#ax-sched-ch-picker .ax-ch-pick-btn').forEach(b => {
      const active = b.dataset.chid === channelId;
      b.classList.toggle('active', active);
      b.style.borderColor = active && ch ? (ch.color || '') : '';
      b.style.color       = active && ch ? (ch.color || '') : '';
    });
    const lbl = document.getElementById('ax-sched-ch-label');
    if (lbl) lbl.textContent = `${ch?.name || channelId} — Schedule`;
    _switchPane('schedule');
    _renderSchedItems();
    _renderOnAir();
  },

  openPlayNow(channelId) {
    _openPlayNowModal(channelId);
  },

  openBroadcast(mediaId) {
    _openBroadcastModal(mediaId);
  },

  openMeta(mediaId) {
    _openMetaModal(mediaId, '');
  },

  playPreview(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item?.url) { _toast('No URL for preview.', 'err'); return; }
    window.open(item.url, '_blank', 'noopener');
  },

  async skipChannel(channelId) {
    const st = _channelStates[channelId];
    if (!st) return;
    const queue  = st.queue || [];
    const curIdx = queue.findIndex(q => q.id === st.current_item?.id);
    let nextIdx  = curIdx + 1;
    if (nextIdx >= queue.length) {
      if (st.loop) nextIdx = 0;
      else {
        await setDoc(doc(db, 'network_state', channelId), { ...st, current_item: null, started_at: serverTimestamp() }, { merge: true });
        _toast(`${channelId} queue exhausted.`);
        return;
      }
    }
    const next = queue[nextIdx];
    await setDoc(doc(db, 'network_state', channelId), { ...st, current_item: next, started_at: serverTimestamp() }, { merge: true });
    _toast(`${channelId} skipped to: ${next.title}`);
  },

  async restartChannel(channelId) {
    const st = _channelStates[channelId];
    if (!st?.current_item) { _toast('Nothing playing to restart.', 'err'); return; }
    await setDoc(doc(db, 'network_state', channelId), { ...st, started_at: serverTimestamp() }, { merge: true });
    _toast(`${channelId} restarted.`);
  },

  async stopChannel(channelId) {
    if (!confirm(`Stop broadcasting on ${channelId}?`)) return;
    const st  = _channelStates[channelId];
    await setDoc(doc(db, 'network_state', channelId), { ...(st || {}), current_item: null, started_at: serverTimestamp() }, { merge: true });
    _toast(`${channelId} stopped.`);
  },

  async addToSched(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item) return;
    // Approval gate — only approved media can enter a broadcast schedule.
    const isApproved = item.status === 'approved' || item.status === 'ready';
    if (!isApproved) {
      _toast(`"${item.title}" is not approved yet. Go to Pending Approval to approve it first.`, 'err');
      return;
    }
    const st    = _channelStates[_schedChannelId];
    const queue = [...(st?.queue || [])];
    if (queue.find(q => q.id === mediaId)) { _toast('Already in schedule.', 'err'); return; }
    queue.push({ id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0, mime_type: item.mime_type || '' });
    await _saveQueue(queue);
    _toast(`Added to ${_schedChannelId}: ${item.title}`);
  },

  async addToSchedChannel(mediaId, channelId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item) return;
    // Approval gate — only approved media can enter a broadcast schedule.
    const isApproved = item.status === 'approved' || item.status === 'ready';
    if (!isApproved) {
      _toast(`"${item.title}" is not approved yet. Approve it in the Pending Approval pane first.`, 'err');
      return;
    }
    const st    = _channelStates[channelId];
    const queue = [...(st?.queue || [])];
    if (queue.find(q => q.id === mediaId)) { _toast('Already in queue.', 'err'); return; }
    queue.push({ id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0, mime_type: item.mime_type || '' });
    const loop = st?.loop ?? true;
    const ref  = doc(db, 'network_state', channelId);
    await setDoc(ref, { ...(st || {}), queue, loop, updated_at: serverTimestamp() }, { merge: true });
    _toast(`Added to ${channelId}: ${item.title}`);
  },

  async removeFromSched(idx) {
    const st    = _channelStates[_schedChannelId];
    const queue = [...(st?.queue || [])];
    queue.splice(idx, 1);
    await _saveQueue(queue);
  },

  downloadMedia(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item?.url) { _toast('No download URL available.', 'err'); return; }
    const urlParts = item.url.split('?')[0].split('.');
    const ext = urlParts.length > 1 ? urlParts.pop() : 'bin';
    const a = document.createElement('a');
    a.href = item.url;
    a.download = (item.title || 'media').replace(/[^a-z0-9 _-]/gi, '_') + '.' + ext;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  async deleteMedia(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item) return;
    if (!confirm(`DELETE "${item.title}"?\n\nThis will permanently remove the file from storage and cannot be undone.`)) return;
    try {
      if (item.storage_path) {
        await supabase.storage.from(MEDIA_BUCKET).remove([item.storage_path]);
      }
      await deleteDoc(doc(db, 'network_media', mediaId));
      _toast('Deleted: ' + item.title);
    } catch (e) {
      _toast('Delete failed: ' + e.message, 'err');
    }
  },

  async saveChannelSettings(channelId) {
    const descEl = document.querySelector(`.ax-settings-desc[data-chid="${channelId}"]`);
    const loopEl = document.querySelector(`.ax-settings-loop[data-chid="${channelId}"]`);
    // Save description/loop to the channel doc (not the state doc)
    await setDoc(doc(db, 'network_channels', channelId), {
      description: descEl?.value || '',
      loop:        loopEl?.checked ?? true,
      updated_at:  serverTimestamp(),
    }, { merge: true });
    _toast(`${channelId} settings saved.`);
  },

  editChannel(channelId) {
    _openChannelModal(channelId);
  },

  async deleteChannel(channelId) {
    const ch = _channels().find(c => c.id === channelId);
    if (!ch) return;
    if (!confirm(`DELETE channel "${ch.name}"?\n\nThis removes the channel from the network. Media in its queue will NOT be deleted from the library.`)) return;
    try {
      await deleteDoc(doc(db, 'network_channels', channelId));
      // Stop the channel state as well
      await setDoc(doc(db, 'network_state', channelId), { current_item: null, queue: [], loop: false, updated_at: serverTimestamp() }, { merge: true });
      _toast(`Channel deleted: ${ch.name}`);
    } catch (e) {
      _toast('Delete failed: ' + e.message, 'err');
    }
  },

  // ── APPROVAL WORKFLOW: network_media ─────────────────────────────────────
  // Approve a media item — it can now enter channels, playlists, and schedules.
  async approveMedia(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    try {
      await updateDoc(doc(db, 'network_media', mediaId), {
        status:      'approved',
        approved_at: serverTimestamp(),
        approved_by: _user?.email || '',
      });
      _toast(`✓ APPROVED — "${item?.title || mediaId}" is ready for broadcast.`);
    } catch (e) { _toast('Approve failed: ' + e.message, 'err'); }
  },

  // Reject a media item — it cannot enter channels or schedules.
  async rejectMedia(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    const note = prompt(`Rejection note (optional):`);
    if (note === null) return; // cancelled
    try {
      await updateDoc(doc(db, 'network_media', mediaId), {
        status:          'rejected',
        rejected_at:     serverTimestamp(),
        rejected_by:     _user?.email || '',
        rejection_note:  note || '',
      });
      _toast(`✕ REJECTED — "${item?.title || mediaId}".`);
    } catch (e) { _toast('Reject failed: ' + e.message, 'err'); }
  },

  // Request changes — keeps status as pending_approval with a note.
  async requestChanges(mediaId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    const note = prompt(`What changes are needed?`);
    if (!note) return;
    try {
      await updateDoc(doc(db, 'network_media', mediaId), {
        status:                   'pending_approval',
        changes_requested_at:     serverTimestamp(),
        changes_note:             note,
      });
      _toast(`↻ CHANGES REQUESTED — "${item?.title || mediaId}".`);
    } catch (e) { _toast('Request changes failed: ' + e.message, 'err'); }
  },

  // ── APPROVAL WORKFLOW: media_submissions (user-submitted URLs) ───────────
  async approveSubmission(submissionId) {
    try {
      await setDoc(doc(db, 'media_submissions', submissionId), { status: 'approved', reviewed_at: serverTimestamp() }, { merge: true });
      _toast('Submission approved.');
    } catch (e) { _toast('Failed: ' + e.message, 'err'); }
  },

  async rejectSubmission(submissionId) {
    try {
      await setDoc(doc(db, 'media_submissions', submissionId), { status: 'rejected', reviewed_at: serverTimestamp() }, { merge: true });
      _toast('Submission rejected.');
    } catch (e) { _toast('Failed: ' + e.message, 'err'); }
  },

  async importSubmission(submissionId) {
    const sub = _submissionsLib.find(s => s.id === submissionId);
    if (!sub) return;
    try {
      await addDoc(collection(db, 'network_media'), {
        title:        sub.title,
        artist:       sub.artist || '',
        creator:      sub.submitted_email || sub.submitted_by || '',
        description:  sub.description || '',
        type:         sub.type || 'audio',
        category:     sub.type || 'music',
        url:          sub.url || '',
        storage_path: '',
        duration_sec: 0,
        size_bytes:   0,
        // Imported user submissions start as pending_approval — Founder must approve
        // before the media can be added to a channel or broadcast schedule.
        status:       'pending_approval',
        channel:      '',
        tags:         [],
        year:         new Date().getFullYear(),
        uploaded_by:  _user?.uid || '',
        uploaded_at:  serverTimestamp(),
        source:       'user_submission',
        submission_id: submissionId,
      });
      _toast('Imported to library (pending approval): ' + sub.title);
    } catch (e) { _toast('Import failed: ' + e.message, 'err'); }
  },
};

/* ═══════════════════════════════════════
   UTILITIES
═══════════════════════════════════════ */
function _fmtTime(sec) {
  const s  = Math.max(0, Math.floor(sec || 0));
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${m}:${String(ss).padStart(2,'0')}`;
}

function _fmtTimeLong(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function _fmtSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _relDate(ts) {
  if (!ts?.toMillis) return '';
  const diff = Date.now() - ts.toMillis();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}

function _typeIcon(type) {
  const map = {
    audio:'🎵', music:'🎵', video:'🎬', music_video:'🎞', show:'📺',
    broadcast_clip:'🎥', podcast:'🎙', audio_program:'🎧', station_id:'📢',
    thumbnail:'🖼', trailer:'🎞', archive:'📼',
  };
  return map[type] || '🎬';
}

function _toast(msg, type = '') {
  let el = document.getElementById('ax-toast');
  if (!el) { el = document.createElement('div'); el.id = 'ax-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = type === 'err' ? 'err visible' : 'visible';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3500);
}
