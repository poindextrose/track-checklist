// =================================================================
// Track Day Checklist — Google sign-in
//
// Two modes, chosen by whether AUTH_BASE (a refresh-token broker URL) is set:
//
//  • Backend mode (AUTH_BASE set): OAuth authorization-code flow. The browser
//    gets a code, the broker (server/worker.js) exchanges it for a refresh
//    token it keeps server-side, and mints short-lived access tokens on
//    demand via /token. The client stores only a durable opaque session token,
//    so users stay signed in INDEFINITELY (survives an iOS home-screen relaunch
//    with no live Google session).
//  • Legacy mode (AUTH_BASE empty): the original GIS token flow — access token
//    only (~1h), silent refresh while a Google session is live. This is the
//    default and the automatic fallback if the broker is unreachable.
//
// Either way the app calls Google Sheets/Drive directly with the access token,
// so a "session" object stays { getToken(), spreadsheetId, ensureFreshToken(),
// signOut() } and nothing else in the app changes.
// =================================================================

import { findOrCreateSpreadsheet } from "./sheets.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const LS_MODE = "tcl_mode";
const LS_SHEET_ID = "tcl_sheet_id";
const LS_CLIENT_ID = "tcl_client_id";
const LS_ACCESS_TOKEN = "tcl_access_token";
const LS_TOKEN_EXPIRY = "tcl_token_expiry";
const LS_SESSION_TOKEN = "tcl_session_token"; // durable broker session (backend mode)
const LS_OAUTH_STATE = "tcl_oauth_state"; // CSRF state across the code redirect
const LS_AUTH_BASE = "tcl_auth_base"; // broker URL override

// The app's OAuth Web Client ID. Not a secret — it only works from the
// Authorized JavaScript origins configured in the Google Cloud project.
const HARDCODED_CLIENT_ID =
  "339043595837-1bga1hrs7vl40vqo0jbna9d7f5pg2avn.apps.googleusercontent.com";

// Base URL of the refresh-token broker (server/worker.js on Cloudflare).
// Empty = legacy 1-hour token flow. Set this to the deployed Worker URL to
// enable indefinite sign-in.
const HARDCODED_AUTH_BASE = "";

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0; // epoch ms

// Restore a previously-acquired access token if still valid — a warm-path
// optimization so a quick reload/relaunch skips a network round-trip.
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

// -----------------------------------------------------------------
// Config
// -----------------------------------------------------------------

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

function getAuthBase() {
  return (HARDCODED_AUTH_BASE || localStorage.getItem(LS_AUTH_BASE) || "").replace(/\/+$/, "");
}

export function setAuthBase(url) {
  localStorage.setItem(LS_AUTH_BASE, (url || "").trim().replace(/\/+$/, ""));
}

function useBackend() {
  return getAuthBase().length > 0;
}

// -----------------------------------------------------------------
// Sign-in
// -----------------------------------------------------------------

export async function signIn() {
  if (useBackend()) return startRedirectSignIn(); // navigates away; completes on return
  // Legacy GIS token flow.
  await loadGis();
  await requestToken("consent");
  localStorage.setItem(LS_MODE, "cloud");
  return session(localStorage.getItem(LS_SHEET_ID)); // sheet resolved by startCloud
}

function redirectUri() {
  return location.origin + location.pathname;
}

// Backend mode: full-page redirect to Google's auth-code endpoint. We force
// offline access + consent so Google always returns a refresh token to the
// broker. Reliable on desktop and robust vs. iOS popup quirks (do the one-time
// sign-in in Safari, then add to home screen — later relaunches never redirect).
function startRedirectSignIn() {
  const state = randomToken();
  localStorage.setItem(LS_OAUTH_STATE, state);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: redirectUri(),
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
  return new Promise(() => {}); // page is navigating away; never resolves here
}

// True on the redirect landing (backend mode) when Google sent us ?code&state.
export function hasPendingRedirect() {
  if (!useBackend()) return false;
  const p = new URLSearchParams(location.search);
  return p.has("code") || p.has("error");
}

// Complete the code exchange after the redirect back. Resolves to a session.
export async function completeRedirectSignIn() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");
  const state = p.get("state");
  const err = p.get("error");
  const expected = localStorage.getItem(LS_OAUTH_STATE);
  const uri = redirectUri();

  // Clean ?code/&state out of the URL and clear the one-time state.
  history.replaceState(null, "", uri);
  localStorage.removeItem(LS_OAUTH_STATE);

  if (err) {
    console.warn("OAuth redirect error:", err); // don't interpolate the raw value
    throw new Error("oauth_redirect_error");
  }
  if (!code || !state || state !== expected) throw new Error("oauth_state_mismatch");

  const data = await backendPost("/exchange", { code, redirect_uri: uri });
  // Commit the durable session BEFORE the fallible sheet lookup, so a transient
  // failure resolving the Sheet can't strand an otherwise-valid sign-in (the
  // auth code is single-use). The Sheet id is resolved lazily by startCloud.
  localStorage.setItem(LS_SESSION_TOKEN, data.session_token);
  localStorage.setItem(LS_MODE, "cloud");
  accessToken = data.access_token;
  tokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
  persistToken();
  return session(localStorage.getItem(LS_SHEET_ID));
}

// -----------------------------------------------------------------
// Session state
// -----------------------------------------------------------------

export function hasCloudSession() {
  if (!isCloudSelected() || !clientIdConfigured()) return false;
  // Backend mode only needs the durable broker session — the Sheet id is
  // re-derivable (startCloud resolves it). Legacy mode needs a cached sheet id.
  if (useBackend()) return !!localStorage.getItem(LS_SESSION_TOKEN);
  return !!localStorage.getItem(LS_SHEET_ID);
}

export function cachedSession() {
  return session(localStorage.getItem(LS_SHEET_ID));
}

// Resolve (find-or-create + cache) the user's Sheet id using the current access
// token. Called by startCloud when the id isn't cached yet. Requires a valid
// token (call session.ensureFreshToken() first).
export async function ensureSheetId() {
  return ensureSheet();
}

export function signOut() {
  const tok = accessToken;
  const sessionToken = localStorage.getItem(LS_SESSION_TOKEN);
  clearToken();
  try {
    localStorage.removeItem(LS_SESSION_TOKEN);
  } catch {
    /* ignore */
  }
  localStorage.removeItem(LS_MODE); // back to Local; keep sheet id + client id cached
  if (useBackend() && sessionToken) {
    // Revoke + delete server-side (best effort).
    backendPost("/signout", { session_token: sessionToken }).catch(() => {});
  } else {
    try {
      if (tok && window.google?.accounts?.oauth2?.revoke) {
        google.accounts.oauth2.revoke(tok, () => {});
      }
    } catch {
      /* best effort */
    }
  }
}

// -----------------------------------------------------------------
// Token freshness (called by the poll loop before each sync)
// -----------------------------------------------------------------

async function ensureFreshToken() {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

  if (useBackend()) {
    const sessionToken = localStorage.getItem(LS_SESSION_TOKEN);
    if (!sessionToken) throw new Error("no_session");
    try {
      const data = await backendPost("/token", { session_token: sessionToken });
      accessToken = data.access_token;
      tokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
      persistToken();
      return accessToken;
    } catch (e) {
      // Dead session (revoked/expired/unknown) → wipe so the UI prompts a
      // re-sign-in. Transient errors (503/network) keep the session for retry.
      if (e && e.status === 401) {
        clearToken();
        try {
          localStorage.removeItem(LS_SESSION_TOKEN);
        } catch {
          /* ignore */
        }
        localStorage.removeItem(LS_MODE);
      }
      throw e;
    }
  }

  // Legacy silent refresh.
  await requestToken("");
  return accessToken;
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

async function backendPost(path, body) {
  const res = await fetch(getAuthBase() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "http_" + res.status);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
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

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- legacy GIS token flow (fallback when AUTH_BASE is empty) ----

let pendingReject = null;

function ensureTokenClient() {
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPE,
    callback: () => {}, // success handler set per request
    error_callback: (err) => {
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
