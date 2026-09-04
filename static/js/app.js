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

  // Installed as a PWA, the OS paints the status bar with theme-color, so it
  // has to follow the toggle or dark mode keeps a light bar above it.
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function paintThemeControls() {
    const theme = currentTheme();
    if (themeIcon) themeIcon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    if (themeMeta) themeMeta.content = theme === "dark" ? "#19191a" : "#286653";
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

  // ---------- Service worker (PWA) ----------
  // Registered after load so it never competes with the page's own requests
  // for bandwidth on a first visit.
  if ("serviceWorker" in navigator) {
    addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* file:// , an unsupported browser, or plain http on a non-localhost
           host -- the site works fine without it, it just isn't installable */
      });
    });
  }

  // ---------- Install prompt ----------
  // Chrome fires this instead of showing its own prompt; stash it so the
  // "Install app" button in the settings panel has something to trigger.
  let installPrompt = null;
  const installBtn = document.getElementById("install-app");

  function paintInstallBtn() {
    if (!installBtn) return;
    installBtn.hidden = !installPrompt;
  }
  paintInstallBtn();

  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    paintInstallBtn();
  });

  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      // The event is single-use -- Chrome fires a fresh one if they decline
      // and become eligible again.
      installPrompt = null;
      paintInstallBtn();
    });
  }

  addEventListener("appinstalled", () => {
    installPrompt = null;
    paintInstallBtn();
    showToast("Balance installed", { icon: "check_circle" });
  });

  // ---------- Header dropdowns (settings + account) ----------
  // One implementation drives every [data-dropdown]; opening one closes the
  // others so the two panels can't overlap each other.
  const dropdowns = [...document.querySelectorAll("[data-dropdown]")].map((menu) => ({
    menu: menu,
    toggle: menu.querySelector("[data-dropdown-toggle]"),
    panel: menu.querySelector("[data-dropdown-panel]"),
  })).filter((d) => d.toggle && d.panel);

  function setDropdownOpen(entry, open) {
    entry.panel.hidden = !open;
    entry.menu.classList.toggle("is-open", open);
    entry.toggle.setAttribute("aria-expanded", String(open));
  }

  function closeAllDropdowns(except) {
    dropdowns.forEach((d) => {
      if (d !== except) setDropdownOpen(d, false);
    });
  }

  dropdowns.forEach((entry) => {
    entry.toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = entry.panel.hidden;
      closeAllDropdowns(entry);
      setDropdownOpen(entry, willOpen);
    });
  });

  if (dropdowns.length) {
    // Click anywhere outside (or Escape) closes whichever is open.
    document.addEventListener("click", (event) => {
      dropdowns.forEach((d) => {
        if (!d.panel.hidden && !d.menu.contains(event.target)) setDropdownOpen(d, false);
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const open = dropdowns.find((d) => !d.panel.hidden);
      if (open) {
        setDropdownOpen(open, false);
        open.toggle.focus();
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

  // ---------- Effort slider readout (add-commitment form) ----------
  const effortInput = document.querySelector("[data-effort-input]");
  const effortOut = document.querySelector("[data-effort-out]");
  if (effortInput && effortOut) {
    effortInput.addEventListener("input", () => {
      effortOut.textContent = effortInput.value;
    });
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
