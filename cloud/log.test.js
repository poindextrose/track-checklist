import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldEvents,
  makeEvent,
  eventToRow,
  rowToEvent,
  mergeEvents,
} from "./log.js";

test("a list.upsert event creates one list", () => {
  const events = [
    ev("e1", "2026-07-02T10:00:00Z", "d1", "list.upsert", "l1", {
      title: "Morning",
      recycles: false,
      order: 0,
    }),
  ];
  const { lists } = foldEvents(events);
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0], {
    id: "l1",
    title: "Morning",
    recycles: false,
    order: 0,
  });
});

test("lists are returned sorted by order, deleted lists excluded", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "l1", { title: "B", recycles: false, order: 1 }),
    ev("e2", t(2), "d1", "list.upsert", "l2", { title: "A", recycles: true, order: 0 }),
    ev("e3", t(3), "d1", "list.upsert", "l3", { title: "C", recycles: false, order: 2 }),
    ev("e4", t(4), "d1", "list.delete", "l3"),
  ];
  const { lists } = foldEvents(events);
  assert.deepEqual(lists.map((l) => l.id), ["l2", "l1"]);
  assert.equal(lists.find((l) => l.id === "l3"), undefined);
});

test("item.upsert creates an item that defaults to unchecked", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "l1", { title: "Pre", recycles: true, order: 0 }),
    ev("e2", t(2), "d1", "item.upsert", "i1", { listId: "l1", text: "Set tire pressure", order: 0 }),
  ];
  const { items } = foldEvents(events);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: "i1",
    listId: "l1",
    text: "Set tire pressure",
    order: 0,
    checked: false,
    kind: "item",
  });
});

test("an item can be a named separator via kind", () => {
  const events = [
    ev("e1", t(1), "d1", "item.upsert", "s1", {
      listId: "l1",
      text: "Warm-up",
      order: 0,
      kind: "separator",
    }),
  ];
  const { items } = foldEvents(events);
  assert.equal(items[0].kind, "separator");
  assert.equal(items[0].text, "Warm-up");
});

test("item.upsert can un-delete an item (undo support)", () => {
  const events = [
    ev("e1", t(1), "d1", "item.upsert", "i1", { listId: "l1", text: "x", order: 0 }),
    ev("e2", t(2), "d1", "item.delete", "i1"),
    ev("e3", t(3), "d1", "item.upsert", "i1", { deleted: false }),
  ];
  const { items } = foldEvents(events);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "x", "original fields survive the round-trip");
});

test("item.upsert with deleted:true removes the item", () => {
  const events = [
    ev("e1", t(1), "d1", "item.upsert", "i1", { listId: "l1", text: "x", order: 0 }),
    ev("e2", t(2), "d1", "item.upsert", "i1", { deleted: true }),
  ];
  assert.equal(foldEvents(events).items.length, 0);
});

test("items sorted by order; deleted items excluded", () => {
  const events = [
    ev("e1", t(1), "d1", "item.upsert", "i1", { listId: "l1", text: "one", order: 2 }),
    ev("e2", t(2), "d1", "item.upsert", "i2", { listId: "l1", text: "two", order: 0 }),
    ev("e3", t(3), "d1", "item.upsert", "i3", { listId: "l1", text: "three", order: 1 }),
    ev("e4", t(4), "d1", "item.delete", "i1"),
  ];
  const { items } = foldEvents(events);
  assert.deepEqual(items.map((i) => i.text), ["two", "three"]);
});

test("item.check sets and clears the checked flag", () => {
  const base = [
    ev("e1", t(1), "d1", "item.upsert", "i1", { listId: "l1", text: "x", order: 0 }),
  ];
  assert.equal(
    foldEvents([...base, ev("e2", t(2), "d1", "item.check", "i1", { checked: true })]).items[0].checked,
    true,
  );
  assert.equal(
    foldEvents([
      ...base,
      ev("e2", t(2), "d1", "item.check", "i1", { checked: true }),
      ev("e3", t(3), "d1", "item.check", "i1", { checked: false }),
    ]).items[0].checked,
    false,
  );
});

test("editing an item's text preserves its checked state", () => {
  const events = [
    ev("e1", t(1), "d1", "item.upsert", "i1", { listId: "l1", text: "old", order: 0 }),
    ev("e2", t(2), "d1", "item.check", "i1", { checked: true }),
    ev("e3", t(3), "d1", "item.upsert", "i1", { text: "new" }),
  ];
  const { items } = foldEvents(events);
  assert.equal(items[0].text, "new");
  assert.equal(items[0].checked, true);
});

test("last write wins by event time, regardless of input order", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "l1", { title: "First", recycles: false, order: 0 }),
    ev("e2", t(5), "d1", "list.upsert", "l1", { title: "Latest" }),
    ev("e3", t(3), "d1", "list.upsert", "l1", { title: "Middle" }),
  ];
  assert.equal(foldEvents(events).lists[0].title, "Latest");
});

test("a late-arriving offline edit with an earlier timestamp does not override a newer change", () => {
  // Device B (offline) checked at t(2); device A later unchecked at t(4).
  // B reconnects and its older event arrives last in the array.
  const events = [
    ev("a1", t(1), "dA", "item.upsert", "i1", { listId: "l1", text: "x", order: 0 }),
    ev("a3", t(4), "dA", "item.check", "i1", { checked: false }),
    ev("b2", t(2), "dB", "item.check", "i1", { checked: true }),
  ];
  assert.equal(foldEvents(events).items[0].checked, false);
});

test("equal timestamps break ties deterministically (device, then id)", () => {
  const mk = (title, device, id) => ev(id, t(2), device, "list.upsert", "l1", { title });
  const forward = [mk("from-a", "dA", "e1"), mk("from-b", "dB", "e2")];
  const reversed = [mk("from-b", "dB", "e2"), mk("from-a", "dA", "e1")];
  // Higher (device,id) is applied last and wins; both input orders agree.
  assert.equal(foldEvents(forward).lists[0].title, "from-b");
  assert.equal(foldEvents(reversed).lists[0].title, "from-b");
});

test("session.reset('recycling') clears only recycling lists", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "lr", { title: "Pre", recycles: true, order: 0 }),
    ev("e2", t(1), "d1", "list.upsert", "ln", { title: "Morning", recycles: false, order: 1 }),
    ev("e3", t(2), "d1", "item.upsert", "ir", { listId: "lr", text: "tire", order: 0 }),
    ev("e4", t(2), "d1", "item.upsert", "in", { listId: "ln", text: "coffee", order: 0 }),
    ev("e5", t(3), "d1", "item.check", "ir", { checked: true }),
    ev("e6", t(3), "d1", "item.check", "in", { checked: true }),
    ev("e7", t(5), "d1", "session.reset", "", { scope: "recycling" }),
  ];
  const byId = Object.fromEntries(foldEvents(events).items.map((i) => [i.id, i]));
  assert.equal(byId.ir.checked, false, "recycling item cleared");
  assert.equal(byId.in.checked, true, "non-recycling item untouched");
});

test("a check made after a session.reset survives it", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "lr", { title: "Pre", recycles: true, order: 0 }),
    ev("e2", t(2), "d1", "item.upsert", "ir", { listId: "lr", text: "tire", order: 0 }),
    ev("e3", t(3), "d1", "item.check", "ir", { checked: true }),
    ev("e4", t(4), "d1", "session.reset", "", { scope: "recycling" }),
    ev("e5", t(5), "d1", "item.check", "ir", { checked: true }),
  ];
  assert.equal(foldEvents(events).items[0].checked, true);
});

test("session.reset(<listId>) clears only that one list", () => {
  const events = [
    ev("e1", t(1), "d1", "list.upsert", "l1", { title: "A", recycles: false, order: 0 }),
    ev("e2", t(1), "d1", "list.upsert", "l2", { title: "B", recycles: false, order: 1 }),
    ev("e3", t(2), "d1", "item.upsert", "i1", { listId: "l1", text: "x", order: 0 }),
    ev("e4", t(2), "d1", "item.upsert", "i2", { listId: "l2", text: "y", order: 0 }),
    ev("e5", t(3), "d1", "item.check", "i1", { checked: true }),
    ev("e6", t(3), "d1", "item.check", "i2", { checked: true }),
    ev("e7", t(4), "d1", "session.reset", "l1", { scope: "l1" }),
  ];
  const byId = Object.fromEntries(foldEvents(events).items.map((i) => [i.id, i]));
  assert.equal(byId.i1.checked, false);
  assert.equal(byId.i2.checked, true);
});

test("makeEvent builds a normalized event, defaulting target and payload", () => {
  assert.deepEqual(
    makeEvent({ id: "e1", time: t(1), device: "dA", op: "list.delete", target: "l1" }),
    { id: "e1", time: t(1), device: "dA", op: "list.delete", target: "l1", payload: {} },
  );
  assert.deepEqual(
    makeEvent({ id: "e2", time: t(2), device: "dA", op: "session.reset", payload: { scope: "recycling" } }),
    { id: "e2", time: t(2), device: "dA", op: "session.reset", target: "", payload: { scope: "recycling" } },
  );
});

test("an event round-trips through a Sheet row", () => {
  const e = makeEvent({
    id: "e1", time: t(1), device: "dA", op: "item.upsert", target: "i1",
    payload: { listId: "l1", text: "Set tire pressure", order: 0 },
  });
  const row = eventToRow(e);
  assert.equal(row.length, 6);
  assert.equal(row[0], "e1");
  assert.equal(row[5], JSON.stringify(e.payload));
  assert.deepEqual(rowToEvent(row), e);
});

test("rowToEvent tolerates empty target and missing trailing payload cell", () => {
  assert.deepEqual(
    rowToEvent(["e9", t(2), "dA", "session.reset", "", '{"scope":"recycling"}']),
    { id: "e9", time: t(2), device: "dA", op: "session.reset", target: "", payload: { scope: "recycling" } },
  );
  // Sheets omits trailing empty cells: a short row still parses.
  const parsed = rowToEvent(["e10", t(3), "dA", "list.delete", "l1"]);
  assert.equal(parsed.target, "l1");
  assert.deepEqual(parsed.payload, {});
});

test("mergeEvents unions two event sets and dedupes by id", () => {
  const local = [ev("e1", t(1), "d", "item.check", "i1", { checked: true })];
  const pulled = [
    ev("e1", t(1), "d", "item.check", "i1", { checked: true }),
    ev("e2", t(2), "d", "item.check", "i2", { checked: true }),
  ];
  const merged = mergeEvents(local, pulled);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((e) => e.id).sort(), ["e1", "e2"]);
});

// -----------------------------------------------------------------
// helpers
// -----------------------------------------------------------------

// Distinct ISO timestamps in ascending order, one per integer.
function t(n) {
  return new Date(Date.UTC(2026, 6, 2, 10, 0, n)).toISOString();
}

function ev(id, time, device, op, target, payload = {}) {
  return { id, time, device, op, target, payload };
}
