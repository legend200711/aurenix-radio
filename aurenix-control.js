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

// Supabase client is used ONLY for the delete action (anon DELETE policy
// on storage.objects is kept intentionally). Uploads go through the
// Cloudflare Worker instead — supabase is not used for INSERT here.
import { supabase } from './supabase-client.js';

/* ═══════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════ */
const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const MEDIA_BUCKET  = 'aurenix-media';
const MAX_FILE_MB   = 500;

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

const CHANNELS = [
  { id: 'A1', name: 'AURENIX ONE',   label: 'ONE',   color: '#1e50ff' },
  { id: 'A2', name: 'AURENIX MUSIC', label: 'MUSIC', color: '#b8860b' },
  { id: 'A3', name: 'AURENIX VIDEO', label: 'VIDEO', color: '#8b00ff' },
  { id: 'A4', name: 'AURENIX LIVE',  label: 'LIVE',  color: '#ff2d55' },
];

const MEDIA_CATEGORIES = [
  { id: 'music',         label: '🎵 MUSIC',            accept: 'audio/*',       type: 'audio'  },
  { id: 'video',         label: '🎬 VIDEO',             accept: 'video/*',       type: 'video'  },
  { id: 'music_video',   label: '🎞 MUSIC VIDEO',       accept: 'video/*',       type: 'music_video' },
  { id: 'show',          label: '📺 SHOW',              accept: 'video/*',       type: 'show'   },
  { id: 'broadcast_clip',label: '🎥 BROADCAST CLIP',    accept: 'video/*,audio/*', type: 'broadcast_clip' },
  { id: 'podcast',       label: '🎙 PODCAST',           accept: 'audio/*',       type: 'podcast' },
  { id: 'audio_program', label: '🎧 AUDIO PROGRAM',     accept: 'audio/*',       type: 'audio_program' },
  { id: 'station_id',    label: '📢 STATION ID / INTRO',accept: 'audio/*,video/*', type: 'station_id' },
  { id: 'thumbnail',     label: '🖼 THUMBNAIL',          accept: 'image/*',       type: 'thumbnail' },
  { id: 'trailer',       label: '🎞 TRAILER',            accept: 'video/*',       type: 'trailer' },
  { id: 'archive',       label: '📼 ARCHIVED BROADCAST', accept: 'video/*,audio/*', type: 'archive' },
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
    // Show a clear "not authorized" message instead of blank screen
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
    // Inject the full Founder Studio HTML (replaces the loading state)
    ctrl.innerHTML = _buildFounderHTML();
    // Ensure visible in case this was called directly
    ctrl.classList.add('visible');
    const hero = document.getElementById('ax-hero');
    if (hero) hero.style.display = 'none';

    // Subscribe to all channels and media library
    CHANNELS.forEach(ch => _subscribeChannelState(ch.id));
    _subscribeMedia();

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
    _bindLiveControl();
    _renderChannels();
    _renderDashboard();

    // Close button
    ctrl.querySelector('#ax-ctrl-close')?.addEventListener('click', _restoreHero);

    // Refresh btn
    ctrl.querySelector('#ax-ov-refresh-btn')?.addEventListener('click', () => {
      CHANNELS.forEach(ch => _renderChannelCard(ch.id));
      _renderDashboard();
      _toast('Refreshed.');
    });

    // Worker health check — run once on open and bind re-check button
    _checkWorkerHealth();
    ctrl.querySelector('#ax-sec-recheck-btn')?.addEventListener('click', _checkWorkerHealth);

  } catch (err) {
    console.error('[AURENIX] Founder Studio mount error:', err);
    // Show a visible error — never leave the panel as a black screen
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
    <button class="ax-ctrl-nav-btn" data-pane="channels">
      <span class="ax-ctrl-nav-icon">📺</span> Channel Manager
    </button>
    <button class="ax-ctrl-nav-btn" data-pane="schedule">
      <span class="ax-ctrl-nav-icon">📅</span> Broadcast Scheduler
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
          <div id="ax-dash-nowplaying">
            ${CHANNELS.map(ch => `
              <div class="ax-dash-np-row" id="ax-dash-np-${ch.id}">
                <div class="ax-dash-np-badge" style="background:${ch.color}22;color:${ch.color};border-color:${ch.color}44;">${ch.id}</div>
                <div class="ax-dash-np-info">
                  <div class="ax-dash-np-title" id="ax-dash-title-${ch.id}">Standby…</div>
                  <div class="ax-dash-np-meta" id="ax-dash-meta-${ch.id}">—</div>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="ax-dash-card">
          <div class="ax-dash-card-title">QUEUE STATUS</div>
          <div id="ax-dash-queues">
            ${CHANNELS.map(ch => `
              <div class="ax-dash-q-row">
                <div class="ax-dash-q-label" style="color:${ch.color}">${ch.label}</div>
                <div class="ax-dash-q-bar-wrap">
                  <div class="ax-dash-q-bar" id="ax-qbar-${ch.id}" style="width:0%;background:${ch.color}"></div>
                </div>
                <div class="ax-dash-q-count" id="ax-qcount-${ch.id}">0 items</div>
              </div>`).join('')}
          </div>
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

    <!-- ══ LIVE CONTROL ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-live">
      <div class="ax-section-title">🔴 Live <span>Control</span></div>
      <div class="ax-live-grid" id="ax-live-grid">
        ${CHANNELS.map(ch => `
          <div class="ax-live-channel-card" id="ax-live-card-${ch.id}">
            <div class="ax-live-ch-header" style="border-color:${ch.color}44;">
              <div class="ax-live-ch-id" style="color:${ch.color}">${ch.id}</div>
              <div class="ax-live-ch-name">${ch.name}</div>
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
          </div>`).join('')}
      </div>
    </div>

    <!-- ══ UPLOAD CENTER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-upload">
      <div class="ax-section-title">Upload <span>Center</span></div>
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
          Audio: MP3 WAV AAC OGG FLAC M4A &nbsp;|&nbsp; Video: MP4 WebM MOV AVI &nbsp;|&nbsp; Images: JPG PNG WebP
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

    <!-- ══ CHANNEL MANAGER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-channels">
      <div class="ax-section-title">Channel <span>Manager</span></div>
      <div class="ax-channels-grid" id="ax-ch-manager-grid"></div>
    </div>

    <!-- ══ BROADCAST SCHEDULER ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-schedule">
      <div class="ax-section-title">Broadcast <span>Scheduler</span></div>
      <div class="ax-channel-picker" id="ax-sched-ch-picker">
        ${CHANNELS.map(ch => `
          <button class="ax-ch-pick-btn ${ch.id === 'A1' ? 'active' : ''}" data-chid="${ch.id}"
                  style="${ch.id === 'A1' ? `border-color:${ch.color};color:${ch.color};` : ''}">
            ${ch.id} — ${ch.label}
          </button>`).join('')}
      </div>
      <label class="ax-loop-toggle">
        <input type="checkbox" id="ax-loop-toggle" checked>
        Loop playlist continuously (24/7 broadcast — channel never stops)
      </label>
      <div class="ax-sched-builder">
        <div>
          <div class="ax-sched-queue" id="ax-sched-queue">
            <div class="ax-sched-queue-header">
              <span class="ax-sched-queue-title" id="ax-sched-ch-label">AURENIX ONE — Schedule</span>
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
          <div class="ax-security-row"><span>Delete Media</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Modify Schedules</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Channel Control</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
          <div class="ax-security-row"><span>Play Now / Interrupt</span><span class="ax-security-val ax-badge-founder">FOUNDER ONLY</span></div>
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
          <div style="margin-top:8px;">
            <button class="ax-btn-sm" id="ax-sec-recheck-btn">↺ Re-check Worker</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ SETTINGS ══ -->
    <div class="ax-ctrl-pane" id="ax-pane-settings">
      <div class="ax-section-title">AURENIX <span>Settings</span></div>
      <div class="ax-settings-grid">
        ${CHANNELS.map(ch => `
          <div class="ax-settings-card">
            <div class="ax-settings-ch-header" style="color:${ch.color}">${ch.id} — ${ch.name}</div>
            <div class="ax-field-group" style="margin-top:10px;">
              <label class="ax-field-label">Channel Description</label>
              <input class="ax-field-input ax-settings-desc" data-chid="${ch.id}" type="text" placeholder="${ch.name} — 24/7 broadcast">
            </div>
            <label class="ax-loop-toggle" style="margin-top:10px;">
              <input type="checkbox" class="ax-settings-loop" data-chid="${ch.id}" checked>
              Loop continuously
            </label>
            <button class="ax-btn-sm" style="margin-top:10px;" onclick="window._AXC.saveChannelSettings('${ch.id}')">Save</button>
          </div>`).join('')}
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
    <div class="ax-channel-picker" id="ax-bcast-ch-picker">
      ${CHANNELS.filter(ch => ch.id !== 'A4').map(ch => `
        <button class="ax-ch-pick-btn" data-chid="${ch.id}" style="color:${ch.color}">
          ${ch.id} — ${ch.label}
        </button>`).join('')}
    </div>
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
  });
}

/* ═══════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════ */
function _renderDashboard() {
  // Channel status badges
  const dashCh = document.getElementById('ax-dash-channels');
  if (dashCh) {
    dashCh.innerHTML = CHANNELS.map(ch => {
      const st  = _channelStates[ch.id];
      const live = !!(st?.current_item);
      return `
        <div class="ax-dash-ch-badge" style="border-color:${ch.color}44;">
          <div class="ax-dash-ch-id" style="color:${ch.color}">${ch.id}</div>
          <div class="ax-dash-ch-name">${ch.name}</div>
          <div class="ax-dash-ch-state ${live ? 'on-air' : ''}">
            ${live ? '🔴 ON AIR' : '⚫ STANDBY'}
          </div>
        </div>`;
    }).join('');
  }
  // Now playing rows
  CHANNELS.forEach(ch => {
    const st  = _channelStates[ch.id];
    const cur = st?.current_item;
    const titleEl = document.getElementById(`ax-dash-title-${ch.id}`);
    const metaEl  = document.getElementById(`ax-dash-meta-${ch.id}`);
    if (titleEl) titleEl.textContent = cur ? cur.title : 'Standby…';
    if (metaEl)  metaEl.textContent  = cur ? (cur.artist || cur.type || 'media') : '—';
  });
  // Queue bars
  CHANNELS.forEach(ch => {
    const st    = _channelStates[ch.id];
    const queue = st?.queue || [];
    const max   = 20;
    const pct   = Math.min(100, (queue.length / max) * 100);
    const bar   = document.getElementById(`ax-qbar-${ch.id}`);
    const cnt   = document.getElementById(`ax-qcount-${ch.id}`);
    if (bar) bar.style.width = pct + '%';
    if (cnt) cnt.textContent = queue.length + (queue.length === 1 ? ' item' : ' items');
  });
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
  const warnings = [];
  CHANNELS.forEach(ch => {
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
    el.innerHTML = '<div style="color:var(--green);font-size:12px;">✓ All channels have content scheduled.</div>';
    return;
  }
  el.innerHTML = warnings.map(w => `
    <div class="ax-warning-row ${w.level === 'empty' ? 'ax-warn-empty' : 'ax-warn-low'}">
      <div>${w.level === 'empty' ? '🔴' : '⚠️'} <strong>${w.ch.id}</strong> — ${_esc(w.msg)}</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${w.ch.id}')">+ ADD MEDIA</button>
        <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${w.ch.id}')">📅 SCHEDULE</button>
      </div>
    </div>`).join('');
}

/* ═══════════════════════════════════════
   NETWORK CONTROL PANE
═══════════════════════════════════════ */
function _renderChannelCard(channelId) {
  const container = document.getElementById('ax-ov-channels');
  if (!container) return;
  container.innerHTML = CHANNELS.map(c => {
    const s   = _channelStates[c.id];
    const cur = s?.current_item;
    const q   = s?.queue || [];
    return `
      <div class="ax-channel-card">
        <div class="ax-channel-card-header">
          <div class="ax-channel-card-id" style="color:${c.color}">${c.id}</div>
          <div>
            <div class="ax-channel-card-name">${c.label}</div>
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
  }).join('');
  const liveCount = CHANNELS.filter(c => _channelStates[c.id]?.current_item).length;
  const lc = document.getElementById('ax-ov-live-count');
  if (lc) lc.textContent = liveCount;
}

function _renderChannels() {
  _renderChannelCard('A1');
  // channel manager grid
  const mgr = document.getElementById('ax-ch-manager-grid');
  if (mgr) {
    mgr.innerHTML = CHANNELS.map(c => {
      const s   = _channelStates[c.id];
      const cur = s?.current_item;
      const q   = s?.queue || [];
      const nextItem = cur && q.length ? q[q.findIndex(x => x.id === cur.id) + 1] || null : q[0] || null;
      return `
        <div class="ax-channel-card" style="border-color:${c.color}33;">
          <div class="ax-channel-card-header">
            <div class="ax-channel-card-id" style="color:${c.color};font-size:20px;">${c.id}</div>
            <div>
              <div class="ax-channel-card-name" style="font-size:14px;">${c.name}</div>
              <div class="ax-channel-card-status">${cur ? `<span style="color:var(--red)">● ON AIR</span>` : `<span style="color:var(--text-muted)">● OFFLINE</span>`}</div>
            </div>
          </div>
          <div style="margin:8px 0;font-size:11px;font-weight:700;letter-spacing:1px;color:var(--text-dim);">CURRENT PROGRAM</div>
          <div class="ax-channel-card-np">${cur ? _esc(cur.title) : '—'}</div>
          <div style="margin:8px 0;font-size:11px;font-weight:700;letter-spacing:1px;color:var(--text-dim);">UP NEXT</div>
          <div class="ax-channel-card-np" style="color:var(--text-dim)">${nextItem ? _esc(nextItem.title) : '—'}</div>
          <div style="margin:8px 0;font-size:11px;color:var(--text-dim);">${q.length} items · ${s?.loop ? 'Looping' : 'Linear'}</div>
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
            <button class="ax-btn-sm" onclick="window._AXC.goToSchedule('${c.id}')">📅 Schedule</button>
            <button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openPlayNow('${c.id}')">🔴 Play Now</button>
            <button class="ax-btn-sm" onclick="window._AXC.skipChannel('${c.id}')">⏭ Skip</button>
            <button class="ax-btn-sm" onclick="window._AXC.restartChannel('${c.id}')">🔄 Restart</button>
            <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.stopChannel('${c.id}')">■ Stop</button>
          </div>
        </div>`;
    }).join('');
  }
}

/* ═══════════════════════════════════════
   LIVE CONTROL PANE
═══════════════════════════════════════ */
function _renderLiveCard(channelId) {
  const ch  = CHANNELS.find(c => c.id === channelId);
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
  CHANNELS.forEach(ch => _renderLiveCard(ch.id));
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
  const allowed = files.filter(f =>
    f.type.startsWith('audio/') ||
    f.type.startsWith('video/') ||
    f.type.startsWith('image/')
  );
  if (!allowed.length) { _toast('No supported files selected.', 'err'); return; }
  const tooBig = allowed.filter(f => f.size > MAX_FILE_MB * 1024 * 1024);
  if (tooBig.length) {
    _toast(`${tooBig.length} file(s) exceed ${MAX_FILE_MB} MB limit and were skipped.`, 'err');
  }
  const valid = allowed.filter(f => f.size <= MAX_FILE_MB * 1024 * 1024);
  // Upload concurrently (max 3 at a time)
  for (let i = 0; i < valid.length; i += 3) {
    await Promise.allSettled(valid.slice(i, i + 3).map(f => _uploadFile(f)));
  }
}

/**
 * Upload a single file using the TUS resumable-upload architecture:
 *
 *   Phase 1 — Worker /authorize (tiny JSON, no file body)
 *     → Firebase token verified server-side
 *     → Founder email confirmed from verified token
 *     → Worker creates TUS resource on Supabase using service-role key
 *     → Returns tusUrl + storagePath + publicUrl
 *
 *   Phase 2 — TUS PATCH directly to Supabase (no Worker in the data path)
 *     → Chunked XHR for byte-accurate progress
 *     → Resumable: network errors retry the current chunk
 *     → File never passes through the Worker → no 100 MB CF body limit
 *     → Size limit is the Supabase bucket's file_size_limit (set to 500 MB)
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

  const setProgress = (loaded, total) => {
    const pct   = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
    const bar   = document.getElementById(`bar-${itemKey}`);
    const pctEl = document.getElementById(`pct-${itemKey}`);
    const bytes = document.getElementById(`bytes-${itemKey}`);
    if (bar)   bar.style.width   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (bytes && total > 0) bytes.textContent = `${_fmtSize(loaded)} / ${_fmtSize(total)}`;
  };
  const setStatus = (msg, color = '') => {
    const el = document.getElementById(`st-${itemKey}`);
    if (el) { el.textContent = msg; if (color) el.style.color = color; }
  };
  const addRetry = () => {
    const row = document.getElementById(itemKey);
    if (!row) return;
    // Remove any existing retry button first
    row.querySelector('.ax-retry-btn')?.remove();
    const btn = document.createElement('button');
    btn.className   = 'ax-btn-sm ax-btn-danger ax-retry-btn';
    btn.textContent = '↺ Retry';
    btn.style.marginLeft = '8px';
    btn.onclick = () => { row.remove(); _uploadFile(file); };
    row.appendChild(btn);
  };

  // ── Pre-flight: duration ───────────────────────────────────────────────
  let duration_sec = 0;
  if (isAudio || isVideo) {
    try { duration_sec = await _getMediaDuration(file); } catch (_) {}
  }

  // ── Phase 1: Worker /authorize — get TUS URL ──────────────────────────
  // Sends only a tiny JSON body (fileName, contentType, size).
  // The file is NOT sent here. The Worker verifies the Firebase token and
  // creates a TUS upload resource on Supabase using the service-role key.
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

    authResult = data; // { tusUrl, storagePath, publicUrl }
  } catch (authErr) {
    setStatus('✗ AUTH FAILED — click retry', 'var(--red)');
    addRetry();
    _toast(authErr.message, 'err');
    return;
  }

  // ── Phase 2: TUS upload directly to Supabase ──────────────────────────
  // The file streams directly from browser → Supabase.
  // The Worker is completely out of the data path.
  setStatus('UPLOADING…', '');
  setProgress(0, file.size);

  try {
    await _tusUpload(file, authResult.tusUrl, (loaded, total) => {
      setProgress(loaded, total);
    });
  } catch (uploadErr) {
    setStatus('✗ STORAGE FAILED — click retry', 'var(--red)');
    addRetry();
    _toast(uploadErr.message || 'SUPABASE STORAGE UPLOAD FAILED', 'err');
    return;
  }

  setProgress(file.size, file.size);
  setStatus('PROCESSING…', 'var(--blue-bright)');

  // ── Phase 3: Firestore metadata record ───────────────────────────────
  // Force-refresh token before writing so the Firestore SDK has a valid
  // session even after a long upload.
  try { await auth.currentUser?.getIdToken(true); } catch (_) {}

  try {
    const docRef = await addDoc(collection(db, 'network_media'), {
      title:        file.name.replace(/\.[^.]+$/, ''),
      artist:       '',
      creator:      _user.email,
      description:  '',
      category:     _uploadCategory,
      type:         mediaType,
      url:          authResult.publicUrl,
      storage_path: authResult.storagePath,
      duration_sec,
      size_bytes:   file.size,
      status:       'ready',
      channel:      '',
      tags:         [],
      year:         new Date().getFullYear(),
      uploaded_by:  _user.uid,
      uploaded_at:  serverTimestamp(),
    });

    setStatus('✓ READY', 'var(--green)');
    const destEl = document.getElementById(`dest-${itemKey}`);
    if (destEl) destEl.textContent = `${MEDIA_BUCKET} › ${docRef.id}`;
    _toast(`Uploaded: ${file.name}`);

    if (!isImage) {
      setTimeout(() => _openMetaModal(docRef.id, file.name.replace(/\.[^.]+$/, '')), 400);
    }

  } catch (metaErr) {
    setStatus('✗ METADATA FAILED — click retry', 'var(--orange,#f90)');
    addRetry();
    _toast('MEDIA DATABASE RECORD FAILED — ' + (metaErr.message || metaErr), 'err');
  }
}

/**
 * TUS resumable upload — sends the file directly to a Supabase TUS URL.
 *
 * Implements TUS 1.0.0 PATCH protocol:
 *   - Chunks the file into ~5 MB pieces for accurate progress
 *   - Each chunk is a PATCH request with Upload-Offset header
 *   - Network errors on a chunk are retried up to 3 times before failing
 *   - Resume: queries Upload-Offset via HEAD before starting, so a
 *     previously interrupted upload continues from where it left off
 *
 * @param {File}     file        — the file to upload
 * @param {string}   tusUrl      — TUS Location URL from Worker /authorize
 * @param {function} onProgress  — callback(loadedBytes, totalBytes)
 */
async function _tusUpload(file, tusUrl, onProgress) {
  const CHUNK = 5 * 1024 * 1024; // 5 MB chunks
  const total = file.size;

  // ── Resume: find how far we got (HEAD) ─────────────────────────────────
  let offset = 0;
  try {
    const head = await fetch(tusUrl, {
      method:  'HEAD',
      headers: { 'Tus-Resumable': '1.0.0' },
    });
    if (head.ok) {
      const off = head.headers.get('Upload-Offset');
      if (off) offset = parseInt(off, 10);
    }
  } catch (_) { /* start from 0 if HEAD fails */ }

  onProgress(offset, total);

  // ── Upload chunks ──────────────────────────────────────────────────────
  while (offset < total) {
    const end   = Math.min(offset + CHUNK, total);
    const chunk = file.slice(offset, end);

    // Retry each chunk up to 3 times on network error
    let attempts = 0;
    while (true) {
      attempts++;
      try {
        await _tusChunk(tusUrl, chunk, offset, total);
        break; // chunk succeeded
      } catch (err) {
        if (attempts >= 3) throw new Error(`SUPABASE STORAGE UPLOAD FAILED — ${err.message}`);
        await new Promise(r => setTimeout(r, 1000 * attempts)); // back-off
      }
    }

    offset = end;
    onProgress(offset, total);
  }
}

/**
 * Send one TUS PATCH chunk via XHR for byte-accurate upload progress.
 *
 * @param {string} tusUrl
 * @param {Blob}   chunk       — slice of the file
 * @param {number} offset      — byte offset of this chunk in the full file
 * @param {number} totalSize   — total file size
 */
function _tusChunk(tusUrl, chunk, offset, totalSize) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', tusUrl, true);
    xhr.setRequestHeader('Tus-Resumable',  '1.0.0');
    xhr.setRequestHeader('Upload-Offset',  String(offset));
    xhr.setRequestHeader('Content-Type',   'application/offset+octet-stream');
    xhr.setRequestHeader('Content-Length', String(chunk.size));

    xhr.addEventListener('load', () => {
      // TUS success = 204 No Content
      if (xhr.status === 204 || xhr.status === 200) {
        resolve();
      } else {
        reject(new Error(`HTTP ${xhr.status} at offset ${offset}: ${xhr.responseText.slice(0, 200)}`));
      }
    });
    xhr.addEventListener('error',  () => reject(new Error('Network error during chunk upload')));
    xhr.addEventListener('abort',  () => reject(new Error('Upload aborted')));

    xhr.send(chunk);
  });
}

function _getMediaDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el  = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { resolve(Math.round(el.duration)); URL.revokeObjectURL(url); };
    el.onerror = () => { reject(new Error('Could not read duration')); URL.revokeObjectURL(url); };
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
          ${CHANNELS.map(ch => `<option value="${ch.id}" ${ch.id === item.channel ? 'selected' : ''}>${ch.name}</option>`).join('')}
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
  grid.innerHTML = items.map(m => `
    <div class="ax-media-card" data-id="${m.id}">
      <div class="ax-media-card-thumb">
        ${m.thumbnail_url
          ? `<img src="${_esc(m.thumbnail_url)}" alt="" loading="lazy">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;opacity:0.5;">${_typeIcon(m.type)}</div>`}
        <span class="ax-media-card-type">${m.type || 'media'}</span>
        ${m.duration_sec ? `<span class="ax-media-card-dur">${_fmtTime(m.duration_sec)}</span>` : ''}
        ${m.channel ? `<span class="ax-media-card-ch" style="position:absolute;bottom:4px;left:4px;font-size:9px;background:rgba(0,0,0,0.7);color:#4d7aff;padding:1px 4px;border-radius:3px;">${m.channel}</span>` : ''}
      </div>
      <div class="ax-media-card-body">
        <div class="ax-media-card-title" title="${_esc(m.title)}">${_esc(m.title)}</div>
        <div class="ax-media-card-meta">${_esc(m.artist || m.creator || '')}${m.uploaded_at ? ' · ' + _relDate(m.uploaded_at) : ''}</div>
      </div>
      ${showActions ? `
      <div class="ax-media-card-actions">
        <button class="ax-btn-sm" onclick="window._AXC.playPreview('${m.id}')" title="Preview">▶</button>
        <button class="ax-btn-sm" onclick="window._AXC.openMeta('${m.id}')" title="Edit">✏</button>
        <button class="ax-btn-sm ax-btn-playnow" onclick="window._AXC.openBroadcast('${m.id}')" title="Broadcast">📡</button>
        <button class="ax-btn-sm" onclick="window._AXC.addToSched('${m.id}')" title="Schedule">📅</button>
        ${m.url ? `<button class="ax-btn-sm" onclick="window._AXC.downloadMedia('${m.id}')" title="Download">⬇</button>` : ''}
        <button class="ax-btn-sm ax-btn-danger" onclick="window._AXC.deleteMedia('${m.id}')" title="Delete">🗑</button>
      </div>` : ''}
    </div>`).join('');
}

/* ═══════════════════════════════════════
   SCHEDULE PANE
═══════════════════════════════════════ */
function _bindSchedulePane() {
  document.querySelectorAll('.ax-ch-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ax-ch-pick-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = '';
        b.style.color = '';
      });
      btn.classList.add('active');
      const ch = CHANNELS.find(c => c.id === btn.dataset.chid);
      if (ch) { btn.style.borderColor = ch.color; btn.style.color = ch.color; }
      _schedChannelId = btn.dataset.chid;
      const lbl = document.getElementById('ax-sched-ch-label');
      if (lbl) lbl.textContent = `${CHANNELS.find(c => c.id === _schedChannelId)?.name} — Schedule`;
      _renderSchedItems();
      _renderOnAir();
    });
  });

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
  container.innerHTML = items.map(m => `
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
  _toast(`${CHANNELS.find(c => c.id === _schedChannelId)?.name} is now LIVE.`);
}

/* ═══════════════════════════════════════
   STATISTICS
═══════════════════════════════════════ */
function _renderStats() {
  const total   = _mediaLib.length;
  const audios  = _mediaLib.filter(m => ['audio','music','podcast','audio_program','station_id'].includes(m.type)).length;
  const videos  = _mediaLib.filter(m => ['video','music_video','show','trailer','archive','broadcast_clip'].includes(m.type)).length;
  const live    = CHANNELS.filter(c => _channelStates[c.id]?.current_item).length;
  const queued  = CHANNELS.reduce((acc, c) => acc + (_channelStates[c.id]?.queue?.length || 0), 0);
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
    statsChEl.innerHTML = CHANNELS.map(ch => {
      const st    = _channelStates[ch.id];
      const cur   = st?.current_item;
      const q     = st?.queue || [];
      const qSec  = q.reduce((a, i) => a + (i.duration_sec || 0), 0);
      return `
        <div class="ax-stats-ch-row">
          <div class="ax-stats-ch-id" style="color:${ch.color}">${ch.id}</div>
          <div class="ax-stats-ch-name">${ch.name}</div>
          <div class="ax-stats-ch-val">${q.length} items</div>
          <div class="ax-stats-ch-val">${_fmtTimeLong(qSec)} queued</div>
          <div class="ax-stats-ch-state ${cur ? 'live' : ''}">${cur ? '● LIVE' : '● STANDBY'}</div>
        </div>`;
    }).join('');
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

  const ch  = CHANNELS.find(c => c.id === channelId);
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
        { id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0 },
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
  _bcastChannelId = 'A1';
  _bcastMode      = 'queue';
  const item  = _mediaLib.find(m => m.id === mediaId);
  if (!item) return;
  const modal = document.getElementById('ax-broadcast-modal');
  if (!modal) return;
  const titleEl = document.getElementById('ax-bcast-media-title');
  if (titleEl) titleEl.textContent = `${_typeIcon(item.type)} ${item.title}`;
  // Reset pickers
  document.querySelectorAll('#ax-bcast-ch-picker .ax-ch-pick-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#ax-bcast-ch-picker .ax-ch-pick-btn')?.classList.add('active');
  _bcastChannelId = document.querySelector('#ax-bcast-ch-picker .ax-ch-pick-btn')?.dataset.chid || 'A1';

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
    document.querySelectorAll('.ax-ch-pick-btn').forEach(b => {
      const ch = CHANNELS.find(c => c.id === b.dataset.chid);
      const active = b.dataset.chid === channelId;
      b.classList.toggle('active', active);
      b.style.borderColor = active && ch ? ch.color : '';
      b.style.color       = active && ch ? ch.color : '';
    });
    const lbl = document.getElementById('ax-sched-ch-label');
    if (lbl) lbl.textContent = `${CHANNELS.find(c => c.id === channelId)?.name} — Schedule`;
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
    const st    = _channelStates[_schedChannelId];
    const queue = [...(st?.queue || [])];
    if (queue.find(q => q.id === mediaId)) { _toast('Already in schedule.', 'err'); return; }
    queue.push({ id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0 });
    await _saveQueue(queue);
    _toast(`Added to ${_schedChannelId}: ${item.title}`);
  },

  async addToSchedChannel(mediaId, channelId) {
    const item = _mediaLib.find(m => m.id === mediaId);
    if (!item) return;
    const st    = _channelStates[channelId];
    const queue = [...(st?.queue || [])];
    if (queue.find(q => q.id === mediaId)) { _toast('Already in queue.', 'err'); return; }
    queue.push({ id: item.id, title: item.title, artist: item.artist || '', type: item.type, url: item.url, duration_sec: item.duration_sec || 0 });
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
    const st  = _channelStates[channelId];
    const ref = doc(db, 'network_state', channelId);
    await setDoc(ref, {
      ...(st || {}),
      description: descEl?.value || '',
      loop:        loopEl?.checked ?? true,
      updated_at:  serverTimestamp(),
    }, { merge: true });
    _toast(`${channelId} settings saved.`);
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
