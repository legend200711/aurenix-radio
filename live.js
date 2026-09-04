/**
 * AURENIX — live.js
 *
 * Backend architecture (post-migration):
 *
 *  Auth + Profiles:
 *    - Firebase Authentication
 *    - Firestore `users/{uid}` collection
 *
 *  Live Rooms (Firestore):
 *    - Firestore `live_rooms/{roomId}` collection
 *    - Real-time via onSnapshot
 *
 *  Chat (Firestore):
 *    - Firestore `live_messages` collection, ordered by created_at
 *    - Real-time via onSnapshot (filtered to room_id)
 *
 *  WebRTC Signaling (Supabase Broadcast channels — KEPT):
 *    - channel `live-signal-{roomId}`   → main viewer signaling
 *    - channel `live-guests-{roomId}`   → guest presence
 *    - channel `live-guest-sig-{roomId}` → guest WebRTC signaling
 *    - channel `live-relay-sig-{roomId}` → guest relay signaling
 *    - channel `live-presence-{roomId}` → viewer presence/count
 *
 *  NOTE: Supabase Realtime broadcast channels are intentionally kept
 *        for WebRTC signaling — they have no Firebase equivalent.
 *        Only DB (live_rooms, live_messages, etc.) moves to Firestore.
 */

'use strict';

import { supabase, onAuthChange, loadUserProfile, upsertUserProfile,
         getFeatureFlag, getAccessToken } from './supabase-client.js';

/* ── Firestore helpers imported from firebase-client.js ── */
import {
  db          as _fbDb,
  doc         as _fbDoc,
  getDoc      as _fbGetDoc,
  setDoc      as _fbSetDoc,
  updateDoc   as _fbUpdateDoc,
  addDoc      as _fbAddDoc,
  deleteDoc   as _fbDeleteDoc,
  collection  as _fbCollection,
  query       as _fbQuery,
  where       as _fbWhere,
  orderBy     as _fbOrderBy,
  limit       as _fbLimit,
  getDocs     as _fbGetDocs,
  onSnapshot  as _fbOnSnapshot,
  serverTimestamp as _fbServerTs,
} from './firebase-client.js';

/* ── Supabase Realtime Broadcast helpers (replace Firebase RTDB) ── */

/**
 * Get (or create) a Supabase Realtime channel for signaling.
 * Each roomId gets its own channel namespace.
 */
const _channels = {};

function _getChannel(name) {
  if (!_channels[name]) {
    _channels[name] = supabase.channel(name, { config: { broadcast: { self: false } } });
    _channels[name].subscribe();
  }
  return _channels[name];
}

function _removeChannel(name) {
  if (_channels[name]) {
    supabase.removeChannel(_channels[name]);
    delete _channels[name];
  }
}

/** Broadcast a message on a signaling channel (replaces RTDB `set/update`). */
async function _rtBroadcast(channelName, event, payload) {
  const ch = _getChannel(channelName);
  await ch.send({ type: 'broadcast', event, payload });
}

/** Listen for broadcast events on a channel (replaces RTDB `onValue`). */
function _rtListen(channelName, event, handler) {
  const ch = _getChannel(channelName);
  ch.on('broadcast', { event }, msg => handler(msg.payload));
  return () => _removeChannel(channelName);
}

/** One-shot read from Firestore (replaces Supabase _dbGet). */
async function _dbGet(collection, id) {
  try {
    const snap = await _fbGetDoc(_fbDoc(_fbDb, collection, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (e) {
    console.warn('[live] _dbGet', collection, e.message);
    return null;
  }
}

/** Set/upsert a Firestore document (replaces Supabase _dbSet). */
async function _dbSet(collection, row) {
  try {
    const { id, ...fields } = row;
    await _fbSetDoc(_fbDoc(_fbDb, collection, id), {
      ...fields,
      id,
      updated_at: _fbServerTs(),
    }, { merge: true });
  } catch (e) {
    console.warn('[live] _dbSet', collection, e.message);
  }
}

/** Update fields on a Firestore document (replaces Supabase _dbUpdate). */
async function _dbUpdate(collection, id, patch) {
  try {
    await _fbUpdateDoc(_fbDoc(_fbDb, collection, id), {
      ...patch,
      updated_at: _fbServerTs(),
    });
  } catch (e) {
    console.warn('[live] _dbUpdate', collection, e.message);
  }
}

/** Delete a Firestore document (replaces Supabase _dbDelete). */
async function _dbDelete(collection, id) {
  try {
    await _fbDeleteDoc(_fbDoc(_fbDb, collection, id));
  } catch (e) {
    console.warn('[live] _dbDelete', collection, e.message);
  }
}

/* ── Compatibility shims (keep internal code changes minimal) ── */
// onDisconnect has no direct Supabase equivalent; we use beforeunload/pagehide
// cleanup instead. These stubs prevent call-site errors.
const _liveDB = {
  _noop: () => ({ cancel: () => {}, remove: () => {} }),
};
// ref/set/get/update/remove/onValue/off/onDisconnect stubs are replaced inline below.

/* ── WebRTC ICE config ── */
const _ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

/* ── State ── */
let _user         = null;   // Firebase Auth user
let _userData     = null;   // Firestore user doc data
let _mode         = null;   // 'creator' | 'viewer'
let _roomId       = null;
let _roomHostId   = null;   // real uid of the host (populated on viewer join and creator start)
let _feedPostId   = null;   // ID of the live post created in 'posts' collection
let _localStream  = null;
let _camOn        = true;
let _micOn        = true;
let _facingMode   = 'user';

/* ── Performance: send-lock prevents double-send on rapid taps ── */
let _chatSending  = false;
/* ── Performance: rAF handle for layout batching ── */
let _layoutRafId  = null;
/* ── Performance: track if update-check has already run this session ── */
let _updateChecked = false;

// WebRTC
let _rtcPc           = null;   // RTCPeerConnection (viewer's main stream PC)
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe (off ref)
let _rtcSignalRef    = null;   // RTDB ref being listened to

// Host: per-viewer peer connections for main stream broadcast
// uid → { pc, signalUnsub, appliedCandKeys }
let _hostViewerPeers = {};

// Auto-reconnect for viewers
// Fix: no hard cap on reconnect attempts — keep trying as long as the page is open
let _viewerReconnectTimer   = null;
let _viewerReconnectAttempt = 0;
const _MAX_RECONNECT_ATTEMPTS = 9999;  // effectively unlimited for the 2-week test

/* ── Viewer presence heartbeat (separate from 8s guest heartbeat) ── */
let _viewerPresenceHeartbeatInterval = null;
const _VIEWER_PRESENCE_HB_MS = 30000; // 30 s keep-alive write to RTDB

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _likesRef         = null;   // RTDB ref for host likes listener
let _likesUnsub       = null;   // onValue unsubscribe for likes (host only)

let _roomWatchRef     = null;   // saved RTDB ref so we can call off() on it
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

/* ══════════════════════════════════════════════════
   GUEST BOX CONFIGURATION — change here to update max
   ══════════════════════════════════════════════════ */
const _MAX_GUESTS = 9;   // Maximum simultaneous guest boxes (1–9 supported)

/* ── Guest Box State ── */
let _guestLayout       = 'auto';   // current layout preference
let _guestBoxSize      = 'sm';     // 'sm' | 'md' | 'lg'
let _guestPeers        = {};       // uid → { pc, stream, cell, name }
let _guestReqUnsub     = null;     // RTDB listener for incoming requests (host)
let _guestStatusUnsub  = null;     // RTDB listener for request status (viewer)
let _layoutPanelOpen   = false;
let _guestStream       = null;     // viewer's own guest media stream
let _guestCamOn        = true;     // viewer's guest cam state
let _guestMicOn        = true;     // viewer's guest mic state
let _shownReqUids      = new Set(); // host: tracks UIDs already shown in request queue
let _viewerGuestUnsub  = null;     // viewer: RTDB listener for liveGuests presence
let _layoutSyncUnsub   = null;     // viewer/guest: RTDB listener for layout sync
let _guestPc              = null;  // viewer-in-box: their own guest RTCPeerConnection (for disconnect cleanup)
let _guestSigUnsub        = null;  // viewer-in-box: unsubscribe for host-ICE signaling onValue listener
let _guestRemovedUnsub    = null;  // viewer-in-box: unsubscribe for removedByHost onValue listener
let _hostSigUnsubs        = {};    // host: uid → onValue unsubscribe for per-guest signaling listener

// Host: relay guest streams to viewers
// guestUid → { viewerUid → { pc, signalUnsub } }
let _hostRelayPeers   = {};
// Host: unsub for the viewers-joined listener used to relay guest streams to new viewers
let _hostViewerListenUnsub = null;
// Viewer: guestUid → { pc, signalUnsub } for guest relay streams
let _viewerRelayPeers   = {};
// Guards concurrent subscribe calls for the same guestUid (prevents duplicate relay PCs)
const _viewerRelayPending = new Set();
// Viewer: unsub for guestViewerSignaling listener
let _viewerRelayListenUnsub = null;

/* ── Disconnect / heartbeat state ── */
let _guestHeartbeatInterval = null;  // guest: periodic presence keep-alive writer
let _hostWatchdogInterval   = null;  // host: periodic sweep for stale guest presence entries
const _HEARTBEAT_INTERVAL_MS = 8000; // every 8 s the guest writes a timestamp
const _STALE_THRESHOLD_MS    = 18000; // >18 s without heartbeat → guest is gone

/* ── DOM refs (resolved after DOMContentLoaded) ── */
let D = {};

/* ═══════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  D = {
    loading:         document.getElementById('liveLoading'),
    setup:           document.getElementById('liveSetup'),
    stage:           document.getElementById('liveStage'),
    ended:           document.getElementById('liveEndedOverlay'),
    toast:           document.getElementById('liveToast'),
    unmutePrompt:    document.getElementById('liveUnmutePrompt'),

    setupPreview:    document.getElementById('setupPreview'),
    setupPreviewOff: document.getElementById('setupPreviewOff'),
    setupTitle:      document.getElementById('setupTitleInput'),
    setupCamBtn:     document.getElementById('setupBtnCam'),
    setupMicBtn:     document.getElementById('setupBtnMic'),
    setupFlipBtn:    document.getElementById('setupBtnFlip'),
    goLiveBtn:       document.getElementById('btnGoLive'),

    liveVideo:       document.getElementById('liveVideo'),
    camOffOverlay:   document.getElementById('liveCamOffOverlay'),
    topBar:          document.getElementById('liveTopBar'),
    liveBadge:       document.getElementById('liveBadge'),
    creatorName:     document.getElementById('liveCreatorName'),
    creatorAvatar:   document.getElementById('liveCreatorAvatar'),
    viewerCount:     document.getElementById('liveViewerCount'),
    likeCount:       document.getElementById('liveLikeCount'),
    connBanner:      document.getElementById('liveConnBanner'),
    connTitle:       document.getElementById('liveConnTitle'),
    connSub:         document.getElementById('liveConnSub'),

    // Creator controls
    btnCam:          document.getElementById('btnToggleCam'),
    btnMic:          document.getElementById('btnToggleMic'),
    btnFlip:         document.getElementById('btnFlipCam'),
    btnFS:           document.getElementById('btnFullscreen'),
    btnEnd:          document.getElementById('btnEndLive'),
    btnShareCreator: document.getElementById('btnShareLiveCreator'),

    // Viewer controls
    likeBtn:         document.getElementById('btnLike'),
    likeBtnCount:    document.getElementById('likeBtnCount'),
    profileBtn:      document.getElementById('btnCreatorProfile'),
    btnShare:        document.getElementById('btnShareLive'),

    // Chat
    chatMessages:    document.getElementById('liveChatMessages'),
    chatInput:       document.getElementById('liveChatInput'),
    chatSend:        document.getElementById('liveChatSend'),

    // Ended overlay
    endedTitle:      document.getElementById('endedTitle'),
    endedSub:        document.getElementById('endedSub'),
    endedBackBtn:    document.getElementById('endedBackBtn'),

    // Guest box system
    guestGrid:           document.getElementById('guestGrid'),
    guestRequestQueue:   document.getElementById('guestRequestQueue'),
    btnRequestBox:       document.getElementById('btnRequestBox'),
    btnRequestBoxLabel:  document.getElementById('btnRequestBoxLabel'),
    btnGuestCam:         document.getElementById('btnGuestCam'),
    btnGuestCamLabel:    document.getElementById('btnGuestCamLabel'),
    btnGuestMic:         document.getElementById('btnGuestMic'),
    btnGuestMicLabel:    document.getElementById('btnGuestMicLabel'),
    btnLeaveBox:         document.getElementById('btnLeaveBox'),
    btnLayoutSettings:   document.getElementById('btnLayoutSettings'),
    layoutSettingsPanel: document.getElementById('layoutSettingsPanel'),
  };

  // Disable Go Live until Firebase auth resolves
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; }

  // Wire up static buttons
  D.setupCamBtn  && D.setupCamBtn.addEventListener('click', toggleSetupCam);
  D.setupMicBtn  && D.setupMicBtn.addEventListener('click', toggleSetupMic);
  D.setupFlipBtn && D.setupFlipBtn.addEventListener('click', flipSetupCamera);
  D.goLiveBtn    && D.goLiveBtn.addEventListener('click', startLive);

  D.btnCam  && D.btnCam.addEventListener('click',   () => toggleLiveCam());
  D.btnMic  && D.btnMic.addEventListener('click',   () => toggleLiveMic());
  D.btnFlip && D.btnFlip.addEventListener('click',  () => flipLiveCamera());
  D.btnFS   && D.btnFS.addEventListener('click',    toggleFullscreen);
  D.btnEnd  && D.btnEnd.addEventListener('click',   endLive);

  D.likeBtn          && D.likeBtn.addEventListener('click',          sendLike);
  D.btnShare         && D.btnShare.addEventListener('click',         shareLive);
  D.btnShareCreator  && D.btnShareCreator.addEventListener('click',  shareLive);
  D.chatSend  && D.chatSend.addEventListener('click',  sendChat);
  D.chatInput && D.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  D.endedBackBtn && D.endedBackBtn.addEventListener('click', () => {
    window.location.href = 'aurenix.html#live';
  });

  document.getElementById('liveCloseBtn') &&
    document.getElementById('liveCloseBtn').addEventListener('click', onCloseBtn);

  // Guest box button wiring
  D.btnRequestBox     && D.btnRequestBox.addEventListener('click', _viewerRequestBox);
  D.btnGuestCam       && D.btnGuestCam.addEventListener('click', _toggleGuestCam);
  D.btnGuestMic       && D.btnGuestMic.addEventListener('click', _toggleGuestMic);
  D.btnLeaveBox       && D.btnLeaveBox.addEventListener('click', _guestLeaveBox);
  D.btnLayoutSettings && D.btnLayoutSettings.addEventListener('click', _toggleLayoutPanel);

  // Live Settings panel wiring (host only)
  const _btnLiveSettings = document.getElementById('btnLiveSettings');
  if (_btnLiveSettings) {
    _btnLiveSettings.addEventListener('click', () => {
      const panel = document.getElementById('liveSettingsPanel');
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
    });
  }
  document.getElementById('toggleAISafety') &&
    document.getElementById('toggleAISafety').addEventListener('change', e => {
      _aiSafetySetEnabled(e.target.checked);
    });
  document.getElementById('toggleShadowBot') &&
    document.getElementById('toggleShadowBot').addEventListener('change', e => {
      _shadowBotSetEnabled(e.target.checked);
    });
  document.getElementById('toggleLiveTimer') &&
    document.getElementById('toggleLiveTimer').addEventListener('change', e => {
      _liveTimerSetEnabled(e.target.checked);
    });

  document.getElementById('toggleInternetQuality') &&
    document.getElementById('toggleInternetQuality').addEventListener('change', e => {
      _iqSetEnabled(e.target.checked);
    });

  // Layout option buttons
  document.querySelectorAll('.layout-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestLayout = btn.dataset.layout;
      _applyGuestLayout();
      // Broadcast layout change to all viewers and guests
      _broadcastLayout();
    });
  });

  // Box size buttons
  document.querySelectorAll('.layout-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestBoxSize = btn.dataset.size;
      _applyGuestLayout();
      // Broadcast size change to all viewers and guests
      _broadcastLayout();
    });
  });

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge',
                    '.layout-settings-panel','.layout-option-btn','.layout-size-btn',
                    '.live-settings-panel','#liveSettingsPanel','.lsp-row','.lsp-toggle','.lsp-slider'];
    if (ignore.some(s => e.target.closest(s))) return;
    // Close layout panel on tap-away
    if (_layoutPanelOpen) { _closeLayoutPanel(); return; }
    // Close settings panel on tap-away
    const sp = document.getElementById('liveSettingsPanel');
    if (sp && sp.style.display !== 'none') { sp.style.display = 'none'; return; }
    D.stage.classList.toggle('live-controls-hidden');
  });

  onAuthChange(user => {
    if (!user) {
      _hideLoading();
      window.location.href = 'aurenix.html#live';
      return;
    }
    _user = user;
    _loadUserData().then(() => {
      if (D.goLiveBtn) { D.goLiveBtn.disabled = false; }
      _resolveMode();
      // ── One-time update check per session ──
      _checkForUpdate();
    });
  });
});

/* ── Load Firebase user profile from Firestore ── */
async function _loadUserData() {
  try {
    _userData = await loadUserProfile(_user.uid);
    if (!_userData) {
      // Profile row missing — create it so the user never appears as "Unknown"
      const fallbackName = _user.displayName || _user.email?.split('@')[0] || 'Wave User';
      const profileData = {
        uid:                _user.uid,
        id:                 _user.uid,
        display_name:       fallbackName,
        display_name_lower: fallbackName.toLowerCase(),
        username:           '',
        email:              _user.email || '',
        avatar:             _user.photoURL || '',
        bio:                '',
        role:               'member',
        followers:          [],
        following:          [],
        follower_count:     0,
        following_count:    0,
        is_live:            false,
        live_room_id:       null,
      };
      await upsertUserProfile(profileData);
      _userData = profileData;
    }
  } catch (_) {
    const fallbackName = _user.email?.split('@')[0] || 'Guest';
    _userData = { display_name: fallbackName, username: '' };
  }
}

/* ── Display-name helper (replaces snxGetDisplayName) ── */
function _getDisplayName(userData, user) {
  return userData?.display_name || userData?.username || user?.email?.split('@')[0] || 'User';
}

/* ── Founder kill-switch: site_settings.live_enabled ── */
async function _checkLiveFeatureFlag() {
  const enabled = await getFeatureFlag('live_enabled', true);
  if (!enabled) {
    _hideLoading();
    document.body.innerHTML =
      '<div style="min-height:100vh;background:#0B1F3A;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;padding:32px 24px;text-align:center;font-family:system-ui,sans-serif;">' +
      '<div style="font-size:52px;margin-bottom:20px;">📡</div>' +
      '<div style="font-size:22px;font-weight:700;color:#d8eeff;margin-bottom:12px;">Feature Temporarily Disabled</div>' +
      '<div style="font-size:15px;color:#9bbdd8;max-width:380px;line-height:1.75;margin-bottom:28px;">' +
      'Live streaming is currently unavailable.<br>Please check back soon — it will be back!</div>' +
      '<a href="aurenix.html#live" style="display:inline-block;padding:10px 28px;background:rgba(0,174,239,0.15);' +
      'border:1px solid rgba(0,174,239,0.5);color:#00aeef;border-radius:24px;text-decoration:none;' +
      'font-size:14px;font-weight:600;">← Back to AURENIX</a>' +
      '</div>';
    return false;
  }
  return true;
}

/* ── Decide mode from URL hash ── */
async function _resolveMode() {
  const hash   = location.hash;
  const params = new URLSearchParams(location.search);
  localStorage.removeItem('snx_live_intent');

  // Check Firestore kill-switch before any live setup
  const enabled = await _checkLiveFeatureFlag();
  if (!enabled) return;

  // Viewer entry via hash:  live.html#watch=<roomId>  (Share/Join links)
  // Viewer entry via query: live.html?room=<roomId>   (home/search/notifications/profile cards)
  const watchRoomId = hash.startsWith('#watch=')
    ? hash.slice(7)
    : (params.get('room') || null);

  if (watchRoomId) {
    _roomId = watchRoomId;
    _mode   = 'viewer';
    document.body.classList.add('is-viewer');
    await _startViewer();
  } else {
    _mode = 'creator';
    document.body.classList.add('is-creator');
    await _startCreatorSetup();
  }
}

/* ═══════════════════════════════════════════════════
   CREATOR SETUP
   ═══════════════════════════════════════════════════ */
async function _startCreatorSetup() {
  _hideLoading();
  if (D.setup) D.setup.style.display = 'block';

  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      // Default: 720p 30fps — safe for 5G/4G (adaptive quality shifts tiers automatically)
      video: {
        facingMode:  _facingMode,
        width:       { ideal: 1280 },
        height:      { ideal: 720  },
        frameRate:   { ideal: 30, max: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _updateSetupPreviewState(true);
  } catch (err) {
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      _camOn = false;
      _updateSetupPreviewState(false);
      toast('Camera is audio only');
    } catch (e) {
      _showSetupPermError('Camera & mic access denied. Allow Camera + Microphone in your browser settings, then refresh.');
    }
  }
}

function _showSetupPermError(msg) {
  toast(msg);
  const existing = document.getElementById('_snxSetupPermError');
  if (existing) { existing.textContent = msg; return; }
  const banner = document.createElement('div');
  banner.id = '_snxSetupPermError';
  banner.style.cssText = [
    'width:100%', 'background:rgba(180,0,30,0.18)', 'border:1px solid rgba(255,50,70,0.55)',
    'border-radius:10px', 'padding:12px 14px', 'font-size:13px', 'color:#ff8899',
    'line-height:1.5', 'text-align:center',
  ].join(';');
  banner.textContent = msg;
  const input = document.getElementById('setupTitleInput');
  if (input && input.parentNode) {
    input.parentNode.insertBefore(banner, input);
  } else if (D.goLiveBtn && D.goLiveBtn.parentNode) {
    D.goLiveBtn.parentNode.insertBefore(banner, D.goLiveBtn);
  }
  if (D.goLiveBtn) {
    D.goLiveBtn.disabled = true;
    D.goLiveBtn.title = 'Camera & mic access required';
  }
}

function _updateSetupPreviewState(hasVideo) {
  if (!D.setupPreviewOff) return;
  D.setupPreviewOff.classList.toggle('visible', !hasVideo);
  if (D.setupPreview) D.setupPreview.style.display = hasVideo ? 'block' : 'none';
}

function toggleSetupCam() {
  _camOn = !_camOn;
  if (_localStream) {
    _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  }
  _updateSetupPreviewState(_camOn && !!(_localStream?.getVideoTracks().length));
  if (D.setupCamBtn) {
    D.setupCamBtn.querySelector('.setup-ctrl-icon').textContent = '📷';
    D.setupCamBtn.classList.toggle('off', !_camOn);
    D.setupCamBtn.querySelector('span:last-child').textContent  = _camOn ? 'Cam' : 'Cam Off';
  }
}

function toggleSetupMic() {
  _micOn = !_micOn;
  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  }
  if (D.setupMicBtn) {
    D.setupMicBtn.querySelector('.setup-ctrl-icon').textContent = _micOn ? '🎤' : '🔇';
    D.setupMicBtn.classList.toggle('off', !_micOn);
    D.setupMicBtn.querySelector('span:last-child').textContent  = _micOn ? 'Mic' : 'Mic Off';
  }
}

async function flipSetupCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
  }
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _camOn = true;
    _updateSetupPreviewState(true);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   START LIVE (creator)
   ═══════════════════════════════════════════════════ */
async function startLive() {
  if (!_user) {
    toast('Please wait…');
    return;
  }
  if (_user.isAnonymous) {
    toast('Sign in to go live.');
    return;
  }
  if (!_localStream || !_localStream.getTracks().length) {
    toast('Camera or mic not available. Check permissions and refresh.');
    return;
  }

  // ── Kill any previous stuck live session for this user ──
  try {
    const prevProfile = await loadUserProfile(_user.uid);
    const prevRoomId = prevProfile?.live_room_id;
    if (prevRoomId) {
      await _dbUpdate('live_rooms', prevRoomId, { status: 'ended', is_live: false, ended_at: new Date().toISOString() });
      // Clean up signaling channels
      _removeChannel(`live-signal-${prevRoomId}`);
    }
    await _dbUpdate('users', _user.uid, { is_live: false, live_room_id: null });
    // Clean up any orphaned live posts in Firestore
    try {
      const orphanQ = _fbQuery(_fbCollection(_fbDb, 'posts'),
        _fbWhere('uid', '==', _user.uid), _fbWhere('type', '==', 'live'));
      const orphanSnap = await _fbGetDocs(orphanQ);
      orphanSnap.forEach(d => _fbDeleteDoc(d.ref).catch(() => {}));
    } catch(_) {}
  } catch (_) {}

  const titleVal = (D.setupTitle?.value || '').trim();
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; D.goLiveBtn.textContent = 'Going Live…'; }

  // Sanitize uid — strip any chars forbidden in channel names (. # $ / [ ])
  const _safeUid = _user.uid.replace(/[.#$/\[\]]/g, '_');
  _roomId = `${_safeUid}_${Date.now().toString(36)}`;

  _roomHostId = _user.uid;   // creator is always their own host

  const creatorData = {
    id:            _roomId,
    host_id:       _user.uid,
    host_name:     _getDisplayName(_userData, _user),
    host_username: _userData.username || '',
    host_avatar:   _userData.avatar || '',
    title:         titleVal || 'Shadow Nexus Wave',
    status:        'live',
    is_live:       true,
    viewers:       0,
    likes:         0,
  };

  /* ── Write room to Supabase live_rooms ── */
  try {
    await _dbSet('live_rooms', creatorData);
  } catch (e) {
    toast('Could not start live. Please try again.');
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = 'Start Live'; }
    return;
  }

  /* ── Guard: prevent accidental cleanup if page unloads during live ── */
  _creatorEndedFlag = false;
  window.addEventListener('beforeunload', _creatorBeforeUnload);
  // pagehide with persisted=true means the page entered bfcache (mobile tab-switch).
  // Do NOT stop camera tracks in that case — the host is just backgrounding the app.
  // Only clean up on a true navigation-away (persisted=false).
  window.addEventListener('pagehide', (e) => { if (!e.persisted) _creatorBeforeUnload(); });

  // Fix: keep broadcaster camera active in background — on visibilitychange restore,
  // check whether the local stream tracks are still live and re-attach if not.
  // This catches the iOS/Android case where the camera track silently ends when
  // the user backgrounds the app for more than ~30 seconds.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || _creatorEndedFlag || !_roomId) return;
    if (!_localStream) return;
    const videoTracks = _localStream.getVideoTracks();
    const allLive = videoTracks.length > 0 && videoTracks.every(t => t.readyState === 'live');
    if (!allLive) {
      console.log('[Creator] Camera track ended in background — reacquiring stream');
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        // Stop old tracks first
        _localStream.getTracks().forEach(t => t.stop());
        _localStream = fresh;
        // Re-attach to stage
        if (D.liveVideo) { D.liveVideo.srcObject = fresh; D.liveVideo.play().catch(() => {}); }
        // Replace tracks in all active viewer PCs
        const newVid = fresh.getVideoTracks()[0];
        const newAud = fresh.getAudioTracks()[0];
        for (const { pc } of Object.values(_hostViewerPeers)) {
          if (newVid) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) s.replaceTrack(newVid).catch(() => {}); }
          if (newAud) { const s = pc.getSenders().find(s => s.track?.kind === 'audio'); if (s) s.replaceTrack(newAud).catch(() => {}); }
        }
        console.log('[Creator] Camera stream restored after background');
      } catch(e) {
        console.warn('[Creator] Could not reacquire camera after background:', e.name);
      }
    }
  });

  if (D.setup) D.setup.style.display = 'none';
  _showStage();
  _attachLocalVideoToStage();
  _populateCreatorInfo(creatorData);

  await _startCreatorWebRTC();

  _subscribeChat();
  _subscribeViewerCount();
  _showCreatorShareBar();

  // ── Start listening for guest box requests ──
  _hostListenForGuestRequests();

  // ── Watch for new viewers joining so we can relay guest streams to them ──
  _hostStartWatchingViewers();

  // ── Attach resize observer so guest grid re-layouts on any screen change ──
  _attachGuestGridResizeObserver();

  // ── Publish host's own presence to guest broadcast channel ──
  try {
    await _rtBroadcast(`live-guests-${_roomId}`, 'presence', {
      uid:      _user.uid,
      name:     creatorData.host_name,
      avatar:   creatorData.host_avatar,
      isHost:   true,
      camOn:    _camOn,
      micOn:    _micOn,
      joinedAt: Date.now(),
    });
  } catch (_) {}

  toast('🔴 You are LIVE!');

  // ── Notify add-on modules (co-host, etc.) that live has started ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    supabase,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: true,
  }}));

  // ── Start optional systems (respects their individual ON/OFF state) ──
  _liveTimerOnLiveStart();
  _shadowBotOnLiveStart();
  _aiSafetyOnLiveStart();
  _iqOnLiveStart();

  // ── Non-critical side-work ──
  try {
    await _dbUpdate('users', _user.uid, { is_live: true, live_room_id: _roomId });
  } catch (_) {}
  // _createLiveFeedPost intentionally omitted — live sessions must not create
  // feed posts; they appear only in the story bar and Live Hub.
  _createLiveStory(creatorData);
  _notifyFollowersLive(creatorData);
}

function _attachLocalVideoToStage() {
  if (!D.liveVideo || !_localStream) return;
  D.liveVideo.srcObject = _localStream;
  D.liveVideo.play().catch(() => {});
  D.camOffOverlay && D.camOffOverlay.classList.toggle('visible', !_camOn);
}

/* ── Share bar: big visible URL strip shown on the live stage ──
   Creator sees their exact watch link immediately so they can copy
   and send it without going through the share modal.              */
function _showCreatorShareBar() {
  const old = document.getElementById('_snxCreatorShareBar');
  if (old) old.remove();

  const url = _buildLiveUrl();

  const bar = document.createElement('div');
  bar.id = '_snxCreatorShareBar';
  bar.style.cssText = [
    'position:absolute', 'top:64px', 'left:50%',
    'transform:translateX(-50%)',
    'z-index:50', 'max-width:calc(100vw - 24px)', 'width:420px',
    'background:rgba(0,10,30,0.93)',
    'border:1.5px solid rgba(0,174,239,0.7)',
    'border-radius:12px', 'padding:10px 14px',
    'display:flex', 'align-items:center', 'gap:10px',
    'backdrop-filter:blur(8px)',
  ].join(';');

  bar.innerHTML = `
    <div style="flex:1;min-width:0;">
      <div style="font-size:10px;color:#6a90b8;margin-bottom:3px;letter-spacing:.5px;text-transform:uppercase;">Your watch link — share this!</div>
      <div id="_snxShareUrlText" style="font-size:12px;color:#00AEEF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;">${url}</div>
    </div>
    <button id="_snxCopyShareUrl" style="
      flex-shrink:0;padding:8px 14px;border-radius:8px;
      background:rgba(0,174,239,0.2);border:1px solid rgba(0,174,239,0.6);
      color:#00AEEF;font-size:12px;font-weight:700;cursor:pointer;
      white-space:nowrap;
    ">📋 Copy</button>
    <button id="_snxDismissShareBar" style="
      flex-shrink:0;width:28px;height:28px;border-radius:50%;
      background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
      color:#aaa;font-size:14px;cursor:pointer;
    ">✕</button>
  `;

  // Copy button
  bar.querySelector('#_snxCopyShareUrl').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => toast('✅ Link copied! Send it to your viewers.'))
        .catch(() => window.prompt('Copy your watch link:', url));
    } else {
      window.prompt('Copy your watch link:', url);
    }
  });

  // Dismiss
  bar.querySelector('#_snxDismissShareBar').addEventListener('click', () => bar.remove());

  // Auto-dismiss after 60 s
  setTimeout(() => bar.remove(), 60000);

  const stage = document.getElementById('liveStage');
  const videoWrap = stage?.querySelector('.live-video-wrap');
  (videoWrap || stage || document.body).appendChild(bar);
}

function _populateCreatorInfo(data) {
  const name   = data.host_name   || data.hostName   || '';
  const avatar = data.host_avatar || data.hostAvatar || '';
  if (D.creatorName)   D.creatorName.textContent  = name;
  if (D.creatorAvatar) {
    if (avatar) {
      D.creatorAvatar.style.backgroundImage = `url('${avatar}')`;
      D.creatorAvatar.textContent = '';
    } else {
      D.creatorAvatar.textContent = (name || '?')[0].toUpperCase();
    }
  }
}

/* ── Subscribe to viewer count + likes via Supabase Realtime Presence ── */
function _subscribeViewerCount() {
  // Use a Supabase Presence channel — each viewer tracks their own presence.
  // The host subscribes and counts sync() events to get the viewer count.
  if (_viewerCountUnsub) { try { _viewerCountUnsub(); } catch(_) {} _viewerCountUnsub = null; }

  const presenceCh = supabase.channel(`live-presence-${_roomId}`, {
    config: { presence: { key: _user.uid } }
  });

  let _lastMirroredViewers = -1;
  let _lastLikes = 0;

  presenceCh
    .on('presence', { event: 'sync' }, () => {
      const state = presenceCh.presenceState();
      const v = Object.keys(state).length;
      if (D.viewerCount) D.viewerCount.textContent = '👁 ' + v;
      if (v !== _lastMirroredViewers && _roomId) {
        _lastMirroredViewers = v;
        _dbUpdate('live_rooms', _roomId, { viewers: v }).catch(() => {});
      }
    })
    // Likes arrive via broadcast from viewers
    .on('broadcast', { event: 'like' }, () => {
      _lastLikes++;
      if (D.likeCount) D.likeCount.textContent = '❤️ ' + _lastLikes;
      _spawnHeartBurst();
      // Persist incremented like count
      if (_roomId) _dbUpdate('live_rooms', _roomId, { likes: _lastLikes }).catch(() => {});
    })
    .subscribe();

  _viewerCountUnsub = () => { supabase.removeChannel(presenceCh); };
}

/* ═══════════════════════════════════════════════════
   CREATOR CONTROLS — Cam / Mic / Flip / End
   ═══════════════════════════════════════════════════ */
function toggleLiveCam() {
  _camOn = !_camOn;
  if (_localStream) _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  if (D.btnCam) { D.btnCam.textContent = _camOn ? '📷' : '🚫'; D.btnCam.classList.toggle('off', !_camOn); }
  if (D.camOffOverlay) D.camOffOverlay.classList.toggle('visible', !_camOn);
  // Broadcast host cam state to viewers
  if (_roomId) _rtBroadcast(`live-guests-${_roomId}`, 'host-cam', { camOn: _camOn }).catch(() => {});
}

function toggleLiveMic() {
  _micOn = !_micOn;
  if (_localStream) _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  if (D.btnMic) { D.btnMic.textContent = _micOn ? '🎤' : '🔇'; D.btnMic.classList.toggle('off', !_micOn); }
  toast(_micOn ? 'Mic on' : 'Mic muted');
  // Broadcast host mic state to viewers
  if (_roomId) _rtBroadcast(`live-guests-${_roomId}`, 'host-mic', { micOn: _micOn }).catch(() => {});
}

async function flipLiveCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });

    // ── Stop old tracks AFTER new stream is ready to prevent any black-frame gap ──
    _localStream = newStream;

    if (D.liveVideo) {
      D.liveVideo.srcObject = newStream;
      D.liveVideo.play().catch(() => {});
    }

    // ── Update the host's own cell in the guest grid so it never goes dark ──
    if (D.guestGrid) {
      const hostCell = D.guestGrid.querySelector('.host-cell');
      if (hostCell) {
        const hostVid = hostCell.querySelector('video');
        if (hostVid) {
          hostVid.srcObject = newStream;
          hostVid.play().catch(() => {});
        }
      }
    }

    // ── Replace video track in the main viewer WebRTC connection ──
    if (_rtcPc && newStream.getVideoTracks()[0]) {
      const newVideoTrack = newStream.getVideoTracks()[0];
      const sender = _rtcPc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack).catch(() => {});
      }
    }

    // ── Replace video track in all active guest peer connections ──
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (newVideoTrack) {
      for (const uid of Object.keys(_guestPeers)) {
        const peer = _guestPeers[uid];
        if (peer && peer.pc) {
          const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(newVideoTrack).catch(() => {});
        }
      }
    }

    // ── Now stop old tracks (after all replacements are done) ──
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());

  } catch (e) {
    toast('Could not flip camera.');
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

/* ── Creator page unload guard — only fires if endLive() was NOT called ── */
function _creatorBeforeUnload() {
  if (_creatorEndedFlag || !_roomId) return;
  // Can't do async work in beforeunload; Supabase Presence auto-cleans on disconnect.
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
}

async function endLive() {
  if (_creatorEndedFlag) return;   // prevent double-call
  _creatorEndedFlag = true;

  // Supabase Presence auto-cleans on disconnect, so no trigger to cancel
  if (_roomId) {
  window.removeEventListener('beforeunload', _creatorBeforeUnload);
  window.removeEventListener('pagehide',     _creatorBeforeUnload);

  // Stop adaptive quality monitor
  _stopAdaptiveQuality();

  // Close all guest peer connections and host relay peers
  _teardownAllGuestPeers();
  if (_guestReqUnsub) { try { _guestReqUnsub(); } catch(_){} _guestReqUnsub = null; }

  // Tear down all per-viewer WebRTC connections (multi-viewer broadcast)
  _hostTeardownAllViewerPeers();
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }

  // Tear down all relay PCs (host→viewer per-guest relay)
  _hostTeardownAllRelayPeers();
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountUnsub) { try { _viewerCountUnsub(); } catch(_) {} _viewerCountRef = null; _viewerCountUnsub = null; }

  // Remove signaling broadcast channels
  if (_roomId) {
    _removeChannel(`live-signal-${_roomId}`);
    _removeChannel(`live-guests-${_roomId}`);
    _removeChannel(`live-guest-sig-${_roomId}`);
    _removeChannel(`live-relay-sig-${_roomId}`);
    _removeChannel(`live-presence-${_roomId}`);
  }

  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }

  /* ── Mark room as ended in Supabase ── */
  const _endedRoomId = _roomId;
  try {
    await _dbUpdate('live_rooms', _endedRoomId, {
      status:   'ended',
      is_live:  false,
      ended_at: new Date().toISOString(),
    });
  } catch (_) {}

  /* ── Clear live status from user profile ── */
  try {
    await _dbUpdate('users', _user.uid, { is_live: false, live_room_id: null });
  } catch (_) {}

  /* ── Delete live feed post (safety net) ── */
  if (_feedPostId) {
    try { await _fbDeleteDoc(_fbDoc(_fbDb, 'posts', _feedPostId)); } catch(_) {}
    _feedPostId = null;
  }

  /* ── Mark share posts as ended in Firestore ── */
  try {
    const shareQ = _fbQuery(_fbCollection(_fbDb, 'posts'),
      _fbWhere('live_room_id', '==', _endedRoomId),
      _fbWhere('type', '==', 'live_share'));
    const shareSnap = await _fbGetDocs(shareQ);
    shareSnap.forEach(d => _fbUpdateDoc(d.ref, { is_live: false }).catch(() => {}));
  } catch (_) {}

  /* ── Schedule room deletion after 5 min ── */
  setTimeout(async () => {
    try { await _dbDelete('live_rooms', _endedRoomId); } catch (_) {}
  }, 5 * 60 * 1000);

  _deleteLiveStory();

  // ── Stop optional systems ──
  _liveTimerOnLiveEnd();
  _shadowBotOnLiveEnd();
  _aiSafetyOnLiveEnd();
  _iqOnLiveEnd();

  // ── Co-host cleanup (no-op if cohost.js is not loaded) ──
  if (typeof window._cohostCleanup === 'function') { try { window._cohostCleanup(); } catch(_){} }

  _showEndedOverlay(true);
}

/* ═══════════════════════════════════════════════════
   LIVE FEED POST — Firestore `posts` collection
   ═══════════════════════════════════════════════════ */
async function _createLiveFeedPost(creatorData) {
  if (!_user || !_roomId) return;
  try {
    const ref = await _fbAddDoc(_fbCollection(_fbDb, 'posts'), {
      type:          'live',
      uid:           _user.uid,
      author_name:   creatorData.host_name     || '',
      author_handle: creatorData.host_username || '',
      author_avatar: creatorData.host_avatar   || '',
      live_room_id:  _roomId,
      is_live:       true,
      title:         creatorData.title || 'Shadow Nexus Wave',
      text:          (creatorData.host_name || '') + ' is Live now 🔴',
      likes:         0,
      created_at:    _fbServerTs(),
    });
    _feedPostId = ref.id;
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   LIVE STORY — Firestore `stories` collection
   ═══════════════════════════════════════════════════ */
function _liveStoryId() {
  return `live_${_user.uid}`;
}

async function _createLiveStory(creatorData) {
  if (!_user || !_roomId) return;
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  try {
    await _fbSetDoc(_fbDoc(_fbDb, 'stories', _liveStoryId()), {
      id:            _liveStoryId(),
      uid:           _user.uid,
      author_name:   creatorData.host_name     || '',
      author_handle: creatorData.host_username || '',
      author_avatar: creatorData.host_avatar   || '',
      type:          'live',
      live_room_id:  _roomId,
      title:         creatorData.title || 'Shadow Nexus Wave',
      expires_at:    expiresAt,
    }, { merge: true });
  } catch (_) {}
}

async function _deleteLiveStory() {
  if (!_user) return;
  try {
    await _fbDeleteDoc(_fbDoc(_fbDb, 'stories', _liveStoryId()));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   FOLLOWER LIVE NOTIFICATIONS — Firestore `notifications`
   ═══════════════════════════════════════════════════ */
async function _notifyFollowersLive(creatorData) {
  if (!_user) return;
  try {
    const profile = await loadUserProfile(_user.uid);
    if (!profile) return;
    const followers = profile.followers || [];
    if (!followers.length) return;

    const notifBase = {
      type:        'live',
      from_uid:    _user.uid,
      from_name:   creatorData.host_name   || '',
      from_avatar: creatorData.host_avatar || '',
      room_id:     _roomId,
      room_title:  creatorData.title       || 'Shadow Nexus Wave',
      title:       '🔴 ' + (creatorData.host_name || '') + ' is Live',
      body:        `${creatorData.host_name || ''} is live: ${creatorData.title || 'Shadow Nexus Wave'}`,
      url:         'live.html#watch=' + _roomId,
      read:        false,
      created_at:  _fbServerTs(),
    };

    // Write one Firestore notification per follower
    await Promise.all(followers.map(fId =>
      _fbAddDoc(_fbCollection(_fbDb, 'notifications'), { ...notifBase, uid: fId, recipient_id: fId })
        .catch(() => {})
    ));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   VIEWER — join a live stream
   ═══════════════════════════════════════════════════ */
async function _startViewer() {
  let roomData = null;

  const _MAX_RETRIES = 8;
  const _RETRY_MS    = 2000;

  for (let attempt = 0; attempt < _MAX_RETRIES; attempt++) {
    try {
      roomData = await _dbGet('live_rooms', _roomId);
      if (roomData && roomData.status === 'live') break;
      if (roomData && roomData.status === 'ended') {
        _hideLoading();
        _showEndedOverlay(false, 'Stream ended', 'This live stream has already ended.');
        return;
      }
      roomData = null;
    } catch (e) {
      _hideLoading();
      toast('Could not connect. Please try again.');
      return;
    }
    if (attempt === 0) {
      _hideLoading();
      _showStage();
      _showConnBanner('Waiting for stream…', '');
    }
    await new Promise(r => setTimeout(r, _RETRY_MS));
  }

  if (!roomData) {
    _showEndedOverlay(false, 'Stream ended', 'This live stream has ended or does not exist.');
    return;
  }

  _roomHostId = roomData.host_id || null;   // store real host uid for chat badge

  _hideLoading();
  _showStage();
  _hideConnBanner();
  _populateCreatorInfo(roomData);
  _setupViewerControls(roomData);
  _subscribeChat();

  // ── Notify add-on modules that viewer has joined ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    supabase,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: false,
  }}));

  /* ── Subscribe to live guest presence (shows guest boxes to viewers) ── */
  _startViewerGuestGrid();

  /* ── Subscribe to host layout changes so everyone sees the same layout ── */
  _startLayoutSync();

  /* ── Attach resize observer so guest grid re-layouts on any screen change ── */
  _attachGuestGridResizeObserver();

  /* ── Register viewer presence via Supabase Realtime Presence ── */
  if (_user && _roomId) {
    (async () => {
      try {
        const presenceCh = _getChannel(`live-presence-${_roomId}`);
        await presenceCh.track({ user_id: _user.uid, joined_at: Date.now() });

        // No native onDisconnect in Supabase — Realtime auto-removes presence on disconnect
        if (_viewerPresenceHeartbeatInterval) clearInterval(_viewerPresenceHeartbeatInterval);
        _viewerPresenceHeartbeatInterval = setInterval(() => {
          if (_viewerLeftFlag || !_roomId) { clearInterval(_viewerPresenceHeartbeatInterval); return; }
          presenceCh.track({ user_id: _user.uid, hb: Date.now() }).catch(() => {});
        }, _VIEWER_PRESENCE_HB_MS);
      } catch (_) {}
    })();
  }

  /* ── Watch for stream ending + viewer/like counts via Firestore onSnapshot ── */
  const watchUnsub = _fbOnSnapshot(_fbDoc(_fbDb, 'live_rooms', _roomId), snap => {
    if (!snap.exists()) {
      _showEndedOverlay(false, 'Stream ended', 'The live stream has ended.');
      return;
    }
    const d = snap.data() || {};
    const vText = '👁 ' + (d.viewers || 0);
    const lText = '❤️ ' + (d.likes   || 0);
    if (D.viewerCount && D.viewerCount.textContent !== vText) D.viewerCount.textContent = vText;
    if (D.likeCount   && D.likeCount.textContent   !== lText) D.likeCount.textContent   = lText;
    if (d.guest_layout   && d.guest_layout   !== _guestLayout)  { _guestLayout   = d.guest_layout;   _applyGuestLayout(); }
    if (d.guest_box_size && d.guest_box_size !== _guestBoxSize) { _guestBoxSize = d.guest_box_size; _applyGuestLayout(); }
    if (d.status === 'ended') {
      _showEndedOverlay(false, 'Stream ended', `${roomData.host_name || 'Creator'} has ended the live stream.`);
    }
  }, () => {
    _showEndedOverlay(false, 'Stream ended', 'The live stream has ended.');
  });
  // Store as a callable ref so _viewerLeave can clean it up
  _roomWatchRef = { unsubscribe: watchUnsub };

  // Fix: start frozen video watchdog — auto-refresh tracks if video freezes
  _startFrozenVideoWatchdog(() => roomData);

  await _startViewerWebRTC(roomData);

  window.addEventListener('beforeunload', _viewerLeave);
  // pagehide with persisted=true = mobile bfcache (user backgrounded the tab).
  // Do NOT run _viewerLeave in that case — the visibilitychange handler will
  // reset _viewerLeftFlag and trigger a reconnect when the tab comes back.
  window.addEventListener('pagehide', (e) => { if (!e.persisted) _viewerLeave(); });

  // ── bfcache restore: user pressed Back after navigating away ──
  // _viewerLeave() ran when they left (setting _viewerLeftFlag + closing PC).
  // pageshow fires with persisted=true when the browser restores from bfcache
  // rather than doing a fresh load — we must manually re-establish the stream.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;  // fresh load — normal startup already handled it
    // Reset all reconnect state so _scheduleViewerReconnect can run
    _viewerLeftFlag = false;
    _viewerReconnectAttempt = 0;
    if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
    // Re-register viewer presence via Supabase Presence (auto-removes on disconnect)
    if (_user && _roomId) {
      (async () => {
        try {
          const presCh = _getChannel(`live-presence-${_roomId}`);
          await presCh.track({ uid: _user.uid, joinedAt: Date.now() });
        } catch(_) {}
      })();
    }
    // Reconnect WebRTC immediately
    _scheduleViewerReconnect(roomData);
  });

  // ── Auto-reconnect on network restore ──
  // If the device was offline briefly and comes back, try reconnecting immediately
  // instead of waiting for the exponential back-off timer.
  window.addEventListener('online', () => {
    if (_viewerLeftFlag) return;
    const state = _rtcPc?.connectionState;
    if (state === 'disconnected' || state === 'failed' || state === 'closed' || !_rtcPc) {
      // Reset attempt counter so we get a fresh fast reconnect
      _viewerReconnectAttempt = 0;
      if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
      _scheduleViewerReconnect(roomData);
    }
  }, { once: false });

  // ── Visibility change: resume WebRTC when tab/app returns to foreground ──
  // Mobile browsers may fire pagehide/visibilitychange when the user backgrounds
  // the app. We reset _viewerLeftFlag on restore so reconnect logic can run.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // If the flag was set by a mobile background-tab pagehide event,
    // clear it now so reconnect is allowed.
    if (_viewerLeftFlag) {
      _viewerLeftFlag = false;
    }
    const state = _rtcPc?.connectionState;
    if (state === 'disconnected' || state === 'failed' || state === 'closed' || !_rtcPc) {
      _viewerReconnectAttempt = 0;
      if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
      _scheduleViewerReconnect(roomData);
    }
  });
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Cancel any pending reconnect
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }

  // If viewer was in a guest box, clean up that state first
  if (_guestStream || _guestPc) {
    if (_guestPc) { try { _guestPc.close(); } catch(_){} _guestPc = null; }
    if (_user && _roomId) {
      _rtBroadcast(`live-guests-${_roomId}`, 'guest-leave', { uid: _user.uid }).catch(() => {});
    }
    if (_guestStream) { try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_){} _guestStream = null; }
  }

  // Tear down viewer guest grid listener
  if (_viewerGuestUnsub) {
    try { _viewerGuestUnsub(); } catch(_) {}
    _viewerGuestUnsub = null;
  }

  // Tear down layout sync listener
  if (_layoutSyncUnsub) {
    try { _layoutSyncUnsub(); } catch(_) {}
    _layoutSyncUnsub = null;
  }

  // Tear down room-watch Firestore listener
  if (_roomWatchRef) {
    try { if (typeof _roomWatchRef.unsubscribe === 'function') _roomWatchRef.unsubscribe(); } catch(_) {}
    _roomWatchRef = null;
  }

  // Clean up any pending box request in Firestore
  if (_user && _roomId) {
    const requestId = `${_roomId}_${_user.uid}`;
    _fbDeleteDoc(_fbDoc(_fbDb, 'box_requests', requestId)).catch(() => {});
  }
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  // Stop frozen video watchdog
  _stopFrozenVideoWatchdog();

  if (_rtcPc) {
    _rtcPc.ontrack = null; _rtcPc.onconnectionstatechange = null;
    _rtcPc.oniceconnectionstatechange = null; _rtcPc.onicecandidate = null;
    try { _rtcPc.close(); } catch (_) {} _rtcPc = null;
  }
  if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_) {} _rtcSignalRef = null; _rtcSignalUnsub = null; }

  // Tear down viewer-side relay connections (guest video streams)
  _viewerTeardownAllRelayPeers();

  // Remove viewer's per-viewer signaling slot so host tears down its peer
  if (_user && _roomId) {
    // Signal viewer leave to host via broadcast
    _rtBroadcast(`live-signal-${_roomId}`, 'viewer-leave', { uid: _user.uid }).catch(() => {});
  }

  /* ── Stop viewer presence heartbeat ── */
  if (_viewerPresenceHeartbeatInterval) {
    clearInterval(_viewerPresenceHeartbeatInterval);
    _viewerPresenceHeartbeatInterval = null;
  }

  /* ── Untrack viewer presence ── */
  if (_user && _roomId) {
    try {
      const presenceCh = _channels[`live-presence-${_roomId}`];
      if (presenceCh) presenceCh.untrack().catch(() => {});
    } catch (_) {}
    // Note: keep channel alive for Supabase Presence counting — host removes it
    _removeChannel(`live-presence-${_roomId}`);
  }
}

function _setupViewerControls(roomData) {
  if (D.profileBtn) {
    D.profileBtn.style.display = 'flex';
    D.profileBtn.onclick = () => {
      window.location.href = 'aurenix.html#community';
    };
  }

  // Follow button — shown to viewers who are not the host
  const followBtn      = document.getElementById('btnFollowCreator');
  const followLabel    = document.getElementById('btnFollowCreatorLabel');
  const hostId         = roomData.host_id;
  if (!followBtn || !followLabel || !hostId) return;
  // Don't show follow button on your own stream
  if (_user && _user.uid === hostId) return;

  followBtn.style.display = 'flex';

  // Check current follow state
  let _liveFollowing = false;
  if (_user && _userData && Array.isArray(_userData.following)) {
    _liveFollowing = _userData.following.includes(hostId);
  }
  // Also check viewers' own uid equality
  function _updateLiveFollowBtn() {
    followLabel.textContent = _liveFollowing ? '✓ Following' : 'Follow';
    followBtn.style.opacity = _liveFollowing ? '0.7' : '1';
  }
  _updateLiveFollowBtn();

  followBtn.addEventListener('click', async () => {
    if (!_user) { toast('Sign in to follow creators.'); return; }
    if (!hostId || hostId === _user.uid) return;
    followBtn.disabled = true;
    try {
      if (_liveFollowing) {
        // Unfollow — remove from both Firestore user docs
        await _fbUpdateDoc(_fbDoc(_fbDb, 'users', hostId), {
          followers: (_userData.followers || []).filter(id => id !== _user.uid),
          updated_at: _fbServerTs(),
        });
        await _fbUpdateDoc(_fbDoc(_fbDb, 'users', _user.uid), {
          following: (_userData.following || []).filter(id => id !== hostId),
          updated_at: _fbServerTs(),
        });
        if (_userData) _userData.following = (_userData.following || []).filter(id => id !== hostId);
        _liveFollowing = false;
        toast('Unfollowed.');
      } else {
        // Follow — add to both Firestore user docs
        await _fbUpdateDoc(_fbDoc(_fbDb, 'users', hostId), {
          followers: [...new Set([...(_userData.followers || []), _user.uid])],
          updated_at: _fbServerTs(),
        });
        await _fbUpdateDoc(_fbDoc(_fbDb, 'users', _user.uid), {
          following: [...new Set([...(_userData.following || []), hostId])],
          updated_at: _fbServerTs(),
        });
        if (_userData) _userData.following = [...new Set([...(_userData.following || []), hostId])];
        _liveFollowing = true;
        toast('Following ' + (roomData.host_name || 'creator') + '!');

        // Send follow notification to Firestore
        const myName   = _getDisplayName(_userData, _user);
        const myAvatar = _userData?.avatar || '';
        _fbAddDoc(_fbCollection(_fbDb, 'notifications'), {
          type:         'follow',
          uid:          hostId,
          recipient_id: hostId,
          from_uid:     _user.uid,
          from_name:    myName,
          from_avatar:  myAvatar,
          title:        myName + ' started following you.',
          body:         myName + ' started following you.',
          url:          'aurenix.html#community',
          read:         false,
          created_at:   _fbServerTs(),
        }).catch(() => {});
      }
      _updateLiveFollowBtn();
    } catch(e) {
      toast('Error updating follow.');
    } finally {
      followBtn.disabled = false;
    }
  });
}

/* ═══════════════════════════════════════════════════
   WebRTC — CREATOR
   Uses Supabase Broadcast channels for signaling.
   ═══════════════════════════════════════════════════ */
async function _startCreatorWebRTC() {
  if (!_localStream) {
    toast('Camera or mic not available.');
    return;
  }

  // Listen on signaling channel for viewer join/answer/ICE events
  const sigCh = _getChannel(`live-signal-${_roomId}`);

  if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_) {} _rtcSignalUnsub = null; }

  sigCh
    .on('broadcast', { event: 'viewer-join' }, msg => {
      const { uid: viewerUid, sessionId } = msg.payload || {};
      if (!viewerUid) return;
      if (!_hostViewerPeers[viewerUid]) {
        _hostCreateViewerPeer(viewerUid);
      } else if (sessionId && sessionId !== _hostViewerPeers[viewerUid]?.sessionId) {
        _hostRebuildViewerPeer(viewerUid, sessionId);
      }
    })
    .on('broadcast', { event: 'viewer-answer' }, msg => {
      const { uid: viewerUid, answer } = msg.payload || {};
      if (!viewerUid || !answer) return;
      const peer = _hostViewerPeers[viewerUid];
      if (peer?.pc && peer.pc.remoteDescription === null) {
        peer.pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(() => {});
      }
    })
    .on('broadcast', { event: 'viewer-ice' }, msg => {
      const { uid: viewerUid, candidate } = msg.payload || {};
      if (!viewerUid || !candidate) return;
      const peer = _hostViewerPeers[viewerUid];
      if (peer?.pc && peer.pc.remoteDescription) {
        peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      }
    })
    .on('broadcast', { event: 'viewer-leave' }, msg => {
      const { uid: viewerUid } = msg.payload || {};
      if (viewerUid) _hostTeardownViewerPeer(viewerUid);
    });

  _rtcSignalRef   = sigCh;
  _rtcSignalUnsub = () => _removeChannel(`live-signal-${_roomId}`);

  toast('Live now');
}

/* ── HOST: Create a dedicated RTCPeerConnection for one viewer ── */
async function _hostCreateViewerPeer(viewerUid) {
  if (!_localStream || !_roomId) return;
  // Guard against double-creation
  if (_hostViewerPeers[viewerUid]) return;

  const pc = new RTCPeerConnection(_ICE_SERVERS);

  // Send our local stream to this viewer
  _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  pc.getTransceivers().forEach(tc => { tc.direction = 'sendonly'; });

  // Adaptive quality + reconnect on first connected PC
  let _hostPeerDcTimer = null;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[WebRTC-Host] Viewer ${viewerUid} peer state → ${state}`);
    if (state === 'connected') {
      if (_hostPeerDcTimer) { clearTimeout(_hostPeerDcTimer); _hostPeerDcTimer = null; }
      // Use the first successfully connected viewer PC for quality monitoring
      if (!Object.values(_hostViewerPeers).some(p => p.qualityStarted)) {
        _hostViewerPeers[viewerUid] && (_hostViewerPeers[viewerUid].qualityStarted = true);
        _startAdaptiveQuality(pc);
      }
      // Relay all currently active guest streams to this new viewer
      _hostRelayAllGuestsToViewer(viewerUid);
    } else if (state === 'disconnected') {
      // Fix: grace period then rebuild instead of teardown
      if (!_hostPeerDcTimer) {
        _hostPeerDcTimer = setTimeout(() => {
          _hostPeerDcTimer = null;
          if (pc.connectionState !== 'connected' && _hostViewerPeers[viewerUid]) {
            console.log(`[WebRTC-Host] Viewer ${viewerUid} still disconnected after grace — rebuilding peer`);
            _hostRebuildViewerPeer(viewerUid, _hostViewerPeers[viewerUid]?.sessionId || null);
          }
        }, 4000);
      }
    } else if (state === 'failed') {
      if (_hostPeerDcTimer) { clearTimeout(_hostPeerDcTimer); _hostPeerDcTimer = null; }
      console.log(`[WebRTC-Host] Viewer ${viewerUid} peer FAILED — rebuilding peer`);
      _hostRebuildViewerPeer(viewerUid, _hostViewerPeers[viewerUid]?.sessionId || null);
    } else if (state === 'closed') {
      if (_hostPeerDcTimer) { clearTimeout(_hostPeerDcTimer); _hostPeerDcTimer = null; }
      _hostTeardownViewerPeer(viewerUid);
    }
  };
  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    console.log(`[WebRTC-Host] Viewer ${viewerUid} ICE state → ${ice}`);
    if (ice === 'failed') {
      console.log(`[WebRTC-Host] Viewer ${viewerUid} ICE failed — attempting restartIce`);
      try { pc.restartIce(); } catch(_) {}
    } else if (ice === 'disconnected') {
      // ICE disconnected: attempt restart before giving up
      setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          console.log(`[WebRTC-Host] Viewer ${viewerUid} ICE still disconnected — restarting ICE`);
          try { pc.restartIce(); } catch(_) {}
        }
      }, 2500);
    }
  };

  const _pendingCands = [];
  let _offerWritten = false;

  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    _rtBroadcast(`live-signal-${_roomId}`, 'host-ice', {
      uid: viewerUid, candidate: e.candidate.toJSON()
    }).catch(() => {});
  };

  let offer;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch(e) { try { pc.close(); } catch(_){} return; }

  const peer = { pc, appliedCandKeys: new Set(), sessionId: null, qualityStarted: false };
  _hostViewerPeers[viewerUid] = peer;

  try {
    await _rtBroadcast(`live-signal-${_roomId}`, 'host-offer', {
      uid: viewerUid,
      offer: { type: offer.type, sdp: offer.sdp },
    });
    _offerWritten = true;
  } catch(e) { _hostTeardownViewerPeer(viewerUid); return; }

  // Flush buffered ICE candidates
  for (const c of _pendingCands) {
    _rtBroadcast(`live-signal-${_roomId}`, 'host-ice', { uid: viewerUid, candidate: c }).catch(() => {});
  }
}

/* ── HOST: Rebuild viewer peer after reconnect ── */
async function _hostRebuildViewerPeer(viewerUid, newSessionId) {
  const old = _hostViewerPeers[viewerUid];
  if (old) {
    if (old.pc) { try { old.pc.close(); } catch(_){} }
    delete _hostViewerPeers[viewerUid];
  }
  // Create fresh peer — will pick up the new sessionId from the RTDB slot
  await _hostCreateViewerPeer(viewerUid);
  if (_hostViewerPeers[viewerUid]) {
    _hostViewerPeers[viewerUid].sessionId = newSessionId;
  }
}

/* ── HOST: Tear down viewer peer (disconnect / leave) ── */
function _hostTeardownViewerPeer(viewerUid) {
  const peer = _hostViewerPeers[viewerUid];
  if (!peer) return;
  if (peer.pc) { try { peer.pc.close(); } catch(_){} }
  delete _hostViewerPeers[viewerUid];
}

/* ── HOST: Tear down ALL viewer peers (called on endLive) ── */
function _hostTeardownAllViewerPeers() {
  for (const uid of Object.keys(_hostViewerPeers)) {
    _hostTeardownViewerPeer(uid);
  }
  _hostViewerPeers = {};
  if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_){} _rtcSignalRef = null; _rtcSignalUnsub = null; }
}

/* ════════════════════════════════════════════════════════════════════
   GUEST STREAM RELAY (host → viewers)
   ────────────────────────────────────────────────────────────────────
   RTDB path: guestViewerSignaling/{roomId}/{guestUid}/{viewerUid}
     host writes: offer + hostCandidates
     viewer writes: answer + viewerCandidates

   When a guest is accepted by the host, the host creates a relay
   RTCPeerConnection per active viewer so each viewer receives the
   guest's video/audio directly from the host-mediated relay.

   When a new viewer joins (registers in liveConnections/viewers),
   the host detects them via _hostRelayNewViewer and relays all
   currently active guests to them.
   ════════════════════════════════════════════════════════════════════ */

/* ── HOST: Relay a specific guest's stream to a specific viewer ── */
async function _hostRelayGuestToViewer(guestUid, viewerUid, stream) {
  if (!_roomId || !stream) return;

  // Guard: don't relay host's own stream to itself (host never receives relay)
  if (viewerUid === _user?.id) return;

  // Guard: don't create duplicate relay
  if (_hostRelayPeers[guestUid] && _hostRelayPeers[guestUid][viewerUid]) return;

  const relayCh = `live-relay-sig-${_roomId}`;

  const pc = new RTCPeerConnection(_ICE_SERVERS);

  // Add the guest stream tracks to relay to this viewer
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
  pc.getTransceivers().forEach(tc => { tc.direction = 'sendonly'; });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed') {
      _hostTeardownRelayPeer(guestUid, viewerUid);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch(_) {} }
  };

  const _pendingCands = [];
  let _offerWritten = false;

  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    try { await _rtBroadcast(relayCh, 'relay-candidate', { guestUid, viewerUid, from: 'host', candidate: e.candidate.toJSON() }); } catch(_) {}
  };

  let offer;
  try {
    // sendonly relay — explicitly tell the browser not to include receive capabilities.
    // Without this, Firefox and some mobile browsers may generate sendrecv SDP which
    // causes the viewer's answer to also be sendrecv, breaking the one-way relay.
    offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
  }
  catch(e) { try { pc.close(); } catch(_){} return; }

  if (!_hostRelayPeers[guestUid]) _hostRelayPeers[guestUid] = {};
  _hostRelayPeers[guestUid][viewerUid] = { pc, appliedCandKeys: new Set(), answerUnsub: null };

  try {
    await _rtBroadcast(relayCh, 'relay-offer', { guestUid, viewerUid, offer: { type: offer.type, sdp: offer.sdp } });
    _offerWritten = true;
  } catch(e) { _hostTeardownRelayPeer(guestUid, viewerUid); return; }

  for (const c of _pendingCands) {
    try { await _rtBroadcast(relayCh, 'relay-candidate', { guestUid, viewerUid, from: 'host', candidate: c }); } catch(_) {}
  }

  // Listen for viewer's answer via Broadcast (answerUnsub is a channel unsubscribe token)
  const relay = _hostRelayPeers[guestUid]?.[viewerUid];
  if (!relay) return;

  relay.answerUnsub = _rtListen(relayCh, 'relay-answer', async (payload) => {
    if (payload.guestUid !== guestUid || payload.viewerUid !== viewerUid) return;
    const r = _hostRelayPeers[guestUid]?.[viewerUid];
    if (!r) return;
    if (payload.answer && r.pc.remoteDescription === null) {
      try { await r.pc.setRemoteDescription(new RTCSessionDescription(payload.answer)); } catch(_) {}
    }
  });

  // Also listen for viewer ICE candidates
  _rtListen(relayCh, 'relay-candidate', async (payload) => {
    if (payload.guestUid !== guestUid || payload.viewerUid !== viewerUid) return;
    if (payload.from !== 'viewer') return;
    const r = _hostRelayPeers[guestUid]?.[viewerUid];
    if (!r || !r.pc.remoteDescription) return;
    try { await r.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch(_) {}
  });
}

/* ── HOST: Relay a specific guest to ALL current viewers ── */
async function _hostRelayGuestToAllViewers(guestUid, stream) {
  if (!_roomId || !stream) return;
  // Get current viewers from Supabase Presence (_viewerPresence populated by presence channel)
  try {
    const viewers = Object.keys(_viewerPresence || {});
    for (const viewerUid of viewers) {
      _hostRelayGuestToViewer(guestUid, viewerUid, stream);
    }
  } catch(_) {}
}

/* ── HOST: When a new viewer joins, relay all active guests to them ── */
async function _hostRelayAllGuestsToViewer(viewerUid) {
  for (const [guestUid, peer] of Object.entries(_guestPeers)) {
    if (peer.stream) {
      await _hostRelayGuestToViewer(guestUid, viewerUid, peer.stream);
    }
  }
}

/* ── HOST: Tear down one relay peer ── */
function _hostTeardownRelayPeer(guestUid, viewerUid) {
  const relay = _hostRelayPeers[guestUid]?.[viewerUid];
  if (!relay) return;
  if (relay.answerUnsub) { try { relay.answerUnsub(); } catch(_){} }
  if (relay.pc) { try { relay.pc.close(); } catch(_){} }
  delete _hostRelayPeers[guestUid][viewerUid];
  // No persistent signaling to clean up — Broadcast channels are ephemeral
}

/* ── HOST: Tear down all relay peers for one guest ── */
function _hostTeardownGuestRelayPeers(guestUid) {
  const viewers = _hostRelayPeers[guestUid] || {};
  for (const viewerUid of Object.keys(viewers)) {
    _hostTeardownRelayPeer(guestUid, viewerUid);
  }
  delete _hostRelayPeers[guestUid];
}

/* ── HOST: Tear down ALL relay peers (endLive) ── */
function _hostTeardownAllRelayPeers() {
  for (const guestUid of Object.keys(_hostRelayPeers)) {
    _hostTeardownGuestRelayPeers(guestUid);
  }
  _hostRelayPeers = {};
  if (_hostViewerListenUnsub) { try { _hostViewerListenUnsub(); } catch(_){} _hostViewerListenUnsub = null; }
}

/* ── HOST: Start watching for new viewers joining so they receive relay streams ──
   Viewers join the live-presence channel; we listen for presence join events. */
function _hostStartWatchingViewers() {
  if (!_roomId || _hostViewerListenUnsub) return;
  const presCh = _getChannel(`live-presence-${_roomId}`);
  const _onJoin = ({ newPresences }) => {
    for (const p of (newPresences || [])) {
      const viewerUid = p.uid;
      if (!viewerUid) continue;
      for (const [guestUid, peer] of Object.entries(_guestPeers)) {
        if (!peer.stream) continue;
        if (_hostRelayPeers[guestUid]?.[viewerUid]) continue; // already relayed
        _hostRelayGuestToViewer(guestUid, viewerUid, peer.stream);
      }
    }
  };
  presCh.on('presence', { event: 'join' }, _onJoin);
  _hostViewerListenUnsub = () => { try { presCh.off('presence', { event: 'join' }); } catch(_){} };
}

/* ── VIEWER: Subscribe to relay signaling for one guest ── */
async function _viewerSubscribeGuestRelay(guestUid) {
  if (!_user || !_roomId) return;
  // Don't subscribe if already have a relay for this guest
  if (_viewerRelayPeers[guestUid]) return;
  // Don't subscribe if this is the viewer's own guest box (they see their own video directly)
  if (guestUid === _user.uid) return;
  // Prevent concurrent calls for the same guest (race condition guard)
  if (_viewerRelayPending.has(guestUid)) return;
  _viewerRelayPending.add(guestUid);

  const relayCh = `live-relay-sig-${_roomId}`;

  // Wait for host's relay-offer event (up to 10 s)
  let relayData = null;
  await new Promise(resolve => {
    const _timeout = setTimeout(() => resolve(null), 10000);
    const _unsub = _rtListen(relayCh, 'relay-offer', (payload) => {
      if (payload.guestUid !== guestUid || payload.viewerUid !== _user.uid) return;
      clearTimeout(_timeout);
      try { _unsub(); } catch(_) {}
      relayData = payload;
      resolve(payload);
    });
  });

  if (!relayData) {
    _viewerRelayPending.delete(guestUid);
    // No relay offer yet — watch for next offer from host (re-subscribe once)
    _rtListen(relayCh, 'relay-offer', (payload) => {
      if (payload.guestUid !== guestUid || payload.viewerUid !== _user.uid) return;
      _viewerSubscribeGuestRelay(guestUid);
    });
    return;
  }

  const pc = new RTCPeerConnection(_ICE_SERVERS);

  // Collect all tracks from every ontrack event into a single shared stream,
  // then attach to the cell only once a video track is confirmed present.
  // This prevents premature attachment with an audio-only stream when audio
  // ontrack fires before video ontrack (common on Firefox / some mobile browsers).
  const _relayStream = new MediaStream();
  let   _relayAttached = false;
  const _relayTryAttach = () => {
    if (!_relayStream.getVideoTracks().length) return; // no video yet — skip until video arrives
    if (_relayAttached) {
      // Already attached — re-apply stream so any newly arrived audio track is included
      // in the srcObject, and resume playback if the element was paused.
      const cell = D.guestGrid?.querySelector(`.vgc-cell[data-uid="${guestUid}"]`);
      if (cell) {
        const v = cell.querySelector('video');
        if (v) {
          if (v.srcObject !== _relayStream) v.srcObject = _relayStream;
          if (v.paused) v.play().catch(() => {});
        }
      }
      return;
    }
    _relayAttached = true;
    const _doAttach = (attemptsLeft) => {
      const grid = D.guestGrid;
      if (!grid) return;
      const cell = grid.querySelector(`.vgc-cell[data-uid="${guestUid}"]`);
      if (cell) { _attachStreamToGuestCell(cell, _relayStream); return; }
      if (attemptsLeft > 0) setTimeout(() => _doAttach(attemptsLeft - 1), 150);
    };
    _doAttach(40);
  };
  pc.ontrack = (e) => {
    // Merge every incoming track into the shared stream
    if (!_relayStream.getTracks().includes(e.track)) {
      _relayStream.addTrack(e.track);
    }
    _relayTryAttach();
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed') {
      _viewerTeardownRelayPeer(guestUid);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch(_){} }
  };

  try { await pc.setRemoteDescription(new RTCSessionDescription(relayData.offer)); }
  catch(e) { _viewerRelayPending.delete(guestUid); try { pc.close(); } catch(_){} return; }

  const _pendingCands = [];
  let _answerWritten = false;

  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_answerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    try { await _rtBroadcast(relayCh, 'relay-candidate', { guestUid, viewerUid: _user.uid, from: 'viewer', candidate: e.candidate.toJSON() }); } catch(_) {}
  };

  let answer;
  try { answer = await pc.createAnswer(); await pc.setLocalDescription(answer); }
  catch(e) { _viewerRelayPending.delete(guestUid); try { pc.close(); } catch(_){} return; }

  const relay = { pc, appliedCandKeys: new Set(), sigUnsub: null };
  _viewerRelayPeers[guestUid] = relay;
  _viewerRelayPending.delete(guestUid);

  try {
    await _rtBroadcast(relayCh, 'relay-answer', { guestUid, viewerUid: _user.uid, answer: { type: answer.type, sdp: answer.sdp } });
    _answerWritten = true;
  } catch(e) { _viewerTeardownRelayPeer(guestUid); return; }

  for (const c of _pendingCands) {
    try { await _rtBroadcast(relayCh, 'relay-candidate', { guestUid, viewerUid: _user.uid, from: 'viewer', candidate: c }); } catch(_) {}
  }

  // Listen for additional host ICE candidates
  relay.sigUnsub = _rtListen(relayCh, 'relay-candidate', async (payload) => {
    if (payload.guestUid !== guestUid || payload.viewerUid !== _user.uid) return;
    if (payload.from !== 'host') return;
    const r = _viewerRelayPeers[guestUid];
    if (!r || !r.pc.remoteDescription) return;
    try { await r.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch(_) {}
  });
}

/* ── VIEWER: Attach a stream to a guest cell (replaces avatar with live video) ── */
function _attachStreamToGuestCell(cell, stream) {
  if (!cell || !stream) return;
  // Only attach a stream that actually contains a video track — skip audio-only streams
  // so we never accidentally overwrite a good srcObject with a partial one.
  if (!stream.getVideoTracks().length) return;
  let vid = cell.querySelector('video');
  if (!vid) {
    vid = document.createElement('video');
    vid.autoplay    = true;
    vid.muted       = false;
    vid.playsInline = true;
    const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
    cell.insertBefore(vid, nameEl || null);
  }
  // Always update srcObject so reconnects and stream replacements are handled
  if (vid.srcObject !== stream) vid.srcObject = stream;
  // Always call play() — browsers may pause a video element after a srcObject change
  // or after the tab was backgrounded; this is a no-op when already playing.
  vid.play().catch(() => {});
  // Hide avatar and cam-off overlay since we have live video
  const avatar = cell.querySelector('.vgc-avatar');
  if (avatar) avatar.style.display = 'none';
  const camOff = cell.querySelector('.vgc-cam-off');
  if (camOff) camOff.classList.remove('vgc-cam-off--visible');
}

/* ── VIEWER: Tear down one relay peer ── */
function _viewerTeardownRelayPeer(guestUid) {
  _viewerRelayPending.delete(guestUid);
  const relay = _viewerRelayPeers[guestUid];
  if (!relay) return;
  if (relay.sigUnsub) { try { relay.sigUnsub(); } catch(_){} }
  if (relay.pc) { try { relay.pc.close(); } catch(_){} }
  delete _viewerRelayPeers[guestUid];
}

/* ── VIEWER: Tear down ALL relay peers ── */
function _viewerTeardownAllRelayPeers() {
  for (const guestUid of Object.keys(_viewerRelayPeers)) {
    _viewerTeardownRelayPeer(guestUid);
  }
  _viewerRelayPeers = {};
  _viewerRelayPending.clear();
  if (_viewerRelayListenUnsub) { try { _viewerRelayListenUnsub(); } catch(_){} _viewerRelayListenUnsub = null; }
}

/* ═══════════════════════════════════════════════════
   WebRTC — VIEWER
   Uses LIVE Realtime Database for signaling.
   ═══════════════════════════════════════════════════ */
async function _startViewerWebRTC(roomData) {
  if (!_user || !_roomId) return;
  _showConnBanner('Waiting for stream…', '');

  // Each viewer uses their own per-viewer signaling slot so multiple viewers
  // never overwrite each other's answer/ICE data.
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Tell the host that this viewer wants to connect
  let _offerPayload = null;
  await new Promise(async resolve => {
    const sigCh = _getChannel(`live-signal-${_roomId}`);

    // Listen for host-offer event targeted at this viewer
    sigCh.on('broadcast', { event: 'host-offer' }, msg => {
      if (msg.payload?.uid === _user.uid) {
        _offerPayload = msg.payload.offer;
        resolve();
      }
    });

    // Join signal — host will create a peer and send an offer
    await _rtBroadcast(`live-signal-${_roomId}`, 'viewer-join', {
      uid: _user.uid, sessionId
    }).catch(() => {});

    // Timeout after 15 s
    setTimeout(resolve, 15000);
  });

  if (!_offerPayload) {
    // Offer never arrived — retry later
    _showConnBanner('Waiting for stream…', '');
    return;
  }
  const slotData = { offer: _offerPayload, hostCandidates: {} };

  if (_rtcPc) {
    _rtcPc.ontrack = null; _rtcPc.onconnectionstatechange = null;
    _rtcPc.oniceconnectionstatechange = null; _rtcPc.onicecandidate = null;
    try { _rtcPc.close(); } catch(_) {} _rtcPc = null;
  }
  if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_) {} _rtcSignalRef = null; _rtcSignalUnsub = null; }

  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);

  _rtcPc.ontrack = (e) => {
    if (!D.liveVideo) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    D.liveVideo.srcObject = stream;
    D.liveVideo.muted = true;
    if ('playsInline' in D.liveVideo) D.liveVideo.playsInline = true;
    if (typeof D.liveVideo.disableRemotePlayback !== 'undefined') D.liveVideo.disableRemotePlayback = true;
    D.liveVideo.play().catch(() => {});
    _showUnmutePrompt();
    _hideConnBanner();
    D.liveVideo.addEventListener('playing', _hideConnBanner, { once: true });
    const hostCell = D.guestGrid?.querySelector('.vgc-cell.host-cell');
    if (hostCell) {
      const existingVid = hostCell.querySelector('video');
      if (existingVid) { existingVid.srcObject = stream; existingVid.play().catch(() => {}); }
      else { _attachHostVideoToCell(hostCell); }
    }
  };

  _rtcPc.onconnectionstatechange = () => {
    const state = _rtcPc?.connectionState;
    console.log(`[WebRTC-Viewer] connectionState → ${state}`);
    if (state === 'connected') {
      _hideConnBanner();
      _viewerReconnectAttempt = 0;
    } else if (state === 'disconnected') {
      console.log('[WebRTC-Viewer] Disconnected — waiting 3 s before reconnect attempt');
      _showConnBanner('Connection lost…', 'Reconnecting…');
      setTimeout(() => {
        if (_rtcPc && (_rtcPc.connectionState === 'disconnected' || _rtcPc.connectionState === 'failed')) {
          _scheduleViewerReconnect(roomData);
        }
      }, 3000);
    } else if (state === 'failed') {
      console.log('[WebRTC-Viewer] PeerConnection FAILED — recreating PeerConnection');
      _showConnBanner('Reconnecting…', '');
      _scheduleViewerReconnect(roomData);
    } else if (state === 'closed') {
      console.log('[WebRTC-Viewer] PeerConnection closed');
      if (!_viewerLeftFlag) _scheduleViewerReconnect(roomData);
    }
  };

  _rtcPc.oniceconnectionstatechange = () => {
    const ice = _rtcPc?.iceConnectionState;
    console.log(`[WebRTC-Viewer] ICE state → ${ice}`);
    if (ice === 'failed') {
      console.log('[WebRTC-Viewer] ICE FAILED — triggering reconnect');
      _showConnBanner('Reconnecting…', '');
      _scheduleViewerReconnect(roomData);
    } else if (ice === 'disconnected') {
      console.log('[WebRTC-Viewer] ICE disconnected — waiting 3 s');
      setTimeout(() => {
        if (_rtcPc && (_rtcPc.iceConnectionState === 'disconnected' || _rtcPc.iceConnectionState === 'failed')) {
          console.log('[WebRTC-Viewer] ICE still disconnected — scheduling reconnect');
          _scheduleViewerReconnect(roomData);
        }
      }, 3000);
    }
  };

  try { await _rtcPc.setRemoteDescription(new RTCSessionDescription(slotData.offer)); }
  catch(e) { _showConnBanner('Waiting for stream…', ''); return; }

  const _pendingCands = [];
  let _answerWritten = false;

  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_answerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    _rtBroadcast(`live-signal-${_roomId}`, 'viewer-ice', {
      uid: _user.uid, candidate: e.candidate.toJSON()
    }).catch(() => {});
  };

  let answer;
  try { answer = await _rtcPc.createAnswer(); await _rtcPc.setLocalDescription(answer); }
  catch(e) { _showConnBanner('Waiting for stream…', ''); return; }

  try {
    await _rtBroadcast(`live-signal-${_roomId}`, 'viewer-answer', {
      uid: _user.uid, answer: { type: answer.type, sdp: answer.sdp }
    });
    _answerWritten = true;
  } catch(e) { _showConnBanner('Waiting for stream…', ''); return; }

  for (const c of _pendingCands) {
    _rtBroadcast(`live-signal-${_roomId}`, 'viewer-ice', { uid: _user.uid, candidate: c }).catch(() => {});
  }

  // Listen for host ICE candidates
  const sigCh = _getChannel(`live-signal-${_roomId}`);
  let _lastSeenOfferSdp = slotData.offer?.sdp || null;
  _rtcSignalRef   = sigCh;
  _rtcSignalUnsub = () => _removeChannel(`live-signal-${_roomId}`);

  sigCh.on('broadcast', { event: 'host-ice' }, msg => {
    if (msg.payload?.uid !== _user.uid) return;
    if (_rtcPc && _rtcPc.remoteDescription) {
      _rtcPc.addIceCandidate(new RTCIceCandidate(msg.payload.candidate)).catch(() => {});
    }
  });

  sigCh.on('broadcast', { event: 'host-offer' }, async msg => {
    if (msg.payload?.uid !== _user.uid) return;
    const d = msg.payload;
    if (d.offer && d.offer.sdp && d.offer.sdp !== _lastSeenOfferSdp) {
      _lastSeenOfferSdp = d.offer.sdp;
      _rtcPc.ontrack = null; _rtcPc.onconnectionstatechange = null;
      _rtcPc.oniceconnectionstatechange = null; _rtcPc.onicecandidate = null;
      try { _rtcPc.close(); } catch(_) {}
      if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_) {} _rtcSignalRef = null; _rtcSignalUnsub = null; }
      _startViewerWebRTC(roomData);
      return;
    }
    if (d.hostCandidates) {
      for (const [key, cand] of Object.entries(d.hostCandidates)) {
        if (_appliedHostCands.has(key)) continue;
        _appliedHostCands.add(key);
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch(_) {}
      }
    }
  });

  _showConnBanner('Waiting for stream…', '');
  setTimeout(() => {
    const v = D.liveVideo;
    if (v && v.srcObject && !v.paused && v.readyState >= 2) _hideConnBanner();
  }, 3000);

  const _watchdogPc = _rtcPc;
  setTimeout(() => {
    if (_viewerLeftFlag) return;
    if (_rtcPc !== _watchdogPc) return;
    const v = D.liveVideo;
    const hasVideo = v && v.srcObject && v.srcObject.getVideoTracks().some(t => t.readyState === 'live');
    if (!hasVideo) { console.log('[WebRTC-Viewer] Black-screen watchdog triggered — retrying'); _scheduleViewerReconnect(roomData); }
  }, 8000);
}
/* ═══════════════════════════════════════════════════
   FROZEN VIDEO WATCHDOG — viewer side
   Polls every 12 s. If the video element has a live
   srcObject but has been stuck (readyState < 2 or
   paused) for two consecutive checks, triggers a
   reconnect to auto-refresh the video tracks.
   ═══════════════════════════════════════════════════ */
let _frozenWatchdogInterval = null;
let _frozenWatchdogStrikeCount = 0;

function _startFrozenVideoWatchdog(getRoomDataFn) {
  if (_frozenWatchdogInterval) return;
  _frozenWatchdogStrikeCount = 0;
  _frozenWatchdogInterval = setInterval(() => {
    if (_viewerLeftFlag || !_roomId) {
      clearInterval(_frozenWatchdogInterval);
      _frozenWatchdogInterval = null;
      return;
    }
    const v = D.liveVideo;
    if (!v || !v.srcObject) { _frozenWatchdogStrikeCount = 0; return; }
    const isPlaying = !v.paused && v.readyState >= 2 && v.srcObject.getVideoTracks().some(t => t.readyState === 'live');
    if (isPlaying) { _frozenWatchdogStrikeCount = 0; return; }
    _frozenWatchdogStrikeCount++;
    console.warn(`[FrozenWatchdog] Video stuck (strike ${_frozenWatchdogStrikeCount}/2), readyState=${v.readyState} paused=${v.paused}`);
    // Try play() first — may just be an autoplay block
    v.play().then(() => { _frozenWatchdogStrikeCount = 0; }).catch(() => {});
    if (_frozenWatchdogStrikeCount >= 2) {
      _frozenWatchdogStrikeCount = 0;
      console.warn('[FrozenWatchdog] Video still frozen — triggering reconnect to refresh video tracks');
      const rd = typeof getRoomDataFn === 'function' ? getRoomDataFn() : null;
      if (rd) _scheduleViewerReconnect(rd);
    }
  }, 12000);
}

function _stopFrozenVideoWatchdog() {
  if (_frozenWatchdogInterval) { clearInterval(_frozenWatchdogInterval); _frozenWatchdogInterval = null; }
  _frozenWatchdogStrikeCount = 0;
}

/* ═══════════════════════════════════════════════════
   STREAM QUALITY PROFILES
   Phone sends 720p 30fps 3000 kbps CBR by default.
   Auto-quality shifts between tiers based on
   bandwidth and packet-loss measured every 10 s.
   ═══════════════════════════════════════════════════ */

/**
 * Sender-side quality tiers (used by _startAdaptiveQuality).
 *
 * Tier selection on the SENDER is driven by packet-loss rate
 * (what the creator's upload path can sustain). The viewer's
 * playback simply receives whatever the sender transmits —
 * because this is a direct P2P WebRTC stream there is only one
 * encoded copy, so "viewer quality switching" means the sender
 * adapts to network conditions automatically.
 *
 *  Tier  | Resolution | maxBitrate | scaleDown | Condition
 *  ------+------------+------------+-----------+-------------------
 *  HIGH  | 1080p      | 6 000 kbps |     1     | loss < 3 %
 *  MED   | 720p       | 3 000 kbps |     1     | loss 3–10 %  (default)
 *  LOW   | 480p       | 1 500 kbps |  ~1.5     | loss 10–20 %
 *  MIN   | ~240p      |   600 kbps |     3     | loss > 20 %
 */
const _QUALITY_TIERS = [
  { name: 'HIGH', maxBitrate: 6_000_000, scaleDown: 1,   lossThreshold: 0.03  },
  { name: 'MED',  maxBitrate: 3_000_000, scaleDown: 1,   lossThreshold: 0.10  },
  { name: 'LOW',  maxBitrate: 1_500_000, scaleDown: 1.5, lossThreshold: 0.20  },
  { name: 'MIN',  maxBitrate:   600_000, scaleDown: 3,   lossThreshold: Infinity },
];

let _adaptiveQualityTimer    = null;
let _adaptiveQualityTierIdx  = 1; // start at MED (720p / 3000 kbps)

function _startAdaptiveQuality(pc) {
  if (_adaptiveQualityTimer) return; // already running

  let _prevPacketsSent = 0;
  let _prevPacketsLost = 0;

  _adaptiveQualityTimer = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') {
      clearInterval(_adaptiveQualityTimer);
      _adaptiveQualityTimer = null;
      return;
    }

    try {
      const stats = await pc.getStats();
      let totalSent = 0, totalLost = 0, totalBytesSent = 0;

      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          totalSent      += report.packetsSent  || 0;
          totalLost      += report.packetsLost  || 0;
          totalBytesSent += report.bytesSent    || 0;
        }
      });

      const deltaSent = totalSent - _prevPacketsSent;
      const deltaLost = totalLost - _prevPacketsLost;
      _prevPacketsSent = totalSent;
      _prevPacketsLost = totalLost;

      if (deltaSent < 10) return; // not enough data yet

      const lossRate = deltaSent > 0 ? Math.max(0, deltaLost) / deltaSent : 0;

      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (!sender) return;

      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;

      // Determine which tier we should be in
      let targetIdx = _QUALITY_TIERS.length - 1; // default: lowest
      for (let i = 0; i < _QUALITY_TIERS.length; i++) {
        if (lossRate < _QUALITY_TIERS[i].lossThreshold) { targetIdx = i; break; }
      }

      // Only change tier when moving down immediately, or when improving
      // after two consecutive good intervals (hysteresis to avoid flapping)
      if (targetIdx === _adaptiveQualityTierIdx) return;

      // Allow instant degradation; require loss to be below prev tier threshold
      // for at least one check before upgrading (simple 1-step hysteresis)
      if (targetIdx > _adaptiveQualityTierIdx) {
        // degrading → apply immediately
      } else {
        // upgrading → only move one tier at a time
        targetIdx = _adaptiveQualityTierIdx - 1;
        if (lossRate >= _QUALITY_TIERS[targetIdx].lossThreshold) return;
      }

      _adaptiveQualityTierIdx = targetIdx;
      const tier = _QUALITY_TIERS[targetIdx];

      params.encodings[0].maxBitrate           = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
      console.log(`[AdaptiveQuality] → ${tier.name} (loss:${(lossRate*100).toFixed(1)}%  bitrate:${tier.maxBitrate/1000}kbps)`);

    } catch(_) {}
  }, 10_000);
}

function _stopAdaptiveQuality() {
  if (_adaptiveQualityTimer) {
    clearInterval(_adaptiveQualityTimer);
    _adaptiveQualityTimer   = null;
    _adaptiveQualityTierIdx = 1; // reset to MED for next session
  }
}

/* ═══════════════════════════════════════════════════
   VIEWER AUTO-RECONNECT
   ═══════════════════════════════════════════════════ */

/**
 * Schedule a WebRTC reconnect attempt with exponential back-off.
 * Clears the old peer connection before creating a new one so listeners
 * and ICE candidates don't pile up.
 */
function _scheduleViewerReconnect(roomData) {
  if (_viewerLeftFlag) return;  // viewer already left

  // Fix: no hard cap — keep retrying. Only bail if the stream actually ended.
  if (_viewerReconnectAttempt >= _MAX_RECONNECT_ATTEMPTS) {
    // Safety valve: after 9999 attempts something is structurally wrong — verify stream first
    _viewerReconnectAttempt = 0;
  }

  if (_viewerReconnectTimer) clearTimeout(_viewerReconnectTimer);

  // Cap back-off at 15 s so reconnects stay timely even after many failures
  const delay = Math.min(2000 * Math.pow(1.5, Math.min(_viewerReconnectAttempt, 7)), 15000);
  _viewerReconnectAttempt++;
  console.log(`[WebRTC-Viewer] Reconnect attempt ${_viewerReconnectAttempt} scheduled in ${delay}ms (state: ${_rtcPc?.connectionState || 'no-pc'})`);

  _viewerReconnectTimer = setTimeout(async () => {
    _viewerReconnectTimer = null;
    if (_viewerLeftFlag) return;

    // Tear down old peer connection + signal listener cleanly
    if (_rtcPc) {
      // Detach all event handlers before closing so stale callbacks don't fire
      _rtcPc.ontrack = null;
      _rtcPc.onconnectionstatechange = null;
      _rtcPc.oniceconnectionstatechange = null;
      _rtcPc.onicecandidate = null;
      try { _rtcPc.close(); } catch(_) {}
      _rtcPc = null;
    }
    if (_rtcSignalUnsub) {
      try { _rtcSignalUnsub(); } catch(_) {}
      _rtcSignalRef = null; _rtcSignalUnsub = null;
    }

    // Clear stale video so the black frame is not visible while reconnecting.
    // Do NOT call .stop() on remote WebRTC tracks — just detach srcObject.
    if (D.liveVideo) {
      D.liveVideo.srcObject = null;
    }

    // Verify stream is still live before attempting
    try {
      const room = await _dbGet('live_rooms', _roomId);
      if (!room || room.status !== 'live') {
        const hostName = room?.host_name || roomData?.host_name || roomData?.hostName || '';
        _showEndedOverlay(false, 'Stream ended', `${hostName} has ended the live stream.`);
        return;
      }
    } catch(_) {}

    // Re-run the WebRTC viewer setup
    await _startViewerWebRTC(roomData);
  }, delay);
}

/* ═══════════════════════════════════════════════════
   CHAT — Firestore `live_messages` collection
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  if (_chatUnsub) { try { _chatUnsub(); } catch(_){} _chatUnsub = null; }

  // Firestore onSnapshot — streams recent messages and new inserts in real time
  const chatQ = _fbQuery(
    _fbCollection(_fbDb, 'live_messages'),
    _fbWhere('room_id', '==', _roomId),
    _fbOrderBy('created_at', 'asc'),
    _fbLimit(100),
  );

  let _initialLoad = true;
  _chatUnsub = _fbOnSnapshot(chatQ, snap => {
    if (_initialLoad) {
      // First snapshot: render all existing messages
      _initialLoad = false;
      snap.docs.forEach(d => _appendChatMsg(_normMsg({ id: d.id, ...d.data() })));
    } else {
      // Subsequent snapshots: only handle added documents
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          _appendChatMsg(_normMsg({ id: change.doc.id, ...change.doc.data() }));
        }
      });
    }
  }, err => {
    console.warn('[Chat] Firestore onSnapshot error — retrying in 5 s:', err.message);
    setTimeout(() => { if (_roomId && !_viewerLeftFlag) _subscribeChat(); }, 5000);
  });
}

/** Normalize a live_messages row to the shape _buildChatMsgEl expects. */
function _normMsg(row) {
  return {
    userId:    row.user_id,
    userName:  row.user_name,
    text:      row.text,
    type:      row.type || 'chat',
    createdAt: row.created_at,
  };
}

function _buildChatMsgEl(data) {
  // Use the real host uid — _roomHostId is set from roomData.hostId (viewer) or _user.id (creator)
  const isHost   = !!(data.userId && _roomHostId && data.userId === _roomHostId);
  const isSystem = data.type === 'system';

  const el = document.createElement('div');
  el.className = 'live-chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem) {
    const author = document.createElement('span');
    author.className = 'live-chat-author' + (isHost ? ' is-host' : '');
    author.textContent = data.userName || 'Guest';
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(author);
    el.appendChild(text);
  } else {
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(text);
  }
  return el;
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  const el = _buildChatMsgEl(data);
  if (!el) return;
  const cm = D.chatMessages;
  const atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 120;
  cm.appendChild(el);
  while (cm.children.length > 70) cm.removeChild(cm.firstChild);
  if (atBottom) cm.scrollTop = cm.scrollHeight;
}

/* ── Live chat AI safety rules (mirrors index.html _RULES) ── */
const _LIVE_RULES = [
  { category: 'Threats',           severity: 'block', patterns: [
      /\bi('?ll| will|'m going to|m gonna|gonna|will)\s+(kill|hurt|murder|destroy|beat|shoot|stab|end)\s+(you|u|them|him|her)/i,
      /\b(kill\s*your?self|kys|go\s*die|i\s*will\s*find\s*you|watch\s*your\s*back|you('re|\s+are)\s+dead|dead\s*man|dead\s*girl|die\s*bitch)\b/i,
      /\b(bomb|shoot up|blow up|attack)\s*(the\s*)?(school|place|building|event)/i,
  ]},
  { category: 'Hate Speech',       severity: 'block', patterns: [
      /\b(f+u+c+k+\s*(all\s*)?(blacks?|whites?|jews?|muslims?|christians?|gays?|lesbians?|trans|latinos?|asians?|mexicans?|arabs?))\b/i,
      /\b(all\s+(blacks?|whites?|jews?|muslims?|gays?|lesbians?|trans|latinos?|asians?)\s+should\s+(die|be\s+killed|disappear|burn))\b/i,
      /\b(white\s*power|white\s*supremac|ethnic\s*cleans|n[i1]+gg[e3]r|ch[i1]nk|sp[i1]c|k[i1]ke|f[a4]gg[o0]t|tr[a4]nny)\b/i,
  ]},
  { category: 'Doxxing',           severity: 'block', patterns: [
      /\b(here('?s|\s+is)\s+(your|his|her|their)\s+(address|phone|number|location|ip\s*address|home|school|work))\b/i,
      /\b(i\s*(know|found)\s+where\s+you\s+(live|work|go\s+to\s+school))\b/i,
  ]},
  { category: 'Self-Harm Promotion', severity: 'block', patterns: [
      /\b(how\s+to\s+(properly\s+)?(cut|harm|hurt)\s+(yourself|myself)|best\s+way\s+to\s+(overdose|die|end\s+(it|your\s+life)))\b/i,
      /\b(just\s+(do\s+it|end\s+it|kill\s+yourself|hurt\s+yourself)\s+(already|please|nobody\s+cares))\b/i,
  ]},
  { category: 'Harassment',        severity: 'warn',  patterns: [
      /\b(shut\s*(the\s*f[uck*@]+\s*)?up\s+(you\s+)?(stupid|dumb|idiot|ugly|fat|loser|worthless|pathetic|disgusting)\b)/i,
      /\b(nobody\s+(likes?|cares\s*about)\s+you|you\s+(are|r|re)\s+(worthless|pathetic|trash|garbage|a\s+loser|disgusting|nothing))\b/i,
  ]},
  { category: 'Spam',              severity: 'warn',  patterns: [
      /(.)\1{19,}/,
      /(\b\w+\b)(\s+\1){7,}/i,
  ]},
];

function _liveScanText(text) {
  if (!text) return null;
  for (const rule of _LIVE_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(text)) return rule;
    }
  }
  return null;
}

async function sendChat() {
  if (!_user || !_roomId) return;
  // Guard against double-send (rapid taps / Enter+click combo)
  if (_chatSending) return;

  const text = (D.chatInput?.value || '').trim();
  if (!text || text.length > 200) return;

  // ── AI Safety scan ──
  const hit = _liveScanText(text);
  if (hit) {
    const isMod = _userData?.role === 'founder' ||
                  _userData?.role === 'administrator' ||
                  _userData?.role === 'moderator';
    if (hit.severity === 'block' && !isMod) {
      toast(`🚫 Blocked · ${hit.category}: Keep it safe.`);
      return;   // hard block — do NOT clear input, let user edit
    }
    toast(`⚠️ Warning · ${hit.category}: Please keep the community safe.`);
  }

  // Clear input immediately so typing feels instant
  if (D.chatInput) {
    D.chatInput.value = '';
    D.chatInput.focus();
  }

  _chatSending = true;
  try {
    await _fbAddDoc(_fbCollection(_fbDb, 'live_messages'), {
      room_id:    _roomId,
      user_id:    _user.uid,
      user_name:  _userData.display_name || _userData.username || 'Guest',
      text,
      type:       'chat',
      created_at: _fbServerTs(),
    });
  } catch (e) {
    toast('Could not send message.');
  } finally {
    _chatSending = false;
  }
}

/* ═══════════════════════════════════════════════════
   LIKES — Supabase Broadcast
   ═══════════════════════════════════════════════════ */
let _hasLiked = false;

async function sendLike() {
  if (!_user || !_roomId || _hasLiked) return;
  _hasLiked = true;
  if (D.likeBtn)      D.likeBtn.classList.add('liked');
  if (D.likeBtnCount) D.likeBtnCount.textContent = '❤️';

  _spawnHeartBurst();

  // Broadcast like event to host's presence channel (host increments and persists)
  (async () => {
    try {
      const ch = _getChannel(`live-presence-${_roomId}`);
      await ch.send({ type: 'broadcast', event: 'like', payload: { uid: _user.uid } });
    } catch (_) {}
  })();

  setTimeout(() => {
    _hasLiked = false;
    if (D.likeBtn) D.likeBtn.classList.remove('liked');
  }, 5000);
}

function _spawnHeartBurst() {
  const stage = D.stage;
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'like-burst';
  el.textContent = '❤️';
  const rect = stage.getBoundingClientRect();
  el.style.left     = (rect.width  * 0.75 + (Math.random() - 0.5) * 60) + 'px';
  el.style.bottom   = (80 + Math.random() * 60) + 'px';
  el.style.position = 'absolute';
  stage.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ═══════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════ */
function _hideLoading() {
  if (D.loading) D.loading.style.display = 'none';
}

function _showStage() {
  if (D.stage) D.stage.classList.add('active');
}

function _showConnBanner(title, sub) {
  if (!D.connBanner) return;
  // Don't show the banner if the video is already playing
  const v = D.liveVideo;
  if (v && v.srcObject && !v.paused && v.readyState >= 2) return;
  if (D.connTitle) D.connTitle.textContent = title;
  if (D.connSub)   D.connSub.textContent   = sub;
  D.connBanner.classList.add('visible');
}

function _hideConnBanner() {
  if (D.connBanner) D.connBanner.classList.remove('visible');
}

function _showUnmutePrompt() {
  const p = D.unmutePrompt;
  if (!p) return;
  p.style.display = 'block';
  const _unmute = () => {
    if (D.liveVideo) D.liveVideo.muted = false;
    p.style.display = 'none';
    p.removeEventListener('click', _unmute);
    if (D.stage) D.stage.removeEventListener('click', _unmute);
  };
  p.addEventListener('click', _unmute);
  if (D.stage) D.stage.addEventListener('click', _unmute, { once: true });
}

function _showEndedOverlay(wasCreator, title, sub) {
  if (!D.ended) return;
  if (D.endedTitle) D.endedTitle.textContent = title || 'Stream ended';
  if (D.endedSub)   D.endedSub.textContent   = sub   || (wasCreator
    ? 'Your live stream has ended. Thanks for going live!'
    : 'The creator has ended this live stream.');
  D.ended.classList.add('visible');
  // Cancel pending reconnect so we don't try to reconnect to an ended stream
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalUnsub) { try { _rtcSignalUnsub(); } catch(_) {} _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
}

function onCloseBtn() {
  if (_mode === 'creator') {
    endLive();
  } else {
    _viewerLeave();
    window.location.href = 'aurenix.html#live';
  }
}

/* ═══════════════════════════════════════════════════
   SHARE
   ═══════════════════════════════════════════════════ */
function shareLive() {
  if (!_roomId) { toast('Start your live first.'); return; }
  _openShareModal();
}

function _buildLiveUrl() {
  const base = window.location.origin + window.location.pathname.replace('live.html', '');
  return base + 'live.html#watch=' + _roomId;
}

function _openShareModal() {
  const old = document.getElementById('_snxShareModal');
  if (old) old.remove();

  const url      = _buildLiveUrl();
  const name     = _getDisplayName(_userData, _user);
  const shareMsg = `${name} is Live Now 🔴 — Watch: ${url}`;

  const modal = document.createElement('div');
  modal.id    = '_snxShareModal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:flex-end;justify-content:center;
    background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);
  `;

  modal.innerHTML = `
    <div style="
      background:#0d2444;border:1px solid rgba(0,174,239,0.3);
      border-radius:20px 20px 0 0;padding:24px 20px 36px;
      width:100%;max-width:520px;
    ">
      <div style="text-align:center;font-size:16px;font-weight:800;color:#fff;margin-bottom:18px;">
        📤 Share Live Stream
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <button id="_snxShareCopyLink" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">🔗 Copy Live Link</button>
        <button id="_snxShareToFeed" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📣 Share to Feed</button>
        <button id="_snxShareNative" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📲 Share to Friends / Apps</button>
      </div>
      <button id="_snxShareClose" style="
        margin-top:18px;width:100%;background:rgba(255,255,255,0.06);
        border:1px solid rgba(255,255,255,0.12);border-radius:12px;
        padding:12px;color:#6a90b8;font-size:14px;cursor:pointer;
      ">Cancel</button>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#_snxShareCopyLink').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => { toast('🔗 Live link copied!'); })
        .catch(() => { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
    _closeShareModal();
  });

  modal.querySelector('#_snxShareToFeed').addEventListener('click', async () => {
    _closeShareModal();
    try {
      await _fbAddDoc(_fbCollection(_fbDb, 'posts'), {
        type:          'live_share',
        uid:           _user.uid,
        author_name:   _userData?.display_name || _userData?.username || '',
        author_handle: _userData?.username     || '',
        author_avatar: _userData?.avatar       || '',
        live_room_id:  _roomId,
        is_live:       true,
        text:          shareMsg,
        likes:         0,
        created_at:    _fbServerTs(),
      });
      toast('📣 Shared to Feed!');
    } catch (e) {
      toast('Could not share.');
    }
  });

  modal.querySelector('#_snxShareNative').addEventListener('click', () => {
    _closeShareModal();
    if (navigator.share) {
      navigator.share({
        title: '🔴 Watch me live on Shadow Nexus Wave!',
        text:  shareMsg,
        url,
      }).catch(() => {});
    } else {
      window.prompt('Copy this link to share:', url);
    }
  });

  modal.querySelector('#_snxShareClose').addEventListener('click', _closeShareModal);
  modal.addEventListener('click', e => { if (e.target === modal) _closeShareModal(); });
}

function _closeShareModal() {
  const m = document.getElementById('_snxShareModal');
  if (m) m.remove();
}

function toast(msg, duration = 3200) {
  if (!D.toast) return;
  clearTimeout(_toastTimer);
  D.toast.textContent = msg;
  D.toast.classList.add('visible');
  _toastTimer = setTimeout(() => D.toast.classList.remove('visible'), duration);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── One-time version/update check ──
   Asks the SW if a newer version is waiting. If one is available, notify
   once via toast with a manual refresh prompt. Never polls again in the
   same session (guarded by _updateChecked). ── */
function _checkForUpdate() {
  if (_updateChecked) return;
  _updateChecked = true;
  if (!('serviceWorker' in navigator)) return;

  // When a new SW takes over (after SKIP_WAITING), reload the page to apply updates
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  navigator.serviceWorker.ready.then(reg => {
    // Trigger a background network check — does NOT block the page
    reg.update().then(() => {
      _showUpdateBarIfWaiting(reg);
    }).catch(() => {});

    // Also handle the case where a SW update event fires during this session
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          _showUpdateBarIfWaiting(reg);
        }
      });
    });
  }).catch(() => {});
}

function _showUpdateBarIfWaiting(reg) {
  if (!reg.waiting) return;
  // Already shown once? Don't show again
  if (document.getElementById('_snxUpdateBar')) return;

  const bar = document.createElement('div');
  bar.id = '_snxUpdateBar';
  bar.style.cssText = [
    'position:fixed','bottom:72px','left:50%','transform:translateX(-50%)',
    'z-index:9999','background:rgba(0,20,60,0.97)',
    'border:1px solid rgba(0,174,239,0.7)','border-radius:10px',
    'padding:10px 18px','font-size:13px','color:#00AEEF',
    'cursor:pointer','white-space:nowrap',
    'box-shadow:0 4px 18px rgba(0,0,0,0.5)',
  ].join(';');
  bar.textContent = '🔄 New version available — tap to refresh';
  bar.addEventListener('click', () => {
    bar.textContent = 'Updating…';
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // Reload will be triggered by the controllerchange event above
  });
  document.body.appendChild(bar);
  // Auto-dismiss after 15s — user can update later
  setTimeout(() => bar.remove(), 15000);
}

/* ── Confirmation dialog — Promise-based modal ──
   _snxConfirm({ icon, title, sub, okLabel, okClass })
   Resolves true (confirmed) or false (cancelled). */
function _snxConfirm({ icon = '❓', title = 'Are you sure?', sub = '', okLabel = 'Confirm', okClass = '' } = {}) {
  return new Promise(resolve => {
    // Remove any stale overlay
    document.getElementById('_snxConfirmOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_snxConfirmOverlay';
    overlay.className = 'snx-confirm-overlay';
    overlay.innerHTML = `
      <div class="snx-confirm-box">
        <div class="snx-confirm-icon">${icon}</div>
        <div class="snx-confirm-title">${_esc(title)}</div>
        ${sub ? `<div class="snx-confirm-sub">${_esc(sub)}</div>` : ''}
        <div class="snx-confirm-actions">
          <button class="snx-confirm-cancel">Cancel</button>
          <button class="snx-confirm-ok${okClass ? ' ' + okClass : ''}">${_esc(okLabel)}</button>
        </div>
      </div>
    `;

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.snx-confirm-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.snx-confirm-ok').addEventListener('click',     () => close(true));
    // Tap backdrop to cancel
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });

    document.body.appendChild(overlay);
  });
}

/* ═══════════════════════════════════════════════════════════════
   VIEWER GUEST GRID — real-time presence display for followers
   ─────────────────────────────────────────────────────────────
   Watches liveGuests/{roomId} in RTDB.
   Each entry: { uid, name, avatar, camOn, micOn, isHost? }
   Renders placeholder cards (no live video) so all viewers see
   who is in each box and their cam/mic status in real time.
   ═══════════════════════════════════════════════════════════════ */

/* ── HOST: Broadcast current layout + size to all viewers via Supabase Broadcast ── */
function _broadcastLayout() {
  if (!_roomId) return;
  _rtBroadcast(`live-guests-${_roomId}`, 'layout', {
    guestLayout:  _guestLayout,
    guestBoxSize: _guestBoxSize,
  }).catch(() => {});
  // Also persist to live_rooms for reconnecting viewers
  _dbUpdate('live_rooms', _roomId, {
    guest_layout:   _guestLayout,
    guest_box_size: _guestBoxSize,
  }).catch(() => {});
}

/* ── VIEWER / GUEST: Subscribe to layout changes broadcast by the host ── */
function _startLayoutSync() {
  if (!_roomId) return;
  if (_layoutSyncUnsub) { try { _layoutSyncUnsub(); } catch(_) {} _layoutSyncUnsub = null; }

  // If _roomWatchRef is already listening (viewer path), reuse it — no new listener needed.
  if (_roomWatchRef) {
    _layoutSyncUnsub = () => {};
    return;
  }

  // Guest-only path: subscribe to layout broadcast channel
  const ch = _getChannel(`live-guests-${_roomId}`);
  ch.on('broadcast', { event: 'layout' }, msg => {
    const d = msg.payload || {};
    let changed = false;
    if (d.guestLayout  && d.guestLayout  !== _guestLayout)  { _guestLayout  = d.guestLayout;  changed = true; }
    if (d.guestBoxSize && d.guestBoxSize !== _guestBoxSize)  { _guestBoxSize = d.guestBoxSize; changed = true; }
    if (changed) _applyGuestLayout();
  });
  _layoutSyncUnsub = () => _removeChannel(`live-guests-${_roomId}`);
}

/* Guest presence state (local in-memory, updated via broadcast) */
const _guestPresence = {};

function _startViewerGuestGrid() {
  if (!_roomId) return;

  // Subscribe to guest broadcast channel for presence events
  const ch = _getChannel(`live-guests-${_roomId}`);

  const _handleGuestPresence = () => {
    const grid = D.guestGrid;
    if (!grid) return;
    const incoming = { ..._guestPresence };

    // ── Remove cards for guests who left — animate out then remove ──
    grid.querySelectorAll('.vgc-cell').forEach(card => {
      if (!incoming[card.dataset.guestKey] && !card.classList.contains('removing')) {
        card.classList.add('removing');
        // Tear down relay connection for this departed guest (viewer mode)
        const departedUid = card.dataset.uid;
        if (departedUid && _mode === 'viewer') {
          _viewerTeardownRelayPeer(departedUid);
        }
        setTimeout(() => {
          card.remove();
          _applyGuestLayout(); // re-layout after DOM node is fully gone
        }, 220);
      }
    });

    // ── Add or update cards for current guests ──
    const orderedKeys = Object.keys(incoming).sort((a, b) => {
      // _host_ always first, then by joinedAt
      if (a === '_host_') return -1;
      if (b === '_host_') return  1;
      return (incoming[a].joinedAt || 0) - (incoming[b].joinedAt || 0);
    });

    orderedKeys.forEach(key => {
      const g = incoming[key];
      let card = grid.querySelector(`.vgc-cell[data-guest-key="${key}"]`);

      if (!card) {
        // ── Create new card ──
        card = document.createElement('div');
        card.className = 'guest-cell vgc-cell' + (g.isHost ? ' host-cell' : '');
        card.dataset.guestKey = key;
        card.dataset.uid      = g.uid;

        // Avatar circle
        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'vgc-avatar';
        if (g.avatar) {
          avatarWrap.style.backgroundImage = `url('${_esc(g.avatar)}')`;
        } else {
          avatarWrap.textContent = (g.name || '?')[0].toUpperCase();
        }
        card.appendChild(avatarWrap);

        // Camera-off overlay
        const camOffEl = document.createElement('div');
        camOffEl.className = 'vgc-cam-off';
        camOffEl.innerHTML = '<span>📷</span><span>Camera off</span>';
        card.appendChild(camOffEl);

        // Name label
        const nameEl = document.createElement('div');
        nameEl.className = 'guest-cell-name vgc-name';
        nameEl.textContent = g.isHost ? (g.name + ' (Host)') : (g.name || 'Guest');
        card.appendChild(nameEl);

        // Status icons bar
        const statusBar = document.createElement('div');
        statusBar.className = 'vgc-status';
        statusBar.innerHTML = `
          <span class="vgc-icon-cam">${g.camOn !== false ? '📷' : '🚫'}</span>
          <span class="vgc-icon-mic">${g.micOn !== false ? '🎤' : '🔇'}</span>
          ${g.isHost ? '<span class="vgc-host-badge">HOST</span>' : ''}
        `;
        card.appendChild(statusBar);

        // Insert: host always first
        if (g.isHost) {
          grid.insertBefore(card, grid.firstChild);
          // ── Attach host video stream to the host cell so it never disappears ──
          // For viewers, the host video arrives via WebRTC on #liveVideo.
          // Re-use that stream in the host cell so the grid always shows the host feed.
          _attachHostVideoToCell(card);
        } else {
          grid.appendChild(card);
        }

        // If this is the current viewer's own cell and they have a live guest stream,
        // attach the stream so they see their own live video (not just the avatar).
        if (_guestStream && g.uid === _user?.id) {
          _attachGuestSelfStream(_guestStream);
        }

        // For viewers watching this live: subscribe to the host-relayed stream for
        // this guest so the video actually appears in the cell (not just the avatar).
        // Skip: host cell (has video via _attachHostVideoToCell), own cell (direct stream).
        if (!g.isHost && g.uid && g.uid !== _user?.id && _mode === 'viewer') {
          _viewerSubscribeGuestRelay(g.uid);
        }
      } else {
        // ── Update existing card ──
        const camIcon = card.querySelector('.vgc-icon-cam');
        const micIcon = card.querySelector('.vgc-icon-mic');
        const camOff  = card.querySelector('.vgc-cam-off');
        if (camIcon) camIcon.textContent = g.camOn !== false ? '📷' : '🚫';
        if (micIcon) micIcon.textContent = g.micOn !== false ? '🎤' : '🔇';
        if (camOff)  camOff.classList.toggle('vgc-cam-off--visible', g.camOn === false);
        // When cam turns back on, resume the video element in case it was paused
        if (g.camOn !== false) {
          const vid = card.querySelector('video');
          if (vid && vid.paused) vid.play().catch(() => {});
        }
        // Update own cell uid check
        if (g.uid === _user?.id && _guestStream) {
          _attachGuestSelfStream(_guestStream);
        }
        // Ensure host video is attached if not yet (e.g. stream arrived after card was built)
        if (g.isHost && !card.querySelector('video')) {
          _attachHostVideoToCell(card);
        }
        // Re-attach self-stream if this is the viewer's own cell and video is missing
        // (can happen if the RTDB card was built before _guestStream was set)
        if (_guestStream && g.uid === _user?.id && !card.querySelector('video')) {
          _attachGuestSelfStream(_guestStream);
        }
        // Re-trigger relay subscription for non-own, non-host cells that still lack video
        // (handles the case where the relay offer arrived after the card was first built)
        if (!g.isHost && g.uid && g.uid !== _user?.id && _mode === 'viewer' && !card.querySelector('video')) {
          _viewerSubscribeGuestRelay(g.uid);
        }
      }
    });

    // ── Show/hide grid based on whether any guests are present ──
    const guestCount = orderedKeys.filter(k => !incoming[k].isHost).length;
    grid.dataset.count = guestCount.toString();
    if (guestCount > 0) {
      grid.classList.add('has-guests');
    } else {
      grid.classList.remove('has-guests');
    }
    _applyGuestLayout();
  };

  // Handle guest presence events
  ch.on('broadcast', { event: 'presence' }, msg => {
    const g = msg.payload || {};
    if (g.uid) { _guestPresence[g.uid] = g; _handleGuestPresence(); }
  });
  ch.on('broadcast', { event: 'host-cam' }, msg => {
    const g = _guestPresence['_host_'];
    if (g) { g.camOn = msg.payload?.camOn; _handleGuestPresence(); }
  });
  ch.on('broadcast', { event: 'host-mic' }, msg => {
    const g = _guestPresence['_host_'];
    if (g) { g.micOn = msg.payload?.micOn; _handleGuestPresence(); }
  });
  ch.on('broadcast', { event: 'guest-leave' }, msg => {
    const uid = msg.payload?.uid;
    if (uid) { delete _guestPresence[uid]; _handleGuestPresence(); }
  });

  _viewerGuestUnsub = () => _removeChannel(`live-guests-${_roomId}`);

  // Initial render
  _handleGuestPresence();
}

/* ── Attach the host's live video stream into a viewer-side host cell ──
   The host stream arrives via WebRTC on #liveVideo. We create a <video>
   element in the host cell that reads from the same MediaStream so the
   host camera is always visible, even when the guest grid is shown. */
function _attachHostVideoToCell(cell) {
  const _tryAttach = (attempts) => {
    const liveVid = D.liveVideo;
    if (!liveVid) return;
    const stream = liveVid.srcObject;
    if (!stream) {
      // Host stream not yet arrived — retry up to 30 times (3 seconds)
      if (attempts > 0) setTimeout(() => _tryAttach(attempts - 1), 100);
      return;
    }
    // If a video element already exists, just refresh its srcObject in case
    // the stream changed (e.g. after reconnect) — avoids a black host cell.
    const existing = cell.querySelector('video');
    if (existing) {
      if (existing.srcObject !== stream) {
        existing.srcObject = stream;
        existing.play().catch(() => {});
      }
      return;
    }
    const vid = document.createElement('video');
    vid.autoplay   = true;
    vid.muted      = false;   // viewers should hear the host
    vid.playsInline = true;
    vid.srcObject  = stream;
    vid.play().catch(() => {});
    // Insert before the name label so it sits behind the overlay elements
    const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
    cell.insertBefore(vid, nameEl || null);
    // Hide avatar once video is attached
    const avatar = cell.querySelector('.vgc-avatar');
    if (avatar) avatar.style.display = 'none';
    // Hide cam-off overlay (host cam state already reflects in the card)
    const camOff = cell.querySelector('.vgc-cam-off');
    if (camOff) camOff.classList.remove('vgc-cam-off--visible');
  };
  _tryAttach(30);
}

/* ═══════════════════════════════════════════════════════════════
   GUEST BOX SYSTEM
   ─────────────────────────────────────────────────────────────
   RTDB paths used:
     guestRequests/{roomId}/{viewerUid}  → { uid, name, avatar, status:'pending'|'accepted'|'declined' }
     guestSignaling/{roomId}/{viewerUid} → { offer, answer, guestCandidates:{}, hostCandidates:{} }

   Flow:
     Viewer:  taps "Request a Box"
              → writes guestRequests/{roomId}/{uid}  status:'pending'
              → watches status node for 'accepted' / 'declined'

     Host:    listens to guestRequests/{roomId}
              → sees pending card → Accept / Decline
              Accept → writes status:'accepted'  + initiates WebRTC offer
              Decline → removes request node

     WebRTC:  host is offerer, guest is answerer (like creator/viewer main flow)
   ═══════════════════════════════════════════════════════════════ */

/* ── VIEWER: Request a Box ── */
async function _viewerRequestBox() {
  console.log('[BoxRequest] Request button clicked');

  // ── Guard: user must be logged in ──
  if (!_user) {
    console.warn('[BoxRequest] User not authenticated');
    toast('❌ Please sign in to request a box.');
    return;
  }

  // ── Guard: anonymous users are blocked by Firestore rules ──
  if (_user.isAnonymous) {
    toast('❌ Sign in with an account to request a box.');
    return;
  }

  // ── Guard: user data must be loaded ──
  if (!_userData) {
    toast('Loading your profile… Please try again.');
    return;
  }

  // ── Guard: must have a valid room ──
  if (!_roomId) {
    console.warn('[BoxRequest] Missing liveId (roomId is null)');
    toast('❌ No live stream found. Try refreshing.');
    return;
  }

  const btn = D.btnRequestBox;

  // ── Guard: already in a guest box ──
  if (_guestStream || _guestPc) {
    console.log('[BoxRequest] Viewer already in a guest box');
    return;
  }

  // ── Guard: already has a pending request ──
  if (btn && btn.classList.contains('pending')) {
    console.log('[BoxRequest] Viewer already has a pending request');
    toast('Your request is already pending…');
    return;
  }

  // ── Resolve hostId from live_rooms ──
  let hostId = null;
  try {
    const roomRow = await _dbGet('live_rooms', _roomId);
    hostId = roomRow?.host_id || null;
  } catch (e) {
    toast('❌ Could not connect. Please try again.');
    return;
  }

  if (!hostId) {
    toast('❌ Could not find stream host. Try refreshing.');
    return;
  }

  const viewerName   = _userData.display_name || _userData.username || _user.email?.split('@')[0] || 'Guest';
  const viewerAvatar = _userData.avatar || '';
  const requestId    = `${_roomId}_${_user.uid}`;

  // ── Write to Firestore box_requests ──
  try {
    await _fbSetDoc(_fbDoc(_fbDb, 'box_requests', requestId), {
      id:          requestId,
      room_id:     _roomId,
      viewer_uid:  _user.uid,
      viewer_name: viewerName,
      status:      'pending',
      created_at:  _fbServerTs(),
    }, { merge: true });
  } catch (e) {
    toast('❌ Could not send request. Please try again.');
    return;
  }

  // ── Signal host via broadcast ──
  try {
    await _rtBroadcast(`live-guest-sig-${_roomId}`, 'guest-request', {
      uid:       _user.uid,
      name:      viewerName,
      avatar:    viewerAvatar,
      requestId,
      status:    'pending',
      ts:        Date.now(),
    });
  } catch (e) {
    // Non-fatal — box_requests is source of truth for host notification
  }

  // ── Update button to show pending state ──
  if (btn) btn.classList.add('pending');
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Waiting…';
  toast('📺 Request sent to host!');

  // ── Watch box_requests status for host response (Firestore onSnapshot) ──
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  // Firestore listener fires immediately with current data, then on every update
  const _stopDbWatch = _fbOnSnapshot(_fbDoc(_fbDb, 'box_requests', requestId), async snap => {
    if (!snap.exists()) return;
    const status = snap.data()?.status;

    if (status === 'accepted') {
      if (btn) { btn.classList.remove('pending'); btn.style.display = 'none'; }
      toast('✅ Accepted! Joining as guest…');
      if (_guestStatusUnsub) { _guestStatusUnsub(); _guestStatusUnsub = null; }
      await _guestJoinAsViewer();

    } else if (status === 'declined') {
      if (btn) btn.classList.remove('pending');
      if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
      toast('Request declined.');
      if (_guestStatusUnsub) { _guestStatusUnsub(); _guestStatusUnsub = null; }
      _fbDeleteDoc(_fbDoc(_fbDb, 'box_requests', requestId)).catch(() => {});
    }
  });

  // Also listen via Supabase Broadcast for an instant host response (no DB round-trip)
  const _statusCh = _getChannel(`box-request-${requestId}`);
  _statusCh.on('broadcast', { event: 'request-response' }, async msg => {
    if (msg.payload?.requestId !== requestId) return;
    if (msg.payload?.status === 'accepted') {
      if (btn) { btn.classList.remove('pending'); btn.style.display = 'none'; }
      toast('✅ Accepted! Joining as guest…');
      if (_guestStatusUnsub) { _guestStatusUnsub(); _guestStatusUnsub = null; }
      await _guestJoinAsViewer();
    } else if (msg.payload?.status === 'declined') {
      if (btn) btn.classList.remove('pending');
      if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
      toast('Request declined.');
      if (_guestStatusUnsub) { _guestStatusUnsub(); _guestStatusUnsub = null; }
    }
  });

  _guestStatusUnsub = () => {
    _stopDbWatch();
    _removeChannel(`box-request-${requestId}`);
  };
}

/* ── VIEWER: Guest cam toggle ── */
function _toggleGuestCam() {
  if (!_guestStream) return;
  _guestCamOn = !_guestCamOn;
  _guestStream.getVideoTracks().forEach(t => { t.enabled = _guestCamOn; });
  if (D.btnGuestCam) D.btnGuestCam.classList.toggle('off', !_guestCamOn);
  if (D.btnGuestCamLabel) D.btnGuestCamLabel.textContent = _guestCamOn ? 'Cam' : 'Cam Off';
  const icon = D.btnGuestCam && D.btnGuestCam.querySelector('span:first-child');
  if (icon) icon.textContent = _guestCamOn ? '📷' : '🚫';
  // Broadcast cam state so host and other viewers see the change
  if (_user && _roomId) _rtBroadcast(`live-guests-${_roomId}`, 'guest-cam', { uid: _user.uid, camOn: _guestCamOn }).catch(() => {});
  if (_user && _roomId) {
    const g = _guestPresence[_user.uid];
    if (g) { g.camOn = _guestCamOn; }
  }
}

/* ── VIEWER: Guest mic toggle ── */
function _toggleGuestMic() {
  if (!_guestStream) return;
  _guestMicOn = !_guestMicOn;
  _guestStream.getAudioTracks().forEach(t => { t.enabled = _guestMicOn; });
  if (D.btnGuestMic) D.btnGuestMic.classList.toggle('off', !_guestMicOn);
  if (D.btnGuestMicLabel) D.btnGuestMicLabel.textContent = _guestMicOn ? 'Mic' : 'Mic Off';
  const icon = D.btnGuestMic && D.btnGuestMic.querySelector('span:first-child');
  if (icon) icon.textContent = _guestMicOn ? '🎤' : '🔇';
  toast(_guestMicOn ? 'Mic on' : 'Mic muted');
  // Broadcast mic state so host and other viewers see the change
  if (_user && _roomId) _rtBroadcast(`live-guests-${_roomId}`, 'guest-mic', { uid: _user.uid, micOn: _guestMicOn }).catch(() => {});
  if (_user && _roomId) {
    const g = _guestPresence[_user.uid];
    if (g) { g.micOn = _guestMicOn; }
  }
}

/* ── VIEWER: Leave the guest box voluntarily ── */
async function _guestLeaveBox() {
  // Guard: only a viewer who is currently in a box can leave
  if (!_guestStream && !_guestPc) return;

  const confirmed = await _snxConfirm({
    icon:     '🚪',
    title:    'Leave guest box?',
    sub:      'You will return to watching the live stream.',
    okLabel:  'Leave Box',
    okClass:  '',
  });
  if (!confirmed) return;

  _guestDoLeave();
}

/* ── Internal: perform the guest leave cleanup (called from Leave Box or removedByHost signal) ── */
function _guestDoLeave() {
  // Stop heartbeat immediately — no more presence keep-alive
  if (_guestHeartbeatInterval) {
    clearInterval(_guestHeartbeatInterval);
    _guestHeartbeatInterval = null;
  }

  // Tear down the removedByHost listener so it cannot fire again on rejoin
  if (_guestRemovedUnsub) {
    try { _guestRemovedUnsub(); } catch(_) {}
    _guestRemovedUnsub = null;
  }

  // Tear down the host-ICE signaling listener
  if (_guestSigUnsub) {
    try { _guestSigUnsub(); } catch(_) {}
    _guestSigUnsub = null;
  }

  // Cancel the box-request status listener so it doesn't race on rejoin
  if (_guestStatusUnsub) {
    try { _guestStatusUnsub(); } catch(_) {}
    _guestStatusUnsub = null;
  }

  // Close peer connection — null it out BEFORE closing so any pending
  // onconnectionstatechange callbacks cannot trigger a second _guestDoLeave
  const pc = _guestPc;
  _guestPc = null;
  if (pc) {
    try { pc.close(); } catch(_) {}
  }

  // Broadcast departure so grid updates for everyone instantly.
  if (_user?.uid && _roomId) {
    // Broadcast departure so everyone's grid updates instantly
    _rtBroadcast(`live-guests-${_roomId}`, 'guest-leave', { uid: _user.uid }).catch(() => {});
    delete _guestPresence[_user.uid];
    // Clean up box request in Firestore
    const requestId = `${_roomId}_${_user.uid}`;
    _fbDeleteDoc(_fbDoc(_fbDb, 'box_requests', requestId)).catch(() => {});
    // Signal host to remove via guest-sig channel
    _rtBroadcast(`live-guest-sig-${_roomId}`, 'guest-leave', { uid: _user.uid }).catch(() => {});
  }

  // Stop local guest media tracks
  if (_guestStream) {
    try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_) {}
    _guestStream = null;
  }

  // Reset cam/mic state so controls start clean on next join
  _guestCamOn = true;
  _guestMicOn = true;

  // Hide guest controls, restore Request a Box button
  if (D.btnGuestCam) {
    D.btnGuestCam.style.display = 'none';
    D.btnGuestCam.classList.remove('off');
    const icon = D.btnGuestCam.querySelector('span:first-child');
    if (icon) icon.textContent = '📷';
  }
  if (D.btnGuestMic) {
    D.btnGuestMic.style.display = 'none';
    D.btnGuestMic.classList.remove('off');
    const icon = D.btnGuestMic.querySelector('span:first-child');
    if (icon) icon.textContent = '🎤';
  }
  if (D.btnGuestCamLabel) D.btnGuestCamLabel.textContent = 'Cam';
  if (D.btnGuestMicLabel) D.btnGuestMicLabel.textContent = 'Mic';
  if (D.btnLeaveBox)  D.btnLeaveBox.style.display = 'none';
  if (D.btnRequestBox) {
    D.btnRequestBox.style.display = '';
    D.btnRequestBox.classList.remove('pending');
  }
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';

  toast('You left the guest box.');
}

/* ── VIEWER: Join as a guest box (answerer) ── */
async function _guestJoinAsViewer() {
  if (!_user || !_roomId) return;

  let guestStream;
  try {
    guestStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true,
    });
  } catch (e) {
    console.error('[GuestBox] getUserMedia failed:', e.name, e.message);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      toast('❌ Camera & mic access denied. Allow in browser settings.');
    } else if (e.name === 'NotFoundError') {
      toast('❌ No camera/mic found on this device.');
    } else {
      toast('❌ Could not access camera. Please try again.');
    }
    return;
  }

  // Store stream so cam/mic toggles work
  _guestStream = guestStream;
  _guestCamOn  = true;
  _guestMicOn  = true;

  const guestSigCh = `live-guest-sig-${_roomId}`;
  const MAX_WAIT = 10000;

  // Wait for offer from host (via Broadcast channel)
  const _waitForOffer = () => new Promise((resolve, reject) => {
    const _to = setTimeout(() => reject(new Error('offer timeout')), MAX_WAIT);
    const _unsub = _rtListen(guestSigCh, 'guest-offer', (payload) => {
      if (payload.guestUid !== _user.uid) return;
      clearTimeout(_to);
      try { _unsub(); } catch(_) {}
      resolve(payload);
    });
  });

  let sigData;
  try { sigData = await _waitForOffer(); }
  catch (e) { toast('Host did not respond in time.'); guestStream.getTracks().forEach(t=>t.stop()); return; }

  const guestPc = new RTCPeerConnection(_ICE_SERVERS);

  // Add local tracks
  guestStream.getTracks().forEach(t => guestPc.addTrack(t, guestStream));

  const _pendingCands = [];
  let _answerWritten = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_answerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    try { await _rtBroadcast(guestSigCh, 'guest-candidate', { guestUid: _user.uid, from: 'guest', candidate: e.candidate.toJSON() }); } catch(_) {}
  };

  try {
    await guestPc.setRemoteDescription(new RTCSessionDescription(sigData.offer));
  } catch(e) { toast('Connection error.'); guestPc.close(); guestStream.getTracks().forEach(t=>t.stop()); return; }

  const answer = await guestPc.createAnswer();
  await guestPc.setLocalDescription(answer);

  try {
    await _rtBroadcast(guestSigCh, 'guest-answer', { guestUid: _user.uid, answer: { type: answer.type, sdp: answer.sdp } });
    _answerWritten = true;
  } catch(e) { toast('Connection error.'); guestPc.close(); guestStream.getTracks().forEach(t=>t.stop()); return; }

  // Flush pending candidates
  for (const c of _pendingCands) {
    try { await _rtBroadcast(guestSigCh, 'guest-candidate', { guestUid: _user.uid, from: 'guest', candidate: c }); } catch(_) {}
  }
  _pendingCands.length = 0;

  // Listen for more host ICE candidates — store unsub so _guestDoLeave can clean up
  if (_guestSigUnsub) { try { _guestSigUnsub(); } catch(_) {} _guestSigUnsub = null; }
  _guestSigUnsub = _rtListen(guestSigCh, 'guest-candidate', async (payload) => {
    if (payload.guestUid !== _user.uid || payload.from !== 'host') return;
    try { await guestPc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch(_) {}
  });

  // Store peer connection so disconnect handler can clean up
  _guestPc = guestPc;

  // ── Publish own presence via Broadcast so everyone (incl. self) sees this box ──
  const guestName   = _userData?.display_name || _userData?.displayName || _user.email?.split('@')[0] || 'Guest';
  const guestAvatar = _userData?.avatar || _userData?.profile_picture || _userData?.profilePicture || '';
  _guestPresence[_user.uid] = { uid: _user.uid, name: guestName, avatar: guestAvatar, camOn: true, micOn: true, joinedAt: Date.now(), hb: Date.now() };
  try {
    await _rtBroadcast(`live-guests-${_roomId}`, 'guest-join', {
      uid: _user.uid, name: guestName, avatar: guestAvatar, camOn: true, micOn: true, joinedAt: Date.now(),
    });
  } catch(_) {}

  // ── Heartbeat: broadcast presence updates so host watchdog detects live guests ──
  if (_guestHeartbeatInterval) clearInterval(_guestHeartbeatInterval);
  _guestHeartbeatInterval = setInterval(() => {
    if (!_user || !_roomId || !_guestStream) { clearInterval(_guestHeartbeatInterval); return; }
    const hb = Date.now();
    if (_guestPresence[_user.uid]) _guestPresence[_user.uid].hb = hb;
    _rtBroadcast(`live-guests-${_roomId}`, 'guest-hb', { uid: _user.uid, hb }).catch(() => {});
  }, _HEARTBEAT_INTERVAL_MS);

  // ── Subscribe to full guest grid (viewer sees all boxes including own) ──
  // If already subscribed (joined as viewer before requesting a box), it
  // is already running — the new RTDB entry above will trigger a re-render.
  // If not yet subscribed, start now.
  if (!_viewerGuestUnsub) {
    _startViewerGuestGrid();
  }

  // ── Subscribe to layout sync if not already running ──
  if (!_layoutSyncUnsub) {
    _startLayoutSync();
  }

  // ── Attach live stream to own cell once RTDB grid renders it ──
  // Poll for the cell (RTDB listener may not have fired yet)
  _attachGuestSelfStream(guestStream);

  // Show cam/mic/leave toggle buttons now that the viewer is in a box
  if (D.btnGuestCam) D.btnGuestCam.style.display = 'flex';
  if (D.btnGuestMic) D.btnGuestMic.style.display = 'flex';
  if (D.btnLeaveBox) D.btnLeaveBox.style.display  = 'flex';

  // ── Listen for host-remove signal via Broadcast ──
  // Host broadcasts 'guest-removed' when it removes this guest.
  // Guest client responds by cleaning up immediately.
  // Store the unsub in the module-level _guestRemovedUnsub so _guestDoLeave
  // can tear it down and prevent it from firing again on a future rejoin.
  if (_guestRemovedUnsub) { try { _guestRemovedUnsub(); } catch(_) {} _guestRemovedUnsub = null; }
  _guestRemovedUnsub = _rtListen(`live-guest-sig-${_roomId}`, 'guest-removed', (payload) => {
    if (payload.guestUid !== _user.uid) return;
    // Unsubscribe immediately so it only fires once
    if (_guestRemovedUnsub) { try { _guestRemovedUnsub(); } catch(_) {} _guestRemovedUnsub = null; }
    toast('The host removed you from the guest box.');
    _guestDoLeave();
  });

  // Handle peer disconnect: delegate to _guestDoLeave for consistent cleanup.
  // Use the local `guestPc` reference (not the module-level `_guestPc`) so the
  // callback still fires even after _guestDoLeave has nulled _guestPc.
  // Guard with the local reference: if _guestPc was already nulled by a prior
  // _guestDoLeave call (triggered from a different path), skip to avoid double-cleanup.
  let _guestReconnectTimer = null;
  guestPc.onconnectionstatechange = () => {
    const state = guestPc.connectionState;
    // Only react if this PC is still the active one
    if (_guestPc !== guestPc) return;

    if (state === 'failed') {
      // Hard failure — attempt one automatic recovery after a short pause.
      // Clean up the broken connection first, then trigger a fresh _guestJoinAsViewer.
      if (_guestReconnectTimer) return; // already scheduled
      _guestReconnectTimer = setTimeout(async () => {
        _guestReconnectTimer = null;
        // Ensure this PC is still the active one (nothing else cleaned up in the meantime)
        if (_guestPc !== guestPc) return;
        console.log('[GuestBox] Connection failed — attempting auto-recovery');
        toast('Connection lost. Reconnecting to guest box…');
        // Tear down broken session without showing "You left" toast
        if (_guestRemovedUnsub) { try { _guestRemovedUnsub(); } catch(_) {} _guestRemovedUnsub = null; }
        if (_guestSigUnsub)     { try { _guestSigUnsub(); }     catch(_) {} _guestSigUnsub = null; }
        if (_guestStatusUnsub)  { try { _guestStatusUnsub(); }  catch(_) {} _guestStatusUnsub = null; }
        if (_guestHeartbeatInterval) { clearInterval(_guestHeartbeatInterval); _guestHeartbeatInterval = null; }
        _guestPc = null;
        try { guestPc.close(); } catch(_) {}
        if (_guestStream) { try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_) {} _guestStream = null; }
        if (_user && _roomId) {
          delete _guestPresence[_user.uid];
          _rtBroadcast(`live-guests-${_roomId}`, 'guest-leave', { uid: _user.uid }).catch(() => {});
        }
        // Re-submit a fresh box request to trigger the full rejoin flow
        await _viewerRequestBox();
      }, 1500);
    } else if (state === 'disconnected') {
      // Transient disconnect — wait briefly, then clean up if still disconnected
      if (_guestReconnectTimer) return;
      _guestReconnectTimer = setTimeout(() => {
        _guestReconnectTimer = null;
        if (_guestPc !== guestPc) return;
        if (guestPc.connectionState !== 'connected') {
          _guestDoLeave();
        }
      }, 4000);
    } else if (state === 'connected') {
      // Recovered — cancel any pending cleanup timer
      if (_guestReconnectTimer) { clearTimeout(_guestReconnectTimer); _guestReconnectTimer = null; }
    } else if (state === 'closed') {
      if (_guestReconnectTimer) { clearTimeout(_guestReconnectTimer); _guestReconnectTimer = null; }
      if (_guestPc === guestPc) _guestDoLeave();
    }
  };
}

/* ── Attach the guest's own live stream to their cell in the Broadcast-driven grid ──
   The grid renders asynchronously; retry until the cell is found. */
function _attachGuestSelfStream(stream) {
  const uid = _user?.id;
  if (!uid || !stream) return;

  const _tryAttach = (attempts) => {
    const grid = D.guestGrid;
    if (!grid) return;
    // Find own cell by uid (rendered by _startViewerGuestGrid)
    const cell = grid.querySelector(`.vgc-cell[data-uid="${uid}"]`);
    if (cell) {
      // Create video element if missing, or reuse existing one
      let vid = cell.querySelector('video');
      if (!vid) {
        vid = document.createElement('video');
        vid.autoplay    = true;
        vid.muted       = true;   // mute self-preview to prevent echo
        vid.playsInline = true;
        // Insert before name label so it sits behind overlays
        const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
        cell.insertBefore(vid, nameEl || null);
      }
      // Always update srcObject — covers reconnect / stream replacement
      if (vid.srcObject !== stream) {
        vid.muted = true;   // re-enforce mute on self-preview
        vid.srcObject = stream;
      }
      vid.play().catch(() => {});
      // Hide avatar once video is live
      const avatar = cell.querySelector('.vgc-avatar');
      if (avatar) avatar.style.display = 'none';
      // Hide camera-off overlay since stream is live
      const camOff = cell.querySelector('.vgc-cam-off');
      if (camOff) camOff.classList.remove('vgc-cam-off--visible');
      return; // done
    }
    // Cell not yet rendered — retry up to 40 times (4 seconds total)
    if (attempts > 0) {
      setTimeout(() => _tryAttach(attempts - 1), 100);
    }
  };

  _tryAttach(40);
}

/* ── HOST: Listen for incoming guest requests (Supabase Realtime) ── */
function _hostListenForGuestRequests() {
  if (!_roomId || !_user) return;
  console.log('[BoxRequest] Host listening for guest requests on roomId:', _roomId);

  // Reset the seen-UID tracker when starting a new listen session
  _shownReqUids.clear();

  // Start the stale-guest watchdog — cleans up ghost boxes every 10 s
  _startHostGuestWatchdog();

  // ── Firestore + Broadcast: listen for new box_requests for this room ──
  // Use Supabase Broadcast for real-time guest-request signals,
  // with Firestore onSnapshot as the source-of-truth fallback.

  // Broadcast listener (fast path) — viewer sends 'guest-request' on guest-sig channel
  const sigCh = _getChannel(`live-guest-sig-${_roomId}`);
  sigCh.on('broadcast', { event: 'guest-request' }, (msg) => {
    const d = msg.payload || {};
    if (!d.uid || d.status !== 'pending') return;
    console.log('[BoxRequest] Request received by host (broadcast) from viewer:', d.uid, 'name:', d.name);
    if (_shownReqUids.has(d.uid) && !_guestPeers[d.uid]) {
      _shownReqUids.delete(d.uid);
    }
    if (!_shownReqUids.has(d.uid)) {
      _shownReqUids.add(d.uid);
      _hostShowRequestCard({
        uid:       d.uid,
        name:      d.name || 'Guest',
        avatar:    d.avatar || '',
        requestId: d.requestId || `${_roomId}_${d.uid}`,
        status:    'pending',
      });
    }
  });

  // Firestore onSnapshot fallback — catches requests from viewers who may have missed the broadcast
  const reqQ = _fbQuery(
    _fbCollection(_fbDb, 'box_requests'),
    _fbWhere('room_id', '==', _roomId),
    _fbWhere('status', '==', 'pending'),
  );

  let _reqInitialSeed = true;
  const _reqUnsub = _fbOnSnapshot(reqQ, snap => {
    if (_reqInitialSeed) { _reqInitialSeed = false; return; } // skip initial snapshot
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const d = change.doc.data();
      if (!d.viewer_uid) return;
      console.log('[BoxRequest] Request received by host (Firestore) from viewer:', d.viewer_uid, 'name:', d.viewer_name);
      if (_shownReqUids.has(d.viewer_uid) && !_guestPeers[d.viewer_uid]) {
        _shownReqUids.delete(d.viewer_uid);
      }
      if (!_shownReqUids.has(d.viewer_uid)) {
        _shownReqUids.add(d.viewer_uid);
        _hostShowRequestCard({
          uid:       d.viewer_uid,
          name:      d.viewer_name || 'Guest',
          avatar:    '',
          requestId: d.id || `${_roomId}_${d.viewer_uid}`,
          status:    'pending',
        });
      }
    });
  }, () => { /* swallow errors */ });

  _guestReqUnsub = () => {
    _reqUnsub();
    _removeChannel(`live-guest-sig-${_roomId}`);
    _shownReqUids.clear();
  };
}

/* ── HOST: Show a request card ── */
function _hostShowRequestCard(req) {
  const queue = D.guestRequestQueue;
  if (!queue) return;

  // Prevent duplicate cards
  if (queue.querySelector(`[data-uid="${req.uid}"]`)) return;

  const card = document.createElement('div');
  card.className = 'guest-request-card';
  card.dataset.uid = req.uid;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'guest-req-avatar';
  if (req.avatar) {
    avatarEl.style.backgroundImage = `url('${req.avatar}')`;
  } else {
    avatarEl.textContent = (req.name || '?')[0].toUpperCase();
  }

  const nameWrap = document.createElement('div');
  nameWrap.style.cssText = 'flex:1;min-width:0;';
  nameWrap.innerHTML = `
    <div class="guest-req-name">${_esc(req.name || 'Guest')}</div>
    <div class="guest-req-sub">wants to join your box</div>
  `;

  const actions = document.createElement('div');
  actions.className = 'guest-req-actions';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'guest-req-accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.addEventListener('click', () => {
    card.remove();
    _hostAcceptGuest(req);  // req carries requestId
  });

  const declineBtn = document.createElement('button');
  declineBtn.className = 'guest-req-decline';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', () => {
    card.remove();
    _hostDeclineGuest(req.uid, req.requestId);
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(declineBtn);
  card.appendChild(avatarEl);
  card.appendChild(nameWrap);
  card.appendChild(actions);
  queue.appendChild(card);

  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (card.parentNode) {
      card.remove();
      _hostDeclineGuest(req.uid, req.requestId);
    }
  }, 30000);
}

/* ── HOST: Accept guest ── */
async function _hostAcceptGuest(req) {
  if (!_roomId || !_localStream) return;

  // ── Cap: respect _MAX_GUESTS limit ──
  if (Object.keys(_guestPeers).length >= _MAX_GUESTS) {
    toast(`⚠️ Guest box full — max ${_MAX_GUESTS} guests.`);
    _hostDeclineGuest(req.uid, req.requestId || `${_roomId}_${req.uid}`);
    return;
  }

  const guestUid  = req.uid;
  const requestId = req.requestId || `${_roomId}_${guestUid}`;
  const guestSigCh = `live-guest-sig-${_roomId}`;

  console.log('[BoxRequest] Host accepting guest:', guestUid, 'name:', req.name);

  // ── Update Firestore box_requests status to "accepted" ──
  try {
    await _fbUpdateDoc(_fbDoc(_fbDb, 'box_requests', requestId), { status: 'accepted', updated_at: _fbServerTs() });
    console.log('[BoxRequest] box_requests status → accepted');
  } catch (e) {
    console.error('[BoxRequest] Could not update box_requests (accepted):', e);
  }

  console.log('[BoxRequest] Guest added to box — starting WebRTC signaling for:', guestUid);

  // Create peer connection for this guest
  const guestPc = new RTCPeerConnection(_ICE_SERVERS);

  // Receive guest's video/audio tracks.
  // ontrack fires once per track — use the shared stream from e.streams[0] so that
  // both video and audio tracks are always in the same MediaStream object.
  // We defer the relay/cell setup by one microtask so that both tracks are collected
  // into the stream before we create the relay offer (which needs all tracks).
  let _guestTrackStream = null;
  let _guestTrackTimer  = null;
  guestPc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    _guestTrackStream = stream;
    // Ensure this track is in the stream (for the new MediaStream([e.track]) fallback path)
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    if (_guestTrackTimer) return; // already scheduled — another track will arrive shortly
    // Defer by 150 ms so both audio+video tracks are present before relaying
    _guestTrackTimer = setTimeout(() => {
      _guestTrackTimer = null;
      const s = _guestTrackStream;
      if (!s) return;
      _hostAddGuestCell(guestUid, req.name || 'Guest', req.avatar || '', s, guestPc);
      // Relay this guest's stream to all current viewers so they can see the guest
      _hostRelayGuestToAllViewers(guestUid, s);
      // Store stream ref so late-joining viewers also receive it
      if (_guestPeers[guestUid]) _guestPeers[guestUid].stream = s;
    }, 150);
  };

  const _pendingHostCands = [];
  let _offerWritten = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) { _pendingHostCands.push(e.candidate.toJSON()); return; }
    try { await _rtBroadcast(guestSigCh, 'guest-candidate', { guestUid, from: 'host', candidate: e.candidate.toJSON() }); } catch(_) {}
  };

  let offer;
  try {
    offer = await guestPc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await guestPc.setLocalDescription(offer);
  } catch(e) { toast('Could not connect guest.'); guestPc.close(); return; }

  try {
    await _rtBroadcast(guestSigCh, 'guest-offer', { guestUid, offer: { type: offer.type, sdp: offer.sdp } });
    _offerWritten = true;
  } catch(e) { toast('Could not connect guest.'); guestPc.close(); return; }

  // Flush pending host candidates
  for (const c of _pendingHostCands) {
    try { await _rtBroadcast(guestSigCh, 'guest-candidate', { guestUid, from: 'host', candidate: c }); } catch(_) {}
  }
  _pendingHostCands.length = 0;

  // Watch for guest answer + ICE via Broadcast — store unsub so _hostDoRemoveGuest can clean up
  const _hostGuestSigUnsub = _rtListen(guestSigCh, 'guest-answer', async (payload) => {
    if (payload.guestUid !== guestUid) return;
    if (guestPc.remoteDescription === null) {
      try { await guestPc.setRemoteDescription(new RTCSessionDescription(payload.answer)); } catch(_) {}
    }
  });
  _rtListen(guestSigCh, 'guest-candidate', async (payload) => {
    if (payload.guestUid !== guestUid || payload.from !== 'guest') return;
    try { await guestPc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch(_) {}
  });
  _hostSigUnsubs[guestUid] = _hostGuestSigUnsub;

  // Store peer
  _guestPeers[guestUid] = { pc: guestPc, name: req.name, avatar: req.avatar };

  // ── Publish guest presence via Broadcast so viewers can see the new box ──
  _guestPresence[guestUid] = { uid: guestUid, name: req.name || 'Guest', avatar: req.avatar || '', camOn: true, micOn: true, joinedAt: Date.now() };
  try {
    await _rtBroadcast(`live-guests-${_roomId}`, 'guest-join', {
      uid: guestUid, name: req.name || 'Guest', avatar: req.avatar || '', camOn: true, micOn: true, joinedAt: Date.now(),
    });
  } catch(_) {}

  toast(`✅ ${req.name || 'Guest'} joined!`);
}

/* ── HOST: Decline guest ── */
async function _hostDeclineGuest(guestUid, requestId) {
  const reqId = requestId || `${_roomId}_${guestUid}`;
  console.log('[BoxRequest] Host declining guest:', guestUid);

  // ── Update Firestore box_requests status to "declined" then clean up after 5 s ──
  try {
    await _fbUpdateDoc(_fbDoc(_fbDb, 'box_requests', reqId), { status: 'declined', updated_at: _fbServerTs() });
    console.log('[BoxRequest] box_requests status → declined, viewer will be notified');
  } catch (e) {
    console.error('[BoxRequest] Could not update box_requests (declined):', e);
  }

  setTimeout(async () => {
    try { await _fbDeleteDoc(_fbDoc(_fbDb, 'box_requests', reqId)); } catch(_) {}
  }, 5000);
}

/* ── HOST: Add a guest cell to the video grid ── */
function _hostAddGuestCell(uid, name, avatar, stream, pc) {
  const grid = D.guestGrid;
  if (!grid) return;

  // If grid doesn't yet have host, add host cell first
  if (!grid.querySelector('.host-cell')) {
    _addHostCellToGrid();
  }

  // Remove any stale cell for this UID (e.g. mid-removal animation on rapid rejoin)
  const staleCell = grid.querySelector(`[data-uid="${uid}"]`);
  if (staleCell) { try { staleCell.remove(); } catch(_) {} }

  grid.classList.add('has-guests');
  grid.dataset.count = (Object.keys(_guestPeers).length).toString();

  const cell = document.createElement('div');
  cell.className = 'guest-cell';
  cell.dataset.uid = uid;

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = false;
  vid.playsInline = true;
  vid.srcObject = stream;
  vid.play().catch(()=>{});
  cell.appendChild(vid);

  // Camera-off overlay — same structure as the viewer-side vgc-cam-off so CSS applies
  const camOffEl = document.createElement('div');
  camOffEl.className = 'vgc-cam-off host-guest-cam-off';
  camOffEl.innerHTML = '<span>📷</span><span>Camera off</span>';
  cell.appendChild(camOffEl);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = name || 'Guest';
  cell.appendChild(nameEl);

  // ── Watch this guest's cam/mic state via Broadcast so the host sees the overlay ──
  const _camStateUnsub = _rtListen(`live-guests-${_roomId}`, 'guest-cam', (payload) => {
    if (payload.uid !== uid) return;
    camOffEl.classList.toggle('vgc-cam-off--visible', payload.camOn === false);
    if (payload.camOn !== false && vid.paused) vid.play().catch(() => {});
  });
  // Store unsub alongside the peer so _hostDoRemoveGuest can tear it down
  if (_guestPeers[uid]) _guestPeers[uid].camStateUnsub = _camStateUnsub;

  // Host can remove a guest by tapping ✕
  const removeBtn = document.createElement('button');
  removeBtn.className = 'guest-cell-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove guest';
  removeBtn.addEventListener('click', () => {
    _hostRemoveGuest(uid);
  });
  cell.appendChild(removeBtn);

  grid.appendChild(cell);

  // Store stream ref
  if (_guestPeers[uid]) _guestPeers[uid].stream = stream;
  if (_guestPeers[uid]) _guestPeers[uid].cell   = cell;

  _applyGuestLayout();

  // ── Fast disconnect detection: connectionstatechange fires within ~1-2 s ──
  let _dcTimer = null;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'disconnected') {
      // Give a 1.5 s grace period — WebRTC may briefly disconnect then recover
      if (!_dcTimer) {
        _dcTimer = setTimeout(() => {
          _dcTimer = null;
          // Only remove if still disconnected (not reconnected or already removed)
          if (pc.connectionState !== 'connected' && _guestPeers[uid]) {
            _hostDoRemoveGuest(uid);
          }
        }, 1500);
      }
    } else if (state === 'failed' || state === 'closed') {
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      if (_guestPeers[uid]) _hostDoRemoveGuest(uid);
    } else if (state === 'connected') {
      // Recovered — cancel any pending removal
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
    }
  };

  // ── Also monitor iceConnectionState for this guest's transport ──
  pc.oniceconnectionstatechange = () => {
    const ice = pc.iceConnectionState;
    if (ice === 'failed') {
      // Hard ICE failure — remove guest box immediately
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      if (_guestPeers[uid]) _hostDoRemoveGuest(uid);
    }
  };
}

/* ── HOST: Add own video as the host cell in the grid ── */
function _addHostCellToGrid() {
  const grid = D.guestGrid;
  if (!grid || grid.querySelector('.host-cell')) return;

  const cell = document.createElement('div');
  cell.className = 'guest-cell host-cell';

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = true;   // mute self-preview
  vid.playsInline = true;
  if (_localStream) { vid.srcObject = _localStream; vid.play().catch(()=>{}); }
  // Mirror host camera (same as main #liveVideo)
  vid.style.transform = 'scaleX(-1)';
  cell.appendChild(vid);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = _getDisplayName(_userData, _user) + ' (You)';
  cell.appendChild(nameEl);

  grid.insertBefore(cell, grid.firstChild);
}

/* ── HOST: Remove a guest (with confirmation) ── */
async function _hostRemoveGuest(uid) {
  const peer = _guestPeers[uid];
  const guestName = peer?.name || 'this guest';

  const confirmed = await _snxConfirm({
    icon:    '✕',
    title:   `Remove ${guestName}?`,
    sub:     'They will be disconnected from the guest box.',
    okLabel: 'Remove',
    okClass: '',
  });
  if (!confirmed) return;

  _hostDoRemoveGuest(uid);
}

/* ── Internal: perform the host-side guest removal ── */
function _hostDoRemoveGuest(uid) {
  // ── Signal the guest client to disconnect gracefully via Broadcast ──
  try {
    _rtBroadcast(`live-guest-sig-${_roomId}`, 'guest-removed', { guestUid: uid }).catch(() => {});
  } catch(_) {}

  // Tear down host-side signaling listener for this guest
  if (_hostSigUnsubs[uid]) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
    delete _hostSigUnsubs[uid];
  }

  // Tear down all relay PCs for this guest (viewers will see the box disappear)
  _hostTeardownGuestRelayPeers(uid);

  const peer = _guestPeers[uid];
  if (peer) {
    // Tear down cam-state RTDB listener added by _hostAddGuestCell
    if (peer.camStateUnsub) { try { peer.camStateUnsub(); } catch(_){} peer.camStateUnsub = null; }
    if (peer.pc) { try { peer.pc.close(); } catch(_){} }
    // Animate cell out (≤260ms) then remove — gives immediate visual feedback
    if (peer.cell && !peer.cell.classList.contains('removing')) {
      peer.cell.classList.add('removing');
      // Update count + re-layout immediately so remaining boxes rearrange without waiting
      delete _guestPeers[uid];
      const grid = D.guestGrid;
      if (grid) {
        const updatedCount = Object.keys(_guestPeers).length;
        grid.dataset.count = updatedCount.toString();
        if (updatedCount === 0) {
          grid.classList.remove('has-guests');
          if (D.liveVideo) { D.liveVideo.style.opacity = ''; D.liveVideo.style.pointerEvents = ''; }
        }
        _applyGuestLayout();
      }
      setTimeout(() => {
        try { peer.cell.remove(); } catch(_){}
        // Final layout pass once the DOM node is gone
        _applyGuestLayout();
      }, 260);
    } else {
      delete _guestPeers[uid];
      if (peer.cell) { try { peer.cell.remove(); } catch(_){} }
    }
  } else {
    // peer already cleaned up; just delete key if present
    delete _guestPeers[uid];
  }
  // Allow this UID to send a new request in a future session
  _shownReqUids.delete(uid);
  // Remove guest presence via Broadcast so viewers' grids update instantly
  delete _guestPresence[uid];
  _rtBroadcast(`live-guests-${_roomId}`, 'guest-leave', { uid }).catch(() => {});
  // Clean up Firestore box_request
  const requestId = `${_roomId}_${uid}`;
  _fbDeleteDoc(_fbDoc(_fbDb, 'box_requests', requestId)).catch(() => {});

  const grid = D.guestGrid;
  if (!grid) return;
  const guestCount = Object.keys(_guestPeers).length;
  grid.dataset.count = guestCount.toString();

  if (guestCount === 0) {
    // Remove host cell too, show plain main video
    grid.querySelector('.host-cell')?.remove();
    grid.classList.remove('has-guests');
    if (D.liveVideo) { D.liveVideo.style.opacity = ''; D.liveVideo.style.pointerEvents = ''; }
  }
  _applyGuestLayout();
}

/* ── HOST: Start the stale-guest watchdog ──
   Runs every 10 s and evicts any guest whose heartbeat (hb) timestamp
   is older than _STALE_THRESHOLD_MS.  Protects against ghosts from
   hard-crashes / silent network drops. */
function _startHostGuestWatchdog() {
  if (!_roomId) return;
  if (_hostWatchdogInterval) clearInterval(_hostWatchdogInterval);

  // Update in-memory presence on heartbeat broadcasts from guests
  _rtListen(`live-guests-${_roomId}`, 'guest-hb', (payload) => {
    if (_guestPresence[payload.uid]) _guestPresence[payload.uid].hb = payload.hb;
  });

  _hostWatchdogInterval = setInterval(() => {
    if (!_roomId) return;
    const now = Date.now();
    for (const [uid, g] of Object.entries(_guestPresence)) {
      if (g.isHost) continue;  // never evict host entry
      if (!g.hb) continue;     // no heartbeat data — skip
      if (now - g.hb > _STALE_THRESHOLD_MS) {
        console.log('[GuestWatchdog] Stale guest detected, evicting:', uid);
        delete _guestPresence[uid];
        _rtBroadcast(`live-guests-${_roomId}`, 'guest-leave', { uid }).catch(() => {});
        if (_guestPeers[uid]) {
          _hostDoRemoveGuest(uid);
        }
      }
    }
  }, 10000); // check every 10 s
}

/* ── Tear down all guest peers (called on endLive) ── */
function _teardownAllGuestPeers() {
  // Stop the stale-guest watchdog
  if (_hostWatchdogInterval) { clearInterval(_hostWatchdogInterval); _hostWatchdogInterval = null; }

  // Tear down all host-side signaling listeners
  for (const uid of Object.keys(_hostSigUnsubs)) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
  }
  _hostSigUnsubs = {};

  for (const uid of Object.keys(_guestPeers)) {
    const p = _guestPeers[uid];
    if (p.camStateUnsub) { try { p.camStateUnsub(); } catch(_){} }
    if (p.pc)   { try { p.pc.close(); }   catch(_){} }
    if (p.cell) { try { p.cell.remove(); } catch(_){} }
  }
  _guestPeers = {};
  if (D.guestGrid) {
    D.guestGrid.innerHTML = '';
    D.guestGrid.classList.remove('has-guests');
    D.guestGrid.dataset.count = '0';
  }
  // Clean up all pending Firestore box_requests for this room
  if (_roomId) {
    _fbGetDocs(_fbQuery(_fbCollection(_fbDb, 'box_requests'), _fbWhere('room_id', '==', _roomId)))
      .then(snap => snap.forEach(d => _fbDeleteDoc(d.ref).catch(() => {})))
      .catch(() => {});
    // Clear in-memory guest presence
    for (const uid of Object.keys(_guestPresence)) { delete _guestPresence[uid]; }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT ENGINE  —  supports 1–9 guests + host (up to 10 total cells)
   ═══════════════════════════════════════════════════════════════════ */

function _applyGuestLayout() {
  // Coalesce rapid back-to-back calls into a single rAF paint
  if (_layoutRafId) return;
  _layoutRafId = requestAnimationFrame(() => {
    _layoutRafId = null;
    _doApplyGuestLayout();
  });
}

/* ── Wire a ResizeObserver so guest boxes re-layout when the
   stage (or window) resizes — covers orientation changes, split-
   screen, keyboard appearing, etc.  Called once from startLive /
   _startViewer after the stage is shown. ── */
function _attachGuestGridResizeObserver() {
  const grid = D.guestGrid;
  if (!grid || !window.ResizeObserver) return;
  const container = grid.parentElement || grid;
  const ro = new ResizeObserver(() => { _applyGuestLayout(); });
  ro.observe(container);
  window.addEventListener('orientationchange', () => {
    setTimeout(_applyGuestLayout, 150);
  }, { passive: true });
}

/* ─────────────────────────────────────────────────────────────────
   _doApplyGuestLayout  —  the single source of truth for all
   geometry.  All explicit pixel / percentage assignments live here;
   CSS only provides the flex skeleton and default resets.

   Smart auto-layout map (guestCount = number of guests, host NOT counted):
     0  → grid hidden, main #liveVideo shown
     1  → 2 participants: 50/50 split
     2  → 3 participants: host 60% + 2 guests stacked in 40%
     3  → 4 participants: 2×2 equal grid
     4  → 5 participants: host top row 100%×55% + 4 guests equal bottom
     5  → 6 participants: 2 rows × 3 cols equal
     6  → 7 participants: host 50%×60% top-left + 6 guests equal right+bottom
     7  → 8 participants: 2 rows × 4 cols equal
     8  → 9 participants: 3 rows × 3 cols equal
     9  → 10 participants: host top-left 33%×40% + 9 guests balanced
   ───────────────────────────────────────────────────────────────── */
function _doApplyGuestLayout() {
  const grid = D.guestGrid;
  if (!grid) return;

  // ── Shared setup for both modes ──
  grid.dataset.layout = _guestLayout;
  grid.classList.remove('box-sm', 'box-md', 'box-lg');
  grid.classList.add('box-' + _guestBoxSize);

  // ── Resolve guestCount based on mode ──
  let guestCount;
  if (_mode === 'viewer') {
    // Viewer: count is maintained by _startViewerGuestGrid via dataset.count
    guestCount = parseInt(grid.dataset.count || '0', 10);
  } else {
    // Creator: count from live _guestPeers
    guestCount = Object.keys(_guestPeers).length;
    grid.dataset.count = guestCount.toString();
  }

  if (guestCount === 0) {
    grid.classList.remove('has-guests');
    return;
  }
  grid.classList.add('has-guests');

  // ── Update guest-count indicator in layout panel ──
  _updateLayoutPanelCounter(guestCount);

  // ── Clear any previously JS-set inline styles on all cells ──
  // (CSS rules handle the base; JS overrides only when needed)
  grid.querySelectorAll('.guest-cell').forEach(c => {
    c.style.width = '';
    c.style.height = '';
    c.style.position = '';
    c.style.top = '';
    c.style.right = '';
    c.style.bottom = '';
    c.style.left = '';
    c.style.flex = '';
  });
  // Reset grid flex properties
  grid.style.flexDirection = '';
  grid.style.flexWrap      = '';
  grid.style.alignContent  = '';
  grid.style.alignItems    = '';

  const totalCells = guestCount + 1; // +1 for host

  // ── Named layout modes (host manually selected) ──
  if (_guestLayout === 'grid') {
    _applyEqualGrid(grid, totalCells);
    return;
  }
  if (_guestLayout === 'float') {
    _applyFloatLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'split') {
    _applySplitLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'host-full') {
    _applyHostFullLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'host-big') {
    _applyHostBigLayout(grid, guestCount);
    return;
  }

  // ── 'auto' layout: pick best layout for current count ──
  _applyAutoLayout(grid, guestCount, totalCells);
}

/* ─────────────────────────────────────────────────────────────────
   AUTO LAYOUT  —  smart geometry for every count 1–9
   ───────────────────────────────────────────────────────────────── */
function _applyAutoLayout(grid, guestCount, totalCells) {
  const stageW = grid.offsetWidth  || window.innerWidth;
  const stageH = grid.offsetHeight || window.innerHeight;
  const isLandscape = stageW >= stageH;

  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  switch (guestCount) {

    /* ── 1 guest: 50/50 side-by-side ── */
    case 1: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'nowrap';
      grid.style.alignItems    = 'stretch';
      if (hostCell)       { hostCell.style.width = '50%';  hostCell.style.height = '100%'; }
      if (guestCells[0])  { guestCells[0].style.width = '50%'; guestCells[0].style.height = '100%'; }
      break;
    }

    /* ── 2 guests: host 60% left + 2 guests stacked right ── */
    case 2: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'stretch';
        if (hostCell)       { hostCell.style.width = '60%';  hostCell.style.height = '100%'; }
        guestCells.forEach(c => { c.style.width = '40%'; c.style.height = '50%'; });
      } else {
        // Portrait: host full top row, guests side-by-side below
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell)       { hostCell.style.width = '100%'; hostCell.style.height = '55%'; }
        guestCells.forEach(c => { c.style.width = '50%'; c.style.height = '45%'; });
      }
      break;
    }

    /* ── 3 guests: 2×2 grid ── */
    case 3: {
      _applyEqualGrid(grid, 4);
      break;
    }

    /* ── 4 guests: host full top + 4 equal bottom ── */
    case 4: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'wrap';
      grid.style.alignContent  = 'flex-start';
      if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '55%'; }
      guestCells.forEach(c => { c.style.width = '25%'; c.style.height = '45%'; });
      break;
    }

    /* ── 5 guests: 2 rows × 3 cols equal (6 cells) ── */
    case 5: {
      _applyEqualGrid(grid, 6);
      break;
    }

    /* ── 6 guests: host prominent top-left + 6 guests ──
       Portrait: host top 100%×40%, 3 guests per row below
       Landscape: host left 50%×60% + 6 guests on right in 3×2 */
    case 6: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '50%'; hostCell.style.height = '66.67%'; }
        // 3 guests on right, 3 below
        guestCells.forEach((c, i) => {
          if (i < 3) { c.style.width = '16.67%'; c.style.height = '66.67%'; }
          else       { c.style.width = '16.67%'; c.style.height = '33.33%'; }
        });
      } else {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '40%'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = '30%'; });
      }
      break;
    }

    /* ── 7 guests: 2 rows × 4 cols equal (8 cells) ── */
    case 7: {
      _applyEqualGrid(grid, 8);
      break;
    }

    /* ── 8 guests: 3×3 equal (9 cells total) ── */
    case 8: {
      _applyEqualGrid(grid, 9);
      break;
    }

    /* ── 9 guests: host top-left prominent + 9 guests ──
       Portrait: host top 100%×33% + 3 rows of 3 below
       Landscape: host left 33%×40% + 3 cols of 3 on right */
    case 9: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '34%'; hostCell.style.height = '66.67%'; }
        guestCells.forEach((c, i) => {
          if (i < 3) { c.style.width = '22%';  c.style.height = '66.67%'; }
          else       { c.style.width = '22%';  c.style.height = '33.33%'; }
        });
      } else {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '33%'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = '22.33%'; });
      }
      break;
    }

    default: {
      // Fallback for counts beyond 9 (should not happen given _MAX_GUESTS cap)
      _applyEqualGrid(grid, totalCells);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   NAMED LAYOUT HELPERS
   ───────────────────────────────────────────────────────────────── */

/* Equal grid: calculate optimal rows/cols then set dimensions */
function _applyEqualGrid(grid, totalCells) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  // Pick cols to minimise wasted space given aspect ratio
  const cols     = Math.ceil(Math.sqrt(totalCells * (stageW / Math.max(1, stageH))));
  const colsClamped = Math.max(1, Math.min(totalCells, cols));
  const rows     = Math.ceil(totalCells / colsClamped);
  const w        = (100 / colsClamped).toFixed(4) + '%';
  const h        = (100 / rows).toFixed(4) + '%';
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'stretch';
  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w;
    cell.style.height = h;
  });
}

/* Split: side-by-side — works well when guestCount ≤ 2 */
function _applySplitLayout(grid, guestCount) {
  const cells = Array.from(grid.querySelectorAll('.guest-cell'));
  const n     = cells.length;
  if (n === 0) return;
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'stretch';
  const w = (100 / n).toFixed(4) + '%';
  cells.forEach(c => { c.style.width = w; c.style.height = '100%'; });
}

/* Host full-screen — guests as responsive floating tiles */
function _applyHostFullLayout(grid, guestCount) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  const hostCell = grid.querySelector('.host-cell');
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  // Tile size: shrink when many guests to avoid overflow
  const maxPerRow  = Math.min(guestCount, Math.ceil(Math.sqrt(guestCount * 2)));
  const baseW      = Math.max(60, Math.min(160, Math.floor(stageW * 0.18)));
  const tileW      = Math.floor(baseW * (maxPerRow > 4 ? 0.75 : 1));
  const tileH      = Math.floor(tileW * 0.75);
  const gap        = Math.max(4, Math.floor(stageW * 0.012));
  const cols       = Math.max(1, Math.floor((stageW - gap) / (tileW + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.right    = (gap + col * (tileW + gap)) + 'px';
    cell.style.top      = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom   = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* Host Big: host takes most of the width, guests in a vertical strip */
function _applyHostBigLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  // Strip width: clamp to avoid tiny guest tiles
  const stripW = Math.max(80, Math.min(200, Math.floor(stageW * 0.22)));
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'stretch';

  if (hostCell) {
    hostCell.style.flex   = '1';
    hostCell.style.height = '100%';
  }

  // Stack guests in the strip — if more than 5, split into 2 sub-columns
  const subCols  = guestCount > 5 ? 2 : 1;
  const gH       = (100 / Math.ceil(guestCount / subCols)).toFixed(4) + '%';
  const gW       = (stripW / subCols) + 'px';
  guestCells.forEach(c => {
    c.style.width  = gW;
    c.style.height = gH;
    c.style.flex   = 'none';
  });
}

/* Float layout: cascade guest boxes from top-right, responsive */
function _applyFloatLayout(grid, guestCount) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  const hostCell = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  // Scale tile size down for more guests
  const base    = Math.max(55, Math.min(160, Math.floor(stageW * 0.20)));
  const tileW   = guestCount > 5 ? Math.floor(base * 0.75) : base;
  const tileH   = Math.floor(tileW * 0.75);
  const gap     = Math.max(4, Math.floor(stageW * 0.012));
  const cols    = Math.max(1, Math.floor((stageW - gap) / (tileW + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.right    = (gap + col * (tileW + gap)) + 'px';
    cell.style.top      = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom   = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* ── Update the guest count indicator inside the layout panel ── */
function _updateLayoutPanelCounter(guestCount) {
  const el = document.getElementById('_guestCountIndicator');
  if (el) {
    el.textContent = `${guestCount} / ${_MAX_GUESTS} guest${guestCount === 1 ? '' : 's'}`;
    el.style.color = guestCount >= _MAX_GUESTS ? '#ff6677' : '#00AEEF';
  }
}

/* ── Toggle layout panel ── */
function _toggleLayoutPanel() {
  _layoutPanelOpen ? _closeLayoutPanel() : _openLayoutPanel();
}

function _openLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'block';
  _layoutPanelOpen = true;
  if (D.btnLayoutSettings) D.btnLayoutSettings.classList.add('has-guests');
  // Refresh counter whenever panel opens
  const guestCount = _mode === 'creator'
    ? Object.keys(_guestPeers).length
    : parseInt(D.guestGrid?.dataset.count || '0', 10);
  _updateLayoutPanelCounter(guestCount);
}

function _closeLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'none';
  _layoutPanelOpen = false;
}

/* ═══════════════════════════════════════════════════════════════════
   LIVE TIMER
   — Tracks how long the live has been running.
   — Controlled by the host via the Settings panel toggle.
   — Displays in the top bar (host only).
   ═══════════════════════════════════════════════════════════════════ */

let _liveTimerEnabled  = false;   // host's preference (ON/OFF toggle)
let _liveTimerInterval = null;    // setInterval handle
let _liveTimerStart    = 0;       // Date.now() when live started

function _liveTimerSetEnabled(on) {
  _liveTimerEnabled = on;
  const badge = document.getElementById('liveTimerDisplay');
  if (!badge) return;
  if (on) {
    badge.classList.add('visible');
    // If the live is already running, start counting.
    // If _liveTimerStart was never set (live started before timer was enabled),
    // initialize it now so the counter starts from 0 rather than showing a huge number.
    if (_roomId) {
      if (!_liveTimerStart) _liveTimerStart = Date.now();
      _liveTimerRun();
    }
  } else {
    badge.classList.remove('visible');
    if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
    const txt = document.getElementById('liveTimerText');
    if (txt) txt.textContent = '00:00:00';
  }
}

function _liveTimerOnLiveStart() {
  _liveTimerStart = Date.now();
  if (_liveTimerEnabled) _liveTimerRun();
}

function _liveTimerOnLiveEnd() {
  if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
  const badge = document.getElementById('liveTimerDisplay');
  if (badge) badge.classList.remove('visible');
  const txt = document.getElementById('liveTimerText');
  if (txt) txt.textContent = '00:00:00';
}

function _liveTimerRun() {
  if (_liveTimerInterval) clearInterval(_liveTimerInterval);
  const txt = document.getElementById('liveTimerText');
  if (!txt) return;

  const tick = () => {
    const secs = Math.floor((Date.now() - _liveTimerStart) / 1000);
    const h    = Math.floor(secs / 3600);
    const m    = Math.floor((secs % 3600) / 60);
    const s    = secs % 60;
    txt.textContent =
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0');
  };
  tick();
  _liveTimerInterval = setInterval(tick, 1000);
}


/* ═══════════════════════════════════════════════════════════════════
   AI SAFETY SYSTEM
   — Monitors incoming live chat from Firestore in real time.
   — Detects spam, harassment, threats, hate speech, doxxing.
   — Shows a PRIVATE popup to the host only.
   — Host chooses: Ignore / Warn user / Remove comment / Remove guest.
   — Does NOT auto-punish users without host approval.
   — Completely separate from the existing client-side send-time scanner.
   ═══════════════════════════════════════════════════════════════════ */

let _aiSafetyEnabled   = false;    // host toggle
let _aiSafetyChatUnsub = null;     // Firestore listener handle
let _aiSafetySeenIds   = new Set(); // already-processed message IDs

/* Enable / disable the system */
function _aiSafetySetEnabled(on) {
  _aiSafetyEnabled = on;
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_roomId) _aiSafetyStartMonitor();
  } else {
    _aiSafetyStopMonitor();
  }
}

/* Called when live starts — starts monitor if already enabled */
function _aiSafetyOnLiveStart() {
  if (_aiSafetyEnabled && _roomId) _aiSafetyStartMonitor();
}

/* Called when live ends — clean up */
function _aiSafetyOnLiveEnd() {
  _aiSafetyStopMonitor();
  _aiSafetySeenIds.clear();
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.remove('visible');
}

function _aiSafetyStopMonitor() {
  if (_aiSafetyChatUnsub) {
    try { _aiSafetyChatUnsub(); } catch(_) {}
    _aiSafetyChatUnsub = null;
  }
}

function _aiSafetyStartMonitor() {
  _aiSafetyStopMonitor();
  if (!_roomId || _mode !== 'creator') return;

  // Use Firestore onSnapshot — seeded with initial snapshot IDs so history is skipped
  let _initialSeed = true;

  const aiQ = _fbQuery(
    _fbCollection(_fbDb, 'live_messages'),
    _fbWhere('room_id', '==', _roomId),
    _fbOrderBy('created_at', 'asc'),
    _fbLimit(50),
  );

  const _unsub = _fbOnSnapshot(aiQ, snap => {
    if (_initialSeed) {
      // First snapshot: seed all existing IDs so we don't alert on history
      _initialSeed = false;
      snap.docs.forEach(d => _aiSafetySeenIds.add(d.id));
      return;
    }
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const d = change.doc.data();
      const msgId = change.doc.id;
      if (_aiSafetySeenIds.has(msgId)) return;
      _aiSafetySeenIds.add(msgId);
      if (d.type === 'system') return;
      if (d.user_id === _user?.uid) return;
      const hit = _liveScanText(d.text || '');
      if (!hit) return;
      _aiSafetyShowWarning(hit, { text: d.text, userName: d.user_name, userId: d.user_id }, msgId);
    });
  }, () => { /* swallow errors silently */ });

  _aiSafetyChatUnsub = _unsub;
}

/* Show the private warning popup to the host */
function _aiSafetyShowWarning(rule, msgData, docId) {
  // Don't stack: dismiss existing one first
  const old = document.getElementById('_snxSafetyOverlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = '_snxSafetyOverlay';
  overlay.className = 'snx-safety-overlay';

  const userName  = msgData.userName || 'Unknown User';
  const msgText   = msgData.text     || '';
  const msgUserId = msgData.userId   || '';

  // Severity icon
  const icon = rule.severity === 'block' ? '🚫' : '⚠️';

  overlay.innerHTML = `
    <div class="snx-safety-box">
      <div class="snx-safety-header">
        <div class="snx-safety-icon">${icon}</div>
        <div class="snx-safety-title-block">
          <div class="snx-safety-title">AI Safety Alert</div>
          <div class="snx-safety-category">${rule.category} · ${rule.severity === 'block' ? 'High Risk' : 'Warning'}</div>
        </div>
      </div>
      <div class="snx-safety-body">
        <div class="snx-safety-label">Flagged Message</div>
        <div class="snx-safety-text">${_escapeHtml(msgText)}</div>
      </div>
      <div class="snx-safety-user-row">
        <span style="font-size:16px">👤</span>
        <div class="snx-safety-user-name">${_escapeHtml(userName)}</div>
        <span style="font-size:10px;color:#4a7a9a;">user</span>
      </div>
      <div class="snx-safety-actions">
        <button class="snx-safety-btn snx-safety-btn-ignore" data-action="ignore">Ignore</button>
        <button class="snx-safety-btn snx-safety-btn-warn"   data-action="warn">Warn User</button>
        <button class="snx-safety-btn snx-safety-btn-del"    data-action="delete">Remove Comment</button>
        <button class="snx-safety-btn snx-safety-btn-kick"   data-action="kick">Remove Guest</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.snx-safety-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      overlay.remove();
      const action = btn.dataset.action;

      if (action === 'ignore') {
        // Host chose to ignore — no action
        return;
      }

      if (action === 'warn') {
        // Send a system warning message visible to everyone in chat
        try {
          await _fbAddDoc(_fbCollection(_fbDb, 'live_messages'), {
            room_id:    _roomId,
            user_id:    'safety_bot',
            user_name:  'Safety Bot',
            text:       `⚠️ Please keep the community safe and respectful.`,
            type:       'system',
            created_at: _fbServerTs(),
          });
        } catch(_) {}
        toast('⚠️ Warning sent to chat.');
        return;
      }

      if (action === 'delete') {
        // Delete the flagged message from Firestore
        try {
          await _fbDeleteDoc(_fbDoc(_fbDb, 'live_messages', docId));
          toast('🗑 Comment removed.');
        } catch(_) {
          toast('Could not remove comment.');
        }
        return;
      }

      if (action === 'kick') {
        // Host must confirm before removing a guest
        if (!msgUserId) { toast('Cannot identify user to remove.'); return; }
        const confirmed = await _snxConfirm({
          icon:    '🚫',
          title:   `Remove ${userName} from this live?`,
          sub:     `They will be disconnected and cannot rejoin. This action cannot be undone.`,
          okLabel: 'Remove',
          okClass: '',
        });
        if (!confirmed) return;

        // Remove from guest boxes if present
        if (_guestPeers[msgUserId]) {
          _hostDoRemoveGuest(msgUserId);
        }
        // Delete the flagged message from Firestore
        _fbDeleteDoc(_fbDoc(_fbDb, 'live_messages', docId)).catch(() => {});
        toast('🚫 Guest removed.');
      }
    });
  });

  document.body.appendChild(overlay);

  // Auto-dismiss after 30 s if host doesn't respond
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 30000);
}

/* Tiny HTML escape for user content injected into innerHTML */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/* ═══════════════════════════════════════════════════════════════════
   SHADOW BOT ASSISTANT
   — Friendly welcome and positive messages.
   — Completely separate from AI Safety System.
   — Posts as a "Shadow Bot" system message to live chat.
   — Limits: max 2 messages per hour. Only during active live.
   ═══════════════════════════════════════════════════════════════════ */

let _shadowBotEnabled      = false;    // host toggle
let _shadowBotTimer1       = null;     // first message timer
let _shadowBotTimer2       = null;     // second message timer (if needed)
let _shadowBotMsgCount     = 0;        // messages sent this hour window
let _shadowBotHourReset    = null;     // hourly counter reset timer
let _shadowBotActive       = false;    // true only when live is running

const _SHADOW_BOT_MESSAGES = [
  'Welcome to Shadow Nexus Wave! 🔥',
  'Thanks for being here — keep the chat positive! ✨',
  'Great to see everyone here on Shadow Nexus Wave! 🔴',
  "You're all amazing — thanks for watching! 🙌",
  'This live is powered by the Shadow Nexus Wave community. Welcome! 💙',
  'Enjoying the stream? Share it with a friend! 📤',
];

function _shadowBotSetEnabled(on) {
  _shadowBotEnabled = on;
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_shadowBotActive) _shadowBotSchedule();
  } else {
    _shadowBotClearTimers();
  }
}

function _shadowBotOnLiveStart() {
  _shadowBotActive   = true;
  _shadowBotMsgCount = 0;
  if (_shadowBotEnabled) _shadowBotSchedule();
}

function _shadowBotOnLiveEnd() {
  _shadowBotActive = false;
  _shadowBotClearTimers();
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.remove('visible');
}

function _shadowBotClearTimers() {
  if (_shadowBotTimer1)    { clearTimeout(_shadowBotTimer1);    _shadowBotTimer1    = null; }
  if (_shadowBotTimer2)    { clearTimeout(_shadowBotTimer2);    _shadowBotTimer2    = null; }
  if (_shadowBotHourReset) { clearTimeout(_shadowBotHourReset); _shadowBotHourReset = null; }
}

function _shadowBotSchedule() {
  _shadowBotClearTimers();
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;

  // First message: 45–75 seconds after live starts (or bot is enabled)
  const delay1 = 45000 + Math.random() * 30000;   // 45–75 s
  // Second message: 30–40 minutes later
  const delay2 = delay1 + (30 * 60 * 1000) + Math.random() * (10 * 60 * 1000);

  _shadowBotTimer1 = setTimeout(() => _shadowBotPost(), delay1);

  // Only schedule second message if we haven't hit the hourly cap
  _shadowBotTimer2 = setTimeout(() => {
    if (_shadowBotMsgCount < 2) _shadowBotPost();
  }, delay2);

  // Reset counter every 60 minutes so the bot can post again next hour
  _shadowBotHourReset = setTimeout(() => {
    _shadowBotMsgCount = 0;
    if (_shadowBotEnabled && _shadowBotActive) _shadowBotSchedule();
  }, 60 * 60 * 1000);
}

async function _shadowBotPost() {
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;
  if (_shadowBotMsgCount >= 2) return;   // hard cap: max 2 per hour

  _shadowBotMsgCount++;

  // Pick a random message, avoid repeating the last one
  const msg = _SHADOW_BOT_MESSAGES[
    Math.floor(Math.random() * _SHADOW_BOT_MESSAGES.length)
  ];

  try {
    await _fbAddDoc(_fbCollection(_fbDb, 'live_messages'), {
      room_id:    _roomId,
      user_id:    'shadow_bot',
      user_name:  'Shadow Bot',
      text:       msg,
      type:       'system',
      created_at: _fbServerTs(),
    });
  } catch(_) {}
}


/* ═══════════════════════════════════════════════════════════════════
   AUTOMATIC INTERNET QUALITY
   — Host-only feature.  Separate from existing adaptive quality.
   — Detects connection type via Network Information API.
   — Monitors upload packet-loss, latency (RTT), and buffering every 8 s.
   — Maps network conditions to four tiers: Excellent / Good / Fair / Poor.
   — Adjusts bitrate + resolution on the outbound video sender.
   — Shows a top-bar badge and toasts the host when tier changes.
   — Prevents disconnection by pre-emptively reducing quality.
   — Auto-recovers when conditions improve.
   — Does NOT touch chat, posts, comments, Firebase, or viewer code.
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────────
let _iqEnabled       = false;    // toggled by the host
let _iqLiveActive    = false;    // true only while stream is running
let _iqTimer         = null;     // monitoring interval handle
let _iqCurrentTier   = null;     // 'excellent' | 'good' | 'fair' | 'poor'
let _iqUpgradePending = false;   // hysteresis: require two good reads to upgrade
let _iqPrevSent      = 0;
let _iqPrevLost      = 0;
let _iqPrevBytes     = 0;
let _iqPrevTs        = 0;

// ── Quality tiers ────────────────────────────────────────────────────
// Each tier: { id, label, icon, maxBitrate (bps), scaleDown, lossMax, rttMax }
const _IQ_TIERS = {
  excellent: { id: 'excellent', label: '1080p',   icon: '📶', maxBitrate: 5_500_000, scaleDown: 1,   lossMax: 0.02, rttMax: 80  },
  good:      { id: 'good',      label: '720p',    icon: '📶', maxBitrate: 3_000_000, scaleDown: 1,   lossMax: 0.08, rttMax: 150 },
  fair:      { id: 'fair',      label: '480p',    icon: '📶', maxBitrate: 1_200_000, scaleDown: 1.5, lossMax: 0.18, rttMax: 300 },
  poor:      { id: 'poor',      label: '360p',    icon: '⚠️', maxBitrate:   550_000, scaleDown: 2.5, lossMax: 1,    rttMax: Infinity },
};

// ── Network type → initial tier hint ─────────────────────────────────
const _IQ_TYPE_HINT = { '5g': 'excellent', '4g': 'good', 'wifi': 'good', 'ethernet': 'excellent' };

// ── Public lifecycle hooks ───────────────────────────────────────────

function _iqSetEnabled(on) {
  _iqEnabled = on;
  if (!on) {
    _iqStop();
    _iqHideBadge();
    return;
  }
  // If live is already running, start immediately
  if (_iqLiveActive && _rtcPc) {
    _iqStart(_rtcPc);
  }
}

function _iqOnLiveStart() {
  _iqLiveActive = true;
  if (_iqEnabled && _rtcPc) _iqStart(_rtcPc);
}

function _iqOnLiveEnd() {
  _iqLiveActive = false;
  _iqStop();
  _iqHideBadge();
}

// ── Core: start monitoring ───────────────────────────────────────────

function _iqStart(pc) {
  if (_iqTimer) return; // already running

  // Detect initial tier from Network Information API if available
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    const etype = (conn.effectiveType || '').toLowerCase(); // 'slow-2g'|'2g'|'3g'|'4g'
    const type  = (conn.type || '').toLowerCase();          // 'wifi'|'cellular'|'ethernet'|…
    let hint = null;
    if (type === 'ethernet' || type === 'wifi') {
      hint = conn.downlink >= 10 ? 'excellent' : 'good';
    } else if (etype === '4g') {
      hint = 'good';
    } else if (etype === '3g') {
      hint = 'fair';
    } else if (etype === '2g' || etype === 'slow-2g') {
      hint = 'poor';
    }
    if (hint) _iqApplyTier(pc, hint, false);
  }

  // Reset counters
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;

  _iqTimer = setInterval(() => _iqTick(pc), 8_000);

  // Also listen for connection-type changes
  if (conn) {
    conn.addEventListener('change', () => _iqOnConnectionChange(pc));
  }
}

// ── Monitoring tick (runs every 8 s) ─────────────────────────────────

async function _iqTick(pc) {
  if (!pc || pc.connectionState !== 'connected') return;
  if (!_iqEnabled || !_iqLiveActive) return;

  try {
    const stats = await pc.getStats();

    let sent  = 0, lost  = 0, bytes = 0, rtt = 0, rttCount = 0;
    let roundTripMs = null;

    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        sent  += r.packetsSent  || 0;
        lost  += r.packetsLost  || 0;
        bytes += r.bytesSent    || 0;
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        if (r.roundTripTime != null) { rtt += r.roundTripTime; rttCount++; }
      }
      // candidate-pair for RTT fallback
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        if (!rttCount) { rtt = r.currentRoundTripTime; rttCount = 1; }
      }
    });

    const now      = Date.now();
    const deltaSent = sent  - _iqPrevSent;
    const deltaLost = lost  - _iqPrevLost;
    const deltaBytes = bytes - _iqPrevBytes;
    const deltaSec   = _iqPrevTs ? (now - _iqPrevTs) / 1000 : 8;

    _iqPrevSent  = sent;
    _iqPrevLost  = lost;
    _iqPrevBytes = bytes;
    _iqPrevTs    = now;

    if (deltaSent < 5) return; // too few packets to be meaningful

    const lossRate = Math.max(0, deltaLost) / deltaSent;
    const kbps     = (deltaBytes * 8 / 1000) / deltaSec;
    roundTripMs    = rttCount ? (rtt / rttCount) * 1000 : null;

    const targetTier = _iqPickTier(lossRate, roundTripMs, kbps);
    _iqMaybeChangeTier(pc, targetTier, lossRate, roundTripMs);

  } catch(_) {}
}

// ── Pick the best tier based on current network metrics ──────────────

function _iqPickTier(lossRate, rttMs, kbps) {
  const rtt = rttMs != null ? rttMs : 0;
  if (lossRate <= _IQ_TIERS.excellent.lossMax && rtt <= _IQ_TIERS.excellent.rttMax && kbps >= 4000) return 'excellent';
  if (lossRate <= _IQ_TIERS.good.lossMax      && rtt <= _IQ_TIERS.good.rttMax      && kbps >= 1500) return 'good';
  if (lossRate <= _IQ_TIERS.fair.lossMax      && rtt <= _IQ_TIERS.fair.rttMax      && kbps >= 600)  return 'fair';
  return 'poor';
}

// ── Change-tier logic with hysteresis ────────────────────────────────

function _iqMaybeChangeTier(pc, targetTier, lossRate, rttMs) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const curIdx = order.indexOf(_iqCurrentTier ?? 'good');
  const tarIdx = order.indexOf(targetTier);

  if (tarIdx === curIdx) { _iqUpgradePending = false; return; }

  if (tarIdx > curIdx) {
    // Degrading → apply immediately (protect stream first)
    _iqUpgradePending = false;
    _iqApplyTier(pc, targetTier, true);
  } else {
    // Improving → require two consecutive good reads (hysteresis)
    if (!_iqUpgradePending) {
      _iqUpgradePending = true;
      return;
    }
    _iqUpgradePending = false;
    // Improve one step at a time
    const nextTier = order[curIdx - 1];
    _iqApplyTier(pc, nextTier, true);
  }
}

// ── Apply a quality tier to the sender ───────────────────────────────

async function _iqApplyTier(pc, tierId, notify) {
  if (_iqCurrentTier === tierId) return;
  const prev = _iqCurrentTier;
  _iqCurrentTier = tierId;
  const tier = _IQ_TIERS[tierId];

  // Apply to the video sender
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate            = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
    }
  } catch(_) {}

  // Also align the existing adaptive-quality module's tier index so they don't fight
  const legacyMap = { excellent: 0, good: 1, fair: 2, poor: 3 };
  _adaptiveQualityTierIdx = legacyMap[tierId] ?? 1;

  _iqShowBadge(tierId, tier);
  if (notify && prev !== null) _iqNotify(prev, tierId, tier);

  console.log(`[IQ] → ${tierId.toUpperCase()} (${tier.label} / ${tier.maxBitrate/1000} kbps)`);
}

// ── Handle Network Information API change event ───────────────────────

function _iqOnConnectionChange(pc) {
  if (!_iqEnabled || !_iqLiveActive) return;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  const etype = (conn.effectiveType || '').toLowerCase();
  let hint = null;
  if      (etype === '4g')                   hint = 'good';
  else if (etype === '3g')                   hint = 'fair';
  else if (etype === '2g' || etype === 'slow-2g') hint = 'poor';
  if (hint) _iqMaybeChangeTier(pc, hint, null, null);
}

// ── Badge ─────────────────────────────────────────────────────────────

function _iqShowBadge(tierId, tier) {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = `iq-visible iq-${tierId}`;
  badge.textContent = `${tier.icon} ${tier.label}`;
}

function _iqHideBadge() {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = '';
  badge.textContent = '';
  _iqCurrentTier = null;
}

// ── Toast notification to streamer ───────────────────────────────────

function _iqNotify(prevId, nextId, tier) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const improved = order.indexOf(nextId) < order.indexOf(prevId);
  const msg = improved
    ? `📶 Quality improved → ${tier.label}`
    : `⚠️ Quality reduced → ${tier.label} (weak signal)`;
  toast(msg, 3500);
}

// ── Stop & cleanup ────────────────────────────────────────────────────

function _iqStop() {
  if (_iqTimer) { clearInterval(_iqTimer); _iqTimer = null; }
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;
  // Remove network-change listener
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) conn.removeEventListener('change', _iqOnConnectionChange);
}
