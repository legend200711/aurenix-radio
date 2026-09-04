/**
 * AURENIX RADIO — Admin Dashboard
 * aurenix-admin.js
 *
 * SECURITY:
 *  - All admin operations require Supabase session with email === ADMIN_EMAIL
 *    AND email_confirmed_at set (verified email).
 *  - Server-side RLS policies enforce this independently of JS.
 *  - This module verifies admin identity directly from Supabase auth on every
 *    sensitive operation — never trusts localStorage or URL params.
 *  - No service-role keys are present in this file.
 *
 * Scope: Radio Queue moderation + Copyright Reports only.
 */

import { supabase } from './supabase-client.js';

const ADMIN_EMAIL = 'christijerina46@gmail.com';

/* ═══════════════════════════════════════════
   AUTH LISTENER — show/hide admin page
═══════════════════════════════════════════ */
window.addEventListener('aurenix:authchange', (e) => {
  const { isAdmin } = e.detail;
  const adminPage = document.getElementById('page-admin');
  if (adminPage) {
    adminPage.style.display = isAdmin ? '' : 'none';
  }
});

/* ═══════════════════════════════════════════
   NAVIGATION LISTENER
═══════════════════════════════════════════ */
window.addEventListener('aurenix:navigate', (e) => {
  if (e.detail.page === 'admin') {
    mountAdmin();
  }
  if (e.detail.page === 'mysubs') {
    mountMySubsPage();
  }
});

/* ═══════════════════════════════════════════
   MY SUBMISSIONS PAGE (standalone page)
   Renders the user's own submissions with status.
═══════════════════════════════════════════ */
async function mountMySubsPage() {
  const container = document.getElementById('mysubs-page-content');
  if (!container) return;

  // Re-verify user from Supabase (not from memory)
  const { data: { user } } = await supabase.auth.getUser();

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
    const { data, error } = await supabase
      .from('studio_queue')
      .select('uid, title, artist, type, content_type, status, genre, notes, created_at, updated_at')
      .eq('submitted_by', user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

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

      row.innerHTML = `
        <div class="rqi-info" style="flex:1; min-width:0;">
          <div class="rqi-title">${esc(sub.title)}</div>
          <div class="rqi-meta">${esc(sub.artist || 'Unknown')}${sub.genre ? ' · ' + esc(sub.genre) : ''} · Submitted ${fmtDate(sub.created_at)}</div>
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
let _mounted = false;

async function mountAdmin() {
  const container = document.getElementById('admin-content');
  if (!container) return;

  // Re-verify directly from Supabase — never trust client-side state alone
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    renderAccessDenied(container);
    return;
  }

  if (!_mounted) {
    _mounted = true;
    renderAdminDashboard(container);
  }
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
  // Re-verify before fetching admin stats
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL) return;

  try {
    const [pendingRes, approvedRes, reportsRes, usersRes] = await Promise.all([
      supabase.from('studio_queue').select('uid', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('studio_queue').select('uid', { count: 'exact', head: true }).in('status', ['approved', 'playing']),
      supabase.from('copyright_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('users').select('id', { count: 'exact', head: true }),
    ]);
    setStat('admin-stat-pending',  pendingRes.count  ?? '—');
    setStat('admin-stat-approved', approvedRes.count ?? '—');
    setStat('admin-stat-reports',  reportsRes.count  ?? '—');
    setStat('admin-stat-users',    usersRes.count    ?? '—');
  } catch (_) {}
}

function setStat(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ═══════════════════════════════════════════
   RADIO MODERATION PANEL
═══════════════════════════════════════════ */
let _radioFilter = 'pending';

async function loadRadioPanel() {
  const panel = document.getElementById('admin-panel-radio');
  if (!panel) return;

  // Always re-verify admin before loading sensitive data
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    panel.innerHTML = '<div style="padding:20px; color:#ff6680;">ACCESS DENIED — administrator account required.</div>';
    return;
  }

  panel.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px;">Loading radio queue…</div>`;

  try {
    const { data, error } = await supabase
      .from('studio_queue')
      .select('uid, title, artist, album, genre, type, content_type, url, artwork_url, notes, status, play_count, likes, submitted_by, rights_confirmed, created_at, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    renderRadioPanel(panel, data || []);
  } catch (e) {
    panel.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load radio queue: ${esc(e.message || '')}</div>`;
  }
}

function renderRadioPanel(panel, items) {
  const counts = {
    pending:  items.filter(i => i.status === 'pending').length,
    approved: items.filter(i => i.status === 'approved' || i.status === 'playing').length,
    rejected: items.filter(i => i.status === 'rejected').length,
    removed:  items.filter(i => i.status === 'removed').length,
  };

  panel.innerHTML = `
    <div class="admin-radio-filter-bar" id="admin-radio-filters">
      <button class="admin-radio-filter-btn ${_radioFilter==='pending'  ? 'active':''}" data-filter="pending">
        Pending <span style="opacity:0.7;">(${counts.pending})</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='approved' ? 'active':''}" data-filter="approved">
        Approved <span style="opacity:0.7;">(${counts.approved})</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='rejected' ? 'active':''}" data-filter="rejected">
        Rejected <span style="opacity:0.7;">(${counts.rejected})</span>
      </button>
      <button class="admin-radio-filter-btn ${_radioFilter==='removed'  ? 'active':''}" data-filter="removed">
        Removed <span style="opacity:0.7;">(${counts.removed})</span>
      </button>
    </div>
    <div class="mech-panel mech-corner" id="admin-radio-list-panel">
      <div id="admin-radio-filtered-list"></div>
    </div>
  `;

  panel.querySelectorAll('.admin-radio-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _radioFilter = btn.dataset.filter;
      panel.querySelectorAll('.admin-radio-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      _renderRadioFilteredList(items, _radioFilter);
    });
  });

  _renderRadioFilteredList(items, _radioFilter);
}

function _renderRadioFilteredList(items, filter) {
  const list = document.getElementById('admin-radio-filtered-list');
  if (!list) return;

  let filtered;
  if (filter === 'approved') filtered = items.filter(i => i.status === 'approved' || i.status === 'playing');
  else                       filtered = items.filter(i => i.status === filter);

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:13px;">
      No ${filter} submissions.
    </div>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(item => list.appendChild(buildRadioModItem(item, filter)));
}

function buildRadioModItem(item, filter) {
  const div = document.createElement('div');
  div.className = 'admin-radio-item';
  div.style.flexWrap = 'wrap';

  const statusCls = {
    pending: 'rqi-pending', approved: 'rqi-approved',
    playing: 'rqi-playing', rejected: 'rqi-rejected', removed: 'rqi-rejected',
  }[item.status] || 'rqi-pending';

  const contentTypeCls   = item.content_type === 'aurenix_audio' ? 'rdi-badge-aurenix' : 'rdi-badge-external';
  const contentTypeLabel = item.content_type === 'aurenix_audio' ? 'AURENIX AUDIO' : 'EXTERNAL MEDIA';

  let rightsHtml = '';
  if (item.type === 'upload') {
    rightsHtml = item.rights_confirmed
      ? `<span class="admin-rights-confirmed" title="Submitter confirmed rights">✓ Rights confirmed</span>`
      : `<span class="admin-rights-missing"   title="No rights confirmation on record">⚠ No rights confirmation</span>`;
  }

  div.innerHTML = `
    <div class="admin-radio-item-info" style="flex:1; min-width:200px;">
      <div class="admin-radio-item-title">${esc(item.title)}</div>
      <div class="admin-radio-item-meta">
        ${esc(item.artist || 'Unknown')}
        ${item.album ? ' · <em>' + esc(item.album) + '</em>' : ''}
        ${item.genre ? ' · ' + esc(item.genre) : ''}
        · ${fmtDate(item.created_at)}
      </div>
      <div style="display:flex; gap:8px; margin-top:5px; flex-wrap:wrap; align-items:center;">
        <span class="rdi-source-badge ${contentTypeCls}" style="font-size:10px;">${contentTypeLabel}</span>
        ${rightsHtml}
      </div>
      ${item.notes ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px; font-style:italic;">
        Note: "${esc(item.notes)}"
      </div>` : ''}
      <div style="display:flex; gap:10px; margin-top:4px;">
        ${item.play_count ? `<span style="font-size:10px; color:var(--text-muted);">▶ ${item.play_count} plays</span>` : ''}
        ${item.likes      ? `<span style="font-size:10px; color:var(--text-muted);">♥ ${item.likes}</span>` : ''}
      </div>
    </div>
    <div class="admin-radio-item-actions" style="flex-wrap:wrap; gap:5px;">
      <span class="rqi-badge ${statusCls}">${item.status}</span>
      ${filter === 'pending' ? `
        <button class="btn-mod-approve" data-uid="${item.uid}" title="Approve — add to AURENIX Radio">✓ Approve</button>
        <button class="btn-mod-reject"  data-uid="${item.uid}" title="Reject this submission">✕ Reject</button>
      ` : ''}
      ${filter === 'approved' ? `
        <button class="btn-mod-takedown" data-uid="${item.uid}" title="Remove from public queue">⛔ Takedown</button>
      ` : ''}
      ${(filter === 'rejected' || filter === 'removed') ? `
        <button class="btn-mod-approve btn-mod-restore" data-uid="${item.uid}" title="Restore to approved">↩ Restore</button>
      ` : ''}
    </div>
  `;

  div.querySelectorAll('.btn-mod-approve').forEach(btn => {
    btn.addEventListener('click', () => {
      const isRestore = btn.classList.contains('btn-mod-restore');
      moderateRadio(btn.dataset.uid, isRestore ? 'restore' : 'approve');
    });
  });

  div.querySelectorAll('.btn-mod-reject').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Reject this submission? The submitter will see it as rejected.')) return;
      moderateRadio(btn.dataset.uid, 'reject');
    });
  });

  div.querySelectorAll('.btn-mod-takedown').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('TAKEDOWN: Immediately remove this track from the public AURENIX Radio catalog? It will be hidden from all queues and discovery. The moderation record is preserved.')) return;
      moderateRadio(btn.dataset.uid, 'remove');
    });
  });

  return div;
}

async function moderateRadio(uid, action) {
  // Always re-verify server-side before any mutation
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    alert('ACCESS DENIED — administrator account required.');
    return;
  }

  const statusMap = { approve: 'approved', reject: 'rejected', remove: 'removed', restore: 'approved' };
  const newStatus = statusMap[action];
  if (!newStatus) return;

  const { error } = await supabase.from('studio_queue')
    .update({ status: newStatus }).eq('uid', uid);

  if (error) {
    alert('Unable to update: ' + error.message);
    return;
  }
  loadRadioPanel();
  loadAdminData();
}

/* ═══════════════════════════════════════════
   COPYRIGHT REPORTS PANEL
═══════════════════════════════════════════ */
async function loadReportsPanel() {
  const panel = document.getElementById('admin-panel-reports');
  if (!panel) return;
  panel.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px;">Loading copyright reports…</div>`;

  // Always re-verify admin
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    panel.innerHTML = '<div style="padding:20px; color:#ff6680;">ACCESS DENIED — administrator account required.</div>';
    return;
  }

  try {
    const { data, error } = await supabase
      .from('copyright_reports')
      .select('id, track_uid, track_title, track_artist, reason, details, status, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

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

      row.innerHTML = `
        <div class="admin-radio-item-info" style="flex:1; min-width:200px;">
          <div class="admin-radio-item-title">${esc(report.track_title || '(untitled)')}</div>
          <div class="admin-radio-item-meta">
            ${esc(report.track_artist || '')}
            · ${reasonLabels[report.reason] || esc(report.reason)}
            · ${fmtDate(report.created_at)}
          </div>
          <div style="font-size:12px; color:var(--text); margin-top:5px; line-height:1.5;">
            ${esc(report.details)}
          </div>
          <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">
            Track UID: <code style="font-size:10px; opacity:0.7;">${esc(report.track_uid || '—')}</code>
          </div>
        </div>
        <div class="admin-radio-item-actions" style="flex-wrap:wrap; gap:5px; align-items:flex-start;">
          <span class="rqi-badge ${isOpen ? 'rqi-pending' : 'rqi-approved'}">${isOpen ? 'Open' : 'Resolved'}</span>
          ${isOpen ? `
            <button class="btn-report-takedown" data-track-uid="${esc(report.track_uid || '')}" data-report-id="${report.id}" title="Remove track and resolve report">⛔ Takedown Track</button>
            <button class="btn-report-resolve"  data-report-id="${report.id}" title="Mark as reviewed/resolved without removal">✓ Resolve</button>
          ` : ''}
        </div>
      `;

      row.querySelectorAll('.btn-report-takedown').forEach(btn => {
        btn.addEventListener('click', async () => {
          const trackUid = btn.dataset.trackUid;
          const reportId = btn.dataset.reportId;
          if (!confirm('TAKEDOWN: Remove the reported track from the public AURENIX Radio catalog and mark this report as resolved?')) return;
          btn.disabled = true; btn.textContent = 'Processing…';

          // Re-verify admin
          const { data: { user: u } } = await supabase.auth.getUser();
          if (!u || u.email !== ADMIN_EMAIL || !u.email_confirmed_at) {
            alert('ACCESS DENIED'); btn.disabled = false; btn.textContent = '⛔ Takedown Track'; return;
          }

          try {
            if (trackUid) {
              await supabase.from('studio_queue').update({ status: 'removed' }).eq('uid', trackUid);
            }
            await supabase.from('copyright_reports').update({ status: 'resolved_takedown' }).eq('id', reportId);
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

          // Re-verify admin
          const { data: { user: u } } = await supabase.auth.getUser();
          if (!u || u.email !== ADMIN_EMAIL || !u.email_confirmed_at) {
            alert('ACCESS DENIED'); btn.disabled = false; btn.textContent = '✓ Resolve'; return;
          }

          try {
            await supabase.from('copyright_reports').update({ status: 'resolved' }).eq('id', reportId);
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
