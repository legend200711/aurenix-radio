/**
 * AURENIX RADIO — Navigation System
 * aurenix-nav.js
 *
 * Handles:
 *   - Section routing (Radio / My Submissions / Admin)
 *   - Active state management for nav links
 *   - Mobile hamburger drawer
 *   - URL hash routing (#radio, #mysubs, #admin)
 *
 * Pages: radio (default), mysubs, admin
 */

(function() {
  'use strict';

  /* ── Valid page IDs ── */
  const PAGES = ['radio', 'mysubs', 'admin'];

  /* ── Cached DOM ── */
  const pages    = {};
  const navLinks = [];
  const hamburger = document.getElementById('nav-hamburger');
  const drawer    = document.getElementById('nav-drawer');

  PAGES.forEach(id => {
    pages[id] = document.getElementById('page-' + id);
  });

  /* ── Gather ALL nav-link buttons (desktop + drawer) ── */
  document.querySelectorAll('.nav-link[data-page]').forEach(btn => {
    navLinks.push(btn);
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  /* ── Back buttons inside section headers ── */
  document.querySelectorAll('.section-back[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  /* ── Logo → Radio ── */
  const logoBtn = document.getElementById('nav-logo-btn');
  if (logoBtn) {
    logoBtn.addEventListener('click', () => navigateTo('radio'));
    logoBtn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo('radio'); }
    });
  }

  /* ── Hamburger ── */
  if (hamburger && drawer) {
    hamburger.addEventListener('click', () => {
      const open = drawer.classList.toggle('open');
      hamburger.classList.toggle('open', open);
      hamburger.setAttribute('aria-expanded', open);
    });

    drawer.querySelectorAll('.nav-link').forEach(btn => {
      btn.addEventListener('click', () => {
        drawer.classList.remove('open');
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ── Core navigate function ── */
  function navigateTo(pageId) {
    if (!PAGES.includes(pageId)) return;

    // Update visible pages
    PAGES.forEach(id => {
      const pg = pages[id];
      if (!pg) return;
      const active = id === pageId;
      pg.classList.toggle('active', active);
      pg.style.display = active ? '' : 'none';
    });

    // Update nav link active state (only for links that are currently visible)
    navLinks.forEach(btn => {
      if (btn.dataset.page === pageId) {
        btn.classList.add('active');
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.classList.remove('active');
        btn.removeAttribute('aria-current');
      }
    });

    // Update hash
    if (history.replaceState) {
      history.replaceState(null, '', pageId === 'radio' ? '#' : '#' + pageId);
    }

    // Notify modules
    window.dispatchEvent(new CustomEvent('aurenix:navigate', { detail: { page: pageId } }));
  }

  /* ── Hash-based initial routing ── */
  function routeFromHash() {
    const hash = window.location.hash.replace('#', '').toLowerCase();
    if (PAGES.includes(hash)) {
      navigateTo(hash);
    } else {
      navigateTo('radio');
    }
  }

  /* ── Init ── */
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);

  /* ── Expose for external use ── */
  window.AURENIX_NAV = { navigateTo };

})();
