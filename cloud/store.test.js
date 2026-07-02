import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.js";

test("dispatched events append to the sheet; a fresh store reads them back", async () => {
  const sheet = sharedSheet();
  const clock = mkClock();
  const A = createStore({
    device: "dA",
    sheets: connection(sheet),
    storage: fakeStorage(),
    clock,
    idgen: mkIdgen("dA"),
  });
  A.dispatch("list.upsert", "l1", { title: "Pre", recycles: true, order: 0 });
  A.dispatch("item.upsert", "i1", { listId: "l1", text: "tire", order: 0 });
  await A.sync();

  // A brand-new store on the same sheet, with its own empty storage.
  const B = createStore({
    device: "dB",
    sheets: connection(sheet),
    storage: fakeStorage(),
    clock: mkClock(),
    idgen: mkIdgen("dB"),
  });
  await B.sync();
  assert.deepEqual(B.state().lists.map((l) => l.title), ["Pre"]);
  assert.deepEqual(B.state().items.map((i) => i.text), ["tire"]);
});

test("offline edits are queued and converge after reconnect", async () => {
  const sheet = sharedSheet();
  const clock = mkClock(); // shared logical clock -> deterministic ordering
  const connA = connection(sheet);
  const connB = connection(sheet);
  const A = createStore({ device: "dA", sheets: connA, storage: fakeStorage(), clock, idgen: mkIdgen("dA") });
  const B = createStore({ device: "dB", sheets: connB, storage: fakeStorage(), clock, idgen: mkIdgen("dB") });

  // A builds a recycling list with two items and syncs; B pulls it.
  A.dispatch("list.upsert", "l1", { title: "Pre", recycles: true, order: 0 });
  A.dispatch("item.upsert", "i1", { listId: "l1", text: "one", order: 0 });
  A.dispatch("item.upsert", "i2", { listId: "l1", text: "two", order: 1 });
  await A.sync();
  await B.sync();
  assert.equal(B.state().items.length, 2);

  // B loses connection and checks item one.
  connB.setOnline(false);
  B.dispatch("item.check", "i1", { checked: true });
  const offlineResult = await B.sync();
  assert.equal(offlineResult.offline, true, "sync reports offline");
  assert.equal(B.state().items.find((i) => i.id === "i1").checked, true, "local edit is live offline");

  // Meanwhile A checks item two online.
  A.dispatch("item.check", "i2", { checked: true });
  await A.sync();

  // B reconnects and syncs; A syncs again to pull B's queued edit.
  connB.setOnline(true);
  await B.sync();
  await A.sync();

  const checks = (s) => Object.fromEntries(s.state().items.map((i) => [i.id, i.checked]));
  assert.deepEqual(checks(A), { i1: true, i2: true });
  assert.deepEqual(checks(B), { i1: true, i2: true });
  assert.deepEqual(checks(A), checks(B), "both devices converged");
});

test("a store rehydrates its queue from storage across a reload", async () => {
  const sheet = sharedSheet();
  const storage = fakeStorage();
  const conn = connection(sheet);
  conn.setOnline(false); // offline the whole time

  const first = createStore({ device: "dA", sheets: conn, storage, clock: mkClock(), idgen: mkIdgen("dA") });
  first.dispatch("list.upsert", "l1", { title: "Pre", recycles: false, order: 0 });
  await first.sync(); // fails to push (offline); event stays queued in storage

  // "Reload": a new store instance backed by the SAME storage.
  const reloaded = createStore({ device: "dA", sheets: conn, storage, clock: mkClock(), idgen: mkIdgen("dA") });
  assert.deepEqual(reloaded.state().lists.map((l) => l.title), ["Pre"], "state restored offline");

  // Now the network returns; the queued event finally reaches the sheet.
  conn.setOnline(true);
  await reloaded.sync();
  assert.equal(sheet.rows.length, 1, "queued event pushed after reconnect");
});

test("startNextSession clears recycling lists across devices", async () => {
  const sheet = sharedSheet();
  const clock = mkClock();
  const A = createStore({ device: "dA", sheets: connection(sheet), storage: fakeStorage(), clock, idgen: mkIdgen("dA") });
  A.dispatch("list.upsert", "lr", { title: "Pre", recycles: true, order: 0 });
  A.dispatch("list.upsert", "ln", { title: "Morning", recycles: false, order: 1 });
  A.dispatch("item.upsert", "ir", { listId: "lr", text: "tire", order: 0 });
  A.dispatch("item.upsert", "in", { listId: "ln", text: "coffee", order: 0 });
  A.dispatch("item.check", "ir", { checked: true });
  A.dispatch("item.check", "in", { checked: true });
  A.dispatch("session.reset", "", { scope: "recycling" });
  await A.sync();

  const B = createStore({ device: "dB", sheets: connection(sheet), storage: fakeStorage(), clock: mkClock(), idgen: mkIdgen("dB") });
  await B.sync();
  const byId = Object.fromEntries(B.state().items.map((i) => [i.id, i.checked]));
  assert.equal(byId.ir, false, "recycling item cleared everywhere");
  assert.equal(byId.in, true, "non-recycling item untouched");
});

// -----------------------------------------------------------------
// fakes
// -----------------------------------------------------------------

// A shared in-memory stand-in for the Sheet's Log tab: an append-only
// array of rows (arrays of cell strings).
function sharedSheet() {
  const rows = [];
  return {
    rows,
    append(newRows) {
      for (const r of newRows) rows.push([...r]);
    },
    readFrom(n) {
      return rows.slice(n).map((r) => [...r]);
    },
  };
}

// Per-device connection to the shared sheet, with an offline toggle.
function connection(sheet) {
  let online = true;
  return {
    setOnline(v) {
      online = v;
    },
    async appendRows(rows) {
      if (!online) throw new Error("offline");
      sheet.append(rows);
    },
    async readRowsFrom(n) {
      if (!online) throw new Error("offline");
      return sheet.readFrom(n);
    },
  };
}

function fakeStorage() {
  let data = null;
  return {
    load() {
      return data;
    },
    save(d) {
      data = JSON.parse(JSON.stringify(d));
    },
  };
}

function mkClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 2, 10, 0, ++n)).toISOString();
}

function mkIdgen(prefix) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
