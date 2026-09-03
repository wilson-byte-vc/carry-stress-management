/* Search modal -- a vanilla port of the VengeanceUI "search-modal" component.
   Opens from the header search bar or Cmd/Ctrl+K, live-filters the rows, and
   supports removable category tags plus arrow-key navigation. */
(function () {
  "use strict";

  const overlay = document.querySelector("[data-search-overlay]");
  if (!overlay) return;

  const input = overlay.querySelector("[data-search-input]");
  const tagsBox = overlay.querySelector("[data-search-tags]");
  const sections = Array.from(overlay.querySelectorAll("[data-search-section]"));
  const emptyNote = overlay.querySelector("[data-search-empty]");
  const openers = document.querySelectorAll("[data-search-open]");

  // Categories switched off by removing their tag. Everything starts on.
  const disabled = new Set();
  let lastFocused = null;

  function rows() {
    // Only rows still on screen -- this is what the arrow keys walk.
    return Array.from(overlay.querySelectorAll("[data-search-item]")).filter(
      (row) => !row.closest("li, [data-search-section]").hidden && row.offsetParent !== null
    );
  }

  function clearActive() {
    overlay.querySelectorAll(".search-row.is-active").forEach((r) => r.classList.remove("is-active"));
  }

  function move(step) {
    const list = rows();
    if (!list.length) return;
    const current = list.findIndex((r) => r.classList.contains("is-active"));
    const next = (current + step + list.length) % list.length;
    clearActive();
    list[next].classList.add("is-active");
    list[next].scrollIntoView({ block: "nearest" });
  }

  function filter() {
    const query = (input.value || "").trim().toLowerCase();
    let total = 0;

    sections.forEach((section) => {
      const category = section.dataset.searchSection;
      const off = disabled.has(category);
      let shown = 0;

      section.querySelectorAll("li").forEach((li) => {
        const text = li.textContent.toLowerCase();
        const match = !off && (!query || text.includes(query));
        li.hidden = !match;
        if (match) shown += 1;
      });

      const count = section.querySelector("[data-search-count]");
      if (count) count.textContent = String(shown);
      section.hidden = shown === 0;
      total += shown;
    });

    if (emptyNote) emptyNote.hidden = total > 0;
    clearActive();
    const list = rows();
    if (list.length) list[0].classList.add("is-active");
  }

  function open() {
    if (!overlay.hidden) return;
    lastFocused = document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    filter();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = "";
    input.value = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  openers.forEach((btn) => btn.addEventListener("click", open));
  overlay.querySelectorAll("[data-search-close]").forEach((el) => el.addEventListener("click", close));
  input.addEventListener("input", filter);

  overlay.querySelectorAll("[data-search-tag-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.closest("[data-search-tag]");
      disabled.add(tag.dataset.searchTag);
      tag.remove();
      if (!tagsBox.querySelector("[data-search-tag]")) tagsBox.hidden = true;
      filter();
    });
  });

  // Rows that run something in-page rather than navigating.
  overlay.querySelectorAll("[data-search-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.searchAction === "toggle-theme") {
        const themeBtn = document.getElementById("theme-toggle");
        if (themeBtn) themeBtn.click();
      }
      close();
    });
  });

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      const active = overlay.querySelector(".search-row.is-active");
      if (active) {
        event.preventDefault();
        active.click();
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    const key = (event.key || "").toLowerCase();
    if (key === "k" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (overlay.hidden) open();
      else close();
    } else if (event.key === "Escape" && !overlay.hidden) {
      // Stop app.js's dropdown handler from also acting on this Escape.
      event.stopPropagation();
      close();
    }
  }, true);
})();
