/* Carry landing — Lenis smooth scroll + the seven-day scroll narrative.
 *
 * Self-contained. This file is only loaded by templates/landing.html, which
 * does not extend base.html, so nothing here touches the app's theme system,
 * dropdowns, or static/js/app.js.
 */
(function () {
'use strict';

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function startLenis(attempt) {
  const a = attempt || 0;
  if (REDUCED) return;                       // never smooth-scroll someone who asked us not to
  if (typeof window.Lenis !== 'function') {
    if (a < 40) setTimeout(() => startLenis(a + 1), 120);
    return;                                  // CDN blocked or offline: native scroll still works
  }
  const lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.9 });
  const loop = t => { lenis.raf(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);

  // Lenis owns the scroll position, so CSS smooth-scroll anchors stop working.
  $$('a[href^="#"]').forEach(el => el.addEventListener('click', e => {
    const target = document.getElementById(el.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { offset: -56 });
  }));
}

function narrative() {
  const week = $('[data-week]');
  if (!week) return;

  // Motion-sensitive readers get the whole week as one readable column instead
  // of a pinned 800vh scroll-jack. Same words, same order, no hijack.
  if (REDUCED) { document.body.classList.add('rm'); return; }

  const days      = $$('[data-day]');
  const rows      = $$('[data-lrow]');
  const field     = $('[data-field]');
  const tint      = $('[data-tint]');
  const statement = $('[data-statement]');
  const slines    = $$('.statement p');
  const total     = $('[data-ltotal]');
  const totalVal  = $('[data-total-val]');
  const ledgerCol = $('[data-ledger-col]');
  const ledgerHd  = $('[data-ledger-head]');
  const hud       = $('[data-hud]');
  const hudBar    = $('[data-hud-bar]');
  const hudLabel  = $('[data-hud-label]');
  const hudDay    = $('[data-hud-day]');
  const photos    = $$('[data-photo]');
  let activePhoto = null;

  const HOLD = 0.63;
  const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const ease  = v => 1 - Math.pow(1 - clamp(v), 3);
  let inked = null;

  function tick() {
    requestAnimationFrame(tick);
    const r = week.getBoundingClientRect();
    const span = r.height - window.innerHeight;
    const t = span > 0 ? clamp(-r.top / span) : 0;
    const p = t * 8;

    for (let i = 0; i < days.length; i++) {
      const el = days[i];
      const l = p - i;
      let o, y;
      if (l < 0)         { const k = ease(clamp((l + 0.45) / 0.45)); o = k; y = 60 * (1 - k); }
      else if (l < HOLD) { o = 1; y = 0; }
      else               { const k = ease(clamp((l - HOLD) / (1 - HOLD))); o = 1 - k; y = -80 * k; }
      el.style.opacity = String(o);
      el.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
      el.style.visibility = o < 0.01 ? 'hidden' : 'visible';

      const row = rows[i];
      if (row) {
        const rk = ease(clamp((l - HOLD) / 0.3));
        row.style.opacity = String(rk);
        row.style.transform = 'translate3d(' + (22 * (1 - rk)).toFixed(2) + 'px,0,0)';
      }
    }

    if (tint) tint.style.opacity = (0.05 + 0.3 * clamp(p / 7)).toFixed(3);

    // Cross-fade the day photo. Only touched when the index actually changes,
    // so this costs nothing on the frames in between.
    const ap = p < 0.35 ? -1 : Math.min(6, Math.floor(p));
    if (ap !== activePhoto) {
      activePhoto = ap;
      photos.forEach((el, i) => {
        el.style.opacity = i === ap ? '1' : '0';
        el.style.zIndex  = i === ap ? '2' : '1';
      });
    }

    const s = clamp(p - 7), se = ease(s);
    if (field) field.style.opacity = String(se);
    if (statement) {
      statement.style.opacity = String(se);
      statement.style.visibility = se < 0.01 ? 'hidden' : 'visible';
    }
    slines.forEach((el, j) => {
      const k = ease(clamp((s - j * 0.18) / 0.5));
      el.style.opacity = String(k);
      el.style.transform = 'translate3d(0,' + (26 * (1 - k)).toFixed(2) + 'px,0)';
    });
    if (total) total.style.opacity = String(ease(clamp((s - 0.25) / 0.4)));

    // The ledger ends up sitting on the ink field, so it has to invert.
    const ink = s > 0.45;
    if (ink !== inked) {
      inked = ink;
      const c    = ink ? 'var(--bg)' : 'var(--ink)';
      const dim  = ink ? 'color-mix(in srgb, var(--bg) 70%, transparent)' : 'var(--n700)';
      const rule = ink ? 'color-mix(in srgb, var(--bg) 45%, transparent)' : 'var(--rule)';
      rows.forEach(row => {
        row.style.color = c;
        row.style.borderTopColor = rule;
        row.style.borderBottomColor = rule;
        const v = $('.v', row);
        if (v) v.style.color = ink ? 'var(--bg)' : 'var(--accent-700)';
      });
      if (ledgerHd)  ledgerHd.style.color = dim;
      if (ledgerCol) ledgerCol.style.borderLeftColor = rule;
      if (total)     total.style.color = c;
    }

    if (hud) {
      hud.style.opacity = (t > 0.001 && t < 0.999) ? '1' : '0';
      const d = Math.min(7, Math.max(1, Math.floor(p) + 1));
      hudLabel.textContent = 'Day ' + d + ' / 7';
      hudDay.textContent   = s > 0.3 ? 'The week' : DAY_NAMES[d - 1];
      hudBar.style.width   = (Math.min(1, p / 7) * 100).toFixed(1) + '%';
    }
    if (totalVal) totalVal.textContent = Math.round(clamp(p / 7) * 134) + '%';
  }
  requestAnimationFrame(tick);
}

// "Open the app" tries to launch the installed PWA; if the browser has no
// installed copy it triggers the install prompt instead, then continues into
// the app either way once that's done. "Visit website" beside it is a plain
// link -- always just the page, no install detour.
function openAppButton() {
  const btn = $('#open-app-btn');
  if (!btn) return;

  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
  });

  btn.addEventListener('click', e => {
    if (!deferred) return; // not installable here (already installed, unsupported
                            // browser, or criteria unmet) -- plain link, same as
                            // clicking any other <a>
    e.preventDefault();
    const href = btn.href;
    deferred.prompt();
    deferred.userChoice.finally(() => {
      deferred = null;
      window.location.href = href; // into the app whether they installed or dismissed
    });
  });
}

// beforeinstallprompt only fires once a service worker is active for this
// page. static/js/app.js normally registers it, but landing.html doesn't
// load app.js (see its own top comment), so this page needs its own.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

startLenis();
narrative();
openAppButton();

})();
