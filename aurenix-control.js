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

import {
  LIVE_TV_CHANNEL_ID,
  LIVE_TV_COMMERCIAL_FREQ,
  startLiveTvEngine,
  stopLiveTvEngine,
  pauseLiveTvEngine,
  resumeLiveTvEngine,
  forceLiveTvCommercialBreak,
  skipLiveTvProgram,
  randomizeLiveTvNext,
  updateLiveTvMediaLib,
  saveLiveTvConfig,
  getLiveTvConfig,
  getLiveTvHistory,
  isLiveTvEngineActive,
} from './aurenix-live-tv-engine.js';

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
  { id: 'commercial',    label: '📺 COMMERCIAL',         accept: 'video/*,image/*,audio/*', type: 'commercial' },
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
let _oneEngineRunning  = false;
let _oneConfigUnsub    = null;
let _oneStateUnsub     = null;
// AURENIX LIVE TV state
let _liveTvEngineRunning = false;
let _liveTvTickTimer     = null;
let _liveTvStateUnsub    = null;
let _liveTvCurrentFreq   = 'normal';
// Commercial library
let _commercialLib       = [];
let _commLibUnsub        = null;
// Google Drive state
let _gdriveStatus        = null;   // { connected, account_email, account_name, folder }
let _gdriveUploadCategory = 'video';

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
    _bindLiveTvPane();
    _bindCommercialStudio();
    _subscribeCommercialLib();
    _bindStoragePane();
    _bindGdriveUploadPane();

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
    _checkDriveDiagnostic();
    ctrl.querySelector('#ax-sec-recheck-btn')?.addEventListener('click', _checkWorkerHealth);
    ctrl.querySelector('#ax-diag-drive-recheck-btn')?.addEventListener('click', _checkDriveDiagnostic);

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
    <button class="ax-ctrl-nav-btn" data-pane="live-tv">
      <span class="ax-ctrl-nav-icon">📡</span> AURENIX LIVE TV <span id="ax-livetv-engine-badge" style="display:none;background:var(--red);color:#fff;border-radius:10px;padding:1px 6px;font-size:9px;margin-left:4px;font-weight:900;letter-spacing:0.5px;">LIVE</span>
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="commercial-studio">
      <span class="ax-ctrl-nav-icon">📺</span> Commercial Studio
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
    <button class="ax-ctrl-nav-btn" data-pane="storage">
      <span class="ax-ctrl-nav-icon">💾</span> Storage
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

      <!-- Upload destination tabs -->
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;" id="ax-upload-dest-tabs">
        <button class="ax-btn-sm ax-upload-dest-tab active" data-dest="supabase" style="padding:8px 20px;">
          ☁ Supabase Storage
        </button>
        <button class="ax-btn-sm ax-upload-dest-tab" data-dest="gdrive" style="padding:8px 20px;" id="ax-upload-dest-gdrive-btn">
          🔵 Google Drive
        </button>
      </div>

      <!-- ── SUPABASE UPLOAD PANEL ── -->
      <div id="ax-upload-supabase-panel">
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

      <!-- ── GOOGLE DRIVE UPLOAD PANEL ── -->
      <div id="ax-upload-gdrive-panel" style="display:none;">
        <div id="ax-gdrive-upload-not-connected" style="background:rgba(30,80,255,0.07);border:1px solid rgba(30,80,255,0.25);border-radius:8px;padding:18px 20px;margin-bottom:16px;">
          <div style="font-size:14px;font-weight:700;color:var(--blue-bright);margin-bottom:6px;">🔵 Google Drive Not Connected</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6;">
            Connect your Google Drive first to upload directly to Drive.<br>
            Go to <strong style="color:var(--text);">Founder Studio → Storage → Google Drive</strong>.
          </div>
          <button class="ax-btn-sm" onclick="window._AXC.switchToPane('storage')" style="padding:8px 18px;">
            💾 Go to Storage Settings
          </button>
        </div>
        <div id="ax-gdrive-upload-connected" style="display:none;">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-dim);">
            <strong style="color:var(--text);">Upload large video directly to Google Drive.</strong><br>
            Uses Google's resumable upload API — the video goes straight from your browser to Drive.<br>
            The Worker only handles authorization (tiny JSON) — large files never pass through it.<br>
            <strong style="color:var(--orange,#f0a500);">Uploading does not broadcast.</strong> Founder approval still required.
          </div>

          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 14px;background:rgba(30,80,255,0.07);border-radius:6px;border:1px solid rgba(30,80,255,0.2);">
            <span style="font-size:11px;color:var(--text-dim);">Upload to subfolder:</span>
            <select class="ax-field-input" id="ax-gdrive-subfolder" style="flex:1;max-width:200px;padding:4px 8px;font-size:12px;">
              <option value="">— Root AURENIX folder —</option>
              <option value="videos">Videos</option>
              <option value="music">Music</option>
              <option value="commercials">Commercials</option>
              <option value="approved">Approved</option>
              <option value="archive">Archive</option>
            </select>
            <div class="ax-upload-categories" style="margin:0;flex-wrap:nowrap;overflow-x:auto;">
              ${MEDIA_CATEGORIES.map(cat => `
                <button class="ax-upload-cat-btn ax-gdrive-cat-btn ${cat.id === 'video' ? 'active' : ''}" data-cat="${cat.id}" data-accept="${cat.accept}" style="font-size:10px;padding:4px 10px;white-space:nowrap;">
                  ${cat.label}
                </button>`).join('')}
            </div>
          </div>

          <div class="ax-upload-zone" id="ax-gdrive-upload-zone" style="cursor:pointer;">
            <div class="ax-upload-icon">📁</div>
            <div class="ax-upload-title">DROP VIDEO HERE FOR GOOGLE DRIVE</div>
            <div class="ax-upload-sub">or SELECT FILE — uses Google's resumable upload</div>
            <div class="ax-upload-sub" style="margin-top:6px;font-size:11px;opacity:0.6;">
              Video: MP4 WebM MOV AVI MKV · Audio: MP3 WAV AAC · Images: JPG PNG WebP<br>
              No artificial size limit — limited only by your Google Drive storage quota.
            </div>
            <input type="file" id="ax-gdrive-file-input" accept="audio/*,video/*,image/*" style="display:none;">
          </div>
          <div id="ax-gdrive-upload-progress" style="display:none;margin-top:16px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="ax-gdrive-upload-filename">—</div>
                <div style="font-size:11px;color:var(--text-dim);" id="ax-gdrive-upload-filesize">—</div>
              </div>
              <span id="ax-gdrive-upload-pct" style="font-size:13px;font-weight:700;color:var(--blue-bright);min-width:40px;text-align:right;">0%</span>
            </div>
            <div style="height:8px;background:var(--surface-hi);border-radius:4px;overflow:hidden;margin-bottom:6px;">
              <div id="ax-gdrive-upload-bar" style="height:100%;width:0%;background:var(--blue-bright);transition:width 0.15s;border-radius:4px;"></div>
            </div>
            <div style="font-size:12px;color:var(--text-dim);" id="ax-gdrive-upload-status">Preparing…</div>
            <div style="margin-top:6px;font-size:11px;color:var(--text-dim);" id="ax-gdrive-upload-bytes"></div>
          </div>
          <div id="ax-gdrive-upload-result" style="display:none;margin-top:14px;"></div>
        </div>
      </div>
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

        <!-- ══ GOOGLE DRIVE DIAGNOSTIC ══ -->
        <div class="ax-security-card" style="grid-column:1/-1;">
          <div class="ax-security-title">🗂 GOOGLE DRIVE DIAGNOSTIC</div>
          <div class="ax-security-row"><span>Google Drive Account</span><span class="ax-security-val" id="ax-diag-drive-account">—</span></div>
          <div class="ax-security-row"><span>Drive Status</span><span class="ax-security-val" id="ax-diag-drive-status">—</span></div>
          <div class="ax-security-row"><span>AURENIX Media Folder</span><span class="ax-security-val" id="ax-diag-drive-folder-name">—</span></div>
          <div class="ax-security-row"><span>Folder ID</span><span class="ax-security-val" id="ax-diag-drive-folder-id">—</span></div>
          <div class="ax-security-row"><span>Folder Access</span><span class="ax-security-val" id="ax-diag-drive-folder-access">—</span></div>
          <div style="margin-top:8px;">
            <button class="ax-btn-sm" id="ax-diag-drive-recheck-btn">↺ Re-check Drive</button>
          </div>
          <div id="ax-diag-drive-result" style="margin-top:8px;font-size:11px;color:var(--text-dim);display:none;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow-y:auto;background:var(--surface-hi);border-radius:4px;padding:8px;"></div>
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

    <!-- ══ AURENIX LIVE TV CONTROL ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-live-tv">
      <div class="ax-section-title">📡 AURENIX <span>LIVE TV</span></div>
      <div style="background:rgba(255,45,85,0.08);border:1px solid rgba(255,45,85,0.25);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-dim);">
        <strong style="color:#ff2d55;">AURENIX LIVE TV</strong> — 24/7 shared television broadcast. All viewers watch the same live position.
        Random programs, automatic commercial breaks, Founder-controlled content pool.
        This is a <strong style="color:var(--text);">completely separate channel</strong> from AURENIX ONE.
      </div>

      <div class="ax-one-status-bar" id="ax-ltv-status-bar">
        <div class="ax-one-status-live" id="ax-ltv-status-live">
          <span class="ax-one-live-dot" id="ax-ltv-live-dot"></span>
          <span id="ax-ltv-status-text">CHANNEL OFFLINE</span>
        </div>
        <div style="font-size:11px;color:var(--text-dim);" id="ax-ltv-engine-state">Engine not started</div>
      </div>

      <div class="ax-one-section-label">LIVE CHANNEL CONTROL</div>
      <div class="ax-one-controls-grid">
        <button class="ax-one-ctrl-btn ax-one-btn-start" id="ax-ltv-start-btn">▶ START LIVE TV</button>
        <button class="ax-one-ctrl-btn ax-one-btn-stop"  id="ax-ltv-stop-btn">■ STOP LIVE TV</button>
        <button class="ax-one-ctrl-btn" id="ax-ltv-pause-btn">⏸ PAUSE</button>
        <button class="ax-one-ctrl-btn" id="ax-ltv-resume-btn">▶ RESUME</button>
        <button class="ax-one-ctrl-btn" id="ax-ltv-skip-btn">⏭ SKIP PROGRAM</button>
        <button class="ax-one-ctrl-btn" id="ax-ltv-force-comm-btn">📢 FORCE COMMERCIAL BREAK</button>
        <button class="ax-one-ctrl-btn" id="ax-ltv-randomize-btn">🎲 RANDOMIZE NEXT</button>
        <button class="ax-one-ctrl-btn" style="color:var(--gold);" id="ax-ltv-goto-comm-btn">📺 MANAGE COMMERCIALS</button>
      </div>

      <div class="ax-one-section-label">ON AIR — AURENIX LIVE TV</div>
      <div class="ax-one-on-air-grid">
        <div class="ax-one-now-card">
          <div class="ax-one-card-label"><span class="ax-one-live-dot live"></span> NOW PLAYING</div>
          <div class="ax-one-now-title" id="ax-ltv-now-title">—</div>
          <div class="ax-one-now-meta"  id="ax-ltv-now-meta">No broadcast active</div>
          <div class="ax-one-progress-wrap">
            <div class="ax-one-progress-bar">
              <div class="ax-one-progress-fill" id="ax-ltv-progress-fill"></div>
            </div>
            <div class="ax-one-progress-times">
              <span id="ax-ltv-elapsed">0:00</span>
              <span id="ax-ltv-remain">—</span>
            </div>
          </div>
          <div class="ax-one-comm-indicator" id="ax-ltv-comm-indicator" style="display:none;">
            <span style="color:var(--gold);font-weight:700;font-size:11px;letter-spacing:1px;">📢 COMMERCIAL BREAK</span>
          </div>
        </div>
        <div class="ax-one-upnext-card">
          <div class="ax-one-card-label">UP NEXT</div>
          <div class="ax-one-now-title" id="ax-ltv-next-title">—</div>
          <div class="ax-one-now-meta"  id="ax-ltv-next-meta"></div>
        </div>
      </div>

      <div class="ax-one-section-label" style="margin-top:20px;display:flex;align-items:center;justify-content:space-between;">
        <span>BROADCAST HISTORY</span>
        <button class="ax-btn-sm" id="ax-ltv-refresh-hist">↺ Refresh</button>
      </div>
      <div id="ax-ltv-history-list" style="margin-bottom:20px;">
        <div style="color:var(--text-dim);font-size:12px;">History will appear here.</div>
      </div>

      <div class="ax-one-section-label">COMMERCIAL FREQUENCY</div>
      <div class="ax-one-freq-grid">
        <button class="ax-ltv-freq-btn" data-freq="off">OFF</button>
        <button class="ax-ltv-freq-btn" data-freq="low">LOW</button>
        <button class="ax-ltv-freq-btn active" data-freq="normal">NORMAL</button>
        <button class="ax-ltv-freq-btn" data-freq="high">HIGH</button>
      </div>

      <div class="ax-one-settings-grid" style="margin-top:14px;">
        <div class="ax-field-group">
          <label class="ax-field-label">Min programs between breaks</label>
          <input class="ax-field-input" type="number" id="ax-ltv-min-prog" min="1" max="99" value="2">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Max programs between breaks</label>
          <input class="ax-field-input" type="number" id="ax-ltv-max-prog" min="1" max="99" value="4">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Min commercials per break</label>
          <input class="ax-field-input" type="number" id="ax-ltv-min-spots" min="0" max="10" value="1">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Max commercials per break</label>
          <input class="ax-field-input" type="number" id="ax-ltv-max-spots" min="0" max="10" value="2">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Avoid-repeat window (# items)</label>
          <input class="ax-field-input" type="number" id="ax-ltv-repeat-window" min="0" max="100" value="10">
        </div>
      </div>
      <button class="ax-btn-sm" id="ax-ltv-save-settings" style="margin-top:10px;">💾 Save Settings</button>

      <div class="ax-one-section-label" style="margin-top:20px;">LIVE TV CONTENT POOL</div>
      <div id="ax-ltv-pool-info" style="font-size:12px;color:var(--text-dim);">Loading pool info…</div>
    </div>

    <!-- ══ COMMERCIAL STUDIO ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-commercial-studio">
      <div class="ax-section-title">📺 Commercial <span>Studio</span></div>
      <div style="background:rgba(184,134,11,0.1);border:1px solid rgba(184,134,11,0.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-dim);">
        <strong style="color:var(--gold);">COMMERCIAL STUDIO</strong> — Create, manage, and approve commercials for AURENIX LIVE TV.<br>
        Only <strong style="color:var(--green);">ACTIVE</strong> commercials can enter the LIVE TV broadcast system.<br>
        Upload a finished video OR create a commercial from an image + text + music.
        The Founder controls all approval — do not reject content just because it contains a face, person, or logo.
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
        <button class="ax-btn-primary" id="ax-comm-create-btn" style="font-size:13px;padding:10px 22px;">+ CREATE COMMERCIAL</button>
        <button class="ax-btn-sm" id="ax-comm-upload-video-btn" style="padding:10px 18px;">⬆ UPLOAD VIDEO COMMERCIAL</button>
      </div>

      <div class="ax-one-section-label">COMMERCIAL LIBRARY</div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;" id="ax-comm-filter-bar">
        <button class="ax-btn-sm ax-comm-filter active" data-status="all">ALL</button>
        <button class="ax-btn-sm ax-comm-filter" data-status="active">ACTIVE</button>
        <button class="ax-btn-sm ax-comm-filter" data-status="inactive">INACTIVE</button>
        <button class="ax-btn-sm ax-comm-filter" data-status="draft">DRAFT</button>
      </div>
      <div id="ax-comm-library-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
        <div style="color:var(--text-dim);font-size:12px;padding:24px;">Loading commercial library…</div>
      </div>
    </div>

    <!-- ══ STORAGE PANE ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-storage">
      <div class="ax-section-title">💾 AURENIX <span>Storage</span></div>

      <!-- Storage overview cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:24px;" id="ax-storage-overview">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--blue-bright);margin-bottom:6px;">☁ SUPABASE STORAGE</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:4px;">aurenix-media bucket</div>
          <div style="font-size:11px;color:var(--green);">✓ Active</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--gold);margin-bottom:6px;">🔥 FIREBASE</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:4px;">Firestore metadata</div>
          <div style="font-size:11px;color:var(--green);">✓ Active</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;" id="ax-storage-gdrive-overview-card">
          <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#4285f4;margin-bottom:6px;">🔵 GOOGLE DRIVE</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:4px)" id="ax-storage-gdrive-status-text">Checking…</div>
          <div style="font-size:11px;color:var(--text-dim);" id="ax-storage-gdrive-account-line"></div>
        </div>
      </div>

      <!-- Google Drive Section -->
      <div style="background:var(--surface);border:1px solid rgba(66,133,244,0.3);border-radius:10px;padding:20px 22px;margin-bottom:20px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
          <div style="font-size:18px;font-weight:900;letter-spacing:0.12em;color:var(--text);">
            GOOGLE DRIVE
          </div>
          <div id="ax-gdrive-status-badge" style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:10px;background:rgba(30,80,255,0.15);color:var(--text-dim);">
            Checking…
          </div>
        </div>

        <!-- NOT CONNECTED STATE -->
        <div id="ax-gdrive-not-connected">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;line-height:1.7;">
            Connect your Google Drive to store large videos and media directly in your Drive.<br>
            AURENIX uses Google's official OAuth 2.0 — you will authenticate directly on Google's page.<br>
            <strong style="color:var(--text);">AURENIX never asks for or stores your Google password.</strong>
          </div>
          <div id="ax-gdrive-connect-err" style="display:none;margin-bottom:10px;padding:10px 14px;background:rgba(255,45,85,0.1);border:1px solid rgba(255,45,85,0.3);border-radius:6px;font-size:12px;color:var(--red);line-height:1.6;"></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
            <button class="ax-btn-primary" id="ax-gdrive-connect-btn" style="font-size:14px;padding:12px 28px;font-weight:900;letter-spacing:1px;">
              🔵 CONNECT GOOGLE DRIVE
            </button>
            <button class="ax-btn-sm" id="ax-gdrive-setup-toggle" style="padding:8px 16px;font-size:11px;">
              ⚙ SETUP INSTRUCTIONS
            </button>
          </div>

          <!-- Setup instructions panel (collapsed by default) -->
          <div id="ax-gdrive-setup-panel" style="display:none;margin-top:16px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 18px;font-size:12px;line-height:1.9;color:var(--text-dim);">
            <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:12px;letter-spacing:1px;">⚙ GOOGLE CLOUD SETUP GUIDE</div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">1. Create Google Cloud Project</strong><br>
              Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" style="color:var(--blue-bright);">console.cloud.google.com</a> →
              Create or select a project.
            </div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">2. Enable Google Drive API</strong><br>
              APIs &amp; Services → Library → search "Google Drive API" → Enable.
            </div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">3. Configure OAuth Consent Screen</strong><br>
              APIs &amp; Services → OAuth consent screen → External →<br>
              Add scopes: <code style="background:var(--surface-hi);padding:1px 4px;border-radius:3px;">drive.file</code>,
              <code style="background:var(--surface-hi);padding:1px 4px;border-radius:3px;">userinfo.email</code>,
              <code style="background:var(--surface-hi);padding:1px 4px;border-radius:3px;">userinfo.profile</code><br>
              Add your Google account as a Test User.
            </div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">4. Create OAuth Credentials</strong><br>
              APIs &amp; Services → Credentials → Create Credentials → OAuth client ID →<br>
              Application type: Web application →<br>
              Authorized redirect URI: <code id="ax-gdrive-setup-redirect-uri" style="background:var(--surface-hi);padding:1px 4px;border-radius:3px;color:var(--blue-bright);">loading…</code>
            </div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">5. Create KV Namespace</strong><br>
              <code style="background:var(--surface-hi);padding:2px 6px;border-radius:3px;">cd upload-worker &amp;&amp; npx wrangler kv namespace create GDRIVE_KV</code><br>
              Copy the ID into <code style="background:var(--surface-hi);padding:1px 4px;border-radius:3px;">upload-worker/wrangler.jsonc</code>.
            </div>
            <div style="margin-bottom:12px;">
              <strong style="color:var(--text);">6. Set Secrets (server-side only — never in JS/HTML)</strong><br>
              <code style="background:var(--surface-hi);padding:2px 6px;border-radius:3px;display:block;margin:4px 0;">npx wrangler secret put GOOGLE_CLIENT_ID</code>
              <code style="background:var(--surface-hi);padding:2px 6px;border-radius:3px;display:block;margin:4px 0;">npx wrangler secret put GOOGLE_CLIENT_SECRET</code>
              <code style="background:var(--surface-hi);padding:2px 6px;border-radius:3px;display:block;margin:4px 0;">npx wrangler secret put GOOGLE_REDIRECT_URI</code>
              <code style="background:var(--surface-hi);padding:2px 6px;border-radius:3px;display:block;margin:4px 0;">npx wrangler deploy</code>
            </div>
            <div style="padding:10px 12px;background:rgba(255,45,85,0.08);border:1px solid rgba(255,45,85,0.2);border-radius:6px;color:var(--text-dim);">
              ⚠ <strong style="color:var(--red);">Security:</strong> Never put <code>GOOGLE_CLIENT_SECRET</code> in any JavaScript, HTML, CSS, or GitHub file.
              It must remain in Cloudflare Worker secrets only.
            </div>
          </div>
        </div>

        <!-- CONNECTED STATE -->
        <div id="ax-gdrive-connected" style="display:none;">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:16px;">
            <div style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;">
              <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;margin-bottom:4px;">Connected Account</div>
              <div style="font-size:13px;color:var(--text);font-weight:600;" id="ax-gdrive-account-name">—</div>
              <div style="font-size:11px;color:var(--text-dim);" id="ax-gdrive-account-email">—</div>
            </div>
            <div style="background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 14px;" id="ax-gdrive-folder-card">
              <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;margin-bottom:4px;">Storage Folder</div>
              <div style="font-size:13px;color:var(--text);font-weight:600;" id="ax-gdrive-folder-name">Not set</div>
              <div style="font-size:10px;color:var(--text-dim);">AURENIX/Videos, Music, Commercials, Approved, Archive</div>
            </div>
          </div>

          <!-- Folder management -->
          <div style="margin-bottom:16px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px;">AURENIX FOLDER</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
              <div style="flex:1;min-width:220px;">
                <div id="ax-gdrive-folder-list-wrap" style="display:none;">
                  <select class="ax-field-input" id="ax-gdrive-folder-select" style="margin-bottom:6px;">
                    <option value="">— loading Drive folders… —</option>
                  </select>
                  <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">Or create a new folder named:</div>
                  <input class="ax-field-input" id="ax-gdrive-new-folder-name" placeholder="AURENIX" value="AURENIX" style="margin-bottom:6px;">
                  <div style="display:flex;gap:6px;">
                    <button class="ax-btn-sm" id="ax-gdrive-folder-use-existing" style="flex:1;">Use Selected</button>
                    <button class="ax-btn-sm" id="ax-gdrive-folder-create-new" style="flex:1;background:rgba(30,80,255,0.2);">Create New</button>
                  </div>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
                <button class="ax-btn-sm" id="ax-gdrive-change-folder-btn" style="padding:8px 16px;">
                  📁 CHANGE FOLDER
                </button>
                <a id="ax-gdrive-open-drive-btn" href="#" target="_blank" rel="noopener"
                   style="display:inline-block;padding:7px 14px;background:var(--surface-hi);border:1px solid var(--border);border-radius:5px;font-size:11px;font-weight:700;letter-spacing:0.5px;color:var(--text-dim);text-decoration:none;text-align:center;cursor:pointer;">
                  🔗 OPEN GOOGLE DRIVE
                </a>
                <button class="ax-btn-sm ax-btn-danger" id="ax-gdrive-disconnect-btn" style="padding:8px 16px;font-size:11px;">
                  ✕ DISCONNECT GOOGLE DRIVE
                </button>
              </div>
            </div>
            <div id="ax-gdrive-folder-status" style="margin-top:8px;font-size:12px;color:var(--text-dim);"></div>
          </div>

          <!-- Subfolder status -->
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px;">FOLDER STRUCTURE</div>
          <div id="ax-gdrive-subfolders" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
            <div style="font-size:11px;color:var(--text-dim);">Loading subfolder info…</div>
          </div>

          <!-- Use Drive for uploads -->
          <div style="padding:10px 14px;background:rgba(30,80,255,0.07);border:1px solid rgba(30,80,255,0.2);border-radius:6px;font-size:12px;color:var(--text-dim);margin-bottom:12px;">
            💡 To upload to Google Drive: go to <strong style="color:var(--text);">Upload Center → 🔵 Google Drive</strong> tab.
          </div>
        </div>
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

<!-- COMMERCIAL CREATOR MODAL -->
<div class="ax-modal-overlay" id="ax-comm-modal" style="display:none;">
  <div class="ax-modal-box" style="max-width:580px;max-height:90vh;overflow-y:auto;">
    <div class="ax-modal-title" id="ax-comm-modal-title">📺 CREATE COMMERCIAL</div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:16px;line-height:1.6;">
      Create a commercial from an image + text + music, OR upload a finished video commercial.<br>
      <strong style="color:var(--text);">Content is never rejected based on subject matter</strong> — people, faces, logos, and cats are all accepted.
    </div>

    <!-- Type selector -->
    <div class="ax-one-section-label" style="margin-bottom:8px;">COMMERCIAL TYPE</div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="ax-btn-sm ax-comm-type-btn active" data-type="image" style="padding:8px 16px;">🖼 FROM IMAGE</button>
      <button class="ax-btn-sm ax-comm-type-btn" data-type="video" style="padding:8px 16px;">🎬 UPLOAD VIDEO</button>
    </div>

    <!-- Image-based commercial fields -->
    <div id="ax-comm-image-fields">
      <div class="ax-meta-grid">
        <div class="ax-field-group" style="grid-column:1/-1;">
          <label class="ax-field-label">Commercial Image * <span style="color:var(--text-dim);font-size:10px;">(person, business, product, logo — anything)</span></label>
          <div style="border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;background:var(--surface);" id="ax-comm-img-drop">
            <div id="ax-comm-img-preview" style="margin-bottom:8px;display:none;"><img id="ax-comm-img-el" style="max-width:100%;max-height:180px;border-radius:6px;" src="" alt=""></div>
            <div id="ax-comm-img-placeholder">📷 Click or drop image here<br><span style="font-size:10px;color:var(--text-dim);">JPG PNG WebP GIF — any image accepted</span></div>
            <input type="file" id="ax-comm-img-input" accept="image/*" style="display:none;">
          </div>
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Business / Brand Name</label>
          <input class="ax-field-input" id="ax-comm-biz-name" placeholder="e.g. ACME Corp">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Website / URL</label>
          <input class="ax-field-input" id="ax-comm-website" placeholder="e.g. acme.com" type="url">
        </div>
        <div class="ax-field-group" style="grid-column:1/-1;">
          <label class="ax-field-label">Promotional Text / Tagline</label>
          <input class="ax-field-input" id="ax-comm-promo-text" placeholder="e.g. Check out this website! Best deals in town.">
        </div>
        <div class="ax-field-group" style="grid-column:1/-1;">
          <label class="ax-field-label">Background Music / Audio <span style="color:var(--text-dim);font-size:10px;">(optional — select from approved music library)</span></label>
          <select class="ax-field-input" id="ax-comm-bg-music">
            <option value="">— No background music —</option>
          </select>
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Commercial Duration</label>
          <select class="ax-field-input" id="ax-comm-duration">
            <option value="10">10 seconds</option>
            <option value="15">15 seconds</option>
            <option value="20">20 seconds</option>
            <option value="30" selected>30 seconds</option>
            <option value="45">45 seconds</option>
            <option value="60">60 seconds</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Video upload commercial fields -->
    <div id="ax-comm-video-fields" style="display:none;">
      <div class="ax-field-group" style="margin-bottom:12px;">
        <label class="ax-field-label">Commercial Video File *</label>
        <div style="border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;background:var(--surface);" id="ax-comm-vid-drop">
          <div id="ax-comm-vid-info" style="font-size:12px;color:var(--text-dim);display:none;"></div>
          <div id="ax-comm-vid-placeholder">🎬 Click or drop video here<br><span style="font-size:10px;color:var(--text-dim);">MP4 WebM MOV — any video content accepted (people, faces, logos, all OK)</span></div>
          <input type="file" id="ax-comm-vid-input" accept="video/*" style="display:none;">
        </div>
        <div id="ax-comm-vid-progress" style="display:none;margin-top:8px;">
          <div style="height:4px;background:var(--surface-hi);border-radius:2px;overflow:hidden;">
            <div id="ax-comm-vid-bar" style="height:100%;width:0%;background:var(--blue-bright);transition:width 0.2s;"></div>
          </div>
          <div id="ax-comm-vid-status" style="font-size:11px;color:var(--text-dim);margin-top:4px;"></div>
        </div>
      </div>
    </div>

    <!-- Common fields for both types -->
    <div class="ax-meta-grid" style="margin-top:8px;">
      <div class="ax-field-group">
        <label class="ax-field-label">Commercial Name / Title *</label>
        <input class="ax-field-input" id="ax-comm-title" placeholder="e.g. ACME Summer Sale">
      </div>
      <div class="ax-field-group">
        <label class="ax-field-label">Advertiser / Client</label>
        <input class="ax-field-input" id="ax-comm-advertiser" placeholder="e.g. ACME Corp">
      </div>
      <div class="ax-field-group" style="grid-column:1/-1;">
        <label class="ax-field-label">Notes / Description</label>
        <textarea class="ax-field-input" id="ax-comm-notes" rows="2" placeholder="Internal notes about this commercial" style="resize:vertical;"></textarea>
      </div>
    </div>

    <div class="ax-auth-err" id="ax-comm-err" style="margin-top:8px;"></div>
    <div class="ax-modal-actions" style="margin-top:16px;">
      <button class="ax-btn-ghost" id="ax-comm-cancel">CANCEL</button>
      <button class="ax-btn-sm" id="ax-comm-preview-btn" style="padding:10px 18px;">👁 PREVIEW</button>
      <button class="ax-btn-primary" id="ax-comm-save-btn">💾 SAVE COMMERCIAL</button>
    </div>
  </div>
</div>

<!-- COMMERCIAL PREVIEW MODAL -->
<div class="ax-modal-overlay" id="ax-comm-preview-modal" style="display:none;">
  <div class="ax-modal-box" style="max-width:520px;">
    <div class="ax-modal-title">👁 COMMERCIAL PREVIEW</div>
    <div id="ax-comm-preview-content" style="background:var(--surface);border-radius:8px;padding:20px;text-align:center;min-height:120px;"></div>
    <div class="ax-modal-actions" style="margin-top:16px;">
      <button class="ax-btn-ghost" id="ax-comm-preview-close">CLOSE</button>
    </div>
  </div>
</div>

<!-- APPROVE DESTINATION MODAL -->
<div class="ax-modal-overlay" id="ax-approve-dest-modal" style="display:none;">
  <div class="ax-modal-box" style="max-width:580px;max-height:90vh;overflow-y:auto;">
    <div class="ax-modal-title">✓ APPROVE SUBMISSION</div>
    <div id="ax-approve-dest-media-info" style="font-size:13px;font-weight:700;color:var(--text);padding:10px 14px;background:var(--surface);border-radius:6px;margin-bottom:16px;"></div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:20px;line-height:1.7;padding:10px 14px;background:rgba(30,80,255,0.06);border:1px solid rgba(30,80,255,0.18);border-radius:6px;">
      <strong style="color:var(--text);">Where do you want this media to go?</strong><br>
      Approval does <strong style="color:var(--orange,#f0a500);">not</strong> automatically broadcast. You control storage and channel assignment separately.
    </div>

    <!-- STORAGE DESTINATION -->
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px;">STORAGE DESTINATION</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;" id="ax-approve-dest-storage-btns">
      <button class="ax-approve-dest-storage-btn active" data-storage="supabase"
              style="flex:1;min-width:160px;padding:12px 16px;background:rgba(30,80,255,0.12);border:2px solid var(--blue-bright);border-radius:8px;color:var(--blue-bright);font-size:12px;font-weight:700;cursor:pointer;text-align:center;line-height:1.5;">
        ☁ SUPABASE STORAGE<br><span style="font-size:10px;font-weight:400;opacity:0.7;">Keep in current location</span>
      </button>
      <button class="ax-approve-dest-storage-btn" data-storage="gdrive"
              style="flex:1;min-width:160px;padding:12px 16px;background:var(--surface);border:2px solid var(--border);border-radius:8px;color:var(--text-dim);font-size:12px;font-weight:700;cursor:pointer;text-align:center;line-height:1.5;" id="ax-approve-dest-gdrive-btn">
        🔵 GOOGLE DRIVE<br><span style="font-size:10px;font-weight:400;opacity:0.7;">Copy to Drive (server-side)</span>
      </button>
    </div>
    <div id="ax-approve-dest-gdrive-warn" style="display:none;font-size:11px;color:var(--orange,#f0a500);margin-bottom:10px;padding:8px 12px;background:rgba(240,165,0,0.08);border:1px solid rgba(240,165,0,0.25);border-radius:5px;">
      ⚠ Google Drive is not connected. Go to <strong>Storage → Google Drive</strong> to connect it first.
    </div>

    <!-- STORAGE MODE -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;" id="ax-approve-dest-mode-btns">
      <button class="ax-approve-dest-mode-btn active" data-mode="storage_and_channel"
              style="flex:1;min-width:110px;padding:8px 12px;background:rgba(30,80,255,0.1);border:2px solid var(--blue-bright);border-radius:6px;color:var(--blue-bright);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
        STORAGE + CHANNEL
      </button>
      <button class="ax-approve-dest-mode-btn" data-mode="storage_only"
              style="flex:1;min-width:110px;padding:8px 12px;background:var(--surface);border:2px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
        STORAGE ONLY
      </button>
      <button class="ax-approve-dest-mode-btn" data-mode="channel_only"
              style="flex:1;min-width:110px;padding:8px 12px;background:var(--surface);border:2px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
        CHANNEL ONLY
      </button>
    </div>

    <!-- CHANNEL DESTINATION -->
    <div id="ax-approve-dest-channels-section">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px;">CHANNEL DESTINATION</div>
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;line-height:1.6;">
        Select one or more channels. Media will be <strong style="color:var(--text);">available</strong> to those channels but not automatically broadcast.
        You control when it actually enters programming.
      </div>
      <div id="ax-approve-dest-channel-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;"></div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:16px;">☑ Multiple channels allowed. Newly created channels appear here automatically.</div>

      <!-- PROGRAMMING STATUS -->
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px;">PROGRAMMING STATUS</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;" id="ax-approve-dest-prog-btns">
        <button class="ax-approve-dest-prog-btn active" data-prog="ready"
                style="flex:1;min-width:90px;padding:8px 12px;background:rgba(30,80,255,0.1);border:2px solid var(--blue-bright);border-radius:6px;color:var(--blue-bright);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
          READY
        </button>
        <button class="ax-approve-dest-prog-btn" data-prog="scheduled"
                style="flex:1;min-width:90px;padding:8px 12px;background:var(--surface);border:2px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
          SCHEDULED
        </button>
        <button class="ax-approve-dest-prog-btn" data-prog="hold"
                style="flex:1;min-width:90px;padding:8px 12px;background:var(--surface);border:2px solid var(--border);border-radius:6px;color:var(--text-dim);font-size:11px;font-weight:700;cursor:pointer;text-align:center;">
          ON HOLD
        </button>
      </div>
    </div>

    <div id="ax-approve-dest-status" style="display:none;font-size:12px;color:var(--text-dim);padding:8px 12px;background:var(--surface);border-radius:5px;margin-bottom:12px;line-height:1.6;"></div>
    <div class="ax-auth-err" id="ax-approve-dest-err" style="margin-bottom:10px;"></div>
    <div class="ax-modal-actions">
      <button class="ax-btn-ghost" id="ax-approve-dest-cancel">CANCEL</button>
      <button class="ax-btn-primary" id="ax-approve-dest-confirm" style="background:var(--green);border-color:var(--green);color:#000;font-weight:900;">
        ✓ APPROVE &amp; ASSIGN
      </button>
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
    // Auth guard — verify Founder session before touching Firestore
    if (!_user) {
      _toast('Please log in to continue.', 'err');
      return;
    }
    if (!_isFounder) {
      _toast('Founder access required.', 'err');
      console.warn('[AURENIX ONE] START blocked — user is not Founder:', _user?.email);
      return;
    }

    const approvedLib = _mediaLib.filter(m => m.status === 'approved');
    if (!approvedLib.length) { _toast('No approved media — approve content first.', 'err'); return; }
    try {
      await startOneEngine(_mediaLib);
      _oneEngineRunning = true;
      _updateOneBadge(true);
      _renderOneStatus(true, false);
      _startOneTick();
      _toast('AURENIX ONE channel started.');
    } catch (e) {
      // Log the exact Firebase error code and path for diagnosis
      console.error('[AURENIX ONE] START failed —',
        'code:', e?.code,
        'message:', e?.message,
        'user:', _user?.email,
        'isFounder:', _isFounder,
        'raw:', e,
      );
      if (e?.code === 'permission-denied') {
        _toast('Start failed: Firestore permission denied. Check console for details.', 'err');
      } else {
        _toast('Start failed: ' + e.message, 'err');
      }
    }
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
    // Keep AURENIX LIVE TV engine pool in sync
    if (_liveTvEngineRunning) updateLiveTvMediaLib(_mediaLib);
    _renderLiveTvPoolInfo();
    // Refresh commercial modal music dropdown
    _populateCommMusicDropdown();
  });
}

/* ─── COMMERCIAL LIBRARY SUBSCRIPTION ─── */
function _subscribeCommercialLib() {
  if (_commLibUnsub) return;
  const q = query(collection(db, 'network_commercials'), orderBy('created_at', 'desc'));
  _commLibUnsub = onSnapshot(q, snap => {
    _commercialLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderCommercialLibrary();
  }, err => {
    console.warn('[AURENIX] network_commercials snapshot error:', err.message);
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

/** Seed the initial channels if the network_channels collection is empty. */
async function _seedInitialChannels() {
  try {
    const snap = await getDocs(collection(db, 'network_channels'));
    if (!snap.empty) {
      // Check if ALTV is missing (upgrade existing installs)
      const existingIds = snap.docs.map(d => d.id);
      if (!existingIds.includes('ALTV')) {
        await setDoc(doc(db, 'network_channels', 'ALTV'), {
          name: 'AURENIX LIVE TV', label: 'LIVE TV', color: '#ff2d55',
          channel_type: 'mixed', mode: 'random', sort_order: 0,
          description: '24/7 live television — random videos, music, shows, and commercial breaks.',
          enabled: true, loop: true, is_live_tv: true,
          created_at: serverTimestamp(),
        });
        console.log('[AURENIX] Added ALTV channel to existing network.');
      }
      return;
    }
    const seeds = [
      { id: 'ALTV',name: 'AURENIX LIVE TV',   label: 'LIVE TV',    color: '#ff2d55', channel_type: 'mixed',  mode: 'random',   sort_order: 0, description: '24/7 live television — random videos, music, shows, and commercial breaks.', enabled: true, loop: true, is_live_tv: true },
      { id: 'A1',  name: 'AURENIX ONE',        label: 'ONE',        color: '#1e50ff', channel_type: 'mixed',  mode: 'shuffle',  sort_order: 1, description: 'Mixed programming — music, videos, clips, and more.',         enabled: true, loop: true },
      { id: 'A2',  name: 'AURENIX MUSIC',      label: 'MUSIC',      color: '#b8860b', channel_type: 'music',  mode: 'ordered',  sort_order: 2, description: 'Music-only channel with Founder-curated tracks.',             enabled: true, loop: true },
      { id: 'A3',  name: 'AURENIX VIDEO',      label: 'VIDEO',      color: '#8b00ff', channel_type: 'video',  mode: 'ordered',  sort_order: 3, description: 'Video broadcast channel — films, shows, music videos.',        enabled: true, loop: true },
      { id: 'A4',  name: 'AURENIX FUNNY',      label: 'FUNNY',      color: '#ff9500', channel_type: 'mixed',  mode: 'shuffle',  sort_order: 4, description: 'Comedy and funny clip channel — approved clips only.',         enabled: true, loop: true },
      { id: 'A5',  name: 'AURENIX AFTER DARK', label: 'AFTER DARK', color: '#9b59b6', channel_type: 'mixed',  mode: 'ordered',  sort_order: 5, description: 'Nighttime independent programming — its own media pool.',      enabled: true, loop: true },
    ];
    for (const seed of seeds) {
      const { id, ...data } = seed;
      await setDoc(doc(db, 'network_channels', id), { ...data, created_at: serverTimestamp() });
    }
    console.log('[AURENIX] Seeded initial channels including AURENIX LIVE TV.');
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
  listEl.innerHTML = items.map(s => {
    // Determine how the file was submitted
    const hasFile     = !!(s.storage_path || s.url);
    const fileSizeTxt = s.size_bytes ? _fmtSize(s.size_bytes) : '';
    const mimeShort   = (s.mime_type || '').split('/')[1] || s.mime_type || '';
    const fileTag     = hasFile
      ? `<span style="font-size:10px;background:rgba(30,80,255,0.12);color:var(--blue-bright);border-radius:4px;padding:1px 6px;margin-left:6px;letter-spacing:0.5px;">
           ${mimeShort ? mimeShort.toUpperCase() : 'FILE'}${fileSizeTxt ? ' · ' + fileSizeTxt : ''}
         </span>`
      : `<span style="font-size:10px;background:rgba(240,165,0,0.12);color:#f0a500;border-radius:4px;padding:1px 6px;margin-left:6px;letter-spacing:0.5px;">URL ONLY</span>`;

    return `
    <div class="ax-sub-card" id="ax-sub-${s.id}" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
            ${_esc(s.title || '(untitled)')}${fileTag}
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">
            ${_esc(s.artist || '')}${s.artist ? ' · ' : ''}${_esc(s.type || 'media')} · submitted by ${_esc(s.submitted_email || s.submitted_by || '?')}
          </div>
          ${s.file_name ? `<div style="font-size:11px;color:var(--text-dim);margin-top:3px;">📄 ${_esc(s.file_name)}</div>` : ''}
          ${s.url && s.storage_path ? `<div style="font-size:10px;color:var(--text-dim);margin-top:3px;word-break:break-all;">☁ Supabase Storage · <code style="font-size:10px;">${_esc(s.storage_path)}</code></div>` : ''}
          ${s.url && !s.storage_path ? `<div style="font-size:11px;color:var(--blue-bright);margin-top:4px;word-break:break-all;"><a href="${_esc(s.url)}" target="_blank" rel="noopener" style="color:var(--blue-bright);">🔗 ${_esc(s.url.slice(0,60))}${s.url.length > 60 ? '…' : ''}</a></div>` : ''}
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
    </div>`;
  }).join('');
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
      // Live-TV engine channels (A1, ALTV) use random engines — no fixed queue
      if (ch.id === ONE_CHANNEL_ID || ch.id === LIVE_TV_CHANNEL_ID) {
        const isLive = !!(st?.current_item);
        const isComm = !!(st?.is_commercial);
        return `
          <div class="ax-dash-q-row">
            <div class="ax-dash-q-label" style="color:${ch.color || '#1e50ff'}">${_esc(ch.label || ch.id)}</div>
            <div class="ax-dash-q-bar-wrap">
              <div class="ax-dash-q-bar" style="width:${isLive ? 100 : 0}%;background:${isLive ? (isComm ? 'var(--gold)' : 'var(--red)') : ch.color || '#1e50ff'}"></div>
            </div>
            <div class="ax-dash-q-count" style="color:${isLive ? (isComm ? 'var(--gold)' : 'var(--red)') : 'var(--text-dim)'};">${isLive ? (isComm ? '📢 COMMERCIAL' : '🔴 LIVE TV') : '⚫ ENGINE OFF'}</div>
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
    // Live-TV engine channels use a random engine — no fixed queue; skip queue warnings.
    if (ch.id === ONE_CHANNEL_ID || ch.id === LIVE_TV_CHANNEL_ID) return;
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

/* ── APPROVE DESTINATION MODAL ── */
// State for the modal
let _approveDestMediaId   = null;
let _approveDestStorage   = 'supabase';  // 'supabase' | 'gdrive'
let _approveDestMode      = 'storage_and_channel'; // 'storage_and_channel' | 'storage_only' | 'channel_only'
let _approveDestChannels  = new Set();   // set of channelIds selected
let _approveDestProg      = 'ready';     // 'ready' | 'scheduled' | 'hold'

/**
 * Open the Approve Destination modal for a given mediaId.
 * This replaces the old direct `approveMedia()` one-click approval.
 */
function _openApproveDestModal(mediaId) {
  const item = _mediaLib.find(m => m.id === mediaId);
  if (!item) return;

  _approveDestMediaId  = mediaId;
  _approveDestStorage  = 'supabase';
  _approveDestMode     = 'storage_and_channel';
  _approveDestChannels = new Set();
  _approveDestProg     = 'ready';

  const modal = document.getElementById('ax-approve-dest-modal');
  if (!modal) return;

  // Media info banner
  const infoEl = document.getElementById('ax-approve-dest-media-info');
  if (infoEl) {
    infoEl.innerHTML = `
      <span style="font-size:16px;margin-right:8px;">${_typeIcon(item.type)}</span>
      ${_esc(item.title || '(untitled)')}
      <span style="font-size:10px;font-weight:400;color:var(--text-dim);margin-left:8px;">${_esc(item.type || 'media')}${item.size_bytes ? ' · ' + _fmtSize(item.size_bytes) : ''}${item.mime_type ? ' · ' + _esc(item.mime_type) : ''}</span>`;
  }

  // Reset storage selection UI
  modal.querySelectorAll('.ax-approve-dest-storage-btn').forEach(b => {
    const isActive = b.dataset.storage === 'supabase';
    b.classList.toggle('active', isActive);
    b.style.background   = isActive ? 'rgba(30,80,255,0.12)' : 'var(--surface)';
    b.style.borderColor  = isActive ? 'var(--blue-bright)' : 'var(--border)';
    b.style.color        = isActive ? 'var(--blue-bright)' : 'var(--text-dim)';
  });
  document.getElementById('ax-approve-dest-gdrive-warn').style.display = 'none';

  // Reset mode buttons
  modal.querySelectorAll('.ax-approve-dest-mode-btn').forEach(b => {
    const isActive = b.dataset.mode === 'storage_and_channel';
    b.classList.toggle('active', isActive);
    b.style.background  = isActive ? 'rgba(30,80,255,0.1)' : 'var(--surface)';
    b.style.borderColor = isActive ? 'var(--blue-bright)' : 'var(--border)';
    b.style.color       = isActive ? 'var(--blue-bright)' : 'var(--text-dim)';
  });

  // Reset prog buttons
  modal.querySelectorAll('.ax-approve-dest-prog-btn').forEach(b => {
    const isActive = b.dataset.prog === 'ready';
    b.classList.toggle('active', isActive);
    b.style.background  = isActive ? 'rgba(30,80,255,0.1)' : 'var(--surface)';
    b.style.borderColor = isActive ? 'var(--blue-bright)' : 'var(--border)';
    b.style.color       = isActive ? 'var(--blue-bright)' : 'var(--text-dim)';
  });

  // Populate channel list dynamically from live channel list
  _refreshApproveDestChannelList();

  // Show/hide channels section based on mode
  _approveDestUpdateSectionsVisibility();

  // Clear status/error
  const statusEl = document.getElementById('ax-approve-dest-status');
  const errEl    = document.getElementById('ax-approve-dest-err');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
  if (errEl)    { errEl.textContent = ''; errEl.classList.remove('visible'); }

  modal.style.display = 'flex';
}

/** Rebuild the channel checkboxes in the approve-dest modal. */
function _refreshApproveDestChannelList() {
  const container = document.getElementById('ax-approve-dest-channel-list');
  if (!container) return;
  const chs = _channels();
  if (!chs.length) {
    container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">No channels yet — create one in Channel Manager.</div>';
    return;
  }
  container.innerHTML = chs.map(ch => {
    const checked = _approveDestChannels.has(ch.id);
    return `<label style="display:inline-flex;align-items:center;gap:7px;padding:8px 14px;background:${checked ? 'rgba(30,80,255,0.12)' : 'var(--surface)'};border:2px solid ${checked ? (ch.color || 'var(--blue-bright)') : 'var(--border)'};border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;color:${checked ? (ch.color || 'var(--blue-bright)') : 'var(--text-dim)'};transition:all 0.1s;">
      <input type="checkbox" data-chid="${ch.id}" style="display:none;" ${checked ? 'checked' : ''}>
      ${_esc(ch.label || ch.id)} — ${_esc(ch.name)}
    </label>`;
  }).join('');

  // Bind checkbox clicks
  container.querySelectorAll('label').forEach(lbl => {
    lbl.addEventListener('click', () => {
      const input = lbl.querySelector('input');
      const chid  = input.dataset.chid;
      const ch    = _channels().find(c => c.id === chid);
      if (_approveDestChannels.has(chid)) {
        _approveDestChannels.delete(chid);
        lbl.style.background   = 'var(--surface)';
        lbl.style.borderColor  = 'var(--border)';
        lbl.style.color        = 'var(--text-dim)';
      } else {
        _approveDestChannels.add(chid);
        lbl.style.background   = 'rgba(30,80,255,0.12)';
        lbl.style.borderColor  = ch?.color || 'var(--blue-bright)';
        lbl.style.color        = ch?.color || 'var(--blue-bright)';
      }
    });
  });
}

function _approveDestUpdateSectionsVisibility() {
  const chSection = document.getElementById('ax-approve-dest-channels-section');
  if (chSection) {
    chSection.style.display = _approveDestMode === 'storage_only' ? 'none' : '';
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

  // ── APPROVE DESTINATION MODAL BINDINGS ───────────────────────────────────
  const modal = document.getElementById('ax-approve-dest-modal');
  if (!modal) return;

  // Storage buttons
  modal.querySelectorAll('.ax-approve-dest-storage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const storage = btn.dataset.storage;
      // If Google Drive selected, check it's connected first
      if (storage === 'gdrive') {
        const connected = _gdriveStatus?.connected;
        const warnEl = document.getElementById('ax-approve-dest-gdrive-warn');
        if (!connected) {
          if (warnEl) warnEl.style.display = '';
          return; // Don't allow selection if not connected
        }
        if (warnEl) warnEl.style.display = 'none';
      }
      _approveDestStorage = storage;
      modal.querySelectorAll('.ax-approve-dest-storage-btn').forEach(b => {
        const active = b.dataset.storage === storage;
        b.classList.toggle('active', active);
        b.style.background   = active ? 'rgba(30,80,255,0.12)' : 'var(--surface)';
        b.style.borderColor  = active ? 'var(--blue-bright)'   : 'var(--border)';
        b.style.color        = active ? 'var(--blue-bright)'   : 'var(--text-dim)';
      });
    });
  });

  // Mode buttons
  modal.querySelectorAll('.ax-approve-dest-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _approveDestMode = btn.dataset.mode;
      modal.querySelectorAll('.ax-approve-dest-mode-btn').forEach(b => {
        const active = b.dataset.mode === _approveDestMode;
        b.classList.toggle('active', active);
        b.style.background  = active ? 'rgba(30,80,255,0.1)' : 'var(--surface)';
        b.style.borderColor = active ? 'var(--blue-bright)'  : 'var(--border)';
        b.style.color       = active ? 'var(--blue-bright)'  : 'var(--text-dim)';
      });
      _approveDestUpdateSectionsVisibility();
    });
  });

  // Programming status buttons
  modal.querySelectorAll('.ax-approve-dest-prog-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _approveDestProg = btn.dataset.prog;
      modal.querySelectorAll('.ax-approve-dest-prog-btn').forEach(b => {
        const active = b.dataset.prog === _approveDestProg;
        b.classList.toggle('active', active);
        b.style.background  = active ? 'rgba(30,80,255,0.1)' : 'var(--surface)';
        b.style.borderColor = active ? 'var(--blue-bright)'  : 'var(--border)';
        b.style.color       = active ? 'var(--blue-bright)'  : 'var(--text-dim)';
      });
    });
  });

  // Cancel
  document.getElementById('ax-approve-dest-cancel')?.addEventListener('click', () => {
    modal.style.display = 'none';
    _approveDestMediaId = null;
  });

  // Confirm — the main approval logic
  document.getElementById('ax-approve-dest-confirm')?.addEventListener('click', () => {
    _executeApproveAndAssign();
  });
}

/**
 * Execute the approval + storage/channel assignment chosen in the modal.
 * Called when Founder clicks "APPROVE & ASSIGN".
 */
async function _executeApproveAndAssign() {
  const mediaId = _approveDestMediaId;
  if (!mediaId) return;
  const item = _mediaLib.find(m => m.id === mediaId);
  if (!item) return;

  const modal    = document.getElementById('ax-approve-dest-modal');
  const statusEl = document.getElementById('ax-approve-dest-status');
  const errEl    = document.getElementById('ax-approve-dest-err');
  const confirmBtn = document.getElementById('ax-approve-dest-confirm');

  const setStatus = (msg) => {
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = msg; }
  };
  const setErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.classList.add('visible'); }
  };
  const clearErr = () => {
    if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }
  };

  clearErr();
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Approving…'; }

  // Collect selected channels
  const selectedChannels = [..._approveDestChannels];
  const includeChannels  = _approveDestMode !== 'storage_only' && selectedChannels.length > 0;

  try {
    // ── STEP 1: Mark approved in Firestore ──────────────────────────────────
    setStatus('Saving approval status…');
    const updateData = {
      status:             'approved',
      approved_at:        serverTimestamp(),
      approved_by:        _user?.email || '',
      programming_status: _approveDestProg,
      storage_backend:    _approveDestStorage,
      assigned_channels:  includeChannels ? selectedChannels : [],
    };
    await updateDoc(doc(db, 'network_media', mediaId), updateData);

    // ── STEP 2: Google Drive copy (server-side, if selected) ─────────────────
    if (_approveDestStorage === 'gdrive' && item.storage_path) {
      setStatus('Copying to Google Drive (server-side)…');
      try {
        const idToken  = await auth.currentUser.getIdToken(true);
        const copyRes  = await fetch(UPLOAD_WORKER_URL + '/submission/copy-to-drive', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storagePath: item.storage_path,
            fileName:    item.title || item.storage_path.split('/').pop() || 'media',
            mimeType:    item.mime_type || 'application/octet-stream',
          }),
        });
        const copyData = await copyRes.json();
        if (!copyRes.ok || !copyData.ok) {
          // Non-fatal: approval is already saved; log the Drive copy failure
          console.warn('[AURENIX] Drive copy failed:', copyData.error);
          setStatus(`⚠ Drive copy failed: ${copyData.error || 'Unknown error'}. Media stays in Supabase. Approval saved.`);
          _toast(`Drive copy failed: ${copyData.error || 'see console'}. Approved in Supabase.`, 'warn');
        } else {
          // Update Firestore with Drive file info
          await updateDoc(doc(db, 'network_media', mediaId), {
            drive_file_id:  copyData.driveFileId,
            drive_view_url: copyData.viewUrl || '',
            storage_backend: 'google_drive',
          });
          setStatus('✓ Copied to Google Drive. Firestore updated.');
        }
      } catch (driveErr) {
        console.warn('[AURENIX] Drive copy exception:', driveErr);
        setStatus(`⚠ Drive copy error: ${driveErr.message}. Approval already saved.`);
      }
    }

    // ── STEP 3: Log channel assignments in Firestore ─────────────────────────
    if (includeChannels) {
      setStatus('Saving channel assignments…');
      // Record on the media doc which channels it is assigned to
      // (actual scheduling is still manual via the Broadcast Scheduler)
      await updateDoc(doc(db, 'network_media', mediaId), {
        assigned_channels: selectedChannels,
        channel: selectedChannels[0] || '',  // primary channel (backward-compat)
        updated_at: serverTimestamp(),
      });
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    const chNames = selectedChannels.map(id => {
      const ch = _channels().find(c => c.id === id);
      return ch?.name || id;
    }).join(', ');

    const summaryParts = [
      `✓ APPROVED — "${item.title || mediaId}"`,
      `Storage: ${_approveDestStorage === 'gdrive' ? 'Google Drive' : 'Supabase'}`,
      _approveDestMode !== 'storage_only' && selectedChannels.length
        ? `Channels: ${chNames}`
        : _approveDestMode === 'storage_only'
          ? 'Storage only (no channel yet)'
          : 'No channel selected (Storage only)',
      `Programming: ${_approveDestProg.toUpperCase()}`,
    ];
    _toast(summaryParts.filter(Boolean).join(' · '));
    if (modal) modal.style.display = 'none';
    _approveDestMediaId = null;

  } catch (e) {
    console.error('[AURENIX] Approval failed:', e);
    setErr('Approval failed: ' + e.message);
    _toast('Approval failed: ' + e.message, 'err');
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '✓ APPROVE & ASSIGN'; }
  }
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
        <div style="display:flex;flex-direction:column;gap:8px;flex-shrink:0;min-width:150px;">
          ${isPending ? `
            <button class="ax-btn-sm" style="background:var(--green);color:#000;font-weight:900;letter-spacing:0.5px;padding:10px 16px;font-size:13px;"
                    onclick="window._AXC.approveMedia('${m.id}')">✓ APPROVE</button>
            <div style="font-size:9px;color:var(--text-dim);text-align:center;margin-top:-4px;margin-bottom:2px;">Opens storage + channel selector</div>
            <button class="ax-btn-sm ax-btn-danger" style="font-weight:700;padding:8px 16px;"
                    onclick="window._AXC.rejectMedia('${m.id}')">✕ REJECT</button>
            <button class="ax-btn-sm" style="font-weight:700;padding:8px 16px;"
                    onclick="window._AXC.requestChanges('${m.id}')">↻ REQUEST CHANGES</button>
          ` : isApproved ? `
            <div style="font-size:11px;font-weight:700;color:var(--green);text-align:center;margin-bottom:4px;">✓ APPROVED</div>
            ${m.storage_backend === 'google_drive'
              ? `<div style="font-size:10px;color:#4285f4;text-align:center;margin-bottom:4px;">🔵 Google Drive</div>`
              : `<div style="font-size:10px;color:var(--blue-bright);text-align:center;margin-bottom:4px;">☁ Supabase</div>`
            }
            ${(m.assigned_channels||[]).length ? `<div style="font-size:9px;color:var(--text-dim);text-align:center;margin-bottom:4px;">Channels: ${_esc((m.assigned_channels||[]).join(', '))}</div>` : ''}
            ${m.programming_status ? `<div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--text-dim);text-align:center;margin-bottom:6px;">${_esc(m.programming_status.toUpperCase())}</div>` : ''}
            <button class="ax-btn-sm" onclick="window._AXC.openBroadcast('${m.id}')">📡 Add to Broadcast</button>
            <button class="ax-btn-sm" onclick="window._AXC.addToSched('${m.id}')">📅 Schedule</button>
            <button class="ax-btn-sm" onclick="window._AXC.approveMedia('${m.id}')" style="font-size:10px;">✏ Change Destination</button>
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
    const isDrive = m.storage_backend === 'google_drive' || !!m.drive_file_id;
    const driveId = m.drive_file_id || '';
    return `
    <div class="ax-media-card" data-id="${m.id}">
      <div class="ax-media-card-thumb">
        ${m.thumbnail_url
          ? `<img src="${_esc(m.thumbnail_url)}" alt="" loading="lazy">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;opacity:0.5;">${_typeIcon(m.type)}</div>`}
        <span class="ax-media-card-type">${m.type || 'media'}${isDrive ? ' 🔵' : ''}</span>
        ${m.duration_sec ? `<span class="ax-media-card-dur">${_fmtTime(m.duration_sec)}</span>` : ''}
        ${m.channel ? `<span class="ax-media-card-ch" style="position:absolute;bottom:4px;left:4px;font-size:9px;background:rgba(0,0,0,0.7);color:#4d7aff;padding:1px 4px;border-radius:3px;">${m.channel}</span>` : ''}
        <span style="position:absolute;top:4px;right:4px;font-size:9px;font-weight:700;letter-spacing:0.5px;padding:2px 5px;border-radius:3px;background:rgba(0,0,0,0.75);color:${statusColors[st] || 'var(--text-dim)'};">${stLabel}</span>
      </div>
      <div class="ax-media-card-body">
        <div class="ax-media-card-title" title="${_esc(m.title)}">${_esc(m.title)}</div>
        <div class="ax-media-card-meta">${_esc(m.artist || m.creator || '')}${m.uploaded_at ? ' · ' + _relDate(m.uploaded_at) : ''}${m.size_bytes ? ' · ' + _fmtSize(m.size_bytes) : ''}</div>
        <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">
          ${isDrive
            ? `<span style="font-size:9px;color:#4285f4;font-weight:700;background:rgba(66,133,244,0.12);padding:1px 5px;border-radius:3px;">🔵 DRIVE</span>`
            : `<span style="font-size:9px;color:var(--blue-bright);font-weight:700;background:rgba(30,80,255,0.1);padding:1px 5px;border-radius:3px;">☁ SUPABASE</span>`}
          ${(m.assigned_channels||[]).map(chId => {
              const ch = _channels().find(c => c.id === chId);
              return `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:${(ch?.color||'#1e50ff')}22;color:${ch?.color||'#4d7aff'};">${_esc(ch?.label || chId)}</span>`;
            }).join('')}
          ${m.programming_status && m.programming_status !== 'ready' ? `<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(240,165,0,0.12);color:var(--orange,#f0a500);">${_esc(m.programming_status.toUpperCase())}</span>` : ''}
        </div>
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
        ${isDrive && driveId ? `<a href="https://drive.google.com/file/d/${_esc(driveId)}/view" target="_blank" rel="noopener" class="ax-btn-sm" title="Open in Google Drive" style="text-decoration:none;display:inline-block;">🔵</a>` : ''}
        ${!isDrive && m.url ? `<button class="ax-btn-sm" onclick="window._AXC.downloadMedia('${m.id}')" title="Download">⬇</button>` : ''}
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
   GOOGLE DRIVE DIAGNOSTIC
═══════════════════════════════════════ */
/**
 * Calls GET /gdrive/diagnostic and populates the Drive Diagnostic card
 * in the Founder Studio Security pane.
 * Shows: account email, connection status, folder name, masked folder ID,
 * and whether the folder is currently accessible.
 * Never displays OAuth secrets or refresh tokens.
 */
async function _checkDriveDiagnostic() {
  const set = (id, text, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  };

  set('ax-diag-drive-account',       'checking…', '');
  set('ax-diag-drive-status',        'checking…', '');
  set('ax-diag-drive-folder-name',   '—', '');
  set('ax-diag-drive-folder-id',     '—', '');
  set('ax-diag-drive-folder-access', '—', '');

  try {
    if (!auth.currentUser) throw new Error('Not signed in');
    const idToken = await auth.currentUser.getIdToken(true);
    const res  = await fetch(UPLOAD_WORKER_URL + '/gdrive/diagnostic', {
      headers: { 'Authorization': 'Bearer ' + idToken },
    });
    const data = await res.json();

    if (!res.ok) {
      set('ax-diag-drive-status', '✗ Error: ' + (data.error || data.config_error || 'Unknown'), 'var(--red,#ff2d55)');
      return;
    }

    if (!data.connected) {
      set('ax-diag-drive-account', data.account_email || '—', 'var(--text-dim)');
      set('ax-diag-drive-status',  'NOT CONNECTED',        'var(--text-dim)');
      set('ax-diag-drive-folder-name',   'N/A', 'var(--text-dim)');
      set('ax-diag-drive-folder-id',     'N/A', 'var(--text-dim)');
      set('ax-diag-drive-folder-access', 'N/A', 'var(--text-dim)');
      return;
    }

    set('ax-diag-drive-account', data.account_email || '—', 'var(--text)');
    set('ax-diag-drive-status',  'CONNECTED', 'var(--green)');

    if (data.folder) {
      set('ax-diag-drive-folder-name', data.folder.name || 'AURENIX', 'var(--text)');
      set('ax-diag-drive-folder-id',   data.folder.id_masked || '—',  'var(--text-dim)');
      const accessStatus = data.folder.status === 'VERIFIED'
        ? 'VERIFIED ✓'
        : data.folder.status === 'NOT_FOUND'
          ? 'NOT FOUND ✗ (will auto-recover on next upload)'
          : data.folder.status === 'ERROR'
            ? 'ERROR ✗'
            : data.folder.status;
      const accessColor = data.folder.status === 'VERIFIED'
        ? 'var(--green)'
        : 'var(--orange,#f0a500)';
      set('ax-diag-drive-folder-access', accessStatus, accessColor);
    } else {
      set('ax-diag-drive-folder-name',   'Not set — will auto-create on first upload', 'var(--orange,#f0a500)');
      set('ax-diag-drive-folder-id',     'N/A', 'var(--text-dim)');
      set('ax-diag-drive-folder-access', 'N/A', 'var(--text-dim)');
    }
  } catch (err) {
    set('ax-diag-drive-status', '✗ ' + err.message, 'var(--red,#ff2d55)');
  }
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
  switchToPane(pane) {
    _switchPane(pane);
  },

  editCommercial(commId) {
    _openCommercialModal(commId);
  },

  async deleteCommercial(commId) {
    const comm = _commercialLib.find(c => c.id === commId);
    if (!comm) return;
    if (!confirm(`DELETE commercial "${comm.title}"?\nThis cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'network_commercials', commId));
      _toast('Commercial deleted.');
    } catch (e) { _toast('Delete failed: ' + e.message, 'err'); }
  },

  async activateCommercial(commId) {
    try {
      await updateDoc(doc(db, 'network_commercials', commId), { status: 'active', updated_at: serverTimestamp() });
      _toast('Commercial activated for LIVE TV.');
    } catch (e) { _toast('Activate failed: ' + e.message, 'err'); }
  },

  async deactivateCommercial(commId) {
    try {
      await updateDoc(doc(db, 'network_commercials', commId), { status: 'inactive', updated_at: serverTimestamp() });
      _toast('Commercial deactivated.');
    } catch (e) { _toast('Deactivate failed: ' + e.message, 'err'); }
  },

  previewCommercial(commId) {
    const comm = _commercialLib.find(c => c.id === commId);
    if (!comm) return;
    _showCommercialPreview(comm);
  },

  async toggleLiveTvAssign(mediaId, assigned) {
    try {
      await updateDoc(doc(db, 'network_media', mediaId), { live_tv_assigned: assigned, updated_at: serverTimestamp() });
      _toast(assigned ? 'Added to LIVE TV pool.' : 'Removed from LIVE TV pool.');
    } catch (e) { _toast('Failed: ' + e.message, 'err'); }
  },

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
  // Approve a media item — opens Approve Destination modal.
  // APPROVAL DOES NOT AUTOMATICALLY BROADCAST. Founder chooses storage + channels first.
  approveMedia(mediaId) {
    _openApproveDestModal(mediaId);
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
        // Carry over actual storage location from the uploaded file
        url:          sub.url          || '',
        storage_path: sub.storage_path || '',
        // Carry over real file metadata if present
        file_name:    sub.file_name    || '',
        size_bytes:   sub.size_bytes   || 0,
        mime_type:    sub.mime_type    || '',
        duration_sec: 0,
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
    commercial:'📺', promo:'📢',
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

/* ═══════════════════════════════════════
   AURENIX LIVE TV — FOUNDER PANE BINDINGS
═══════════════════════════════════════ */

function _bindLiveTvPane() {
  // Start
  document.getElementById('ax-ltv-start-btn')?.addEventListener('click', async () => {
    if (!_user || !_isFounder) { _toast('Founder access required.', 'err'); return; }
    const approvedLib = _mediaLib.filter(m => m.status === 'approved');
    if (!approvedLib.length) { _toast('No approved media — approve content first.', 'err'); return; }
    try {
      await startLiveTvEngine(_mediaLib);
      _liveTvEngineRunning = true;
      _updateLiveTvBadge(true);
      _renderLiveTvStatus(true, false);
      _startLiveTvTick();
      _toast('AURENIX LIVE TV started.');
    } catch (e) {
      console.error('[AURENIX LIVE TV] START failed —', e?.code, e?.message, e);
      if (e?.code === 'permission-denied') {
        _toast('Start failed: Firestore permission denied. Check console.', 'err');
      } else {
        _toast('Start failed: ' + e.message, 'err');
      }
    }
  });

  // Stop
  document.getElementById('ax-ltv-stop-btn')?.addEventListener('click', async () => {
    if (!confirm('Stop AURENIX LIVE TV? The channel will go dark for all viewers.')) return;
    try {
      await stopLiveTvEngine();
      _liveTvEngineRunning = false;
      _stopLiveTvTick();
      _updateLiveTvBadge(false);
      _renderLiveTvStatus(false, false);
      _toast('AURENIX LIVE TV stopped.');
    } catch (e) { _toast('Stop failed: ' + e.message, 'err'); }
  });

  // Pause
  document.getElementById('ax-ltv-pause-btn')?.addEventListener('click', async () => {
    try {
      await pauseLiveTvEngine();
      _renderLiveTvStatus(true, true);
      _toast('AURENIX LIVE TV paused.');
    } catch (e) { _toast('Pause failed: ' + e.message, 'err'); }
  });

  // Resume
  document.getElementById('ax-ltv-resume-btn')?.addEventListener('click', async () => {
    try {
      await resumeLiveTvEngine();
      _renderLiveTvStatus(true, false);
      _toast('AURENIX LIVE TV resumed.');
    } catch (e) { _toast('Resume failed: ' + e.message, 'err'); }
  });

  // Skip
  document.getElementById('ax-ltv-skip-btn')?.addEventListener('click', async () => {
    try {
      await skipLiveTvProgram();
      _toast('Skipped — loading next program…');
    } catch (e) { _toast('Skip failed: ' + e.message, 'err'); }
  });

  // Force commercial break
  document.getElementById('ax-ltv-force-comm-btn')?.addEventListener('click', async () => {
    try {
      const ok = await forceLiveTvCommercialBreak();
      _toast(ok ? '📢 Commercial break started.' : 'No commercials available yet.', ok ? '' : 'err');
    } catch (e) { _toast('Force break failed: ' + e.message, 'err'); }
  });

  // Randomize next
  document.getElementById('ax-ltv-randomize-btn')?.addEventListener('click', async () => {
    try {
      const ok = await randomizeLiveTvNext();
      _toast(ok ? '🎲 Randomized — new program selected.' : 'No eligible programs in pool.', ok ? '' : 'err');
    } catch (e) { _toast('Randomize failed: ' + e.message, 'err'); }
  });

  // Manage commercials shortcut
  document.getElementById('ax-ltv-goto-comm-btn')?.addEventListener('click', () => {
    _switchPane('commercial-studio');
  });

  // Refresh history
  document.getElementById('ax-ltv-refresh-hist')?.addEventListener('click', _renderLiveTvHistory);

  // Commercial frequency buttons
  document.querySelectorAll('.ax-ltv-freq-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.ax-ltv-freq-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _liveTvCurrentFreq = btn.dataset.freq;
      const freq = LIVE_TV_COMMERCIAL_FREQ[_liveTvCurrentFreq] || LIVE_TV_COMMERCIAL_FREQ.normal;
      const minProg = document.getElementById('ax-ltv-min-prog');
      const maxProg = document.getElementById('ax-ltv-max-prog');
      const minSpot = document.getElementById('ax-ltv-min-spots');
      const maxSpot = document.getElementById('ax-ltv-max-spots');
      if (minProg) minProg.value = freq.minPrograms === 999 ? 0 : freq.minPrograms;
      if (maxProg) maxProg.value = freq.maxPrograms === 999 ? 0 : freq.maxPrograms;
      if (minSpot) minSpot.value = freq.minSpot;
      if (maxSpot) maxSpot.value = freq.maxSpot;
    });
  });

  // Save settings
  document.getElementById('ax-ltv-save-settings')?.addEventListener('click', async () => {
    const updates = {
      commercial_freq:     _liveTvCurrentFreq,
      min_programs:        parseInt(document.getElementById('ax-ltv-min-prog')?.value) || 2,
      max_programs:        parseInt(document.getElementById('ax-ltv-max-prog')?.value) || 4,
      min_spots:           parseInt(document.getElementById('ax-ltv-min-spots')?.value) || 1,
      max_spots:           parseInt(document.getElementById('ax-ltv-max-spots')?.value) || 2,
      avoid_repeat_window: parseInt(document.getElementById('ax-ltv-repeat-window')?.value) || 10,
    };
    try {
      await saveLiveTvConfig(updates);
      _toast('AURENIX LIVE TV settings saved.');
    } catch (e) { _toast('Save failed: ' + e.message, 'err'); }
  });

  // Subscribe to ALTV state for the on-air panel
  _subscribeLiveTvStateForPanel();

  // Initial renders
  _renderLiveTvPoolInfo();
  _renderLiveTvHistory();
}

/** Subscribe to network_state/ALTV to update the on-air panel. */
function _subscribeLiveTvStateForPanel() {
  if (_liveTvStateUnsub) return;
  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  _liveTvStateUnsub = onSnapshot(stateRef, snap => {
    if (!snap.exists()) return;
    const st  = snap.data();
    const cur = st?.current_item;
    const isComm = !!(st?.is_commercial);

    const titleEl   = document.getElementById('ax-ltv-now-title');
    const metaEl    = document.getElementById('ax-ltv-now-meta');
    const commEl    = document.getElementById('ax-ltv-comm-indicator');
    const nextTitle = document.getElementById('ax-ltv-next-title');
    const nextMeta  = document.getElementById('ax-ltv-next-meta');

    if (titleEl) titleEl.textContent = cur ? cur.title : '—';
    if (metaEl)  metaEl.textContent  = cur ? (cur.artist || cur.type || 'media') : 'No broadcast active';
    if (commEl)  commEl.style.display = isComm ? '' : 'none';

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

    const isRunning = !!(cur);
    _renderLiveTvStatus(isRunning, false);
    _updateLiveTvBadge(isRunning);
  });
}

function _renderLiveTvStatus(running, paused) {
  const dotEl   = document.getElementById('ax-ltv-live-dot');
  const textEl  = document.getElementById('ax-ltv-status-text');
  const stateEl = document.getElementById('ax-ltv-engine-state');
  if (dotEl)  dotEl.className  = `ax-one-live-dot ${running && !paused ? 'live' : ''}`;
  if (textEl) textEl.textContent = paused ? 'PAUSED' : (running ? 'BROADCASTING' : 'CHANNEL OFFLINE');
  if (stateEl) stateEl.textContent = _liveTvEngineRunning
    ? (paused ? 'Engine active — paused' : 'Engine running — 24/7 mode')
    : 'Engine not started — click START LIVE TV';
}

function _updateLiveTvBadge(live) {
  const badge = document.getElementById('ax-livetv-engine-badge');
  if (badge) badge.style.display = live ? '' : 'none';
}

function _startLiveTvTick() {
  if (_liveTvTickTimer) return;
  _liveTvTickTimer = setInterval(_liveTvTickFn, 800);
}

function _stopLiveTvTick() {
  if (_liveTvTickTimer) { clearInterval(_liveTvTickTimer); _liveTvTickTimer = null; }
}

function _liveTvTickFn() {
  const st  = _channelStates[LIVE_TV_CHANNEL_ID];
  const cur = st?.current_item;
  if (!cur) return;

  const startedAt = st.started_at?.toMillis?.() || Date.now();
  const elapsed   = (Date.now() - startedAt) / 1000;
  const dur       = cur.duration_sec || 0;

  const fill    = document.getElementById('ax-ltv-progress-fill');
  const elEl    = document.getElementById('ax-ltv-elapsed');
  const remEl   = document.getElementById('ax-ltv-remain');

  if (dur > 0) {
    const pct = Math.min(100, (elapsed / dur) * 100);
    if (fill)  fill.style.width    = pct + '%';
    if (elEl)  elEl.textContent    = _fmtTime(elapsed);
    if (remEl) remEl.textContent   = '-' + _fmtTime(Math.max(0, dur - elapsed));
  } else {
    if (fill)  fill.style.width    = '0%';
    if (elEl)  elEl.textContent    = _fmtTime(elapsed);
    if (remEl) remEl.textContent   = '—';
  }
}

async function _renderLiveTvHistory() {
  const listEl = document.getElementById('ax-ltv-history-list');
  if (!listEl) return;
  try {
    const history = await getLiveTvHistory();
    if (!history.length) {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:12px;">No broadcast history yet.</div>';
      return;
    }
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

function _renderLiveTvPoolInfo() {
  const el = document.getElementById('ax-ltv-pool-info');
  if (!el) return;
  const approved = _mediaLib.filter(m => m.status === 'approved');
  const PROG_TYPES = ['video','music_video','show','broadcast_clip','audio_program','podcast','station_id','archive','trailer','audio','music'];
  const COMM_TYPES = ['commercial','promo','trailer','station_id'];
  const programs    = approved.filter(m => PROG_TYPES.includes(m.type) && m.live_tv_assigned !== false);
  const commercials = approved.filter(m => COMM_TYPES.includes(m.type) && m.live_tv_assigned !== false);
  // Also count active commercials from the commercial library
  const libComms    = _commercialLib.filter(c => c.status === 'active');
  el.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:8px;">
      <div><span style="font-size:18px;font-weight:900;color:var(--blue-bright);">${programs.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Programs eligible</span></div>
      <div><span style="font-size:18px;font-weight:900;color:var(--gold);">${commercials.length + libComms.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Commercials available</span></div>
      <div><span style="font-size:18px;font-weight:900;color:var(--green);">${approved.length}</span>
           <span style="font-size:11px;color:var(--text-dim);margin-left:4px;">Total approved</span></div>
    </div>
    ${programs.length === 0 ? '<div style="color:var(--orange,#f0a500);font-size:12px;">⚠ No eligible programs — approve media in Pending Approval first.</div>' : ''}
    ${(commercials.length + libComms.length) === 0 ? '<div style="color:var(--text-dim);font-size:11px;margin-top:4px;">No commercials yet — create one in Commercial Studio.</div>' : ''}`;
}

/* ═══════════════════════════════════════
   COMMERCIAL STUDIO BINDINGS
═══════════════════════════════════════ */
let _commEditId    = null;  // non-null when editing an existing commercial
let _commImageFile = null;  // pending image file
let _commVideoFile = null;  // pending video file
let _commType      = 'image'; // 'image' | 'video'
let _commFilter    = 'all';

function _bindCommercialStudio() {
  // Main "Create Commercial" button
  document.getElementById('ax-comm-create-btn')?.addEventListener('click', () => {
    _openCommercialModal(null);
  });

  // "Upload Video Commercial" shortcut — opens modal pre-set to video type
  document.getElementById('ax-comm-upload-video-btn')?.addEventListener('click', () => {
    _openCommercialModal(null, 'video');
  });

  // Filter bar
  document.getElementById('ax-comm-filter-bar')?.querySelectorAll('.ax-comm-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-comm-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _commFilter = btn.dataset.status;
      _renderCommercialLibrary();
    });
  });
}

function _openCommercialModal(commId, forceType = null) {
  _commEditId    = commId;
  _commImageFile = null;
  _commVideoFile = null;
  _commType      = forceType || 'image';

  const modal   = document.getElementById('ax-comm-modal');
  const titleEl = document.getElementById('ax-comm-modal-title');
  const errEl   = document.getElementById('ax-comm-err');
  if (!modal) return;

  if (titleEl) titleEl.textContent = commId ? '✏️ EDIT COMMERCIAL' : '📺 CREATE COMMERCIAL';
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }

  // Reset fields
  const fieldsToReset = ['ax-comm-title','ax-comm-advertiser','ax-comm-notes',
    'ax-comm-biz-name','ax-comm-website','ax-comm-promo-text'];
  fieldsToReset.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const durEl = document.getElementById('ax-comm-duration');
  if (durEl) durEl.value = '30';

  // Reset image preview
  const imgEl        = document.getElementById('ax-comm-img-el');
  const imgPreview   = document.getElementById('ax-comm-img-preview');
  const imgPlaceholder = document.getElementById('ax-comm-img-placeholder');
  if (imgEl) imgEl.src = '';
  if (imgPreview) imgPreview.style.display = 'none';
  if (imgPlaceholder) imgPlaceholder.style.display = '';

  // Reset video info
  const vidInfo = document.getElementById('ax-comm-vid-info');
  const vidPH   = document.getElementById('ax-comm-vid-placeholder');
  const vidProg = document.getElementById('ax-comm-vid-progress');
  if (vidInfo) { vidInfo.style.display = 'none'; vidInfo.textContent = ''; }
  if (vidPH)   vidPH.style.display = '';
  if (vidProg) vidProg.style.display = 'none';

  // Populate music dropdown
  _populateCommMusicDropdown();

  // Set type
  _setCommType(_commType);

  // If editing — populate fields
  if (commId) {
    const comm = _commercialLib.find(c => c.id === commId);
    if (comm) {
      const get = id => document.getElementById(id);
      if (get('ax-comm-title'))    get('ax-comm-title').value    = comm.title    || '';
      if (get('ax-comm-advertiser'))get('ax-comm-advertiser').value = comm.advertiser || '';
      if (get('ax-comm-notes'))    get('ax-comm-notes').value    = comm.notes    || '';
      if (get('ax-comm-biz-name')) get('ax-comm-biz-name').value = comm.biz_name || '';
      if (get('ax-comm-website'))  get('ax-comm-website').value  = comm.website  || '';
      if (get('ax-comm-promo-text'))get('ax-comm-promo-text').value = comm.promo_text || '';
      if (get('ax-comm-duration')) get('ax-comm-duration').value = String(comm.duration_sec || 30);
      if (get('ax-comm-bg-music')) get('ax-comm-bg-music').value = comm.bg_music_id || '';
      _commType = comm.commercial_type || 'image';
      _setCommType(_commType);
      // Show existing image if any
      if (comm.image_url && imgEl && imgPreview && imgPlaceholder) {
        imgEl.src = comm.image_url;
        imgPreview.style.display = '';
        imgPlaceholder.style.display = 'none';
      }
    }
  }

  modal.style.display = 'flex';

  // ── Type toggle buttons ──
  modal.querySelectorAll('.ax-comm-type-btn').forEach(btn => {
    const handler = () => {
      _commType = btn.dataset.type;
      _setCommType(_commType);
    };
    btn.removeEventListener('click', handler);
    btn.addEventListener('click', handler);
  });

  // ── Image drop zone ──
  const imgDrop  = document.getElementById('ax-comm-img-drop');
  const imgInput = document.getElementById('ax-comm-img-input');
  if (imgDrop) {
    const imgClickHandler = () => imgInput?.click();
    imgDrop.removeEventListener('click', imgClickHandler);
    imgDrop.addEventListener('click', imgClickHandler);
    imgDrop.addEventListener('dragover', e => { e.preventDefault(); imgDrop.style.borderColor = 'var(--blue-bright)'; });
    imgDrop.addEventListener('dragleave', () => { imgDrop.style.borderColor = ''; });
    imgDrop.addEventListener('drop', e => {
      e.preventDefault();
      imgDrop.style.borderColor = '';
      const file = e.dataTransfer.files[0];
      if (file) _handleCommImageFile(file);
    });
  }
  if (imgInput) {
    imgInput.onchange = () => {
      const file = imgInput.files[0];
      if (file) _handleCommImageFile(file);
      imgInput.value = '';
    };
  }

  // ── Video drop zone ──
  const vidDrop  = document.getElementById('ax-comm-vid-drop');
  const vidInput = document.getElementById('ax-comm-vid-input');
  if (vidDrop) {
    const vidClickHandler = () => vidInput?.click();
    vidDrop.removeEventListener('click', vidClickHandler);
    vidDrop.addEventListener('click', vidClickHandler);
    vidDrop.addEventListener('dragover', e => { e.preventDefault(); vidDrop.style.borderColor = 'var(--blue-bright)'; });
    vidDrop.addEventListener('dragleave', () => { vidDrop.style.borderColor = ''; });
    vidDrop.addEventListener('drop', e => {
      e.preventDefault();
      vidDrop.style.borderColor = '';
      const file = e.dataTransfer.files[0];
      if (file) _handleCommVideoFile(file);
    });
  }
  if (vidInput) {
    vidInput.onchange = () => {
      const file = vidInput.files[0];
      if (file) _handleCommVideoFile(file);
      vidInput.value = '';
    };
  }

  // ── Cancel ──
  document.getElementById('ax-comm-cancel')?.addEventListener('click', () => {
    modal.style.display = 'none';
    _commImageFile = null;
    _commVideoFile = null;
  }, { once: true });

  // ── Preview ──
  document.getElementById('ax-comm-preview-btn')?.addEventListener('click', () => {
    _previewCommercialModal();
  }, { once: true });

  // ── Save ──
  const saveBtn = document.getElementById('ax-comm-save-btn');
  if (saveBtn) {
    // Remove any previous listener by replacing the element clone
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener('click', () => _saveCommercial(modal, errEl));
  }

  // Close preview modal
  document.getElementById('ax-comm-preview-close')?.addEventListener('click', () => {
    const pm = document.getElementById('ax-comm-preview-modal');
    if (pm) pm.style.display = 'none';
  });
}

function _setCommType(type) {
  const imageFields = document.getElementById('ax-comm-image-fields');
  const videoFields = document.getElementById('ax-comm-video-fields');
  document.querySelectorAll('.ax-comm-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  if (imageFields) imageFields.style.display = type === 'image' ? '' : 'none';
  if (videoFields) videoFields.style.display = type === 'video' ? '' : 'none';
}

function _handleCommImageFile(file) {
  // Accept any image — no content validation
  if (!file.type.startsWith('image/') && !file.type === '') {
    _toast('Please select an image file.', 'err');
    return;
  }
  _commImageFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    const imgEl        = document.getElementById('ax-comm-img-el');
    const imgPreview   = document.getElementById('ax-comm-img-preview');
    const imgPlaceholder = document.getElementById('ax-comm-img-placeholder');
    if (imgEl)        imgEl.src = e.target.result;
    if (imgPreview)   imgPreview.style.display   = '';
    if (imgPlaceholder) imgPlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function _handleCommVideoFile(file) {
  // Accept any video file — no content validation
  _commVideoFile = file;
  const vidInfo = document.getElementById('ax-comm-vid-info');
  const vidPH   = document.getElementById('ax-comm-vid-placeholder');
  if (vidInfo) {
    vidInfo.textContent = `✓ ${file.name} (${_fmtSize(file.size)})`;
    vidInfo.style.display = '';
    vidInfo.style.color = 'var(--green)';
  }
  if (vidPH) vidPH.style.display = 'none';
  // Auto-fill title if empty
  const titleEl = document.getElementById('ax-comm-title');
  if (titleEl && !titleEl.value.trim()) {
    titleEl.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g,' ');
  }
}

function _populateCommMusicDropdown() {
  const sel = document.getElementById('ax-comm-bg-music');
  if (!sel) return;
  const currentVal = sel.value;
  const musicItems = _mediaLib.filter(m =>
    m.status === 'approved' && ['audio','music','audio_program'].includes(m.type)
  );
  sel.innerHTML = '<option value="">— No background music —</option>' +
    musicItems.map(m => `<option value="${m.id}">${_esc(m.title)}${m.artist ? ' — ' + _esc(m.artist) : ''}</option>`).join('');
  if (currentVal) sel.value = currentVal;
}

function _previewCommercialModal() {
  const previewModal = document.getElementById('ax-comm-preview-modal');
  const previewContent = document.getElementById('ax-comm-preview-content');
  if (!previewModal || !previewContent) return;

  const title     = document.getElementById('ax-comm-title')?.value || '(untitled)';
  const bizName   = document.getElementById('ax-comm-biz-name')?.value || '';
  const promoText = document.getElementById('ax-comm-promo-text')?.value || '';
  const website   = document.getElementById('ax-comm-website')?.value || '';
  const duration  = document.getElementById('ax-comm-duration')?.value || '30';
  const imgEl     = document.getElementById('ax-comm-img-el');
  const hasMusicId = document.getElementById('ax-comm-bg-music')?.value;
  const musicTitle = hasMusicId
    ? _mediaLib.find(m => m.id === hasMusicId)?.title || 'Selected track'
    : null;

  let previewHtml = `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--text-dim);margin-bottom:12px;">📺 COMMERCIAL PREVIEW (${duration}s)</div>`;

  if (_commType === 'image' && imgEl?.src && imgEl.src !== window.location.href) {
    previewHtml += `<div style="position:relative;background:#000;border-radius:8px;overflow:hidden;margin-bottom:12px;min-height:120px;display:flex;align-items:center;justify-content:center;">
      <img src="${_esc(imgEl.src)}" style="max-width:100%;max-height:240px;object-fit:contain;" alt="${_esc(title)}">
      ${bizName ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.75);padding:8px 12px;text-align:center;">
        <div style="font-size:14px;font-weight:900;color:#fff;letter-spacing:1px;">${_esc(bizName)}</div>
        ${promoText ? `<div style="font-size:11px;color:#ccc;margin-top:2px;">${_esc(promoText)}</div>` : ''}
        ${website ? `<div style="font-size:10px;color:#4d7aff;margin-top:2px;">${_esc(website)}</div>` : ''}
      </div>` : ''}
    </div>`;
  } else if (_commType === 'video' && _commVideoFile) {
    previewHtml += `<div style="margin-bottom:12px;padding:12px;background:var(--surface-hi);border-radius:6px;">
      🎬 Video: <strong>${_esc(_commVideoFile.name)}</strong> (${_fmtSize(_commVideoFile.size)})
    </div>`;
  }

  if (title)     previewHtml += `<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px;">${_esc(title)}</div>`;
  if (musicTitle) previewHtml += `<div style="font-size:11px;color:var(--text-dim);">🎵 Background music: ${_esc(musicTitle)}</div>`;
  if (!_commImageFile && !_commVideoFile && _commType === 'image') {
    previewHtml += `<div style="color:var(--orange,#f0a500);font-size:11px;margin-top:8px;">⚠ No image selected yet — upload an image to see the full preview.</div>`;
  }

  previewContent.innerHTML = previewHtml;
  previewModal.style.display = 'flex';
}

async function _saveCommercial(modal, errEl) {
  // ── VALIDATION ──────────────────────────────────────────────────────────
  // Only validate technically required fields.
  // NEVER reject based on visual content (faces, people, logos, cats, etc.)
  const title = document.getElementById('ax-comm-title')?.value.trim();
  if (!title) {
    if (errEl) { errEl.textContent = 'Commercial name / title is required.'; errEl.classList.add('visible'); }
    return;
  }

  if (_commType === 'image' && !_commImageFile && !_commEditId) {
    if (errEl) { errEl.textContent = 'Please select an image for the image-based commercial.'; errEl.classList.add('visible'); }
    return;
  }
  if (_commType === 'video' && !_commVideoFile && !_commEditId) {
    if (errEl) { errEl.textContent = 'Please select a video file for the video commercial.'; errEl.classList.add('visible'); }
    return;
  }

  const saveBtn = document.getElementById('ax-comm-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }

  try {
    // ── Build commercial record ─────────────────────────────────────────
    const data = {
      title,
      advertiser:    document.getElementById('ax-comm-advertiser')?.value.trim() || '',
      notes:         document.getElementById('ax-comm-notes')?.value.trim() || '',
      biz_name:      document.getElementById('ax-comm-biz-name')?.value.trim() || '',
      website:       document.getElementById('ax-comm-website')?.value.trim() || '',
      promo_text:    document.getElementById('ax-comm-promo-text')?.value.trim() || '',
      bg_music_id:   document.getElementById('ax-comm-bg-music')?.value || '',
      duration_sec:  parseInt(document.getElementById('ax-comm-duration')?.value || '30'),
      commercial_type: _commType,
      status:        _commEditId
        ? (_commercialLib.find(c => c.id === _commEditId)?.status || 'draft')
        : 'draft',
      updated_at:    serverTimestamp(),
    };

    // ── Image upload (if new image selected) ───────────────────────────
    if (_commType === 'image' && _commImageFile) {
      if (!auth.currentUser) throw new Error('Please log in.');
      const idToken = await auth.currentUser.getIdToken(true);
      const authRes = await fetch(UPLOAD_WORKER_URL + '/authorize', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: _commImageFile.name, contentType: _commImageFile.type || 'image/jpeg', size: _commImageFile.size }),
      });
      const authData = await authRes.json();
      if (!authRes.ok || !authData.ok) throw new Error(authData.error || 'Image upload authorization failed');
      // Upload image via signed URL
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', authData.signedUrl, true);
        xhr.setRequestHeader('Content-Type', _commImageFile.type || 'image/jpeg');
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Image upload failed HTTP ' + xhr.status));
        xhr.onerror = () => reject(new Error('Image upload network error'));
        xhr.send(_commImageFile);
      });
      data.image_url    = authData.publicUrl;
      data.storage_path = authData.storagePath;
    }

    // ── Video upload (if new video selected) ────────────────────────────
    if (_commType === 'video' && _commVideoFile) {
      const vidProgress = document.getElementById('ax-comm-vid-progress');
      const vidBar      = document.getElementById('ax-comm-vid-bar');
      const vidStatus   = document.getElementById('ax-comm-vid-status');
      if (vidProgress) vidProgress.style.display = '';
      if (vidStatus)   vidStatus.textContent = 'Authorizing upload…';

      if (!auth.currentUser) throw new Error('Please log in.');
      const idToken = await auth.currentUser.getIdToken(true);
      const authRes = await fetch(UPLOAD_WORKER_URL + '/authorize', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: _commVideoFile.name, contentType: _commVideoFile.type || 'video/mp4', size: _commVideoFile.size }),
      });
      const authData = await authRes.json();
      if (!authRes.ok || !authData.ok) throw new Error(authData.error || 'Video upload authorization failed');
      if (vidStatus) vidStatus.textContent = 'Uploading video…';
      // Upload via signed URL with progress
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', authData.signedUrl, true);
        xhr.setRequestHeader('Content-Type', _commVideoFile.type || 'video/mp4');
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && vidBar) {
            vidBar.style.width = Math.min(99, Math.round(e.loaded / e.total * 100)) + '%';
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { if (vidBar) vidBar.style.width = '100%'; resolve(); }
          else reject(new Error('Video upload failed HTTP ' + xhr.status + ': ' + xhr.responseText.slice(0,200)));
        };
        xhr.onerror = () => reject(new Error('Video upload network error'));
        xhr.send(_commVideoFile);
      });
      if (vidStatus) vidStatus.textContent = '✓ Video uploaded';
      data.video_url    = authData.publicUrl;
      data.storage_path = authData.storagePath;
      // Get duration
      try {
        const dur = await _getMediaDuration(_commVideoFile);
        if (dur > 0) data.duration_sec = dur;
      } catch (_) {}
    }

    // ── Save to Firestore ───────────────────────────────────────────────
    if (_commEditId) {
      await updateDoc(doc(db, 'network_commercials', _commEditId), data);
      _toast(`Commercial updated: ${title}`);
    } else {
      data.created_at = serverTimestamp();
      data.created_by = _user?.email || '';
      const docRef = await addDoc(collection(db, 'network_commercials'), data);
      _toast(`✓ Commercial saved: ${title}`);
      // Also add to media library as type=commercial for the programming engine
      await addDoc(collection(db, 'network_media'), {
        title,
        artist:        data.advertiser || '',
        creator:       _user?.email || '',
        description:   data.notes || '',
        type:          'commercial',
        category:      'commercial',
        url:           data.video_url || data.image_url || '',
        storage_path:  data.storage_path || '',
        duration_sec:  data.duration_sec || 30,
        size_bytes:    (_commVideoFile?.size || _commImageFile?.size || 0),
        mime_type:     (_commVideoFile?.type || _commImageFile?.type || ''),
        status:        'approved',            // Founder-created commercials auto-approved
        channel:       LIVE_TV_CHANNEL_ID,
        live_tv_assigned: true,
        commercial_id: docRef.id,
        tags:          ['commercial'],
        year:          new Date().getFullYear(),
        uploaded_by:   _user?.uid || '',
        uploaded_at:   serverTimestamp(),
      });
    }

    modal.style.display = 'none';
    _commImageFile = null;
    _commVideoFile = null;

  } catch (e) {
    console.error('[AURENIX] Commercial save error:', e);
    if (errEl) { errEl.textContent = 'Save failed: ' + e.message; errEl.classList.add('visible'); }
    _toast('Commercial save failed: ' + e.message, 'err');
  }

  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 SAVE COMMERCIAL'; }
}

/* ═══════════════════════════════════════
   COMMERCIAL LIBRARY RENDERER
═══════════════════════════════════════ */

function _renderCommercialLibrary() {
  const grid = document.getElementById('ax-comm-library-grid');
  if (!grid) return;

  const items = _commFilter === 'all'
    ? _commercialLib
    : _commercialLib.filter(c => c.status === _commFilter);

  if (!items.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--text-dim);">
        <div style="font-size:36px;margin-bottom:12px;">📺</div>
        <div style="font-size:14px;font-weight:700;margin-bottom:6px;">No Commercials Yet</div>
        <div style="font-size:12px;margin-bottom:16px;">Create your first commercial using the button above.</div>
        <button class="ax-btn-primary" onclick="window._AXC.switchToPane('commercial-studio');document.getElementById('ax-comm-create-btn')?.click();" style="font-size:12px;padding:8px 20px;">+ CREATE COMMERCIAL</button>
      </div>`;
    return;
  }

  const statusColors = { active:'var(--green)', inactive:'var(--text-dim)', draft:'var(--orange,#f0a500)' };
  const statusLabels = { active:'✓ ACTIVE', inactive:'⏸ INACTIVE', draft:'✏ DRAFT' };

  grid.innerHTML = items.map(c => {
    const thumb = c.image_url
      ? `<img src="${_esc(c.image_url)}" style="width:100%;height:140px;object-fit:cover;border-radius:6px 6px 0 0;" loading="lazy">`
      : `<div style="width:100%;height:80px;display:flex;align-items:center;justify-content:center;font-size:36px;background:var(--surface-hi);border-radius:6px 6px 0 0;">📺</div>`;
    const statusColor = statusColors[c.status] || 'var(--text-dim)';
    const statusLabel = statusLabels[c.status] || c.status?.toUpperCase() || 'DRAFT';
    const dur = c.duration_sec ? `${c.duration_sec}s` : '—';
    const created = c.created_at ? _relDate(c.created_at) : '—';

    return `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;">
        ${thumb}
        <div style="padding:12px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
            <div style="font-size:13px;font-weight:700;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(c.title)}</div>
            <span style="font-size:9px;font-weight:700;letter-spacing:1px;color:${statusColor};white-space:nowrap;">${statusLabel}</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">
            ${c.advertiser ? _esc(c.advertiser) + ' · ' : ''}${_esc(c.commercial_type || 'image')} · ${dur} · ${created}
          </div>
          ${c.biz_name ? `<div style="font-size:11px;color:var(--text-dim);">🏢 ${_esc(c.biz_name)}</div>` : ''}
          ${c.website  ? `<div style="font-size:10px;color:var(--blue-bright);">${_esc(c.website)}</div>` : ''}
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="ax-btn-sm" onclick="window._AXC.previewCommercial('${c.id}')">👁 Preview</button>
            <button class="ax-btn-sm" onclick="window._AXC.editCommercial('${c.id}')">✏ Edit</button>
            ${c.status !== 'active'
              ? `<button class="ax-btn-sm" style="background:var(--green);color:#000;font-weight:700;" onclick="window._AXC.activateCommercial('${c.id}')">✓ ACTIVATE</button>`
              : `<button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.deactivateCommercial('${c.id}')">⏸ Deactivate</button>`}
            <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.deleteCommercial('${c.id}')">🗑 Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function _showCommercialPreview(comm) {
  const previewModal   = document.getElementById('ax-comm-preview-modal');
  const previewContent = document.getElementById('ax-comm-preview-content');
  if (!previewModal || !previewContent) return;

  let html = `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:var(--text-dim);margin-bottom:12px;">📺 ${_esc(comm.title)} (${comm.duration_sec || '—'}s)</div>`;

  if (comm.image_url) {
    html += `<div style="position:relative;background:#000;border-radius:8px;overflow:hidden;margin-bottom:12px;">
      <img src="${_esc(comm.image_url)}" style="width:100%;max-height:260px;object-fit:contain;" alt="${_esc(comm.title)}">
      ${comm.biz_name ? `<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.8);padding:10px 14px;text-align:center;">
        <div style="font-size:15px;font-weight:900;color:#fff;">${_esc(comm.biz_name)}</div>
        ${comm.promo_text ? `<div style="font-size:11px;color:#ccc;margin-top:2px;">${_esc(comm.promo_text)}</div>` : ''}
        ${comm.website ? `<div style="font-size:10px;color:#4d7aff;margin-top:2px;">${_esc(comm.website)}</div>` : ''}
      </div>` : ''}
    </div>`;
  } else if (comm.video_url) {
    html += `<video src="${_esc(comm.video_url)}" controls style="width:100%;max-height:260px;border-radius:8px;background:#000;" preload="metadata"></video>`;
  }

  if (comm.bg_music_id) {
    const track = _mediaLib.find(m => m.id === comm.bg_music_id);
    if (track) html += `<div style="font-size:11px;color:var(--text-dim);margin-top:8px;">🎵 Background music: ${_esc(track.title)}</div>`;
  }

  const statusLabel = { active:'✓ ACTIVE', inactive:'⏸ INACTIVE', draft:'✏ DRAFT' }[comm.status] || (comm.status || 'DRAFT').toUpperCase();
  html += `<div style="margin-top:10px;font-size:11px;font-weight:700;letter-spacing:1px;">Status: ${statusLabel}</div>`;

  previewContent.innerHTML = html;
  previewModal.style.display = 'flex';
}

/* ═══════════════════════════════════════════════════════════
   GOOGLE DRIVE — STORAGE PANE
   ══════════════════════════════════════════════════════════
   All OAuth is handled server-side by the Cloudflare Worker.
   The Founder's Google password never passes through AURENIX.
   Client secret and refresh tokens never reach browser JS.
═══════════════════════════════════════════════════════════ */

/**
 * Fetch Drive status from the Worker (requires Firebase Founder token).
 * Populates _gdriveStatus and re-renders the Storage pane.
 */
async function _gdriveLoadStatus() {
  if (!auth.currentUser) return;
  try {
    const idToken = await auth.currentUser.getIdToken(true);
    const res = await fetch(UPLOAD_WORKER_URL + '/gdrive/status', {
      headers: { 'Authorization': 'Bearer ' + idToken },
    });
    const data = await res.json();
    _gdriveStatus = data;
    _renderGdriveStatus();
    // Also update the Drive upload panel connection state
    _updateGdriveUploadPanelState();
  } catch (e) {
    console.warn('[AURENIX] Drive status check failed:', e.message);
    _gdriveStatus = { connected: false, error: e.message };
    _renderGdriveStatus();
  }
}

/** Render the storage pane Drive status UI from _gdriveStatus. */
function _renderGdriveStatus() {
  const s = _gdriveStatus;
  if (!s) return;

  // Status badge
  const badge      = document.getElementById('ax-gdrive-status-badge');
  const notConn    = document.getElementById('ax-gdrive-not-connected');
  const connDiv    = document.getElementById('ax-gdrive-connected');
  const statusText = document.getElementById('ax-storage-gdrive-status-text');
  const acctLine   = document.getElementById('ax-storage-gdrive-account-line');

  if (s.connected) {
    if (badge) { badge.textContent = '🟢 CONNECTED'; badge.style.background = 'rgba(0,200,80,0.15)'; badge.style.color = 'var(--green)'; }
    if (notConn) notConn.style.display = 'none';
    if (connDiv)  connDiv.style.display = '';
    if (statusText) { statusText.textContent = '🟢 Connected'; statusText.style.color = 'var(--green)'; }
    if (acctLine)   acctLine.textContent = s.account_email || '';

    // Account info
    const nameEl  = document.getElementById('ax-gdrive-account-name');
    const emailEl = document.getElementById('ax-gdrive-account-email');
    if (nameEl)  nameEl.textContent  = s.account_name  || s.account_email || '—';
    if (emailEl) emailEl.textContent = s.account_email || '—';

    // Folder info
    const folderNameEl = document.getElementById('ax-gdrive-folder-name');
    const openDriveBtn = document.getElementById('ax-gdrive-open-drive-btn');
    if (s.folder) {
      if (folderNameEl) folderNameEl.textContent = s.folder.name || 'AURENIX';
      if (openDriveBtn && s.folder.webViewLink) openDriveBtn.href = s.folder.webViewLink;
      // Render subfolders
      const sfDiv = document.getElementById('ax-gdrive-subfolders');
      if (sfDiv && s.folder.subFolders) {
        const subs = Object.values(s.folder.subFolders);
        sfDiv.innerHTML = subs.length
          ? subs.map(sf => `
              <a href="${_esc(sf.webViewLink || '#')}" target="_blank" rel="noopener"
                 style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;background:var(--panel);border:1px solid var(--border);border-radius:5px;font-size:11px;font-weight:600;color:var(--text);text-decoration:none;">
                📁 ${_esc(sf.name)}
              </a>`).join('')
          : '<div style="font-size:11px;color:var(--text-dim);">No subfolders yet — click CHANGE FOLDER to create them.</div>';
      } else if (sfDiv) {
        sfDiv.innerHTML = '<button class="ax-btn-sm" id="ax-gdrive-create-subfolders-btn" style="font-size:11px;">📁 Create AURENIX Subfolders</button>';
        document.getElementById('ax-gdrive-create-subfolders-btn')?.addEventListener('click', () => _gdriveSetFolder(null, 'AURENIX'));
      }
    } else {
      if (folderNameEl) folderNameEl.textContent = 'Not set';
      // Auto-prompt to set up folder
      const sfDiv = document.getElementById('ax-gdrive-subfolders');
      if (sfDiv) sfDiv.innerHTML = `
        <div style="font-size:12px;color:var(--orange,#f0a500);">⚠ No AURENIX folder set yet.</div>
        <button class="ax-btn-sm" id="ax-gdrive-auto-folder-btn" style="margin-top:6px;font-size:11px;background:rgba(30,80,255,0.2);">
          📁 CREATE AURENIX FOLDER + SUBFOLDERS
        </button>`;
      document.getElementById('ax-gdrive-auto-folder-btn')?.addEventListener('click', () => _gdriveSetFolder(null, 'AURENIX'));
    }
  } else {
    if (badge)      { badge.textContent = 'NOT CONNECTED'; badge.style.background = ''; badge.style.color = 'var(--text-dim)'; }
    if (notConn)    notConn.style.display = '';
    if (connDiv)    connDiv.style.display = 'none';
    if (statusText) { statusText.textContent = 'Not Connected'; statusText.style.color = 'var(--text-dim)'; }
    if (acctLine)   acctLine.textContent = '';

    // If config is not ready, show setup hint
    if (!s.config_ready) {
      const errDiv = document.getElementById('ax-gdrive-connect-err');
      if (errDiv) {
        errDiv.style.display = '';
        errDiv.textContent = '⚙ Worker configuration required. ' + (s.config_error || '') + ' See SETUP INSTRUCTIONS below.';
      }
    }
  }
}

/** Bind all buttons on the Storage pane. */
function _bindStoragePane() {
  // Load status when pane is opened
  document.querySelector('[data-pane="storage"]')?.addEventListener('click', () => {
    _gdriveLoadStatus();
    // Load config check to show redirect URI in setup instructions
    fetch(UPLOAD_WORKER_URL + '/gdrive/config-check')
      .then(r => r.json())
      .then(d => {
        const uriEl = document.getElementById('ax-gdrive-setup-redirect-uri');
        if (uriEl && d.redirect_uri) uriEl.textContent = d.redirect_uri;
        else if (uriEl) uriEl.textContent = UPLOAD_WORKER_URL + '/gdrive/callback';
      }).catch(() => {});
  });

  // Setup instructions toggle
  document.getElementById('ax-gdrive-setup-toggle')?.addEventListener('click', () => {
    const p = document.getElementById('ax-gdrive-setup-panel');
    if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
  });

  // CONNECT GOOGLE DRIVE button — opens OAuth popup
  document.getElementById('ax-gdrive-connect-btn')?.addEventListener('click', _gdriveStartOAuth);

  // DISCONNECT button
  document.getElementById('ax-gdrive-disconnect-btn')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Google Drive?\n\nThis removes AURENIX\'s authorization. No Drive files will be deleted.')) return;
    await _gdriveDisconnect();
  });

  // CHANGE FOLDER button
  document.getElementById('ax-gdrive-change-folder-btn')?.addEventListener('click', async () => {
    const wrap = document.getElementById('ax-gdrive-folder-list-wrap');
    if (!wrap) return;
    wrap.style.display = '';
    // Load folders from Drive
    if (!auth.currentUser) return;
    const idToken = await auth.currentUser.getIdToken(true);
    const res = await fetch(UPLOAD_WORKER_URL + '/gdrive/folders', {
      headers: { 'Authorization': 'Bearer ' + idToken },
    });
    if (!res.ok) { _toast('Could not list Drive folders.', 'err'); return; }
    const data = await res.json();
    const sel = document.getElementById('ax-gdrive-folder-select');
    if (sel) {
      const current = data.current_folder;
      sel.innerHTML = `<option value="">— create a new folder —</option>` +
        (data.folders || []).map(f =>
          `<option value="${_esc(f.id)}" ${current?.id === f.id ? 'selected' : ''}>${_esc(f.name)}</option>`
        ).join('');
    }
  });

  // Use existing folder button
  document.getElementById('ax-gdrive-folder-use-existing')?.addEventListener('click', async () => {
    const sel = document.getElementById('ax-gdrive-folder-select');
    const folderId = sel?.value;
    if (!folderId) { _toast('Select a folder first, or create a new one.', 'err'); return; }
    await _gdriveSetFolder(folderId, null);
  });

  // Create new folder button
  document.getElementById('ax-gdrive-folder-create-new')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('ax-gdrive-new-folder-name');
    const name = (nameEl?.value || 'AURENIX').trim() || 'AURENIX';
    await _gdriveSetFolder(null, name);
  });
}

/** Start Google OAuth flow — opens a popup window to Google's auth page. */
async function _gdriveStartOAuth() {
  const btn    = document.getElementById('ax-gdrive-connect-btn');
  const errDiv = document.getElementById('ax-gdrive-connect-err');
  if (errDiv) errDiv.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Opening Google…'; }

  try {
    if (!auth.currentUser) throw new Error('Please sign in to AURENIX first.');
    const idToken = await auth.currentUser.getIdToken(true);

    const res = await fetch(UPLOAD_WORKER_URL + '/gdrive/auth', {
      headers: { 'Authorization': 'Bearer ' + idToken },
    });
    const data = await res.json();

    if (!res.ok || !data.authUrl) {
      throw new Error(data.error || 'Could not get Google authorization URL. ' + (data.config_error ? 'Config: ' + data.config_error : ''));
    }

    // Open OAuth popup
    const popup = window.open(
      data.authUrl,
      'aurenix_gdrive_oauth',
      'width=520,height=680,scrollbars=yes,resizable=yes,toolbar=no,location=yes'
    );

    if (!popup) {
      // Popup blocked — fall back to redirect
      if (errDiv) {
        errDiv.style.display = '';
        errDiv.textContent = '⚠ Popup blocked — click the button again or allow popups for this site.';
      }
      if (btn) { btn.disabled = false; btn.textContent = '🔵 CONNECT GOOGLE DRIVE'; }
      return;
    }

    // Listen for postMessage from the callback page
    const messageHandler = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== 'gdrive_oauth') return;
      window.removeEventListener('message', messageHandler);
      clearInterval(pollTimer);

      if (e.data.ok) {
        _toast('🟢 Google Drive connected!');
        _gdriveLoadStatus();
        _updateGdriveUploadPanelState();
      } else {
        const errMsg = _gdriveHumanError(e.data.msg || 'Authorization failed');
        if (errDiv) { errDiv.style.display = ''; errDiv.innerHTML = '⚠ ' + _esc(errMsg) + '<br><button class="ax-btn-sm" style="margin-top:6px;" onclick="this.closest(\'#ax-gdrive-connect-err\').style.display=\'none\'">Dismiss</button>'; }
        _toast('Drive connection failed: ' + errMsg, 'err');
      }
      if (btn) { btn.disabled = false; btn.textContent = '🔵 CONNECT GOOGLE DRIVE'; }
    };
    window.addEventListener('message', messageHandler);

    // Fallback poll in case postMessage doesn't fire (popup closed without OAuth)
    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        window.removeEventListener('message', messageHandler);
        // Check if we connected (popup may have closed after posting the message)
        _gdriveLoadStatus();
        if (btn) { btn.disabled = false; btn.textContent = '🔵 CONNECT GOOGLE DRIVE'; }
      }
    }, 800);

  } catch (e) {
    const errMsg = _gdriveHumanError(e.message);
    if (errDiv) {
      errDiv.style.display = '';
      errDiv.textContent = '⚠ ' + errMsg;
    }
    _toast('Drive connect failed: ' + errMsg, 'err');
    if (btn) { btn.disabled = false; btn.textContent = '🔵 CONNECT GOOGLE DRIVE'; }
  }
}

/** Disconnect Google Drive — revokes tokens, does NOT delete any Drive files. */
async function _gdriveDisconnect() {
  const btn = document.getElementById('ax-gdrive-disconnect-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Disconnecting…'; }
  try {
    const idToken = await auth.currentUser?.getIdToken(true);
    const res = await fetch(UPLOAD_WORKER_URL + '/gdrive/disconnect', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Disconnect failed');
    _gdriveStatus = { connected: false };
    _renderGdriveStatus();
    _updateGdriveUploadPanelState();
    _toast('Google Drive disconnected. Your Drive files are untouched.');
  } catch (e) {
    _toast('Disconnect failed: ' + e.message, 'err');
  }
  if (btn) { btn.disabled = false; btn.textContent = '✕ DISCONNECT GOOGLE DRIVE'; }
}

/** Set or create the AURENIX folder in Drive and create standard subfolders. */
async function _gdriveSetFolder(folderId, folderName) {
  const statusEl = document.getElementById('ax-gdrive-folder-status');
  if (statusEl) statusEl.textContent = 'Setting up folder…';
  try {
    const idToken = await auth.currentUser?.getIdToken(true);
    const body = {};
    if (folderId)   body.folderId   = folderId;
    if (folderName) body.folderName = folderName;
    const res = await fetch(UPLOAD_WORKER_URL + '/gdrive/folder-set', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Folder setup failed');
    // Hide folder list
    const wrap = document.getElementById('ax-gdrive-folder-list-wrap');
    if (wrap) wrap.style.display = 'none';
    if (statusEl) statusEl.textContent = '✓ AURENIX folder set: ' + (data.folder?.name || 'AURENIX');
    _gdriveStatus.folder = data.folder;
    _renderGdriveStatus();
    _toast('✓ AURENIX Drive folder configured: ' + (data.folder?.name || 'AURENIX'));
  } catch (e) {
    if (statusEl) statusEl.textContent = '✗ Folder setup failed: ' + e.message;
    _toast('Folder setup failed: ' + e.message, 'err');
  }
}

/**
 * Map raw Google/Worker error messages to human-friendly descriptions.
 */
function _gdriveHumanError(raw) {
  const r = raw || '';
  if (r.includes('access_denied') || r.includes('cancelled'))
    return 'Google authorization cancelled by user.';
  if (r.includes('GDRIVE_CONFIG_MISSING') || r.includes('not set') || r.includes('not bound'))
    return 'Google Drive API not configured in AURENIX Worker. See SETUP INSTRUCTIONS.';
  if (r.includes('redirect_uri_mismatch'))
    return 'OAuth redirect URI mismatch. Check Google Cloud → Credentials → authorized redirect URIs.';
  if (r.includes('invalid_client') || r.includes('GOOGLE_CLIENT'))
    return 'Invalid OAuth credentials. Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET worker secrets.';
  if (r.includes('Token refresh failed') || r.includes('token_expired') || r.includes('invalid_grant'))
    return 'Google authorization expired or revoked. Please reconnect Google Drive.';
  if (r.includes('Drive API error'))
    return 'Google Drive API error: ' + r;
  if (r.includes('FIREBASE TOKEN'))
    return 'AURENIX session expired. Please refresh the page.';
  if (r.includes('FOUNDER NOT AUTHORIZED'))
    return 'Founder access required to manage Google Drive.';
  if (r.includes('GDRIVE_KV'))
    return 'KV namespace not configured. Run: npx wrangler kv namespace create GDRIVE_KV';
  if (r.includes('Google Drive not connected'))
    return 'Google Drive not connected. Go to Storage → Google Drive to connect.';
  if (r.includes('insufficient'))
    return 'Insufficient Google Drive permissions. Reconnect and grant all requested scopes.';
  if (r.includes('network error') || r.includes('could not connect') || r.includes('temporary connection'))
    return 'Google Drive upload could not connect. Retrying may resolve a temporary connection problem.';
  if (r.includes('unavailable') || r.includes('503') || r.includes('502'))
    return 'Google Drive unavailable. Try again in a moment.';
  return r;
}

/* ═══════════════════════════════════════════════════════════
   GOOGLE DRIVE — UPLOAD CENTER TAB
   Direct-to-Drive resumable upload (large video files).
   Files go browser → Google Drive.
   The Worker handles only the authorization roundtrip.
═══════════════════════════════════════════════════════════ */

/** Update the Google Drive upload panel's connected/not-connected state. */
function _updateGdriveUploadPanelState() {
  const nc = document.getElementById('ax-gdrive-upload-not-connected');
  const co = document.getElementById('ax-gdrive-upload-connected');
  const connected = _gdriveStatus?.connected;
  if (nc) nc.style.display = connected ? 'none' : '';
  if (co) co.style.display = connected ? '' : 'none';
}

/** Bind the Upload Center → Google Drive tab. */
function _bindGdriveUploadPane() {
  // Upload destination tab switcher
  document.getElementById('ax-upload-dest-tabs')?.querySelectorAll('.ax-upload-dest-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-upload-dest-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const dest = btn.dataset.dest;
      const supPanel  = document.getElementById('ax-upload-supabase-panel');
      const drivePanel = document.getElementById('ax-upload-gdrive-panel');
      if (supPanel)   supPanel.style.display   = dest === 'supabase' ? '' : 'none';
      if (drivePanel) drivePanel.style.display = dest === 'gdrive'   ? '' : 'none';
      // Check Drive status whenever switching to the Drive tab
      if (dest === 'gdrive') {
        _gdriveLoadStatus();
      }
    });
  });

  // Google Drive category buttons
  document.querySelectorAll('.ax-gdrive-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-gdrive-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _gdriveUploadCategory = btn.dataset.cat;
      const fi = document.getElementById('ax-gdrive-file-input');
      if (fi) fi.accept = btn.dataset.accept;
    });
  });

  // Drop zone
  const zone = document.getElementById('ax-gdrive-upload-zone');
  const inp  = document.getElementById('ax-gdrive-file-input');
  if (zone && inp) {
    zone.addEventListener('click', e => {
      if (!e.target.closest('.ax-gdrive-cat-btn') && !e.target.closest('select')) inp.click();
    });
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) _gdriveUploadFile(f);
    });
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      if (f) _gdriveUploadFile(f);
      inp.value = '';
    });
  }
}

/**
 * Upload a file to Google Drive using the resumable upload API.
 *
 * Phase 1 — POST /gdrive/upload-init (tiny JSON — no file body)
 *   Worker verifies Firebase token, checks Founder email,
 *   gets a Drive resumable upload URI, returns it.
 *
 * Phase 2 — PUT directly to Drive upload URI (XHR with progress)
 *   The entire file goes browser → Google Drive.
 *   No proxying through the Worker.
 *
 * Phase 3 — POST /gdrive/upload-finalize { driveFileId }
 *   Worker fetches Drive file metadata and returns it.
 *
 * Phase 4 — Save to Firestore network_media
 *   Status: pending_approval.
 */
async function _gdriveUploadFile(file) {
  if (!_gdriveStatus?.connected) {
    _toast('Connect Google Drive first (Storage → Google Drive).', 'err');
    return;
  }

  const isVideo  = file.type.startsWith('video/');
  const isAudio  = file.type.startsWith('audio/');
  const cat = MEDIA_CATEGORIES.find(c => c.id === _gdriveUploadCategory) || MEDIA_CATEGORIES.find(c => c.id === 'video');
  const mediaType = cat?.type || (isVideo ? 'video' : isAudio ? 'audio' : 'thumbnail');
  const subFolder = document.getElementById('ax-gdrive-subfolder')?.value || '';

  // Show progress area
  const progressDiv  = document.getElementById('ax-gdrive-upload-progress');
  const resultDiv    = document.getElementById('ax-gdrive-upload-result');
  const filenameEl   = document.getElementById('ax-gdrive-upload-filename');
  const filesizeEl   = document.getElementById('ax-gdrive-upload-filesize');
  const pctEl        = document.getElementById('ax-gdrive-upload-pct');
  const barEl        = document.getElementById('ax-gdrive-upload-bar');
  const statusEl     = document.getElementById('ax-gdrive-upload-status');
  const bytesEl      = document.getElementById('ax-gdrive-upload-bytes');

  const setStatus = (msg, color = '') => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color; } };
  const setProgress = (loaded, total) => {
    const rawPct = total > 0 ? Math.round(loaded / total * 100) : 0;
    const pct = loaded < total ? Math.min(99, rawPct) : rawPct;
    if (barEl)   barEl.style.width    = pct + '%';
    if (pctEl)   pctEl.textContent    = pct + '%';
    if (bytesEl && total > 0) bytesEl.textContent = `${_fmtSize(loaded)} / ${_fmtSize(total)}`;
  };

  if (progressDiv)  progressDiv.style.display = '';
  if (resultDiv)    resultDiv.style.display = 'none';
  if (filenameEl)   filenameEl.textContent = file.name;
  if (filesizeEl)   filesizeEl.textContent = _fmtSize(file.size);
  setProgress(0, file.size);
  setStatus('Authenticating…', 'var(--blue-bright)');

  let driveFileId = null;

  // ARCHITECTURE NOTE (v10):
  // The browser CANNOT PUT directly to googleapis.com/upload/ — Google's
  // resumable upload endpoint has no CORS headers, so a direct XHR always
  // fires onerror ("network error") before any bytes are sent.
  //
  // Fix: the Worker owns the Google connection.
  //   1. Browser → POST /gdrive/upload-init → Worker returns upload_id
  //   2. Browser reads File in chunks and POST each chunk to
  //      /gdrive/upload-chunk (Worker proxies chunk→Google with Content-Range)
  //   3. Final chunk response contains the Drive file metadata (id, name, etc.)
  //
  // Chunk size: 5 MiB (Google minimum recommended = 256 KiB, must be multiple
  // of 256 KiB; 5 MiB balances progress granularity vs. round-trip overhead).
  // For files ≤ 5 MiB (e.g. the 1.5 MB test file), a single chunk is sent.
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB

  try {
    // ── Pre-flight: get media duration ───────────────────────────────────
    let duration_sec = 0;
    if (isAudio || isVideo) {
      try { duration_sec = await _getMediaDuration(file); } catch (_) {}
    }

    // ── Phase 1: Initialize resumable session via Worker ─────────────────
    // Worker creates the Drive resumable session and returns an upload_id.
    // The raw Google upload URI never leaves the Worker.
    if (!auth.currentUser) throw new Error('FIREBASE SESSION NOT FOUND — please sign in again');
    let idToken = await auth.currentUser.getIdToken(true);

    setStatus('Authorizing with Worker…', 'var(--blue-bright)');
    console.log('[AURENIX gdrive] POST /gdrive/upload-init — fileName:', file.name, 'size:', file.size, 'type:', file.type);

    const initRes = await fetch(UPLOAD_WORKER_URL + '/gdrive/upload-init', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName:    file.name,
        contentType: file.type || 'application/octet-stream',
        size:        file.size,
        subFolder:   subFolder || undefined,
      }),
    });
    const initData = await initRes.json();

    console.log('[AURENIX gdrive] /gdrive/upload-init HTTP', initRes.status, '— ok:', initData.ok, 'uploadId present:', !!initData.uploadId);

    if (!initRes.ok || !initData.uploadId) {
      const errMsg = _gdriveHumanError(initData.error || `Worker authorization failed — HTTP ${initRes.status}`);
      throw new Error(errMsg);
    }

    const { uploadId } = initData;

    // ── Phase 2: Worker-proxied chunked upload ────────────────────────────
    // Each chunk is POST-ed to /gdrive/upload-chunk.
    // The Worker streams it to Google using Content-Range.
    // No CORS problem — browser only talks to the Worker (our own origin).
    setStatus('Uploading to Google Drive…', 'var(--blue-bright)');
    setProgress(0, file.size);

    let bytesUploaded = 0;
    let finalFileMeta = null;

    while (bytesUploaded < file.size) {
      const chunkStart = bytesUploaded;
      const chunkEnd   = Math.min(chunkStart + CHUNK_SIZE, file.size) - 1; // inclusive
      const chunk      = file.slice(chunkStart, chunkEnd + 1);
      const contentRange = `bytes ${chunkStart}-${chunkEnd}/${file.size}`;

      console.log('[AURENIX gdrive] POST /gdrive/upload-chunk — range:', contentRange);

      // Refresh token if this is not the first chunk (long uploads may expire the token)
      if (bytesUploaded > 0) {
        try { idToken = await auth.currentUser?.getIdToken(false); } catch (_) {}
      }

      let chunkRes, chunkData;
      try {
        chunkRes = await fetch(UPLOAD_WORKER_URL + '/gdrive/upload-chunk', {
          method: 'POST',
          headers: {
            'Authorization':  'Bearer ' + idToken,
            'Content-Type':   file.type || 'application/octet-stream',
            'Content-Range':  contentRange,
            'X-Upload-Id':    uploadId,
            'X-Total-Size':   String(file.size),
          },
          body: chunk,
        });
        chunkData = await chunkRes.json();
      } catch (fetchErr) {
        console.error('[AURENIX gdrive] chunk fetch error:', fetchErr.message, 'type:', fetchErr.constructor?.name);
        throw new Error(`Google Drive upload could not connect. Retrying may resolve a temporary connection problem. (${fetchErr.message})`);
      }

      console.log('[AURENIX gdrive] /gdrive/upload-chunk HTTP', chunkRes.status,
        '— complete:', chunkData.complete, 'rangeEnd:', chunkData.rangeEnd);

      if (!chunkRes.ok) {
        const detail  = chunkData.detail  || chunkData.error || '';
        const retryable = chunkData.retryable === true;
        const msg = retryable
          ? `Google Drive upload could not connect. Retrying may resolve a temporary connection problem. (HTTP ${chunkRes.status}${detail ? ': ' + detail.slice(0, 120) : ''})`
          : _gdriveHumanError(chunkData.error || `Google Drive upload error — HTTP ${chunkRes.status}: ${detail.slice(0, 120)}`);
        throw new Error(msg);
      }

      if (chunkData.complete) {
        // Upload finished — final chunk
        finalFileMeta = chunkData.file || null;
        driveFileId   = finalFileMeta?.id || null;
        bytesUploaded = file.size;
        setProgress(file.size, file.size);
        console.log('[AURENIX gdrive] upload complete — driveFileId:', driveFileId);
      } else {
        // Chunk accepted — advance cursor.
        // Use the rangeEnd from Google (authoritative) when available.
        const confirmedEnd = typeof chunkData.rangeEnd === 'number' && chunkData.rangeEnd >= 0
          ? chunkData.rangeEnd + 1  // rangeEnd is inclusive
          : chunkEnd + 1;
        bytesUploaded = confirmedEnd;
        setProgress(bytesUploaded, file.size);
        const pct = Math.round(bytesUploaded / file.size * 100);
        setStatus(`Uploading to Google Drive… ${pct}%`, 'var(--blue-bright)');
      }
    }

    setStatus('Upload complete — confirming…', 'var(--green)');
    setProgress(file.size, file.size);

    // ── Phase 3: Save to Firestore ────────────────────────────────────────
    try { await auth.currentUser?.getIdToken(true); } catch (_) {}
    setStatus('Saving AURENIX media record…', 'var(--blue-bright)');

    const docRef = await addDoc(collection(db, 'network_media'), {
      title:          file.name.replace(/\.[^.]+$/, ''),
      artist:         '',
      creator:        _user?.email || '',
      description:    '',
      category:       _gdriveUploadCategory,
      type:           mediaType,
      // For Drive files, url is not a direct public URL — playback handled via Drive
      url:            driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : '',
      storage_path:   '',                          // not applicable for Drive
      drive_file_id:  driveFileId || '',           // Google Drive file ID
      drive_web_view_link: driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : '',
      drive_sub_folder: subFolder || '',
      storage_backend: 'google_drive',
      duration_sec,
      size_bytes:     file.size,
      mime_type:      file.type || 'application/octet-stream',
      // All uploads start as pending_approval regardless of storage backend.
      status:         'pending_approval',
      channel:        '',
      tags:           [],
      year:           new Date().getFullYear(),
      uploaded_by:    _user?.uid || '',
      uploaded_at:    serverTimestamp(),
    });

    setStatus('✓ Upload Complete', 'var(--green)');

    // Show result card
    if (resultDiv) {
      resultDiv.style.display = '';
      resultDiv.innerHTML = `
        <div style="background:rgba(0,200,80,0.08);border:1px solid rgba(0,200,80,0.3);border-radius:8px;padding:14px 16px;font-size:12px;line-height:1.8;">
          <div style="font-size:13px;font-weight:900;color:var(--green);margin-bottom:8px;letter-spacing:1px;">✓ GOOGLE DRIVE UPLOAD COMPLETE</div>
          <div style="color:var(--text);">✓ Google Drive file confirmed</div>
          <div style="color:var(--text);">✓ AURENIX media record created</div>
          <div style="color:var(--orange,#f0a500);">⏳ Status: Pending Approval</div>
          ${driveFileId ? `<div style="margin-top:8px;"><a href="https://drive.google.com/file/d/${_esc(driveFileId)}/view" target="_blank" rel="noopener" style="color:var(--blue-bright);font-size:11px;">🔗 Open in Google Drive</a></div>` : ''}
          <div style="margin-top:10px;display:flex;gap:8px;">
            <button class="ax-btn-sm" style="font-size:11px;" onclick="window._AXC.switchToPane('approval')">🔍 Go to Pending Approval</button>
          </div>
        </div>`;
    }

    _toast('✓ Uploaded to Google Drive — pending Founder approval: ' + file.name);

    // Open metadata editor after a short delay
    setTimeout(() => _openMetaModal(docRef.id, file.name.replace(/\.[^.]+$/, '')), 600);

  } catch (uploadErr) {
    const rawMsg = uploadErr.message || 'Upload failed';
    // Determine if this is a connectivity/retryable error vs. a configuration error
    const isConnectErr = rawMsg.toLowerCase().includes('could not connect') ||
                         rawMsg.toLowerCase().includes('network error') ||
                         rawMsg.toLowerCase().includes('temporary connection');
    const errMsg = isConnectErr
      ? rawMsg  // already has friendly text from above
      : _gdriveHumanError(rawMsg);

    console.error('[AURENIX gdrive] upload error:', rawMsg);
    setStatus('✗ ' + errMsg, 'var(--red)');
    setProgress(0, file.size);
    if (resultDiv) {
      resultDiv.style.display = '';
      resultDiv.innerHTML = `
        <div style="background:rgba(255,45,85,0.08);border:1px solid rgba(255,45,85,0.3);border-radius:8px;padding:14px 16px;font-size:12px;line-height:1.7;">
          <div style="font-size:13px;font-weight:700;color:var(--red);margin-bottom:6px;">✗ UPLOAD FAILED</div>
          <div style="color:var(--text-dim);margin-bottom:10px;">${_esc(isConnectErr
            ? 'Google Drive upload could not connect.\nRetrying may resolve a temporary connection problem.'
            : errMsg)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="ax-btn-sm" onclick="window._AXC.retryGdriveUpload()" style="margin-right:2px;">↺ Retry</button>
            <button class="ax-btn-sm" onclick="window._AXC.switchToPane('storage')">🔗 Check Drive Connection</button>
          </div>
        </div>`;
      // Store file for retry
      window._AXC._pendingGdriveFile = file;
    }
    _toast('Google Drive upload failed: ' + errMsg, 'err');
  }
}

// Extend _AXC with Drive helpers
Object.assign(window._AXC, {
  retryGdriveUpload() {
    const f = window._AXC._pendingGdriveFile;
    if (f) _gdriveUploadFile(f);
    else _toast('No pending file — select a file again.', 'err');
  },
});

