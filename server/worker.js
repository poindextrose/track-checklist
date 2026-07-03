// =================================================================
// Track Day Checklist — OAuth refresh-token broker (Cloudflare Worker)
//
// A tiny stateless-ish token broker so the static client can keep users
// signed in indefinitely. It holds the OAuth client SECRET and each user's
// refresh token (in KV), and mints short-lived access tokens on demand. The
// client still calls Google Sheets/Drive directly with those access tokens —
// this server never sees the app's data.
//
//   POST /exchange {code, redirect_uri, code_verifier}
//        -> swap auth code for tokens, store refresh token, return a durable
//           opaque session_token + a first access_token.
//   POST /token    {session_token} -> mint a fresh access_token.
//   POST /signout  {session_token} -> revoke + delete.
//   GET  /health   -> {ok:true}
//
// Bindings (wrangler): KV namespace TOKENS; secrets GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, ALLOWED_ORIGIN. Tests inject env.__fetch to stub
// Google; production uses global fetch. Written with web-standard APIs only.
// =================================================================

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

// Auto-evict a session that hasn't been used in this long (seconds). Refreshed
// on every /token, so active users are unaffected; bounds the window a stolen
// but idle session_token stays usable. ~180 days.
const SESSION_TTL = 180 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};

export async function handle(request, env) {
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // Any unexpected throw still returns a CORS'd response the browser can read
  // (and which the client treats as transient — it never wipes the session).
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/health") {
      return json({ ok: true }, 200, cors);
    }

    if (request.method === "POST") {
      // The Origin equality check is CSRF hygiene (it blocks casual cross-site
      // *browser* calls), NOT the real authorization gate — a non-browser
      // client can forge Origin. Possession of the session_token is the actual
      // credential; its blast radius is bounded to this user's drive.file.
      if (!originAllowed(origin, env.ALLOWED_ORIGIN)) {
        return json({ error: "forbidden_origin" }, 403, cors);
      }
      const body = await request.json().catch(() => ({}));
      if (path === "/exchange") return exchange(body, env, cors);
      if (path === "/token") return mintToken(body, env, cors);
      if (path === "/signout") return signout(body, env, cors);
    }

    return json({ error: "not_found" }, 404, cors);
  } catch {
    return json({ error: "server_error" }, 500, cors);
  }
}

// -----------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------

async function exchange(body, env, cors) {
  const { code, redirect_uri, code_verifier } = body;
  if (!code) return json({ error: "missing_code" }, 400, cors);

  const params = {
    grant_type: "authorization_code",
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  };
  if (redirect_uri) params.redirect_uri = redirect_uri;
  if (code_verifier) params.code_verifier = code_verifier;

  const res = await googleToken(env, params);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: data.error || "invalid_grant", detail: data.error_description }, 400, cors);
  }
  if (!data.refresh_token) {
    // Google only returns a refresh token on first consent / when forced.
    return json({ error: "no_refresh_token" }, 400, cors);
  }

  // The id_token comes straight from Google over TLS (server-to-server), so
  // it's authentic; we just decode it to bind the session to the user, and
  // sanity-check the audience.
  const claims = decodeJwt(data.id_token);
  if (!claims || claims.aud !== env.GOOGLE_CLIENT_ID) {
    return json({ error: "bad_id_token" }, 400, cors);
  }

  const session_token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.TOKENS.put(
    session_token,
    JSON.stringify({
      refresh_token: data.refresh_token,
      sub: claims.sub,
      email: claims.email || "",
      created_at: now,
      last_used_at: now,
    }),
    { expirationTtl: SESSION_TTL },
  );

  return json(
    { session_token, access_token: data.access_token, expires_in: data.expires_in },
    200,
    cors,
  );
}

async function mintToken(body, env, cors) {
  const { session_token } = body;
  if (!session_token) return json({ error: "missing_session" }, 400, cors);

  const raw = await env.TOKENS.get(session_token);
  const rec = safeParse(raw);
  if (!rec || !rec.refresh_token) {
    // No row, or a corrupt one — treat as a dead session (client re-auths).
    if (raw) await env.TOKENS.delete(session_token);
    return json({ error: "unknown_session" }, 401, cors);
  }

  let res;
  try {
    res = await googleToken(env, {
      grant_type: "refresh_token",
      refresh_token: rec.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    });
  } catch {
    // Network-level failure reaching Google — transient, keep the session.
    return json({ error: "upstream_unreachable" }, 503, cors);
  }
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (data.error === "invalid_grant") {
      // Refresh token revoked/expired — kill the session so the client re-auths.
      await env.TOKENS.delete(session_token);
      return json({ error: "revoked" }, 401, cors);
    }
    // Transient upstream problem — keep the session, let the client retry.
    return json({ error: "upstream", detail: data.error }, 503, cors);
  }

  rec.last_used_at = Math.floor(Date.now() / 1000);
  await env.TOKENS.put(session_token, JSON.stringify(rec), { expirationTtl: SESSION_TTL });
  return json({ access_token: data.access_token, expires_in: data.expires_in }, 200, cors);
}

async function signout(body, env, cors) {
  const { session_token } = body;
  if (session_token) {
    const rec = safeParse(await env.TOKENS.get(session_token));
    if (rec && rec.refresh_token) {
      try {
        const doFetch = env.__fetch || fetch;
        await doFetch(GOOGLE_REVOKE + "?token=" + encodeURIComponent(rec.refresh_token), {
          method: "POST",
        });
      } catch {
        /* best effort */
      }
    }
    await env.TOKENS.delete(session_token);
  }
  return new Response(null, { status: 204, headers: cors });
}

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function googleToken(env, params) {
  const doFetch = env.__fetch || fetch;
  return doFetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

function corsHeaders(origin, allowed) {
  const h = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (originAllowed(origin, allowed)) h["Access-Control-Allow-Origin"] = allowed;
  return h;
}

function originAllowed(origin, allowed) {
  return !!origin && !!allowed && origin === allowed;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(jwt) {
  try {
    const part = String(jwt).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "===".slice((b64.length + 3) % 4);
    return JSON.parse(atob(pad));
  } catch {
    return null;
  }
}
