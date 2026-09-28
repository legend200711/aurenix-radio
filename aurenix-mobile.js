/**
 * AURENIX MOBILE — App Experience Layer
 *
 * Handles:
 * - Cinematic splash screen lifecycle
 * - Bottom navigation (Watch / Channels / Guide / Library / Profile)
 * - Instant-on live TV (auto-tune + live position after login)
 * - Muted autoplay fallback ("TAP FOR SOUND")
 * - Picture-in-Picture
 * - Background / resume / bfcache handling
 * - Network recovery overlay
 * - Orientation / landscape fullscreen auto-expand
 * - Capacitor / WebView bridge detection
 *
 * This module coordinates with aurenix-broadcast.js via the
 * AurenixMobile global event bus (window._axMobile).
 * broadcast.js fires _axMobile.onAuth(), _axMobile.onNetworkReady(),
 * _axMobile.onChannelChange(), _axMobile.onPlayState() so the mobile
 * layer can respond without modifying broadcast.js internals.
 */

/* ── Public API exported to index.html ───────────────────────── */
export function initMobile() {
  _init();
}

/* ── Internal state ──────────────────────────────────────────── */
let _isMobile       = _detectMobile();
let _isStandalone   = _detectStandalone();
let _isCapacitor    = typeof window.Capacitor !== 'undefined';
let _activeTab      = 'watch';        // watch | channels | guide | library | profile
let _isFounder      = false;
let _userEmail      = null;
let _splashDone     = false;
let _networkReady   = false;
let _gateOpen       = false;          // mirrors broadcast.js gate state
let _mutePromptShown = false;
let _onlineTimer    = null;
let _lastOnline     = navigator.onLine;

/* Expose the mobile event bus immediately so broadcast.js can attach */
window._axMobile = {
  onAuth:          _onAuth,
  onNetworkReady:  _onNetworkReady,
  onChannelChange: _onChannelChange,
  onPlayState:     _onPlayState,
  onGateOpen:      _onGateOpen,
  hideSplash:      _hideSplash,
  showMutePrompt:  _showMutePrompt,
  hideMutePrompt:  _hideMutePrompt,
};

/* ════════════════════════════════════════
   INIT
════════════════════════════════════════ */
function _init() {
  _setupSplash();
  _setupNetworkMonitor();
  _setupOrientationHandler();
  _setupFullscreenHandler();
  _setupVisibilityHandler();
  _setupOnlineHandler();

  // On desktop → dismiss splash quickly, no mobile nav needed
  if (!_isMobile && !_isStandalone && !_isCapacitor) {
    setTimeout(_hideSplash, 1200);
    return;
  }

  // Mobile / standalone / Capacitor: keep splash until auth confirmed
  // (broadcast.js will call _axMobile.onAuth() when Firebase auth resolves)
  _setSplashStatus('CONNECTING TO AURENIX…');

  // Safety fallback: if broadcast.js takes too long (5s), dismiss splash anyway
  setTimeout(() => {
    if (!_splashDone) _hideSplash();
  }, 5000);
}

/* ════════════════════════════════════════
   SPLASH SCREEN
════════════════════════════════════════ */
function _setupSplash() {
  const splash = document.getElementById('ax-splash');
  if (!splash) return;
  // Listen for transition end to fully remove
  splash.addEventListener('transitionend', () => {
    if (splash.classList.contains('ax-splash-out')) {
      splash.classList.add('ax-splash-gone');
    }
  }, { once: false });
}

function _setSplashStatus(msg) {
  const el = document.getElementById('ax-splash-status');
  if (el) el.textContent = msg;
}

function _hideSplash() {
  if (_splashDone) return;
  _splashDone = true;
  const splash = document.getElementById('ax-splash');
  if (!splash || splash.classList.contains('ax-splash-gone')) return;
  splash.classList.add('ax-splash-out');
  setTimeout(() => {
    splash.classList.add('ax-splash-gone');
  }, 600);
}

/* ════════════════════════════════════════
   AUTH EVENTS (called by broadcast.js)
════════════════════════════════════════ */
function _onAuth(user, isFounder) {
  if (!user) {
    // Not logged in — dismiss splash to show login screen
    _setSplashStatus('SIGN IN TO WATCH');
    setTimeout(_hideSplash, 800);
    _hideBottomNav();
    return;
  }
  _userEmail  = user.email;
  _isFounder  = isFounder;
  _setSplashStatus('TUNING IN…');
}

function _onNetworkReady(channels, activeChannelId) {
  _networkReady = true;
  _setSplashStatus('LIVE TV ON');
  // Short delay so "LIVE TV ON" is visible before transition
  setTimeout(_hideSplash, 350);

  if (_isMobile || _isStandalone || _isCapacitor) {
    _buildBottomNav();
    _showBottomNav();
  }
}

function _onChannelChange(channelId, channelName) {
  // Update active channel indicator in bottom nav if visible
  // (bottom nav doesn't show channel name currently, but hook is here for future)
}

function _onPlayState(item, isCommercial) {
  // After first play state arrives, gate is considered open
}

function _onGateOpen() {
  _gateOpen = true;
  _hideMutePrompt(); // clean up if shown
}

/* ════════════════════════════════════════
   BOTTOM NAVIGATION
════════════════════════════════════════ */
function _buildBottomNav() {
  const nav = document.getElementById('ax-mobile-nav');
  if (!nav) return;

  const tabs = [
    { id: 'watch',   icon: '📺', label: 'WATCH'   },
    { id: 'guide',   icon: '📅', label: 'GUIDE'   },
    { id: 'profile', icon: '👤', label: 'PROFILE' },
  ];

  nav.innerHTML = `<div class="ax-mobile-nav-inner">${
    tabs.map(t => `
      <button class="ax-mobile-nav-btn${_activeTab === t.id ? ' active' : ''}"
              data-tab="${t.id}"
              aria-label="${t.label}"
              aria-pressed="${_activeTab === t.id}">
        <span class="ax-mobile-nav-icon" aria-hidden="true">${t.icon}</span>
        <span class="ax-mobile-nav-label">${t.label}</span>
      </button>
    `).join('')
  }</div>`;

  nav.querySelectorAll('.ax-mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
    // Touch feedback
    btn.addEventListener('touchstart', () => {}, { passive: true });
  });
}

function _showBottomNav() {
  const nav = document.getElementById('ax-mobile-nav');
  if (nav) nav.classList.add('visible');
}

function _hideBottomNav() {
  const nav = document.getElementById('ax-mobile-nav');
  if (nav) nav.classList.remove('visible');
}

/* ════════════════════════════════════════
   TAB SWITCHING — SPA NAVIGATION
   No full page reloads. The Watch tab shows
   the main player layout; other tabs show
   app-screens that overlay the player area.
════════════════════════════════════════ */
function _switchTab(tab) {
  if (_activeTab === tab) {
    // Tap active tab → scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  _activeTab = tab;

  // Update nav button states
  document.querySelectorAll('.ax-mobile-nav-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Show/hide screens
  switch (tab) {
    case 'watch':   _showWatchScreen();   break;
    case 'guide':   _showGuideScreen();   break;
    case 'profile': _showProfileScreen(); break;
  }
}

/* ── WATCH screen (main broadcast layout) ── */
function _showWatchScreen() {
  _hideMobileScreens();
  const hero = document.getElementById('ax-hero');
  if (hero) hero.style.display = '';
  // Scroll to top so player is visible
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── GUIDE screen ── */
function _showGuideScreen() {
  _hideMobileScreens();
  _showScreen('ax-mob-guide', _buildGuideScreen);
}

/* ── PROFILE screen ── */
function _showProfileScreen() {
  _hideMobileScreens();
  _showScreen('ax-mob-profile', _buildProfileScreen);
}

function _hideMobileScreens() {
  // Remove any previously rendered mobile screens
  document.querySelectorAll('.ax-mobile-screen').forEach(s => s.remove());
  const hero = document.getElementById('ax-hero');
  if (hero) hero.style.display = 'none';
}

function _showScreen(id, buildFn) {
  let screen = document.getElementById(id);
  if (!screen) {
    screen = document.createElement('div');
    screen.id = id;
    screen.className = 'ax-mobile-screen';
    const app = document.getElementById('ax-app');
    if (app) app.appendChild(screen);
  }
  buildFn(screen);
  // Trigger enter animation
  screen.style.display = '';
  requestAnimationFrame(() => screen.classList.add('active'));
}

/* ════════════════════════════════════════
   SCREEN BUILDERS
════════════════════════════════════════ */

function _buildGuideScreen(el) {
  // Mirror EPG content
  const epgBody = document.getElementById('ax-epg-body');
  const epgTabs = document.getElementById('ax-epg-tabs');

  el.innerHTML = `
    <div class="ax-screen-header">
      <div>
        <div class="ax-screen-title">📅 TV GUIDE</div>
        <div class="ax-screen-subtitle">WHAT'S ON NOW</div>
      </div>
    </div>
    <div style="padding:0 0 8px;">
      <div id="ax-mob-epg-tabs" style="display:flex;gap:8px;padding:12px 12px 0;overflow-x:auto;scrollbar-width:none;">
        ${epgTabs ? epgTabs.innerHTML : ''}
      </div>
      <div id="ax-mob-epg-body" style="padding:8px 12px;">
        ${epgBody ? epgBody.innerHTML : '<div style="padding:20px;color:var(--text-dim);font-size:12px;text-align:center;">Loading guide…</div>'}
      </div>
    </div>
  `;

  // Bind tab clicks to switch EPG channel
  el.querySelectorAll('.ax-epg-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      // Click the real EPG tab in the hero (which triggers _renderEPG)
      const real = document.querySelector(`#ax-epg-tabs .ax-epg-tab[data-chid="${btn.dataset.chid}"]`);
      if (real) {
        real.click();
        // Refresh our copy after a short delay
        setTimeout(() => {
          const mobBody = document.getElementById('ax-mob-epg-body');
          const origBody = document.getElementById('ax-epg-body');
          if (mobBody && origBody) mobBody.innerHTML = origBody.innerHTML;
          el.querySelectorAll('.ax-epg-tab').forEach(t => t.classList.remove('active'));
          btn.classList.add('active');
        }, 100);
      }
    });
  });
}

function _buildProfileScreen(el) {
  const initial = _userEmail ? _userEmail.charAt(0).toUpperCase() : '?';
  const isFounder = _isFounder;

  el.innerHTML = `
    <div class="ax-screen-header">
      <div>
        <div class="ax-screen-title">👤 PROFILE</div>
        <div class="ax-screen-subtitle">YOUR AURENIX ACCOUNT</div>
      </div>
    </div>
    <div class="ax-mobile-profile">
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="ax-profile-avatar">${initial}</div>
        <div class="ax-profile-info">
          <div class="ax-profile-email">${_esc(_userEmail || 'Unknown')}</div>
          <div class="ax-profile-role">${isFounder ? '⚡ FOUNDER' : 'VIEWER'}</div>
        </div>
      </div>

      ${isFounder ? `
      <div class="ax-profile-founder-card">
        <div class="ax-pfc-icon">⚡</div>
        <div>
          <div class="ax-pfc-label">FOUNDER ACCESS</div>
          <div class="ax-pfc-sub">Full broadcast control &amp; studio tools</div>
        </div>
      </div>
      ` : ''}

      <div class="ax-profile-actions">
        <button class="ax-profile-action-btn" id="ax-mob-watch-btn">
          <span class="ax-pab-icon">📺</span>
          <span class="ax-pab-label">WATCH LIVE</span>
          <span class="ax-pab-arrow">›</span>
        </button>

        <button class="ax-profile-action-btn" id="ax-mob-submit-btn">
          <span class="ax-pab-icon">🎤</span>
          <span class="ax-pab-label">SUBMIT CONTENT</span>
          <span class="ax-pab-arrow">›</span>
        </button>

        ${isFounder ? `
        <button class="ax-profile-action-btn" id="ax-mob-founder-btn" style="border-color:rgba(184,134,11,0.4);color:var(--gold-bright);">
          <span class="ax-pab-icon">⚡</span>
          <span class="ax-pab-label">FOUNDER STUDIO</span>
          <span class="ax-pab-arrow">›</span>
        </button>
        ` : ''}

        <button class="ax-profile-action-btn danger" id="ax-mob-signout-btn">
          <span class="ax-pab-icon">🚪</span>
          <span class="ax-pab-label">SIGN OUT</span>
          <span class="ax-pab-arrow">›</span>
        </button>
      </div>

      <div style="text-align:center;padding:12px 0 4px;">
        <div style="font-size:10px;color:var(--text-muted);letter-spacing:2px;">AURENIX — THE BROADCAST NEVER STOPS.</div>
      </div>
    </div>
  `;

  // Bind actions
  el.querySelector('#ax-mob-watch-btn')?.addEventListener('click', () => _switchTab('watch'));

  el.querySelector('#ax-mob-submit-btn')?.addEventListener('click', () => {
    _switchTab('watch');
    setTimeout(() => {
      const submitBtn = document.getElementById('ax-submit-btn');
      if (submitBtn) submitBtn.click();
    }, 200);
  });

  el.querySelector('#ax-mob-founder-btn')?.addEventListener('click', () => {
    _switchTab('watch');
    setTimeout(() => {
      const ctrlBtn = document.getElementById('ax-ctrl-btn');
      if (ctrlBtn) ctrlBtn.click();
    }, 200);
  });

  el.querySelector('#ax-mob-signout-btn')?.addEventListener('click', () => {
    const signoutBtn = document.getElementById('ax-signout-btn');
    if (signoutBtn) signoutBtn.click();
  });
}

/* ════════════════════════════════════════
   MUTED AUTOPLAY FALLBACK
   "TAP FOR SOUND" prompt
════════════════════════════════════════ */
function _showMutePrompt() {
  if (_mutePromptShown) return;
  _mutePromptShown = true;
  const prompt = document.getElementById('ax-sound-prompt');
  if (!prompt) return;
  prompt.style.display = '';
  const btn = document.getElementById('ax-sound-btn');
  btn?.addEventListener('click', _onSoundTap, { once: true });
}

function _hideMutePrompt() {
  _mutePromptShown = false;
  const prompt = document.getElementById('ax-sound-prompt');
  if (prompt) prompt.style.display = 'none';
}

function _onSoundTap() {
  // Find the active media element and unmute it
  const video = document.getElementById('ax-video');
  const audio = document.getElementById('ax-audio');
  const media = (video && video.style.display !== 'none') ? video : audio;
  if (media) {
    media.muted = false;
    media.volume = parseFloat(document.getElementById('ax-vol-slider')?.value || '0.8');
    // Try to start playback if it was paused due to autoplay restriction
    if (media.paused) media.play().catch(() => {});
  }
  // Also unmute via the mute button's state
  const muteBtn = document.getElementById('ax-mute-btn');
  if (muteBtn && media && media.muted === false) {
    muteBtn.textContent = '🔊';
  }
  _hideMutePrompt();
}

/* ════════════════════════════════════════
   FULLSCREEN HANDLER
   Show / hide bottom nav + top nav during fullscreen
════════════════════════════════════════ */
function _setupFullscreenHandler() {
  const onFsChange = () => {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle('ax-fullscreen-active', isFs);
    const mobileNav = document.getElementById('ax-mobile-nav');
    if (mobileNav) mobileNav.classList.toggle('ax-nav-hidden', isFs);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
}

/* ════════════════════════════════════════
   ORIENTATION HANDLER
   Auto-fullscreen on landscape rotation (mobile)
════════════════════════════════════════ */
function _setupOrientationHandler() {
  if (!_isMobile && !_isCapacitor) return;

  const onOrient = () => {
    const isLandscape = window.innerWidth > window.innerHeight;
    // Update bottom nav visibility
    const mobileNav = document.getElementById('ax-mobile-nav');
    if (mobileNav) {
      mobileNav.classList.toggle('ax-nav-hidden', isLandscape);
    }
    // In landscape, auto-enter fullscreen for the active player if gate is open
    if (isLandscape && _gateOpen) {
      const fsContainer = document.getElementById('ax-fs-container');
      const isAlreadyFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (fsContainer && !isAlreadyFs && _activeTab === 'watch') {
        // Small delay to let the orientation animation complete
        setTimeout(() => {
          const req = fsContainer.requestFullscreen || fsContainer.webkitRequestFullscreen;
          if (req) req.call(fsContainer).catch(() => {});
        }, 300);
      }
    }
    // In portrait, exit fullscreen if entered via orientation
    if (!isLandscape) {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFs) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document).catch(() => {});
      }
    }
  };

  // Use screen.orientation API (modern) or resize fallback
  if (screen.orientation) {
    screen.orientation.addEventListener('change', onOrient);
  } else {
    window.addEventListener('resize', () => setTimeout(onOrient, 100));
  }
  // Initial check
  setTimeout(onOrient, 100);
}

/* ════════════════════════════════════════
   VISIBILITY / RESUME HANDLER
   Reconnect on app resume
════════════════════════════════════════ */
function _setupVisibilityHandler() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // App returned from background — let broadcast.js handle reconnect
      // (it already listens for visibilitychange via _viewerReconnect)
      _hideNetworkOverlay();
    }
  });
}

/* ════════════════════════════════════════
   NETWORK MONITOR
   Show overlay on connection loss; reconnect on restore
════════════════════════════════════════ */
function _setupOnlineHandler() {
  window.addEventListener('offline', () => {
    if (!_networkReady) return; // not connected yet anyway
    _showNetworkOverlay('RECONNECTING TO BROADCAST…', 'Connection lost. Waiting for network…');
  });

  window.addEventListener('online', () => {
    _hideNetworkOverlay();
    // Trigger broadcast.js reconnect after a short delay
    // (Firestore auto-reconnects; this ensures the player catches up)
    clearTimeout(_onlineTimer);
    _onlineTimer = setTimeout(() => {
      // Dispatch a synthetic visibilitychange-like trigger by calling
      // the broadcast reconnect hook if available
      if (typeof window._axBroadcastReconnect === 'function') {
        window._axBroadcastReconnect('online');
      }
    }, 1500);
  });
}

function _showNetworkOverlay(msg, sub) {
  let overlay = document.getElementById('ax-mobile-reconnect');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ax-mobile-reconnect';
    overlay.innerHTML = `
      <div class="ax-mobile-reconnect-logo">
        <svg viewBox="0 0 64 64" fill="none" width="56" height="56">
          <polygon points="32,6 58,56 6,56" fill="none" stroke="#b8860b" stroke-width="1.5" opacity="0.85"/>
          <ellipse cx="32" cy="38" rx="13" ry="9" fill="none" stroke="#1e50ff" stroke-width="1.3"/>
          <circle cx="32" cy="38" r="2.5" fill="#1e50ff" opacity="0.9"/>
        </svg>
      </div>
      <div class="ax-mobile-reconnect-title">AURE<span>NIX</span></div>
      <div class="ax-mobile-reconnect-msg" id="ax-mob-rc-msg">${_esc(msg)}</div>
      <div class="ax-mobile-reconnect-sub" id="ax-mob-rc-sub">${_esc(sub)}</div>
    `;
    document.body.appendChild(overlay);
  } else {
    const msgEl = overlay.querySelector('#ax-mob-rc-msg');
    const subEl = overlay.querySelector('#ax-mob-rc-sub');
    if (msgEl) msgEl.textContent = msg;
    if (subEl) subEl.textContent = sub;
  }
  overlay.classList.add('visible');
}

function _hideNetworkOverlay() {
  const overlay = document.getElementById('ax-mobile-reconnect');
  if (overlay) overlay.classList.remove('visible');
}

/* ════════════════════════════════════════
   DETECTION HELPERS
════════════════════════════════════════ */
function _detectMobile() {
  return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || window.innerWidth <= 767;
}

function _detectStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||  // iOS Safari
    document.referrer.includes('android-app://')
  );
}

/* ════════════════════════════════════════
   UTIL
════════════════════════════════════════ */
function _esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
