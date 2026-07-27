"use strict";

// OAuth loopback-flow deadlines (#8) + PKCE/state hardening (Cluster D): an
// abandoned or declined Google consent must settle the flow (and free the
// port) instead of hanging forever — and a callback that doesn't carry THIS
// flow's state must be ignored outright, so a local injector can neither bind
// Plume to an attacker's account nor cancel the user's real consent. No
// network beyond 127.0.0.1 — every path here rejects or is ignored before any
// Google endpoint is contacted.

const { test } = require("node:test");
const assert = require("node:assert");
const { runOAuthFlow } = require("../src/main/gdocs.js");

const CREDS = { cid: "test-client-id", cs: "test-client-secret" };

function captureAuthUrl() {
  // openUrl is injected; instead of opening a browser, hand the URL to the test.
  let resolveUrl;
  const url = new Promise((r) => (resolveUrl = r));
  return { openUrl: (u) => resolveUrl(u), url };
}

async function startFlow(timeoutMs) {
  const { openUrl, url } = captureAuthUrl();
  const flow = runOAuthFlow(CREDS, openUrl, { timeoutMs });
  const authUrl = new URL(await url);
  const port = authUrl.searchParams.get("redirect_uri").match(/:(\d+)$/)[1];
  const state = authUrl.searchParams.get("state");
  return { flow, authUrl, port, state };
}

test("abandoned consent times out with OAUTH_TIMEOUT", async () => {
  const started = Date.now();
  await assert.rejects(
    runOAuthFlow(CREDS, () => {}, { timeoutMs: 200 }),
    (e) => e.code === "OAUTH_TIMEOUT"
  );
  assert.ok(Date.now() - started < 5_000, "settles promptly after the deadline");
});

test("declined consent (with valid state) rejects with OAUTH_DENIED", async () => {
  const { flow, port, state } = await startFlow(10_000);
  // Attach the rejection handler before triggering the deny, or the (fast)
  // rejection lands as an unhandledRejection.
  const rejected = assert.rejects(flow, (e) => e.code === "OAUTH_DENIED");
  const res = await fetch(`http://127.0.0.1:${port}/?error=access_denied&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /declined/i);
  await rejected;
});

test("injected code with WRONG state is ignored — flow keeps waiting, then times out", async () => {
  const { flow, port } = await startFlow(600);
  const res = await fetch(`http://127.0.0.1:${port}/?code=attacker-code&state=not-the-real-state`);
  assert.equal(res.status, 400, "injection answered with 400");
  // The injection must not have settled the flow with the attacker's code —
  // it stays pending until the deadline (a real callback would still win).
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});

test("injected code with MISSING state is ignored too", async () => {
  const { flow, port } = await startFlow(600);
  const res = await fetch(`http://127.0.0.1:${port}/?code=attacker-code`);
  assert.equal(res.status, 400);
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});

test("denial with wrong state can't cancel the flow", async () => {
  const { flow, port } = await startFlow(600);
  const res = await fetch(`http://127.0.0.1:${port}/?error=access_denied&state=wrong`);
  assert.equal(res.status, 400, "spoofed denial rejected");
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT", "times out — NOT OAUTH_DENIED");
});

test("stray requests (favicon) don't consume the flow; timeout still fires", async () => {
  const { flow, port } = await startFlow(500);
  const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(res.status, 404);
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});

test("auth URL carries the expected OAuth + PKCE parameters", async () => {
  const { flow, authUrl } = await startFlow(300);
  assert.equal(authUrl.origin, "https://accounts.google.com");
  assert.equal(authUrl.searchParams.get("client_id"), CREDS.cid);
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.match(authUrl.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  // base64url of a sha256 digest is 43 chars, no padding.
  assert.match(authUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  // 16 random bytes → 22 base64url chars.
  assert.match(authUrl.searchParams.get("state"), /^[A-Za-z0-9_-]{22}$/);
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});

test("state and challenge are fresh per flow", async () => {
  const a = await startFlow(300);
  const b = await startFlow(300);
  assert.notEqual(a.state, b.state, "state is per-flow");
  assert.notEqual(
    a.authUrl.searchParams.get("code_challenge"),
    b.authUrl.searchParams.get("code_challenge"),
    "challenge is per-flow"
  );
  await assert.rejects(a.flow, (e) => e.code === "OAUTH_TIMEOUT");
  await assert.rejects(b.flow, (e) => e.code === "OAUTH_TIMEOUT");
});
