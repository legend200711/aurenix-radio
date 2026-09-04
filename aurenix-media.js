/**
 * AURENIX — Media Section
 * aurenix-media.js
 *
 * Real backend-connected media section:
 *  - Video/audio upload to Supabase Storage
 *  - Browse/search media items
 *  - Views, likes, comments
 *  - Admin moderation
 */

import { supabase, getUser } from './supabase-client.js';

let _mounted  = false;
let _user     = null;
let _channel  = null;
let _page     = 0;
const PAGE_SIZE = 12;

window.addEventListener('aurenix:authchange', (e) => {
  _user = e.detail.user;
});

window.addEventListener('aurenix:navigate', (e) => {
  if (e.detail.page === 'media') {
    mountMedia();
  }
});

/* ═══════════════════════════════════════════
   MOUNT
═══════════════════════════════════════════ */
function mountMedia() {
  const container = document.getElementById('media-content');
  if (!container || _mounted) { if (_mounted) loadFeed(); return; }
  _mounted = true;
  renderMediaShell(container);
  loadFeed();
}

/* ═══════════════════════════════════════════
   RENDER SHELL
═══════════════════════════════════════════ */
function renderMediaShell(container) {
  container.innerHTML = `
    <!-- Upload + search bar -->
    <div class="media-topbar">
      <div class="media-search-wrap">
        <input class="field-input" type="search" id="media-search" placeholder="Search media…" maxlength="80" aria-label="Search media">
        <button class="btn btn-ghost btn-sm" id="media-search-btn">Search</button>
      </div>
      <button class="btn btn-gold btn-sm" id="media-upload-btn" data-requires-auth style="display:none;">
        ⬆ Upload
      </button>
    </div>

    <!-- Upload panel (hidden by default) -->
    <div id="media-upload-panel" class="mech-panel mech-corner" style="display:none; padding:20px; margin-bottom:20px;">
      <div style="font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--gold-bright); margin-bottom:16px;">
        Upload Media
      </div>

      <div class="field-group">
        <label class="field-label">Title <span style="color:var(--blood)">*</span></label>
        <input class="field-input" type="text" id="media-upload-title" placeholder="Media title" maxlength="120">
      </div>
      <div class="field-group">
        <label class="field-label">Description</label>
        <textarea class="field-textarea" id="media-upload-desc" placeholder="Describe your media…" maxlength="500" style="min-height:70px;"></textarea>
      </div>
      <div class="field-group">
        <label class="field-label">Media File <span style="color:var(--blood)">*</span></label>
        <div id="media-file-drop" style="border:1px dashed var(--border-metal); border-radius:var(--radius); padding:24px; text-align:center; cursor:pointer;">
          <div style="font-size:28px; margin-bottom:8px;">▶</div>
          <div id="media-filename" style="font-size:12px; color:var(--text-dim);">Click or drag video/audio file here</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">MP4, MOV, WebM, MP3, AAC (max 200 MB)</div>
        </div>
        <input type="file" id="media-file-input" accept="video/*,audio/*" style="display:none;">
      </div>
      <div class="field-group">
        <label class="field-label">Thumbnail (optional)</label>
        <div id="media-thumb-drop" style="border:1px dashed var(--border-metal); border-radius:var(--radius); padding:16px; text-align:center; cursor:pointer;">
          <div id="media-thumb-name" style="font-size:12px; color:var(--text-dim);">Click to select thumbnail image</div>
        </div>
        <input type="file" id="media-thumb-input" accept="image/*" style="display:none;">
      </div>

      <div id="media-upload-progress" style="display:none; margin:12px 0;">
        <div style="height:4px; background:var(--stone-mid); border-radius:2px; overflow:hidden;">
          <div id="media-upload-bar" style="height:100%; width:0%; background:linear-gradient(90deg,var(--gold),var(--energy)); transition:width 0.3s;"></div>
        </div>
        <div id="media-upload-pct" style="font-size:11px; color:var(--text-muted); margin-top:4px; text-align:center;">0%</div>
      </div>

      <div id="media-upload-status" style="display:none; padding:10px; border-radius:var(--radius); font-size:13px; margin-bottom:12px;"></div>

      <div style="display:flex; gap:10px;">
        <button class="btn btn-gold" id="media-upload-submit">Upload Media</button>
        <button class="btn btn-ghost" id="media-upload-cancel">Cancel</button>
      </div>
    </div>

    <!-- Feed grid -->
    <div id="media-grid" class="media-grid" aria-label="Media items" aria-live="polite">
      <div style="padding:40px; text-align:center; color:var(--text-muted); font-size:13px;">Loading media…</div>
    </div>

    <!-- Load more -->
    <div style="text-align:center; padding:24px;">
      <button class="btn btn-ghost" id="media-load-more" style="display:none;">Load More</button>
    </div>

    <!-- Media viewer modal -->
    <div id="media-viewer-modal" style="display:none;" role="dialog" aria-modal="true" aria-label="Media player">
      <div class="media-viewer-backdrop"></div>
      <div class="media-viewer-box">
        <button class="media-viewer-close" id="media-viewer-close" aria-label="Close">✕</button>
        <div id="media-viewer-player"></div>
        <div id="media-viewer-meta"></div>
        <div id="media-viewer-comments"></div>
      </div>
    </div>
  `;

  bindMediaEvents(container);
  if (_user) {
    const upBtn = document.getElementById('media-upload-btn');
    if (upBtn) upBtn.style.display = '';
  }
}

/* ═══════════════════════════════════════════
   BIND EVENTS
═══════════════════════════════════════════ */
function bindMediaEvents(container) {
  const uploadBtn   = document.getElementById('media-upload-btn');
  const cancelBtn   = document.getElementById('media-upload-cancel');
  const uploadPanel = document.getElementById('media-upload-panel');
  const searchBtn   = document.getElementById('media-search-btn');
  const searchInput = document.getElementById('media-search');
  const fileInput   = document.getElementById('media-file-input');
  const fileDrop    = document.getElementById('media-file-drop');
  const thumbInput  = document.getElementById('media-thumb-input');
  const thumbDrop   = document.getElementById('media-thumb-drop');
  const submitBtn   = document.getElementById('media-upload-submit');
  const viewerClose = document.getElementById('media-viewer-close');
  const loadMore    = document.getElementById('media-load-more');

  if (uploadBtn)   uploadBtn.addEventListener('click', () => { uploadPanel.style.display = ''; uploadBtn.style.display = 'none'; });
  if (cancelBtn)   cancelBtn.addEventListener('click', () => { uploadPanel.style.display = 'none'; if (_user) uploadBtn.style.display = ''; });

  if (fileDrop && fileInput) {
    fileDrop.addEventListener('click', () => fileInput.click());
    fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.style.borderColor='var(--gold)'; });
    fileDrop.addEventListener('dragleave', () => { fileDrop.style.borderColor=''; });
    fileDrop.addEventListener('drop', e => {
      e.preventDefault(); fileDrop.style.borderColor='';
      if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; document.getElementById('media-filename').textContent = e.dataTransfer.files[0].name; }
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) document.getElementById('media-filename').textContent = fileInput.files[0].name; });
  }

  if (thumbDrop && thumbInput) {
    thumbDrop.addEventListener('click', () => thumbInput.click());
    thumbInput.addEventListener('change', () => { if (thumbInput.files[0]) document.getElementById('media-thumb-name').textContent = thumbInput.files[0].name; });
  }

  if (submitBtn)   submitBtn.addEventListener('click', handleMediaUpload);
  if (searchBtn)   searchBtn.addEventListener('click', () => loadFeed(0, searchInput?.value || ''));
  if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key==='Enter') loadFeed(0, searchInput.value); });
  if (viewerClose) viewerClose.addEventListener('click', closeViewer);
  if (loadMore)    loadMore.addEventListener('click', () => loadFeed(_page + 1, searchInput?.value || '', true));

  const backdrop = document.querySelector('.media-viewer-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeViewer);
}

/* ═══════════════════════════════════════════
   LOAD FEED
═══════════════════════════════════════════ */
async function loadFeed(page = 0, search = '', append = false) {
  _page = page;
  const grid = document.getElementById('media-grid');
  if (!grid) return;

  if (!append && !page) {
    grid.innerHTML = `<div style="padding:40px; text-align:center; color:var(--text-muted); font-size:13px;">Loading media…</div>`;
  }

  try {
    let query = supabase
      .from('media_files')
      .select('id, title, description, file_name, owner_uid, file_type, url, views, likes, uploaded_at')
      .eq('status', 'approved')
      .order('uploaded_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (search.trim()) {
      query = query.ilike('title', `%${search.trim()}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const loadMore = document.getElementById('media-load-more');
    if (loadMore) loadMore.style.display = (data && data.length === PAGE_SIZE) ? '' : 'none';

    if (!append) grid.innerHTML = '';
    if (!data || !data.length) {
      if (!append) grid.innerHTML = `
        <div style="padding:60px 24px; text-align:center; color:var(--text-muted);">
          <div style="font-size:40px; margin-bottom:14px;">▶</div>
          <div style="font-size:15px; font-weight:700; color:var(--text-dim); margin-bottom:8px;">No media yet</div>
          <div style="font-size:13px;">Be the first to upload content to the AURENIX vault.</div>
        </div>`;
      return;
    }
    data.forEach(item => grid.appendChild(buildMediaCard(item)));
  } catch(e) {
    if (!append) grid.innerHTML = `<div style="padding:40px; text-align:center; color:#ff6680;">Unable to load media. Please try again.</div>`;
  }
}

/* ═══════════════════════════════════════════
   BUILD MEDIA CARD
═══════════════════════════════════════════ */
function buildMediaCard(item) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.mid = item.id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Play ${item.title}`);

  const thumb = item.thumbnail_url
    ? `<img src="${esc(item.thumbnail_url)}" alt="${esc(item.title)}" style="width:100%;height:100%;object-fit:cover;">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:36px;color:var(--text-muted);">▶</div>`;

  // Normalise: real DB uses file_type/owner_uid/url; legacy rows may use type/creator_name/media_url
  const displayType = item.file_type || item.type || 'video';
  const displayCreator = item.creator_name || item.file_name?.split('/')[0] || 'Unknown';

  card.innerHTML = `
    <div class="media-card-thumb">
      ${thumb}
      <div class="media-card-play-overlay" aria-hidden="true">▶</div>
      <div class="media-card-type">${esc(displayType)}</div>
    </div>
    <div class="media-card-body">
      <div class="media-card-title">${esc(item.title || item.file_name || 'Untitled')}</div>
      <div class="media-card-meta">${esc(displayCreator)} · ${item.views || 0} views</div>
    </div>
  `;
  card.addEventListener('click', () => openViewer(item));
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(item); } });
  return card;
}

/* ═══════════════════════════════════════════
   MEDIA VIEWER
═══════════════════════════════════════════ */
async function openViewer(item) {
  const modal  = document.getElementById('media-viewer-modal');
  const player = document.getElementById('media-viewer-player');
  const meta   = document.getElementById('media-viewer-meta');
  const comments = document.getElementById('media-viewer-comments');
  if (!modal) return;

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Increment view count (fire and forget)
  supabase.rpc('increment_media_views', { item_id: item.id }).catch(() => {});

  // Fetch full item with url — real DB uses 'url' column in 'media_files'
  let mediaUrl = item.url || '';
  if (!mediaUrl) {
    try {
      const { data } = await supabase.from('media_files').select('url').eq('id', item.id).single();
      mediaUrl = data?.url || '';
    } catch(_) {}
  }

  // Player
  if (item.type === 'audio') {
    player.innerHTML = `
      <audio controls style="width:100%; accent-color:var(--gold-bright);" src="${esc(mediaUrl)}">
        Your browser does not support audio playback.
      </audio>
    `;
  } else {
    player.innerHTML = `
      <video controls playsinline style="width:100%; max-height:50vh; background:#000; border-radius:var(--radius);" ${mediaUrl ? `src="${esc(mediaUrl)}"` : ''}>
        ${!mediaUrl ? '<p style="color:var(--text-muted); padding:20px;">Media unavailable.</p>' : ''}
      </video>
    `;
  }

  // Metadata
  meta.innerHTML = `
    <div style="padding:16px 0 8px;">
      <h3 style="font-size:17px; font-weight:700; color:var(--text); margin-bottom:6px;">${esc(item.title)}</h3>
      <div style="font-size:13px; color:var(--text-muted); margin-bottom:8px;">${esc(item.creator_name || item.file_name?.split('/')[0] || 'Unknown')} · ${item.views || 0} views</div>
      ${item.description ? `<p style="font-size:13px; color:var(--text-dim); line-height:1.7;">${esc(item.description)}</p>` : ''}
      <div style="display:flex; gap:10px; margin-top:12px;">
        <button class="btn btn-ghost btn-sm" id="viewer-like-btn" data-liked="false">♥ ${item.likes || 0}</button>
      </div>
    </div>
  `;

  // Like button
  const likeBtn = document.getElementById('viewer-like-btn');
  if (likeBtn) {
    likeBtn.addEventListener('click', async () => {
      if (!_user) { window.AURENIX_AUTH?.openModal('login'); return; }
      if (likeBtn.dataset.liked === 'true') return;
      likeBtn.dataset.liked = 'true';
      const current = parseInt(likeBtn.textContent.replace(/\D/g,'')) || 0;
      likeBtn.textContent = `♥ ${current + 1}`;
      await supabase.from('media_files').update({ likes: current + 1 }).eq('id', item.id).catch(() => {});
    });
  }

  // Load comments
  loadComments(item.id, comments);
}

async function loadComments(itemId, container) {
  container.innerHTML = `
    <div style="border-top:1px solid var(--border); padding-top:16px; margin-top:8px;">
      <div style="font-size:12px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-dim); margin-bottom:12px;">Comments</div>

      ${_user ? `
        <div style="display:flex; gap:8px; margin-bottom:16px;">
          <input class="field-input" type="text" id="viewer-comment-input" placeholder="Add a comment…" maxlength="300" style="flex:1;">
          <button class="btn btn-gold btn-sm" id="viewer-comment-btn">Post</button>
        </div>
      ` : `<div style="font-size:12px; color:var(--text-muted); margin-bottom:12px;">Sign in to comment.</div>`}

      <div id="viewer-comment-list"><div style="color:var(--text-muted); font-size:13px;">Loading comments…</div></div>
    </div>
  `;

  if (_user) {
    document.getElementById('viewer-comment-btn')?.addEventListener('click', async () => {
      const input = document.getElementById('viewer-comment-input');
      const text = input?.value?.trim();
      if (!text) return;
      const profile = window.AURENIX_AUTH?.getProfile();
      const { error } = await supabase.from('media_comments').insert({
        media_id: itemId,
        user_id: _user.id,
        user_name: profile?.display_name || _user.email?.split('@')[0] || 'User',
        text,
      });
      if (!error) { if (input) input.value = ''; loadCommentList(itemId); }
    });
  }
  loadCommentList(itemId);
}

async function loadCommentList(itemId) {
  const list = document.getElementById('viewer-comment-list');
  if (!list) return;
  try {
    const { data } = await supabase.from('media_comments')
      .select('id, user_name, text, created_at')
      .eq('media_id', itemId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (!data || !data.length) { list.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">No comments yet.</div>'; return; }
    list.innerHTML = data.map(c => `
      <div style="padding:8px 0; border-bottom:1px solid rgba(74,69,96,0.2);">
        <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:2px;">
          <span style="font-size:13px; font-weight:600; color:var(--text);">${esc(c.user_name)}</span>
          <span style="font-size:11px; color:var(--text-muted);">${formatDate(c.created_at)}</span>
        </div>
        <div style="font-size:13px; color:var(--text-dim);">${esc(c.text)}</div>
      </div>
    `).join('');
  } catch(_) { list.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Unable to load comments.</div>'; }
}

function closeViewer() {
  const modal = document.getElementById('media-viewer-modal');
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
    const player = document.getElementById('media-viewer-player');
    if (player) player.innerHTML = '';
  }
}

/* ═══════════════════════════════════════════
   UPLOAD HANDLER
═══════════════════════════════════════════ */
async function handleMediaUpload() {
  if (!_user) { window.AURENIX_AUTH?.openModal('login'); return; }

  const title     = document.getElementById('media-upload-title')?.value?.trim();
  const desc      = document.getElementById('media-upload-desc')?.value?.trim() || '';
  const fileInput = document.getElementById('media-file-input');
  const thumbInput= document.getElementById('media-thumb-input');
  const statusEl  = document.getElementById('media-upload-status');
  const progressEl= document.getElementById('media-upload-progress');
  const barEl     = document.getElementById('media-upload-bar');
  const pctEl     = document.getElementById('media-upload-pct');
  const submitBtn = document.getElementById('media-upload-submit');

  if (!title) { showUploadStatus(statusEl, 'error', 'Title is required.'); return; }
  if (!fileInput?.files?.[0]) { showUploadStatus(statusEl, 'error', 'Please select a media file.'); return; }

  const file = fileInput.files[0];
  const MAX_MB = 200;
  if (file.size > MAX_MB * 1024 * 1024) { showUploadStatus(statusEl, 'error', `File exceeds ${MAX_MB} MB limit.`); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';
  progressEl.style.display = 'block';

  try {
    const profile = window.AURENIX_AUTH?.getProfile();
    const uid     = _user.id;
    const ext     = file.name.split('.').pop()?.toLowerCase() || 'mp4';
    const mtype   = file.type.startsWith('audio/') ? 'audio' : 'video';
    const storagePath = `media/${uid}/${Date.now()}.${ext}`;

    // Upload media file
    const { error: uploadErr } = await supabase.storage
      .from('aurenix-media')
      .upload(storagePath, file, { cacheControl: '3600', upsert: false });
    if (uploadErr) throw uploadErr;

    barEl.style.width = '70%'; pctEl.textContent = '70%';

    // Get public URL
    const { data: urlData } = supabase.storage.from('aurenix-media').getPublicUrl(storagePath);
    const mediaUrl = urlData?.publicUrl || '';

    // Upload thumbnail if provided
    let thumbnailUrl = '';
    if (thumbInput?.files?.[0]) {
      const tExt  = thumbInput.files[0].name.split('.').pop() || 'jpg';
      const tPath = `thumbs/${uid}/${Date.now()}.${tExt}`;
      const { error: tErr } = await supabase.storage.from('aurenix-media').upload(tPath, thumbInput.files[0]);
      if (!tErr) {
        const { data: tUrl } = supabase.storage.from('aurenix-media').getPublicUrl(tPath);
        thumbnailUrl = tUrl?.publicUrl || '';
      }
    }

    barEl.style.width = '90%'; pctEl.textContent = '90%';

    // Insert metadata row — use real media_files schema
    const { error: insertErr } = await supabase.from('media_files').insert({
      title,
      description:   desc,
      owner_uid:     uid,
      creator_name:  profile?.display_name || _user.email?.split('@')[0] || 'Unknown',
      file_type:     mtype,
      file_name:     file.name,
      file_size:     file.size,
      url:           mediaUrl,
      thumbnail_url: thumbnailUrl,
      status:        'approved', // auto-approved for now; admins can remove
      views:         0,
      likes:         0,
    });
    if (insertErr) throw insertErr;

    barEl.style.width = '100%'; pctEl.textContent = '100%';
    showUploadStatus(statusEl, 'success', '✓ Media uploaded successfully!');

    // Reset form
    setTimeout(() => {
      document.getElementById('media-upload-panel').style.display = 'none';
      document.getElementById('media-upload-btn').style.display = '';
      if (document.getElementById('media-upload-title')) document.getElementById('media-upload-title').value = '';
      if (document.getElementById('media-upload-desc'))  document.getElementById('media-upload-desc').value  = '';
      if (fileInput)  fileInput.value  = '';
      if (thumbInput) thumbInput.value = '';
      document.getElementById('media-filename').textContent = 'Click or drag video/audio file here';
      document.getElementById('media-thumb-name').textContent = 'Click to select thumbnail image';
      progressEl.style.display = 'none';
      barEl.style.width = '0%';
      loadFeed();
    }, 2000);
  } catch(e) {
    showUploadStatus(statusEl, 'error', 'Upload failed. Please try again.');
    progressEl.style.display = 'none';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload Media';
  }
}

function showUploadStatus(el, type, msg) {
  if (!el) return;
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'rgba(139,0,0,0.2)' : 'rgba(0,201,192,0.12)';
  el.style.border     = type === 'error' ? '1px solid rgba(139,0,0,0.4)' : '1px solid rgba(0,201,192,0.3)';
  el.style.color      = type === 'error' ? '#ff6680' : 'var(--energy)';
  el.textContent = msg;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch(_) { return ''; }
}
