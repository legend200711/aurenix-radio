/**
 * AURENIX — Background Particle / Atmosphere System
 * aurenix-bg.js
 *
 * Renders the atmospheric canvas: ancient dust particles, energy motes,
 * mechanical scan sparks. Performance-optimized (reduced count on mobile,
 * pauses when tab is hidden).
 */

(function() {
  'use strict';

  const canvas = document.getElementById('aurenix-particle-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  let raf = null;
  let paused = false;

  /* ── Detect mobile for particle budget ── */
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const PARTICLE_COUNT = isMobile ? 40 : 80;

  /* ── Particle types ── */
  const TYPES = [
    { hue: 43,  sat: 70,  lit: 50, alpha: [0.08, 0.22], r: [0.6, 1.4], vy: [-0.18, -0.06], vx: [-0.1, 0.1] },  // gold dust
    { hue: 178, sat: 100, lit: 56, alpha: [0.06, 0.20], r: [0.5, 1.2], vy: [-0.22, -0.08], vx: [-0.12, 0.12] }, // energy cyan
    { hue: 0,   sat: 0,   lit: 80, alpha: [0.03, 0.10], r: [0.4, 0.9], vy: [-0.08, -0.02], vx: [-0.05, 0.05] }, // ancient dust
  ];

  let particles = [];

  function mkParticle(forceY) {
    const t = TYPES[Math.floor(Math.random() * TYPES.length)];
    return {
      x:     Math.random() * W,
      y:     forceY !== undefined ? forceY : Math.random() * H,
      r:     t.r[0]    + Math.random() * (t.r[1]    - t.r[0]),
      vx:    t.vx[0]   + Math.random() * (t.vx[1]   - t.vx[0]),
      vy:    t.vy[0]   + Math.random() * (t.vy[1]   - t.vy[0]),
      alpha: t.alpha[0] + Math.random() * (t.alpha[1] - t.alpha[0]),
      hue:   t.hue, sat: t.sat, lit: t.lit,
      life:  0,
      maxLife: 200 + Math.random() * 400,
    };
  }

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function init() {
    resize();
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(mkParticle());
    }
  }

  function draw() {
    if (paused) { raf = requestAnimationFrame(draw); return; }

    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life++;

      // Fade in/out
      const lifeRatio = p.life / p.maxLife;
      const fade = lifeRatio < 0.1
        ? lifeRatio / 0.1
        : lifeRatio > 0.8
          ? 1 - (lifeRatio - 0.8) / 0.2
          : 1;

      if (p.life >= p.maxLife || p.y < -10) {
        particles[i] = mkParticle(H + 5);
        continue;
      }

      ctx.globalAlpha = p.alpha * fade;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${p.hue},${p.sat}%,${p.lit}%)`;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(draw);
  }

  /* ── Visibility pause ── */
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
  });

  window.addEventListener('resize', () => {
    resize();
    // Reposition out-of-bounds particles
    particles.forEach(p => {
      if (p.x > W) p.x = Math.random() * W;
      if (p.y > H) p.y = Math.random() * H;
    });
  }, { passive: true });

  /* ── Build Egyptian column silhouettes ── */
  function buildColumns() {
    const colContainer = document.getElementById('bg-columns');
    if (!colContainer) return;
    // Vary height for ancient ruins feel
    const heights = [35, 42, 28, 55, 38, 45, 30, 52, 36, 48];
    colContainer.innerHTML = '';
    heights.forEach(h => {
      const col = document.createElement('div');
      col.className = 'bg-col';
      col.style.height = h + 'vh';
      colContainer.appendChild(col);
    });
  }

  init();
  buildColumns();
  draw();
})();
