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
    return root.dataset.theme === "light" ? "light" : "dark";
  }

  // Installed as a PWA, the OS paints the status bar with theme-color, so it
  // has to follow the toggle or dark mode keeps a light bar above it.
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function paintThemeControls() {
    const theme = currentTheme();
    if (themeIcon) themeIcon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    if (themeMeta) themeMeta.content = theme === "dark" ? "#0c111d" : "#f3f2ee";
    themeChoices.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setTheme === theme);
    });
  }

  function setTheme(theme) {
    if (theme === "light") {
      root.dataset.theme = "light";
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
    showToast("Carry installed", { icon: "check_circle" });
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

  // ---------- Effort slider readout (add-commitment form) ----------
  const effortInput = document.querySelector("[data-effort-input]");
  const effortOut = document.querySelector("[data-effort-out]");
  if (effortInput && effortOut) {
    effortInput.addEventListener("input", () => {
      effortOut.textContent = effortInput.value;
    });
  }

  // ---------- Cost of Yes preview (same formula as compute_capacity()) ----------
  const costOfYes = document.getElementById("costOfYes");
  if (costOfYes && effortInput) {
    const energy = parseFloat(costOfYes.dataset.energy);
    const loadNow = parseFloat(costOfYes.dataset.loadNow);
    const budget = parseFloat(costOfYes.dataset.budget);
    const fatigue = 2 - energy / 100;
    const fill = document.getElementById("costOfYesFill");
    const afterOut = document.getElementById("costOfYesAfter");

    const updateCostOfYes = () => {
      const effort = parseFloat(effortInput.value) || 0;
      const newLoadRatio = (loadNow + effort) / budget;
      const after = Math.max(0, Math.round(newLoadRatio * 100 * fatigue));
      if (afterOut) afterOut.textContent = after + "%";
      if (fill) {
        fill.style.width = Math.min(100, after) + "%";
        if (window.carryBand) fill.style.background = window.carryBand(after).color;
      }
    };
    effortInput.addEventListener("input", updateCostOfYes);
    updateCostOfYes();
  }

  // ---------- Draft a decline instead ----------
  const declineBtn = document.getElementById("declineDraftBtn");
  const declineResult = document.getElementById("declineDraftResult");
  if (declineBtn && declineResult) {
    declineBtn.addEventListener("click", () => {
      const titleField = document.getElementById("c-title");
      const categoryField = document.getElementById("c-category");
      const title = (titleField.value || "").trim();
      if (!title) {
        titleField.focus();
        return;
      }
      declineBtn.disabled = true;
      const originalLabel = declineBtn.textContent;
      declineBtn.textContent = "Drafting…";
      fetch("/commitments/decline-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title, category: categoryField ? categoryField.value : "academic" }),
      })
        .then((r) => r.json())
        .then((data) => {
          declineResult.textContent = data.message || data.error || "Something went wrong.";
          declineResult.hidden = false;
        })
        .catch(() => {
          declineResult.textContent = "Something went wrong.";
          declineResult.hidden = false;
        })
        .finally(() => {
          declineBtn.disabled = false;
          declineBtn.textContent = originalLabel;
        });
    });
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

  // ---------- Activity tracking (the sleep chart's data source) ----------
  // Page Visibility only -- this can't see whether the phone itself is
  // asleep, only whether this tab is open and focused. A session opens on
  // "visible" and pings every couple of minutes so a killed tab still has a
  // recent last-seen time; it closes cleanly via sendBeacon on hide/unload.
  if (isAuthed) {
    let sessionId = null;
    let pingTimer = null;

    function startActivitySession() {
      if (sessionId) return;
      fetch("/activity/start", { method: "POST" })
        .then((res) => res.json())
        .then((data) => { sessionId = data.session_id; })
        .catch(() => {});
      pingTimer = setInterval(() => {
        if (!sessionId) return;
        fetch("/activity/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => {});
      }, 2 * 60 * 1000);
    }

    function endActivitySession() {
      if (!sessionId) return;
      navigator.sendBeacon("/activity/end", JSON.stringify({ session_id: sessionId }));
      clearInterval(pingTimer);
      sessionId = null;
    }

    if (document.visibilityState === "visible") startActivitySession();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") startActivitySession();
      else endActivitySession();
    });
    addEventListener("pagehide", endActivitySession);
  }
})();
