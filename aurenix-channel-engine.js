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
═══════════════════════════════════════ */
const _engines = {};   // channelId → { config, mediaLib, configUnsub, stateUnsub, advancing }

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
    stateUnsub: null,
    advancing: false,
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

  // Subscribe to config changes
  engine.configUnsub = onSnapshot(configRef, snap => {
    if (snap.exists() && _engines[channelId]) {
      _engines[channelId].config = { ...DEFAULT_CH_CONFIG, ...snap.data() };
    }
  });

  // Mark as running
  await setDoc(configRef, { running: true, paused: false, updated_at: serverTimestamp() }, { merge: true });

  // Subscribe to state for advance triggers
  _subscribeStateForAdvance(channelId);

  // Kick off immediately if no current program
  const stateRef  = doc(db, 'network_state', channelId);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  if (!st?.current_item) {
    await _scheduleNextProgram(channelId, null);
  }
}

export async function stopChannelEngine(channelId) {
  const engine = _engines[channelId];
  if (!engine) return;
  if (engine.stateUnsub)  { engine.stateUnsub();  engine.stateUnsub  = null; }
  if (engine.configUnsub) { engine.configUnsub(); engine.configUnsub = null; }
  delete _engines[channelId];

  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, { running: false, updated_at: serverTimestamp() }, { merge: true });
  await setDoc(doc(db, 'network_state', channelId), {
    current_item: null, started_at: serverTimestamp(), updated_at: serverTimestamp(),
  }, { merge: true });
}

export async function pauseChannelEngine(channelId) {
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, { paused: true, updated_at: serverTimestamp() }, { merge: true });
  await setDoc(doc(db, 'network_state', channelId), { current_item: null, started_at: serverTimestamp() }, { merge: true });
}

export async function resumeChannelEngine(channelId) {
  const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
  await setDoc(configRef, { paused: false, updated_at: serverTimestamp() }, { merge: true });
  await _scheduleNextProgram(channelId, null);
}

export async function skipChannelProgram(channelId) {
  const stateRef  = doc(db, 'network_state', channelId);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  const mode = _engines[channelId]?.config?.programming_mode || 'random';

  if (mode === 'ordered' || mode === 'shuffle') {
    // Queue-based: advance to next in queue
    const queue  = st?.queue || [];
    const curIdx = queue.findIndex(q => q.id === st?.current_item?.id);
    let nextIdx = curIdx + 1;
    if (nextIdx >= queue.length) nextIdx = 0;
    if (queue[nextIdx]) {
      await setDoc(stateRef, { ...st, current_item: queue[nextIdx], started_at: serverTimestamp() }, { merge: true });
    }
  } else {
    // Random mode: trigger re-schedule
    await _scheduleNextProgram(channelId, st?.current_item?.id || null);
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
 * Called by broadcast.js when a non-ALTV channel's current item ends.
 * Handles commercial queue drain or triggers next program.
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

  const engine = _engines[channelId];
  if (!engine) {
    // Engine not active — fall back to queue-based advance
    await _queueAdvance(channelId, st, currentItemId);
    return;
  }

  const mode = engine.config.programming_mode || 'random';
  if (mode === 'ordered' || mode === 'shuffle') {
    await _queueAdvance(channelId, st, currentItemId);
  } else {
    // Random mode — signal needs_next
    await setDoc(stateRef, {
      needs_next:   true,
      last_item_id: currentItemId || null,
      updated_at:   serverTimestamp(),
    }, { merge: true });
  }
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

/* ═══════════════════════════════════════
   INTERNAL — STATE WATCHER (random mode)
═══════════════════════════════════════ */
function _subscribeStateForAdvance(channelId) {
  const engine = _engines[channelId];
  if (!engine) return;
  if (engine.stateUnsub) engine.stateUnsub();
  const stateRef = doc(db, 'network_state', channelId);
  engine.stateUnsub = onSnapshot(stateRef, async snap => {
    const eng = _engines[channelId];
    if (!eng) return;
    if (!snap.exists()) return;
    const st = snap.data();
    if (st.needs_next === true && !eng.advancing) {
      await _scheduleNextProgram(channelId, st.last_item_id || null);
    }
  });
}

/* ═══════════════════════════════════════
   INTERNAL — RANDOM PROGRAM SELECTION
═══════════════════════════════════════ */
async function _scheduleNextProgram(channelId, justPlayedId) {
  const engine = _engines[channelId];
  if (!engine || engine.advancing) return;
  engine.advancing = true;

  try {
    if (!_engines[channelId]) { engine.advancing = false; return; }

    // Re-read config from Firestore
    const configRef = doc(db, CHANNEL_ENGINE_CONFIG_COLLECTION, channelId);
    const configSnap = await getDoc(configRef);
    if (configSnap.exists()) engine.config = { ...DEFAULT_CH_CONFIG, ...configSnap.data() };

    if (!engine.config.running) { engine.advancing = false; return; }
    if (engine.config.paused)  { engine.advancing = false; return; }

    // Check if commercial break is due
    const shouldBreak = engine.config.commercial_enabled && _shouldRunCommercialBreak(engine);
    if (shouldBreak) {
      const commercials = _pickCommercials(engine);
      if (commercials.length > 0) {
        await _playCommercialSequence(channelId, engine, commercials);
        await _writeNextProgram(channelId, engine, justPlayedId, true);
      } else {
        await _writeNextProgram(channelId, engine, justPlayedId, false);
      }
    } else {
      await _writeNextProgram(channelId, engine, justPlayedId, false);
    }
  } catch (e) {
    console.error(`[AURENIX CH ENGINE ${channelId}] _scheduleNextProgram error:`, e);
  }
  if (_engines[channelId]) _engines[channelId].advancing = false;
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
