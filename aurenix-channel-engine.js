/**
 * AURENIX CHANNEL ENGINE
 * aurenix-channel-engine.js
 *
 * Generic 24/7 TV engine for every non-ALTV channel.
 * Each channel has fully independent state, programming, and commercial settings.
 *
 * Firestore:
 *   network_channels/{id}        — channel config (commercials, mode, anti-repeat…)
 *   network_state/{id}           — live playback state (current_item, started_at, queue…)
 *   network_ch_config/{id}       — per-channel engine config (mirrors channel_live_tv_config)
 *
 * Programming modes: 'random' | 'ordered' | 'shuffle'
 * Commercial modes:  ON (configurable) | OFF
 */

import {
  auth, db,
  doc, getDoc, setDoc, collection, getDocs,
  onSnapshot, serverTimestamp, updateDoc,
  query, orderBy, where,
} from './firebase-client.js';

/* ═══════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════ */
export const CHANNEL_ENGINE_CONFIG_COLLECTION = 'network_ch_config';

// Media types eligible for main programming
const PROGRAM_TYPES = [
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
  'funny_clip', 'short_film', 'other', 'promo',
];

// Media types treated as commercials
const COMMERCIAL_TYPES = ['commercial', 'promo', 'station_id'];

export const CHANNEL_COMMERCIAL_FREQ = {
  off:    { label: 'OFF',           minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
  low:    { label: 'Low',           minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
  normal: { label: 'Normal',        minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
  high:   { label: 'High',          minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
  every:  { label: 'Every program', minPrograms: 1,   maxPrograms: 1,   minSpot: 1, maxSpot: 1 },
  every2: { label: 'Every 2',       minPrograms: 2,   maxPrograms: 2,   minSpot: 1, maxSpot: 2 },
  every3: { label: 'Every 3',       minPrograms: 3,   maxPrograms: 3,   minSpot: 1, maxSpot: 2 },
};

const DEFAULT_CH_CONFIG = {
  running:              false,
  commercial_enabled:   false,
  commercial_freq:      'normal',
  min_programs:         2,
  max_programs:         4,
  min_spots:            1,
  max_spots:            2,
  avoid_repeat_window:  5,
  recent_history:       [],
  commercial_history:   [],
  programs_since_break: 0,
  next_break_at:        3,
  paused:               false,
  programming_mode:     'random',   // 'random' | 'ordered' | 'shuffle'
  max_commercials_per_break: 2,
  updated_at:           null,
};

/* ═══════════════════════════════════════
   ACTIVE ENGINES MAP
   channelId → engine instance
   NOTE: The engine is now a configuration & management cache only.
   Actual channel advancement is handled server-side by the Cloudflare Worker
   (POST /channel/advance).  The browser-side engine no longer acts as a
   24/7 broadcast server — channels continue even when no browser is open.
═══════════════════════════════════════ */
const _engines = {};   // channelId → { config, mediaLib, configUnsub }

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

/**
 * Start a channel engine for a specific channel.
 * @param {string} channelId
 * @param {Array}  mediaLib   — approved media library
 * @param {Object} channelDoc — Firestore network_channels/{id} document
 */
export async function startChannelEngine(channelId, mediaLib, channelDoc) {
  if (_engines[channelId]) {
    // Already running — just update media lib
    _engines[channelId].mediaLib = mediaLib;
    return;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Please log in to continue.');
  try { await currentUser.getIdToken(true); } catch (_) {}

  const engine = {
    channelId,
    mediaLib,
    channelDoc: channelDoc || {},
    config: { ...DEFAULT_CH_CONFIG },
    configUnsub: null,
    // NOTE: No stateUnsub / advancing — the browser no longer drives advancement.
    // The Cloudflare Worker handles all atomic channel advancement server-side.
  };
  _engines[channelId] = engine;

  // Load / create engine config doc
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  const configSnap = await getDoc(configRef);
  if (configSnap.exists()) {
    engine.config = { ...DEFAULT_CH_CONFIG, ...configSnap.data() };
  } else {
    // Bootstrap from channel document settings
    const initConfig = {
      ...DEFAULT_CH_CONFIG,
      running: true,
      commercial_enabled: channelDoc?.commercial_enabled ?? false,
      commercial_freq:    channelDoc?.commercial_freq    ?? 'normal',
      programming_mode:   channelDoc?.mode === 'shuffle' ? 'shuffle'
                         : channelDoc?.mode === 'ordered' ? 'ordered' : 'random',
      avoid_repeat_window: channelDoc?.avoid_repeat_window ?? 5,
    };
    await setDoc(configRef, { ...initConfig, updated_at: serverTimestamp() });
    engine.config = initConfig;
  }

  // Subscribe to config changes (local cache for management UI only)
  engine.configUnsub = onSnapshot(configRef, snap => {
    if (snap.exists() && _engines[channelId]) {
      _engines[channelId].config = { ...DEFAULT_CH_CONFIG, ...snap.data() };
    }
  });

  // Mark as running in the config doc so the Worker knows the channel is active
  await setDoc(configRef, { running: true, paused: false, updated_at: serverTimestamp() }, { merge: true });

  // DO NOT subscribe to state for advancement — the Worker handles that.
  // DO NOT call _scheduleNextProgram — the Worker handles the first item too.
  // If no current program is set, the next viewer/Founder advance request will
  // kick off the channel via the Worker automatically.
}

/**
 * Tears down the local engine cache for a channel.
 *
 * CRITICAL: This does NOT erase network_state.  Erasing live broadcast state
 * must only happen when the Founder explicitly presses the STOP BROADCAST
 * button (handled in aurenix-control.js stopChannel).  Calling this function
 * merely destroys the in-memory engine object so Founder Studio can change
 * which channel it is managing without affecting any channel's live state.
 */
export async function stopChannelEngine(channelId) {
  const engine = _engines[channelId];
  if (!engine) return;
  if (engine.configUnsub) { engine.configUnsub(); engine.configUnsub = null; }
  delete _engines[channelId];

  // Mark as not-running in the config doc only.
  // network_state is intentionally left untouched — the channel broadcast
  // continues via the server-side Worker until explicitly stopped.
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, { running: false, updated_at: serverTimestamp() }, { merge: true });
}

export async function pauseChannelEngine(channelId) {
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  // Pause flag tells the Worker to reject advance requests for this channel.
  // network_state is left untouched so the currently-playing item stays visible.
  await setDoc(configRef, { paused: true, updated_at: serverTimestamp() }, { merge: true });
}

export async function resumeChannelEngine(channelId) {
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  // Un-pausing allows the Worker to accept advance requests again.
  // The next viewer tick will call the Worker which will continue the channel.
  await setDoc(configRef, { paused: false, updated_at: serverTimestamp() }, { merge: true });
}

export async function skipChannelProgram(channelId) {
  const stateRef  = doc(db, 'network_state', channelId);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  const mode = _engines[channelId]?.config?.programming_mode || 'random';

  if (mode === 'ordered' || mode === 'shuffle') {
    // Queue-based: advance to next in queue directly (Founder action — admin writes allowed)
    const queue  = st?.queue || [];
    const curIdx = queue.findIndex(q => q.id === st?.current_item?.id);
    let nextIdx = curIdx + 1;
    if (nextIdx >= queue.length) nextIdx = 0;
    if (queue[nextIdx]) {
      await setDoc(stateRef, { ...st, current_item: queue[nextIdx], started_at: serverTimestamp() }, { merge: true });
    }
  } else {
    // Random mode: force-advance by clearing current_item with a sentinel that
    // makes elapsed >= duration immediately, causing the next tick from any
    // viewer to call the Worker.  The simplest safe approach is to set
    // started_at far in the past so the Worker's time-guard passes instantly.
    if (st?.current_item) {
      const oneSecAgo = new Date(Date.now() - ((st.current_item.duration_sec || 1) + 10) * 1000);
      await setDoc(stateRef, {
        started_at: oneSecAgo,
        updated_at: serverTimestamp(),
      }, { merge: true });
    }
  }
}

export async function saveChannelEngineConfig(channelId, updates) {
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, { ...updates, updated_at: serverTimestamp() }, { merge: true });
}

export function getChannelEngineConfig(channelId) {
  return { ...((_engines[channelId]?.config) || DEFAULT_CH_CONFIG) };
}

export function isChannelEngineActive(channelId) {
  return !!_engines[channelId];
}

export function updateChannelMediaLib(channelId, mediaLib) {
  if (_engines[channelId]) {
    _engines[channelId].mediaLib = mediaLib;
  }
}

export function updateAllChannelsMediaLib(mediaLib) {
  Object.keys(_engines).forEach(id => {
    _engines[id].mediaLib = mediaLib;
  });
}

/**
 * Called by aurenix-control.js for ordered/shuffle queue manipulation only.
 * Random-mode advancement now goes through the Cloudflare Worker exclusively.
 *
 * NOTE: This function is only called by the Founder (admin writes allowed).
 * Regular viewers call the Worker endpoint directly.
 */
export async function channelAdvance(channelId, currentItemId) {
  const stateRef  = doc(db, 'network_state', channelId);
  const stateSnap = await getDoc(stateRef);
  if (!stateSnap.exists()) return;
  const st = stateSnap.data();

  // Drain commercial queue first
  const commQueue = st.commercial_queue || [];
  if (commQueue.length > 0) {
    const [nextComm, ...remaining] = commQueue;
    await setDoc(stateRef, {
      current_item:     nextComm,
      started_at:       serverTimestamp(),
      is_commercial:    true,
      commercial_queue: remaining,
      needs_next:       false,
      last_item_id:     nextComm.id,
      updated_at:       serverTimestamp(),
    }, { merge: true });
    return;
  }

  // Queue-based advance for ordered/shuffle modes
  await _queueAdvance(channelId, st, currentItemId);
}

/* ═══════════════════════════════════════
   INTERNAL — QUEUE-BASED ADVANCE (ordered/shuffle)
═══════════════════════════════════════ */
async function _queueAdvance(channelId, st, currentItemId) {
  const stateRef = doc(db, 'network_state', channelId);
  const queue  = st?.queue || [];
  const curIdx = queue.findIndex(q => q.id === (st?.current_item?.id));
  let nextIdx = curIdx + 1;

  if (nextIdx >= queue.length) {
    const loop = st?.loop ?? true;
    if (loop) {
      nextIdx = 0;
    } else {
      await setDoc(stateRef, { ...st, current_item: null, started_at: serverTimestamp() }, { merge: true });
      return;
    }
  }

  const nextItem = queue[nextIdx];
  if (!nextItem) { return; }

  // Check commercials for queue-based channels
  const engine = _engines[channelId];
  if (engine?.config?.commercial_enabled) {
    const shouldBreak = _shouldRunCommercialBreak(engine);
    if (shouldBreak) {
      const commercials = _pickCommercials(engine);
      if (commercials.length > 0) {
        const [firstComm, ...remainingComms] = commercials;
        await setDoc(stateRef, {
          current_item:     _mediaItemToState(firstComm),
          started_at:       serverTimestamp(),
          is_commercial:    true,
          commercial_queue: remainingComms.map(_mediaItemToState),
          _post_commercial_item: nextItem,
          needs_next:       false,
          last_item_id:     firstComm.id,
          updated_at:       serverTimestamp(),
        }, { merge: true });
        await _updateCommercialBreakHistory(channelId, engine, commercials);
        return;
      }
    }
  }

  await setDoc(stateRef, {
    ...st,
    current_item: nextItem,
    started_at:   serverTimestamp(),
    is_commercial: false,
    commercial_queue: [],
    updated_at:   serverTimestamp(),
  }, { merge: true });

  if (engine) await _updateProgramHistory(channelId, engine, nextItem.id || '');
}


function _shouldRunCommercialBreak(engine) {
  const freq = CHANNEL_COMMERCIAL_FREQ[engine.config.commercial_freq] || CHANNEL_COMMERCIAL_FREQ.normal;
  if (freq.maxSpot === 0) return false;
  const since = engine.config.programs_since_break || 0;
  const target = engine.config.next_break_at || freq.minPrograms;
  return since >= target;
}

function _pickCommercials(engine) {
  const freq = CHANNEL_COMMERCIAL_FREQ[engine.config.commercial_freq] || CHANNEL_COMMERCIAL_FREQ.normal;
  const pool = engine.mediaLib.filter(m =>
    m.status === 'approved' &&
    COMMERCIAL_TYPES.includes(m.type) &&
    m.url
  );
  if (!pool.length) return [];

  const maxPerBreak = engine.config.max_commercials_per_break || freq.maxSpot;
  const count = _randInt(Math.min(freq.minSpot, maxPerBreak), Math.min(freq.maxSpot, maxPerBreak));
  const result = [];
  const recentComm = engine.config.commercial_history || [];

  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    const fresh = available.filter(m => !recentComm.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

async function _playCommercialSequence(channelId, engine, commercials) {
  const stateRef = doc(db, 'network_state', channelId);
  const [firstComm, ...remainingComms] = commercials;
  await setDoc(stateRef, {
    current_item:       _mediaItemToState(firstComm),
    started_at:         serverTimestamp(),
    is_commercial:      true,
    commercial_queue:   remainingComms.map(_mediaItemToState),
    needs_next:         false,
    last_item_id:       firstComm.id,
    updated_at:         serverTimestamp(),
  }, { merge: true });

  await _updateCommercialBreakHistory(channelId, engine, commercials);
}

async function _updateCommercialBreakHistory(channelId, engine, commercials) {
  const newCommHist = [...((engine.config.commercial_history || []).slice(-20)), ...commercials.map(c => c.id)];
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, {
    commercial_history: newCommHist,
    programs_since_break: 0,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

async function _writeNextProgram(channelId, engine, justPlayedId, afterCommercial) {
  const program = _pickProgram(engine, justPlayedId);
  if (!program) {
    console.warn(`[AURENIX CH ENGINE ${channelId}] No eligible programs found.`);
    return;
  }

  const stateRef = doc(db, 'network_state', channelId);
  await setDoc(stateRef, {
    current_item:     _mediaItemToState(program),
    started_at:       serverTimestamp(),
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     program.id,
    updated_at:       serverTimestamp(),
  }, { merge: true });

  await _updateProgramHistory(channelId, engine, program.id);
}

async function _updateProgramHistory(channelId, engine, programId) {
  const window = engine.config.avoid_repeat_window || 5;
  const newHistory = [...((engine.config.recent_history || []).slice(-(window - 1))), programId];
  const freq = CHANNEL_COMMERCIAL_FREQ[engine.config.commercial_freq] || CHANNEL_COMMERCIAL_FREQ.normal;
  const newSinceBreak = (engine.config.programs_since_break || 0) + 1;
  const newTarget = _randInt(freq.minPrograms, freq.maxPrograms);

  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, {
    recent_history:       newHistory,
    programs_since_break: newSinceBreak,
    next_break_at:        newTarget,
    updated_at:           serverTimestamp(),
  }, { merge: true });
}

function _pickProgram(engine, justPlayedId) {
  const pool = engine.mediaLib.filter(m =>
    m.status === 'approved' &&
    PROGRAM_TYPES.includes(m.type) &&
    m.url
  );
  if (!pool.length) return null;

  const recentHistory = engine.config.recent_history || [];
  const avoidIds = justPlayedId ? [...recentHistory, justPlayedId] : recentHistory;
  let candidates = pool.filter(m => !avoidIds.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== justPlayedId);
  if (!candidates.length) candidates = pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function _mediaItemToState(m) {
  return {
    id:           m.id,
    title:        m.title || '(untitled)',
    artist:       m.artist   || '',
    type:         m.type     || 'media',
    url:          m.url      || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
  };
}

function _randInt(min, max) {
  if (min > max) return max;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
