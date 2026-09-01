(function () {
  "use strict";

  // ---------- Dark theme toggle ----------
  const themeBtn = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-toggle-icon");

  function applyThemeIcon() {
    if (!themeIcon) return;
    const isDark = document.documentElement.dataset.theme === "dark";
    themeIcon.textContent = isDark ? "light_mode" : "dark_mode";
  }
  applyThemeIcon();

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const isDark = document.documentElement.dataset.theme === "dark";
      if (isDark) {
        delete document.documentElement.dataset.theme;
        localStorage.setItem("theme", "light");
      } else {
        document.documentElement.dataset.theme = "dark";
        localStorage.setItem("theme", "dark");
      }
      applyThemeIcon();
    });
  }

  // ---------- Toasts ----------
  function ensureToastLayer() {
    let layer = document.querySelector(".toast-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "toast-layer";
      document.body.appendChild(layer);
    }
    return layer;
  }

  function showToast(message, opts) {
    opts = opts || {};
    const layer = ensureToastLayer();
    const toast = document.createElement("div");
    toast.className = "toast" + (opts.icon ? "" : "");
    toast.innerHTML =
      (opts.icon ? '<span class="material-symbols-outlined">' + opts.icon + "</span>" : "") +
      '<span>' + message + "</span>";
    layer.appendChild(toast);

    // Force layout before adding the visible class so the entrance transition runs.
    requestAnimationFrame(() => toast.classList.add("toast-visible"));

    const remove = () => {
      toast.classList.remove("toast-visible");
      setTimeout(() => toast.remove(), 200);
    };
    setTimeout(remove, opts.duration || 2600);
  }
  window.showToast = showToast;

  // ---------- Live slider labels (check-in page) ----------
  document.querySelectorAll(".checkin-slider").forEach((slider) => {
    let labels;
    try {
      labels = JSON.parse(slider.dataset.labels || "[]");
    } catch (e) {
      labels = [];
    }
    const labelEl = slider.closest(".checkin-item")?.querySelector("[data-live-label]");
    if (!labelEl || !labels.length) return;

    slider.addEventListener("input", () => {
      const idx = Number(slider.value) - 1;
      labelEl.textContent = labels[idx] ?? "";
      labelEl.classList.remove("checkin-live-label-pulse");
      // eslint-disable-next-line no-unused-expressions
      labelEl.offsetWidth; // restart the CSS animation
      labelEl.classList.add("checkin-live-label-pulse");
    });
  });

  // ---------- Landing on a category via #cat-xxx (from the home page) ----------
  // The page loads several webfont weights; if they swap in after the
  // browser's native anchor-jump, the layout shifts and the scroll position
  // drifts off target. Wait for fonts to settle, then scroll deliberately.
  if (location.hash.startsWith("#cat-")) {
    const target = document.querySelector(location.hash);
    if (target) {
      const landOnTarget = () => {
        target.scrollIntoView({ behavior: "auto", block: "start" });
        target.classList.add("checkin-item-highlight");
        setTimeout(() => target.classList.remove("checkin-item-highlight"), 1800);
      };
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(landOnTarget);
      } else {
        landOnTarget();
      }
    }
  }

  // ---------- Toast after a check-in is saved (home page) ----------
  const main = document.querySelector("main[data-just-saved]");
  if (main) {
    showToast("Check-in saved", { icon: "check_circle" });
    // Clean the ?saved=1 out of the URL so a refresh doesn't retoast.
    const url = new URL(location.href);
    url.searchParams.delete("saved");
    history.replaceState(null, "", url.pathname + url.search);
  }

  // ---------- Insight action buttons: give real click feedback ----------
  document.querySelectorAll("[data-insight-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-done")) return;
      btn.classList.add("is-done");
      const original = btn.innerHTML;
      btn.dataset.original = original;
      btn.innerHTML = '<span class="material-symbols-outlined">check</span> Done';
      showToast(btn.dataset.insightAction, { icon: "check_circle" });
    });
  });

  // ---------- Expand/collapse "View detail" on the stress-pattern card ----------
  document.querySelectorAll("[data-toggle-detail]").forEach((btn) => {
    const panel = document.querySelector(btn.dataset.toggleDetail);
    if (!panel) return;
    btn.addEventListener("click", () => {
      const isOpen = panel.classList.toggle("is-open");
      btn.classList.toggle("is-open", isOpen);
    });
  });
})();
