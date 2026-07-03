# Auth broker (Cloudflare Worker) — indefinite Google sign-in

This tiny Worker lets the static app keep users signed in **indefinitely**. It
holds the OAuth **client secret** and each user's **refresh token** (in KV), and
mints short-lived access tokens on demand. The app still talks to Google Sheets
directly with those tokens — this server never sees your checklist data.

Only `drive.file` scope is involved, so a leaked/abused session can only touch
the one Sheet the app created for that user.

## Endpoints

- `POST /exchange` `{code, redirect_uri}` → stores the refresh token, returns
  `{session_token, access_token, expires_in}`.
- `POST /token` `{session_token}` → `{access_token, expires_in}`.
- `POST /signout` `{session_token}` → revokes + deletes (204).
- `GET /health` → `{ok:true}`.

## One-time deploy

Prereqs: a (free) Cloudflare account and Node. Install the CLI: `npm i -g wrangler`.

```sh
cd server
wrangler login

# 1. Create the KV namespace, then paste the printed id into wrangler.toml
wrangler kv namespace create TOKENS

# 2. Set the three secrets (from your Google Cloud OAuth client)
wrangler secret put GOOGLE_CLIENT_ID        # 339043595837-...apps.googleusercontent.com
wrangler secret put GOOGLE_CLIENT_SECRET    # the client secret (see docs/GCP_SETUP.md)
wrangler secret put ALLOWED_ORIGIN          # https://poindextrose.github.io

# 3. Deploy
wrangler deploy
```

`wrangler deploy` prints your Worker URL (e.g.
`https://tcl-auth.<subdomain>.workers.dev`). Give that URL to set as the app's
`AUTH_BASE` (in `cloud/auth.js`, or `localStorage.tcl_auth_base` for testing).

## Google Cloud changes (see docs/GCP_SETUP.md)

- Copy the **client secret** from your OAuth client (previously ignored).
- Add your app URL as an **Authorized redirect URI**
  (e.g. `https://poindextrose.github.io/track-checklist/` and, for dev,
  `http://localhost:8017/`).
- **Publish the OAuth app to production** so refresh tokens don't expire after 7
  days. `drive.file` is non-sensitive, so this doesn't trigger verification.

## Local dev / tests

The Worker is written with web-standard APIs and is unit-tested in plain Node
(a fake KV + stubbed Google) — run `node --test server/worker.test.js` from the
repo root. To run it locally against real Google, use `wrangler dev`.
