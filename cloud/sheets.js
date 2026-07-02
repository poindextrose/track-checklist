// =================================================================
// Track Day Checklist — Google Sheets / Drive transport
//
// Implements the { appendRows, readRowsFrom } interface the store depends
// on, over the Sheet's append-only "Log" tab, plus find-or-create of the
// app's spreadsheet. Uses only the drive.file scope (the app touches only
// the file it created). fetch is injected so request construction is unit-
// testable without a network.
//
// Log tab layout: row 1 is the header (LOG_HEADER); data starts at row 2.
// The store counts *data* rows, so data row N (0-based) is sheet row N+2.
// =================================================================

import { LOG_HEADER } from "./log.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const TAB = "Log";
const DEFAULT_TITLE = "TrackDayChecklist";

export function createSheetsClient({ getToken, spreadsheetId, fetchImpl = globalThis.fetch }) {
  const cfg = { getToken, fetchImpl };

  async function readRowsFrom(startRow) {
    // startRow data rows already consumed -> begin at sheet row startRow + 2.
    const range = `${TAB}!A${startRow + 2}:F`;
    const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const body = await apiRequest({ method: "GET", url, ...cfg });
    return body.values || [];
  }

  async function appendRows(rows) {
    if (!rows || !rows.length) return;
    const range = `${TAB}!A:F`;
    const url =
      `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}:append` +
      `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await apiRequest({ method: "POST", url, body: { values: rows }, ...cfg });
  }

  return { readRowsFrom, appendRows };
}

// Find the app's spreadsheet (created under drive.file, so the Drive query
// only ever sees files this app made) or create it with a Log tab + header.
export async function findOrCreateSpreadsheet({
  getToken,
  fetchImpl = globalThis.fetch,
  title = DEFAULT_TITLE,
}) {
  const cfg = { getToken, fetchImpl };

  const q =
    `name='${title}' and ` +
    `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  const listUrl =
    `${DRIVE_API}?q=${encodeURIComponent(q)}&spaces=drive` +
    `&fields=${encodeURIComponent("files(id,name)")}`;
  const found = await apiRequest({ method: "GET", url: listUrl, ...cfg });
  if (found.files && found.files.length) return found.files[0].id;

  // Create the spreadsheet with a single Log tab.
  const created = await apiRequest({
    method: "POST",
    url: SHEETS_API,
    body: { properties: { title }, sheets: [{ properties: { title: TAB } }] },
    ...cfg,
  });
  const id = created.spreadsheetId;

  // Seed the header row.
  const headerRange = `${TAB}!A1:F1`;
  const headerUrl =
    `${SHEETS_API}/${id}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`;
  await apiRequest({ method: "PUT", url: headerUrl, body: { values: [LOG_HEADER] }, ...cfg });

  return id;
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

async function apiRequest({ method, url, getToken, fetchImpl, body }) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, opts);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Sheets ${method} failed (${res.status}): ${detail}`);
  }
  return res.json();
}
