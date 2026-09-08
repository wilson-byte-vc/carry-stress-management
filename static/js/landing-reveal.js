/* Carry landing — scroll reveal for the static sections.
 *
 * Deliberately separate from static/js/landing.js: that file owns the pinned
 * seven-day narrative (its own scroll maths, inline styles and colour
 * inversion) and nothing here touches it. This file only handles the sections
 * outside [data-week] — hero, handoff, footer — where words rise into place as
 * the block scrolls in.
 *
 * Progressive enhancement: landing.html sets html.js-reveal in <head>, which is
 * the only thing that hides the copy. If this script never runs, or the reader
 * asked for reduced motion, the class comes off (or was never honoured) and the
 * page is plain, fully readable text.
 */
(function () {
'use strict';

var root = document.documentElement;
var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Give up cleanly: dropping the class un-hides everything at once.
function showEverything() { root.classList.remove('js-reveal'); }

if (REDUCED || !('IntersectionObserver' in window)) { showEverything(); return; }

var targets = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
if (!targets.length) { showEverything(); return; }

/* Wrap each word in <span class="w"><span>word</span></span> so the outer span
 * can clip while the inner one slides up. Walks text nodes only, so inline
 * markup (<strong>, <em>) and entities survive untouched, and whitespace is
 * left in place as its own text node to keep natural wrapping. */
function splitWords(el) {
  var i = 0;
  (function walk(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (child) {
      if (child.nodeType === 3) {
        if (!child.nodeValue.trim()) return;
        var frag = document.createDocumentFragment();
        child.nodeValue.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
          var outer = document.createElement('span');
          outer.className = 'w';
          outer.style.setProperty('--i', String(i++));
          var inner = document.createElement('span');
          inner.textContent = part;
          outer.appendChild(inner);
          frag.appendChild(outer);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1 &&
                 child.namespaceURI !== 'http://www.w3.org/2000/svg') {
        walk(child);
      }
    });
  })(el);
}

targets.forEach(function (el) {
  if (el.getAttribute('data-reveal') === 'words') {
    var step = el.getAttribute('data-step');
    if (step) el.style.setProperty('--step', step);
    splitWords(el);
  }
});

/* start: 'top 90%' — the block begins as its top crosses the last tenth of the
 * viewport. Revealed once, then unobserved: scrolling back up must not replay
 * a paragraph the reader has already read. */
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in');
    io.unobserve(entry.target);
  });
}, { rootMargin: '0px 0px -10% 0px', threshold: 0 });

targets.forEach(function (el) { io.observe(el); });

})();
