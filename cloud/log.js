// =================================================================
// Track Day Checklist — event-log reducer (pure, offline-first sync core)
//
// The Google Sheet's Log tab is an append-only stream of change events.
// State (the lists + items the UI renders) is DERIVED by folding that
// stream. localStorage caches the full event set so the app boots and
// runs offline; on reconnect, locally-created events are appended to the
// Sheet and remote events are pulled in. Because folding always processes
// the full set in timestamp order, out-of-order (late offline) arrivals
// converge deterministically — last-write-wins by event time.
//
// Event shape:
//   { id, time, device, op, target, payload }
//     id      unique per event (dedupes echoes of our own appends)
//     time    ISO-8601 UTC string; the moment the change happened
//     device  stable per-browser id; breaks ties when times are equal
//     op      "list.upsert" | "list.delete"
//             | "item.upsert" | "item.delete" | "item.check"
//             | "session.reset"
//     target  the list id / item id the op applies to ("" for session.*)
//     payload op-specific fields (see below)
// =================================================================

export function foldEvents(events) {
  const lists = new Map(); // id -> {id, title, recycles, order, _deleted}
  const items = new Map(); // id -> {id, listId, text, order, checked, _deleted}

  // Fold in (time, device, id) order so last-write-wins is automatic and
  // out-of-order arrivals converge to the same result.
  const ordered = [...events].sort(compareEvents);

  for (const e of ordered) {
    switch (e.op) {
      case "list.upsert": {
        const cur = lists.get(e.target) || newList(e.target);
        Object.assign(cur, e.payload);
        lists.set(e.target, cur);
        break;
      }
      case "list.delete": {
        const cur = lists.get(e.target) || newList(e.target);
        cur._deleted = true;
        lists.set(e.target, cur);
        break;
      }
      case "item.upsert": {
        const cur = items.get(e.target) || newItem(e.target);
        Object.assign(cur, e.payload);
        items.set(e.target, cur);
        break;
      }
      case "item.delete": {
        const cur = items.get(e.target) || newItem(e.target);
        cur._deleted = true;
        items.set(e.target, cur);
        break;
      }
      case "item.check": {
        const cur = items.get(e.target);
        if (cur) cur.checked = !!e.payload.checked;
        break;
      }
      case "session.reset": {
        // Clear checks for every live item in scope, as of this point in
        // the fold. scope "recycling" targets all recycling lists (the
        // "Start next session" button); any other scope value is a single
        // list id (a per-list reset). A later item.check re-checks it.
        const scope = e.payload.scope;
        for (const it of items.values()) {
          if (it._deleted) continue;
          const parent = lists.get(it.listId);
          if (!parent || parent._deleted) continue;
          const inScope =
            scope === "recycling" ? parent.recycles === true : it.listId === scope;
          if (inScope) it.checked = false;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    lists: [...lists.values()]
      .filter((l) => !l._deleted)
      .sort(byOrder)
      .map((l) => ({
        id: l.id,
        title: l.title,
        recycles: l.recycles,
        order: l.order,
      })),
    items: [...items.values()]
      .filter((i) => !i._deleted)
      .sort(byOrder)
      .map((i) => ({
        id: i.id,
        listId: i.listId,
        text: i.text,
        order: i.order,
        checked: i.checked,
      })),
  };
}

// -----------------------------------------------------------------
// Event construction & Sheet-row (de)serialization
// -----------------------------------------------------------------

// Column order of the Sheet's Log tab.
// A: id | B: time | C: device | D: op | E: target | F: payload(JSON)
export const LOG_HEADER = ["event_id", "event_time", "device_id", "op", "target", "payload"];

export function makeEvent({ id, time, device, op, target = "", payload = {} }) {
  return { id, time, device, op, target, payload };
}

export function eventToRow(e) {
  return [e.id, e.time, e.device, e.op, e.target, JSON.stringify(e.payload ?? {})];
}

export function rowToEvent(row) {
  return {
    id: row[0],
    time: row[1],
    device: row[2],
    op: row[3],
    target: row[4] ?? "", // Sheets returns "" for empty middle cells
    payload: row[5] ? JSON.parse(row[5]) : {}, // trailing empty cells are omitted
  };
}

export function mergeEvents(a, b) {
  const byId = new Map();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()];
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

function newList(id) {
  return { id, title: "", recycles: false, order: 0, _deleted: false };
}

function newItem(id) {
  return { id, listId: "", text: "", order: 0, checked: false, _deleted: false };
}

function byOrder(a, b) {
  return a.order - b.order;
}

// ISO-8601 UTC strings compare lexically the same as chronologically.
function compareEvents(a, b) {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
