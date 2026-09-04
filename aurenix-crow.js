/**
 * AURENIX — Flying Crow System
 * aurenix-crow.js
 *
 * The signature AURENIX event: a mysterious mechanical-Egyptian crow
 * flies across the viewport and may reveal a secret transmission.
 *
 * Configurable via window.AURENIX_CROW_CONFIG (set before this script)
 * or via the default config below.
 *
 * Design:
 *   - Ancient Egypt + Horror + Futuristic Machinery
 *   - Crow is drawn via SVG with animated wing geometry
 *   - Transmission panel has Egyptian-mechanical styling
 *   - Event is rare enough to feel special (default: ~every 4-8 min)
 */

(function() {
  'use strict';

  /* ════════════════════════════════════
     CONFIGURATION
     Override: window.AURENIX_CROW_CONFIG = { ... }
  ════════════════════════════════════ */
  const defaults = {
    enabled:         true,         // master on/off
    minIntervalMs:   240000,       // 4 minutes minimum between events
    maxIntervalMs:   480000,       // 8 minutes maximum
    showTransmission: true,        // show message after crow passes
    transmissionDelayMs: 1200,     // delay after crow lands before message
    transmissionDurationMs: 9000,  // how long message stays before auto-dismiss
    flightDurationMs: 3800,        // crow crossing time
    crossDirection: 'random',      // 'ltr' | 'rtl' | 'random'
  };

  const cfg = Object.assign({}, defaults, window.AURENIX_CROW_CONFIG || {});

  if (!cfg.enabled) return;

  /* ════════════════════════════════════
     TRANSMISSION MESSAGES
  ════════════════════════════════════ */
  const TRANSMISSIONS = [
    { glyph: '𓅃', message: 'The signal is still alive.', sub: 'AURENIX remembers everything.' },
    { glyph: '𓁹', message: 'The eye does not sleep.', sub: 'Something ancient watches the feed.' },
    { glyph: '𓂀', message: 'Between the stones, a frequency.', sub: 'Tune in before it fades.' },
    { glyph: '𓆄', message: 'The machine breathes.', sub: 'Its gears turn without hands.' },
    { glyph: '𓃭', message: 'You have been marked.', sub: 'Your presence registered in the archive.' },
    { glyph: '𓆙', message: 'Deep beneath the data — something older.', sub: 'AURENIX is listening.' },
    { glyph: '𓀭', message: 'The crow carries a message.', sub: 'Not all signals are meant to be decoded.' },
    { glyph: '𓁨', message: 'The pyramid hums at this frequency.', sub: 'Ancient resonance detected.' },
    { glyph: '𓏌', message: 'The gate is open.', sub: 'Enter while the signal holds.' },
    { glyph: '𓋹', message: 'Power without limit.', sub: 'AURENIX draws from deeper wells.' },
  ];

  let lastMsgIndex = -1;

  function getTransmission() {
    let idx;
    do { idx = Math.floor(Math.random() * TRANSMISSIONS.length); }
    while (idx === lastMsgIndex && TRANSMISSIONS.length > 1);
    lastMsgIndex = idx;
    return TRANSMISSIONS[idx];
  }

  /* ════════════════════════════════════
     DOM REFS
  ════════════════════════════════════ */
  const container    = document.getElementById('crow-container');
  const txPanel      = document.getElementById('crow-transmission');
  const txGlyph      = document.getElementById('crow-tx-glyph');
  const txMessage    = document.getElementById('crow-tx-message');
  const txSub        = document.getElementById('crow-tx-submessage');
  const txClose      = document.getElementById('crow-tx-close');

  if (!container) return;

  /* ════════════════════════════════════
     CROW SVG — Mechanical + Egyptian Raven
     Wings articulate via CSS animation transforms
  ════════════════════════════════════ */
  function buildCrowSVG() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 80 52');
    svg.setAttribute('width', '80');
    svg.setAttribute('height', '52');
    svg.setAttribute('aria-hidden', 'true');

    svg.innerHTML = `
      <style>
        .crow-wing-l { transform-origin: 40px 26px; animation: wingFlapL 0.38s ease-in-out infinite alternate; }
        .crow-wing-r { transform-origin: 40px 26px; animation: wingFlapR 0.38s ease-in-out infinite alternate; }
        @keyframes wingFlapL {
          0%   { transform: rotate(-12deg) scaleY(0.9); }
          100% { transform: rotate(14deg)  scaleY(1.1); }
        }
        @keyframes wingFlapR {
          0%   { transform: rotate(12deg)  scaleY(0.9); }
          100% { transform: rotate(-14deg) scaleY(1.1); }
        }
        .crow-eye-glow { animation: eyeGlowCrow 1.5s ease-in-out infinite alternate; }
        @keyframes eyeGlowCrow {
          0%   { opacity: 0.7; }
          100% { opacity: 1; filter: drop-shadow(0 0 4px #00c9c0); }
        }
        .crow-gear { animation: gearSpin 2s linear infinite; transform-origin: 52px 30px; }
        @keyframes gearSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .crow-circuit { animation: circuitPulse 1.2s ease-in-out infinite alternate; }
        @keyframes circuitPulse { 0% { opacity: 0.3; } 100% { opacity: 0.7; } }
      </style>

      <!-- Left wing -->
      <g class="crow-wing-l">
        <path d="M40,26 L8,12 L14,24 L6,22 L12,30 Z"
          fill="#1a1825" stroke="#b8860b" stroke-width="0.7" opacity="0.95"/>
        <line x1="40" y1="26" x2="8" y2="12" stroke="#00c9c0" stroke-width="0.4" class="crow-circuit"/>
      </g>

      <!-- Right wing -->
      <g class="crow-wing-r">
        <path d="M40,26 L72,12 L66,24 L74,22 L68,30 Z"
          fill="#1a1825" stroke="#b8860b" stroke-width="0.7" opacity="0.95"/>
        <line x1="40" y1="26" x2="72" y2="12" stroke="#00c9c0" stroke-width="0.4" class="crow-circuit"/>
      </g>

      <!-- Body -->
      <ellipse cx="40" cy="28" rx="12" ry="9"
        fill="#0e0d12" stroke="#b8860b" stroke-width="0.8"/>

      <!-- Mechanical chest plate -->
      <rect x="33" y="25" width="14" height="7" rx="2"
        fill="#161420" stroke="#4a4560" stroke-width="0.5"/>
      <line x1="35" y1="28.5" x2="45" y2="28.5" stroke="#00c9c0" stroke-width="0.3" class="crow-circuit"/>
      <line x1="40" y1="25" x2="40" y2="32" stroke="#00c9c0" stroke-width="0.3" class="crow-circuit"/>

      <!-- Neck + head -->
      <path d="M40,19 Q44,16 48,18 Q50,22 47,25 Q44,20 40,20 Z"
        fill="#0e0d12" stroke="#b8860b" stroke-width="0.7"/>

      <!-- Beak — hooked, mechanical -->
      <path d="M47,19 L56,17 L54,21 L47,22 Z"
        fill="#b8860b" stroke="#d4a017" stroke-width="0.5"/>
      <line x1="56" y1="17" x2="60" y2="16" stroke="#b8860b" stroke-width="0.6" opacity="0.5"/>

      <!-- Egyptian eye -->
      <ellipse cx="50" cy="19" rx="2.5" ry="2" fill="#00c9c0" class="crow-eye-glow"/>
      <circle cx="50" cy="19" r="1.2" fill="#0a0a0f"/>
      <!-- Eye of Horus kohl line -->
      <path d="M47.5,21 Q50,22.5 52.5,21" fill="none" stroke="#b8860b" stroke-width="0.5" opacity="0.7"/>

      <!-- Small gear on body -->
      <g class="crow-gear">
        <circle cx="52" cy="30" r="3" fill="none" stroke="#4a4560" stroke-width="0.6"/>
        <circle cx="52" cy="30" r="1.2" fill="#252235"/>
        <line x1="52" y1="27" x2="52" y2="25.5" stroke="#4a4560" stroke-width="0.6"/>
        <line x1="52" y1="33" x2="52" y2="34.5" stroke="#4a4560" stroke-width="0.6"/>
        <line x1="49" y1="30" x2="47.5" y2="30" stroke="#4a4560" stroke-width="0.6"/>
        <line x1="55" y1="30" x2="56.5" y2="30" stroke="#4a4560" stroke-width="0.6"/>
      </g>

      <!-- Tail feathers -->
      <path d="M28,30 L22,36 L26,33 L20,40 L28,34 L24,42 Z"
        fill="#0e0d12" stroke="#b8860b" stroke-width="0.6" opacity="0.8"/>

      <!-- Talons -->
      <path d="M36,37 L33,44 M36,37 L36,44 M36,37 L39,44"
        stroke="#4a4560" stroke-width="1" stroke-linecap="round" fill="none"/>
      <path d="M44,37 L41,44 M44,37 L44,44 M44,37 L47,44"
        stroke="#4a4560" stroke-width="1" stroke-linecap="round" fill="none"/>

      <!-- Egyptian headdress stripe hint -->
      <path d="M44,16 Q48,14 52,15" fill="none" stroke="#b8860b" stroke-width="0.7" opacity="0.5"/>
    `;
    return svg;
  }

  /* ════════════════════════════════════
     CROW FLIGHT ENGINE
  ════════════════════════════════════ */
  let crowActive   = false;
  let txTimer      = null;
  let schedTimer   = null;

  function launchCrow() {
    if (crowActive) return;
    crowActive = true;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Direction
    const dir = cfg.crossDirection === 'random'
      ? (Math.random() > 0.5 ? 'ltr' : 'rtl')
      : cfg.crossDirection;

    const startX = dir === 'ltr' ? -100 : vw + 100;
    const endX   = dir === 'ltr' ? vw + 100 : -100;

    // Vertical position: somewhere in upper-mid area (avoid nav bar)
    const startY = 90 + Math.random() * (vh * 0.35);

    // Gentle arc — slightly above or below midpoint
    const midY   = startY - 30 - Math.random() * 60;

    // Build crow element
    const crowWrap = document.createElement('div');
    crowWrap.className = 'crow-svg';
    crowWrap.style.cssText = `
      position: absolute;
      top: ${startY}px;
      left: ${startX}px;
      transform: ${dir === 'rtl' ? 'scaleX(-1)' : ''};
    `;

    crowWrap.appendChild(buildCrowSVG());
    container.appendChild(crowWrap);

    // Animate via keyframes
    const totalMs = cfg.flightDurationMs;
    let startTime = null;

    function fly(ts) {
      if (!startTime) startTime = ts;
      const elapsed = ts - startTime;
      const t = Math.min(elapsed / totalMs, 1);

      // Bezier-like arc: linear x, quadratic y
      const x = startX + (endX - startX) * t;
      const y = startY + (midY - startY) * Math.sin(t * Math.PI);

      crowWrap.style.left = x + 'px';
      crowWrap.style.top  = y + 'px';

      if (t < 1) {
        requestAnimationFrame(fly);
      } else {
        // Crow has passed — clean up
        crowWrap.remove();
        crowActive = false;

        // Show transmission after delay
        if (cfg.showTransmission) {
          clearTimeout(txTimer);
          txTimer = setTimeout(showTransmission, cfg.transmissionDelayMs);
        } else {
          scheduleNext();
        }
      }
    }

    requestAnimationFrame(fly);
  }

  /* ════════════════════════════════════
     TRANSMISSION PANEL
  ════════════════════════════════════ */
  function showTransmission() {
    const tx = getTransmission();
    if (txGlyph)   txGlyph.textContent   = tx.glyph;
    if (txMessage) txMessage.textContent = tx.message;
    if (txSub)     txSub.textContent     = tx.sub;

    txPanel.classList.add('visible');
    txPanel.removeAttribute('aria-hidden');

    // Auto-dismiss
    clearTimeout(txTimer);
    txTimer = setTimeout(hideTransmission, cfg.transmissionDurationMs);
  }

  function hideTransmission() {
    txPanel.classList.remove('visible');
    txPanel.setAttribute('aria-hidden', 'true');
    scheduleNext();
  }

  if (txClose) {
    txClose.addEventListener('click', () => {
      clearTimeout(txTimer);
      hideTransmission();
    });
  }

  /* ════════════════════════════════════
     SCHEDULER
  ════════════════════════════════════ */
  function scheduleNext() {
    const delay = cfg.minIntervalMs
      + Math.random() * (cfg.maxIntervalMs - cfg.minIntervalMs);
    clearTimeout(schedTimer);
    schedTimer = setTimeout(launchCrow, delay);
  }

  // Initial random first appearance (1-3 minutes after load)
  setTimeout(launchCrow, 60000 + Math.random() * 120000);

  /* ════════════════════════════════════
     PUBLIC API
     window.aurenixCrow.launch()         — force a crow
     window.aurenixCrow.setConfig(obj)   — update config live
     window.aurenixCrow.disable()        — turn off
     window.aurenixCrow.enable()         — turn back on
  ════════════════════════════════════ */
  window.aurenixCrow = {
    launch: launchCrow,
    setConfig: obj => Object.assign(cfg, obj),
    disable: () => { cfg.enabled = false; clearTimeout(schedTimer); clearTimeout(txTimer); },
    enable:  () => { cfg.enabled = true; scheduleNext(); },
    showTransmission,
    hideTransmission,
  };

})();
