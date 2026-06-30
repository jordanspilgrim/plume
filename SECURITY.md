# Plume — Security Model

Plume is a local, single-user editor that an AI agent (Claude Code, Codex, Gemini)
can read from and write to over a local control socket and an MCP server. That
agent connection is the security surface this document is about.

## Threat model

The adversary we design against is **a prompt-injected agent**, not a remote
attacker. Coding agents routinely ingest untrusted input — web pages, repo files,
pasted documents — so an attacker who lands text in front of the agent may try to
steer its tool calls. That's the "lethal trifecta": untrusted content + tool access
+ a way to act. The agent runs as the user and is semi-trusted; our job is to keep a
*manipulated* agent from escalating "edit my document" into something worse.

We do **not** try to defend against a separate hostile process already running as the
user — on a single-user machine that process can do anything the user can. The socket
permissions below raise the bar on multi-user boxes, but the primary control is
scoping what the agent path itself can do.

## Controls

### Write containment (P0-1) — `write_document`
A write is allowed only if its **canonical** target is either:
- a file Plume currently has open, or
- inside the **workspace root** the MCP server was spawned in (its real `cwd`).

Enforced in two places:
- **MCP server** (`bin/plume-mcp.js`, `refuseWrite`) — the primary boundary. The
  agent cannot change the server's `cwd`, so anchoring to it is sound against the
  injected-agent threat. Refusals are returned to the agent as a clear message.
- **Rust backstop** (`src-tauri/src/main.rs`, `write_allowed`) — re-checks against
  Plume's authoritative open-file set plus the `root` the request declares. Paths are
  canonicalized (symlinks/`..` resolved) so the check can't be bypassed.

Result: a manipulated agent cannot use `write_document` to overwrite `~/.ssh/...`,
a sibling repository, or `.git/hooks/*`.

### Socket permissions (P0-2)
`~/.plume` is `chmod 700` and `~/.plume/plume.sock` is `chmod 600` after bind, so no
other local user can drive the control protocol. On Windows the named pipe lives in
the per-session namespace (no cross-user access by default).

### Probe-before-bind (P0-3)
The Rust socket server never blindly removes and rebinds the socket. It probes first:
a live Plume answering → leave it alone; a stale socket → reclaim it. This mirrors the
Electron `control.js` ownership logic and prevents two shells from hijacking each
other's socket.

### Dirty-buffer guard (P1-4)
The renderer reports per-document dirty state (`set_doc_dirty`). `write_document`
refuses with a `dirty_conflict` code rather than clobbering a buffer that has unsaved
edits; the agent is told to ask the user to save or discard first.

### Content Security Policy (P1-5)
`src-tauri/tauri.conf.json` sets an explicit CSP (the Tauri build strips the HTML
`<meta>` CSP and defers to the config). `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'`, no remote script. Defense-in-depth behind the sanitizer.

### Renderer sanitization (audited)
Document and agent-transcript content is treated as untrusted. All HTML-producing
paths were audited:
- inline markdown for table cells / live preview escapes first (`escapeHtml`);
- agent-transcript prose renders through `markdown-it` with `html: false`;
- outlines, notes, status use `textContent`.
No raw-HTML passthrough. Re-audit any new `innerHTML` sink that touches doc content.

### Attachment quarantine (P2-7)
`get_attachments` moves a malformed push to `.bad/` instead of unlinking it, so a
corrupt write is recoverable rather than silently lost.

### Socket handshake token
At startup Plume writes a per-launch 256-bit secret to `~/.plume/token` (mode 600)
*before* it binds the socket. Every socket request except the liveness `ping` must
carry that token (`socket_token` check in `dispatch`); the `plume` CLI and the MCP
server read the file per send and present it. This gates the protocol even against a
same-user process that hasn't read the 0600 token file — belt-and-suspenders behind
the 0600 socket. `PLUME_TOKEN` overrides the file for tests/dev.

### Asset-protocol scope
`assetProtocol.scope` is an allow/deny set: `allow: ["**"]` (the editor opens images
from arbitrary local paths) with a `deny` list for credential material —
`**/.ssh/**`, `**/.aws/**`, `**/.gnupg/**`, `*.pem`, `*.key`, `id_rsa*`, `.env*`,
`.git-credentials`, etc. The CSP already keeps `asset:` out of `connect-src`, so the
webview can't `fetch()` a local file into JS regardless; the deny list is additional
depth against rendering secret files through `<img>`.

## MCP protocol — version-bump checklist (P2-8)

The MCP server (`bin/plume-mcp.js`) is intentionally zero-dependency and pins the
protocol version. Before changing `PROTOCOL_VERSION` or the tool set:

1. Update `PROTOCOL_VERSION` and, if needed, `serverInfo.version`.
2. Update the `TOOLS` table (name, description, `inputSchema`) for any added/removed tool.
3. Update `EXPECTED_TOOLS` in `test/mcp-smoke.test.js` and the pinned version assertion.
4. `npm test` — the smoke test asserts the wire `initialize`/`tools/list` match the
   exported `TOOLS`/`PROTOCOL_VERSION`, so drift fails loudly.
5. Re-test against at least one real client (`claude mcp add plume -- node bin/plume-mcp.js`).

If maintaining the hand-rolled server becomes burdensome, adopt
`@modelcontextprotocol/sdk` — but keep the smoke + contract tests as the contract.

## Tests

`npm test` (`node --test`) covers the connected layer without a running Plume:
- `test/mcp-containment.test.js` — containment helpers (unit).
- `test/mcp-smoke.test.js` — protocol version + tool-set conformance.
- `test/mcp-socket-contract.test.js` — MCP ↔ fake-Plume wire contract, `root` field,
  containment + `dirty_conflict` end-to-end.
- `test/mcp-attachments.test.js` — quarantine behavior.

## Known residual risks (tracked)

- **Rust backstop trusts the MCP-supplied `root`.** Sound against the injected-agent
  threat (the server can't be made to lie about its own `cwd`) and gated by the 0600
  socket + handshake token; a separate hostile process running as the user is
  explicitly out of scope (it could act as the user directly).
- **The asset-protocol deny list is a blocklist**, not an allowlist — it covers the
  well-known credential locations but a novel secret path outside it would still be
  loadable as an `<img>`. The CSP (`asset:` not in `connect-src`) is the real backstop:
  contents can't be read into JS regardless of what renders.

### Closed
- `assetProtocol.scope` tightened to allow/deny (was `["**"]`).
- Annotation chips now build with `textContent` (was `innerHTML`).
- Socket handshake token implemented (was the optional item).
