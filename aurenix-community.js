/**
 * AURENIX — Community Section
 * aurenix-community.js
 *
 * Real backend-connected community:
 *  - User profiles
 *  - Posts feed
 *  - Likes/reactions
 *  - Comments
 *  - Follow/unfollow
 *  - Notifications
 */

import { supabase, loadUserProfile, upsertUserProfile } from './supabase-client.js';

/* ── Column name map for this project's schema ── */
// users PK = uid (not id)
// studio_queue = radio submissions
// community = posts table
// media_files = media uploads
// notifications uses uid (recipient) not recipient_id

let _mounted  = false;
let _user     = null;
let _profile  = null;
let _isAdmin  = false;
let _activeTab = 'feed';
let _channel   = null;

window.addEventListener('aurenix:authchange', (e) => {
  _user    = e.detail.user;
  _profile = e.detail.profile;
  _isAdmin = e.detail.isAdmin;
  // Normalise: users table uses 'uid' as PK; profile may expose it as uid or id
  if (_profile && _profile.uid && !_profile.id) _profile.id = _profile.uid;
});

window.addEventListener('aurenix:navigate', (e) => {
  if (e.detail.page === 'community') {
    mountCommunity();
  }
});

/* ═══════════════════════════════════════════
   MOUNT
═══════════════════════════════════════════ */
function mountCommunity() {
  const container = document.getElementById('community-content');
  if (!container || _mounted) { if (_mounted) loadFeedTab(); return; }
  _mounted = true;
  renderCommunityShell(container);
}

/* ═══════════════════════════════════════════
   RENDER SHELL
═══════════════════════════════════════════ */
function renderCommunityShell(container) {
  container.innerHTML = `
    <div class="community-layout">

      <!-- Left sidebar: profile + nav -->
      <div class="community-sidebar">
        <div id="community-profile-card" class="mech-panel mech-corner community-profile-card">
          <!-- populated by updateProfileCard() -->
        </div>

        <div class="mech-panel" style="margin-top:16px;">
          <div class="mech-panel-title"><span class="mech-panel-title-dot"></span> Navigate</div>
          <div style="padding:8px 0;">
            <button class="community-nav-btn active" data-ctab="feed">📡 Feed</button>
            <button class="community-nav-btn" data-ctab="notifications">🔔 Notifications</button>
            <button class="community-nav-btn" data-ctab="members">👥 Members</button>
            <button class="community-nav-btn" data-ctab="myprofile" data-requires-auth>👤 My Profile</button>
          </div>
        </div>
      </div>

      <!-- Main content -->
      <div class="community-main">
        <!-- Post composer -->
        <div id="community-composer" class="mech-panel mech-corner community-composer" data-requires-auth style="display:none;">
          <textarea class="field-textarea community-post-input" id="community-post-input"
            placeholder="What signal are you broadcasting to the network?" maxlength="500"
            style="min-height:80px;"></textarea>
          <div style="display:flex; align-items:center; justify-content:flex-end; gap:10px; margin-top:10px;">
            <span id="community-post-charcount" style="font-size:11px; color:var(--text-muted);">0/500</span>
            <button class="btn btn-gold btn-sm" id="community-post-btn">Transmit</button>
          </div>
          <div id="community-post-status" style="display:none; padding:8px; border-radius:var(--radius); font-size:12px; margin-top:8px;"></div>
        </div>

        <!-- Tab content area -->
        <div id="community-tab-content"></div>
      </div>

    </div>
  `;

  bindCommunityNav(container);
  updateProfileCard();
  loadFeedTab();

  // Bind auth events to show/hide gated elements
  window.addEventListener('aurenix:authchange', () => {
    updateProfileCard();
    container.querySelectorAll('[data-requires-auth]').forEach(el => {
      el.style.display = _user ? '' : 'none';
    });
    container.querySelectorAll('[data-guest-only]').forEach(el => {
      el.style.display = _user ? 'none' : '';
    });
  });

  // Show gated elements if already logged in
  if (_user) {
    container.querySelectorAll('[data-requires-auth]').forEach(el => { el.style.display = ''; });
  }
}

/* ═══════════════════════════════════════════
   PROFILE CARD
═══════════════════════════════════════════ */
function updateProfileCard() {
  const card = document.getElementById('community-profile-card');
  if (!card) return;

  if (!_user) {
    card.innerHTML = `
      <div style="padding:20px; text-align:center;">
        <div style="font-size:40px; margin-bottom:10px;">⬡</div>
        <div style="font-size:14px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">Join the Network</div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:16px; line-height:1.6;">Sign in to post, follow members, and interact with the AURENIX community.</div>
        <button class="btn btn-gold btn-sm" id="community-signin-btn" style="width:100%;">Sign In / Register</button>
      </div>
    `;
    document.getElementById('community-signin-btn')?.addEventListener('click', () => {
      window.AURENIX_AUTH?.openModal('login');
    });
    return;
  }

  const name   = _profile?.display_name || _user.email?.split('@')[0] || 'User';
  const handle = _profile?.username     || name;
  const avatar = _profile?.avatar;
  const bio    = _profile?.bio          || '';

  card.innerHTML = `
    <div style="padding:20px; text-align:center;">
      <div class="community-avatar-lg" id="profile-avatar-display" style="${avatar ? `background-image:url('${esc(avatar)}');background-size:cover;background-position:center;` : ''}">
        ${!avatar ? name.charAt(0).toUpperCase() : ''}
      </div>
      <div style="font-size:15px; font-weight:700; color:var(--text); margin-top:10px;">${esc(name)}</div>
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">@${esc(handle)}</div>
      ${bio ? `<div style="font-size:12px; color:var(--text-dim); line-height:1.6; margin-bottom:10px;">${esc(bio)}</div>` : ''}
      <div style="display:flex; justify-content:center; gap:20px; margin-bottom:14px;">
        <div style="text-align:center;">
          <div style="font-size:16px; font-weight:700; color:var(--gold-bright);">${(_profile?.following || []).length}</div>
          <div style="font-size:10px; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">Following</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:16px; font-weight:700; color:var(--energy);">${(_profile?.followers || []).length}</div>
          <div style="font-size:10px; color:var(--text-muted); letter-spacing:1px; text-transform:uppercase;">Followers</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="edit-profile-btn" style="width:100%;">Edit Profile</button>
    </div>
  `;

  document.getElementById('edit-profile-btn')?.addEventListener('click', openEditProfile);
}

/* ═══════════════════════════════════════════
   COMMUNITY NAV TABS
═══════════════════════════════════════════ */
function bindCommunityNav(container) {
  container.querySelectorAll('.community-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.requiresAuth !== undefined && !_user) {
        window.AURENIX_AUTH?.openModal('login'); return;
      }
      container.querySelectorAll('.community-nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _activeTab = btn.dataset.ctab;
      switch(_activeTab) {
        case 'feed':          loadFeedTab();          break;
        case 'notifications': loadNotificationsTab(); break;
        case 'members':       loadMembersTab();       break;
        case 'myprofile':     loadMyProfileTab();     break;
      }
    });
  });

  // Composer
  const postBtn   = container.querySelector('#community-post-btn');
  const postInput = container.querySelector('#community-post-input');
  const charCount = container.querySelector('#community-post-charcount');

  if (postInput && charCount) {
    postInput.addEventListener('input', () => { charCount.textContent = `${postInput.value.length}/500`; });
  }
  if (postBtn && postInput) {
    postBtn.addEventListener('click', () => handleNewPost(postInput));
  }
}

/* ═══════════════════════════════════════════
   FEED TAB
═══════════════════════════════════════════ */
async function loadFeedTab() {
  const content = document.getElementById('community-tab-content');
  if (!content) return;
  content.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); font-size:13px;">Loading feed…</div>`;

  try {
    const { data, error } = await supabase
      .from('community')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    renderFeed(content, data || []);
  } catch(e) {
    content.innerHTML = `<div style="padding:40px; text-align:center; color:#ff6680;">Unable to load feed. Please try again.</div>`;
  }

  // Subscribe to real-time post updates
  if (_channel) { try { supabase.removeChannel(_channel); } catch(_) {} }
  _channel = supabase.channel('community-posts-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community' }, () => loadFeedTab())
    .subscribe();
}

function renderFeed(container, posts) {
  if (!posts.length) {
    container.innerHTML = `
      <div style="padding:60px 24px; text-align:center; color:var(--text-muted);">
        <div style="font-size:40px; margin-bottom:14px;">⬡</div>
        <div style="font-size:15px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">No posts yet</div>
        <div style="font-size:13px;">Be the first to transmit to the AURENIX network.</div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';
  posts.forEach(post => container.appendChild(buildPostCard(post)));
}

function buildPostCard(post) {
  const card = document.createElement('div');
  card.className = 'community-post-card mech-panel';
  card.dataset.pid = post.id;

  const initial = (post.author_name || 'U').charAt(0).toUpperCase();
  const avatar  = post.author_avatar;

  card.innerHTML = `
    <div class="post-header">
      <div class="post-avatar" style="${avatar ? `background-image:url('${esc(avatar)}');background-size:cover;background-position:center;` : ''}">
        ${!avatar ? initial : ''}
      </div>
      <div class="post-author-info">
        <div class="post-author-name">${esc(post.author_name || 'Unknown')}</div>
        <div class="post-meta">${formatRelativeDate(post.created_at)}</div>
      </div>
    </div>
    <div class="post-text">${esc(post.text || post.body || '')}</div>
    <div class="post-actions">
      <button class="post-action-btn post-like-btn" data-liked="false" data-pid="${post.id}">
        ♥ <span class="post-like-count">${post.likes || 0}</span>
      </button>
      <button class="post-action-btn post-comment-toggle" data-pid="${post.id}">
        💬 <span>${post.comment_count || 0}</span>
      </button>
    </div>
    <div class="post-comments-section" id="post-comments-${post.id}" style="display:none;"></div>
  `;

  card.querySelector('.post-like-btn')?.addEventListener('click', (e) => handleLike(e.currentTarget, post.id));
  card.querySelector('.post-comment-toggle')?.addEventListener('click', () => toggleComments(post.id));
  return card;
}

async function handleLike(btn, postId) {
  if (!_user) { window.AURENIX_AUTH?.openModal('login'); return; }
  if (btn.dataset.liked === 'true') return;
  btn.dataset.liked = 'true';
  const countEl = btn.querySelector('.post-like-count');
  const current = parseInt(countEl?.textContent || '0');
  if (countEl) countEl.textContent = current + 1;
  await supabase.from('community').update({ likes: current + 1 }).eq('id', postId).catch(() => {});
}

function toggleComments(postId) {
  const section = document.getElementById(`post-comments-${postId}`);
  if (!section) return;
  if (section.style.display === 'none') {
    section.style.display = '';
    loadPostComments(postId, section);
  } else {
    section.style.display = 'none';
  }
}

async function loadPostComments(postId, container) {
  container.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">Loading comments…</div>`;
  try {
    const { data } = await supabase.from('post_comments')
      .select('*').eq('post_id', postId).order('created_at', { ascending: true }).limit(20);

    container.innerHTML = `
      ${_user ? `
        <div style="display:flex; gap:8px; margin:8px 0;">
          <input class="field-input" type="text" id="post-comment-input-${postId}" placeholder="Reply…" maxlength="300" style="flex:1; font-size:13px; padding:8px 12px;">
          <button class="btn btn-ghost btn-sm" data-post-id="${postId}" class="post-reply-btn">Reply</button>
        </div>
      ` : ''}
      <div class="post-comment-list" id="post-comment-list-${postId}"></div>
    `;

    container.querySelector(`[data-post-id="${postId}"]`)?.addEventListener('click', () => {
      const input = document.getElementById(`post-comment-input-${postId}`);
      submitPostComment(postId, input?.value?.trim(), container);
    });

    const list = document.getElementById(`post-comment-list-${postId}`);
    if (list) {
      if (!data?.length) {
        list.innerHTML = '<div style="font-size:12px; color:var(--text-muted); padding:4px 0;">No replies yet.</div>';
      } else {
        list.innerHTML = data.map(c => `
          <div style="padding:6px 0; border-bottom:1px solid rgba(74,69,96,0.15);">
            <span style="font-size:12px; font-weight:600; color:var(--text-dim);">${esc(c.user_name)}</span>
            <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">${formatRelativeDate(c.created_at)}</span>
            <div style="font-size:13px; color:var(--text); margin-top:2px;">${esc(c.text)}</div>
          </div>
        `).join('');
      }
    }
  } catch(e) {
    container.innerHTML = '<div style="font-size:12px; color:#ff6680;">Unable to load replies.</div>';
  }
}

async function submitPostComment(postId, text, container) {
  if (!text || !_user) return;
  const profile = window.AURENIX_AUTH?.getProfile();
  const { error } = await supabase.from('post_comments').insert({
    post_id:   postId,
    user_id:   _user.id,
    user_name: profile?.display_name || _user.email?.split('@')[0] || 'User',
    text,
  });
  if (!error) {
    const input = document.getElementById(`post-comment-input-${postId}`);
    if (input) input.value = '';
    loadPostComments(postId, container);
    // Increment comment count
    supabase.rpc('increment_post_comments', { post_id: postId }).catch(() => {});
  }
}

/* ═══════════════════════════════════════════
   NEW POST
═══════════════════════════════════════════ */
async function handleNewPost(inputEl) {
  if (!_user) { window.AURENIX_AUTH?.openModal('login'); return; }
  const text = inputEl?.value?.trim();
  if (!text) return;

  const profile = window.AURENIX_AUTH?.getProfile();
  const btn = document.getElementById('community-post-btn');
  const statusEl = document.getElementById('community-post-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Transmitting…'; }

  const { error } = await supabase.from('community').insert({
    uid:           _user.id,
    author_name:   profile?.display_name || _user.email?.split('@')[0] || 'User',
    author_handle: profile?.username     || '',
    author_avatar: profile?.avatar       || '',
    text,
    likes:         0,
    comment_count: 0,
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Transmit'; }

  if (error) {
    if (statusEl) {
      statusEl.style.display='block'; statusEl.style.color='#ff6680';
      statusEl.style.background='rgba(139,0,0,0.15)'; statusEl.style.border='1px solid rgba(139,0,0,0.3)';
      statusEl.textContent = 'Unable to post. Please try again.';
    }
    return;
  }
  inputEl.value = '';
  document.getElementById('community-post-charcount').textContent = '0/500';
  if (statusEl) statusEl.style.display = 'none';
  loadFeedTab();
}

/* ═══════════════════════════════════════════
   NOTIFICATIONS TAB
═══════════════════════════════════════════ */
async function loadNotificationsTab() {
  const content = document.getElementById('community-tab-content');
  if (!content) return;
  if (!_user) { content.innerHTML = signInPrompt('view notifications'); return; }

  content.innerHTML = `<div style="padding:20px; color:var(--text-muted);">Loading notifications…</div>`;
  try {
    const { data } = await supabase.from('notifications')
      .select('*').eq('uid', _user.id)
      .order('created_at', { ascending: false }).limit(30);

    if (!data?.length) {
      content.innerHTML = `<div style="padding:60px; text-align:center; color:var(--text-muted);"><div style="font-size:36px; margin-bottom:14px;">🔔</div><div>No notifications yet.</div></div>`;
      return;
    }

    // Mark as read
    supabase.from('notifications').update({ read: true }).eq('uid', _user.id).eq('read', false).then(() => {});

    content.innerHTML = '<div class="community-notification-list"></div>';
    const list = content.querySelector('.community-notification-list');
    data.forEach(n => {
      const item = document.createElement('div');
      item.className = 'community-notification-item mech-panel' + (n.read ? '' : ' unread');
      item.innerHTML = `
        <div style="display:flex; gap:10px; align-items:flex-start;">
          <div style="width:36px; height:36px; border-radius:50%; background:var(--stone-mid); display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:16px;">
            ${n.type === 'follow' ? '➕' : n.type === 'like' ? '♥' : n.type === 'comment' ? '💬' : n.type === 'live' ? '📡' : '🔔'}
          </div>
          <div style="flex:1;">
            <div style="font-size:13px; color:var(--text);">${esc(n.body || n.title)}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${formatRelativeDate(n.created_at)}</div>
          </div>
          ${!n.read ? '<div style="width:7px; height:7px; border-radius:50%; background:var(--energy); margin-top:6px; flex-shrink:0;"></div>' : ''}
        </div>
      `;
      list.appendChild(item);
    });
  } catch(e) {
    content.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load notifications.</div>`;
  }
}

/* ═══════════════════════════════════════════
   MEMBERS TAB
═══════════════════════════════════════════ */
async function loadMembersTab() {
  const content = document.getElementById('community-tab-content');
  if (!content) return;
  content.innerHTML = `<div style="padding:20px; color:var(--text-muted);">Loading members…</div>`;

  try {
    const { data } = await supabase
      .from('users')
      .select('uid, display_name, username, bio, avatar, followers, is_live')
      .order('updated_at', { ascending: false })
      .limit(40);

    if (!data?.length) { content.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">No members yet.</div>'; return; }

    content.innerHTML = '<div class="community-members-grid" id="members-grid"></div>';
    const grid = document.getElementById('members-grid');
    data.forEach(member => {
      const card = document.createElement('div');
      card.className = 'community-member-card mech-panel';
      const initial = (member.display_name || 'U').charAt(0).toUpperCase();
      const followerCount = (member.followers || []).length;
      card.innerHTML = `
        <div class="community-avatar-md" style="${member.avatar ? `background-image:url('${esc(member.avatar)}');background-size:cover;background-position:center;` : ''}">
          ${!member.avatar ? initial : ''}
          ${member.is_live ? '<span class="member-live-badge">LIVE</span>' : ''}
        </div>
        <div style="padding:12px;">
          <div style="font-size:13px; font-weight:700; color:var(--text); margin-bottom:2px;">${esc(member.display_name || 'Unknown')}</div>
          ${member.username ? `<div style="font-size:11px; color:var(--text-muted);">@${esc(member.username)}</div>` : ''}
          <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">${followerCount} followers</div>
          ${_user && member.uid !== _user.id ? `<button class="btn btn-ghost btn-sm follow-btn" data-uid="${member.uid}" style="width:100%; margin-top:8px;">Follow</button>` : ''}
        </div>
      `;
      card.querySelectorAll('.follow-btn').forEach(btn => {
        btn.addEventListener('click', () => handleFollow(btn, member.uid));
      });
      grid.appendChild(card);
    });
  } catch(e) {
    content.innerHTML = `<div style="padding:20px; color:#ff6680;">Unable to load members.</div>`;
  }
}

async function handleFollow(btn, targetUid) {
  if (!_user) { window.AURENIX_AUTH?.openModal('login'); return; }
  btn.disabled = true;
  btn.textContent = 'Following…';

  try {
    // Update following array on current user
    const currentFollowing = _profile?.following || [];
    if (currentFollowing.includes(targetUid)) { btn.textContent = 'Following'; return; }

    const newFollowing = [...currentFollowing, targetUid];
    await upsertUserProfile({ uid: _user.id, following: newFollowing });

    // Update followers array on target user (append current user's uid)
    const { data: targetData } = await supabase.from('users').select('followers').eq('uid', targetUid).single().catch(() => ({ data: null }));
    const newFollowers = [...(targetData?.followers || [])];
    if (!newFollowers.includes(_user.id)) newFollowers.push(_user.id);
    await supabase.from('users').update({ followers: newFollowers }).eq('uid', targetUid).catch(() => {});

    btn.textContent = '✓ Following';
    btn.classList.add('active');

    // Notify target user
    const profile = window.AURENIX_AUTH?.getProfile();
    await supabase.from('notifications').insert({
      uid:          targetUid,
      type:         'follow',
      from_uid:     _user.id,
      from_name:    profile?.display_name || 'Someone',
      from_avatar:  profile?.avatar || '',
      body:         `${profile?.display_name || 'Someone'} started following you.`,
    }).catch(() => {});
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Follow';
  }
}

/* ═══════════════════════════════════════════
   MY PROFILE TAB
═══════════════════════════════════════════ */
async function loadMyProfileTab() {
  const content = document.getElementById('community-tab-content');
  if (!content) return;
  if (!_user) { content.innerHTML = signInPrompt('view your profile'); return; }

  const profile = window.AURENIX_AUTH?.getProfile() || _profile;
  const name    = profile?.display_name || _user.email?.split('@')[0] || 'User';

  content.innerHTML = `
    <div class="mech-panel mech-corner" style="padding:24px; max-width:600px;">
      <div style="font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--gold-bright); margin-bottom:16px;">
        My Profile
      </div>

      <div class="field-group">
        <label class="field-label">Display Name</label>
        <input class="field-input" id="profile-edit-name" value="${esc(name)}" maxlength="50">
      </div>
      <div class="field-group">
        <label class="field-label">Username</label>
        <input class="field-input" id="profile-edit-username" value="${esc(profile?.username || '')}" maxlength="30" placeholder="lowercase letters and numbers only">
      </div>
      <div class="field-group">
        <label class="field-label">Bio</label>
        <textarea class="field-textarea" id="profile-edit-bio" maxlength="200" placeholder="Tell the network who you are…" style="min-height:70px;">${esc(profile?.bio || '')}</textarea>
      </div>
      <div class="field-group">
        <label class="field-label">Avatar URL</label>
        <input class="field-input" id="profile-edit-avatar" value="${esc(profile?.avatar || '')}" placeholder="https://…">
      </div>

      <div id="profile-save-status" style="display:none; padding:10px; border-radius:var(--radius); font-size:13px; margin-bottom:12px;"></div>
      <button class="btn btn-gold" id="profile-save-btn">Save Profile</button>
    </div>
  `;

  document.getElementById('profile-save-btn')?.addEventListener('click', async () => {
    const name     = document.getElementById('profile-edit-name')?.value?.trim();
    const username = document.getElementById('profile-edit-username')?.value?.trim()?.toLowerCase()?.replace(/[^a-z0-9_]/g,'');
    const bio      = document.getElementById('profile-edit-bio')?.value?.trim();
    const avatar   = document.getElementById('profile-edit-avatar')?.value?.trim();
    const statusEl = document.getElementById('profile-save-status');

    if (!name) { showProfileStatus(statusEl, 'error', 'Display name is required.'); return; }

    const btn = document.getElementById('profile-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';

    const { error } = await supabase.from('users').update({
      display_name: name,
      username:     username || undefined,
      bio:          bio || '',
      avatar:       avatar || '',
    }).eq('uid', _user.id);

    btn.disabled = false; btn.textContent = 'Save Profile';

    if (error) {
      showProfileStatus(statusEl, 'error', 'Unable to save. Please try again.');
    } else {
      showProfileStatus(statusEl, 'success', '✓ Profile updated!');
      // Update local profile reference
      if (_profile) { _profile.display_name = name; _profile.bio = bio; _profile.avatar = avatar; }
      updateProfileCard();
    }
  });
}

function showProfileStatus(el, type, msg) {
  if (!el) return;
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'rgba(139,0,0,0.2)' : 'rgba(0,201,192,0.12)';
  el.style.border     = type === 'error' ? '1px solid rgba(139,0,0,0.4)' : '1px solid rgba(0,201,192,0.3)';
  el.style.color      = type === 'error' ? '#ff6680' : 'var(--energy)';
  el.textContent = msg;
}

/* ═══════════════════════════════════════════
   EDIT PROFILE MODAL
═══════════════════════════════════════════ */
function openEditProfile() {
  const tabs = document.querySelectorAll('.community-nav-btn');
  tabs.forEach(btn => { if (btn.dataset.ctab === 'myprofile') btn.click(); });
}

/* ═══════════════════════════════════════════
   UTILS
═══════════════════════════════════════════ */
function signInPrompt(action) {
  return `
    <div style="padding:60px 24px; text-align:center; color:var(--text-muted);">
      <div style="font-size:40px; margin-bottom:14px;">🔒</div>
      <div style="font-size:15px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">Sign in required</div>
      <div style="font-size:13px; margin-bottom:20px;">Sign in to ${action}.</div>
      <button class="btn btn-gold" onclick="window.AURENIX_AUTH?.openModal('login')">Sign In</button>
    </div>
  `;
}

function formatRelativeDate(iso) {
  if (!iso) return '';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${d}d ago`;
  } catch(_) { return ''; }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
