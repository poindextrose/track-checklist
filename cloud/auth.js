// =================================================================
// Track Day Checklist — Google sign-in (GIS token model)
//
// Uses Google Identity Services' OAuth token client, loaded from a CDN
// <script> (no bundler). Requests only the drive.file scope. We persist the
// short-lived access token (+ expiry) in localStorage alongside
// tcl_mode="cloud", the spreadsheet id, and the Client ID, so a relaunch
// (including an iOS home-screen app, which loses in-memory state and can't
// silently re-auth) reconnects instantly while the token is still valid.
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
const LS_ACCESS_TOKEN = "tcl_access_token";
const LS_TOKEN_EXPIRY = "tcl_token_expiry";

// The app's OAuth Web Client ID. Not a secret — it only works from the
// Authorized JavaScript origins configured in the Google Cloud project. If
// left blank, the app falls back to a value stored in localStorage (settable
// via the Cloud settings field).
const HARDCODED_CLIENT_ID =
  "339043595837-1bga1hrs7vl40vqo0jbna9d7f5pg2avn.apps.googleusercontent.com";

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // epoch ms

// Restore a previously-acquired token from localStorage, but only if it's
// still valid. This is what lets an iOS home-screen app (which loses all
// in-memory state and can't silently re-auth) reconnect instantly on relaunch
// within the token's ~1-hour lifetime instead of forcing a fresh sign-in.
(function restoreToken() {
  try {
    const t = localStorage.getItem(LS_ACCESS_TOKEN);
    const exp = Number(localStorage.getItem(LS_TOKEN_EXPIRY) || 0);
    if (t && exp > Date.now() + 60_000) {
      accessToken = t;
      tokenExpiry = exp;
    }
  } catch {
    /* ignore */
  }
})();

function persistToken() {
  try {
    localStorage.setItem(LS_ACCESS_TOKEN, accessToken);
    localStorage.setItem(LS_TOKEN_EXPIRY, String(tokenExpiry));
  } catch {
    /* ignore */
  }
}

function clearToken() {
  accessToken = null;
  tokenExpiry = 0;
  try {
    localStorage.removeItem(LS_ACCESS_TOKEN);
    localStorage.removeItem(LS_TOKEN_EXPIRY);
  } catch {
    /* ignore */
  }
}

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

// True when the user previously signed in on this device (mode + a known
// spreadsheet cached). The access token is NOT persisted, so this doesn't
// mean we currently hold a valid token — just that we should resume Cloud
// mode and (re)acquire a token lazily.
export function hasCloudSession() {
  return (
    isCloudSelected() && clientIdConfigured() && !!localStorage.getItem(LS_SHEET_ID)
  );
}

// A session restored from cached identifiers, WITHOUT a token yet. The app
// boots straight into Cloud mode from the local cache (offline-first); the
// token is obtained lazily and silently by ensureFreshToken on the first sync.
export function cachedSession() {
  return session(localStorage.getItem(LS_SHEET_ID));
}

export function signOut() {
  const tok = accessToken;
  clearToken();
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

let pendingReject = null;

function ensureTokenClient() {
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPE,
    callback: () => {}, // success handler set per request
    error_callback: (err) => {
      // Fires for popup-blocked, silent-refresh failure, user-cancel, etc.
      if (pendingReject) {
        const rej = pendingReject;
        pendingReject = null;
        rej(new Error(err && err.type ? err.type : "token_error"));
      }
    },
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    ensureTokenClient();
    pendingReject = reject;
    const timer = setTimeout(() => {
      if (pendingReject) {
        pendingReject = null;
        reject(new Error("token_timeout"));
      }
    }, 10000);
    const done = (fn, value) => {
      clearTimeout(timer);
      pendingReject = null;
      fn(value);
    };
    tokenClient.callback = (resp) => {
      if (resp && resp.access_token) {
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + Number(resp.expires_in || 3600) * 1000;
        persistToken();
        done(resolve, accessToken);
      } else {
        done(reject, new Error(resp && resp.error ? resp.error : "token_failed"));
      }
    };
    try {
      tokenClient.requestAccessToken({ prompt });
    } catch (err) {
      done(reject, err);
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
