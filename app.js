// =================================================================
// Track Day Checklist — boot / mode router
//
// Two modes:
//   • Local mode  — the original anonymous, offline, localStorage app
//                   (local.js). Default, and the fallback if Google
//                   sign-in is unavailable.
//   • Cloud mode  — Google-signed-in, Sheet-backed, synced, user-defined
//                   lists (cloud/*). Activated on sign-in.
//
// This file decides which controller to boot and wires the sign-in entry.
// =================================================================

import * as local from "./local.js";
import { toast } from "./core.js";
import * as auth from "./cloud/auth.js";
import { createStore } from "./cloud/store.js";
import { createSheetsClient } from "./cloud/sheets.js";
import { enterCloud, leaveCloud } from "./cloud/ui.js";

const CLOUD_CACHE_KEY = "tcl_cloud_v1";

// -----------------------------------------------------------------
// Small platform helpers
// -----------------------------------------------------------------

function deviceId() {
  let d = localStorage.getItem("tcl_device_id");
  if (!d) {
    d = "dev-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("tcl_device_id", d);
  }
  return d;
}

function genId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "e-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function lsStorage(key) {
  return {
    load() {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    save(state) {
      localStorage.setItem(key, JSON.stringify(state));
    },
  };
}

// -----------------------------------------------------------------
// Cloud boot
// -----------------------------------------------------------------

// Build the cloud store + enter the UI (synchronous). session may be null for
// the test seam (a fake sheets client is injected instead).
function buildAndEnterCloud(session, sheets) {
  const store = createStore({
    device: deviceId(),
    sheets,
    storage: lsStorage(CLOUD_CACHE_KEY),
    clock: () => new Date().toISOString(),
    idgen: genId,
  });
  enterCloud({
    store,
    hooks: {
      ensureFreshToken: session ? session.ensureFreshToken : undefined,
      getClientId: auth.getClientId,
      onSetClientId: (v) => auth.setClientId(v),
      onSignOut: () => {
        auth.signOut();
        leaveCloud();
        local.enter();
      },
      // Interactive re-auth when the token can't be refreshed (tapping the
      // offline status pill — a real user gesture, so the popup/redirect works).
      onReconnect: session ? () => auth.signIn() : undefined,
    },
  });
  return store;
}

async function startCloud(session, sheetsClient) {
  if (sheetsClient) return buildAndEnterCloud(session, sheetsClient); // test seam

  let spreadsheetId = session ? session.spreadsheetId : null;
  if (session && !spreadsheetId) {
    // First sign-in (or a lost sheet id): resolve the user's Sheet now that we
    // can obtain a token. If it fails (offline/Drive blip), fall back to Local;
    // the durable session persists, so the next launch retries automatically.
    try {
      if (session.ensureFreshToken) await session.ensureFreshToken();
      spreadsheetId = await auth.ensureSheetId();
    } catch (e) {
      console.error("Couldn't resolve your Sheet yet:", e);
      local.enter();
      return;
    }
  }
  const sheets = createSheetsClient({ getToken: session.getToken, spreadsheetId });
  return buildAndEnterCloud(session, sheets);
}

async function signInFlow() {
  if (!auth.clientIdConfigured()) {
    const id = window.prompt(
      "Paste your Google OAuth Client ID (…apps.googleusercontent.com).\n" +
        "See docs/GCP_SETUP.md to create one.",
    );
    if (!id) return;
    auth.setClientId(id);
  }
  try {
    toast("Opening Google sign-in…");
    const session = await auth.signIn();
    startCloud(session);
  } catch (err) {
    console.error("Cloud sign-in failed:", err);
    toast("Sign-in failed: " + errText(err), 8000);
  }
}

// Human-readable reason from a thrown auth error (backend error code, HTTP
// status, or message) so a failed sign-in surfaces something actionable.
function errText(err) {
  if (!err) return "unknown";
  return err.code || err.message || String(err);
}

// -----------------------------------------------------------------
// Boot
// -----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  // Sign-in entry points (setup screen + Local settings modal).
  document.querySelectorAll(".cloud-signin-trigger").forEach((btn) => {
    btn.addEventListener("click", signInFlow);
  });

  // Test/dev seam: drive Cloud mode against an injected Sheets client with no
  // Google. Used for automated browser verification of the cloud UI + store.
  window.__tclCloudTest = (fakeSheets) => buildAndEnterCloud(null, fakeSheets);

  if (auth.hasPendingRedirect()) {
    // Backend mode: we just came back from Google's auth-code redirect.
    auth
      .completeRedirectSignIn()
      .then((session) => startCloud(session))
      .catch((err) => {
        console.error("Cloud sign-in failed:", err);
        // A failed/cancelled sign-in must not clobber an existing session —
        // resume it if we still have one, otherwise fall back to Local.
        if (auth.hasCloudSession()) {
          startCloud(auth.cachedSession());
        } else {
          toast("Sign-in failed: " + errText(err), 8000);
          local.enter();
        }
      });
    return;
  }

  if (auth.hasCloudSession()) {
    // Previously signed in on this device: resume Cloud mode immediately from
    // the local cache (offline-first). The token is re-acquired silently on
    // the first sync; if that can't happen, the user stays in Cloud mode and
    // can tap the offline pill to reconnect.
    startCloud(auth.cachedSession());
  } else {
    local.enter();
  }
});
