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

import { oneChannelAdvance } from './aurenix-one-engine.js';
import { liveTvChannelAdvance, LIVE_TV_CHANNEL_ID } from './aurenix-live-tv-engine.js';

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
                <div class="ax-np-label" id="ax-np-label-text">NOW PLAYING</div>
                <div class="ax-np-title" id="ax-np-title">Connecting to network…</div>
                <div class="ax-np-artist" id="ax-np-artist"></div>
              </div>
              <!-- AURENIX ONE live-TV overlays -->
              <div id="ax-one-viewer-live" style="display:none;position:absolute;top:12px;left:12px;z-index:10;background:rgba(255,45,85,0.92);color:#fff;font-size:10px;font-weight:900;letter-spacing:2px;padding:3px 8px;border-radius:4px;">● LIVE</div>
              <div id="ax-one-viewer-comm" style="display:none;position:absolute;top:12px;right:12px;z-index:10;background:rgba(184,134,11,0.92);color:#fff;font-size:10px;font-weight:900;letter-spacing:1.5px;padding:3px 8px;border-radius:4px;">📢 COMMERCIAL BREAK</div>
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
      <div class="ax-modal-box" style="max-width:560px;width:100%;">
        <div class="ax-modal-title">🎤 SUBMIT CONTENT TO AURENIX</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;line-height:1.6;">
          Upload directly from your phone, tablet, or computer — music, video, funny clips, podcasts, music videos, and more.<br>
          <strong style="color:var(--text);">Submitting does not publish your content.</strong> The Founder reviews all submissions before anything goes on air.
        </div>

        <!-- ── FILE PICKER ZONE ── -->
        <div id="ax-sub-drop-zone" style="
            border:2px dashed rgba(30,80,255,0.45);border-radius:10px;
            padding:22px 16px;text-align:center;cursor:pointer;
            background:rgba(30,80,255,0.04);margin-bottom:14px;
            transition:border-color 0.15s,background 0.15s;">
          <div style="font-size:28px;margin-bottom:6px;">📁</div>
          <div style="font-size:14px;font-weight:700;color:var(--text);letter-spacing:0.5px;">SELECT FILE</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px;line-height:1.6;">
            Tap to choose from your device — phone, tablet, or computer<br>
            <span style="opacity:0.7;">Video: MP4 WebM MOV · Audio: MP3 WAV AAC · Image: JPG PNG WebP</span>
          </div>
          <!-- Hidden inputs — separate for better iOS/Android compatibility -->
          <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px;">
            <button type="button" id="ax-sub-btn-any"
                    style="padding:8px 16px;background:var(--blue,#1e50ff);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;letter-spacing:0.5px;">
              📁 SELECT FILE
            </button>
            <button type="button" id="ax-sub-btn-photo"
                    style="padding:8px 16px;background:rgba(30,80,255,0.15);color:var(--blue-bright,#4d7aff);border:1px solid rgba(30,80,255,0.3);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
              📷 PHOTO
            </button>
            <button type="button" id="ax-sub-btn-video"
                    style="padding:8px 16px;background:rgba(30,80,255,0.15);color:var(--blue-bright,#4d7aff);border:1px solid rgba(30,80,255,0.3);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
              🎥 VIDEO
            </button>
            <button type="button" id="ax-sub-btn-audio"
                    style="padding:8px 16px;background:rgba(30,80,255,0.15);color:var(--blue-bright,#4d7aff);border:1px solid rgba(30,80,255,0.3);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
              🎵 AUDIO
            </button>
          </div>
          <!-- Hidden file inputs (one per accept type for broadest mobile compat) -->
          <input type="file" id="ax-sub-file-any"   accept="audio/*,video/*,image/*" style="display:none;">
          <input type="file" id="ax-sub-file-photo" accept="image/*" capture="environment" style="display:none;">
          <input type="file" id="ax-sub-file-video" accept="video/*" capture="environment" style="display:none;">
          <input type="file" id="ax-sub-file-audio" accept="audio/*" style="display:none;">
        </div>

        <!-- ── SELECTED FILE INFO ── -->
        <div id="ax-sub-file-info" style="display:none;background:var(--surface,#10101c);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px 14px;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span id="ax-sub-file-icon" style="font-size:20px;flex-shrink:0;">📄</span>
            <div style="flex:1;min-width:0;">
              <div id="ax-sub-file-name" style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
              <div id="ax-sub-file-meta" style="font-size:11px;color:var(--text-dim);margin-top:2px;"></div>
            </div>
            <button type="button" id="ax-sub-file-clear" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:16px;padding:4px;flex-shrink:0;" title="Remove file">✕</button>
          </div>
        </div>

        <!-- ── UPLOAD PROGRESS ── -->
        <div id="ax-sub-progress" style="display:none;margin-bottom:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <span id="ax-sub-progress-status" style="font-size:12px;color:var(--text-dim);">Uploading…</span>
            <span id="ax-sub-progress-pct" style="font-size:12px;font-weight:700;color:var(--blue-bright,#4d7aff);">0%</span>
          </div>
          <div style="height:6px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden;">
            <div id="ax-sub-progress-bar" style="height:100%;width:0%;background:var(--blue,#1e50ff);border-radius:3px;transition:width 0.1s;"></div>
          </div>
          <div id="ax-sub-progress-bytes" style="font-size:10px;color:var(--text-dim);margin-top:4px;text-align:right;"></div>
        </div>

        <!-- ── METADATA FIELDS ── -->
        <div id="ax-sub-meta-fields">
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
            <label class="ax-field-label">Description</label>
            <textarea class="ax-field-input" id="ax-sub-desc" rows="2" placeholder="Tell us about your content…" style="resize:vertical;"></textarea>
          </div>
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
          <button class="ax-btn-primary" id="ax-sub-submit" disabled style="opacity:0.5;">SUBMIT TO AURENIX</button>
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
    _updateLiveTVOverlay(null, false);
    return;
  }
  const item   = st.current_item;
  const isComm = !!(st.is_commercial);
  _setNowPlaying(item.title, item.artist || '', item.type || '');
  _updateLiveTVOverlay(item, isComm);

  // For live-TV engine channels (A1 and ALTV): up-next from commercial_queue or auto-selected
  if (_activeChannel?.id === 'A1' || _activeChannel?.id === LIVE_TV_CHANNEL_ID) {
    const commQ = st.commercial_queue || [];
    if (isComm && commQ.length > 0) {
      _renderUpNext([commQ[0]]);
    } else {
      _renderUpNext([]);
    }
  } else {
    const queue  = st.queue || [];
    const curIdx = queue.findIndex(q => q.id === item.id);
    _renderUpNext(queue.slice(curIdx + 1, curIdx + 6));
  }

  if (_gateOpen) _playState(st);
  _startTick();
}

/** Update the live-TV channel badge and commercial indicator for viewers. */
function _updateLiveTVOverlay(item, isCommercial) {
  const commBanner = document.getElementById('ax-one-viewer-comm');
  if (commBanner) commBanner.style.display = isCommercial ? '' : 'none';

  const liveTag = document.getElementById('ax-one-viewer-live');
  if (liveTag) liveTag.style.display = item ? '' : 'none';
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

    // ── AURENIX ONE — live-TV engine handles its own advance ─────────────────
    if (channelId === 'A1') {
      const currentId = st?.current_item?.id || null;
      await oneChannelAdvance(currentId);
      _advancing = false;
      return;
    }
    // ── AURENIX LIVE TV — separate live-TV engine ─────────────────────────────
    if (channelId === LIVE_TV_CHANNEL_ID) {
      const currentId = st?.current_item?.id || null;
      await liveTvChannelAdvance(currentId);
      _advancing = false;
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

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

const UPLOAD_WORKER_URL = 'https://aurenix-upload.nthntjrn.workers.dev';

/** Format bytes human-readable */
function _subFmtSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

/** Pick a file type icon from MIME */
function _subFileIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('video/'))  return '🎬';
  if (mime.startsWith('audio/'))  return '🎵';
  if (mime.startsWith('image/'))  return '🖼️';
  return '📄';
}

/** Guess a content type option from MIME / filename */
function _subGuessType(mime, filename) {
  const ext = (filename?.split('.').pop() || '').toLowerCase();
  if (mime?.startsWith('video/') || ['mp4','webm','mov','avi','mkv','m4v'].includes(ext)) return 'video';
  if (mime?.startsWith('audio/') || ['mp3','wav','aac','flac','ogg','m4a','opus'].includes(ext)) return 'music';
  return 'other';
}

/**
 * Upload a file to Supabase via Worker signed URL.
 * Phase 1: POST /submission/authorize  → signedUrl + storagePath + publicUrl
 * Phase 2: XHR PUT to signedUrl        → bytes go straight to Supabase
 */
async function _subUploadFile(file, onProgress, onStatus) {
  if (!auth.currentUser) throw new Error('Not signed in — please log in again.');
  const idToken = await auth.currentUser.getIdToken(true);

  // Phase 1: get signed URL
  onStatus('AUTHENTICATING…');
  const authRes  = await fetch(UPLOAD_WORKER_URL + '/submission/authorize', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + idToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      fileName:    file.name,
      contentType: file.type || 'application/octet-stream',
      size:        file.size,
    }),
  });
  const authData = await authRes.json();
  if (!authRes.ok || !authData.ok)
    throw new Error(authData.error || `Authorization failed — HTTP ${authRes.status}`);

  const { signedUrl, storagePath, publicUrl } = authData;
  if (!signedUrl?.includes('/object/upload/sign/') || !signedUrl.includes('token='))
    throw new Error('Worker returned an invalid signed URL. Please try again.');

  // Phase 2: PUT file to Supabase signed URL
  onStatus('UPLOADING…');
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload  = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(file.size, file.size); resolve(); }
      else reject(new Error(`Upload failed — HTTP ${xhr.status}: ${xhr.responseText?.slice(0,200)}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.send(file);
  });

  return { storagePath, publicUrl };
}

function _openSubmitModal() {
  const modal = document.getElementById('ax-submit-modal');
  if (!modal) return;

  // Per-open state
  let _selectedFile = null;
  let _uploading    = false;

  const setErr = msg => {
    const el = document.getElementById('ax-sub-err');
    if (!el) return;
    el.textContent = msg;
    if (msg) el.classList.add('visible'); else el.classList.remove('visible');
  };

  const setSubmitEnabled = (on) => {
    const btn = document.getElementById('ax-sub-submit');
    if (!btn) return;
    btn.disabled = !on;
    btn.style.opacity = on ? '1' : '0.5';
  };

  const checkSubmitReady = () => {
    setSubmitEnabled(
      !_uploading &&
      !!_selectedFile &&
      !!document.getElementById('ax-sub-title')?.value.trim() &&
      !!document.getElementById('ax-sub-rights')?.checked
    );
  };

  const showFileInfo = (file) => {
    const infoEl  = document.getElementById('ax-sub-file-info');
    const iconEl  = document.getElementById('ax-sub-file-icon');
    const nameEl  = document.getElementById('ax-sub-file-name');
    const metaEl  = document.getElementById('ax-sub-file-meta');
    const titleEl = document.getElementById('ax-sub-title');
    const typeEl  = document.getElementById('ax-sub-type');
    if (!infoEl) return;
    if (file) {
      if (iconEl) iconEl.textContent = _subFileIcon(file.type);
      if (nameEl) nameEl.textContent = file.name;
      if (metaEl) metaEl.textContent = `${_subFmtSize(file.size)}  ·  ${file.type || 'unknown type'}`;
      infoEl.style.display = '';
      if (titleEl && !titleEl.value.trim())
        titleEl.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      if (typeEl) {
        const g = _subGuessType(file.type, file.name);
        if (g !== 'other') typeEl.value = g;
      }
    } else {
      infoEl.style.display = 'none';
    }
    checkSubmitReady();
  };

  const clearFile = () => {
    _selectedFile = null;
    showFileInfo(null);
    ['ax-sub-file-any','ax-sub-file-photo','ax-sub-file-video','ax-sub-file-audio'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    setProgressUI(null);
  };

  const setProgressUI = (loaded, total) => {
    const wrap    = document.getElementById('ax-sub-progress');
    const bar     = document.getElementById('ax-sub-progress-bar');
    const pctEl   = document.getElementById('ax-sub-progress-pct');
    const bytesEl = document.getElementById('ax-sub-progress-bytes');
    if (loaded === null || loaded === undefined) { if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    const pct = (total > 0) ? Math.min(99, Math.round(loaded / total * 100)) : 0;
    if (bar)    bar.style.width   = pct + '%';
    if (pctEl)  pctEl.textContent = pct + '%';
    if (bytesEl && total > 0) bytesEl.textContent = `${_subFmtSize(loaded)} / ${_subFmtSize(total)}`;
  };

  const setStatusMsg = msg => {
    const el = document.getElementById('ax-sub-progress-status');
    if (el) el.textContent = msg;
  };

  // Wire hidden file inputs
  const wireInput = (inputId) => {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.onchange = () => {
      const file = el.files?.[0];
      if (!file) return;
      _selectedFile = file;
      showFileInfo(file);
      setErr('');
    };
  };
  wireInput('ax-sub-file-any');
  wireInput('ax-sub-file-photo');
  wireInput('ax-sub-file-video');
  wireInput('ax-sub-file-audio');

  // Picker buttons
  document.getElementById('ax-sub-btn-any')?.addEventListener('click', e => {
    e.stopPropagation(); document.getElementById('ax-sub-file-any')?.click();
  });
  document.getElementById('ax-sub-btn-photo')?.addEventListener('click', e => {
    e.stopPropagation(); document.getElementById('ax-sub-file-photo')?.click();
  });
  document.getElementById('ax-sub-btn-video')?.addEventListener('click', e => {
    e.stopPropagation(); document.getElementById('ax-sub-file-video')?.click();
  });
  document.getElementById('ax-sub-btn-audio')?.addEventListener('click', e => {
    e.stopPropagation(); document.getElementById('ax-sub-file-audio')?.click();
  });

  // Drop zone click (desktop)
  document.getElementById('ax-sub-drop-zone')?.addEventListener('click', e => {
    if (!e.target.closest('button')) document.getElementById('ax-sub-file-any')?.click();
  });

  // Drag-and-drop (desktop)
  const dz = document.getElementById('ax-sub-drop-zone');
  if (dz) {
    dz.addEventListener('dragover', e => {
      e.preventDefault();
      dz.style.borderColor = 'var(--blue,#1e50ff)';
      dz.style.background  = 'rgba(30,80,255,0.09)';
    });
    dz.addEventListener('dragleave', () => { dz.style.borderColor = ''; dz.style.background = ''; });
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.style.borderColor = '';
      dz.style.background  = '';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const ok = !file.type || file.type.startsWith('audio/') || file.type.startsWith('video/') || file.type.startsWith('image/');
      if (!ok) { setErr('Unsupported file type. Please select a video, audio, or image file.'); return; }
      _selectedFile = file;
      showFileInfo(file);
      setErr('');
    });
  }

  // Clear file button
  document.getElementById('ax-sub-file-clear')?.addEventListener('click', e => {
    e.stopPropagation(); clearFile();
  });

  // Re-check submit state on title / rights changes
  document.getElementById('ax-sub-title')?.addEventListener('input', checkSubmitReady);
  document.getElementById('ax-sub-rights')?.addEventListener('change', checkSubmitReady);

  // Cancel
  document.getElementById('ax-sub-cancel')?.addEventListener('click', () => {
    if (_uploading) return;
    modal.style.display = 'none';
  });

  // Submit
  document.getElementById('ax-sub-submit')?.addEventListener('click', async () => {
    setErr('');
    const titleEl   = document.getElementById('ax-sub-title');
    const artistEl  = document.getElementById('ax-sub-artist');
    const typeEl    = document.getElementById('ax-sub-type');
    const descEl    = document.getElementById('ax-sub-desc');
    const rightsEl  = document.getElementById('ax-sub-rights');
    const submitBtn = document.getElementById('ax-sub-submit');
    const cancelBtn = document.getElementById('ax-sub-cancel');

    const title = titleEl?.value.trim();
    if (!title)           { setErr('Please enter a title.'); return; }
    if (!_selectedFile)   { setErr('Please select a file to upload.'); return; }
    if (!rightsEl?.checked) { setErr('You must confirm you have rights to submit this content.'); return; }

    _uploading = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.5'; submitBtn.textContent = 'UPLOADING…'; }
    if (cancelBtn) cancelBtn.disabled = true;
    setProgressUI(0, _selectedFile.size);

    let storagePath = null;
    let publicUrl   = null;

    try {
      const result = await _subUploadFile(
        _selectedFile,
        (loaded, total) => setProgressUI(loaded, total),
        (msg)           => setStatusMsg(msg),
      );
      storagePath = result.storagePath;
      publicUrl   = result.publicUrl;

      setStatusMsg('SAVING RECORD…');
      if (submitBtn) submitBtn.textContent = 'SAVING…';

      await addDoc(collection(db, 'media_submissions'), {
        title:            title,
        artist:           artistEl?.value.trim() || '',
        type:             typeEl?.value || 'other',
        description:      descEl?.value.trim() || '',
        storage_path:     storagePath,
        url:              publicUrl,
        file_name:        _selectedFile.name,
        size_bytes:       _selectedFile.size,
        mime_type:        _selectedFile.type || 'application/octet-stream',
        rights_confirmed: true,
        status:           'pending',
        submitted_by:     _user.uid,
        submitted_email:  _user.email,
        submitted_at:     serverTimestamp(),
      });

      modal.style.display = 'none';
      if (titleEl)  titleEl.value  = '';
      if (artistEl) artistEl.value = '';
      if (descEl)   descEl.value   = '';
      if (rightsEl) rightsEl.checked = false;
      clearFile();

      const toast = document.getElementById('ax-toast') ||
        (() => { const t = document.createElement('div'); t.id = 'ax-toast'; document.body.appendChild(t); return t; })();
      toast.textContent = '✓ Submitted! The Founder will review your content.';
      toast.className = 'visible';
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove('visible'), 5000);

    } catch (e) {
      setErr('Upload failed: ' + (e.message || e));
      setStatusMsg('FAILED');
      setProgressUI(null);
    } finally {
      _uploading = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.textContent = 'SUBMIT TO AURENIX'; }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });

  modal.style.display = 'flex';
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
