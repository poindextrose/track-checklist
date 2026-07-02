# Google Cloud setup for Track Day Checklist (Cloud mode)

Cloud mode signs you in with Google and stores your lists in **one Google
Sheet that the app creates in your own Drive**. To allow that, you create a
Google Cloud project and an **OAuth Client ID**. This is a one-time setup.

**What you'll end up with:** a single string — an **OAuth Client ID** — that
gets pasted into the app. That's the only output you need from this whole
process.

**Good to know before you start:**

- The Client ID is **not a secret**. It's safe to commit in client-side code.
  What protects your data is (a) the narrow `drive.file` scope and (b) the
  list of authorized website origins you configure below.
- We request **only** the `.../auth/drive.file` scope — the app can read/write
  **only files it created**, never the rest of your Drive. This is a
  non-sensitive scope, so Google won't put you through app verification.
- **No API key, no client secret, no billing** required for this app.
- You'll keep the app in **"Testing"** mode with yourself as a test user. That
  avoids Google's verification process entirely and is the right choice for a
  personal app.

> Google renames these console screens periodically (the OAuth settings now
> live under a section sometimes called **"Google Auth Platform"**). The
> step names below describe the *goal* of each screen so you can find it even
> if a label has changed.

---

## Step 1 — Create a project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → the **project dropdown** → **New Project**.
3. Name it e.g. `track-day-checklist` → **Create**.
4. Make sure that new project is **selected** in the top bar before continuing.

## Step 2 — Enable the APIs

The app calls two Google APIs. Enable both **in this project**:

1. Go to **APIs & Services → Library** (or search "API Library").
2. Search **"Google Drive API"** → open it → **Enable**.
3. Search **"Google Sheets API"** → open it → **Enable**.

(Drive API is used to create/find the Sheet; Sheets API reads and writes it.)

## Step 3 — Configure the consent screen / audience

Go to **APIs & Services → OAuth consent screen** (may appear as **Google Auth
Platform**). Fill in:

1. **Audience / User type:** choose **External**. (Personal Gmail accounts
   can't use "Internal" — that's Workspace-only. External is correct.)
2. **App information:** App name = `Track Day Checklist`; User support email =
   your email; Developer contact email = your email. Logo/homepage optional.
3. **Publishing status:** leave it as **Testing** (do **not** click "Publish
   app").
4. **Test users:** add **your own Google account** (the address you'll sign in
   with in the Tesla and on your laptop). Only listed test users can sign in
   while in Testing mode — that's fine, it's just you. You can add up to 100.
5. **Scopes / Data access:** add the scope
   `https://www.googleapis.com/auth/drive.file`
   (search "drive.file" in the scope picker, or "Add scope manually" and paste
   the full URL). Do **not** add broader Drive scopes. Save.

## Step 4 — Create the OAuth Client ID

Go to **APIs & Services → Credentials** (or **Google Auth Platform → Clients**):

1. **Create Credentials → OAuth client ID**.
2. **Application type:** **Web application**.
3. **Name:** `Track Day Checklist Web`.
4. **Authorized JavaScript origins →** click **Add URI** for each origin the
   app will be served from. An origin is **scheme + host + port only — no path,
   no trailing slash**:
   - `http://localhost:8017` — the local dev server used while building/testing.
   - `http://localhost:8000` — the port the README's `python3 -m http.server`
     uses, in case you run that instead.
   - `https://<your-github-username>.github.io` — your GitHub Pages origin
     (add this once you know your username; it's the **origin only**, even
     though the app lives at `.../<repo>/`). If you later put it on a custom
     domain, add that domain too.
5. **Authorized redirect URIs:** leave **empty**. This app uses Google's
   token model (a popup that posts the token back), which does not use
   redirect URIs.
6. **Create.**

## Step 5 — Copy the Client ID

A dialog shows your **Client ID** (looks like
`1234567890-abc123def456.apps.googleusercontent.com`). Copy it.

- You can ignore/close the "client secret" — this app doesn't use it.
- Paste the Client ID here when I wire up sign-in, or drop it into
  `cloud/auth.js` as `GOOGLE_CLIENT_ID` (the app will also accept it via a
  one-time field in Cloud settings). **Send me this string when you have it**
  and I'll finish the auth wiring and test it end-to-end.

---

## Gotchas & verification

- **Origin must match exactly.** `https://name.github.io/repo/` will **fail**
  — use `https://name.github.io` (no path). `http` vs `https` and the port
  number must match the address bar exactly.
- **Changes take a minute.** New origins/test users can take a few minutes to
  propagate; if sign-in errors right after editing, wait and retry.
- **"Google hasn't verified this app" screen:** expected in Testing mode for
  your own test-user account — click **Advanced → Continue**. Because we only
  use `drive.file`, you likely won't even see it, but if you do, it's safe for
  your own account.
- **Access tokens last ~1 hour.** The app refreshes silently while you have a
  live Google session; you shouldn't have to re-sign-in mid-track-day.
- **Tesla browser risk (the big one):** Google may block sign-in in the
  Tesla's older in-car browser as "not a secure browser." **Test sign-in on
  the actual car early.** If it's blocked, Local mode still works fully offline
  — nothing is lost, you just won't get cloud sync in the car.
- **Nothing here costs money** or needs billing enabled.

## What I need back from you

Just the **Client ID** string from Step 5, plus your **GitHub Pages URL**
(or intended username) so we get the production origin right. With those I'll
finish `cloud/auth.js`, connect it to your Sheet, and we'll test the full
sign-in → create-sheet → sync round-trip.
