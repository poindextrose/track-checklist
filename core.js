// =================================================================
// Track Day Checklist — core checklist engine (mode-agnostic)
//
// These primitives render, edit, reorder, and toggle a single
// checklist. They are keyed on an opaque "list context" (ctx) so the
// same code drives both Local mode (three fixed phases) and Cloud mode
// (an arbitrary number of user-defined lists).
//
//   ctx = {
//     key,            // string id ("pre" locally, or a cloud list id)
//     listEl,         // the <ul> DOM node this list renders into
//     checkedSet,     // Set<string> of checked row indices
//     getItems(),     // () => string[]        current item texts
//     setItems(next), // (string[]) => void    persist a new item array
//     onToggle(idx, checked), // optional hook run AFTER a toggle
//     _sortable,      // internal: the SortableJS instance (managed here)
//   }
// =================================================================

// -----------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------

export const $ = (id) => document.getElementById(id);

export function setScreen(name) {
  document.body.dataset.screen = name;
  if (name === "pre" || name === "post" || name === "packup") {
    window.scrollTo(0, 0);
  }
}

let toastTimer = null;
export function toast(msg, ms = 6000) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  // Tap to dismiss early (attached once).
  if (!el.dataset.dismissWired) {
    el.dataset.dismissWired = "1";
    el.addEventListener("click", () => {
      el.hidden = true;
    });
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

// -----------------------------------------------------------------
// Checklist rendering (with edit-in-place support)
// -----------------------------------------------------------------

export function snapshotChecks(ctx) {
  // Capture currently-checked items by their text content so we can
  // restore them after a re-render even if list indices changed.
  const listEl = ctx.listEl;
  const texts = new Set();
  if (!listEl) return texts;
  const items = ctx.getItems();
  listEl.querySelectorAll(".check-row.checked").forEach((row) => {
    const idx = Number(row.dataset.idx);
    if (Number.isInteger(idx)) {
      const t = items[idx];
      if (t) texts.add(t);
    }
  });
  return texts;
}

export function makeSortable(ctx, { withOnEnd = true } = {}) {
  const options = {
    handle: ".drag-handle",
    animation: 150,
    forceFallback: true,
    fallbackTolerance: 5,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
  };
  // The transient sortable created while adding the first item to an empty
  // list must NOT persist on drag: its only row is the in-progress edit
  // placeholder (item text still undefined), so reordering it would save an
  // empty list and discard the edit. renderChecklist rebuilds a real,
  // onEnd-bearing sortable as soon as the item is saved.
  if (withOnEnd) {
    options.onEnd = () => {
      // Read new order from DOM, persist, and re-render with checks preserved.
      const preserved = snapshotChecks(ctx);
      const items = ctx.getItems();
      const newOrder = [];
      ctx.listEl.querySelectorAll(".check-row").forEach((row) => {
        const oldIdx = Number(row.dataset.idx);
        if (Number.isInteger(oldIdx) && items[oldIdx] !== undefined) {
          newOrder.push(items[oldIdx]);
        }
      });
      ctx.setItems(newOrder);
      renderChecklist(ctx, preserved);
    };
  }
  return Sortable.create(ctx.listEl, options);
}

export function renderChecklist(ctx, preserveTexts = null) {
  const listEl = ctx.listEl;
  if (!listEl) return;

  // Tear down any existing Sortable instance.
  if (ctx._sortable) {
    ctx._sortable.destroy();
    ctx._sortable = null;
  }

  listEl.innerHTML = "";
  ctx.checkedSet.clear();

  const items = ctx.getItems();

  if (!items || items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "checklist-empty";
    empty.textContent = `No items yet — tap "+ Add item" below.`;
    listEl.appendChild(empty);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const li = buildCheckRow(ctx, i, items[i]);
    listEl.appendChild(li);
  }

  // Restore checks if requested (after a reorder/edit/delete).
  if (preserveTexts && preserveTexts.size > 0) {
    listEl.querySelectorAll(".check-row").forEach((row) => {
      const idx = Number(row.dataset.idx);
      const text = items[idx];
      if (text && preserveTexts.has(text)) {
        row.classList.add("checked");
        const area = row.querySelector(".check-area");
        if (area) area.setAttribute("aria-checked", "true");
        ctx.checkedSet.add(String(idx));
      }
    });
  }

  // Initialise SortableJS for drag-and-drop reordering.
  ctx._sortable = makeSortable(ctx);
}

export function buildCheckRow(ctx, idx, text) {
  const li = document.createElement("li");
  li.className = "check-row";
  li.dataset.idx = String(idx);
  li.dataset.phase = ctx.key;
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
  checkArea.addEventListener("click", () => toggleCheck(li, ctx));
  checkArea.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggleCheck(li, ctx);
    }
  });

  // Pencil opens edit-in-place.
  li.querySelector(".row-edit").addEventListener("click", (e) => {
    e.stopPropagation();
    enterEditMode(li, ctx);
  });

  return li;
}

export function toggleCheck(li, ctx) {
  if (li.classList.contains("editing")) return;
  const idx = li.dataset.idx;
  const nowChecked = !li.classList.contains("checked");
  li.classList.toggle("checked", nowChecked);
  const area = li.querySelector(".check-area");
  if (area) area.setAttribute("aria-checked", String(nowChecked));
  if (nowChecked) ctx.checkedSet.add(idx);
  else ctx.checkedSet.delete(idx);

  // Mode-specific behaviour (e.g. Local's auto-advance to the GO! screen,
  // or Cloud's write-back to the Sheet) lives in the ctx.onToggle hook.
  ctx.onToggle?.(idx, nowChecked);
}

export function allCheckedFor(ctx) {
  const total = ctx.getItems().length;
  return total > 0 && ctx.checkedSet.size === total;
}

// -----------------------------------------------------------------
// Edit-in-place
// -----------------------------------------------------------------

export function enterEditMode(li, ctx) {
  if (li.classList.contains("editing")) return;

  const isNew = li.dataset.isNew === "true";
  const idx = Number(li.dataset.idx);
  const originalText = isNew ? "" : ctx.getItems()[idx] || "";

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
        const preserved = snapshotChecks(ctx);
        ctx.setItems([...ctx.getItems(), newValue]);
        renderChecklist(ctx, preserved);
      } else {
        // Cancel-new or save-empty-new — just drop the placeholder row.
        li.remove();
        if (ctx.getItems().length === 0) {
          renderChecklist(ctx);
        }
      }
      return;
    }

    if (save && newValue === "") {
      // Empty + save = delete.
      const preserved = snapshotChecks(ctx);
      preserved.delete(originalText); // don't preserve the now-deleted item
      ctx.setItems(ctx.getItems().filter((_, i) => i !== idx));
      renderChecklist(ctx, preserved);
      return;
    }

    if (save && newValue !== originalText) {
      // Update value in place.
      const preserved = snapshotChecks(ctx);
      // The item we're editing keeps its check state if it was checked.
      if (preserved.has(originalText)) {
        preserved.delete(originalText);
        preserved.add(newValue);
      }
      const next = ctx.getItems().slice();
      next[idx] = newValue;
      ctx.setItems(next);
      renderChecklist(ctx, preserved);
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

export function addItem(ctx) {
  const listEl = ctx.listEl;

  // If list is empty, the placeholder <li> is in the DOM. Remove it before
  // appending the new editable row.
  const placeholder = listEl.querySelector(".checklist-empty");
  if (placeholder) placeholder.remove();

  const li = buildCheckRow(ctx, ctx.getItems().length, "");
  li.dataset.isNew = "true";
  listEl.appendChild(li);

  // Initialise sortable for the new row if there isn't one already (empty
  // lists don't get a sortable instance). No onEnd — see makeSortable.
  if (!ctx._sortable) {
    ctx._sortable = makeSortable(ctx, { withOnEnd: false });
  }

  enterEditMode(li, ctx);
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// -----------------------------------------------------------------
// Press-and-hold helper
// -----------------------------------------------------------------

export function attachHoldHandler(button, ms, onComplete, onShortTap) {
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
    const wasActive = active;
    reset();
    // Released before the hold completed — treat as a tap.
    if (wasActive && onShortTap) onShortTap();
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
