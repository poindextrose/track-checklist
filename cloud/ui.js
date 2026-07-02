// =================================================================
// Track Day Checklist — Cloud mode UI
//
// Renders the signed-in experience from a store (cloud/store.js): a home
// list picker grouped into one-time vs per-session lists, a full-screen
// list detail that reuses the app's check-row look, and a settings screen
// for managing lists. All user actions become store.dispatch(...) events;
// a poll loop keeps the view in sync with other devices.
//
// Cloud lists carry stable ids and synced checked state, so rendering here
// is keyed by item/list id (not array index like Local mode).
// =================================================================

import { $, setScreen, toast } from "../core.js";

let store = null;
let hooks = {};
let currentListId = null;
let pollTimer = null;
let editing = false; // suppress poll re-renders while editing inline
let lastSig = ""; // cheap change signature for the open view

const POLL_MS = 7000;

export function enterCloud(opts) {
  store = opts.store;
  hooks = opts.hooks || {};
  wireChrome();
  renderHome();
  setScreen("cloud-home");
  startPolling();
  // Kick an immediate sync so a fresh device pulls existing lists.
  syncNow();
}

export function leaveCloud() {
  stopPolling();
  store = null;
  currentListId = null;
}

// -----------------------------------------------------------------
// Home list picker
// -----------------------------------------------------------------

function renderHome() {
  const state = store.state();
  const oneTime = state.lists.filter((l) => !l.recycles);
  const perSession = state.lists.filter((l) => l.recycles);

  const root = $("cloud-home-lists");
  root.innerHTML = "";

  if (state.lists.length === 0) {
    const empty = document.createElement("p");
    empty.className = "setup-help";
    empty.textContent = "No lists yet — open Settings to add your first list.";
    root.appendChild(empty);
  }

  if (oneTime.length) root.appendChild(listGroup("Persistent", oneTime, state));
  if (perSession.length) {
    root.appendChild(listGroup("Auto recycles", perSession, state));
    // "Start next session" clears every recycling list at once.
    const startBtn = document.createElement("button");
    startBtn.className = "btn btn-primary cloud-start-session";
    startBtn.textContent = "Start next session";
    startBtn.addEventListener("click", () => {
      store.startNextSession();
      renderHome();
      toast("Per-session lists cleared for the next session.");
      syncNow();
    });
    root.appendChild(startBtn);
  }
}

function listGroup(label, lists, state) {
  const wrap = document.createElement("div");
  wrap.className = "list-group";
  const h = document.createElement("h3");
  h.className = "list-group-label";
  h.textContent = label;
  wrap.appendChild(h);

  for (const list of lists) {
    const { done, total } = progressOf(list.id, state);
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary list-picker-row";
    if (total > 0 && done === total) btn.classList.add("list-complete");
    btn.innerHTML =
      `<span class="list-picker-title"></span>` +
      `<span class="list-picker-count">${done}/${total}</span>`;
    btn.querySelector(".list-picker-title").textContent = list.title || "(untitled)";
    btn.addEventListener("click", () => openList(list.id));
    wrap.appendChild(btn);
  }
  return wrap;
}

function progressOf(listId, state) {
  const items = state.items.filter((i) => i.listId === listId);
  return { done: items.filter((i) => i.checked).length, total: items.length };
}

// -----------------------------------------------------------------
// List detail
// -----------------------------------------------------------------

function openList(listId) {
  currentListId = listId;
  renderList();
  setScreen("cloud-list");
  window.scrollTo(0, 0);
}

function currentList() {
  return store.state().lists.find((l) => l.id === currentListId) || null;
}

function itemsOf(listId) {
  return store.state().items.filter((i) => i.listId === listId);
}

function renderList() {
  const list = currentList();
  if (!list) {
    // list was deleted (perhaps on another device) — bounce home.
    renderHome();
    setScreen("cloud-home");
    return;
  }
  $("cloud-list-title").textContent = list.title || "(untitled)";
  const ul = $("cloud-list-items");
  if (ul._sortable) {
    ul._sortable.destroy();
    ul._sortable = null;
  }
  ul.innerHTML = "";

  const items = itemsOf(list.id);
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "checklist-empty";
    empty.textContent = `No items yet — tap "+ Add item" below.`;
    ul.appendChild(empty);
  } else {
    for (const item of items) ul.appendChild(buildCloudRow(item));
    ul._sortable = makeCloudSortable(ul);
  }
  lastSig = viewSignature();
}

function buildCloudRow(item) {
  const li = document.createElement("li");
  li.className = "check-row";
  li.dataset.id = item.id;
  if (item.checked) li.classList.add("checked");
  li.innerHTML = `
    <span class="drag-handle" aria-label="Drag to reorder">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
      </svg>
    </span>
    <span class="check-area" role="checkbox" aria-checked="${item.checked}" tabindex="0">
      <span class="check-box" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor"
            stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="check-text"></span>
    </span>
    <button class="icon-btn icon-btn-small row-edit" aria-label="Edit item">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
      </svg>
    </button>`;
  li.querySelector(".check-text").textContent = item.text;

  const area = li.querySelector(".check-area");
  area.addEventListener("click", () => toggleCloudCheck(li));
  area.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggleCloudCheck(li);
    }
  });
  li.querySelector(".row-edit").addEventListener("click", (e) => {
    e.stopPropagation();
    editCloudRow(li);
  });
  return li;
}

function toggleCloudCheck(li) {
  if (li.classList.contains("editing")) return;
  const id = li.dataset.id;
  const nowChecked = !li.classList.contains("checked");
  li.classList.toggle("checked", nowChecked);
  li.querySelector(".check-area").setAttribute("aria-checked", String(nowChecked));
  store.dispatch("item.check", id, { checked: nowChecked });
  lastSig = viewSignature();
  syncNow();
}

function editCloudRow(li) {
  if (li.classList.contains("editing")) return;
  const id = li.dataset.id;
  const item = store.state().items.find((i) => i.id === id);
  const originalText = item ? item.text : "";
  startInlineEdit(
    li,
    originalText,
    (value, save) => {
      if (save && value === "") {
        store.dispatch("item.delete", id, {});
        renderList();
      } else if (save && value !== originalText) {
        store.dispatch("item.upsert", id, { text: value });
        renderList();
      } else {
        renderList(); // cancel / no-op: restore the row
      }
      syncNow();
    },
    () => {
      // Explicit trash-button delete.
      store.dispatch("item.delete", id, {});
      renderList();
      syncNow();
    },
  );
}

function addCloudItem() {
  const list = currentList();
  if (!list) return;
  const ul = $("cloud-list-items");
  const placeholder = ul.querySelector(".checklist-empty");
  if (placeholder) placeholder.remove();

  const li = document.createElement("li");
  li.className = "check-row";
  li.innerHTML = `
    <span class="drag-handle" aria-hidden="true"></span>
    <span class="check-area"><span class="check-box"></span><span class="check-text"></span></span>
    <span></span>`;
  ul.appendChild(li);

  const order = itemsOf(list.id).length;
  startInlineEdit(li, "", (value, save) => {
    if (save && value !== "") {
      store.dispatch("item.upsert", store.newId(), {
        listId: list.id,
        text: value,
        order,
      });
      syncNow();
    }
    renderList();
  });
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Shared inline text editor. onDone(value, save) is called once. If onDelete
// is provided, a trash button appears (replacing the edit pencil) that removes
// the item outright.
function startInlineEdit(li, originalText, onDone, onDelete) {
  editing = true;
  li.classList.add("editing");
  const area = li.querySelector(".check-area");
  area.style.display = "none";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "check-input";
  input.value = originalText;
  input.autocomplete = "off";
  input.autocapitalize = "sentences";
  input.spellcheck = true;
  area.insertAdjacentElement("afterend", input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  let resolved = false;
  const finish = (save) => {
    if (resolved) return;
    resolved = true;
    editing = false;
    const value = input.value.trim();
    onDone(value, save);
  };

  if (onDelete) {
    const pencil = li.querySelector(".row-edit");
    if (pencil) pencil.style.display = "none";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn icon-btn-small row-delete";
    del.setAttribute("aria-label", "Delete item");
    del.innerHTML =
      `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">` +
      `<path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>`;
    li.appendChild(del);
    del.addEventListener("click", (e) => {
      e.preventDefault();
      if (resolved) return;
      resolved = true;
      editing = false;
      onDelete();
    });
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  // Defer the save-on-blur by a tick so a click on the trash button (which
  // blurs the input) wins the race and deletes instead of saving.
  input.addEventListener("blur", () => setTimeout(() => finish(true), 0));
}

function makeCloudSortable(ul) {
  return Sortable.create(ul, {
    handle: ".drag-handle",
    animation: 150,
    forceFallback: true,
    fallbackTolerance: 5,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: () => {
      const ids = [...ul.querySelectorAll(".check-row")].map((r) => r.dataset.id);
      ids.forEach((id, idx) => {
        if (id) store.dispatch("item.upsert", id, { order: idx });
      });
      renderList();
      syncNow();
    },
  });
}

// -----------------------------------------------------------------
// Settings / list management
// -----------------------------------------------------------------

function renderSettings() {
  const state = store.state();
  const root = $("cloud-settings-lists");
  if (root._sortable) {
    root._sortable.destroy();
    root._sortable = null;
  }
  root.innerHTML = "";

  for (const list of state.lists) {
    const rowEl = document.createElement("div");
    rowEl.className = "settings-list-row";
    rowEl.dataset.id = list.id;

    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.setAttribute("aria-label", "Drag to reorder list");
    handle.innerHTML =
      `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">` +
      `<path fill="currentColor" d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" /></svg>`;
    rowEl.appendChild(handle);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "settings-list-name";
    name.value = list.title;
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (v && v !== list.title) {
        store.dispatch("list.upsert", list.id, { title: v });
        syncNow();
      }
    });

    const recycle = document.createElement("label");
    recycle.className = "settings-recycle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!list.recycles;
    cb.addEventListener("change", () => {
      store.dispatch("list.upsert", list.id, { recycles: cb.checked });
      syncNow();
    });
    recycle.appendChild(cb);
    recycle.appendChild(document.createTextNode(" auto recycles"));

    const del = document.createElement("button");
    del.className = "icon-btn icon-btn-small";
    del.setAttribute("aria-label", "Delete list");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      store.dispatch("list.delete", list.id, {});
      renderSettings();
      syncNow();
    });

    rowEl.appendChild(name);
    rowEl.appendChild(recycle);
    rowEl.appendChild(del);
    root.appendChild(rowEl);
  }

  if (state.lists.length) root._sortable = makeListsSortable(root);

  const status = $("cloud-clientid-input");
  if (status && hooks.getClientId) status.value = hooks.getClientId();
}

function makeListsSortable(container) {
  return Sortable.create(container, {
    handle: ".drag-handle",
    animation: 150,
    forceFallback: true,
    fallbackTolerance: 5,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: () => {
      const ids = [...container.querySelectorAll(".settings-list-row")].map(
        (r) => r.dataset.id,
      );
      ids.forEach((id, idx) => {
        if (id) store.dispatch("list.upsert", id, { order: idx });
      });
      renderSettings();
      renderHome();
      syncNow();
    },
  });
}

// Add a list straight from the home screen with an inline name field.
// New lists default to one-time (non-recycling); recycles/order/delete are
// managed on the settings screen.
function addListInline() {
  const root = $("cloud-home-lists");
  const empty = root.querySelector(".setup-help");
  if (empty) empty.remove();

  const wrap = document.createElement("div");
  wrap.className = "list-add-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "settings-list-name";
  input.placeholder = "New list name";
  input.autocomplete = "off";
  input.autocapitalize = "sentences";
  wrap.appendChild(input);
  root.appendChild(wrap);
  input.focus();
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

  editing = true;
  let resolved = false;
  const finish = (save) => {
    if (resolved) return;
    resolved = true;
    editing = false;
    const title = input.value.trim();
    if (save && title) {
      store.dispatch("list.upsert", store.newId(), {
        title,
        recycles: false,
        order: store.state().lists.length,
      });
      syncNow();
    }
    renderHome();
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

// -----------------------------------------------------------------
// Chrome wiring + poll loop
// -----------------------------------------------------------------

function wireChrome() {
  $("cloud-settings-gear").addEventListener("click", () => {
    renderSettings();
    setScreen("cloud-settings");
  });
  $("cloud-list-back").addEventListener("click", () => {
    renderHome();
    setScreen("cloud-home");
  });
  $("cloud-settings-back").addEventListener("click", () => {
    renderHome();
    setScreen("cloud-home");
  });
  $("cloud-add-item").addEventListener("click", addCloudItem);
  $("cloud-home-add-list").addEventListener("click", addListInline);

  $("cloud-list-reset").addEventListener("click", () => {
    if (currentListId) {
      store.resetList(currentListId);
      renderList();
      toast("List reset.");
      syncNow();
    }
  });

  $("cloud-signout").addEventListener("click", () => {
    stopPolling();
    if (hooks.onSignOut) hooks.onSignOut();
  });

  const saveId = $("cloud-clientid-save");
  if (saveId) {
    saveId.addEventListener("click", () => {
      const v = $("cloud-clientid-input").value.trim();
      if (hooks.onSetClientId) hooks.onSetClientId(v);
      toast("Client ID saved.");
    });
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") syncNow();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function syncNow() {
  if (!store) return;
  try {
    if (hooks.ensureFreshToken) await hooks.ensureFreshToken();
    const res = await store.sync();
    setStatus(res.offline ? "offline" : store.hasPendingWrites() ? "syncing" : "synced");
  } catch {
    setStatus("offline");
  }
  maybeRerender();
}

// Re-render the open view if remote changes arrived — but never while the
// user is mid-edit (that would destroy their input).
function maybeRerender() {
  if (editing) return;
  // Never re-render out from under an in-progress edit (inline item text,
  // a settings list name, or the Client ID field) — it would drop the input.
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
  const sig = viewSignature();
  if (sig === lastSig) return;
  const screen = document.body.dataset.screen;
  if (screen === "cloud-home") renderHome();
  else if (screen === "cloud-list") renderList();
  else if (screen === "cloud-settings") renderSettings();
  lastSig = sig;
}

function viewSignature() {
  return store ? JSON.stringify(store.state()) : "";
}

function setStatus(kind) {
  const pill = $("cloud-status");
  if (!pill) return;
  pill.dataset.status = kind;
  pill.textContent =
    kind === "offline" ? "Offline" : kind === "syncing" ? "Syncing…" : "Synced";
}
