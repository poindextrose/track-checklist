import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheetsClient } from "./sheets.js";

test("readRowsFrom(0) reads from data row 2 (below the header) and returns rows", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return resp({ values: [row("e1")] });
  };
  const c = createSheetsClient({ getToken: () => "TOK", spreadsheetId: "SID", fetchImpl });
  const rows = await c.readRowsFrom(0);
  assert.ok(seen.url.includes("/spreadsheets/SID/values/"));
  assert.ok(seen.url.includes(encodeURIComponent("Log!A2:F")), `range in ${seen.url}`);
  assert.equal(seen.opts.headers.Authorization, "Bearer TOK");
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "e1");
});

test("readRowsFrom(n) offsets past the header and already-consumed rows", async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return resp({ values: [] });
  };
  const c = createSheetsClient({ getToken: () => "TOK", spreadsheetId: "SID", fetchImpl });
  await c.readRowsFrom(5); // 5 data rows consumed -> next is sheet row 7
  assert.ok(seen.includes(encodeURIComponent("Log!A7:F")), `range in ${seen}`);
});

test("readRowsFrom returns [] when the range is empty (no values field)", async () => {
  const fetchImpl = async () => resp({}); // Sheets omits `values` for an empty range
  const c = createSheetsClient({ getToken: () => "TOK", spreadsheetId: "SID", fetchImpl });
  assert.deepEqual(await c.readRowsFrom(0), []);
});

test("appendRows posts rows to the append endpoint with RAW + INSERT_ROWS", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return resp({ updates: { updatedRows: 2 } });
  };
  const c = createSheetsClient({ getToken: () => "TOK2", spreadsheetId: "SID", fetchImpl });
  await c.appendRows([row("e1"), row("e2")]);
  assert.ok(seen.url.includes("/spreadsheets/SID/values/"));
  assert.ok(seen.url.includes(":append"));
  assert.ok(seen.url.includes("valueInputOption=RAW"));
  assert.ok(seen.url.includes("insertDataOption=INSERT_ROWS"));
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers.Authorization, "Bearer TOK2");
  assert.deepEqual(JSON.parse(seen.opts.body).values, [row("e1"), row("e2")]);
});

test("a non-OK response throws (so the store treats it as offline/retryable)", async () => {
  const fetchImpl = async () => resp({ error: "boom" }, false);
  const c = createSheetsClient({ getToken: () => "TOK", spreadsheetId: "SID", fetchImpl });
  await assert.rejects(() => c.readRowsFrom(0));
  await assert.rejects(() => c.appendRows([row("e1")]));
});

// -----------------------------------------------------------------
// helpers
// -----------------------------------------------------------------

function row(id) {
  return [id, "2026-07-02T10:00:00Z", "dA", "item.check", "i1", '{"checked":true}'];
}

function resp(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
