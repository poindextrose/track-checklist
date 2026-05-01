// =================================================================
// Track Day Checklist — localStorage version with edit-in-place
// =================================================================

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const HOLD_MS = 3000;
const LS_KEY = "tcl_lists_v1";

const EXAMPLE_LISTS = {
  pre: [
    "Set tire pressure",
    "Mark tire sidewalls",
    "Start Dragy",
    "Start other cameras",
    "Start car lap timer",
  ],
  post: [
    "Measure tire pressure",
    "Analyze sidewall marks",
    "Turn off Dragy",
    "Turn off cameras",
    "Turn off lap timer",
  ],
  packup: [
    "Load tools and gear",
    "Stow loose items",
    "Check tire condition for drive home",
    "Bag trash",
    "Final walk-around",
  ],
};

const PHASES = ["pre", "post", "packup"];

// -----------------------------------------------------------------
// Module state
// -----------------------------------------------------------------

let lists = { pre: [], post: [], packup: [] };

const checkedSets = {
  pre: new Set(),
  post: new Set(),
  packup: new Set(),
};

// Per-phase SortableJS instances
const sortables = { pre: null, post: null, packup: null };

// Timer state
let timerEnd = 0;
let timerInterval = null;

// -----------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function setScreen(name) {
  document.body.dataset.screen = name;
  if (name === "pre" || name === "post" || name === "packup") {
    window.scrollTo(0, 0);
  }
}

let toastTimer = null;
function toast(msg, ms = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function clearAllChecks() {
  for (const phase of PHASES) checkedSets[phase].clear();
}

function renderAllLists() {
  for (const phase of PHASES) renderChecklist(phase);
}

function listElFor(phase) {
  return $(`${phase}-list`);
}

function labelFor(phase) {
  if (phase === "pre") return "pre-session";
  if (phase === "post") return "post-session";
  return "pack-up";
}

// -----------------------------------------------------------------
// localStorage
// -----------------------------------------------------------------

function loadLists() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !Array.isArray(parsed.pre) ||
      !Array.isArray(parsed.post) ||
      !parsed.pre.every((x) => typeof x === "string") ||
      !parsed.post.every((x) => typeof x === "string")
    ) {
      return null;
    }
    if (
      !Array.isArray(parsed.packup) ||
      !parsed.packup.every((x) => typeof x === "string")
    ) {
      parsed.packup = [...EXAMPLE_LISTS.packup];
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveLists(next) {
  lists = next;
  localStorage.setItem(LS_KEY, JSON.stringify(lists));
}

function hasStoredLists() {
  return loadLists() !== null;
}

// -----------------------------------------------------------------
// Checklist rendering (with edit-in-place support)
// -----------------------------------------------------------------

function snapshotChecks(phase) {
  // Capture currently-checked items by their text content so we can
  // restore them after a re-render even if list indices changed.
  const listEl = listElFor(phase);
  const texts = new Set();
  if (!listEl) return texts;
  listEl.querySelectorAll(".check-row.checked").forEach((row) => {
    const idx = Number(row.dataset.idx);
    if (Number.isInteger(idx)) {
      const t = lists[phase][idx];
      if (t) texts.add(t);
    }
  });
  return texts;
}

function renderChecklist(phase, preserveTexts = null) {
  const listEl = listElFor(phase);
  if (!listEl) return;

  // Tear down any existing Sortable instance.
  if (sortables[phase]) {
    sortables[phase].destroy();
    sortables[phase] = null;
  }

  listEl.innerHTML = "";
  checkedSets[phase].clear();

  const items = lists[phase];

  if (!items || items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "checklist-empty";
    empty.textContent = `No items yet — tap "+ Add item" below.`;
    listEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const li = buildCheckRow(phase, i, items[i]);
    listEl.appendChild(li);
  }

  // Restore checks if requested (after a reorder/edit/delete).
  if (preserveTexts && preserveTexts.size > 0) {
    listEl.querySelectorAll(".check-row").forEach((row) => {
      const idx = Number(row.dataset.idx);
      const text = lists[phase][idx];
      if (text && preserveTexts.has(text)) {
        row.classList.add("checked");
        const area = row.querySelector(".check-area");
        if (area) area.setAttribute("aria-checked", "true");
        checkedSets[phase].add(String(idx));
      }
    });
  }

  // Initialise SortableJS for drag-and-drop reordering.
  sortables[phase] = Sortable.create(listEl, {
    handle: ".drag-handle",
    animation: 150,
    forceFallback: true,
    fallbackTolerance: 5,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: () => {
      // Read new order from DOM, persist, and re-render with checks preserved.
      const preserved = snapshotChecks(phase);
      const newOrder = [];
      listEl.querySelectorAll(".check-row").forEach((row) => {
        const oldIdx = Number(row.dataset.idx);
        if (Number.isInteger(oldIdx) && lists[phase][oldIdx] !== undefined) {
          newOrder.push(lists[phase][oldIdx]);
        }
      });
      lists[phase] = newOrder;
      saveLists(lists);
      renderChecklist(phase, preserved);
    },
  });
}

function buildCheckRow(phase, idx, text) {
  const li = document.createElement("li");
  li.className = "check-row";
  li.dataset.idx = String(idx);
  li.dataset.phase = phase;
  li.innerHTML = `
    <span class="drag-handle" aria-label="Drag to reorder">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          fill="currentColor"
          d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"
        />
      </svg>
    </span>
    <span class="check-area" role="checkbox" aria-checked="false" tabindex="0">
      <span class="check-box" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path
            d="M5 12.5l4.5 4.5L19 7"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="check-text"></span>
    </span>
    <button class="icon-btn icon-btn-small row-edit" aria-label="Edit item">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          fill="currentColor"
          d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
        />
      </svg>
    </button>
  `;
  li.querySelector(".check-text").textContent = text;

  // Tap on the check-area toggles the check state.
  const checkArea = li.querySelector(".check-area");
  checkArea.addEventListener("click", () => toggleCheck(li, phase));
  checkArea.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggleCheck(li, phase);
    }
  });

  // Pencil opens edit-in-place.
  li.querySelector(".row-edit").addEventListener("click", (e) => {
    e.stopPropagation();
    enterEditMode(li, phase);
  });

  return li;
}

function toggleCheck(li, phase) {
  if (li.classList.contains("editing")) return;
  const idx = li.dataset.idx;
  const checkedSet = checkedSets[phase];
  const nowChecked = !li.classList.contains("checked");
  li.classList.toggle("checked", nowChecked);
  const area = li.querySelector(".check-area");
  if (area) area.setAttribute("aria-checked", String(nowChecked));
  if (nowChecked) checkedSet.add(idx);
  else checkedSet.delete(idx);

  if (allCheckedFor(phase)) {
    if (phase === "pre") setScreen("go");
    else if (phase === "post") setScreen("between");
    else if (phase === "packup") setScreen("final");
  }
}

function allCheckedFor(phase) {
  const total = lists[phase].length;
  return total > 0 && checkedSets[phase].size === total;
}

// -----------------------------------------------------------------
// Edit-in-place
// -----------------------------------------------------------------

function enterEditMode(li, phase) {
  if (li.classList.contains("editing")) return;

  const isNew = li.dataset.isNew === "true";
  const idx = Number(li.dataset.idx);
  const originalText = isNew ? "" : lists[phase][idx] || "";

  li.classList.add("editing");

  const checkArea = li.querySelector(".check-area");
  checkArea.style.display = "none";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "check-input";
  input.value = originalText;
  input.autocomplete = "off";
  input.autocapitalize = "sentences";
  input.spellcheck = true;
  checkArea.insertAdjacentElement("afterend", input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let resolved = false;

  const restoreDisplay = (currentText) => {
    input.remove();
    checkArea.style.display = "";
    li.querySelector(".check-text").textContent = currentText;
    li.classList.remove("editing");
  };

  const finish = (save) => {
    if (resolved) return;
    resolved = true;

    const newValue = input.value.trim();

    if (isNew) {
      // New item — never saves an empty string. Either we add it, or we
      // discard the placeholder row.
      if (save && newValue !== "") {
        const preserved = snapshotChecks(phase);
        lists[phase].push(newValue);
        saveLists(lists);
        renderChecklist(phase, preserved);
      } else {
        // Cancel-new or save-empty-new — just drop the placeholder row.
        li.remove();
        if (lists[phase].length === 0) {
          renderChecklist(phase);
        }
      }
      return;
    }

    if (save && newValue === "") {
      // Empty + save = delete.
      const preserved = snapshotChecks(phase);
      preserved.delete(originalText); // don't preserve the now-deleted item
      lists[phase].splice(idx, 1);
      saveLists(lists);
      renderChecklist(phase, preserved);
      return;
    }

    if (save && newValue !== originalText) {
      // Update value in place.
      const preserved = snapshotChecks(phase);
      // The item we're editing keeps its check state if it was checked.
      if (preserved.has(originalText)) {
        preserved.delete(originalText);
        preserved.add(newValue);
      }
      lists[phase][idx] = newValue;
      saveLists(lists);
      renderChecklist(phase, preserved);
      return;
    }

    // Cancel or no change — just exit edit mode without re-render.
    restoreDisplay(originalText);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function addItem(phase) {
  const listEl = listElFor(phase);

  // If list is empty, the placeholder <li> is in the DOM. Remove it before
  // appending the new editable row.
  const placeholder = listEl.querySelector(".checklist-empty");
  if (placeholder) placeholder.remove();

  const li = buildCheckRow(phase, lists[phase].length, "");
  li.dataset.isNew = "true";
  listEl.appendChild(li);

  // Initialise sortable for the new row if there isn't one already (empty
  // lists don't get a sortable instance).
  if (!sortables[phase]) {
    sortables[phase] = Sortable.create(listEl, {
      handle: ".drag-handle",
      animation: 150,
      forceFallback: true,
      fallbackTolerance: 5,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
    });
  }

  enterEditMode(li, phase);
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// -----------------------------------------------------------------
// Press-and-hold helper
// -----------------------------------------------------------------

function attachHoldHandler(button, ms, onComplete) {
  let raf = null;
  let startTs = 0;
  let active = false;

  const reset = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    startTs = 0;
    active = false;
    button.classList.remove("holding", "complete");
    button.style.removeProperty("--hold-progress");
  };

  const begin = () => {
    if (active) return;
    active = true;
    startTs = performance.now();
    button.classList.add("holding");

    const tick = (now) => {
      const elapsed = now - startTs;
      const progress = Math.min(1, elapsed / ms);
      button.style.setProperty("--hold-progress", String(progress));
      if (progress >= 1) {
        button.classList.add("complete");
        button.classList.remove("holding");
        raf = null;
        active = false;
        if (navigator.vibrate) navigator.vibrate(30);
        onComplete();
        setTimeout(reset, 250);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const cancel = () => {
    if (button.classList.contains("complete")) return;
    reset();
  };

  // Use touch events on touch-capable devices. Pointer events on older
  // Chromium variants (e.g. the Tesla in-car browser) fire spurious
  // pointercancel mid-hold that `touch-action: none` doesn't suppress.
  if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
    button.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        begin();
      },
      { passive: false },
    );
    button.addEventListener("touchend", (e) => {
      e.preventDefault();
      cancel();
    });
    button.addEventListener("touchcancel", cancel);
  } else {
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      button.setPointerCapture?.(e.pointerId);
      begin();
    });
    button.addEventListener("pointerup", cancel);
    button.addEventListener("pointercancel", cancel);
    button.addEventListener("pointerleave", cancel);
  }

  // Suppress the long-press → context menu pipeline. On Chromium it fires
  // ~500-1000ms into a touch hold and aborts the touch sequence.
  button.addEventListener("contextmenu", (e) => e.preventDefault());
}

// -----------------------------------------------------------------
// Timer
// -----------------------------------------------------------------

function startTimer(minutes) {
  const ms = Math.round(Number(minutes) * 60_000);
  if (!Number.isFinite(ms) || ms <= 0) {
    toast("Enter a positive number of minutes.");
    return;
  }
  timerEnd = Date.now() + ms;
  setScreen("timer");
  updateTimerDisplay();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 250);
}

function updateTimerDisplay() {
  const remaining = Math.max(0, timerEnd - Date.now());
  const totalSec = Math.ceil(remaining / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  $("timer-display").textContent = `${min}:${String(sec).padStart(2, "0")}`;
  if (remaining <= 0) {
    timerExpired();
  }
}

function timerExpired() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  clearAllChecks();
  renderAllLists();
  setScreen("pre");
  toast("Time's up — pre-session checks!");
}

function cancelTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  setScreen("between");
}

function jumpToPre() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  clearAllChecks();
  renderAllLists();
  setScreen("pre");
}

// -----------------------------------------------------------------
// Export / Import
// -----------------------------------------------------------------

function exportLists() {
  const blob = new Blob([JSON.stringify(lists, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "track-checklist.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Downloaded track-checklist.json");
}

function importLists(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (
        !parsed ||
        !Array.isArray(parsed.pre) ||
        !Array.isArray(parsed.post) ||
        !parsed.pre.every((x) => typeof x === "string") ||
        !parsed.post.every((x) => typeof x === "string")
      ) {
        toast("That file doesn't look like a checklist export.");
        return;
      }
      if (
        !Array.isArray(parsed.packup) ||
        !parsed.packup.every((x) => typeof x === "string")
      ) {
        parsed.packup = [...EXAMPLE_LISTS.packup];
      }
      saveLists(parsed);
      clearAllChecks();
      renderAllLists();
      closeSettings();
      setScreen("pre");
      toast("Lists imported.");
    } catch {
      toast("Couldn't read that file as JSON.");
    }
  };
  reader.onerror = () => toast("Couldn't read that file.");
  reader.readAsText(file);
}

// -----------------------------------------------------------------
// Settings modal
// -----------------------------------------------------------------

function openSettings() {
  $("settings-modal").hidden = false;
}

function closeSettings() {
  $("settings-modal").hidden = true;
}

function handleResetChecks() {
  clearAllChecks();
  renderAllLists();
  closeSettings();
  toast("All check marks cleared.");
}

// -----------------------------------------------------------------
// Top-level handlers
// -----------------------------------------------------------------

function handleUseExample() {
  saveLists({
    pre: [...EXAMPLE_LISTS.pre],
    post: [...EXAMPLE_LISTS.post],
    packup: [...EXAMPLE_LISTS.packup],
  });
  clearAllChecks();
  renderAllLists();
  setScreen("pre");
}

function handleStartBlank() {
  saveLists({ pre: [], post: [], packup: [] });
  clearAllChecks();
  renderAllLists();
  setScreen("pre");
  // Drop the user straight into adding their first pre-session item.
  addItem("pre");
}

function handleResetToExample() {
  saveLists({
    pre: [...EXAMPLE_LISTS.pre],
    post: [...EXAMPLE_LISTS.post],
    packup: [...EXAMPLE_LISTS.packup],
  });
  clearAllChecks();
  renderAllLists();
  closeSettings();
  setScreen("pre");
  toast("Lists reset to defaults.");
}

// -----------------------------------------------------------------
// Wire up DOM events
// -----------------------------------------------------------------

function wireEvents() {
  // Setup screen
  $("btn-use-example").addEventListener("click", handleUseExample);
  $("btn-start-blank").addEventListener("click", handleStartBlank);

  // + Add item buttons (one per phase)
  document.querySelectorAll("[data-add-phase]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const phase = btn.dataset.addPhase;
      addItem(phase);
    });
  });

  // Per-phase reset buttons (clears check marks for that phase only)
  document.querySelectorAll("[data-reset-phase]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const phase = btn.dataset.resetPhase;
      checkedSets[phase].clear();
      renderChecklist(phase);
      toast(`${labelFor(phase)} checks cleared.`);
    });
  });

  // GO! → I'm back
  $("btn-im-back").addEventListener("click", () => {
    checkedSets.post.clear();
    renderChecklist("post");
    setScreen("post");
  });

  // Between-sessions: timer presets
  document.querySelectorAll("[data-timer-min]").forEach((btn) => {
    btn.addEventListener("click", () => {
      startTimer(Number(btn.dataset.timerMin));
    });
  });

  // Between-sessions: custom timer
  const customInput = $("custom-timer-input");
  $("btn-start-custom-timer").addEventListener("click", () => {
    const val = Number(customInput.value);
    if (!Number.isFinite(val) || val <= 0) {
      toast("Enter a number of minutes greater than 0.");
      customInput.focus();
      return;
    }
    customInput.value = "";
    startTimer(val);
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-start-custom-timer").click();
    }
  });

  // Between-sessions: restart now
  $("btn-restart-now").addEventListener("click", jumpToPre);

  // Between-sessions: pack-up
  $("btn-go-packup").addEventListener("click", () => {
    checkedSets.packup.clear();
    renderChecklist("packup");
    setScreen("packup");
  });

  // Pack-up: back link
  $("btn-back-to-between").addEventListener("click", () => {
    setScreen("between");
  });

  // Timer screen
  $("btn-cancel-timer").addEventListener("click", cancelTimer);
  $("btn-skip-timer").addEventListener("click", jumpToPre);

  // Settings
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-close-settings").addEventListener("click", closeSettings);
  $("settings-backdrop").addEventListener("click", closeSettings);
  $("btn-reset-checks").addEventListener("click", handleResetChecks);
  $("btn-export").addEventListener("click", exportLists);
  $("btn-import").addEventListener("click", () => $("import-file-input").click());
  $("import-file-input").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importLists(file);
    e.target.value = "";
  });

  // Press-and-hold buttons
  attachHoldHandler($("btn-skip-to-post"), HOLD_MS, () => {
    checkedSets.post.clear();
    renderChecklist("post");
    setScreen("post");
  });

  attachHoldHandler($("btn-start-over"), HOLD_MS, () => {
    clearAllChecks();
    renderAllLists();
    setScreen("pre");
  });

  attachHoldHandler($("btn-reset-example"), HOLD_MS, handleResetToExample);
}

// -----------------------------------------------------------------
// Boot
// -----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  wireEvents();

  if (!hasStoredLists()) {
    setScreen("setup");
    return;
  }

  lists = loadLists();
  renderAllLists();
  setScreen("pre");
});
