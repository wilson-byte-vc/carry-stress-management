/* carry-ui.js — shared motion + capacity-ring helpers. No dependencies.
   Loaded on every page after app.js. Safe to load twice. */
(function () {
  "use strict";

  var CIRC = 427.2; // 2 * PI * r, with r = 68 — matches the 0 0 160 160 ring.
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function reduced() { return motionQuery.matches; }

  /* --- (c) band lookup -------------------------------------------------- */
  function carryBand(pct) {
    if (pct < 60) return { name: "room", color: "var(--band-room)", slug: "room" };
    if (pct < 85) return { name: "tight", color: "var(--band-tight)", slug: "tight" };
    if (pct <= 100) return { name: "at the line", color: "var(--band-line)", slug: "line" };
    return { name: "over", color: "var(--band-over)", slug: "over" };
  }

  /* --- (b) capacity ring ------------------------------------------------ */
  function carryRing(circleEl, pctEl, bandEl, from, to, ms) {
    if (!circleEl || !pctEl) return;
    cancelAnimationFrame(circleEl._ringFrame);

    var displayed = parseFloat(pctEl.textContent);
    if (circleEl._ringStarted && Number.isFinite(displayed)) from = displayed;
    circleEl._ringStarted = true;

    var band = carryBand(to);
    var duration = ms || 800;

    function paint(value) {
      var b = carryBand(Math.round(value));
      circleEl.setAttribute("stroke-dashoffset", CIRC - (value / 100) * CIRC);
      circleEl.style.stroke = b.color;
      pctEl.innerHTML = Math.round(value) + '<span style="font-size:20px">%</span>';
    }

    if (reduced()) {
      paint(to);
      circleEl.style.stroke = band.color;
      if (bandEl) bandEl.textContent = band.name;
      return;
    }

    var start = null;
    function step(ts) {
      if (!start) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3); // cubic ease-out
      paint(from + (to - from) * eased);
      if (t < 1) circleEl._ringFrame = requestAnimationFrame(step);
      else {
        circleEl.style.stroke = band.color;
        if (bandEl) bandEl.textContent = band.name;
      }
    }
    circleEl._ringFrame = requestAnimationFrame(step);
  }

  /* --- (a) reveal observer ---------------------------------------------- */
  function revealAll(nodes) {
    nodes.forEach(function (el) { el.classList.add("is-visible"); });
  }

  function initReveals() {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll(".motion-reveal, .chart-enter")
    );
    if (!nodes.length) return;

    if (reduced() || !("IntersectionObserver" in window)) {
      revealAll(nodes);
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0, rootMargin: "0px 0px -8% 0px" });

    nodes.forEach(function (el, index) {
      if (!el.style.getPropertyValue("--reveal-delay")) {
        el.style.setProperty("--reveal-delay", (index % 4) * 65 + "ms");
      }
      observer.observe(el);
    });

    // If the preference flips mid-session, drop straight to the final state.
    motionQuery.addEventListener("change", function (event) {
      if (event.matches) { observer.disconnect(); revealAll(nodes); }
    });
  }

  window.carryBand = carryBand;
  window.carryRing = carryRing;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initReveals);
  } else {
    initReveals();
  }
})();
