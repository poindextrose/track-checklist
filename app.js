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

function startCloud(session, sheetsClient) {
  const sheets =
    sheetsClient ||
    createSheetsClient({
      getToken: session.getToken,
      spreadsheetId: session.spreadsheetId,
    });
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
    },
  });
  return store;
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
    toast("Google sign-in failed — staying in Local mode.");
  }
}

// -----------------------------------------------------------------
// Boot
// -----------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  // Sign-in entry points (setup screen + Local settings modal).
  document.querySelectorAll(".cloud-signin-trigger").forEach((btn) => {
    btn.addEventListener("click", signInFlow);
  });

  if (auth.isCloudSelected()) {
    // Previously signed in — try to silently reconnect, else fall to Local.
    auth
      .resume()
      .then((session) => (session ? startCloud(session) : local.enter()))
      .catch(() => local.enter());
  } else {
    local.enter();
  }

  // Test/dev seam: drive Cloud mode against an injected Sheets client with no
  // Google. Used for automated browser verification of the cloud UI + store.
  window.__tclCloudTest = (fakeSheets) =>
    startCloud(null, fakeSheets);
});
