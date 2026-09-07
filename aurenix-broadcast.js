/**
 * AURENIX BROADCAST ENGINE
 * aurenix-broadcast.js
 *
 * Synchronized 24/7 network playback.
 * Requires Firebase Authentication — all users must sign in or create a
 * free account before accessing the network.
 *
 * Auth flow:
 *   1. onAuthStateChanged fires.
 *   2. No user → show full-screen login / register screen.
 *   3. User authenticated → load channels from Firestore → show AURENIX Network.
 *   4. Founder (christijerina46@gmail.com) → also show Founder Studio link.
 *
 * Channels are loaded dynamically from network_channels/{id} — no hardcoded list.
 * Storage: Supabase `aurenix-media` bucket for uploaded files.
 * Auth:    Firebase Authentication
 */

import {
  auth, db,
  onAuthChange,
  doc, getDoc, setDoc, collection, getDocs, onSnapshot,
  updateDoc, serverTimestamp, Timestamp,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail,
  query, orderBy, where, upsertUserProfile, addDoc,
} from './firebase-client.js';

import { supabase } from './supabase-client.js';

/* ════════════════════════════════════
   CONSTANTS
════════════════════════════════════ */
const FOUNDER_EMAIL  = 'christijerina46@gmail.com';
const MEDIA_BUCKET   = 'aurenix-media';

/* ════════════════════════════════════
   STATE
════════════════════════════════════ */
let _user          = null;
let _isFounder     = false;
let _networkReady  = false;   // has the network UI been built?
let _channels      = [];      // loaded from Firestore network_channels
let _activeChannel = null;
let _channelStates = {};      // channelId → Firestore network_state doc
let _channelUnsubs = {};      // channelId → onSnapshot unsubscribe
let _channelsUnsub = null;    // unsubscribe for network_channels listener
let _mediaEl       = null;    // the active <video> or <audio> element
let _mediaType     = null;    // 'video' | 'audio'
let _gateOpen      = false;   // user has interacted (autoplay gate)
let _tickTimer     = null;
let _advancing     = false;   // guard against double-advance

/* ════════════════════════════════════
   INIT
════════════════════════════════════ */
export function initBroadcast() {
  _buildParticles();

  // Show login screen immediately while Firebase resolves session
  _showLoginScreen();

  // Firebase Auth state listener — single source of truth
  onAuthChange((user) => {
    _user      = user;
    _isFounder = !!(user && user.email?.trim().toLowerCase() === FOUNDER_EMAIL.toLowerCase());

    if (user) {
      _enterNetwork();
    } else {
      _showLoginScreen();
    }
  });
}

/* ════════════════════════════════════
   PARTICLES (ambient background)
════════════════════════════════════ */
function _buildParticles() {
  const canvas = document.getElementById('ax-particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function mkParticle() {
    return {
      x:  Math.random() * W,
      y:  Math.random() * H,
      r:  Math.random() * 1.4 + 0.3,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      a:  Math.random() * 0.35 + 0.08,
    };
  }
  for (let i = 0; i < 90; i++) particles.push(mkParticle());

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(77,122,255,${p.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

/* ════════════════════════════════════
   LOGIN / REGISTER SCREEN
════════════════════════════════════ */
function _showLoginScreen() {
  _stopMedia();
  _stopTick();

  const nav  = document.getElementById('ax-nav');
  const hero = document.getElementById('ax-hero');
  const ctrl = document.getElementById('ax-control');
  if (nav)  nav.style.display  = 'none';
  if (hero) hero.style.display = 'none';
  if (ctrl) { ctrl.classList.remove('visible'); ctrl.innerHTML = ''; }

  const app = document.getElementById('ax-app');
  if (!app) return;

  app.innerHTML = `
    <div class="ax-auth-screen" id="ax-auth-screen">
      <div class="ax-auth-logo">
        <svg viewBox="0 0 64 64" fill="none" width="56" height="56">
          <polygon points="32,6 58,56 6,56" fill="none" stroke="#b8860b" stroke-width="1.5" opacity="0.85"/>
          <ellipse cx="32" cy="38" rx="13" ry="9" fill="none" stroke="#1e50ff" stroke-width="1.3"/>
          <circle cx="32" cy="38" r="5" fill="none" stroke="#b8860b" stroke-width="1.2"/>
          <circle cx="32" cy="38" r="2.5" fill="#1e50ff" opacity="0.9"/>
          <line x1="8" y1="38" x2="19" y2="38" stroke="#b8860b" stroke-width="0.8" opacity="0.5"/>
          <line x1="45" y1="38" x2="56" y2="38" stroke="#b8860b" stroke-width="0.8" opacity="0.5"/>
        </svg>
        <div class="ax-auth-logo-text">AURE<span>NIX</span></div>
        <div class="ax-auth-logo-sub">THE BROADCAST NEVER STOPS.</div>
      </div>

      <!-- LOGIN PANEL -->
      <div class="ax-auth-card" id="ax-panel-login">
        <div class="ax-auth-card-title">LOGIN</div>
        <div class="ax-field-group">
          <label class="ax-field-label">Email</label>
          <input class="ax-field-input" type="email" id="ax-login-email"
                 placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="ax-field-group" id="ax-login-pass-group">
          <label class="ax-field-label">Password</label>
          <div style="position:relative;">
            <input class="ax-field-input" type="password" id="ax-login-pass"
                   placeholder="Password" autocomplete="current-password" style="padding-right:48px;">
            <button type="button" id="ax-login-pass-toggle"
                    style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;padding:2px 4px;letter-spacing:1px;">SHOW</button>
          </div>
        </div>
        <div class="ax-auth-err" id="ax-login-err"></div>
        <button class="ax-btn-primary" id="ax-login-submit">LOGIN</button>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="ax-btn-ghost" id="ax-login-forgot" style="flex:1;font-size:11px;">Forgot Password?</button>
        </div>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);text-align:center;">
          <span style="font-size:12px;color:var(--text-dim);">No account? Registration is FREE.</span>
          <button class="ax-btn-ghost" id="ax-go-register" style="margin-left:8px;font-size:12px;padding:4px 12px;">CREATE ACCOUNT</button>
        </div>
      </div>

      <!-- REGISTER PANEL -->
      <div class="ax-auth-card" id="ax-panel-register" style="display:none;">
        <div class="ax-auth-card-title">CREATE FREE ACCOUNT</div>
        <div class="ax-auth-card-sub">Free access to all AURENIX channels. No subscription required.</div>
        <div class="ax-field-group">
          <label class="ax-field-label">Email</label>
          <input class="ax-field-input" type="email" id="ax-reg-email"
                 placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Password</label>
          <div style="position:relative;">
            <input class="ax-field-input" type="password" id="ax-reg-pass"
                   placeholder="At least 6 characters" autocomplete="new-password" style="padding-right:48px;">
            <button type="button" id="ax-reg-pass-toggle"
                    style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:11px;padding:2px 4px;letter-spacing:1px;">SHOW</button>
          </div>
        </div>
        <div class="ax-field-group">
          <label class="ax-field-label">Confirm Password</label>
          <input class="ax-field-input" type="password" id="ax-reg-pass2"
                 placeholder="Repeat password" autocomplete="new-password">
        </div>
        <div class="ax-auth-err" id="ax-reg-err"></div>
        <button class="ax-btn-primary" id="ax-reg-submit">CREATE FREE ACCOUNT</button>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);text-align:center;">
          <span style="font-size:12px;color:var(--text-dim);">Already have an account?</span>
          <button class="ax-btn-ghost" id="ax-go-login" style="margin-left:8px;font-size:12px;padding:4px 12px;">LOGIN</button>
        </div>
      </div>

      <!-- FORGOT PASSWORD PANEL -->
      <div class="ax-auth-card" id="ax-panel-reset" style="display:none;">
        <div class="ax-auth-card-title">RESET PASSWORD</div>
        <div class="ax-auth-card-sub">Enter your email to receive a reset link.</div>
        <div class="ax-field-group">
          <label class="ax-field-label">Email</label>
          <input class="ax-field-input" type="email" id="ax-reset-email"
                 placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="ax-auth-err" id="ax-reset-err"></div>
        <button class="ax-btn-primary" id="ax-reset-submit">SEND RESET EMAIL</button>
        <div style="margin-top:8px;">
          <button class="ax-btn-ghost" id="ax-reset-back" style="width:100%;font-size:12px;">← Back to Login</button>
        </div>
      </div>
    </div>
  `;

  _bindLoginScreen();
}

function _bindLoginScreen() {
  function showPanel(id) {
    ['ax-panel-login','ax-panel-register','ax-panel-reset'].forEach(p => {
      const el = document.getElementById(p);
      if (el) el.style.display = (p === id) ? '' : 'none';
    });
    document.getElementById(id)?.querySelector('input')?.focus();
  }

  document.getElementById('ax-go-register')?.addEventListener('click', () => showPanel('ax-panel-register'));
  document.getElementById('ax-go-login')?.addEventListener('click',    () => showPanel('ax-panel-login'));
  document.getElementById('ax-login-forgot')?.addEventListener('click',() => showPanel('ax-panel-reset'));
  document.getElementById('ax-reset-back')?.addEventListener('click',  () => showPanel('ax-panel-login'));

  document.getElementById('ax-login-pass-toggle')?.addEventListener('click', () => {
    const inp = document.getElementById('ax-login-pass');
    const btn = document.getElementById('ax-login-pass-toggle');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? 'SHOW' : 'HIDE';
  });

  document.getElementById('ax-reg-pass-toggle')?.addEventListener('click', () => {
    const inp = document.getElementById('ax-reg-pass');
    const btn = document.getElementById('ax-reg-pass-toggle');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? 'SHOW' : 'HIDE';
  });

  const doLogin = async () => {
    const emailEl  = document.getElementById('ax-login-email');
    const passEl   = document.getElementById('ax-login-pass');
    const errEl    = document.getElementById('ax-login-err');
    const submitEl = document.getElementById('ax-login-submit');
    if (!emailEl || !passEl || !errEl || !submitEl) return;
    _clearErr(errEl);
    const email = emailEl.value.trim();
    const pass  = passEl.value;
    if (!email)              { _showErr(errEl, 'Email address is required.'); return; }
    if (!_validEmail(email)) { _showErr(errEl, 'Enter a valid email address.'); return; }
    if (!pass)               { _showErr(errEl, 'Password is required.'); return; }
    submitEl.disabled = true;
    submitEl.textContent = 'SIGNING IN…';
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      submitEl.textContent = 'OPENING AURENIX…';
    } catch (e) {
      _showErr(errEl, _friendlyAuthError(e.code));
      submitEl.disabled = false;
      submitEl.textContent = 'LOGIN';
    }
  };

  document.getElementById('ax-login-submit')?.addEventListener('click', doLogin);
  document.getElementById('ax-login-pass')?.addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('ax-login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  const doRegister = async () => {
    const emailEl  = document.getElementById('ax-reg-email');
    const passEl   = document.getElementById('ax-reg-pass');
    const pass2El  = document.getElementById('ax-reg-pass2');
    const errEl    = document.getElementById('ax-reg-err');
    const submitEl = document.getElementById('ax-reg-submit');
    if (!emailEl || !passEl || !pass2El || !errEl || !submitEl) return;
    _clearErr(errEl);
    const email = emailEl.value.trim();
    const pass  = passEl.value;
    const pass2 = pass2El.value;
    if (!email)              { _showErr(errEl, 'Email address is required.'); return; }
    if (!_validEmail(email)) { _showErr(errEl, 'Enter a valid email address.'); return; }
    if (!pass)               { _showErr(errEl, 'Password is required.'); return; }
    if (pass.length < 6)     { _showErr(errEl, 'Password must be at least 6 characters.'); return; }
    if (pass !== pass2)      { _showErr(errEl, 'Passwords do not match.'); return; }
    submitEl.disabled = true;
    submitEl.textContent = 'CREATING ACCOUNT…';
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      try {
        await upsertUserProfile(cred.user.uid, {
          email:      cred.user.email,
          role:       'viewer',
          created_at: serverTimestamp(),
        });
      } catch (_) { /* non-fatal */ }
      submitEl.textContent = 'OPENING AURENIX…';
    } catch (e) {
      _showErr(errEl, _friendlyAuthError(e.code));
      submitEl.disabled = false;
      submitEl.textContent = 'CREATE FREE ACCOUNT';
    }
  };

  document.getElementById('ax-reg-submit')?.addEventListener('click', doRegister);
  document.getElementById('ax-reg-pass2')?.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('ax-reg-pass')?.addEventListener('keydown',  e => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('ax-reg-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });

  const doReset = async () => {
    const emailEl  = document.getElementById('ax-reset-email');
    const errEl    = document.getElementById('ax-reset-err');
    const submitEl = document.getElementById('ax-reset-submit');
    if (!emailEl || !errEl || !submitEl) return;
    _clearErr(errEl);
    const email = emailEl.value.trim();
    if (!email)              { _showErr(errEl, 'Enter your email address.'); return; }
    if (!_validEmail(email)) { _showErr(errEl, 'Enter a valid email address.'); return; }
    submitEl.disabled = true;
    submitEl.textContent = 'SENDING…';
    try {
      await sendPasswordResetEmail(auth, email);
      errEl.style.color = 'var(--green)';
      _showErr(errEl, '✓ Reset email sent — check your inbox.');
      submitEl.textContent = 'EMAIL SENT';
    } catch (e) {
      _showErr(errEl, _friendlyAuthError(e.code));
      submitEl.disabled = false;
      submitEl.textContent = 'SEND RESET EMAIL';
    }
  };

  document.getElementById('ax-reset-submit')?.addEventListener('click', doReset);
  document.getElementById('ax-reset-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') doReset(); });

  document.getElementById('ax-login-email')?.focus();
}

/* ════════════════════════════════════
   ENTER NETWORK
════════════════════════════════════ */
function _enterNetwork() {
  const app = document.getElementById('ax-app');
  if (app) app.innerHTML = '';

  const nav = document.getElementById('ax-nav');
  if (nav) nav.style.display = '';

  if (!_networkReady) {
    // Load channels from Firestore, then build UI
    _subscribeChannels();
  } else {
    _buildNav();
    const hero = document.getElementById('ax-hero');
    if (hero) hero.style.display = '';
    _updateNavAuth();
  }
}

/* ════════════════════════════════════
   CHANNEL SUBSCRIPTION (from DB)
════════════════════════════════════ */
function _subscribeChannels() {
  if (_channelsUnsub) _channelsUnsub();

  const q = query(collection(db, 'network_channels'), orderBy('sort_order', 'asc'));
  _channelsUnsub = onSnapshot(q, (snap) => {
    const loaded = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(ch => ch.enabled !== false);

    if (!loaded.length) {
      // No channels yet — show loading state; channels will be seeded by Founder Studio
      const app = document.getElementById('ax-app');
      if (app && !_networkReady) {
        _buildNav();
        _buildHero([]);
        _networkReady = true;
      }
      return;
    }

    const prevChannels = _channels;
    _channels = loaded;

    if (!_networkReady) {
      _buildNav();
      _buildHero(_channels);
      _networkReady = true;
      _channels.forEach(ch => _subscribeChannelState(ch.id));
      const first = _channels[0];
      if (first) _setActiveChannel(first.id);
    } else {
      // Channels changed — refresh the channel list in the UI
      _buildChannelList();
      // Subscribe to any new channels
      _channels.forEach(ch => _subscribeChannelState(ch.id));
    }

    _updateNavAuth();
  }, (err) => {
    console.warn('[AURENIX] Failed to load channels:', err);
    // Fallback: show network with empty channels
    if (!_networkReady) {
      _buildNav();
      _buildHero([]);
      _networkReady = true;
      _updateNavAuth();
    }
  });
}

/* ════════════════════════════════════
   NAV
════════════════════════════════════ */
function _buildNav() {
  const nav = document.getElementById('ax-nav');
  if (!nav) return;
  nav.innerHTML = `
    <div class="ax-nav-logo" id="ax-logo-btn">
      <svg viewBox="0 0 64 64" fill="none">
        <polygon points="32,6 58,56 6,56" fill="none" stroke="#b8860b" stroke-width="1.5" opacity="0.85"/>
        <ellipse cx="32" cy="38" rx="13" ry="9" fill="none" stroke="#1e50ff" stroke-width="1.3"/>
        <circle cx="32" cy="38" r="5" fill="none" stroke="#b8860b" stroke-width="1.2"/>
        <circle cx="32" cy="38" r="2.5" fill="#1e50ff" opacity="0.9"/>
        <line x1="8" y1="38" x2="19" y2="38" stroke="#b8860b" stroke-width="0.8" opacity="0.5"/>
        <line x1="45" y1="38" x2="56" y2="38" stroke="#b8860b" stroke-width="0.8" opacity="0.5"/>
      </svg>
      <div class="ax-nav-logo-text">AURE<span>NIX</span></div>
    </div>
    <div class="ax-nav-live-badge">
      <span class="ax-live-dot"></span> ON AIR
    </div>
    <div class="ax-nav-spacer"></div>
    <div id="ax-nav-auth-area"></div>
  `;
  document.getElementById('ax-logo-btn')?.addEventListener('click', () => {
    const ctrl = document.getElementById('ax-control');
    if (ctrl?.classList.contains('visible')) {
      ctrl.classList.remove('visible');
      ctrl.innerHTML = '';
      const hero = document.getElementById('ax-hero');
      if (hero) hero.style.display = '';
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  _updateNavAuth();
}

function _updateNavAuth() {
  const area = document.getElementById('ax-nav-auth-area');
  if (!area) return;
  if (_user) {
    area.innerHTML = `
      <div class="ax-nav-user" id="ax-user-area">
        ${_isFounder ? `<span class="ax-founder-badge-nav">⚡ FOUNDER MODE</span>` : ''}
        <div class="ax-nav-avatar">${(_user.email || '?').charAt(0).toUpperCase()}</div>
        ${_isFounder ? `<button class="ax-nav-btn ax-founder-panel-btn" id="ax-ctrl-btn">FOUNDER STUDIO</button>` : ''}
        <button class="ax-nav-btn" id="ax-submit-btn">SUBMIT CONTENT</button>
        <button class="ax-nav-btn" id="ax-signout-btn">Sign Out</button>
      </div>`;
    document.getElementById('ax-ctrl-btn')?.addEventListener('click', _openControl);
    document.getElementById('ax-submit-btn')?.addEventListener('click', _openSubmitModal);
    document.getElementById('ax-signout-btn')?.addEventListener('click', () => {
      _gateOpen = false;
      _stopMedia();
      _networkReady = false;
      _channels = [];
      if (_channelsUnsub) { _channelsUnsub(); _channelsUnsub = null; }
      Object.values(_channelUnsubs).forEach(u => u && u());
      _channelUnsubs = {};
      _channelStates = {};
      signOut(auth);
    });
  } else {
    area.innerHTML = '';
  }
}

/* ════════════════════════════════════
   HERO / VIEWER
════════════════════════════════════ */
function _buildHero(channels) {
  const app = document.getElementById('ax-app');
  if (!app) return;
  app.innerHTML = `
    <section id="ax-hero">
      <div class="ax-hero-bg"></div>
      <div style="text-align:center; margin-bottom: 36px;">
        <div style="font-size:clamp(32px,5vw,56px); font-weight:900; letter-spacing:0.22em; color:#c8d0e8; margin-bottom:8px;">
          AURE<span style="color:#4d7aff">NIX</span> <span style="font-size:clamp(14px,2vw,20px);letter-spacing:2px;color:#4d7aff;font-weight:600;">NETWORK</span>
        </div>
        <div style="font-size:12px; letter-spacing:4px; color:#6870a0; text-transform:uppercase;">
          THE BROADCAST NEVER STOPS.
        </div>
      </div>
      <div class="ax-hero-inner">
        <div class="ax-player-wrap">
          <div class="ax-channel-badge" id="ax-channel-badge">
            <span id="ax-badge-id">—</span>
            &nbsp;·&nbsp;
            <span id="ax-badge-name">Loading channels…</span>
          </div>
          <div class="ax-player-shell">
            <div class="ax-media-area" id="ax-media-area">
              <video id="ax-video" playsinline style="width:100%;height:100%;display:none;"></video>
              <audio id="ax-audio" style="display:none;"></audio>
              <div class="ax-media-thumbnail" id="ax-thumbnail">
                <div style="font-size:72px; opacity:0.15;">◉</div>
              </div>
              <div class="ax-media-overlay"></div>
              <div class="ax-np-overlay" id="ax-np-overlay">
                <div class="ax-np-label">NOW PLAYING</div>
                <div class="ax-np-title" id="ax-np-title">Connecting to network…</div>
                <div class="ax-np-artist" id="ax-np-artist"></div>
              </div>
              <div class="ax-autoplay-gate" id="ax-gate">
                <div class="ax-gate-logo">
                  <svg viewBox="0 0 64 64" fill="none" width="56" height="56">
                    <polygon points="32,6 58,56 6,56" fill="none" stroke="#b8860b" stroke-width="1.5"/>
                    <ellipse cx="32" cy="38" rx="13" ry="9" fill="none" stroke="#1e50ff" stroke-width="1.3"/>
                    <circle cx="32" cy="38" r="2.5" fill="#1e50ff"/>
                  </svg>
                </div>
                <div class="ax-gate-title">AURENIX</div>
                <div class="ax-gate-sub">Click to enter the broadcast</div>
                <button class="ax-gate-btn" id="ax-gate-btn">▶ ENTER BROADCAST</button>
              </div>
            </div>
            <div class="ax-progress-wrap">
              <div class="ax-progress-bar" id="ax-progress-bar">
                <div class="ax-progress-fill" id="ax-progress-fill"></div>
              </div>
              <div class="ax-progress-times">
                <span id="ax-time-elapsed">0:00</span>
                <span id="ax-time-remaining">—</span>
              </div>
            </div>
            <div class="ax-controls">
              <button class="ax-ctrl-btn primary" id="ax-play-btn" title="Play / Pause">▶</button>
              <div class="ax-volume-wrap">
                <button class="ax-ctrl-btn" id="ax-mute-btn" title="Mute">🔊</button>
                <input type="range" class="ax-volume-slider" id="ax-vol-slider" min="0" max="1" step="0.02" value="0.8">
              </div>
              <div class="ax-controls-spacer"></div>
              <button class="ax-ctrl-btn" id="ax-pip-btn" title="Picture-in-Picture" style="display:none;">⧉</button>
              <button class="ax-ctrl-btn" id="ax-fs-btn" title="Fullscreen">⛶</button>
            </div>
          </div>
        </div>
        <div class="ax-sidebar">
          <div class="ax-panel">
            <div class="ax-panel-header">
              <span class="ax-panel-title">Channels</span>
            </div>
            <div class="ax-channels" id="ax-channel-list">
              <div style="padding:16px;color:var(--text-dim);font-size:12px;">Loading channels…</div>
            </div>
          </div>
          <div class="ax-panel">
            <div class="ax-panel-header">
              <span class="ax-panel-title">Up Next</span>
            </div>
            <div class="ax-schedule-list" id="ax-up-next-list">
              <div style="padding:20px 16px; color:var(--text-dim); font-size:12px;">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- SUBMIT CONTENT MODAL -->
    <div class="ax-modal-overlay" id="ax-submit-modal" style="display:none;">
      <div class="ax-modal-box" style="max-width:520px;">
        <div class="ax-modal-title">🎤 SUBMIT TO AURENIX</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;line-height:1.6;">
          Upload anything you have the legal right to submit — music, video, funny clips, cat videos, podcasts, music videos, slideshows, and more.
          The Founder reviews all submissions before they can be broadcast.<br>
          <strong style="color:var(--text);">Submitting does not publish your content.</strong> Nothing goes on air until the Founder approves it.
        </div>
        <div class="ax-field-group" style="margin-bottom:10px;">
          <label class="ax-field-label">Title *</label>
          <input class="ax-field-input" id="ax-sub-title" placeholder="Track or content title">
        </div>
        <div class="ax-field-group" style="margin-bottom:10px;">
          <label class="ax-field-label">Artist / Creator</label>
          <input class="ax-field-input" id="ax-sub-artist" placeholder="Your name or artist name">
        </div>
        <div class="ax-field-group" style="margin-bottom:10px;">
          <label class="ax-field-label">Content Type</label>
          <select class="ax-field-input" id="ax-sub-type">
            <option value="music">🎵 Music</option>
            <option value="video">🎬 Video</option>
            <option value="funny_clip">😂 Funny Clip</option>
            <option value="short_film">🎥 Short Film</option>
            <option value="podcast">🎙 Podcast</option>
            <option value="music_video">🎞 Music Video</option>
            <option value="other">📦 Other</option>
          </select>
        </div>
        <div class="ax-field-group" style="margin-bottom:10px;">
          <label class="ax-field-label">Media URL (link to your file or stream)</label>
          <input class="ax-field-input" id="ax-sub-url" type="url" placeholder="https://…">
        </div>
        <div class="ax-field-group" style="margin-bottom:10px;">
          <label class="ax-field-label">Description</label>
          <textarea class="ax-field-input" id="ax-sub-desc" rows="3" placeholder="Tell us about your content…" style="resize:vertical;"></textarea>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;cursor:pointer;">
          <input type="checkbox" id="ax-sub-rights" style="margin-top:3px;accent-color:var(--blue);">
          <span style="font-size:11px;color:var(--text-dim);line-height:1.5;">
            I confirm that I have the legal right to submit this content, or have explicit permission from the rights holder.
            I understand this submission will be reviewed by the Founder before any broadcast decision is made.
            AURENIX does not claim ownership of submitted content.
          </span>
        </label>
        <div class="ax-auth-err" id="ax-sub-err"></div>
        <div class="ax-modal-actions">
          <button class="ax-btn-ghost" id="ax-sub-cancel">CANCEL</button>
          <button class="ax-btn-primary" id="ax-sub-submit">SUBMIT TO AURENIX</button>
        </div>
      </div>
    </div>
  `;

  if (channels.length) _buildChannelList();
  _bindPlayerControls();
}

function _buildChannelList() {
  const list = document.getElementById('ax-channel-list');
  if (!list) return;
  if (!_channels.length) {
    list.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:12px;">No channels available.</div>';
    return;
  }
  const icons = { ONE:'🔴', MUSIC:'🎵', VIDEO:'🎬', FUNNY:'😂', 'AFTER DARK':'🌙', GAMING:'🎮', HORROR:'👻', SPORTS:'⚽', CONCERTS:'🎤', COMEDY:'😄', MOVIES:'🎞', PODCASTS:'🎙', 'SCI-FI':'🚀', CLASSICS:'📺' };
  list.innerHTML = _channels.map(ch => {
    const icon = icons[ch.label?.toUpperCase()] || icons[ch.name?.split(' ').pop()?.toUpperCase()] || '📺';
    return `
    <button class="ax-channel-btn ${_activeChannel?.id === ch.id ? 'active' : ''}"
            data-chid="${ch.id}">
      <span class="ax-ch-num">${icon}</span>
      <span class="ax-ch-name">${_esc(ch.label || ch.name)}</span>
      <span class="ax-ch-status ${_channelStates[ch.id]?.current_item ? 'live' : 'idle'}" id="ax-ch-dot-${ch.id}"></span>
    </button>`;
  }).join('');
  list.querySelectorAll('.ax-channel-btn').forEach(btn => {
    btn.addEventListener('click', () => _setActiveChannel(btn.dataset.chid));
  });
}

function _bindPlayerControls() {
  document.getElementById('ax-gate-btn')?.addEventListener('click', _enterBroadcast);
  document.getElementById('ax-media-area')?.addEventListener('click', (e) => {
    if (!_gateOpen) return;
    if (e.target.closest('#ax-gate')) return;
    _togglePlayPause();
  });

  document.getElementById('ax-play-btn')?.addEventListener('click', _togglePlayPause);

  const volSlider = document.getElementById('ax-vol-slider');
  volSlider?.addEventListener('input', () => {
    if (_mediaEl) _mediaEl.volume = parseFloat(volSlider.value);
    _updateMuteBtn();
  });
  document.getElementById('ax-mute-btn')?.addEventListener('click', () => {
    if (_mediaEl) _mediaEl.muted = !_mediaEl.muted;
    _updateMuteBtn();
  });

  document.getElementById('ax-fs-btn')?.addEventListener('click', () => {
    const area = document.getElementById('ax-media-area');
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else { area?.requestFullscreen().catch(() => {}); }
  });

  document.getElementById('ax-pip-btn')?.addEventListener('click', () => {
    const v = document.getElementById('ax-video');
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); }
    else if (v && v.style.display !== 'none') { v.requestPictureInPicture().catch(() => {}); }
  });
}

function _enterBroadcast() {
  _gateOpen = true;
  const gate = document.getElementById('ax-gate');
  if (gate) gate.style.display = 'none';
  const st = _activeChannel ? _channelStates[_activeChannel.id] : null;
  if (st?.current_item) {
    _playState(st);
  }
}

/* ════════════════════════════════════
   CHANNEL STATE SUBSCRIPTION
════════════════════════════════════ */
function _subscribeChannelState(channelId) {
  if (_channelUnsubs[channelId]) return;
  const ref = doc(db, 'network_state', channelId);
  _channelUnsubs[channelId] = onSnapshot(ref, (snap) => {
    const st = snap.exists() ? snap.data() : null;
    _channelStates[channelId] = st;
    const dot = document.getElementById(`ax-ch-dot-${channelId}`);
    if (dot) {
      dot.className = `ax-ch-status ${st?.current_item ? 'live' : 'idle'}`;
    }
    if (_activeChannel?.id === channelId) {
      _onActiveChannelUpdate(st);
    }
  });
}

function _setActiveChannel(channelId) {
  const ch = _channels.find(c => c.id === channelId);
  if (!ch) return;
  _activeChannel = ch;

  const badgeId = document.getElementById('ax-badge-id');
  const badgeName = document.getElementById('ax-badge-name');
  if (badgeId) badgeId.textContent = ch.label || ch.id;
  if (badgeName) badgeName.textContent = ch.name;

  document.querySelectorAll('.ax-channel-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.chid === channelId);
  });

  _stopMedia();

  const st = _channelStates[channelId];
  if (st) _onActiveChannelUpdate(st);
  else {
    _setNowPlaying(ch.name, '', '');
    _renderUpNext([]);
  }
}

function _onActiveChannelUpdate(st) {
  if (!st || !st.current_item) {
    _setNowPlaying('Standby…', '', '');
    _renderUpNext([]);
    _stopMedia();
    return;
  }
  const item = st.current_item;
  _setNowPlaying(item.title, item.artist || '', item.type || '');

  const queue = st.queue || [];
  const curIdx = queue.findIndex(q => q.id === item.id);
  _renderUpNext(queue.slice(curIdx + 1, curIdx + 6));

  if (_gateOpen) _playState(st);
  _startTick();
}

/* ════════════════════════════════════
   PLAYBACK
════════════════════════════════════ */
function _playState(st) {
  if (!st?.current_item?.url) return;

  const item = st.current_item;
  const startedAt = st.started_at?.toMillis?.() || Date.now();
  const elapsed = (Date.now() - startedAt) / 1000;
  const dur = item.duration_sec || 0;

  // Only auto-advance when there is a known positive duration.
  // Items with duration_sec=0 (images, duration-unknown media) display indefinitely
  // until the founder manually advances or the channel loops.
  if (dur > 0 && elapsed >= dur - 0.5) {
    _advance(st);
    return;
  }

  // Determine media kind:
  //   isImage — item is a static image (still art, photo, poster)
  //   isVideo — item is a video file
  //   otherwise audio
  const isImage = (
    item.type === 'thumbnail' ||
    /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(item.url) ||
    (item.mime_type || '').startsWith('image/')
  );
  const isVideo = !isImage && (
    item.type === 'video' || item.type === 'music_video' || item.type === 'show' ||
    item.type === 'trailer' || item.type === 'archive' || item.type === 'broadcast_clip' ||
    /\.(mp4|webm|mov|avi|wmv|mpeg)(\?|$)/i.test(item.url) ||
    (item.mime_type || '').startsWith('video/')
  );

  const videoEl = document.getElementById('ax-video');
  const audioEl = document.getElementById('ax-audio');
  const thumbEl = document.getElementById('ax-thumbnail');

  if (isImage) {
    // ── Static image display path ──────────────────────────────────────────
    // Show the image in the thumbnail area; use <audio> if a paired audio URL
    // is provided (future extension), otherwise no audio element needed.
    _stopMedia();
    _mediaEl   = null;
    _mediaType = 'image';

    if (thumbEl) {
      thumbEl.style.display      = 'flex';
      thumbEl.style.backgroundImage = `url(${JSON.stringify(item.url)})`;
      thumbEl.style.backgroundSize   = 'contain';
      thumbEl.style.backgroundRepeat = 'no-repeat';
      thumbEl.style.backgroundPosition = 'center';
      // Clear the default placeholder glyph when an image is loaded
      const placeholder = thumbEl.querySelector('div');
      if (placeholder) placeholder.style.display = 'none';
    }
    if (videoEl) videoEl.style.display = 'none';
    if (audioEl) audioEl.style.display = 'none';

    const pipBtn = document.getElementById('ax-pip-btn');
    if (pipBtn) pipBtn.style.display = 'none';

    _updatePlayBtn();
    return;
  }

  // ── Audio / Video playback path ────────────────────────────────────────
  const el = isVideo ? videoEl : audioEl;

  if (_mediaEl !== el || _mediaEl?.src !== item.url) {
    _stopMedia();
    _mediaEl = el;
    _mediaType = isVideo ? 'video' : 'audio';

    if (_mediaEl) {
      _mediaEl.src = item.url;
      _mediaEl.style.display = isVideo ? 'block' : 'none';
      if (isVideo) { if (thumbEl) thumbEl.style.display = 'none'; }
      else { if (thumbEl) thumbEl.style.display = 'flex'; }
      _mediaEl.volume = parseFloat(document.getElementById('ax-vol-slider')?.value || '0.8');
      _mediaEl.currentTime = Math.max(0, elapsed);

      _mediaEl.onended = () => _advance(st);
      _mediaEl.onerror = () => {
        console.warn('[AURENIX] Media error, advancing');
        setTimeout(() => _advance(st), 1500);
      };

      const pipBtn = document.getElementById('ax-pip-btn');
      if (pipBtn) pipBtn.style.display = isVideo && document.pictureInPictureEnabled ? '' : 'none';

      _mediaEl.play().catch(() => {
        const gate = document.getElementById('ax-gate');
        if (gate) {
          gate.style.display = 'flex';
          const sub = gate.querySelector('.ax-gate-sub');
          if (sub) sub.textContent = 'Tap to unmute the broadcast';
        }
        _gateOpen = false;
      });
    }
  } else {
    const drift = Math.abs(_mediaEl.currentTime - elapsed);
    if (drift > 3) _mediaEl.currentTime = elapsed;
    if (_mediaEl.paused) _mediaEl.play().catch(() => {});
  }

  _updatePlayBtn();
}

function _stopMedia() {
  if (_mediaEl) {
    _mediaEl.pause();
    _mediaEl.src = '';
    _mediaEl.style.display = 'none';
    _mediaEl.onended = null;
    _mediaEl.onerror = null;
  }
  _mediaEl   = null;
  _mediaType = null;

  // Clear any image that was displayed in the thumbnail area and restore
  // the default placeholder so the next item starts from a clean state.
  const thumbEl = document.getElementById('ax-thumbnail');
  if (thumbEl) {
    thumbEl.style.display           = 'flex';
    thumbEl.style.backgroundImage   = '';
    thumbEl.style.backgroundSize    = '';
    thumbEl.style.backgroundRepeat  = '';
    thumbEl.style.backgroundPosition = '';
    const placeholder = thumbEl.querySelector('div');
    if (placeholder) placeholder.style.display = '';
  }
}

function _togglePlayPause() {
  if (!_mediaEl) return;
  if (_mediaEl.paused) { _mediaEl.play().catch(() => {}); }
  else { _mediaEl.pause(); }
  _updatePlayBtn();
}

function _updatePlayBtn() {
  const btn = document.getElementById('ax-play-btn');
  if (!btn) return;
  btn.textContent = (_mediaEl && !_mediaEl.paused) ? '⏸' : '▶';
}

function _updateMuteBtn() {
  const btn = document.getElementById('ax-mute-btn');
  if (!btn || !_mediaEl) return;
  btn.textContent = (_mediaEl.muted || _mediaEl.volume === 0) ? '🔇' : '🔊';
}

/* ════════════════════════════════════
   TICK
════════════════════════════════════ */
function _startTick() {
  if (_tickTimer) return;
  _tickTimer = setInterval(_tick, 800);
}

function _stopTick() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function _tick() {
  if (!_activeChannel) { _stopTick(); return; }
  const st = _channelStates[_activeChannel.id];
  if (!st?.current_item) { _stopTick(); return; }

  const startedAt = st.started_at?.toMillis?.() || Date.now();
  const elapsed   = (Date.now() - startedAt) / 1000;
  const dur       = st.current_item.duration_sec || 0;

  const fill      = document.getElementById('ax-progress-fill');
  const elapsedEl = document.getElementById('ax-time-elapsed');
  const remainEl  = document.getElementById('ax-time-remaining');

  if (dur > 0) {
    const pct = Math.min(100, (elapsed / dur) * 100);
    if (fill) fill.style.width = pct + '%';
    if (elapsedEl) elapsedEl.textContent = _fmtTime(elapsed);
    if (remainEl)  remainEl.textContent  = '-' + _fmtTime(Math.max(0, dur - elapsed));

    if (elapsed >= dur - 0.5 && !_advancing) {
      _advance(st);
    }
  } else {
    if (fill) fill.style.width = '0%';
    if (elapsedEl) elapsedEl.textContent = _fmtTime(elapsed);
    if (remainEl)  remainEl.textContent  = '—';
  }

  _updatePlayBtn();
}

/* ════════════════════════════════════
   ADVANCE
════════════════════════════════════ */
async function _advance(st) {
  if (_advancing) return;
  _advancing = true;

  try {
    if (!_activeChannel) { _advancing = false; return; }
    const channelId  = _activeChannel.id;
    const stRef      = doc(db, 'network_state', channelId);
    const stSnap     = await getDoc(stRef);
    if (!stSnap.exists()) { _advancing = false; return; }

    const live = stSnap.data();
    if (live.current_item?.id !== st?.current_item?.id) {
      _advancing = false; return;
    }

    const queue   = live.queue || [];
    const curIdx  = queue.findIndex(q => q.id === live.current_item?.id);
    let   nextIdx = curIdx + 1;

    if (nextIdx >= queue.length) {
      if (live.loop) { nextIdx = 0; }
      else {
        await setDoc(stRef, { ...live, current_item: null, started_at: serverTimestamp() }, { merge: true });
        _advancing = false; return;
      }
    }

    const nextItem = queue[nextIdx];
    await setDoc(stRef, {
      ...live,
      current_item: nextItem,
      started_at:   serverTimestamp(),
    }, { merge: true });

  } catch (e) {
    console.warn('[AURENIX] Advance error', e);
  }

  _advancing = false;
}

/* ════════════════════════════════════
   UI HELPERS
════════════════════════════════════ */
function _setNowPlaying(title, artist, type) {
  const t = document.getElementById('ax-np-title');
  const a = document.getElementById('ax-np-artist');
  if (t) t.textContent = title;
  if (a) a.textContent = artist;
}

function _renderUpNext(items) {
  const list = document.getElementById('ax-up-next-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div style="padding:16px; color:var(--text-muted); font-size:12px; text-align:center;">Empty queue</div>';
    return;
  }
  list.innerHTML = items.map((item, i) => `
    <div class="ax-sched-row ${i === 0 ? 'current' : ''}">
      <div class="ax-sched-idx">${i === 0 ? '▶' : i + 1}</div>
      <div class="ax-sched-info">
        <div class="ax-sched-title">${_esc(item.title)}</div>
        <div class="ax-sched-meta">${_esc(item.artist || '')}${item.type ? ' · ' + item.type : ''}</div>
      </div>
      <div class="ax-sched-dur">${_fmtTime(item.duration_sec || 0)}</div>
    </div>
  `).join('');
}

/* ════════════════════════════════════
   SUBMIT CONTENT MODAL
════════════════════════════════════ */
function _openSubmitModal() {
  const modal = document.getElementById('ax-submit-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  document.getElementById('ax-sub-cancel')?.addEventListener('click', () => { modal.style.display = 'none'; });
  document.getElementById('ax-sub-submit')?.addEventListener('click', async () => {
    const titleEl  = document.getElementById('ax-sub-title');
    const artistEl = document.getElementById('ax-sub-artist');
    const typeEl   = document.getElementById('ax-sub-type');
    const urlEl    = document.getElementById('ax-sub-url');
    const descEl   = document.getElementById('ax-sub-desc');
    const rightsEl = document.getElementById('ax-sub-rights');
    const errEl    = document.getElementById('ax-sub-err');
    const submitBtn= document.getElementById('ax-sub-submit');

    if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }

    const title = titleEl?.value.trim();
    if (!title) { if (errEl) { errEl.textContent = 'Please enter a title.'; errEl.classList.add('visible'); } return; }
    if (!rightsEl?.checked) {
      if (errEl) { errEl.textContent = 'You must confirm you have rights to submit this content.'; errEl.classList.add('visible'); }
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'SUBMITTING…'; }

    try {
      await addDoc(collection(db, 'media_submissions'), {
        title:           title,
        artist:          artistEl?.value.trim() || '',
        type:            typeEl?.value || 'other',
        url:             urlEl?.value.trim() || '',
        description:     descEl?.value.trim() || '',
        rights_confirmed: true,
        status:          'pending',
        submitted_by:    _user.uid,
        submitted_email: _user.email,
        submitted_at:    serverTimestamp(),
      });
      modal.style.display = 'none';
      if (titleEl) titleEl.value = '';
      if (artistEl) artistEl.value = '';
      if (urlEl) urlEl.value = '';
      if (descEl) descEl.value = '';
      if (rightsEl) rightsEl.checked = false;
      // Show a simple success toast
      let toast = document.getElementById('ax-toast');
      if (!toast) { toast = document.createElement('div'); toast.id = 'ax-toast'; document.body.appendChild(toast); }
      toast.textContent = '✓ Submitted! The Founder will review your content.';
      toast.className = 'visible';
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove('visible'), 4000);
    } catch (e) {
      if (errEl) { errEl.textContent = 'Submission failed: ' + (e.message || e); errEl.classList.add('visible'); }
    }

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'SUBMIT TO AURENIX'; }
  });
}

/* ════════════════════════════════════
   OPEN FOUNDER STUDIO
════════════════════════════════════ */
function _openControl() {
  if (!_isFounder || !_user) return;

  let ctrl = document.getElementById('ax-control');
  if (!ctrl) {
    ctrl = document.createElement('div');
    ctrl.id = 'ax-control';
    document.body.appendChild(ctrl);
  }

  ctrl.classList.add('visible');
  ctrl.innerHTML = `
    <div class="ax-ctrl-loading">
      <div style="font-size:40px;opacity:0.5;margin-bottom:8px;">⚡</div>
      <div class="ax-ctrl-loading-title">AURENIX</div>
      <div class="ax-ctrl-loading-sub">FOUNDER STUDIO — LOADING…</div>
    </div>`;

  const hero = document.getElementById('ax-hero');
  if (hero) hero.style.display = 'none';

  import('./aurenix-control.js')
    .then(m => m.mountControl(_user, _isFounder))
    .catch(err => {
      console.error('[AURENIX] Founder Studio failed to load:', err);
      ctrl.innerHTML = `
        <div class="ax-ctrl-error">
          <div style="font-size:clamp(20px,3vw,32px);font-weight:900;letter-spacing:0.2em;color:var(--text);">
            AURE<span style="color:var(--blue-bright)">NIX</span>
          </div>
          <div style="font-size:11px;letter-spacing:3px;color:var(--blue-bright);text-transform:uppercase;margin-bottom:8px;">
            FOUNDER STUDIO
          </div>
          <div class="ax-ctrl-error-msg">
            <strong>Studio failed to load</strong><br>
            ${err?.message ? err.message.replace(/</g,'&lt;') : 'An unexpected error occurred.'}<br>
            <span style="color:var(--text-dim);font-size:11px;">Open the browser console for details.</span>
          </div>
          <button onclick="document.getElementById('ax-control').classList.remove('visible');document.getElementById('ax-hero').style.display=''"
                  style="margin-top:8px;padding:10px 28px;background:var(--surface-hi);color:var(--text);border:1px solid var(--border-hi);border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
            ← BACK TO BROADCAST
          </button>
          <button onclick="location.reload()"
                  style="padding:10px 28px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
            RETRY
          </button>
        </div>`;
    });
}

/* ════════════════════════════════════
   AUTH UTILITIES
════════════════════════════════════ */
function _validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function _friendlyAuthError(code) {
  switch (code) {
    case 'auth/invalid-email':           return 'Invalid email address.';
    case 'auth/user-not-found':          return 'No account found with that email.';
    case 'auth/wrong-password':          return 'Incorrect password.';
    case 'auth/invalid-credential':      return 'Incorrect email or password.';
    case 'auth/too-many-requests':       return 'Too many attempts — try again later or reset your password.';
    case 'auth/user-disabled':           return 'This account has been disabled.';
    case 'auth/network-request-failed':  return 'Network error — check your connection.';
    case 'auth/email-already-in-use':    return 'That email is already registered. Try logging in.';
    case 'auth/weak-password':           return 'Password must be at least 6 characters.';
    case 'auth/operation-not-allowed':   return 'Email/password accounts are not enabled. Contact the network owner.';
    default:                             return 'Authentication failed (' + (code || 'unknown') + '). Please try again.';
  }
}

function _showErr(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

function _clearErr(el) {
  if (!el) return;
  el.textContent = '';
  el.classList.remove('visible');
  el.style.color = '';
}

/* ════════════════════════════════════
   UTILITIES
════════════════════════════════════ */
function _fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${m}:${String(ss).padStart(2,'0')}`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
