/**
 * AURENIX LIVE TV — 24/7 Live Television Engine
 * aurenix-live-tv-engine.js
 *
 * Primary 24/7 live television engine for AURENIX.
 * Channel ID: ALTV
 * Config collection: channel_live_tv_config
 * State: network_state/ALTV (shared broadcast — all viewers see the same position)
 *
 * Supports:
 *   - Random programming from Founder-approved media pool
 *   - Automatic commercial breaks (configurable frequency)
 *   - Per-channel media assignment (media.live_tv_assigned === true)
 *   - Shared broadcast state (late joiners see the live position, not from 0:00)
 *   - All controls: start/stop/pause/resume/skip/force break/randomize
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
export const LIVE_TV_CHANNEL_ID = 'ALTV';
const LIVE_TV_CONFIG_DOC = 'channel_live_tv_config';

// Media types eligible for AURENIX LIVE TV main programming
const LIVE_TV_PROGRAM_TYPES = [
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
];

// Media types that count as commercials for LIVE TV
const LIVE_TV_COMMERCIAL_TYPES = ['commercial', 'promo', 'trailer', 'station_id'];

// Commercial frequency configs (same shape as ONE engine for UI re-use)
export const LIVE_TV_COMMERCIAL_FREQ = {
  off:    { label: 'OFF',    minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
  low:    { label: 'Low',    minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
  normal: { label: 'Normal', minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
  high:   { label: 'High',   minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
};

const DEFAULT_CONFIG = {
  running:              false,
  commercial_freq:      'normal',
  min_programs:         2,
  max_programs:         4,
  min_spots:            1,
  max_spots:            2,
  avoid_repeat_window:  10,
  recent_history:       [],
  commercial_history:   [],
  programs_since_break: 0,
  next_break_at:        3,
  paused:               false,
  programming_mode:     'random',  // 'random' | 'manual' | 'mixed'
  commercial_break_mode:'programs',// 'programs' | 'minutes' | 'random' | 'manual'
  custom_break_minutes: 30,
  updated_at:           null,
};

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let _config        = { ...DEFAULT_CONFIG };
let _mediaLib      = [];
let _configUnsub   = null;
let _stateUnsub    = null;
let _engineActive  = false;
let _advancing     = false;

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

/**
 * Start AURENIX LIVE TV engine.
 * @param {Array} mediaLib — current approved media library
 */
export async function startLiveTvEngine(mediaLib) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Please log in to continue.');
  try { await currentUser.getIdToken(true); } catch (_) {}

  _mediaLib = mediaLib;
  _engineActive = true;

  const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
  const configSnap = await getDoc(configRef);
  if (configSnap.exists()) {
    _config = { ...DEFAULT_CONFIG, ...configSnap.data() };
  } else {
    await setDoc(configRef, { ...DEFAULT_CONFIG, running: true, updated_at: serverTimestamp() });
    _config = { ...DEFAULT_CONFIG, running: true };
  }

  if (_configUnsub) _configUnsub();
  _configUnsub = onSnapshot(configRef, snap => {
    if (snap.exists()) _config = { ...DEFAULT_CONFIG, ...snap.data() };
  });

  await setDoc(configRef, { running: true, paused: false, updated_at: serverTimestamp() }, { merge: true });

  _subscribeStateForAdvance();

  // Kick off immediately if nothing playing
  const stateRef  = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  if (!st?.current_item || _config.running) {
    await _scheduleNextProgram(null);
  }
}

export async function stopLiveTvEngine() {
  _engineActive = false;
  if (_stateUnsub)  { _stateUnsub();  _stateUnsub  = null; }
  if (_configUnsub) { _configUnsub(); _configUnsub = null; }
  const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
  await setDoc(configRef, { running: false, updated_at: serverTimestamp() }, { merge: true });
  // Clear the broadcast state
  await setDoc(doc(db, 'network_state', LIVE_TV_CHANNEL_ID), {
    current_item: null, started_at: serverTimestamp(), updated_at: serverTimestamp(),
  }, { merge: true });
}

export async function pauseLiveTvEngine() {
  const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
  await setDoc(configRef, { paused: true, updated_at: serverTimestamp() }, { merge: true });
  await setDoc(doc(db, 'network_state', LIVE_TV_CHANNEL_ID), { current_item: null, started_at: serverTimestamp() }, { merge: true });
}

export async function resumeLiveTvEngine() {
  const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
  await setDoc(configRef, { paused: false, updated_at: serverTimestamp() }, { merge: true });
  await _scheduleNextProgram(null);
}

export async function forceLiveTvCommercialBreak() {
  return _playCommercialBreak();
}

export async function skipLiveTvProgram() {
  const stateRef  = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  await _scheduleNextProgram(st?.current_item?.id || null);
}

export async function randomizeLiveTvNext() {
  // Force pick of a completely fresh random program (ignoring history)
  const pool = _mediaLib.filter(m =>
    m.status === 'approved' &&
    LIVE_TV_PROGRAM_TYPES.includes(m.type) &&
    m.url &&
    (m.live_tv_assigned !== false)
  );
  if (!pool.length) return false;
  const program = pool[Math.floor(Math.random() * pool.length)];
  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  await setDoc(stateRef, {
    current_item:     _mediaItemToState(program),
    started_at:       serverTimestamp(),
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     program.id,
    queue:            [],
    loop:             false,
    updated_at:       serverTimestamp(),
  }, { merge: true });
  return true;
}

export function updateLiveTvMediaLib(mediaLib) {
  _mediaLib = mediaLib;
}

export async function saveLiveTvConfig(updates) {
  const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
  await setDoc(configRef, { ...updates, updated_at: serverTimestamp() }, { merge: true });
}

export function getLiveTvConfig() { return { ..._config }; }

export function isLiveTvEngineActive() { return _engineActive; }

/* ═══════════════════════════════════════
   INTERNAL — STATE WATCHER
═══════════════════════════════════════ */
function _subscribeStateForAdvance() {
  if (_stateUnsub) _stateUnsub();
  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  _stateUnsub = onSnapshot(stateRef, async snap => {
    if (!_engineActive) return;
    if (!snap.exists()) return;
    const st = snap.data();
    if (st.needs_next === true && !_advancing) {
      await _scheduleNextProgram(st.last_item_id || null);
    }
  });
}

/* ═══════════════════════════════════════
   INTERNAL — PROGRAM SELECTION
═══════════════════════════════════════ */
async function _scheduleNextProgram(justPlayedId) {
  if (_advancing) return;
  _advancing = true;
  try {
    if (!_engineActive) { _advancing = false; return; }
    if (_config.paused)  { _advancing = false; return; }

    const configRef = doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID);
    const configSnap = await getDoc(configRef);
    if (configSnap.exists()) _config = { ...DEFAULT_CONFIG, ...configSnap.data() };
    if (!_config.running) { _advancing = false; return; }

    const shouldBreak = _shouldRunCommercialBreak();
    if (shouldBreak) {
      const commercials = _pickCommercials();
      if (commercials.length > 0) {
        await _playCommercialSequence(commercials);
        await _writeNextProgram(justPlayedId, true);
      } else {
        await _writeNextProgram(justPlayedId, false);
      }
    } else {
      await _writeNextProgram(justPlayedId, false);
    }
  } catch (e) {
    console.error('[AURENIX LIVE TV] _scheduleNextProgram error:', e);
  }
  _advancing = false;
}

function _shouldRunCommercialBreak() {
  const freq = LIVE_TV_COMMERCIAL_FREQ[_config.commercial_freq] || LIVE_TV_COMMERCIAL_FREQ.normal;
  if (freq.maxSpot === 0) return false;
  const since = _config.programs_since_break || 0;
  const target = _config.next_break_at || freq.minPrograms;
  return since >= target;
}

function _pickCommercials() {
  const freq = LIVE_TV_COMMERCIAL_FREQ[_config.commercial_freq] || LIVE_TV_COMMERCIAL_FREQ.normal;
  // Commercial pool: either dedicated commercial type OR approved commercials from network_commercials
  // For live TV, use media with type 'commercial' or 'promo', plus live_tv_assigned !== false
  const pool = _mediaLib.filter(m =>
    m.status === 'approved' &&
    LIVE_TV_COMMERCIAL_TYPES.includes(m.type) &&
    m.live_tv_assigned !== false
  );
  if (!pool.length) return [];

  const count = _randInt(freq.minSpot, freq.maxSpot);
  const result = [];
  const recentComm = _config.commercial_history || [];

  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    const fresh = available.filter(m => !recentComm.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

async function _playCommercialSequence(commercials) {
  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  const firstComm = commercials[0];
  const remainingComms = commercials.slice(1);
  await setDoc(stateRef, {
    current_item:       _mediaItemToState(firstComm),
    started_at:         serverTimestamp(),
    is_commercial:      true,
    commercial_queue:   remainingComms.map(_mediaItemToState),
    needs_next:         false,
    last_item_id:       firstComm.id,
    queue:              [],
    loop:               false,
    updated_at:         serverTimestamp(),
  }, { merge: true });

  const newCommHist = [...((_config.commercial_history || []).slice(-20)), firstComm.id, ...remainingComms.map(c => c.id)];
  await setDoc(doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID), {
    commercial_history: newCommHist,
    programs_since_break: 0,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

async function _writeNextProgram(justPlayedId, afterCommercial) {
  const program = _pickProgram(justPlayedId);
  if (!program) {
    console.warn('[AURENIX LIVE TV] No eligible programs found.');
    return;
  }

  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  await setDoc(stateRef, {
    current_item:     _mediaItemToState(program),
    started_at:       serverTimestamp(),
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     program.id,
    queue:            [],
    loop:             false,
    updated_at:       serverTimestamp(),
  }, { merge: true });

  const window = _config.avoid_repeat_window || 10;
  const newHistory = [...((_config.recent_history || []).slice(-(window - 1))), program.id];
  const freq = LIVE_TV_COMMERCIAL_FREQ[_config.commercial_freq] || LIVE_TV_COMMERCIAL_FREQ.normal;
  const newSinceBreak = afterCommercial ? 1 : ((_config.programs_since_break || 0) + 1);
  const newTarget = _randInt(freq.minPrograms, freq.maxPrograms);

  await setDoc(doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID), {
    recent_history:       newHistory,
    programs_since_break: newSinceBreak,
    next_break_at:        newTarget,
    updated_at:           serverTimestamp(),
  }, { merge: true });
}

async function _playCommercialBreak() {
  const commercials = _pickCommercials();
  if (!commercials.length) {
    console.warn('[AURENIX LIVE TV] No commercials available for forced break.');
    return false;
  }
  await _playCommercialSequence(commercials);
  return true;
}

function _pickProgram(justPlayedId) {
  const pool = _mediaLib.filter(m =>
    m.status === 'approved' &&
    LIVE_TV_PROGRAM_TYPES.includes(m.type) &&
    m.url &&
    m.live_tv_assigned !== false
  );
  if (!pool.length) return null;

  const recentHistory = _config.recent_history || [];
  const avoidIds = justPlayedId ? [...recentHistory, justPlayedId] : recentHistory;
  let candidates = pool.filter(m => !avoidIds.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== justPlayedId);
  if (!candidates.length) candidates = pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* ═══════════════════════════════════════
   ADVANCE HOOK
   Called by aurenix-broadcast.js when ALTV's current item ends.
═══════════════════════════════════════ */
export async function liveTvChannelAdvance(currentItemId) {
  const stateRef = doc(db, 'network_state', LIVE_TV_CHANNEL_ID);
  const stateSnap = await getDoc(stateRef);
  if (!stateSnap.exists()) return;
  const st = stateSnap.data();

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

  await setDoc(stateRef, {
    needs_next:   true,
    last_item_id: currentItemId || null,
    updated_at:   serverTimestamp(),
  }, { merge: true });
}

/* ═══════════════════════════════════════
   HISTORY READER
═══════════════════════════════════════ */
export async function getLiveTvHistory() {
  const configSnap = await getDoc(doc(db, LIVE_TV_CONFIG_DOC, LIVE_TV_CHANNEL_ID));
  if (!configSnap.exists()) return [];
  return configSnap.data().recent_history || [];
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function _mediaItemToState(m) {
  return {
    id:           m.id,
    title:        m.title || '(untitled)',
    artist:       m.artist  || '',
    type:         m.type    || 'media',
    url:          m.url     || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
  };
}

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
