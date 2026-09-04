/**
 * AURENIX RADIO — Shared Continuous Station + PWA
 * aurenix-radio.js
 *
 * Station model:
 *  • ONE authoritative station state in Supabase (radio_station table).
 *  • All listeners calculate: position = NOW() - track_started_at
 *  • advance_radio_station() RPC prevents race conditions.
 *  • Media Session API for lock-screen / BT / OS controls.
 *  • visibilitychange / pageshow reconnect — never restarts from 0:00.
 *  • PWA install prompt exposed as "Install AURENIX" button.
 *
 * Content model:
 *  AURENIX AUDIO   — uploaded files the submitter owns/has rights to.
 *                    Eligible for continuous audio playback + seek-to-position.
 *  EXTERNAL MEDIA  — YouTube, Spotify, other third-party links.
 *                    Played ONLY through official embed/link.
 *                    Audio is NEVER downloaded, extracted, or rebroadcast.
 *
 * Security:
 *  - Only approved/playing tracks appear in the public queue.
 *  - No service-role credentials in this file.
 *  - advance_radio_station is a SECURITY DEFINER RPC; the anon key suffices.
 */

import { supabase } from './supabase-client.js';

/* ════════════════════════════════════
   MODULE-LEVEL STATE
════════════════════════════════════ */
let _initialized        = false;
let _queueChannel       = null;
let _stationChannel     = null;
let _currentUser        = null;
let _activeTab          = 'player';
let _searchDebounce     = null;
let _playedThisSession  = new Set();
let _advanceLock        = false;   // prevent simultaneous advance calls
let _deferredInstall    = null;    // beforeinstallprompt event
let _mediaSessionActive = false;

const state = {
  playing:      false,
  muted:        false,
  volume:       80,
  progress:     0,
  queue:        [],        // AURENIX AUDIO rows (approved + playing)
  nowPlaying:   null,
  station:      null,      // last fetched radio_station row
};

let _audioEl       = null;
let _ytFrame       = null;
let _progressTimer = null;

/* ════════════════════════════════════
   PWA INSTALL PROMPT
════════════════════════════════════ */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
  // Show install button if it exists in the rendered shell
  const btn = document.getElementById('radio-install-btn');
  if (btn) btn.style.display = '';
});

window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const btn = document.getElementById('radio-install-btn');
  if (btn) btn.style.display = 'none';
});

/* ════════════════════════════════════
   AUTH LISTENER
════════════════════════════════════ */
window.addEventListener('aurenix:authchange', e => {
  _currentUser = e.detail.user || null;
  if (_activeTab === 'mysubs') loadMySubmissions();
  const btn = $id('rsub-submit-btn');
  if (btn) btn.disabled = !_currentUser;
  _updateSubmitGate();
});

/* ════════════════════════════════════
   NAVIGATION
════════════════════════════════════ */
window.addEventListener('aurenix:navigate', e => {
  if (e.detail.page === 'radio') {
    if (!_initialized) {
      _initialized = true;
      _initRadio();
    } else {
      _subscribeStation();
      _subscribeQueue();
    }
  } else if (e.detail.page !== 'mysubs' && e.detail.page !== 'admin') {
    _detachChannels();
  }
});

/* Auto-init when Radio is the active page on first load */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoInit);
} else {
  _autoInit();
}
function _autoInit() {
  const shell = document.getElementById('radio-shell');
  const page  = document.getElementById('page-radio');
  if (shell && page && page.classList.contains('active') && !_initialized) {
    _initialized = true;
    _initRadio();
  }
}

/* ════════════════════════════════════
   BACKGROUND / VISIBILITY HANDLING
════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    _onReturnToForeground();
  }
});

window.addEventListener('pageshow', e => {
  // bfcache restore
  if (e.persisted) _onReturnToForeground();
});

window.addEventListener('online', () => {
  if (_initialized) _onReturnToForeground();
});

async function _onReturnToForeground() {
  if (!_initialized) return;
  // Re-subscribe channels if they dropped
  _subscribeStation();
  _subscribeQueue();
  // Fetch fresh station state and resync
  await _syncToStation();
}

/* ════════════════════════════════════
   INIT
════════════════════════════════════ */
function _initRadio() {
  _createAudioElement();
  _renderRadioShell();
  _bindTabBar();
  _bindPlayerControls();
  _bindSubmitForm();
  _subscribeStation();
  _subscribeQueue();
  if (window.AURENIX_AUTH) {
    _currentUser = window.AURENIX_AUTH.getUser();
  }
  _updateSubmitGate();
  _registerServiceWorker();
}

/* ════════════════════════════════════
   SERVICE WORKER REGISTRATION
════════════════════════════════════ */
function _registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/aurenix-sw.js', { scope: '/' })
    .then(reg => {
      // Check for updates
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — show subtle update notice
            _setPlayerStatus('Update available — refresh to get the latest AURENIX.');
          }
        });
      });
    })
    .catch(() => {});
}

/* ════════════════════════════════════
   AUDIO ELEMENT
════════════════════════════════════ */
function _createAudioElement() {
  if (_audioEl) return;
  _audioEl = new Audio();
  _audioEl.preload  = 'none';
  _audioEl.volume   = state.volume / 100;
  _audioEl.addEventListener('ended',      _onAudioEnded);
  _audioEl.addEventListener('timeupdate', _onTimeUpdate);
  _audioEl.addEventListener('error',      _onAudioError);
  _audioEl.addEventListener('playing',    () => { state.playing = true;  _syncPlayBtn(); _updateMediaSession(); });
  _audioEl.addEventListener('pause',      () => { state.playing = false; _syncPlayBtn(); _updateMediaSession(); });
  _audioEl.addEventListener('waiting',    () => _setPlayerStatus('Buffering…'));
  _audioEl.addEventListener('canplay',    () => _setPlayerStatus(''));
}

/* ════════════════════════════════════
   STATION SUBSCRIPTION
   Reads radio_station singleton row and
   subscribes to Realtime updates.
════════════════════════════════════ */
function _subscribeStation() {
  if (_stationChannel) return;
  _stationChannel = supabase
    .channel('radio-station-live')
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'radio_station',
    }, payload => {
      // Station state changed (new track, idle, etc.)
      const row = payload.new;
      if (row) _applyStationState(row);
    })
    .subscribe();

  // Fetch current state immediately
  _fetchStationState();
}

async function _fetchStationState() {
  try {
    const { data } = await supabase
      .from('radio_station')
      .select('*')
      .eq('id', 'live')
      .single();
    if (data) _applyStationState(data);
  } catch (_) {}
}

/**
 * Apply a radio_station row to the local player.
 * This is the core of the shared-station logic:
 *   current position = serverNow - track_started_at
 */
function _applyStationState(row) {
  state.station = row;

  if (row.station_status === 'idle' || !row.current_track_id) {
    // Station is idle — stop playback and show idle UI
    _renderNowPlaying(null);
    if (_audioEl && !_audioEl.paused) { _audioEl.pause(); _audioEl.src = ''; }
    _clearYtFrame();
    state.playing   = false;
    state.nowPlaying = null;
    _syncPlayBtn();
    _setPlayerStatus('Station idle — next track soon');
    return;
  }

  const track       = row.current_track;
  const startedAt   = new Date(row.track_started_at).getTime();
  const serverNow   = Date.now(); // small drift acceptable; see NOTE below
  const elapsedSec  = Math.max(0, (serverNow - startedAt) / 1000);
  const duration    = row.duration_sec || null;

  // NOTE: We use Date.now() as the server clock proxy.
  // track_started_at is a DB server timestamp (UTC).
  // Typical client-server clock drift is <2 s which is imperceptible.
  // We deliberately do NOT attempt NTP correction; the browser's clock
  // is accurate enough for radio sync purposes.

  if (!track) return;

  // Detect track change
  const trackChanged = !state.nowPlaying || state.nowPlaying.uid !== track.uid;

  state.nowPlaying = track;
  _renderNowPlaying(track);

  if (track.type !== 'upload') {
    // External media — show card/embed, no seek possible
    if (trackChanged) _handleExternalTrack(track);
    return;
  }

  // AURENIX AUDIO — seek to current station position
  if (!track.url || track.url.startsWith('[')) {
    _setPlayerStatus('Audio unavailable');
    _showStartCTA(false);
    return;
  }

  if (trackChanged || _audioEl.src !== track.url) {
    _audioEl.src    = track.url;
    _audioEl.volume = state.volume / 100;
    _audioEl.muted  = state.muted;

    // Attempt to seek and autoplay at current station position
    _audioEl.addEventListener('loadedmetadata', function _onMeta() {
      _audioEl.removeEventListener('loadedmetadata', _onMeta);
      // Clamp seek to valid range
      const seekTo = duration
        ? Math.min(elapsedSec, duration - 0.5)
        : elapsedSec;
      if (seekTo > 0 && isFinite(seekTo)) {
        try { _audioEl.currentTime = seekTo; } catch (_) {}
      }
      _audioEl.play().then(() => {
        state.playing = true;
        _syncPlayBtn();
        _hideCTA();
        _updateMediaSession();
        if (trackChanged) _trackPlay(track.uid);
      }).catch(() => {
        state.playing = false;
        _syncPlayBtn();
        _showStartCTA(true);
      });
    }, { once: true });

    _audioEl.load();
  } else {
    // Same track already loaded — just verify position is not wildly off
    const actualElapsed = _audioEl.currentTime;
    const drift = Math.abs(actualElapsed - elapsedSec);
    if (drift > 5) {
      // More than 5 s off — resync
      try { _audioEl.currentTime = elapsedSec; } catch (_) {}
    }
    if (_audioEl.paused && state.playing) {
      _audioEl.play().catch(() => _showStartCTA(true));
    }
  }
}

/* ════════════════════════════════════
   SYNC ON RETURN (visibility / reconnect)
════════════════════════════════════ */
async function _syncToStation() {
  if (!state.station) {
    await _fetchStationState();
    return;
  }
  // Re-fetch to get the freshest timestamp
  await _fetchStationState();
}

/* ════════════════════════════════════
   QUEUE SUBSCRIPTION
════════════════════════════════════ */
function _subscribeQueue() {
  if (_queueChannel) return;
  _queueChannel = supabase
    .channel('radio-public-queue')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'studio_queue' }, () => {
      _refreshQueue();
    })
    .subscribe();
  _refreshQueue();
}

async function _refreshQueue() {
  try {
    const { data } = await supabase
      .from('studio_queue')
      .select('uid, title, artist, album, genre, type, content_type, url, artwork_url, status, play_count, likes, updated_at')
      .in('status', ['approved', 'playing'])
      .order('updated_at', { ascending: true });

    if (data) {
      state.queue = data.filter(t => t.content_type === 'aurenix_audio' || t.type === 'upload');
      _renderQueue();

      // If station has no state yet, try starting the first track
      if (state.station && state.station.station_status === 'idle') {
        const first = state.queue.find(t => t.status === 'approved' || t.status === 'playing');
        if (first) _attemptStationStart(first);
      }
    }
  } catch (_) {}
}

function _detachChannels() {
  if (_queueChannel) {
    try { supabase.removeChannel(_queueChannel); } catch (_) {}
    _queueChannel = null;
  }
  if (_stationChannel) {
    try { supabase.removeChannel(_stationChannel); } catch (_) {}
    _stationChannel = null;
  }
}

/* ════════════════════════════════════
   STATION START (first track)
   Called when station is idle and queue has tracks.
   Uses advance_radio_station RPC to set initial state.
════════════════════════════════════ */
async function _attemptStationStart(firstTrack) {
  if (_advanceLock) return;
  _advanceLock = true;
  try {
    const nextIdx  = state.queue.findIndex(t => t.uid === firstTrack.uid);
    const nextNext = state.queue[nextIdx + 1] || null;

    await supabase.rpc('advance_radio_station', {
      p_finished_track_id: null,
      p_next_track_id:     firstTrack.uid,
      p_next_track_json:   _trackSnapshot(firstTrack),
      p_next_next_id:      nextNext?.uid || null,
      p_next_next_json:    nextNext ? _trackSnapshot(nextNext) : null,
      p_queue_json:        state.queue.map(_trackSnapshot),
      p_duration_sec:      null,
    });
    // Realtime will fire and call _applyStationState
  } catch (_) {}
  _advanceLock = false;
}

/* ════════════════════════════════════
   ADVANCE QUEUE
   Called when current track ends.
   Uses advance_radio_station RPC.
════════════════════════════════════ */
async function _advanceQueue() {
  if (_advanceLock) return;
  _advanceLock = true;

  if (_audioEl) { _audioEl.pause(); _audioEl.src = ''; }
  _clearYtFrame();
  clearInterval(_progressTimer);
  state.playing = false;
  _syncPlayBtn();

  const finishedId  = state.nowPlaying?.uid || null;
  const currentIdx  = state.queue.findIndex(t => t.uid === finishedId);
  const next        = state.queue[currentIdx + 1] || state.queue.find(t => t.status === 'approved');
  const nextNextIdx = next ? state.queue.findIndex(t => t.uid === next.uid) : -1;
  const nextNext    = nextNextIdx >= 0 ? state.queue[nextNextIdx + 1] || null : null;

  try {
    const { data } = await supabase.rpc('advance_radio_station', {
      p_finished_track_id: finishedId,
      p_next_track_id:     next?.uid || null,
      p_next_track_json:   next ? _trackSnapshot(next) : null,
      p_next_next_id:      nextNext?.uid || null,
      p_next_next_json:    nextNext ? _trackSnapshot(nextNext) : null,
      p_queue_json:        state.queue.map(_trackSnapshot),
      p_duration_sec:      next ? (_audioEl?.duration || null) : null,
    });
    // If this client didn't win the race, data.advanced === false.
    // Either way, Realtime will broadcast the updated state to everyone.
    if (data && !data.advanced) {
      // Another client already advanced — fetch fresh state
      await _fetchStationState();
    }
  } catch (_) {
    // Fallback: fetch current state
    await _fetchStationState();
  }

  _advanceLock = false;
}

function _trackSnapshot(t) {
  if (!t) return null;
  return {
    uid:         t.uid,
    title:       t.title       || '',
    artist:      t.artist      || '',
    album:       t.album       || null,
    artwork_url: t.artwork_url || null,
    url:         t.url         || '',
    type:        t.type        || 'upload',
    genre:       t.genre       || null,
    likes:       t.likes       || 0,
  };
}

/* ════════════════════════════════════
   PLAYER CONTROLS
════════════════════════════════════ */
function _bindPlayerControls() {
  document.addEventListener('click', e => {
    const playBtn    = e.target.closest('#radio-play-btn');
    const prevBtn    = e.target.closest('#radio-prev-btn');
    const skipBtn    = e.target.closest('#radio-skip-btn');
    const volBtn     = e.target.closest('#radio-vol-btn');
    const likeBtn    = e.target.closest('#radio-like-btn');
    const startBtn   = e.target.closest('#radio-start-btn');
    const reportBtn  = e.target.closest('#radio-report-btn');
    const installBtn = e.target.closest('#radio-install-btn');

    if (playBtn)    { state.playing ? _pauseAudio() : _resumeOrJoin(); }
    if (prevBtn)    _goToPrev();
    if (skipBtn)    _advanceQueue();
    if (volBtn)     _toggleMute();
    if (likeBtn)    _likeCurrentTrack();
    if (startBtn)   { $id('radio-start-cta').style.display = 'none'; _resumeOrJoin(); }
    if (reportBtn)  _openCopyrightReport();
    if (installBtn) _triggerInstall();
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'radio-vol-slider') {
      state.volume = Number(e.target.value);
      if (_audioEl) _audioEl.volume = state.volume / 100;
    }
  });
}

/**
 * Resume if already loaded, or join the current station position.
 */
function _resumeOrJoin() {
  if (_audioEl && _audioEl.src && !_audioEl.paused) return; // already playing
  if (_audioEl && _audioEl.src && _audioEl.paused) {
    // Same track, just unpaused — resync position then resume
    _syncToStation();
    return;
  }
  // No audio loaded — join station
  _syncToStation();
}

function _pauseAudio() {
  if (_audioEl) _audioEl.pause();
  if (_ytFrame) {
    try { _ytFrame.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*'); } catch (_) {}
  }
  state.playing = false;
  _syncPlayBtn();
}

function _goToPrev() {
  // In station mode, "prev" rejoins current track from station position
  _syncToStation();
}

/* ════════════════════════════════════
   PLAYBACK HELPERS
════════════════════════════════════ */
function _handleExternalTrack(track) {
  _clearYtFrame();
  if (track.type === 'youtube') {
    _playYouTube(track);
  } else if (track.type === 'spotify' || track.type === 'external') {
    _showExternalMediaCard(track);
  }
}

function _playYouTube(track) {
  const vid = _extractYtId(track.url);
  if (!vid) { _advanceQueue(); return; }
  const artEl = $id('radio-artwork');
  if (!artEl) return;

  _ytFrame = document.createElement('iframe');
  _ytFrame.className = 'radio-yt-frame';
  _ytFrame.allow = 'autoplay; encrypted-media';
  _ytFrame.setAttribute('allowfullscreen', '');
  _ytFrame.src = `https://www.youtube.com/embed/${vid}?autoplay=1&controls=1&rel=0&modestbranding=1`;
  artEl.innerHTML = '';
  artEl.appendChild(_ytFrame);
  state.playing = true;
  _syncPlayBtn();
  _hideCTA();
  _trackPlay(track.uid);
}

function _showExternalMediaCard(track) {
  const artEl = $id('radio-artwork');
  if (!artEl) return;
  _clearYtFrame();

  let platformName = 'External Platform';
  let platformIcon = '🔗';
  let embedHtml    = '';

  if (track.type === 'spotify') {
    platformName = 'Spotify';
    platformIcon = '🎵';
    const spotifyId = _extractSpotifyEmbed(track.url);
    if (spotifyId) {
      embedHtml = `<iframe
        src="https://open.spotify.com/embed/${spotifyId}"
        width="100%" height="152"
        frameborder="0" allowtransparency="true" allow="encrypted-media"
        style="border-radius:8px; margin-top:8px;"
        title="Spotify player for ${esc(track.title)}">
      </iframe>`;
    }
  }

  artEl.innerHTML = `
    <div class="radio-external-card">
      <div class="radio-ext-icon">${platformIcon}</div>
      <div class="radio-ext-label">Hosted on ${platformName}</div>
      <div class="radio-ext-sub">This content is externally hosted. AURENIX does not download or rebroadcast it.</div>
      ${embedHtml}
      ${!embedHtml ? `<a href="${esc(track.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm" style="margin-top:10px;">Open on ${platformName} ↗</a>` : ''}
    </div>
  `;
  state.playing = false;
  _syncPlayBtn();
  _setPlayerStatus('External media — played on ' + platformName);
}

function _clearYtFrame() {
  if (_ytFrame) {
    _ytFrame.src = '';
    _ytFrame.remove();
    _ytFrame = null;
  }
}

/* ════════════════════════════════════
   PWA INSTALL
════════════════════════════════════ */
async function _triggerInstall() {
  if (!_deferredInstall) return;
  try {
    _deferredInstall.prompt();
    const { outcome } = await _deferredInstall.userChoice;
    if (outcome === 'accepted') _deferredInstall = null;
  } catch (_) {}
}

/* ════════════════════════════════════
   MEDIA SESSION API
════════════════════════════════════ */
function _updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = state.nowPlaying;
  if (!track) return;

  const artwork = [];
  if (track.artwork_url) {
    artwork.push({ src: track.artwork_url, sizes: '512x512', type: 'image/jpeg' });
    artwork.push({ src: track.artwork_url, sizes: '256x256', type: 'image/jpeg' });
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title  || 'AURENIX Radio',
    artist: track.artist || 'AURENIX',
    album:  track.album  || 'AURENIX Radio',
    artwork,
  });

  navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';

  if (!_mediaSessionActive) {
    _mediaSessionActive = true;

    navigator.mediaSession.setActionHandler('play', () => {
      _resumeOrJoin();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      _pauseAudio();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      _advanceQueue();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      _syncToStation(); // rejoin current station position
    });
    navigator.mediaSession.setActionHandler('stop', () => {
      _pauseAudio();
    });
    // seekto / seekbackward / seekforward — only for AURENIX AUDIO
    navigator.mediaSession.setActionHandler('seekto', details => {
      if (_audioEl && isFinite(details.seekTime)) {
        try { _audioEl.currentTime = details.seekTime; } catch (_) {}
      }
    });
  }
}

/* ════════════════════════════════════
   AUDIO EVENT HANDLERS
════════════════════════════════════ */
function _onAudioEnded() { _advanceQueue(); }

function _onAudioError() {
  console.warn('[Radio] Audio error on:', state.nowPlaying?.title);
  _setPlayerStatus('Unable to load track — skipping…');
  setTimeout(_advanceQueue, 2000);
}

function _onTimeUpdate() {
  if (!_audioEl || !_audioEl.duration) return;
  const pct  = (_audioEl.currentTime / _audioEl.duration) * 100;
  const fill = $id('radio-progress-fill');
  if (fill) fill.style.width = pct + '%';
  const bar  = $id('radio-progress-bar');
  if (bar)  bar.setAttribute('aria-valuenow', Math.round(pct));
  const cur  = $id('radio-time-cur');
  const dur  = $id('radio-time-dur');
  if (cur) cur.textContent = _fmtTime(_audioEl.currentTime);
  if (dur) dur.textContent = _fmtTime(_audioEl.duration);
  state.progress = pct;

  // Update Media Session position state
  if ('mediaSession' in navigator && _audioEl.duration && isFinite(_audioEl.duration)) {
    try {
      navigator.mediaSession.setPositionState({
        duration:     _audioEl.duration,
        playbackRate: _audioEl.playbackRate,
        position:     _audioEl.currentTime,
      });
    } catch (_) {}
  }
}

/* ════════════════════════════════════
   PLAY TRACKING
════════════════════════════════════ */
async function _trackPlay(trackUid) {
  if (!trackUid || _playedThisSession.has(trackUid)) return;
  _playedThisSession.add(trackUid);
  try {
    supabase.rpc('increment_radio_play_count', { track_uid: trackUid }).catch(() => {
      supabase.from('studio_queue').select('play_count').eq('uid', trackUid).single()
        .then(({ data }) => {
          if (data) supabase.from('studio_queue')
            .update({ play_count: (data.play_count || 0) + 1 })
            .eq('uid', trackUid).catch(() => {});
        });
    });
    const sessionId = _getSessionId();
    supabase.from('radio_plays').insert({
      track_uid:  trackUid,
      session_id: sessionId,
      user_uid:   _currentUser?.id || null,
    }).catch(() => {});
  } catch (_) {}
}

/* ════════════════════════════════════
   LIKES
════════════════════════════════════ */
async function _likeCurrentTrack() {
  if (!state.nowPlaying) return;
  if (!_currentUser) { window.AURENIX_AUTH?.openModal('login'); return; }
  const likeBtn = $id('radio-like-btn');
  if (likeBtn?.dataset.liked === 'true') return;
  const track    = state.nowPlaying;
  const newLikes = (track.likes || 0) + 1;
  if (likeBtn) { likeBtn.dataset.liked = 'true'; likeBtn.style.color = '#ff6680'; }
  const likesEl = $id('radio-track-likes');
  if (likesEl) likesEl.textContent = newLikes;
  await supabase.from('studio_queue')
    .update({ likes: newLikes }).eq('uid', track.uid).catch(() => {});
}

/* ════════════════════════════════════
   COPYRIGHT REPORT FORM
════════════════════════════════════ */
function _openCopyrightReport() {
  const track = state.nowPlaying;
  if (!track) return;

  const existing = $id('radio-report-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'radio-report-modal';
  overlay.className = 'radio-report-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Report copyright issue');
  overlay.innerHTML = `
    <div class="radio-report-box mech-panel mech-corner">
      <div class="radio-report-header">
        <span style="font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#ff6680;">
          ⚑ Report Copyright / Content Issue
        </span>
        <button class="radio-report-close" id="radio-report-close" aria-label="Close">✕</button>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:14px;">
        Reporting: <strong style="color:var(--text);">${esc(track.title)}</strong> by ${esc(track.artist || 'Unknown')}
      </div>
      <div class="field-group">
        <label class="field-label" for="report-reason">Reason <span style="color:var(--blood)">*</span></label>
        <select class="field-select" id="report-reason">
          <option value="">— Select reason —</option>
          <option value="copyright">Copyright violation — I own rights to this content</option>
          <option value="no_permission">Uploaded without rights or permission</option>
          <option value="rules_violation">Violates AURENIX rules</option>
          <option value="removal_request">Content should be removed</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="field-group">
        <label class="field-label" for="report-details">Details <span style="color:var(--blood)">*</span></label>
        <textarea class="field-textarea" id="report-details" placeholder="Describe the issue…" maxlength="600" style="min-height:80px;"></textarea>
      </div>
      <div class="field-group">
        <label class="field-label" for="report-contact">Contact email <span style="font-size:10px; color:var(--text-muted);">optional — kept private</span></label>
        <input class="field-input" type="email" id="report-contact" placeholder="your@email.com">
        <div class="field-hint">Your contact information will not be shared publicly.</div>
      </div>
      <div id="report-status" class="rsub-status" style="display:none;"></div>
      <div style="display:flex; gap:8px; margin-top:4px;">
        <button class="btn btn-gold" id="report-submit-btn" style="flex:1;">Submit Report</button>
        <button class="btn btn-ghost" id="radio-report-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  $id('radio-report-close').addEventListener('click',  () => overlay.remove());
  $id('radio-report-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $id('report-submit-btn').addEventListener('click', async () => {
    const reason  = ($id('report-reason')?.value  || '').trim();
    const details = ($id('report-details')?.value || '').trim();
    const contact = ($id('report-contact')?.value || '').trim();
    const statusEl = $id('report-status');

    if (!reason)  { _showFormStatus(statusEl, 'error', 'Please select a reason.'); return; }
    if (!details) { _showFormStatus(statusEl, 'error', 'Please describe the issue.'); return; }

    const btn = $id('report-submit-btn');
    btn.disabled = true; btn.textContent = 'Submitting…';

    try {
      const { error } = await supabase.from('copyright_reports').insert({
        track_uid:     track.uid,
        track_title:   track.title,
        track_artist:  track.artist || null,
        reason,
        details,
        contact_email: contact || null,
        reporter_uid:  _currentUser?.id || null,
        status:        'open',
      });
      if (error) throw error;
      _showFormStatus(statusEl, 'success', '✓ Report submitted. The AURENIX team will review it.');
      btn.textContent = 'Submitted';
      setTimeout(() => overlay.remove(), 4000);
    } catch (_) {
      _showFormStatus(statusEl, 'error', 'Unable to submit. Please try again.');
      btn.disabled = false; btn.textContent = 'Submit Report';
    }
  });
}

/* ════════════════════════════════════
   NOW PLAYING UI
════════════════════════════════════ */
function _renderNowPlaying(track) {
  const titleEl   = $id('radio-np-title');
  const artistEl  = $id('radio-np-artist');
  const albumEl   = $id('radio-np-album');
  const statusEl  = $id('radio-np-status');
  const artEl     = $id('radio-artwork');
  const likeBtn   = $id('radio-like-btn');
  const badgeEl   = $id('radio-np-source-badge');
  const reportBtn = $id('radio-report-btn');

  if (!track) {
    if (titleEl)   titleEl.textContent  = 'No signal';
    if (artistEl)  artistEl.textContent = 'Tune in below';
    if (albumEl)   albumEl.textContent  = '';
    if (statusEl)  statusEl.textContent = '◂ AURENIX RADIO';
    if (badgeEl)   { badgeEl.style.display = 'none'; badgeEl.textContent = ''; }
    if (reportBtn) reportBtn.style.display = 'none';
    if (artEl) {
      _clearYtFrame();
      artEl.style.backgroundImage = '';
      artEl.innerHTML = _defaultArtSVG();
    }
    if (likeBtn) { likeBtn.dataset.liked = 'false'; likeBtn.style.color = ''; }
    _stopEnergyRing();
    return;
  }

  if (titleEl)  titleEl.textContent  = track.title  || 'Unknown Title';
  if (artistEl) artistEl.textContent = track.artist || 'Unknown Artist';
  if (albumEl)  albumEl.textContent  = track.album  || '';
  if (statusEl) statusEl.textContent = '▸ NOW PLAYING';
  if (likeBtn)  { likeBtn.dataset.liked = 'false'; likeBtn.style.color = ''; }
  if (reportBtn) reportBtn.style.display = '';

  // Source badge
  if (badgeEl) {
    const isExternal = track.type !== 'upload';
    badgeEl.style.display = '';
    if (!isExternal) {
      badgeEl.className = 'radio-source-badge radio-source-aurenix';
      badgeEl.textContent = '◉ AURENIX AUDIO';
    } else {
      const platformMap = { youtube: 'YouTube', spotify: 'Spotify', external: 'External' };
      const platform = platformMap[track.type] || 'External';
      badgeEl.className = 'radio-source-badge radio-source-external';
      badgeEl.textContent = `🔗 ${platform} — Externally Hosted`;
    }
  }

  // Artwork (only for non-YouTube)
  if (artEl && track.type !== 'youtube') {
    _clearYtFrame();
    if (track.artwork_url) {
      artEl.style.backgroundImage = `url('${track.artwork_url}')`;
      artEl.innerHTML = '';
    } else {
      artEl.style.backgroundImage = '';
      artEl.innerHTML = _defaultArtSVG();
    }
  }

  const likesEl = $id('radio-track-likes');
  if (likesEl) likesEl.textContent = track.likes || 0;

  _startEnergyRing();
  _renderQueue();
}

/* ════════════════════════════════════
   QUEUE RENDERING
════════════════════════════════════ */
function _renderQueue() {
  const list    = $id('radio-queue-list');
  const countEl = $id('radio-queue-count');
  if (!list) return;

  const visible = state.queue.filter(t => t.status === 'approved' || t.status === 'playing');
  if (countEl) countEl.textContent = visible.length + ' track' + (visible.length !== 1 ? 's' : '');

  if (!visible.length) {
    list.innerHTML = `<div class="radio-queue-empty">Queue is empty — submit the first track!</div>`;
    return;
  }

  list.innerHTML = '';
  visible.forEach((t, i) => {
    const isPlaying = t.uid === state.nowPlaying?.uid || t.status === 'playing';
    const item = document.createElement('div');
    item.className = 'radio-queue-item' + (isPlaying ? ' rqi-active' : '');
    item.dataset.uid = t.uid;
    item.innerHTML = `
      <div class="rqi-num">${isPlaying ? '▶' : i + 1}</div>
      ${t.artwork_url
        ? `<div class="rqi-art" style="background-image:url('${esc(t.artwork_url)}')"></div>`
        : `<div class="rqi-art rqi-art-default" aria-hidden="true">♪</div>`}
      <div class="rqi-info">
        <div class="rqi-title">${esc(t.title)}</div>
        <div class="rqi-meta">${esc(t.artist || 'Unknown')}${t.genre ? ' · ' + esc(t.genre) : ''}</div>
      </div>
      <div class="rqi-right">
        ${isPlaying ? '<span class="rqi-badge rqi-playing">NOW</span>' : ''}
        <span class="rqi-source-dot rqi-source-aurenix" title="AURENIX AUDIO">◉</span>
        ${t.likes ? `<span class="rqi-likes" title="Likes">♥ ${t.likes}</span>` : ''}
      </div>
    `;
    list.appendChild(item);
  });
}

/* ════════════════════════════════════
   RENDER SHELL
════════════════════════════════════ */
function _renderRadioShell() {
  const wrap = $id('radio-shell');
  if (!wrap) return;

  wrap.innerHTML = `
    <!-- Tab bar -->
    <div class="radio-tab-bar" role="tablist" aria-label="Radio sections">
      <button class="radio-tab active" data-rtab="player"  role="tab" aria-selected="true">📻 Player</button>
      <button class="radio-tab"        data-rtab="search"  role="tab" aria-selected="false">🔍 Discover</button>
      <button class="radio-tab"        data-rtab="mysubs"  role="tab" aria-selected="false">📤 My Submissions</button>
    </div>

    <!-- ── TAB: PLAYER ── -->
    <div id="radio-tab-player" class="radio-tab-pane">
      <div class="radio-player-layout">

        <!-- Left column: Now Playing + Queue -->
        <div class="radio-left-col">

          <!-- Now Playing -->
          <div class="mech-panel mech-corner radio-now-playing-panel" id="radio-np-panel">
            <div class="radio-broadcast-header">
              <span class="radio-live-dot" aria-hidden="true"></span>
              <span class="radio-live-label">AURENIX RADIO</span>
              <div id="radio-status-text" class="radio-status-text"></div>
            </div>

            <div class="radio-artwork-wrap">
              <div class="radio-artwork" id="radio-artwork" aria-label="Track artwork">
                <div class="radio-artwork-default" aria-hidden="true">
                  <svg viewBox="0 0 80 80" fill="none" width="56" height="56">
                    <circle cx="40" cy="40" r="38" stroke="#b8860b" stroke-width="1" opacity="0.4"/>
                    <circle cx="40" cy="40" r="24" stroke="#00c9c0" stroke-width="1" opacity="0.5"/>
                    <circle cx="40" cy="40" r="8"  fill="#00c9c0"  opacity="0.6"/>
                    <line x1="40" y1="2"  x2="40" y2="16" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
                    <line x1="40" y1="64" x2="40" y2="78" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
                    <line x1="2"  y1="40" x2="16" y2="40" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
                    <line x1="64" y1="40" x2="78" y2="40" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
                  </svg>
                </div>
              </div>
              <div class="radio-energy-ring" aria-hidden="true" id="radio-energy-ring"></div>
            </div>

            <div class="radio-track-info">
              <div class="radio-np-status" id="radio-np-status">▸ NOW PLAYING</div>
              <div class="radio-np-title"  id="radio-np-title">No signal</div>
              <div class="radio-np-artist" id="radio-np-artist">Tune in below</div>
              <div class="radio-np-album"  id="radio-np-album"></div>
              <div id="radio-np-source-badge" class="radio-source-badge" style="display:none;"></div>
            </div>

            <div class="radio-progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="radio-progress-bar">
              <div class="radio-progress-bg">
                <div class="radio-progress-fill" id="radio-progress-fill" style="width:0%"></div>
              </div>
              <div class="radio-time-row">
                <span id="radio-time-cur">0:00</span>
                <span id="radio-time-dur">—</span>
              </div>
            </div>

            <div class="radio-controls-row">
              <button class="radio-ctrl radio-ctrl-mute" id="radio-vol-btn"  aria-label="Toggle mute" title="Mute">
                <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M9 3.5L5 7H2v6h3l4 3.5V3.5zM13.5 7a4 4 0 010 6M15.5 5.5a7 7 0 010 9"/></svg>
              </button>
              <button class="radio-ctrl radio-ctrl-prev" id="radio-prev-btn" aria-label="Previous track">
                <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M4 4h2v12H4zm3 6l9-6v12l-9-6z"/></svg>
              </button>
              <button class="radio-ctrl radio-ctrl-play" id="radio-play-btn" aria-label="Play / Pause">
                <svg id="radio-play-icon" viewBox="0 0 20 20" fill="currentColor" width="22" height="22"><path d="M6 4l10 6-10 6V4z"/></svg>
              </button>
              <button class="radio-ctrl radio-ctrl-next" id="radio-skip-btn" aria-label="Next track">
                <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M16 4h-2v12h2zm-3 6L4 4v12l9-6z"/></svg>
              </button>
              <button class="radio-ctrl radio-ctrl-like" id="radio-like-btn" aria-label="Like track" title="Like">
                <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M10 17l-1.4-1.3C4 11.5 1 9 1 6a4 4 0 017-2.6A4 4 0 0119 6c0 3-3 5.5-7.6 9.7L10 17z"/></svg>
              </button>
            </div>

            <div class="radio-vol-row">
              <span class="radio-vol-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M2 5h3l4-3v12l-4-3H2z"/></svg>
              </span>
              <input type="range" class="radio-vol-slider" id="radio-vol-slider" min="0" max="100" value="80" aria-label="Volume">
              <span class="radio-vol-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13"><path d="M2 5h3l4-3v12l-4-3H2zm9 .5a3 3 0 010 5M13 4a5 5 0 010 8"/></svg>
              </span>
            </div>

            <!-- Start Radio CTA (shown when autoplay blocked) -->
            <div id="radio-start-cta" class="radio-start-cta" style="display:none;">
              <button class="btn btn-gold" id="radio-start-btn" style="width:100%; padding:14px;">
                ▶ START AURENIX RADIO
              </button>
              <div style="font-size:11px; color:var(--text-muted); text-align:center; margin-top:8px;">
                Your browser requires interaction to begin playback
              </div>
            </div>

            <!-- Install PWA button (hidden until beforeinstallprompt fires) -->
            <div style="margin-top:10px; text-align:center;" id="radio-install-wrap">
              <button id="radio-install-btn" class="btn btn-ghost btn-sm" style="display:none;" aria-label="Install AURENIX app">
                ⬇ Install AURENIX
              </button>
            </div>

            <!-- Report copyright -->
            <div style="margin-top:12px; text-align:center;">
              <button class="radio-report-link" id="radio-report-btn" style="display:none;" aria-label="Report copyright issue">
                ⚑ Report copyright issue
              </button>
            </div>
          </div>

          <!-- Up Next Queue -->
          <div class="mech-panel mech-corner" style="margin-top:16px;">
            <div class="mech-panel-title">
              <span class="mech-panel-title-dot"></span>
              Up Next
              <span id="radio-queue-count" style="margin-left:auto; font-size:11px; color:var(--text-muted);">0 tracks</span>
            </div>
            <div id="radio-queue-list" aria-live="polite" aria-label="Radio queue"></div>
          </div>
        </div>

        <!-- Right column: Submit form -->
        <div class="radio-right-col">
          <div class="mech-panel mech-corner radio-submit-panel">
            <div class="mech-panel-title" style="border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:16px; padding-left:0;">
              <span class="mech-panel-title-dot" style="background:var(--energy);"></span>
              Submit to Radio
            </div>
            <div id="radio-submit-form-inner">
              <!-- Auth gate -->
              <div id="rsub-auth-gate" style="display:none; text-align:center; padding:30px 12px; color:var(--text-muted);">
                <div style="font-size:32px; margin-bottom:10px;">📻</div>
                <div style="font-size:13px; font-weight:700; color:var(--text-dim); margin-bottom:6px;">Sign in to submit</div>
                <div style="font-size:12px; margin-bottom:14px;">Join AURENIX to submit your music.</div>
                <button class="btn btn-gold btn-sm" onclick="window.AURENIX_AUTH?.openModal('register')">Create Account</button>
              </div>

              <!-- Submit form -->
              <div id="rsub-form-body">

                <!-- Submission type -->
                <div class="field-group">
                  <label class="field-label" for="rsub-type">Submission Type</label>
                  <select class="field-select" id="rsub-type">
                    <option value="upload">Upload Audio File — AURENIX AUDIO</option>
                    <option value="youtube">YouTube Link — External Media</option>
                    <option value="spotify">Spotify Link — External Media</option>
                    <option value="external">Other External URL — External Media</option>
                  </select>
                  <div id="rsub-type-notice" class="rsub-type-notice"></div>
                </div>

                <!-- File upload -->
                <div id="rsub-file-group" class="field-group">
                  <label class="field-label">Audio File</label>
                  <div class="rsub-drop-zone" id="rsub-file-drop" role="button" tabindex="0" aria-label="Click to select audio file">
                    <div class="rsub-drop-icon" aria-hidden="true">🎵</div>
                    <div id="rsub-drop-label" class="rsub-drop-label">Click or drag to upload</div>
                    <div class="rsub-drop-hint">MP3, WAV, AAC, FLAC · Max 50 MB</div>
                  </div>
                  <input type="file" id="rsub-file" accept="audio/*,.mp3,.wav,.aac,.flac,.ogg" style="display:none;" aria-label="Select audio file">
                </div>

                <!-- External URL -->
                <div id="rsub-url-group" class="field-group hidden">
                  <label class="field-label" for="rsub-url">URL</label>
                  <input class="field-input" type="url" id="rsub-url" placeholder="https://…">
                  <div class="field-hint" id="rsub-url-hint"></div>
                </div>

                <!-- Track metadata -->
                <div class="field-group">
                  <label class="field-label" for="rsub-title">Track Title <span style="color:var(--blood)">*</span></label>
                  <input class="field-input" type="text" id="rsub-title" placeholder="Track name" maxlength="120" required>
                </div>
                <div class="field-group">
                  <label class="field-label" for="rsub-artist">Artist / Creator <span style="color:var(--blood)">*</span></label>
                  <input class="field-input" type="text" id="rsub-artist" placeholder="Artist name" maxlength="100" required>
                </div>
                <div class="field-group">
                  <label class="field-label" for="rsub-album">Album <span style="font-size:10px; color:var(--text-muted);">optional</span></label>
                  <input class="field-input" type="text" id="rsub-album" placeholder="Album name" maxlength="100">
                </div>
                <div class="field-group">
                  <label class="field-label" for="rsub-genre">Genre <span style="font-size:10px; color:var(--text-muted);">optional</span></label>
                  <select class="field-select" id="rsub-genre">
                    <option value="">— Select genre —</option>
                    <option value="electronic">Electronic</option>
                    <option value="ambient">Ambient</option>
                    <option value="darkwave">Darkwave</option>
                    <option value="industrial">Industrial</option>
                    <option value="hip-hop">Hip-Hop</option>
                    <option value="metal">Metal</option>
                    <option value="rock">Rock</option>
                    <option value="pop">Pop</option>
                    <option value="jazz">Jazz</option>
                    <option value="classical">Classical</option>
                    <option value="world">World</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div class="field-group">
                  <label class="field-label" for="rsub-artwork">Artwork URL <span style="font-size:10px; color:var(--text-muted);">optional</span></label>
                  <input class="field-input" type="url" id="rsub-artwork" placeholder="https://… (image link)">
                </div>
                <div class="field-group">
                  <label class="field-label" for="rsub-notes">Description / Notes <span style="font-size:10px; color:var(--text-muted);">optional</span></label>
                  <textarea class="field-textarea" id="rsub-notes" placeholder="Tell moderators about this track…" maxlength="400" style="min-height:60px;"></textarea>
                </div>

                <!-- Rights confirmation — only shown for uploads -->
                <div id="rsub-rights-group" class="rsub-rights-check-wrap">
                  <label class="rsub-rights-check-label">
                    <input type="checkbox" id="rsub-rights-confirm" aria-required="true">
                    <span>
                      I confirm that I own or have the necessary rights or permission to submit this content
                      for the intended use on AURENIX.
                    </span>
                  </label>
                  <div class="rsub-rights-disclaimer">
                    Checking this box does not constitute legal verification. It is part of your submission record.
                    Submissions that violate rights will be removed.
                  </div>
                </div>

                <!-- External media notice — shown for non-uploads -->
                <div id="rsub-external-notice" class="rsub-external-notice" style="display:none;">
                  <div class="rsub-ext-icon" aria-hidden="true">🔗</div>
                  <div>
                    <strong>External Media</strong> — AURENIX will not download, extract, or rebroadcast audio
                    from this platform. Playback uses the platform's official player or link.
                    Third-party content is clearly labelled and remains hosted externally.
                  </div>
                </div>

                <div id="rsub-status" class="rsub-status" style="display:none;"></div>

                <div id="rsub-upload-progress" class="rsub-progress-wrap" style="display:none;">
                  <div class="rsub-progress-bar">
                    <div class="rsub-progress-fill" id="rsub-progress-fill" style="width:0%"></div>
                  </div>
                  <div id="rsub-progress-pct" style="font-size:11px; color:var(--text-muted); text-align:right; margin-top:4px;">0%</div>
                </div>

                <button class="btn btn-gold" id="rsub-submit-btn" style="width:100%;" aria-label="Submit to radio queue">
                  Submit
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div><!-- /tab-player -->

    <!-- ── TAB: DISCOVER / SEARCH ── -->
    <div id="radio-tab-search" class="radio-tab-pane" style="display:none;">
      <div class="radio-discover-header">
        <div class="radio-search-wrap">
          <input class="field-input" type="search" id="radio-search-input" placeholder="Search tracks, artists…" maxlength="80" aria-label="Search radio">
          <button class="btn btn-ghost btn-sm" id="radio-search-btn">Search</button>
        </div>
        <div class="radio-genre-filters" id="radio-genre-filters" role="group" aria-label="Genre filter">
          <button class="radio-genre-chip active" data-genre="">All</button>
          <button class="radio-genre-chip" data-genre="electronic">Electronic</button>
          <button class="radio-genre-chip" data-genre="ambient">Ambient</button>
          <button class="radio-genre-chip" data-genre="darkwave">Darkwave</button>
          <button class="radio-genre-chip" data-genre="hip-hop">Hip-Hop</button>
          <button class="radio-genre-chip" data-genre="metal">Metal</button>
          <button class="radio-genre-chip" data-genre="other">Other</button>
        </div>
      </div>
      <div class="radio-discover-sections">
        <div class="mech-panel mech-corner" style="margin-bottom:16px;">
          <div class="mech-panel-title"><span class="mech-panel-title-dot"></span> Popular Tracks</div>
          <div id="radio-popular-list"></div>
        </div>
        <div class="mech-panel mech-corner">
          <div class="mech-panel-title">
            <span class="mech-panel-title-dot" style="background:var(--energy);"></span>
            Search Results
            <span id="radio-search-count" style="margin-left:auto; font-size:11px; color:var(--text-muted);"></span>
          </div>
          <div id="radio-search-results"></div>
        </div>
      </div>
    </div><!-- /tab-search -->

    <!-- ── TAB: MY SUBMISSIONS ── -->
    <div id="radio-tab-mysubs" class="radio-tab-pane" style="display:none;">
      <div id="radio-mysubs-content">
        <div style="padding:20px; color:var(--text-muted); text-align:center;">Loading…</div>
      </div>
    </div><!-- /tab-mysubs -->
  `;

  _updateSubmitGate();
  _updateSubmitTypeUI();
}

/* ════════════════════════════════════
   TAB BAR
════════════════════════════════════ */
function _bindTabBar() {
  const shell = $id('radio-shell');
  if (!shell) return;
  shell.querySelectorAll('.radio-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.rtab;
      shell.querySelectorAll('.radio-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      shell.querySelectorAll('.radio-tab-pane').forEach(p => {
        p.style.display = p.id === 'radio-tab-' + _activeTab ? '' : 'none';
      });
      if (_activeTab === 'search')  _loadDiscover();
      if (_activeTab === 'mysubs') loadMySubmissions();
    });
  });
}

/* ════════════════════════════════════
   DISCOVER / SEARCH TAB
════════════════════════════════════ */
async function _loadDiscover() {
  const popList = $id('radio-popular-list');
  if (popList) {
    popList.innerHTML = '<div style="padding:14px; color:var(--text-muted); font-size:13px;">Loading…</div>';
    try {
      const { data } = await supabase
        .from('studio_queue')
        .select('uid, title, artist, genre, type, content_type, artwork_url, play_count, likes')
        .in('status', ['approved', 'playing'])
        .order('play_count', { ascending: false })
        .limit(10);
      _renderDiscoverList(popList, data || [], 'No tracks yet.');
    } catch (_) {
      popList.innerHTML = '<div style="padding:14px; color:#ff6680; font-size:13px;">Unable to load.</div>';
    }
  }

  const input = $id('radio-search-input');
  const btn   = $id('radio-search-btn');
  const chips = document.querySelectorAll('.radio-genre-chip');
  if (btn)   btn.addEventListener('click',   _doSearch);
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') _doSearch();
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(_doSearch, 400);
  });
  chips.forEach(chip => chip.addEventListener('click', () => {
    chips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    _doSearch();
  }));
}

async function _doSearch() {
  const q         = ($id('radio-search-input')?.value || '').trim();
  const genre     = document.querySelector('.radio-genre-chip.active')?.dataset.genre || '';
  const resultsEl = $id('radio-search-results');
  const countEl   = $id('radio-search-count');
  if (!resultsEl) return;

  resultsEl.innerHTML = '<div style="padding:14px; color:var(--text-muted); font-size:13px;">Searching…</div>';

  try {
    let query = supabase
      .from('studio_queue')
      .select('uid, title, artist, genre, type, content_type, artwork_url, play_count, likes')
      .in('status', ['approved', 'playing'])
      .order('play_count', { ascending: false })
      .limit(30);

    if (q)     query = query.or(`title.ilike.%${q}%,artist.ilike.%${q}%`);
    if (genre) query = query.eq('genre', genre);

    const { data } = await query;
    if (countEl) countEl.textContent = data?.length ? data.length + ' results' : '';
    _renderDiscoverList(resultsEl, data || [], q ? 'No results found.' : 'Search for tracks or artists.');
  } catch (_) {
    resultsEl.innerHTML = '<div style="padding:14px; color:#ff6680; font-size:13px;">Search unavailable.</div>';
  }
}

function _renderDiscoverList(container, items, emptyMsg) {
  if (!items.length) {
    container.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:13px;">${emptyMsg}</div>`;
    return;
  }
  container.innerHTML = '';
  items.forEach(item => {
    const isExternal = item.type !== 'upload';
    const sourceLabel = isExternal
      ? ({ youtube: 'YouTube', spotify: 'Spotify', external: 'External' }[item.type] || 'External')
      : 'AURENIX AUDIO';
    const sourceCls = isExternal ? 'rdi-badge-external' : 'rdi-badge-aurenix';

    const row = document.createElement('div');
    row.className = 'radio-discover-row';
    row.innerHTML = `
      ${item.artwork_url
        ? `<div class="rdi-art" style="background-image:url('${esc(item.artwork_url)}')"></div>`
        : `<div class="rdi-art rdi-art-default" aria-hidden="true">♪</div>`}
      <div class="rdi-info">
        <div class="rdi-title">${esc(item.title)}</div>
        <div class="rdi-meta">${esc(item.artist || 'Unknown')}${item.genre ? ' · ' + esc(item.genre) : ''}</div>
        <span class="rdi-source-badge ${sourceCls}">${sourceLabel}</span>
      </div>
      <div class="rdi-stats">
        ${item.play_count ? `<span title="Plays">▶ ${item.play_count}</span>` : ''}
        ${item.likes      ? `<span title="Likes">♥ ${item.likes}</span>`      : ''}
      </div>
    `;
    container.appendChild(row);
  });
}

/* ════════════════════════════════════
   MY SUBMISSIONS TAB
════════════════════════════════════ */
async function loadMySubmissions() {
  const container = $id('radio-mysubs-content');
  if (!container) return;

  if (!_currentUser) {
    container.innerHTML = `
      <div style="padding:40px; text-align:center; color:var(--text-muted);">
        <div style="font-size:32px; margin-bottom:12px;">📻</div>
        <div style="font-size:14px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">Sign in to view your submissions</div>
        <button class="btn btn-gold btn-sm" onclick="window.AURENIX_AUTH?.openModal('login')">Sign In</button>
      </div>`;
    return;
  }

  container.innerHTML = '<div style="padding:20px; color:var(--text-muted);">Loading your submissions…</div>';

  try {
    const { data, error } = await supabase
      .from('studio_queue')
      .select('uid, title, artist, type, content_type, status, genre, created_at, updated_at')
      .eq('submitted_by', _currentUser.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    if (!data?.length) {
      container.innerHTML = `
        <div class="mech-panel mech-corner" style="padding:40px; text-align:center; color:var(--text-muted);">
          <div style="font-size:36px; margin-bottom:12px;">📭</div>
          <div style="font-size:14px; font-weight:700; color:var(--text-dim); margin-bottom:6px;">No submissions yet</div>
          <div style="font-size:13px;">Use the Player tab to submit your music to AURENIX Radio.</div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="mech-panel mech-corner">
        <div class="mech-panel-title">
          <span class="mech-panel-title-dot"></span>
          My Submissions
          <span style="margin-left:auto; font-size:11px; color:var(--text-muted);">${data.length} total</span>
        </div>
        <div id="mysubs-list"></div>
      </div>`;

    const list = $id('mysubs-list');
    data.forEach(sub => {
      const row = document.createElement('div');
      row.className = 'radio-queue-item';
      const statusCfg = {
        pending:  { cls: 'rqi-pending',  label: 'Pending Review' },
        approved: { cls: 'rqi-approved', label: 'Approved' },
        playing:  { cls: 'rqi-playing',  label: '▶ Playing Now' },
        rejected: { cls: 'rqi-rejected', label: 'Rejected' },
        removed:  { cls: 'rqi-rejected', label: 'Removed' },
      };
      const sc = statusCfg[sub.status] || { cls: 'rqi-pending', label: sub.status };
      const isExternal = sub.type !== 'upload';
      const typeLabel  = isExternal
        ? ({ youtube: 'YouTube', spotify: 'Spotify', external: 'External' }[sub.type] || 'External')
        : 'AURENIX AUDIO';
      const typeCls = isExternal ? 'rdi-badge-external' : 'rdi-badge-aurenix';

      row.innerHTML = `
        <div class="rqi-info" style="flex:1;">
          <div class="rqi-title">${esc(sub.title)}</div>
          <div class="rqi-meta">${esc(sub.artist || 'Unknown')} · Submitted ${_fmtDate(sub.updated_at)}</div>
        </div>
        <div class="rqi-right" style="gap:6px;">
          <span class="rdi-source-badge ${typeCls}">${typeLabel}</span>
          <span class="rqi-badge ${sc.cls}">${sc.label}</span>
        </div>
      `;
      list.appendChild(row);
    });

  } catch (err) {
    console.error('[Radio] loadMySubmissions failed:', err?.message || err);
    container.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load submissions. Please try again.</div>`;
  }
}

/* ════════════════════════════════════
   SUBMIT FORM
════════════════════════════════════ */
function _bindSubmitForm() {
  document.addEventListener('change', e => {
    if (e.target.id === 'rsub-type') _updateSubmitTypeUI();
  });
  document.addEventListener('click', e => {
    if (e.target.id === 'rsub-submit-btn') _handleSubmission();
    if (e.target.id === 'rsub-file-drop' || e.target.closest('#rsub-file-drop')) {
      $id('rsub-file')?.click();
    }
  });
  document.addEventListener('dragover', e => {
    if (e.target.closest('#rsub-file-drop')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    if (e.target.closest('#rsub-file-drop')) {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) _setDroppedFile(f);
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'rsub-file') {
      const f = e.target.files?.[0];
      if (f) _setDroppedFile(f);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'rsub-file-drop' && (e.key === 'Enter' || e.key === ' ')) {
      $id('rsub-file')?.click();
    }
  });
  _updateSubmitGate();
}

function _updateSubmitTypeUI() {
  const type      = $id('rsub-type')?.value || 'upload';
  const fileGrp   = $id('rsub-file-group');
  const urlGrp    = $id('rsub-url-group');
  const rightsGrp = $id('rsub-rights-group');
  const extNotice = $id('rsub-external-notice');
  const urlHint   = $id('rsub-url-hint');
  const typeNotice= $id('rsub-type-notice');

  if (type === 'upload') {
    if (fileGrp)   fileGrp.style.display   = '';
    if (urlGrp)    urlGrp.classList.add('hidden');
    if (rightsGrp) rightsGrp.style.display = '';
    if (extNotice) extNotice.style.display = 'none';
    if (typeNotice) typeNotice.textContent  = '';
  } else {
    if (fileGrp)   fileGrp.style.display   = 'none';
    if (urlGrp)    urlGrp.classList.remove('hidden');
    if (rightsGrp) rightsGrp.style.display = 'none';
    if (extNotice) extNotice.style.display = '';
    const hints = {
      youtube:  'YouTube links play via the official YouTube embed.',
      spotify:  'Spotify links use the official Spotify embed player.',
      external: 'External URLs are presented as links. Audio is not extracted.',
    };
    if (urlHint)   urlHint.textContent  = hints[type] || '';
    if (typeNotice) typeNotice.textContent = '';
  }
}

function _updateSubmitGate() {
  const gate = $id('rsub-auth-gate');
  const body = $id('rsub-form-body');
  if (!gate || !body) return;
  if (_currentUser) {
    gate.style.display = 'none';
    body.style.display = '';
  } else {
    gate.style.display = '';
    body.style.display = 'none';
  }
}

function _setDroppedFile(file) {
  const lbl = $id('rsub-drop-label');
  if (lbl) lbl.textContent = file.name;
}

async function _handleSubmission() {
  const type    = $id('rsub-type')?.value    || 'upload';
  const title   = ($id('rsub-title')?.value  || '').trim();
  const artist  = ($id('rsub-artist')?.value || '').trim();
  const album   = ($id('rsub-album')?.value  || '').trim();
  const genre   = $id('rsub-genre')?.value   || '';
  const artwork = ($id('rsub-artwork')?.value|| '').trim();
  const notes   = ($id('rsub-notes')?.value  || '').trim();
  const rights  = $id('rsub-rights-confirm')?.checked || false;
  const statusEl= $id('rsub-status');
  const btn     = $id('rsub-submit-btn');

  if (!_currentUser) {
    _showFormStatus(statusEl, 'error', 'Please sign in to submit.');
    return;
  }
  if (!title)  { _showFormStatus(statusEl, 'error', 'Track title is required.'); return; }
  if (!artist) { _showFormStatus(statusEl, 'error', 'Artist name is required.'); return; }

  let url = '';
  let fileToUpload = null;
  let contentType  = 'aurenix_audio';

  if (type === 'upload') {
    fileToUpload = $id('rsub-file')?.files?.[0];
    if (!fileToUpload) { _showFormStatus(statusEl, 'error', 'Please select an audio file.'); return; }
    if (!rights) { _showFormStatus(statusEl, 'error', 'Please confirm you have rights to submit this content.'); return; }
    const maxBytes = 50 * 1024 * 1024;
    if (fileToUpload.size > maxBytes) { _showFormStatus(statusEl, 'error', 'File exceeds 50 MB limit.'); return; }
    contentType = 'aurenix_audio';
  } else {
    url = ($id('rsub-url')?.value || '').trim();
    if (!url) { _showFormStatus(statusEl, 'error', 'Please enter a URL.'); return; }
    contentType = 'external_media';
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  _showFormStatus(statusEl, '', '');
  if (statusEl) statusEl.style.display = 'none';

  try {
    if (fileToUpload) {
      // Upload to Supabase Storage
      const progWrap = $id('rsub-upload-progress');
      const progFill = $id('rsub-progress-fill');
      const progPct  = $id('rsub-progress-pct');
      if (progWrap) progWrap.style.display = '';

      const ext      = fileToUpload.name.split('.').pop() || 'mp3';
      const fileName = `${_currentUser.id}/${Date.now()}.${ext}`;

      const { data: upData, error: upErr } = await supabase.storage
        .from('aurenix-radio')
        .upload(fileName, fileToUpload, {
          cacheControl: '3600',
          upsert: false,
          onUploadProgress: p => {
            const pct = Math.round((p.loaded / p.total) * 100);
            if (progFill) progFill.style.width = pct + '%';
            if (progPct)  progPct.textContent  = pct + '%';
          },
        });

      if (upErr) throw upErr;

      const { data: { publicUrl } } = supabase.storage
        .from('aurenix-radio')
        .getPublicUrl(fileName);
      url = publicUrl;
      if (progWrap) progWrap.style.display = 'none';
    }

    const row = {
      title,
      artist,
      album:            album    || null,
      genre:            genre    || null,
      artwork_url:      artwork  || null,
      type,
      content_type:     contentType,
      url,
      notes,
      status:           'pending',
      rights_confirmed: rights,
      submitted_by:     _currentUser.id,
    };

    const { error: insErr } = await supabase.from('studio_queue').insert(row);
    if (insErr) throw insErr;

    _showFormStatus(statusEl, 'success', '✓ Submitted! Moderators will review your track shortly.');
    _resetSubmitForm();
  } catch (err) {
    console.error('[Radio] submission error:', err?.message || err);
    _showFormStatus(statusEl, 'error', 'Submission failed: ' + (err?.message || 'Please try again.'));
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
}

function _resetSubmitForm() {
  const ids = ['rsub-title', 'rsub-artist', 'rsub-album', 'rsub-notes', 'rsub-url', 'rsub-artwork'];
  ids.forEach(id => { const el = $id(id); if (el) el.value = ''; });
  const file  = $id('rsub-file');  if (file)  file.value  = '';
  const genre = $id('rsub-genre'); if (genre) genre.value = '';
  const lbl   = $id('rsub-drop-label'); if (lbl) lbl.textContent = 'Click or drag to upload';
  const rc    = $id('rsub-rights-confirm'); if (rc) rc.checked = false;
}

/* ════════════════════════════════════
   ENERGY RING ANIMATION
════════════════════════════════════ */
function _startEnergyRing() {
  const ring = $id('radio-energy-ring');
  if (ring) ring.classList.add('active');
}
function _stopEnergyRing() {
  const ring = $id('radio-energy-ring');
  if (ring) ring.classList.remove('active');
}

/* ════════════════════════════════════
   MISC UI HELPERS
════════════════════════════════════ */
function _syncPlayBtn() {
  const icon = $id('radio-play-icon');
  if (!icon) return;
  icon.innerHTML = state.playing
    ? '<path d="M5 3h3v14H5zm7 0h3v14h-3z"/>'
    : '<path d="M6 4l10 6-10 6V4z"/>';
}

function _toggleMute() {
  state.muted = !state.muted;
  if (_audioEl) _audioEl.muted = state.muted;
  const btn = $id('radio-vol-btn');
  if (btn) btn.style.opacity = state.muted ? '0.4' : '';
}

function _showStartCTA(show) {
  const cta = $id('radio-start-cta');
  if (cta) cta.style.display = show ? '' : 'none';
}
function _hideCTA() { _showStartCTA(false); }

function _setPlayerStatus(msg) {
  const el = $id('radio-status-text');
  if (el) el.textContent = msg;
}

function _showFormStatus(el, type, msg) {
  if (!el) return;
  if (!type && !msg) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.className = 'rsub-status rsub-status-' + type;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 9000);
}

function _defaultArtSVG() {
  return `<div class="radio-artwork-default" aria-hidden="true">
    <svg viewBox="0 0 80 80" fill="none" width="56" height="56">
      <circle cx="40" cy="40" r="38" stroke="#b8860b" stroke-width="1" opacity="0.4"/>
      <circle cx="40" cy="40" r="24" stroke="#00c9c0" stroke-width="1" opacity="0.5"/>
      <circle cx="40" cy="40" r="8"  fill="#00c9c0"  opacity="0.6"/>
      <line x1="40" y1="2"  x2="40" y2="16" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
      <line x1="40" y1="64" x2="40" y2="78" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
      <line x1="2"  y1="40" x2="16" y2="40" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
      <line x1="64" y1="40" x2="78" y2="40" stroke="#b8860b" stroke-width="1" opacity="0.5"/>
    </svg>
  </div>`;
}

/* ════════════════════════════════════
   UTILS
════════════════════════════════════ */
function $id(id)  { return document.getElementById(id); }
function esc(s)   { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _fmtTime(s) {
  if (!isFinite(s)) return '—';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function _fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }); }
  catch (_) { return ''; }
}
function _extractYtId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function _extractSpotifyEmbed(url) {
  if (!url) return null;
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}
function _getSessionId() {
  let sid = sessionStorage.getItem('aurenix_sid');
  if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem('aurenix_sid', sid); }
  return sid;
}
