// =================================================================
// Track Day Checklist — Cloud store (offline-first sync orchestration)
//
// Ties together the pure event-log reducer (log.js), a Sheets transport,
// and a storage cache into a single mutable store the UI talks to.
//
// Design:
//   • localStorage is the always-authoritative local cache: the full event
//     set, the outbound queue (ids not yet on the Sheet), and how many Log
//     rows we've already consumed. The store hydrates from it at
//     construction, so the app boots and runs entirely offline.
//   • dispatch() records a change as a new event immediately (optimistic,
//     offline-safe) and queues it.
//   • sync() pulls new Log rows, merges them (dedup by id), then pushes the
//     queue. Any failure (offline / API error) leaves the queue intact to
//     retry. Appends never overwrite, so concurrent devices can't clobber.
//
// Dependencies are injected so the whole cycle is testable without Google:
//   sheets  : { appendRows(rows)->Promise, readRowsFrom(startRow)->Promise<rows> }
//   storage : { load()->state|null, save(state) }
//   clock   : () => ISO-8601 UTC string
//   idgen   : () => unique event id
//   device  : stable per-browser id string
// =================================================================

import {
  foldEvents,
  makeEvent,
  eventToRow,
  rowToEvent,
  mergeEvents,
} from "./log.js";

export function createStore({ device, sheets, storage, clock, idgen }) {
  let events = [];
  let unsynced = new Set(); // event ids created locally, not yet on the Sheet
  let pulledRows = 0; // number of Log rows already consumed
  let syncing = false; // reentrancy guard for sync()
  let syncAgain = false; // a sync was requested while one was in flight

  const saved = storage.load();
  if (saved) {
    events = saved.events || [];
    unsynced = new Set(saved.unsynced || []);
    pulledRows = saved.pulledRows || 0;
  }

  // Strictly-monotonic per-device timestamps. The wall clock only has
  // millisecond resolution, so several edits fired in one millisecond would
  // otherwise share a timestamp and be ordered by their (random) event id —
  // letting a stale value win. We guarantee each event this device emits has
  // a time strictly greater than the previous one. Start past any known event.
  let lastTime = events.reduce((m, e) => (e.time > m ? e.time : m), "");

  function nextTime() {
    let t = clock();
    if (t <= lastTime) t = new Date(new Date(lastTime).getTime() + 1).toISOString();
    lastTime = t;
    return t;
  }

  let derived = foldEvents(events);

  function persist() {
    storage.save({ events, unsynced: [...unsynced], pulledRows });
  }

  function dispatch(op, target = "", payload = {}) {
    const e = makeEvent({ id: idgen(), time: nextTime(), device, op, target, payload });
    events.push(e);
    unsynced.add(e.id);
    derived = foldEvents(events);
    persist();
    return e;
  }

  async function sync() {
    // Only one sync cycle at a time. Overlapping calls (the UI fires one per
    // edit) would otherwise read the same queue and double-append it. A call
    // made mid-cycle is coalesced into a single follow-up run.
    if (syncing) {
      syncAgain = true;
      return { ok: true, coalesced: true };
    }
    syncing = true;
    try {
      return await runSync();
    } finally {
      syncing = false;
      if (syncAgain) {
        syncAgain = false;
        sync();
      }
    }
  }

  async function runSync() {
    // --- PULL: consume Log rows we haven't seen yet ---
    try {
      const rows = await sheets.readRowsFrom(pulledRows);
      pulledRows += rows.length;
      if (rows.length) {
        const pulled = rows.map(rowToEvent);
        events = mergeEvents(events, pulled);
        // Our own appends echo back on a later pull — confirm them synced.
        const pulledIds = new Set(pulled.map((e) => e.id));
        for (const id of [...unsynced]) if (pulledIds.has(id)) unsynced.delete(id);
      }
    } catch {
      persist();
      return { ok: false, offline: true };
    }

    // --- PUSH: append the queue ---
    const toPush = events.filter((e) => unsynced.has(e.id));
    if (toPush.length) {
      try {
        await sheets.appendRows(toPush.map(eventToRow));
        for (const e of toPush) unsynced.delete(e.id);
      } catch {
        derived = foldEvents(events);
        persist();
        return { ok: false, offline: true };
      }
    }

    derived = foldEvents(events);
    persist();
    return { ok: true };
  }

  return {
    state: () => derived,
    dispatch,
    sync,
    newId: () => idgen(),
    hasPendingWrites: () => unsynced.size > 0,
    deviceId: device,
    // Convenience wrappers over dispatch for the prominent session controls.
    startNextSession: () => dispatch("session.reset", "", { scope: "recycling" }),
    resetList: (listId) => dispatch("session.reset", listId, { scope: listId }),
  };
}
