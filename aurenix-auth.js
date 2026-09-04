/**
 * AURENIX — Authentication System
 * aurenix-auth.js
 *
 * Handles:
 *  - Auth state management (Supabase)
 *  - Login / Register modal
 *  - Admin detection (christijerina46@gmail.com)
 *  - Nav user pill update
 *  - Admin-only DOM guards
 *  - Global window.AURENIX_AUTH export
 *
 * SECURITY NOTE:
 *  Admin identity is verified via the email in the Supabase JWT.
 *  All sensitive operations are enforced server-side via Row Level Security.
 *  This file handles the UI layer only — it never grants real access.
 */

import { supabase, onAuthChange, loadUserProfile, upsertUserProfile }
  from './supabase-client.js';

/* ── Admin email — server side must also enforce this ── */
const ADMIN_EMAIL = 'christijerina46@gmail.com';

/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let _user    = null;
let _profile = null;
let _isAdmin = false;

/* ═══════════════════════════════════════════
   ADMIN CHECK
   Real access control is enforced by Supabase RLS.
   This flag only controls UI visibility.
═══════════════════════════════════════════ */
function checkAdmin(user) {
  return !!(user && user.email === ADMIN_EMAIL && user.email_confirmed_at);
}

/* ═══════════════════════════════════════════
   AUTH STATE CHANGE
═══════════════════════════════════════════ */
onAuthChange(async (user) => {
  _user    = user;
  _isAdmin = checkAdmin(user);
  _profile = null;

  if (user) {
    _profile = await loadUserProfile(user.id);
    if (!_profile) {
      // Create profile on first login
      const handle = (user.email || '').split('@')[0].replace(/[^a-z0-9_]/gi, '_');
      _profile = {
        uid:          user.id,
        email:        user.email || '',
        display_name: handle,
        username:     handle,
        role:         _isAdmin ? 'administrator' : 'member',
      };
      await upsertUserProfile(_profile);
    }
    // Elevate admin role in profile if not already set
    if (_isAdmin && _profile.role !== 'administrator' && _profile.role !== 'founder') {
      _profile.role = 'administrator';
      await upsertUserProfile({ uid: user.id, role: 'administrator' });
    }
  }

  updateNavUI();
  updateAdminGates();
  window.dispatchEvent(new CustomEvent('aurenix:authchange', {
    detail: { user: _user, profile: _profile, isAdmin: _isAdmin }
  }));
});

/* ═══════════════════════════════════════════
   NAV UI UPDATE
═══════════════════════════════════════════ */
function updateNavUI() {
  const pill     = document.getElementById('nav-user-pill');
  const loginBtn = document.getElementById('nav-login-btn');

  if (!pill) return;

  if (_user) {
    const name = _profile?.display_name || _user.email?.split('@')[0] || 'User';
    const avatarText = name.charAt(0).toUpperCase();
    pill.innerHTML = `
      <div class="nav-avatar" aria-hidden="true">${avatarText}</div>
      <span class="nav-user-name">${esc(name)}</span>
    `;
    pill.style.display = 'flex';
    if (loginBtn) loginBtn.style.display = 'none';
  } else {
    pill.style.display = 'none';
    if (loginBtn) loginBtn.style.display = 'flex';
  }
}

/* ═══════════════════════════════════════════
   ADMIN GATE ENFORCEMENT (UI layer)
   Elements with data-admin-only="true" are hidden for non-admins.
   Elements with data-requires-auth="true" are hidden when logged out.
═══════════════════════════════════════════ */
function updateAdminGates() {
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = _isAdmin ? '' : 'none';
  });
  document.querySelectorAll('[data-requires-auth]').forEach(el => {
    el.style.display = _user ? '' : 'none';
  });
  document.querySelectorAll('[data-guest-only]').forEach(el => {
    el.style.display = _user ? 'none' : '';
  });
}

/* ═══════════════════════════════════════════
   AUTH MODAL
═══════════════════════════════════════════ */
function buildModal() {
  if (document.getElementById('aurenix-auth-modal')) return;

  const overlay = document.createElement('div');
  overlay.id = 'aurenix-auth-modal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'AURENIX Sign In');
  overlay.innerHTML = `
    <div class="auth-modal-backdrop"></div>
    <div class="auth-modal-box">
      <button class="auth-modal-close" id="auth-modal-close" aria-label="Close">✕</button>

      <div class="auth-modal-logo" aria-hidden="true">
        <svg viewBox="0 0 38 38" fill="none" width="38" height="38">
          <polygon points="19,2 36,34 2,34" fill="none" stroke="#b8860b" stroke-width="1.2"/>
          <circle cx="19" cy="22" r="7" fill="none" stroke="#00c9c0" stroke-width="1.2"/>
          <circle cx="19" cy="22" r="3" fill="#00c9c0" opacity="0.85"/>
        </svg>
      </div>

      <div class="auth-modal-title">AURENIX</div>

      <div class="auth-tabs" role="tablist">
        <button class="auth-tab active" id="auth-tab-login" role="tab" aria-selected="true">Sign In</button>
        <button class="auth-tab" id="auth-tab-register" role="tab" aria-selected="false">Register</button>
      </div>

      <!-- Login form -->
      <div id="auth-form-login" class="auth-form">
        <div class="field-group">
          <label class="field-label" for="auth-login-email">Email</label>
          <input class="field-input" type="email" id="auth-login-email" placeholder="your@email.com" autocomplete="email">
        </div>
        <div class="field-group">
          <label class="field-label" for="auth-login-pass">Password</label>
          <input class="field-input" type="password" id="auth-login-pass" placeholder="Password" autocomplete="current-password">
        </div>
        <div id="auth-login-error" class="auth-error" style="display:none;"></div>
        <button class="btn btn-gold" id="auth-login-btn" style="width:100%;">Sign In</button>
        <button class="auth-link-btn" id="auth-forgot-btn">Forgot password?</button>
      </div>

      <!-- Register form -->
      <div id="auth-form-register" class="auth-form" style="display:none;">
        <div class="field-group">
          <label class="field-label" for="auth-reg-email">Email</label>
          <input class="field-input" type="email" id="auth-reg-email" placeholder="your@email.com" autocomplete="email">
        </div>
        <div class="field-group">
          <label class="field-label" for="auth-reg-name">Display Name</label>
          <input class="field-input" type="text" id="auth-reg-name" placeholder="Your name" maxlength="50" autocomplete="name">
        </div>
        <div class="field-group">
          <label class="field-label" for="auth-reg-pass">Password</label>
          <input class="field-input" type="password" id="auth-reg-pass" placeholder="At least 8 characters" autocomplete="new-password">
        </div>
        <div id="auth-reg-error" class="auth-error" style="display:none;"></div>
        <button class="btn btn-gold" id="auth-reg-btn" style="width:100%;">Create Account</button>
      </div>

      <!-- Reset password form -->
      <div id="auth-form-reset" class="auth-form" style="display:none;">
        <div class="field-group">
          <label class="field-label" for="auth-reset-email">Email</label>
          <input class="field-input" type="email" id="auth-reset-email" placeholder="your@email.com">
        </div>
        <div id="auth-reset-status" class="auth-error" style="display:none;"></div>
        <button class="btn btn-gold" id="auth-reset-btn" style="width:100%;">Send Reset Link</button>
        <button class="auth-link-btn" id="auth-back-login-btn">← Back to Sign In</button>
      </div>

    </div>
  `;
  document.body.appendChild(overlay);
  bindModalEvents(overlay);
}

function bindModalEvents(overlay) {
  const tabLogin    = overlay.querySelector('#auth-tab-login');
  const tabReg      = overlay.querySelector('#auth-tab-register');
  const formLogin   = overlay.querySelector('#auth-form-login');
  const formReg     = overlay.querySelector('#auth-form-register');
  const formReset   = overlay.querySelector('#auth-form-reset');
  const backdrop    = overlay.querySelector('.auth-modal-backdrop');
  const closeBtn    = overlay.querySelector('#auth-modal-close');
  const forgotBtn   = overlay.querySelector('#auth-forgot-btn');
  const backLoginBtn= overlay.querySelector('#auth-back-login-btn');
  const loginBtn    = overlay.querySelector('#auth-login-btn');
  const regBtn      = overlay.querySelector('#auth-reg-btn');
  const resetBtn    = overlay.querySelector('#auth-reset-btn');

  function showForm(which) {
    formLogin.style.display  = which === 'login'    ? '' : 'none';
    formReg.style.display    = which === 'register' ? '' : 'none';
    formReset.style.display  = which === 'reset'    ? '' : 'none';
    tabLogin.classList.toggle('active', which === 'login');
    tabReg.classList.toggle('active',   which === 'register');
    tabLogin.setAttribute('aria-selected', which === 'login');
    tabReg.setAttribute('aria-selected',   which === 'register');
  }

  tabLogin.addEventListener('click', () => showForm('login'));
  tabReg.addEventListener('click',   () => showForm('register'));
  forgotBtn.addEventListener('click', () => showForm('reset'));
  backLoginBtn.addEventListener('click', () => showForm('login'));
  backdrop.addEventListener('click',  closeModal);
  closeBtn.addEventListener('click',  closeModal);

  /* ── Sign In ── */
  loginBtn.addEventListener('click', async () => {
    const email = overlay.querySelector('#auth-login-email').value.trim();
    const pass  = overlay.querySelector('#auth-login-pass').value;
    const errEl = overlay.querySelector('#auth-login-error');
    errEl.style.display = 'none';
    if (!email || !pass) { showErr(errEl, 'Email and password are required.'); return; }
    loginBtn.disabled = true; loginBtn.textContent = 'Signing in…';
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    loginBtn.disabled = false; loginBtn.textContent = 'Sign In';
    if (error) {
      const isNotConfigured = error.message?.includes('not configured');
      showErr(errEl, isNotConfigured
        ? 'Backend not connected yet — Supabase credentials missing in supabase-client.js'
        : 'Sign in failed. Check your email and password.');
      return;
    }
    closeModal();
  });

  /* ── Register ── */
  regBtn.addEventListener('click', async () => {
    const email = overlay.querySelector('#auth-reg-email').value.trim();
    const name  = overlay.querySelector('#auth-reg-name').value.trim();
    const pass  = overlay.querySelector('#auth-reg-pass').value;
    const errEl = overlay.querySelector('#auth-reg-error');
    errEl.style.display = 'none';
    if (!email || !pass) { showErr(errEl, 'Email and password are required.'); return; }
    if (pass.length < 8) { showErr(errEl, 'Password must be at least 8 characters.'); return; }
    regBtn.disabled = true; regBtn.textContent = 'Creating account…';
    const { data: signUpData, error } = await supabase.auth.signUp({
      email, password: pass,
      options: { data: { display_name: name || email.split('@')[0] } }
    });
    regBtn.disabled = false; regBtn.textContent = 'Create Account';
    if (error) {
      const isNotConfigured = error.message?.includes('not configured');
      const isRateLimit = error.message?.toLowerCase().includes('rate limit') ||
                          error.message?.toLowerCase().includes('email rate') ||
                          error.status === 429;
      showErr(errEl, isNotConfigured
        ? 'Backend not connected yet — Supabase credentials missing in supabase-client.js'
        : isRateLimit
        ? 'Too many sign-up attempts. Please wait a few minutes and try again, or contact the platform administrator.'
        : (error.message || 'Registration failed.'));
      return;
    }
    // If email confirmation is disabled, the user is immediately signed in
    if (signUpData?.user && !signUpData.user.identities?.length === 0) {
      closeModal();
      return;
    }
    showErr(errEl, '✓ Account created! Check your email to confirm before signing in.', true);
  });

  /* ── Password Reset ── */
  resetBtn.addEventListener('click', async () => {
    const email = overlay.querySelector('#auth-reset-email').value.trim();
    const statEl= overlay.querySelector('#auth-reset-status');
    statEl.style.display = 'none';
    if (!email) { showErr(statEl, 'Enter your email address.'); return; }
    resetBtn.disabled = true; resetBtn.textContent = 'Sending…';
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    resetBtn.disabled = false; resetBtn.textContent = 'Send Reset Link';
    if (error) {
      const isRateLimit = error.message?.toLowerCase().includes('rate limit') ||
                          error.message?.toLowerCase().includes('email rate') ||
                          error.status === 429;
      showErr(statEl, isRateLimit
        ? 'Too many requests. Please wait a few minutes before requesting another reset email.'
        : 'Could not send reset email. Please try again later.');
      return;
    }
    showErr(statEl, '✓ Reset link sent — check your email.', true);
  });

  /* Enter key support */
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

function showErr(el, msg, isSuccess = false) {
  el.style.display = 'block';
  el.style.background = isSuccess ? 'rgba(0,201,192,0.12)' : 'rgba(139,0,0,0.2)';
  el.style.border     = isSuccess ? '1px solid rgba(0,201,192,0.3)' : '1px solid rgba(139,0,0,0.4)';
  el.style.color      = isSuccess ? 'var(--energy)' : '#ff6680';
  el.textContent = msg;
}

/* ═══════════════════════════════════════════
   OPEN / CLOSE MODAL
═══════════════════════════════════════════ */
function openModal(tab = 'login') {
  buildModal();
  const modal = document.getElementById('aurenix-auth-modal');
  modal.classList.add('visible');
  document.body.style.overflow = 'hidden';
  if (tab === 'register') {
    modal.querySelector('#auth-tab-register').click();
  }
}

function closeModal() {
  const modal = document.getElementById('aurenix-auth-modal');
  if (modal) { modal.classList.remove('visible'); document.body.style.overflow = ''; }
}

/* ═══════════════════════════════════════════
   SIGN OUT
═══════════════════════════════════════════ */
async function signOut() {
  await supabase.auth.signOut();
}

/* ═══════════════════════════════════════════
   ACCESS DENIED HELPER
═══════════════════════════════════════════ */
function showAccessDenied(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="access-denied-block">
      <div class="adb-glyph" aria-hidden="true">𓂀</div>
      <div class="adb-title">ACCESS DENIED</div>
      <div class="adb-sub">You do not have permission to view this area.</div>
    </div>
  `;
}

/* ═══════════════════════════════════════════
   UTILS
═══════════════════════════════════════════ */
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════
   BIND NAV BUTTONS (called after DOM ready)
═══════════════════════════════════════════ */
function bindNavButtons() {
  const loginBtn  = document.getElementById('nav-login-btn');
  const pill      = document.getElementById('nav-user-pill');
  const signoutBtn = document.getElementById('nav-signout-btn');

  if (loginBtn)  loginBtn.addEventListener('click', () => openModal('login'));
  if (signoutBtn) signoutBtn.addEventListener('click', () => signOut());

  if (pill) {
    pill.addEventListener('click', () => {
      // Toggle user dropdown
      let drop = document.getElementById('nav-user-drop');
      if (drop) { drop.remove(); return; }
      drop = document.createElement('div');
      drop.id = 'nav-user-drop';
      drop.className = 'nav-user-drop';
      drop.innerHTML = `
        <button id="nav-mysubs-drop-btn" class="nav-drop-item">📤 My Submissions</button>
        <button id="nav-signout-drop-btn" class="nav-drop-item nav-drop-danger">⏻ Sign Out</button>
      `;
      document.body.appendChild(drop);

      // Position below pill
      const rect = pill.getBoundingClientRect();
      drop.style.top   = (rect.bottom + 8) + 'px';
      drop.style.right = (window.innerWidth - rect.right) + 'px';

      drop.querySelector('#nav-mysubs-drop-btn').addEventListener('click', () => {
        drop.remove();
        if (window.AURENIX_NAV) window.AURENIX_NAV.navigateTo('mysubs');
      });
      drop.querySelector('#nav-signout-drop-btn').addEventListener('click', () => {
        drop.remove();
        signOut();
      });

      // Close on outside click
      setTimeout(() => {
        document.addEventListener('click', function _outside(e) {
          if (!drop.contains(e.target) && e.target !== pill) {
            drop.remove(); document.removeEventListener('click', _outside);
          }
        });
      }, 50);
    });
  }
}

/* ═══════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════ */
window.AURENIX_AUTH = {
  openModal,
  closeModal,
  signOut,
  showAccessDenied,
  getUser:    () => _user,
  getProfile: () => _profile,
  isAdmin:    () => _isAdmin,
  isLoggedIn: () => !!_user,
};

/* Init on DOM ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindNavButtons);
} else {
  bindNavButtons();
}
