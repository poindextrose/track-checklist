// =================================================================
// Track Day Checklist — Google sign-in (GIS token model)
//
// Uses Google Identity Services' OAuth token client, loaded from a CDN
// <script> (no bundler). Requests only the drive.file scope. The access
// token lives in memory only (short-lived, sensitive); what we persist is
// tcl_mode="cloud", the discovered spreadsheet id, and the Client ID, so a
// reload can silently re-auth and reconnect.
//
// A sign-in returns a "session":
//   { getToken(), spreadsheetId, ensureFreshToken(), signOut() }
// The store's Sheets client calls getToken() synchronously; the poll loop
// calls ensureFreshToken() before each cycle so the token stays valid.
// =================================================================

import { findOrCreateSpreadsheet } from "./sheets.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const LS_MODE = "tcl_mode";
const LS_SHEET_ID = "tcl_sheet_id";
const LS_CLIENT_ID = "tcl_client_id";

// Optionally hard-code your OAuth Web Client ID here. If left blank, the app
// reads it from localStorage (settable via the Cloud settings field), so the
// same static build works for anyone who supplies their own.
const HARDCODED_CLIENT_ID = "";

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // epoch ms

export function getClientId() {
  return HARDCODED_CLIENT_ID || localStorage.getItem(LS_CLIENT_ID) || "";
}

export function setClientId(id) {
  localStorage.setItem(LS_CLIENT_ID, (id || "").trim());
}

export function clientIdConfigured() {
  return getClientId().length > 0;
}

export function isCloudSelected() {
  return localStorage.getItem(LS_MODE) === "cloud";
}

// Interactive sign-in (button press). Resolves to a session.
export async function signIn() {
  await loadGis();
  await requestToken("consent");
  const spreadsheetId = await ensureSheet();
  localStorage.setItem(LS_MODE, "cloud");
  return session(spreadsheetId);
}

// Silent reconnect on boot when cloud was previously selected. Resolves to a
// session, or null if we can't silently re-auth (caller falls back to Local).
export async function resume() {
  if (!isCloudSelected() || !clientIdConfigured()) return null;
  try {
    await loadGis();
    await requestToken(""); // silent: no UI if a Google session exists
    const spreadsheetId = await ensureSheet();
    return session(spreadsheetId);
  } catch {
    return null;
  }
}

export function signOut() {
  const tok = accessToken;
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem(LS_MODE); // back to Local; keep sheet id + client id cached
  try {
    if (tok && window.google?.accounts?.oauth2?.revoke) {
      google.accounts.oauth2.revoke(tok, () => {});
    }
  } catch {
    /* best effort */
  }
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

function session(spreadsheetId) {
  return {
    getToken: () => accessToken,
    spreadsheetId,
    ensureFreshToken,
    signOut,
  };
}

async function ensureFreshToken() {
  // Refresh a bit before expiry, or if we somehow have no token.
  if (!accessToken || Date.now() > tokenExpiry - 60_000) {
    await requestToken("");
  }
  return accessToken;
}

async function ensureSheet() {
  let id = localStorage.getItem(LS_SHEET_ID);
  if (id) {
    return id; // trust the cache; a stale/deleted id surfaces as a sync error
  }
  id = await findOrCreateSpreadsheet({ getToken: () => accessToken });
  localStorage.setItem(LS_SHEET_ID, id);
  return id;
}

function ensureTokenClient() {
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPE,
    callback: () => {}, // replaced per request
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    ensureTokenClient();
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + Number(resp.expires_in || 3600) * 1000;
      resolve(accessToken);
    };
    try {
      tokenClient.requestAccessToken({ prompt });
    } catch (err) {
      reject(err);
    }
  });
}

// Wait for the GIS script (loaded async in index.html) to define its API.
function loadGis(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("Google sign-in library failed to load"));
      }
    }, 100);
  });
}
