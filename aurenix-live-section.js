/**
 * AURENIX — Live Section Module
 * aurenix-live-section.js
 *
 * Populates the Live page inside aurenix.html with real-time data
 * from Supabase. Read-only subscriber — does NOT modify live_rooms.
 */

import { supabase } from './supabase-client.js';

/* ── Only activate when the live page is visible ── */
let bootstrapped = false;
let channel      = null;

window.addEventListener('aurenix:navigate', e => {
  if (e.detail.page === 'live' && !bootstrapped) {
    bootstrapped = true;
    subscribeRooms();
  }
});

/* ════════════════════════════════════
   INITIAL FETCH + REAL-TIME SUBSCRIPTION
════════════════════════════════════ */
function subscribeRooms() {
  const loadingEl = document.getElementById('live-loading-state');
  if (loadingEl) loadingEl.style.display = 'none';

  // Initial fetch
  fetchRooms();

  // Real-time subscription via Supabase Realtime
  if (channel) { try { supabase.removeChannel(channel); } catch(_) {} }

  channel = supabase
    .channel('aurenix-live-rooms')
    .on(
      'postgres_changes',
      {
        event:  '*',
        schema: 'public',
        table:  'live_rooms',
        filter: 'status=eq.live',
      },
      () => fetchRooms()
    )
    .subscribe();
}

async function fetchRooms() {
  try {
    const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('live_rooms')
      .select('*')
      .eq('status', 'live')
      .eq('is_live', true)
      .gt('created_at', cutoff)
      .order('created_at', { ascending: false });

    if (error) throw error;
    renderRooms(data || []);
  } catch (err) {
    console.warn('[AURENIX Live] Rooms fetch error:', err.message);
    showEmpty();
  }
}

/* ════════════════════════════════════
   RENDER
════════════════════════════════════ */
function renderRooms(rooms) {
  const grid    = document.getElementById('live-rooms-grid');
  const empty   = document.getElementById('live-empty-state');
  const loading = document.getElementById('live-loading-state');
  const countEl = document.getElementById('live-section-count');

  if (loading) loading.style.display = 'none';
  if (countEl) countEl.textContent = rooms.length;

  if (!grid) return;

  if (!rooms.length) {
    showEmpty();
    grid.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  grid.style.display = 'grid';

  // Diff update — preserve existing cards
  const existing = new Map();
  grid.querySelectorAll('[data-rid]').forEach(c => existing.set(c.dataset.rid, c));
  const seen = new Set();

  rooms.forEach(room => {
    const rid = room.id;
    seen.add(rid);
    if (!existing.has(rid)) {
      grid.prepend(buildCard(room, rid));
    } else {
      updateCard(existing.get(rid), room);
    }
  });

  existing.forEach((card, rid) => {
    if (!seen.has(rid)) card.remove();
  });
}

function showEmpty() {
  const grid  = document.getElementById('live-rooms-grid');
  const empty = document.getElementById('live-empty-state');
  if (grid)  grid.style.display  = 'none';
  if (empty) empty.style.display = 'block';
  const countEl = document.getElementById('live-section-count');
  if (countEl) countEl.textContent = '0';
}

function buildCard(room, rid) {
  const host    = esc(room.host_name || 'Broadcaster');
  const title   = esc(room.title    || 'Live Broadcast');
  const viewers = room.viewers ?? 0;

  const card = document.createElement('a');
  card.className   = 'live-card';
  card.dataset.rid = rid;
  card.href = `live.html?room=${encodeURIComponent(rid)}`;
  card.setAttribute('aria-label', `Watch ${host} — ${title}`);

  card.innerHTML = `
    <div class="live-card-thumb">
      📡
      <div class="live-card-badges">
        <div class="status-badge status-live">
          <span class="status-live-dot"></span> LIVE
        </div>
      </div>
      <div class="live-card-viewers">👁 <span class="vc">${viewers}</span></div>
    </div>
    <div class="live-card-body">
      <div class="live-card-title">${title}</div>
      <div class="live-card-host">${host}</div>
    </div>
  `;
  return card;
}

function updateCard(card, room) {
  const vc = card.querySelector('.vc');
  if (vc) vc.textContent = room.viewers ?? 0;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
