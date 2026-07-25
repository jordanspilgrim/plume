"use strict";

// OAuth loopback-flow deadlines (#8): an abandoned or declined Google consent
// must settle the flow (and free the port) instead of hanging forever. No
// network beyond 127.0.0.1 — the deny/timeout paths reject before any Google
// endpoint is contacted.

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

test("abandoned consent times out with OAUTH_TIMEOUT", async () => {
  const started = Date.now();
  await assert.rejects(
    runOAuthFlow(CREDS, () => {}, { timeoutMs: 200 }),
    (e) => e.code === "OAUTH_TIMEOUT"
  );
  assert.ok(Date.now() - started < 5_000, "settles promptly after the deadline");
});

test("declined consent rejects with OAUTH_DENIED", async () => {
  const { openUrl, url } = captureAuthUrl();
  const flow = runOAuthFlow(CREDS, openUrl, { timeoutMs: 10_000 });
  // Attach the rejection handler before triggering the deny, or the (fast)
  // rejection lands as an unhandledRejection.
  const rejected = assert.rejects(flow, (e) => e.code === "OAUTH_DENIED");
  const authUrl = new URL(await url);
  const port = authUrl.searchParams.get("redirect_uri").match(/:(\d+)$/)[1];
  const res = await fetch(`http://127.0.0.1:${port}/?error=access_denied`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /declined/i);
  await rejected;
});

test("stray requests (favicon) don't consume the flow; timeout still fires", async () => {
  const { openUrl, url } = captureAuthUrl();
  const flow = runOAuthFlow(CREDS, openUrl, { timeoutMs: 500 });
  const authUrl = new URL(await url);
  const port = authUrl.searchParams.get("redirect_uri").match(/:(\d+)$/)[1];
  const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(res.status, 404);
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});

test("auth URL carries the expected OAuth parameters", async () => {
  const { openUrl, url } = captureAuthUrl();
  const flow = runOAuthFlow(CREDS, openUrl, { timeoutMs: 300 });
  const u = new URL(await url);
  assert.equal(u.origin, "https://accounts.google.com");
  assert.equal(u.searchParams.get("client_id"), CREDS.cid);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(flow, (e) => e.code === "OAUTH_TIMEOUT");
});
