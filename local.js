// =================================================================
// Track Day Checklist — Local mode controller
//
// The original, anonymous, offline experience: three fixed phases
// (pre / post / packup), the scripted flow (setup → pre → GO! → post →
// between → timer → packup → final), a between-sessions timer, and
// JSON export/import. Lists live in localStorage; check state is
// ephemeral (cleared on every refresh). Behaviour is unchanged from
// the original single-file app — this module just wires the shared
// core engine to the three fixed phases.
// =================================================================

import {
  $,
  setScreen,
  toast,
  renderChecklist,
  addItem,
  allCheckedFor,
  attachHoldHandler,
} from "./core.js";

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

// One list context per phase, built in enter(). getItems/setItems close
// over the module-level `lists` variable, so replacing `lists` wholesale
// (saveLists) or mutating a phase (setItems) both stay in sync.
const ctxs = {};

// Timer state
let timerEnd = 0;
let timerInterval = null;

// -----------------------------------------------------------------
// List contexts
// -----------------------------------------------------------------

function persist() {
  localStorage.setItem(LS_KEY, JSON.stringify(lists));
}

function makeLocalCtx(key) {
  const ctx = {
    key,
    listEl: $(`${key}-list`),
    checkedSet: new Set(),
    getItems: () => lists[key],
    setItems: (next) => {
      lists[key] = next;
      persist();
    },
  };
  // Local's auto-advance: completing a phase jumps to the next screen.
  ctx.onToggle = () => {
    if (allCheckedFor(ctx)) {
      if (key === "pre") setScreen("go");
      else if (key === "post") setScreen("between");
      else if (key === "packup") setScreen("final");
    }
  };
  return ctx;
}

function labelFor(phase) {
  if (phase === "pre") return "pre-session";
  if (phase === "post") return "post-session";
  return "pack-up";
}

function renderAllLists() {
  for (const phase of PHASES) renderChecklist(ctxs[phase]);
}

function clearAllChecks() {
  for (const phase of PHASES) ctxs[phase].checkedSet.clear();
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
  persist();
}

function hasStoredLists() {
  return loadLists() !== null;
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
  addItem(ctxs.pre);
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
      addItem(ctxs[phase]);
    });
  });

  // Per-phase reset buttons (clears check marks for that phase only)
  document.querySelectorAll("[data-reset-phase]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const phase = btn.dataset.resetPhase;
      ctxs[phase].checkedSet.clear();
      renderChecklist(ctxs[phase]);
      toast(`${labelFor(phase)} checks cleared.`);
    });
  });

  // GO! → I'm back
  $("btn-im-back").addEventListener("click", () => {
    ctxs.post.checkedSet.clear();
    renderChecklist(ctxs.post);
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
    ctxs.packup.checkedSet.clear();
    renderChecklist(ctxs.packup);
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
    ctxs.post.checkedSet.clear();
    renderChecklist(ctxs.post);
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
// Entry point (called by the boot router in app.js)
// -----------------------------------------------------------------

export function enter() {
  // Build the three phase contexts now that the DOM exists.
  for (const phase of PHASES) ctxs[phase] = makeLocalCtx(phase);

  wireEvents();

  if (!hasStoredLists()) {
    setScreen("setup");
    return;
  }

  lists = loadLists();
  renderAllLists();
  setScreen("pre");
}
