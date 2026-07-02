// =================================================================
// Track Day Checklist — boot / mode router
//
// The app has two modes:
//   • Local mode  — the original anonymous, offline, localStorage
//                   experience (local.js). Default, and the fallback
//                   if Google sign-in is unavailable.
//   • Cloud mode  — Google-signed-in, Sheet-backed, synced, with
//                   user-defined lists (added in a later phase).
//
// This file only decides which controller to boot.
// =================================================================

import * as local from "./local.js";

window.addEventListener("DOMContentLoaded", () => {
  // Cloud mode is added in a later phase; for now the app always boots
  // into Local mode with behaviour identical to the original app.
  local.enter();
});
