/**
 * AURENIX ONE — Live TV Programming Engine
 * aurenix-one-engine.js
 *
 * Implements the 24/7 live-TV channel for AURENIX ONE (channel ID: A1).
 *
 * How it works:
 *   - The Founder starts the channel engine from Founder Studio.
 *   - The engine picks a random approved program from the media library.
 *   - After each program ends, the engine is re-triggered by the
 *     broadcast's _advance() writing a sentinel "auto_advance" flag to
 *     network_state/A1 — OR via a live Firestore listener watching for
 *     the "needs_next" flag, which is set by the advance function.
 *   - The engine writes the next program + optional commercial break to
 *     network_state/A1.  All viewers read this shared state — there is
 *     no per-viewer playlist.
 *
 * Firestore collections used:
 *   network_state/A1          — live playback state (shared by all viewers)
 *   channel_one_config/A1     — engine settings (commercial freq, history)
 *   network_media/{id}        — the approved media pool
 *
 * Security: writes to network_state & channel_one_config require isAdmin().
 * Viewers only read network_state (public read).
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
export const ONE_CHANNEL_ID = 'A1';
const CONFIG_DOC = 'channel_one_config';

// Media types eligible for AURENIX ONE main programming
const PROGRAM_TYPES = [
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
];

// Media types that count as commercials
const COMMERCIAL_TYPES = ['commercial', 'promo', 'trailer', 'station_id'];

// Commercial frequency configs
export const COMMERCIAL_FREQ = {
  off:    { label: 'OFF',    minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
  low:    { label: 'Low',    minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
  normal: { label: 'Normal', minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
  high:   { label: 'High',   minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
};

const DEFAULT_CONFIG = {
  running:           false,
  commercial_freq:   'normal',
  min_programs:      2,
  max_programs:      4,
  min_spots:         1,
  max_spots:         2,
  avoid_repeat_window: 10,    // don't replay same item within last N played
  recent_history:    [],      // array of last N media IDs played
  commercial_history:[],      // last few commercial IDs played
  programs_since_break: 0,    // counter reset after each commercial break
  next_break_at:     3,       // advance counter target before next break
  paused:            false,
  updated_at:        null,
};

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let _config        = { ...DEFAULT_CONFIG };
let _mediaLib      = [];   // full approved library snapshot
let _configUnsub   = null; // Firestore listener for config
let _stateUnsub    = null; // Firestore listener for needs_next flag
let _engineActive  = false;
let _advancing     = false;

/* ═══════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════ */

/**
 * Start the AURENIX ONE engine.
 * Pass the current approved media library from the caller.
 * The engine subscribes to Firestore and drives the channel automatically.
 */
export async function startOneEngine(mediaLib) {
  // ── Auth pre-flight ──────────────────────────────────────────────
  // Force a token refresh so Firestore receives a current ID token.
  // This guards against the race where auth.currentUser exists but the
  // token cached by the Firestore SDK is stale or not yet issued.
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Please log in to continue.');
  }
  try {
    await currentUser.getIdToken(/* forceRefresh= */ true);
  } catch (tokenErr) {
    console.error('[AURENIX ONE] Token refresh failed:', tokenErr);
    // Non-fatal — proceed with the existing token.
  }
  // ────────────────────────────────────────────────────────────────

  _mediaLib = mediaLib;
  _engineActive = true;

  // Load or create config
  const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
  const configSnap = await getDoc(configRef);
  if (configSnap.exists()) {
    _config = { ...DEFAULT_CONFIG, ...configSnap.data() };
  } else {
    await setDoc(configRef, { ...DEFAULT_CONFIG, running: true, updated_at: serverTimestamp() });
    _config = { ...DEFAULT_CONFIG, running: true };
  }

  // Subscribe to config changes (Founder adjusting settings live)
  if (_configUnsub) _configUnsub();
  _configUnsub = onSnapshot(configRef, snap => {
    if (snap.exists()) {
      _config = { ...DEFAULT_CONFIG, ...snap.data() };
    }
  });

  // Mark as running
  await setDoc(configRef, { running: true, paused: false, updated_at: serverTimestamp() }, { merge: true });

  // Watch network_state/A1 for needs_next flag
  _subscribeStateForAdvance();

  // Kick off the channel immediately if nothing is playing
  const stateRef  = doc(db, 'network_state', ONE_CHANNEL_ID);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  if (!st?.current_item || _config.running) {
    await _scheduleNextProgram(null);
  }
}

/**
 * Stop the engine cleanly.
 */
export async function stopOneEngine() {
  _engineActive = false;
  if (_stateUnsub)  { _stateUnsub();  _stateUnsub  = null; }
  if (_configUnsub) { _configUnsub(); _configUnsub = null; }
  const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
  await setDoc(configRef, { running: false, updated_at: serverTimestamp() }, { merge: true });
}

/**
 * Pause the broadcast (channel goes dark but engine stays subscribed).
 */
export async function pauseOneEngine() {
  const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
  await setDoc(configRef, { paused: true, updated_at: serverTimestamp() }, { merge: true });
  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);
  await setDoc(stateRef, { current_item: null, started_at: serverTimestamp() }, { merge: true });
}

/**
 * Resume from pause — pick the next program.
 */
export async function resumeOneEngine() {
  const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
  await setDoc(configRef, { paused: false, updated_at: serverTimestamp() }, { merge: true });
  await _scheduleNextProgram(null);
}

/**
 * Force a commercial break right now.
 */
export async function forceCommercialBreak() {
  await _playCommercialBreak();
}

/**
 * Skip the current program and pick the next one (with optional commercial).
 */
export async function skipCurrentProgram() {
  const stateRef  = doc(db, 'network_state', ONE_CHANNEL_ID);
  const stateSnap = await getDoc(stateRef);
  const st = stateSnap.exists() ? stateSnap.data() : null;
  await _scheduleNextProgram(st?.current_item?.id || null);
}

/**
 * Refresh the media library reference (called when library changes).
 */
export function updateMediaLib(mediaLib) {
  _mediaLib = mediaLib;
}

/**
 * Save config settings to Firestore.
 */
export async function saveOneConfig(updates) {
  const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
  await setDoc(configRef, { ...updates, updated_at: serverTimestamp() }, { merge: true });
}

/**
 * Get the current engine config.
 */
export function getOneConfig() { return { ..._config }; }

/* ═══════════════════════════════════════
   INTERNAL — STATE WATCHER
═══════════════════════════════════════ */

/**
 * Watch network_state/A1.
 * When needs_next === true it means the current item finished and the engine
 * must schedule the next one.
 */
function _subscribeStateForAdvance() {
  if (_stateUnsub) _stateUnsub();
  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);
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

/**
 * Pick the next program and write it to network_state/A1.
 * @param {string|null} justPlayedId — the media ID that just finished (to avoid immediate repeat)
 */
async function _scheduleNextProgram(justPlayedId) {
  if (_advancing) return;
  _advancing = true;

  try {
    if (!_engineActive) { _advancing = false; return; }
    if (_config.paused)  { _advancing = false; return; }

    // Re-read config freshly
    const configRef = doc(db, CONFIG_DOC, ONE_CHANNEL_ID);
    const configSnap = await getDoc(configRef);
    if (configSnap.exists()) _config = { ...DEFAULT_CONFIG, ...configSnap.data() };

    if (!_config.running) { _advancing = false; return; }

    // Should we run a commercial break before the next program?
    const shouldBreak = _shouldRunCommercialBreak();

    let commercials = [];
    if (shouldBreak) {
      commercials = _pickCommercials();
      if (commercials.length > 0) {
        await _playCommercialSequence(commercials, null);
        // After commercials, schedule the actual next program
        await _writeNextProgram(justPlayedId, true);
      } else {
        // No commercials available — just schedule next program
        await _writeNextProgram(justPlayedId, false);
      }
    } else {
      await _writeNextProgram(justPlayedId, false);
    }
  } catch (e) {
    console.error('[AURENIX ONE] _scheduleNextProgram error:', e);
  }

  _advancing = false;
}

/** Determine whether a commercial break should run now. */
function _shouldRunCommercialBreak() {
  const freq = COMMERCIAL_FREQ[_config.commercial_freq] || COMMERCIAL_FREQ.normal;
  if (freq.maxSpot === 0) return false;

  const since = _config.programs_since_break || 0;
  const target = _config.next_break_at || freq.minPrograms;
  return since >= target;
}

/** Pick 1–N commercials from the commercial pool. */
function _pickCommercials() {
  const freq = COMMERCIAL_FREQ[_config.commercial_freq] || COMMERCIAL_FREQ.normal;
  const pool = _mediaLib.filter(m =>
    m.status === 'approved' &&
    COMMERCIAL_TYPES.includes(m.type)
  );
  if (!pool.length) return [];

  const count = _randInt(freq.minSpot, freq.maxSpot);
  const result = [];
  const recentComm = _config.commercial_history || [];

  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    // Prefer commercials not recently played
    const fresh = available.filter(m => !recentComm.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

/** Write a sequence of commercials then set needs_next when done. */
async function _playCommercialSequence(commercials, _unused) {
  // Build a mini-queue: commercials followed by a sentinel item that triggers needs_next
  // We write them one at a time via timeout-based local scheduling, using Firestore
  // as the shared clock so all viewers advance together.
  //
  // Because the actual advance is driven by duration_sec (the viewer's tick triggers
  // _advance() which sets needs_next), we just write the FIRST commercial now
  // and let the tick handle the rest through the queue mechanism.
  // We embed the commercial sequence into the state as a "commercial_queue" so
  // the engine knows to process them in order.

  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);
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

  // Update commercial history
  const newCommHist = [...((_config.commercial_history || []).slice(-20)), firstComm.id, ...remainingComms.map(c => c.id)];
  await setDoc(doc(db, CONFIG_DOC, ONE_CHANNEL_ID), {
    commercial_history: newCommHist,
    programs_since_break: 0,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

/** Write the next main program to network_state/A1. */
async function _writeNextProgram(justPlayedId, afterCommercial) {
  const program = _pickProgram(justPlayedId);
  if (!program) {
    console.warn('[AURENIX ONE] No eligible programs found.');
    return;
  }

  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);
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

  // Update history + program counter
  const window = _config.avoid_repeat_window || 10;
  const newHistory = [...((_config.recent_history || []).slice(-(window - 1))), program.id];

  const freq = COMMERCIAL_FREQ[_config.commercial_freq] || COMMERCIAL_FREQ.normal;
  const newSinceBreak = afterCommercial ? 1 : ((_config.programs_since_break || 0) + 1);
  const newTarget = _randInt(freq.minPrograms, freq.maxPrograms);

  await setDoc(doc(db, CONFIG_DOC, ONE_CHANNEL_ID), {
    recent_history:       newHistory,
    programs_since_break: newSinceBreak,
    next_break_at:        newTarget,
    updated_at:           serverTimestamp(),
  }, { merge: true });
}

/** Force a commercial break right now (public action). */
async function _playCommercialBreak() {
  const commercials = _pickCommercials();
  if (!commercials.length) {
    console.warn('[AURENIX ONE] No commercials available for forced break.');
    return false;
  }
  await _playCommercialSequence(commercials, null);
  return true;
}

/** Pick a random program, avoiding recent repeats. */
function _pickProgram(justPlayedId) {
  const pool = _mediaLib.filter(m =>
    m.status === 'approved' &&
    PROGRAM_TYPES.includes(m.type) &&
    m.url
  );
  if (!pool.length) return null;

  const recentHistory = _config.recent_history || [];
  const avoidIds = justPlayedId ? [...recentHistory, justPlayedId] : recentHistory;

  // Try to find something not recently played
  let candidates = pool.filter(m => !avoidIds.includes(m.id));

  // If everything was recently played (small library), allow repeats except the just-played item
  if (!candidates.length) {
    candidates = pool.filter(m => m.id !== justPlayedId);
  }

  // If still nothing (only one item in library), play it anyway
  if (!candidates.length) {
    candidates = pool;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* ═══════════════════════════════════════
   INTERNAL — ADVANCE HOOK
   Called by the broadcast engine in aurenix-broadcast.js
   when channel A1's current item ends.
═══════════════════════════════════════ */

/**
 * Called instead of the regular queue-based advance for channel A1.
 * Writes needs_next=true + last_item_id to trigger the engine.
 * The engine's Firestore listener picks this up and schedules the next program.
 */
export async function oneChannelAdvance(currentItemId) {
  const stateRef = doc(db, 'network_state', ONE_CHANNEL_ID);

  // Check for a queued commercial — if we had a commercial_queue, play next in sequence
  const stateSnap = await getDoc(stateRef);
  if (!stateSnap.exists()) return;
  const st = stateSnap.data();

  const commQueue = st.commercial_queue || [];
  if (commQueue.length > 0) {
    // Play the next commercial in the sequence
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

  // No more commercials — signal engine to pick next program
  await setDoc(stateRef, {
    needs_next:    true,
    last_item_id:  currentItemId || null,
    updated_at:    serverTimestamp(),
  }, { merge: true });
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

/* ═══════════════════════════════════════
   BROADCAST HISTORY READER
   (used by Founder Studio to show history)
═══════════════════════════════════════ */
export async function getOneHistory() {
  const configSnap = await getDoc(doc(db, CONFIG_DOC, ONE_CHANNEL_ID));
  if (!configSnap.exists()) return [];
  const data = configSnap.data();
  return data.recent_history || [];
}

export async function getOneState() {
  const stateSnap = await getDoc(doc(db, 'network_state', ONE_CHANNEL_ID));
  return stateSnap.exists() ? stateSnap.data() : null;
}
