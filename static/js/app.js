(function () {
  "use strict";

  const root = document.documentElement;
  const isAuthed = root.dataset.authed === "1";

  // ---------- Theme ----------
  // Two controls drive the same state: the header icon and the Light/Dark
  // buttons inside the settings panel. Both route through setTheme so they
  // can never disagree.
  const themeBtn = document.getElementById("theme-toggle");
  const themeIcon = document.getElementById("theme-toggle-icon");
  const themeChoices = document.querySelectorAll("[data-set-theme]");

  function currentTheme() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function paintThemeControls() {
    const theme = currentTheme();
    if (themeIcon) themeIcon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    themeChoices.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setTheme === theme);
    });
  }

  function setTheme(theme) {
    if (theme === "dark") {
      root.dataset.theme = "dark";
    } else {
      delete root.dataset.theme;
    }
    // Keep localStorage current either way -- it's what a logged-out visitor
    // (or a pre-paint load) reads back.
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {
      /* private mode / storage disabled -- theme just won't persist */
    }
    paintThemeControls();

    // Signed in? Persist server-side so the preference follows the account.
    if (isAuthed) {
      fetch("/settings/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: theme }),
      }).catch(() => {
        /* offline -- localStorage still holds it for this browser */
      });
    }
  }

  paintThemeControls();

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      setTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  }
  themeChoices.forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.setTheme));
  });

  // ---------- Settings dropdown ----------
  const settingsMenu = document.querySelector(".settings-menu");
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");

  if (settingsMenu && settingsToggle && settingsPanel) {
    const setOpen = (open) => {
      settingsPanel.hidden = !open;
      settingsMenu.classList.toggle("is-open", open);
      settingsToggle.setAttribute("aria-expanded", String(open));
    };

    settingsToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(settingsPanel.hidden);
    });

    // Click anywhere outside (or Escape) closes it.
    document.addEventListener("click", (event) => {
      if (!settingsPanel.hidden && !settingsMenu.contains(event.target)) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !settingsPanel.hidden) {
        setOpen(false);
        settingsToggle.focus();
      }
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

  // ---------- Server-side flash messages -> toasts ----------
  const flashEl = document.getElementById("flash-data");
  if (flashEl) {
    try {
      JSON.parse(flashEl.textContent).forEach((message, i) => {
        setTimeout(() => showToast(message, { icon: "info" }), i * 300);
      });
    } catch (e) {
      /* malformed payload -- not worth breaking the page over */
    }
  }

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
