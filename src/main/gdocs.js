"use strict";

// One-way publish: Markdown -> a new Google Doc.
//
// Disk stays the source of truth; this just produces a shareable Doc for people
// who don't live in git. Google's API requires an OAuth client, which the user
// supplies once (a "Desktop app" client) via ~/.plume/google.json or env —
// Plume can't register one on their behalf. See docs/agent-setup.md.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const MarkdownIt = require("markdown-it");

const md = new MarkdownIt({ html: false, linkify: true });
const TOKEN_FILE = path.join(os.homedir(), ".plume", "google-token.json");

// Deadlines: an abandoned consent tab or a wedged Google endpoint must never
// hang the caller (or orphan the sidecar process) forever.
const OAUTH_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

async function timedFetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      const err = new Error(`Request to ${new URL(url).host} timed out after ${Math.round(timeoutMs / 1000)}s`);
      err.code = "TIMEOUT";
      throw err;
    }
    throw e;
  }
}

// ---------- Markdown -> Docs batchUpdate requests ----------
// Insert all text once at index 1, then apply paragraph styles, text styles, and
// bullets by absolute index. Pure + offline-testable.
function markdownToDocsRequests(src) {
  const tokens = md.parse(src || "", {});
  let text = "";
  const textRuns = []; // {start,end,bold,italic,code,link}
  const paras = [];    // {start,end,style}
  const bulletGroups = []; // {start,end,ordered}
  const listStack = [];
  let title = "";

  function inline(children) {
    let b = 0, i = 0, link = null;
    for (const c of children || []) {
      switch (c.type) {
        case "strong_open": b++; break;
        case "strong_close": b--; break;
        case "em_open": i++; break;
        case "em_close": i--; break;
        case "link_open": link = c.attrGet ? c.attrGet("href") : null; break;
        case "link_close": link = null; break;
        case "code_inline": {
          const s = text.length; text += c.content;
          textRuns.push({ start: s, end: text.length, bold: b > 0, italic: i > 0, code: true, link });
          break;
        }
        case "text": {
          if (!c.content) break;
          const s = text.length; text += c.content;
          textRuns.push({ start: s, end: text.length, bold: b > 0, italic: i > 0, link });
          break;
        }
        case "image": {
          const alt = c.content || (c.attrGet && c.attrGet("alt")) || "";
          if (alt) { const s = text.length; text += alt; textRuns.push({ start: s, end: text.length, italic: true }); }
          break;
        }
        case "softbreak": case "hardbreak": text += " "; break;
        default: break;
      }
    }
  }

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    switch (tok.type) {
      case "heading_open": {
        const lvl = +tok.tag.slice(1);
        const s = text.length;
        inline(tokens[k + 1] && tokens[k + 1].children);
        if (lvl === 1 && !title) title = text.slice(s).trim();
        text += "\n";
        paras.push({ start: s, end: text.length, style: "HEADING_" + lvl });
        k += 2; break;
      }
      case "paragraph_open": {
        const s = text.length;
        inline(tokens[k + 1] && tokens[k + 1].children);
        text += "\n";
        paras.push({ start: s, end: text.length, style: "NORMAL_TEXT" });
        k += 2; break;
      }
      case "fence": case "code_block": {
        const s = text.length; text += (tok.content || "").replace(/\n+$/, "");
        const e = text.length; text += "\n";
        if (e > s) textRuns.push({ start: s, end: e, code: true });
        paras.push({ start: s, end: text.length, style: "NORMAL_TEXT" });
        break;
      }
      case "bullet_list_open": listStack.push({ ordered: false, start: text.length }); break;
      case "ordered_list_open": listStack.push({ ordered: true, start: text.length }); break;
      case "bullet_list_close": case "ordered_list_close": {
        const l = listStack.pop();
        if (l && text.length > l.start) bulletGroups.push({ start: l.start, end: text.length, ordered: l.ordered });
        break;
      }
      case "hr": text += "―――\n"; break;
      default: break;
    }
  }

  const requests = [];
  if (!text) return { title: title || "", requests };
  requests.push({ insertText: { location: { index: 1 }, text } });

  for (const par of paras) {
    if (par.style !== "NORMAL_TEXT") {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: 1 + par.start, endIndex: 1 + par.end },
          paragraphStyle: { namedStyleType: par.style },
          fields: "namedStyleType",
        },
      });
    }
  }
  for (const r of textRuns) {
    const ts = {}; const fields = [];
    if (r.bold) { ts.bold = true; fields.push("bold"); }
    if (r.italic) { ts.italic = true; fields.push("italic"); }
    if (r.code) { ts.weightedFontFamily = { fontFamily: "Courier New" }; fields.push("weightedFontFamily"); }
    if (r.link) { ts.link = { url: r.link }; fields.push("link"); }
    if (fields.length && r.end > r.start) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: 1 + r.start, endIndex: 1 + r.end },
          textStyle: ts,
          fields: fields.join(","),
        },
      });
    }
  }
  for (const b of bulletGroups) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: 1 + b.start, endIndex: 1 + b.end },
        bulletPreset: b.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  return { title, requests };
}

// ---------- OAuth (installed-app loopback flow) ----------
async function loadCreds() {
  let cid = process.env.GOOGLE_CLIENT_ID, cs = process.env.GOOGLE_CLIENT_SECRET;
  if (!cid || !cs) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(os.homedir(), ".plume", "google.json"), "utf8"));
      cid = cid || j.client_id; cs = cs || j.client_secret;
    } catch { /* none */ }
  }
  return cid && cs ? { cid, cs } : null;
}

function runOAuthFlow(creds, openUrl, { timeoutMs = OAUTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.closeAllConnections) server.closeAllConnections();
      server.close();
      fn(val);
    };
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        // Browsers also request /favicon.ico etc. — those must not consume the flow.
        if (u.pathname !== "/") { res.statusCode = 404; res.end(); return; }
        const denied = u.searchParams.get("error");
        if (denied) {
          res.setHeader("Content-Type", "text/html");
          const e = new Error("Google consent was declined (" + denied + ")");
          e.code = "OAUTH_DENIED";
          // Flush the page before finish() tears down connections.
          res.end("<body style='font:16px -apple-system;padding:40px'><h2>Google Docs connection was declined.</h2><p>You can close this tab and try again from Plume.</p></body>", () => finish(reject, e));
          return;
        }
        const code = u.searchParams.get("code");
        if (!code) { res.statusCode = 400; res.end("Missing code"); return; }
        res.setHeader("Content-Type", "text/html");
        res.end("<body style='font:16px -apple-system;padding:40px'><h2>✅ Plume is connected to Google Docs.</h2><p>You can close this tab.</p></body>");
        const port = server.address().port;
        const tok = await exchangeCode(creds, code, `http://127.0.0.1:${port}`);
        await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
        await fs.chmod(path.dirname(TOKEN_FILE), 0o700).catch(() => {});
        // Owner-only: this is a long-lived Google refresh token.
        await fs.writeFile(TOKEN_FILE, JSON.stringify(tok), { mode: 0o600 });
        await fs.chmod(TOKEN_FILE, 0o600).catch(() => {});
        finish(resolve, tok.refresh_token);
      } catch (e) { finish(reject, e); }
    });
    server.on("error", (e) => finish(reject, e));
    server.listen(0, "127.0.0.1", () => {
      timer = setTimeout(() => {
        const e = new Error(`Google consent was not completed within ${Math.round(timeoutMs / 60_000) || 1} minute(s)`);
        e.code = "OAUTH_TIMEOUT";
        finish(reject, e);
      }, timeoutMs);
      const port = server.address().port;
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: creds.cid,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/documents",
        access_type: "offline",
        prompt: "consent",
      });
      openUrl(authUrl);
    });
  });
}

async function exchangeCode(creds, code, redirectUri) {
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: creds.cid, client_secret: creds.cs,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error("Token exchange failed: " + (await res.text()).slice(0, 200));
  return res.json();
}

async function accessTokenFromRefresh(creds, refresh) {
  const res = await timedFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.cid, client_secret: creds.cs,
      refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

async function getAccessToken(creds, openUrl) {
  let refresh;
  try { refresh = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8")).refresh_token; } catch { /* none */ }
  if (!refresh) refresh = await runOAuthFlow(creds, openUrl);
  return accessTokenFromRefresh(creds, refresh);
}

// ---------- Publish ----------
// openUrl: (url) => void — opens the consent page in the user's browser.
// Injected so this works under both Electron (shell.openExternal) and a plain
// Node sidecar (macOS `open`).
async function publishToGoogleDocs(mdText, defaultName, openUrl) {
  const creds = await loadCreds();
  if (!creds) { const e = new Error("no-credentials"); e.code = "NO_CREDS"; throw e; }
  const access = await getAccessToken(creds, openUrl);
  const { title, requests } = markdownToDocsRequests(mdText);
  if (!requests.length) { const e = new Error("empty"); e.code = "EMPTY"; throw e; }

  const createRes = await timedFetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || defaultName || "Untitled" }),
  });
  if (!createRes.ok) throw new Error("Create failed: " + (await createRes.text()).slice(0, 200));
  const docId = (await createRes.json()).documentId;

  const upRes = await timedFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!upRes.ok) throw new Error("Content update failed: " + (await upRes.text()).slice(0, 200));

  return `https://docs.google.com/document/d/${docId}/edit`;
}

module.exports = { markdownToDocsRequests, publishToGoogleDocs, runOAuthFlow };
