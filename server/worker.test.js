import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "./worker.js";

const ORIGIN = "https://poindextrose.github.io";
const CID = "CID.apps.googleusercontent.com";

test("OPTIONS preflight from the allowed origin returns CORS headers", async () => {
  const env = makeEnv();
  const res = await handle(req("OPTIONS", "/token", { origin: ORIGIN }), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("a POST from a disallowed origin is rejected", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const res = await handle(
    req("POST", "/token", { origin: "https://evil.example.com", body: { session_token: "x" } }),
    env,
  );
  assert.equal(res.status, 403);
});

test("/exchange stores a refresh token and returns a session token", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const res = await handle(
    req("POST", "/exchange", { origin: ORIGIN, body: { code: "AUTHCODE", code_verifier: "v" } }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.session_token, "returns a session token");
  assert.equal(data.access_token, "AT_new");
  const rec = JSON.parse(await env.TOKENS.get(data.session_token));
  assert.equal(rec.refresh_token, "RT_123", "refresh token stored server-side");
  assert.equal(rec.sub, "user-123", "user id extracted from id_token");
});

test("/exchange reports no_refresh_token when Google omits one", async () => {
  const env = makeEnv({ __fetch: googleStub({ withRefresh: false }) });
  const res = await handle(
    req("POST", "/exchange", { origin: ORIGIN, body: { code: "AUTHCODE" } }),
    env,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "no_refresh_token");
});

test("/exchange succeeds with no id_token (drive.file-only scope, no openid)", async () => {
  const env = makeEnv({ __fetch: googleStub({ noIdToken: true }) });
  const res = await handle(
    req("POST", "/exchange", { origin: ORIGIN, body: { code: "AUTHCODE" } }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.session_token, "session created without an id_token");
  const rec = JSON.parse(await env.TOKENS.get(data.session_token));
  assert.equal(rec.refresh_token, "RT_123");
  assert.equal(rec.sub, "", "no user id when there's no id_token");
});

test("/exchange ignores a mismatched-aud id_token but still succeeds", async () => {
  const env = makeEnv({ __fetch: googleStub({ aud: "someone-else" }) });
  const res = await handle(
    req("POST", "/exchange", { origin: ORIGIN, body: { code: "AUTHCODE" } }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  const rec = JSON.parse(await env.TOKENS.get(data.session_token));
  assert.equal(rec.sub, "", "sub not captured from a mismatched-aud token");
});

test("/token mints a fresh access token for a valid session", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const ex = await (
    await handle(req("POST", "/exchange", { origin: ORIGIN, body: { code: "C" } }), env)
  ).json();
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: ex.session_token } }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).access_token, "AT_refreshed");
});

test("/token returns 401 unknown_session for a bogus token", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: "nope" } }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unknown_session");
});

test("/token returns 401 revoked and deletes the row when the refresh token is invalid", async () => {
  const env = makeEnv({ __fetch: googleStub({ refreshInvalid: true }) });
  const ex = await (
    await handle(req("POST", "/exchange", { origin: ORIGIN, body: { code: "C" } }), env)
  ).json();
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: ex.session_token } }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "revoked");
  assert.equal(await env.TOKENS.get(ex.session_token), null, "row deleted");
});

test("/token returns a transient 503 (keeps the session) on an upstream error", async () => {
  const env = makeEnv({ __fetch: googleStub({ refreshServerError: true }) });
  const ex = await (
    await handle(req("POST", "/exchange", { origin: ORIGIN, body: { code: "C" } }), env)
  ).json();
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: ex.session_token } }),
    env,
  );
  assert.equal(res.status, 503);
  assert.ok(await env.TOKENS.get(ex.session_token), "session preserved for retry");
});

test("/token treats a corrupt KV record as a dead session (401) and deletes it", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  await env.TOKENS.put("corrupt", "not-json{");
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: "corrupt" } }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unknown_session");
  assert.equal(await env.TOKENS.get("corrupt"), null);
});

test("/token returns a transient 503 when Google is unreachable (fetch throws)", async () => {
  const env = makeEnv({ __fetch: googleStub({ refreshThrows: true }) });
  const ex = await (
    await handle(req("POST", "/exchange", { origin: ORIGIN, body: { code: "C" } }), env)
  ).json();
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: ex.session_token } }),
    env,
  );
  assert.equal(res.status, 503);
  assert.ok(await env.TOKENS.get(ex.session_token), "session preserved for retry");
});

test("every error response carries CORS headers the browser can read", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const res = await handle(
    req("POST", "/token", { origin: ORIGIN, body: { session_token: "nope" } }),
    env,
  );
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("/signout deletes the session row", async () => {
  const env = makeEnv({ __fetch: googleStub() });
  const ex = await (
    await handle(req("POST", "/exchange", { origin: ORIGIN, body: { code: "C" } }), env)
  ).json();
  const res = await handle(
    req("POST", "/signout", { origin: ORIGIN, body: { session_token: ex.session_token } }),
    env,
  );
  assert.equal(res.status, 204);
  assert.equal(await env.TOKENS.get(ex.session_token), null);
});

test("/health returns ok", async () => {
  const env = makeEnv();
  const res = await handle(req("GET", "/health", { origin: ORIGIN }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

// -----------------------------------------------------------------
// fakes
// -----------------------------------------------------------------

function fakeKV() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    GOOGLE_CLIENT_ID: CID,
    GOOGLE_CLIENT_SECRET: "SECRET",
    ALLOWED_ORIGIN: ORIGIN,
    TOKENS: fakeKV(),
    ...overrides,
  };
}

function req(method, path, { origin, body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("https://broker.example.com" + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function b64url(s) {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fakeIdToken(payload) {
  return "hdr." + b64url(JSON.stringify(payload)) + ".sig";
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Stubs Google's token + revoke endpoints.
function googleStub(opts = {}) {
  const {
    withRefresh = true,
    refreshInvalid = false,
    refreshServerError = false,
    refreshThrows = false,
    noIdToken = false,
    aud = CID,
  } = opts;
  return async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const params = new URLSearchParams(init.body);
      const grant = params.get("grant_type");
      if (grant === "refresh_token" && refreshThrows) throw new Error("network down");
      if (grant === "authorization_code") {
        const body = { access_token: "AT_new", expires_in: 3599 };
        // An id_token is only present when the openid scope is requested.
        if (!noIdToken) {
          body.id_token = fakeIdToken({
            aud,
            iss: "https://accounts.google.com",
            sub: "user-123",
            email: "a@b.com",
            exp: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        if (withRefresh) body.refresh_token = "RT_123";
        return jsonResp(body, 200);
      }
      if (grant === "refresh_token") {
        if (refreshInvalid) return jsonResp({ error: "invalid_grant" }, 400);
        if (refreshServerError) return jsonResp({ error: "backend_error" }, 500);
        return jsonResp({ access_token: "AT_refreshed", expires_in: 3599 }, 200);
      }
    }
    if (u.startsWith("https://oauth2.googleapis.com/revoke")) return jsonResp({}, 200);
    return jsonResp({ error: "unexpected_request" }, 400);
  };
}
