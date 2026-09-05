/**
 * AURENIX RADIO — Admin Dashboard (Firebase)
 * aurenix-admin.js
 *
 * SECURITY:
 *  - All admin operations require a Firebase session with
 *    email === ADMIN_EMAIL AND emailVerified === true.
 *  - Firestore Security Rules enforce this independently of JS.
 *  - This module re-verifies admin identity from Firebase Auth on every
 *    sensitive operation — never trusts localStorage or URL params.
 *  - No Firebase service-account/private keys are present in this file.
 *
 * Scope: Radio Queue moderation + Copyright Reports only.
 */

import {
  auth,
  db,
  updateSubmission,
  getAllReports,
  updateReport,
  getUserSubmissions,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
} from './firebase-client.js';

const ADMIN_EMAIL = 'christijerina46@gmail.com';

/* ═══════════════════════════════════════════
   AUTH LISTENER — show/hide admin page
═══════════════════════════════════════════ */
window.addEventListener('aurenix:authchange', (e) => {
  const { isAdmin } = e.detail;
  const adminPage = document.getElementById('page-admin');

  /* Capture whether the admin page is currently the active page BEFORE
     we hide it below — we need this to decide whether to remount. */
  const adminPageActive = adminPage && adminPage.classList.contains('active');

  if (adminPage) {
    adminPage.style.display = isAdmin ? '' : 'none';
  }

  /* If auth just resolved and the admin page is currently active,
     remount the content now — this handles the race condition where
     Firebase Auth resolves AFTER the navigation event fires on page load.
     Without this, the admin sees ACCESS DENIED or "Verifying…" permanently
     until they navigate away and back. */
  const container = document.getElementById('admin-content');
  if (container && adminPageActive) {
    if (isAdmin) {
      renderAdminDashboard(container);
      loadAdminData();
    } else {
      /* Auth resolved but not admin — replace any loading state.
         Delegate to mountAdmin() which has full diagnostic logic
         (e.g., email-verified check with helpful error message). */
      mountAdmin();
    }
  }
});

/* ═══════════════════════════════════════════
   NAVIGATION LISTENER
═══════════════════════════════════════════ */
window.addEventListener('aurenix:navigate', (e) => {
  if (e.detail.page === 'admin') {
    mountAdmin();
  } else {
    /* Navigated away — detach the live radio listener to avoid
       orphaned Firestore subscriptions. */
    _detachRadioListener();
  }
  if (e.detail.page === 'mysubs') {
    mountMySubsPage();
  }
});

/* ═══════════════════════════════════════════
   ADMIN IDENTITY CHECK
   Re-verified from Firebase Auth on every sensitive call.
   Uses auth.currentUser from Firebase — NEVER localStorage or username.
   The ADMIN_EMAIL constant (christijerina46@gmail.com) must match AND
   emailVerified must be true (prevents unverified account spoofing).
═══════════════════════════════════════════ */
function _verifyAdmin() {
  const user = auth.currentUser;
  return !!(
    user &&
    user.email === ADMIN_EMAIL &&
    user.emailVerified
  );
}

/* ═══════════════════════════════════════════
   MY SUBMISSIONS PAGE (standalone page)
═══════════════════════════════════════════ */
async function mountMySubsPage() {
  const container = document.getElementById('mysubs-page-content');
  if (!container) return;

  const user = auth.currentUser;

  if (!user) {
    container.innerHTML = `
      <div style="padding:60px 24px; text-align:center; color:var(--text-muted);">
        <div style="font-size:48px; margin-bottom:16px;">📻</div>
        <div style="font-size:16px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">Sign in to view your submissions</div>
        <div style="font-size:13px; margin-bottom:20px;">Create an AURENIX account or sign in to submit music and track its status.</div>
        <button class="btn btn-gold" onclick="window.AURENIX_AUTH?.openModal('login')">Sign In</button>
      </div>`;
    return;
  }

  container.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px; letter-spacing:1px;">Loading your submissions…</div>`;

  try {
    const data = await getUserSubmissions(user.uid);

    if (!data?.length) {
      container.innerHTML = `
        <div class="mech-panel mech-corner" style="max-width:600px; margin:40px auto; padding:40px 24px; text-align:center; color:var(--text-muted);">
          <div style="font-size:48px; margin-bottom:16px;">📭</div>
          <div style="font-size:16px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">No submissions yet</div>
          <div style="font-size:13px; margin-bottom:20px;">Go to the Radio player to submit your music. All submissions start as Pending until reviewed by the administrator.</div>
          <button class="btn btn-gold" onclick="window.AURENIX_NAV?.navigateTo('radio')">◉ Go to Radio</button>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="mech-panel mech-corner" style="max-width:860px; margin:0 auto;">
        <div class="mech-panel-title">
          <span class="mech-panel-title-dot"></span>
          My Submissions
          <span style="margin-left:auto; font-size:11px; color:var(--text-muted);">${data.length} total</span>
        </div>
        <div id="mysubs-list-inner"></div>
      </div>
      <div style="max-width:860px; margin:16px auto 0; padding:12px 14px; background:rgba(184,134,11,0.04); border:1px solid rgba(184,134,11,0.12); border-radius:var(--radius); font-size:11px; color:var(--text-muted); line-height:1.7;">
        Submissions are reviewed by the AURENIX administrator. You cannot change submission status.
        Only approved submissions appear publicly in the radio queue.
      </div>`;

    const list = document.getElementById('mysubs-list-inner');
    data.forEach(sub => {
      const row = document.createElement('div');
      row.className = 'radio-queue-item';
      row.style.padding = '14px 16px';

      const statusCfg = {
        pending:  { cls: 'rqi-pending',  label: '⏳ Pending Review' },
        approved: { cls: 'rqi-approved', label: '✓ Approved' },
        playing:  { cls: 'rqi-playing',  label: '▶ Playing Now' },
        rejected: { cls: 'rqi-rejected', label: '✕ Rejected' },
        removed:  { cls: 'rqi-rejected', label: '⛔ Removed' },
      };
      const sc = statusCfg[sub.status] || { cls: 'rqi-pending', label: sub.status };
      const isExternal = sub.type !== 'upload';
      const typeLabel  = isExternal
        ? ({ youtube: 'YouTube', spotify: 'Spotify', external: 'External' }[sub.type] || 'External')
        : 'AURENIX AUDIO';
      const typeCls = isExternal ? 'rdi-badge-external' : 'rdi-badge-aurenix';
      const dateStr = fmtDate(sub.created_at?.toDate ? sub.created_at.toDate().toISOString() : sub.created_at);

      row.innerHTML = `
        <div class="rqi-info" style="flex:1; min-width:0;">
          <div class="rqi-title">${esc(sub.title)}</div>
          <div class="rqi-meta">${esc(sub.artist || 'Unknown')}${sub.genre ? ' · ' + esc(sub.genre) : ''} · Submitted ${dateStr}</div>
          ${sub.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:3px; font-style:italic;">"${esc(sub.notes)}"</div>` : ''}
        </div>
        <div class="rqi-right" style="gap:6px; flex-shrink:0;">
          <span class="rdi-source-badge ${typeCls}">${typeLabel}</span>
          <span class="rqi-badge ${sc.cls}">${sc.label}</span>
        </div>
      `;
      list.appendChild(row);
    });

  } catch (_) {
    container.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load submissions. Please try again.</div>`;
  }
}

/* ═══════════════════════════════════════════
   ADMIN MOUNT
═══════════════════════════════════════════ */
async function mountAdmin() {
  const container = document.getElementById('admin-content');
  if (!container) return;

  /* auth.currentUser is null in two different situations:
       a) Firebase Auth has not resolved yet (page just loaded — race condition)
       b) No user is logged in at all
     We must NOT render ACCESS DENIED for case (a) — if we do, the admin will
     see a denied page even after logging in with christijerina46@gmail.com.
     Instead, show a loading indicator; the aurenix:authchange listener will
     call renderAdminDashboard() once auth resolves to admin. */
  if (auth.currentUser === null) {
    container.innerHTML = `
      <div style="padding:60px 24px; text-align:center; color:var(--text-muted); font-size:13px; letter-spacing:1px;">
        Verifying administrator credentials…
      </div>`;
    return;
  }

  // Auth has resolved — now check identity from Firebase Auth object.
  // Uses user.email (from Firebase JWT) and user.emailVerified.
  // NEVER uses localStorage, username, or URL params.
  const user = auth.currentUser;
  if (!_verifyAdmin()) {
    /* Provide a clear diagnostic if the correct email is signed in but
       email verification has not been completed — this is the most common
       reason a valid admin account is blocked. */
    if (user && user.email === ADMIN_EMAIL && !user.emailVerified) {
      container.innerHTML = `
        <div class="access-denied-block">
          <div class="adb-glyph">⚠</div>
          <div class="adb-title">EMAIL NOT VERIFIED</div>
          <div class="adb-sub">
            You are signed in as <strong>${user.email}</strong> but your email address
            has not been verified with Firebase.<br><br>
            Check your inbox for a verification email, or go to the
            <a href="https://console.firebase.google.com/project/remix-studio-4bf8a/authentication/users"
               target="_blank" rel="noopener"
               style="color:var(--gold);">Firebase Console</a>
            and manually verify the account.
          </div>
        </div>`;
      return;
    }
    renderAccessDenied(container);
    _detachRadioListener();
    return;
  }

  /* Always rebuild the dashboard shell so that the listener is re-attached
     fresh each time the admin navigates to this page. */
  renderAdminDashboard(container);
  loadAdminData();
}

/* ═══════════════════════════════════════════
   ACCESS DENIED
═══════════════════════════════════════════ */
function renderAccessDenied(container) {
  container.innerHTML = `
    <div class="access-denied-block">
      <div class="adb-glyph">𓂀</div>
      <div class="adb-title">ACCESS DENIED</div>
      <div class="adb-sub">This area is restricted. Only the AURENIX administrator may access it.</div>
    </div>
  `;
}

/* ═══════════════════════════════════════════
   RENDER ADMIN DASHBOARD
═══════════════════════════════════════════ */
function renderAdminDashboard(container) {
  container.innerHTML = `
    <!-- Stats row -->
    <div class="admin-stats-row" id="admin-stats-row">
      <div class="admin-stat-card">
        <div class="admin-stat-val" id="admin-stat-pending">—</div>
        <div class="admin-stat-label">Pending Submissions</div>
      </div>
      <div class="admin-stat-card">
        <div class="admin-stat-val" id="admin-stat-approved">—</div>
        <div class="admin-stat-label">Approved Tracks</div>
      </div>
      <div class="admin-stat-card">
        <div class="admin-stat-val" id="admin-stat-reports">—</div>
        <div class="admin-stat-label">Open Reports</div>
      </div>
      <div class="admin-stat-card">
        <div class="admin-stat-val" id="admin-stat-users">—</div>
        <div class="admin-stat-label">Total Users</div>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="admin-tabs">
      <button class="admin-tab active" data-atab="radio">📻 Radio Queue</button>
      <button class="admin-tab" data-atab="reports">⚑ Copyright Reports</button>
      <button class="admin-tab" data-atab="crow">🐦 Crow Settings</button>
    </div>

    <!-- Tab panels -->
    <div id="admin-panel-radio"   class="admin-panel active"></div>
    <div id="admin-panel-reports" class="admin-panel" style="display:none;"></div>
    <div id="admin-panel-crow"    class="admin-panel" style="display:none;"></div>
  `;

  bindAdminTabs(container);
  renderCrowPanel();
}

/* ═══════════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════════ */
function bindAdminTabs(container) {
  container.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.atab;
      container.querySelectorAll('.admin-panel').forEach(p => {
        p.style.display = 'none'; p.classList.remove('active');
      });
      const panel = document.getElementById('admin-panel-' + tab);
      if (panel) { panel.style.display = ''; panel.classList.add('active'); }
      if (tab === 'radio')   loadRadioPanel();
      if (tab === 'reports') loadReportsPanel();
    });
  });
  // Initial load
  loadRadioPanel();
}

/* ═══════════════════════════════════════════
   STATS
═══════════════════════════════════════════ */
async function loadAdminData() {
  if (!_verifyAdmin()) return;

  try {
    const [pendingSnap, approvedSnap, reportsSnap, usersSnap] = await Promise.all([
      getDocs(query(collection(db, 'radio_submissions'), where('status', '==', 'pending'))),
      getDocs(query(collection(db, 'radio_submissions'), where('status', 'in', ['approved', 'playing']))),
      getDocs(query(collection(db, 'radio_reports'),     where('status', '==', 'open'))),
      getDocs(collection(db, 'users')),
    ]);
    setStat('admin-stat-pending',  pendingSnap.size  ?? '—');
    setStat('admin-stat-approved', approvedSnap.size ?? '—');
    setStat('admin-stat-reports',  reportsSnap.size  ?? '—');
    setStat('admin-stat-users',    usersSnap.size    ?? '—');
  } catch (_) {}
}

function setStat(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ═══════════════════════════════════════════
   RADIO MODERATION PANEL
   Uses a real-time onSnapshot listener so the panel updates
   immediately when any submission status changes.
═══════════════════════════════════════════ */
let _radioFilter    = 'pending';
let _radioUnsub     = null;   // active onSnapshot unsubscribe fn
let _allSubmissions = [];     // cached snapshot for the current listener

function loadRadioPanel() {
  const panel = document.getElementById('admin-panel-radio');
  if (!panel) return;

  if (!_verifyAdmin()) {
    panel.innerHTML = '<div style="padding:20px; color:#ff6680;">ACCESS DENIED — administrator account required.</div>';
    _detachRadioListener();
    return;
  }

  /* Build the chrome (filter bar + list container) once; the listener
     keeps the list content fresh without rebuilding the whole panel. */
  panel.innerHTML = `
    <div class="admin-radio-filter-bar" id="admin-radio-filters" style="margin-bottom:0;">
      <button class="admin-radio-filter-btn ${_radioFilter==='pending'  ? 'active':''}" data-filter="pending">
        Pending <span class="admin-filter-count" id="afc-pending">—</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='approved' ? 'active':''}" data-filter="approved">
        Approved <span class="admin-filter-count" id="afc-approved">—</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='rejected' ? 'active':''}" data-filter="rejected">
        Rejected <span class="admin-filter-count" id="afc-rejected">—</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='removed'  ? 'active':''}" data-filter="removed">
        Removed <span class="admin-filter-count" id="afc-removed">—</span>
      </button>
    </div>
    <div class="mech-panel mech-corner" id="admin-radio-list-panel" style="margin-top:0; border-top:none; border-radius:0 0 var(--radius) var(--radius);">
      <div id="admin-radio-filtered-list">
        <div style="padding:20px; color:var(--text-muted); font-size:13px;">Loading submissions…</div>
      </div>
    </div>
  `;

  panel.querySelectorAll('.admin-radio-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _radioFilter = btn.dataset.filter;
      panel.querySelectorAll('.admin-radio-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      _renderRadioFilteredList(_allSubmissions, _radioFilter);
    });
  });

  _attachRadioListener();
}

function _detachRadioListener() {
  if (_radioUnsub) { try { _radioUnsub(); } catch(_) {} _radioUnsub = null; }
  _allSubmissions = [];
}

function _attachRadioListener() {
  _detachRadioListener();

  /* Query all radio_submissions ordered by creation date.
     The Firestore 'list' rule grants admin unrestricted access. */
  const q = query(
    collection(db, 'radio_submissions'),
    orderBy('created_at', 'desc'),
  );

  _radioUnsub = onSnapshot(q,
    snap => {
      _allSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _updateFilterCounts(_allSubmissions);
      _renderRadioFilteredList(_allSubmissions, _radioFilter);
      /* Also refresh the stats bar at the top */
      _updateStatBars(_allSubmissions);
    },
    err => {
      console.error('[Admin] Radio snapshot error:', err.code, err.message);
      const list = document.getElementById('admin-radio-filtered-list');
      if (list) {
        list.innerHTML = `<div style="padding:20px; color:#ff6680;">
          Unable to load submissions: ${esc(err.message)}
          ${err.code === 'permission-denied'
            ? '<br><small>Check that the Firestore rules are deployed. Run: firebase deploy --only firestore:rules</small>'
            : ''}
        </div>`;
      }
    },
  );
}

function _updateFilterCounts(items) {
  const counts = {
    pending:  items.filter(i => i.status === 'pending').length,
    approved: items.filter(i => i.status === 'approved' || i.status === 'playing').length,
    rejected: items.filter(i => i.status === 'rejected').length,
    removed:  items.filter(i => i.status === 'removed').length,
  };
  for (const [k, v] of Object.entries(counts)) {
    const el = document.getElementById('afc-' + k);
    if (el) el.textContent = '(' + v + ')';
  }
}

function _updateStatBars(items) {
  setStat('admin-stat-pending',
    items.filter(i => i.status === 'pending').length ?? '—');
  setStat('admin-stat-approved',
    items.filter(i => i.status === 'approved' || i.status === 'playing').length ?? '—');
}

function _renderRadioFilteredList(items, filter) {
  const list = document.getElementById('admin-radio-filtered-list');
  if (!list) return;

  let filtered;
  if (filter === 'approved') filtered = items.filter(i => i.status === 'approved' || i.status === 'playing');
  else                       filtered = items.filter(i => i.status === filter);

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">
      No ${filter} submissions.
    </div>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(item => list.appendChild(_buildModItem(item, filter)));
}

function _buildModItem(item, filter) {
  const div = document.createElement('div');
  div.className = 'admin-radio-item';
  div.setAttribute('data-sub-id', item.id);

  const statusCls = {
    pending:  'rqi-pending',
    approved: 'rqi-approved',
    playing:  'rqi-playing',
    rejected: 'rqi-rejected',
    removed:  'rqi-rejected',
  }[item.status] || 'rqi-pending';

  const isAudio        = item.content_type === 'aurenix_audio';
  const contentTypeCls = isAudio ? 'rdi-badge-aurenix' : 'rdi-badge-external';
  const contentTypeLbl = isAudio ? 'AURENIX AUDIO'     : 'EXTERNAL MEDIA';

  const rightsHtml = isAudio
    ? (item.rights_confirmed
        ? `<span class="admin-rights-confirmed">✓ Rights confirmed</span>`
        : `<span class="admin-rights-missing">⚠ No rights confirmation</span>`)
    : '';

  const storageHtml = item.storage_path
    ? `<div style="font-size:10px; color:var(--text-muted); margin-top:3px;">
         📦 Storage: <code style="font-size:10px; opacity:0.7;">${esc(item.storage_path)}</code>
       </div>`
    : (item.url
        ? `<div style="font-size:10px; color:var(--text-muted); margin-top:3px;">
             🔗 URL: <code style="font-size:10px; opacity:0.7;">${esc(item.url.slice(0,60))}…</code>
           </div>`
        : '');

  const rejectionHtml = (item.rejection_reason && filter !== 'pending')
    ? `<div style="font-size:11px; color:#ff6680; margin-top:4px;">
         ✕ Rejection reason: ${esc(item.rejection_reason)}
       </div>`
    : '';

  const reviewedHtml = item.reviewed_by
    ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">
         Reviewed by ${esc(item.reviewed_by)} on ${fmtDate(item.reviewed_at)}
       </div>`
    : '';

  const submitterHtml = item.submitted_by
    ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">
         Submitted by UID: <code style="font-size:10px; opacity:0.7;">${esc(item.submitted_by)}</code>
       </div>`
    : '';

  const dateStr = fmtDate(item.created_at?.toDate
    ? item.created_at.toDate().toISOString()
    : item.created_at);

  /* ── Action buttons depend on current filter ──
     pending  → Approve + Reject + Remove
     approved → Takedown (→ removed)
     rejected → Restore (→ approved) + Remove
     removed  → Restore (→ approved)
  ── */
  const actionsHtml = (() => {
    if (filter === 'pending') return `
      <button class="btn-mod-approve"  data-action="approve"  data-id="${item.id}">✓ Approve</button>
      <button class="btn-mod-reject"   data-action="reject"   data-id="${item.id}">✕ Reject</button>
      <button class="btn-mod-takedown" data-action="remove"   data-id="${item.id}">⛔ Remove</button>
    `;
    if (filter === 'approved') return `
      <button class="btn-mod-takedown" data-action="remove"   data-id="${item.id}">⛔ Takedown</button>
    `;
    if (filter === 'rejected') return `
      <button class="btn-mod-approve"  data-action="restore"  data-id="${item.id}">↩ Restore</button>
      <button class="btn-mod-takedown" data-action="remove"   data-id="${item.id}">⛔ Remove</button>
    `;
    if (filter === 'removed') return `
      <button class="btn-mod-approve"  data-action="restore"  data-id="${item.id}">↩ Restore</button>
    `;
    return '';
  })();

  div.innerHTML = `
    <div class="admin-radio-item-info" style="flex:1; min-width:200px;">
      <div class="admin-radio-item-title">${esc(item.title || '(no title)')}</div>
      <div class="admin-radio-item-meta">
        ${esc(item.artist || 'Unknown artist')}
        ${item.album  ? ' · <em>' + esc(item.album)  + '</em>' : ''}
        ${item.genre  ? ' · '     + esc(item.genre)            : ''}
        · ${dateStr}
      </div>
      ${item.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px; font-style:italic;">"${esc(item.notes)}"</div>` : ''}
      <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap; align-items:center;">
        <span class="rdi-source-badge ${contentTypeCls}" style="font-size:10px;">${contentTypeLbl}</span>
        ${rightsHtml}
      </div>
      ${storageHtml}
      ${rejectionHtml}
      ${reviewedHtml}
      ${submitterHtml}
    </div>
    <div class="admin-radio-item-actions" style="flex-direction:column; align-items:stretch; gap:6px; min-width:130px;">
      <span class="rqi-badge ${statusCls}" style="text-align:center;">${esc(item.status)}</span>
      ${actionsHtml}
    </div>
  `;

  /* Bind action buttons */
  div.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => _handleModAction(btn.dataset.action, btn.dataset.id, btn));
  });

  return div;
}

async function _handleModAction(action, submissionId, btn) {
  if (!_verifyAdmin()) {
    alert('ACCESS DENIED — administrator account required.');
    return;
  }

  let confirmMsg  = '';
  let rejReason   = null;

  switch (action) {
    case 'approve':
      confirmMsg = 'Approve this submission? It will become eligible for AURENIX Radio.';
      break;
    case 'reject': {
      const reason = window.prompt(
        'Reject this submission?\n\nOptional: enter a rejection reason for the submitter.\n(Leave blank to reject without a reason.)',
        '',
      );
      if (reason === null) return;   // user hit Cancel
      rejReason  = reason.trim() || null;
      confirmMsg = null;             // prompt already served as confirmation
      break;
    }
    case 'restore':
      confirmMsg = 'Restore this submission to Approved?';
      break;
    case 'remove':
      confirmMsg = 'REMOVE: Hide this track from public Radio permanently?\nThe audio file in Supabase Storage is NOT deleted.';
      break;
    default:
      return;
  }

  if (confirmMsg && !confirm(confirmMsg)) return;

  /* Disable the button while the write is in flight */
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  const statusMap = { approve: 'approved', reject: 'rejected', remove: 'removed', restore: 'approved' };
  const newStatus = statusMap[action];

  const updates = {
    status:      newStatus,
    reviewed_by: auth.currentUser.email,
    reviewed_at: new Date().toISOString(),
  };
  if (rejReason !== null) updates.rejection_reason = rejReason;

  try {
    await updateSubmission(submissionId, updates);
    /* onSnapshot fires immediately — no manual reload needed */
    loadAdminData();
  } catch (err) {
    console.error('[Admin] moderateRadio error:', err);
    alert('Update failed: ' + (err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = _actionLabel(action); }
  }
}

function _actionLabel(action) {
  return { approve: '✓ Approve', reject: '✕ Reject', remove: '⛔ Remove', restore: '↩ Restore' }[action] || action;
}

/* ═══════════════════════════════════════════
   COPYRIGHT REPORTS PANEL
═══════════════════════════════════════════ */
async function loadReportsPanel() {
  const panel = document.getElementById('admin-panel-reports');
  if (!panel) return;
  panel.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px;">Loading copyright reports…</div>`;

  if (!_verifyAdmin()) {
    panel.innerHTML = '<div style="padding:20px; color:#ff6680;">ACCESS DENIED — administrator account required.</div>';
    return;
  }

  try {
    const data = await getAllReports();

    if (!data || !data.length) {
      panel.innerHTML = `
        <div class="mech-panel mech-corner" style="padding:30px; text-align:center; color:var(--text-muted);">
          <div style="font-size:30px; margin-bottom:10px;">✓</div>
          <div style="font-size:14px; font-weight:700;">No copyright reports</div>
          <div style="font-size:12px; margin-top:6px;">No reports have been submitted yet.</div>
        </div>`;
      return;
    }

    const open     = data.filter(r => r.status === 'open').length;
    const resolved = data.filter(r => r.status !== 'open').length;

    panel.innerHTML = `
      <div class="admin-reports-header">
        <div style="font-size:13px; font-weight:700; letter-spacing:1px; color:#ff6680;">⚑ COPYRIGHT &amp; CONTENT REPORTS</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">
          ${open} open · ${resolved} resolved
          <span style="font-size:10px; margin-left:8px; opacity:0.7;">Reporter contact information is not shown publicly.</span>
        </div>
      </div>
      <div id="admin-reports-list"></div>
    `;

    const list = document.getElementById('admin-reports-list');
    const reasonLabels = {
      copyright:       'Copyright violation',
      no_permission:   'Uploaded without rights/permission',
      rules_violation: 'Violates AURENIX rules',
      removal_request: 'Removal request',
      other:           'Other',
    };

    data.forEach(report => {
      const row = document.createElement('div');
      row.className = 'admin-radio-item admin-report-item';
      const isOpen = report.status === 'open';
      const dateStr = fmtDate(report.created_at?.toDate ? report.created_at.toDate().toISOString() : report.created_at);

      row.innerHTML = `
        <div class="admin-radio-item-info" style="flex:1; min-width:200px;">
          <div class="admin-radio-item-title">${esc(report.track_title || '(untitled)')}</div>
          <div class="admin-radio-item-meta">
            ${esc(report.track_artist || '')}
            · ${reasonLabels[report.reason] || esc(report.reason)}
            · ${dateStr}
          </div>
          <div style="font-size:12px; color:var(--text); margin-top:5px; line-height:1.5;">
            ${esc(report.details)}
          </div>
          <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">
            Submission ID: <code style="font-size:10px; opacity:0.7;">${esc(report.submission_id || '—')}</code>
          </div>
        </div>
        <div class="admin-radio-item-actions" style="flex-wrap:wrap; gap:5px; align-items:flex-start;">
          <span class="rqi-badge ${isOpen ? 'rqi-pending' : 'rqi-approved'}">${isOpen ? 'Open' : 'Resolved'}</span>
          ${isOpen ? `
            <button class="btn-report-takedown" data-submission-id="${esc(report.submission_id || '')}" data-report-id="${esc(report.id)}" title="Remove track and resolve report">⛔ Takedown Track</button>
            <button class="btn-report-resolve"  data-report-id="${esc(report.id)}" title="Mark as reviewed/resolved without removal">✓ Resolve</button>
          ` : ''}
        </div>
      `;

      row.querySelectorAll('.btn-report-takedown').forEach(btn => {
        btn.addEventListener('click', async () => {
          const subId    = btn.dataset.submissionId;
          const reportId = btn.dataset.reportId;
          if (!confirm('TAKEDOWN: Remove the reported track from the public AURENIX Radio catalog and mark this report as resolved?')) return;
          btn.disabled = true; btn.textContent = 'Processing…';

          if (!_verifyAdmin()) {
            alert('ACCESS DENIED'); btn.disabled = false; btn.textContent = '⛔ Takedown Track'; return;
          }

          try {
            if (subId) {
              await updateSubmission(subId, { status: 'removed' });
            }
            await updateReport(reportId, { status: 'resolved_takedown' });
            loadReportsPanel();
            loadAdminData();
          } catch (_) {
            btn.disabled = false; btn.textContent = '⛔ Takedown Track';
            alert('Unable to complete takedown. Please try again.');
          }
        });
      });

      row.querySelectorAll('.btn-report-resolve').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reportId = btn.dataset.reportId;
          if (!confirm('Mark this report as resolved without removing the track?')) return;
          btn.disabled = true; btn.textContent = 'Resolving…';

          if (!_verifyAdmin()) {
            alert('ACCESS DENIED'); btn.disabled = false; btn.textContent = '✓ Resolve'; return;
          }

          try {
            await updateReport(reportId, { status: 'resolved' });
            loadReportsPanel();
            loadAdminData();
          } catch (_) {
            btn.disabled = false; btn.textContent = '✓ Resolve';
            alert('Unable to resolve. Please try again.');
          }
        });
      });

      list.appendChild(row);
    });
  } catch (_) {
    panel.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load reports.</div>`;
  }
}

/* ═══════════════════════════════════════════
   CROW SETTINGS PANEL
═══════════════════════════════════════════ */
function renderCrowPanel() {
  const panel = document.getElementById('admin-panel-crow');
  if (!panel) return;

  panel.innerHTML = `
    <div class="mech-panel mech-corner" style="padding:24px; max-width:600px;">
      <div style="font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--gold-bright); margin-bottom:20px;">
        🐦 Flying Crow — Live Controls
      </div>

      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; padding:12px; background:var(--stone-deep); border-radius:var(--radius);">
        <span style="font-size:13px; color:var(--text);">Crow System Enabled</span>
        <label class="admin-toggle">
          <input type="checkbox" id="crow-admin-enabled" checked>
          <span class="admin-toggle-slider"></span>
        </label>
      </div>

      <div class="field-group">
        <label class="field-label">Min Interval (minutes)</label>
        <input class="field-input" type="number" id="crow-admin-min" value="4" min="1" max="60">
      </div>
      <div class="field-group">
        <label class="field-label">Max Interval (minutes)</label>
        <input class="field-input" type="number" id="crow-admin-max" value="8" min="1" max="120">
      </div>
      <div class="field-group">
        <label class="field-label">Flight Duration (seconds)</label>
        <input class="field-input" type="number" id="crow-admin-flight" value="3.8" min="1" max="15" step="0.1">
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; padding:12px; background:var(--stone-deep); border-radius:var(--radius);">
        <span style="font-size:13px; color:var(--text);">Show Transmission Message</span>
        <label class="admin-toggle">
          <input type="checkbox" id="crow-admin-tx" checked>
          <span class="admin-toggle-slider"></span>
        </label>
      </div>

      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;">
        <button class="btn btn-gold" id="crow-admin-apply">Apply Settings</button>
        <button class="btn btn-energy" id="crow-admin-force">Force Crow Now</button>
        <button class="btn btn-ghost" id="crow-admin-disable">Disable Crow</button>
      </div>

      <div id="crow-admin-status" style="display:none; margin-top:12px; padding:10px; border-radius:var(--radius); font-size:13px;"></div>
    </div>
  `;

  document.getElementById('crow-admin-enabled').addEventListener('change', (e) => {
    if (window.aurenixCrow) {
      if (e.target.checked) window.aurenixCrow.enable();
      else window.aurenixCrow.disable();
    }
  });

  document.getElementById('crow-admin-apply').addEventListener('click', () => {
    if (!window.aurenixCrow) { showCrowStatus('Crow system not loaded.', false); return; }
    const min    = parseFloat(document.getElementById('crow-admin-min').value) * 60000;
    const max    = parseFloat(document.getElementById('crow-admin-max').value) * 60000;
    const flight = parseFloat(document.getElementById('crow-admin-flight').value) * 1000;
    const tx     = document.getElementById('crow-admin-tx').checked;
    window.aurenixCrow.setConfig({ minIntervalMs: min, maxIntervalMs: max, flightDurationMs: flight, showTransmission: tx });
    showCrowStatus('Settings applied.', true);
  });

  document.getElementById('crow-admin-force').addEventListener('click', () => {
    if (!window.aurenixCrow) { showCrowStatus('Crow system not loaded.', false); return; }
    window.aurenixCrow.launch();
    showCrowStatus('Crow launched!', true);
  });

  document.getElementById('crow-admin-disable').addEventListener('click', () => {
    if (window.aurenixCrow) window.aurenixCrow.disable();
    document.getElementById('crow-admin-enabled').checked = false;
    showCrowStatus('Crow disabled.', true);
  });
}

function showCrowStatus(msg, ok) {
  const el = document.getElementById('crow-admin-status');
  if (!el) return;
  el.style.display  = 'block';
  el.style.background = ok ? 'rgba(0,201,192,0.1)' : 'rgba(139,0,0,0.2)';
  el.style.color      = ok ? 'var(--energy)' : '#ff6680';
  el.style.border     = ok ? '1px solid rgba(0,201,192,0.3)' : '1px solid rgba(139,0,0,0.3)';
  el.textContent = msg;
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

/* ═══════════════════════════════════════════
   UTILS
═══════════════════════════════════════════ */
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(); } catch(_) { return '—'; }
}
