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

### Write & read containment (P0-1) — server-authoritative
A write (`writeDocument`) or annotation read (`getAnnotations`) is allowed only if its
**canonical** target is either a file Plume currently has open, or inside the
**directory of an open file** — **and** is not sensitive (see below). This scope is
established entirely by the user opening something — it does **not** trust any value
supplied by the caller.

**Scope alone is not sufficient.** Because scope is directory-inclusive, opening one
file in a repository would otherwise put the whole repository within reach. A deny list
(credential material, `.env*`, `.git` internals, shell/REPL history, keys) therefore
overrides scope for both reads and writes, with one carve-out: a file the user opened
**explicitly** — via File ▸ Open, a launch argument, the token-gated socket's `open`, or
a link inside the open document's own directory — remains readable and writable, so
deliberately editing your own `.env` still works.

This was tightened after an adversarial review: the write gate was previously scope-only,
on the reasoning that the socket is authenticated and an agent editing a `.env` the user
pointed it at is legitimate. That reasoning weighed secret *disclosure* and missed *code
execution* — `<repo>/.git/hooks/pre-commit` is arbitrary code on the user's next commit,
and an authenticated channel does not help when the threat is a compromised or confused
agent rather than an unauthenticated attacker. Reads and writes now share one decision
function (`scope_decision`), unit-tested.

An earlier design trusted a client-supplied `root` field. That was wrong: the adversary
speaks the raw socket and could forge `root:"/Users/you"` to authorize writing anywhere
under it (an adversarial review caught this). `write_allowed` / `path_within_open_scope`
(`src-tauri/src/main.rs`) now derive the scope from `open_files()` only, and the write
targets the **canonicalized** path that was validated (never the raw request path — that
closes the check-vs-write TOCTOU). The pure decision is unit-tested (`cargo test`).

- **Rust authority** is the boundary — independent of any client.
- **MCP server** (`bin/plume-mcp.js`, `refuseWrite`) additionally refuses out-of-cwd
  writes up front so the agent gets a clear message; it is a convenience layer, not the
  boundary, and sends no `root`.

Result: neither a prompt-injected agent nor a raw-socket client can use the protocol to
overwrite `~/.ssh/...`, a sibling repo, or `.git/hooks/*`, or to read a `.notes.json`
outside the open workspace. (Reading a file the user themselves opens is inherent editor
behavior and is user-visible — `open` brings the file to the front.)

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
`<meta>` CSP and defers to the config). `script-src 'self'` with **no `'unsafe-eval'`**
(verified: the bundle uses zero `eval`/`new Function`, and mermaid/katex/CodeMirror
render fine without it), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
no remote script. `connect-src` allows only `'self' ipc: blob: data:` — **no `https:`**,
so even if an XSS ever slipped past the sanitizer it has no `fetch()` exfil channel (the
only browser fetch is `blob:`/`data:` image inlining). Defense-in-depth behind the
sanitizer. Note: `img-src https:` remains (for remote images, a feature) and is an
inherent GET-length-limited exfil channel — see residual risks.

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

### Socket handshake token — the outer gate, not the boundary
At startup Plume writes a per-launch 256-bit secret to `~/.plume/token` (mode 600)
*before* it binds the socket. Every socket request except the liveness `ping` must
carry it (checked in `dispatch`, **fails closed**); the `plume` CLI and MCP server read
the file per send. This stops other Unix users and casual same-user processes that
haven't read the token. It does **not** stop a *hostile* same-user process — any code
running as the user can read the 0600 file. That's expected and fine: the token is the
outer gate, and **containment (above) is the load-bearing control**. Even a caller
holding a valid token can only write/read within what the user has opened in Plume —
the token doesn't widen that scope. `PLUME_TOKEN` overrides the file for tests/dev.

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

## Additional controls (from the adversarial review)

- **SSRF guard** — `link_preview` (Rust + Electron) resolves the host and refuses any
  non-public address (loopback, RFC-1918, `169.254/16` incl. cloud metadata, ULA,
  link-local, CGNAT), and does **not** follow redirects (a public→internal redirect is
  the classic bypass).
- **DoS bounds** — the socket readers cap a single message at 32 MiB (no unbounded
  no-newline flood), `sidecar()` no longer `unwrap()`s on a path with no filename, and
  `search_sessions` reuses one scratch buffer instead of allocating 4 MiB per candidate.
- **Token fails closed** — an empty/unset socket token now denies every command.
- **`open_external`** only launches `http(s)`/`mailto` (never `file:`/custom schemes).
- **`resolve_link`** refuses relative links that escape the user's home into `/etc` etc.
- **`push_attachment`** project keys are flattened to one safe path segment.
- **Export/clipboard** markdown uses `html:false` — raw `<script>` in a doc can't ride
  into exported HTML.
- **Google refresh token** is written `0600` under a `0700` dir.
- **Electron control socket** runs only in dev (unpackaged); a shipped build never
  exposes it, and its `writeDocument` is containment-checked.
- **CI actions** are pinned to full commit SHAs; the `allow-dyld-environment-variables`
  entitlement is removed; the unwired auto-updater feed is no longer emitted.

## Known residual risks (tracked)

- **Local images render as `<img>`** (a requested feature), so a document can probe
  file *existence/size* (not contents) for non-secret paths. The asset-protocol deny
  list blocks credential locations and the CSP keeps `asset:` out of `connect-src`
  (bytes can't reach JS). Full closure would require dropping absolute-path images.
- **Remote images auto-load** (standard editor behavior) — a tracking-beacon vector.
  A "block remote images" setting is a reasonable future opt-in.
- **A separate hostile process running as the user** is out of scope — it can act as
  the user directly; the 0600 socket + token raise the bar for *other* users only.
- **Owner actions before publishing:** fill the real Homebrew `sha256` (not the
  placeholder) and reserve the `@plume/mcp` npm name to prevent squatting.

### Closed (this review)
- Client-supplied `root` no longer trusted; write targets the canonical path (TOCTOU).
- Read containment on `getAnnotations`; SSRF guard; DoS bounds; token fail-closed;
  `open_external` scheme allowlist; export `html:false`; menu XSS → `textContent`;
  gdocs token `0600`; Electron socket dev-gated + contained; CI SHAs; dyld entitlement
  dropped; updater feed removed. Earlier: asset deny-list, annotation chip, handshake token.
