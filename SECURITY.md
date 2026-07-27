# Plume — Security Model

Plume is a local, single-user editor that an AI agent (Claude Code, Codex, Gemini)
can read from and write to over a local control socket and an MCP server. That
agent connection is the security surface this document is about.

## Threat model

We design against three adversaries.

**1. A prompt-injected agent.** Coding agents routinely ingest untrusted input — web
pages, repo files, pasted documents — so an attacker who lands text in front of the
agent may try to steer its tool calls. That's the "lethal trifecta": untrusted content
+ tool access + a way to act. The agent runs as the user and is semi-trusted; our job
is to keep a *manipulated* agent from escalating "edit my document" into something
worse.

This adversary **holds a valid socket token** — it is the legitimate client.
Authentication therefore never stands in for user intent anywhere in this document:
where a control needs a human decision it keys on a human *action* (a native dialog,
a launch argument), never on the caller being authenticated. A token holder is the
threat, so a token cannot be the proof.

**2. A hostile document.** A `.md` file is untrusted input, not merely content.
Opening or exporting one must not let it reach the network, read the filesystem, or
crash the process — that is what export image-vetting, the link-preview SSRF guard,
renderer sanitization, and the crash bounds below are for.

**3. A remote web page, via the `plume://` URL handler.** Registering a URL scheme
puts a control surface on the open internet: any page the user visits can ask the OS
to hand Plume a `plume://open?path=…`. This adversary is neither authenticated nor
local, so externally-driven opens get their own gate (below). Finder "Open With" and
a second-instance `argv` arrive through the same path and are treated the same way.

We do **not** try to defend against a separate hostile process already running as the
user — on a single-user machine that process can do anything the user can. The socket
permissions below raise the bar on multi-user boxes, but the primary control is
scoping what each entry path can do.

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
overrides scope for both reads and writes, with one carve-out: a file **a human picked**
— a native File ▸ Open dialog, or the argument Plume was launched with — remains readable
and writable, so deliberately editing your own `.env` still works.

The carve-out is deliberately narrow, because it is the one way past the deny list. A
path merely *named* by a caller does not qualify: the socket's `open`, `plume://` deep
links, Finder "Open With", and links inside a document all refuse sensitive targets
rather than marking them opened. An earlier version treated the token-gated socket's
`open` as equivalent to a user pick; a re-verification showed that let a token-holding
agent launder a path — `open` `<repo>/.git/config`, then write it through the carve-out,
landing a credential-helper line that executes on the next git authentication. A token
holder is precisely the threat this gate exists for, so authentication does not stand in
for human intent.

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

### External-open containment (`plume://`, Finder, second-instance argv, Open Recent)
Registering the `plume://` scheme means any web page can ask the OS to hand Plume a
path, so every externally-driven open routes through one gate
(`deliver_external_open`), which:

1. **refuses sensitive paths outright** — credential material never opens from an
   external trigger, and deliberately without an "are you sure?", because a confirm
   raised by an attacker-driven request is one mis-click from disclosure;
2. **opens directly** when the target is already inside user-established territory;
3. **otherwise requires a native Open/Cancel confirm** showing the **full path**, so a
   scripted flood of `plume://` links cannot silently pull files into the editor.

The same gate covers File ▸ Open **Recent**: that list is renderer-supplied and the
menu shows only the basename, so a compromised renderer could otherwise label a
credential file `notes.md`.

An externally-opened path is **not** a user pick and never earns the deny-list
carve-out. The vetted canonical path is threaded through to the read, so the path
checked and the path opened are the same resolve.

### Renderer command containment
The renderer is a webview displaying untrusted document content, so its filesystem
commands are contained exactly as the socket's are — not trusted for being "internal".
`read_path`, `bind_doc`, `list_dir`, `search_files`, `list_context`,
`load_annotations`/`save_annotations`, `materialize_doc`, `session_read`,
`resolve_link` and `open_in_new_window` share the scope + deny decision; out-of-scope
calls fail soft (empty/refused).

Two rules that are easy to get wrong:
- The renderer's registered **tab set is evidence, not a grant**. A tab path widens
  scope only if a user action independently approved it — otherwise a compromised
  renderer could name a path and thereby authorize itself, and because that set also
  feeds the socket's write scope, escalate into the agent's authority.
- `resolve_link` follows only links that stay **inside the document's own directory**;
  absolute, scheme-bearing and `../`-escaping hrefs are refused.

### Draft autosave (`~/Documents/Plume/Autosave`)
Untitled buffers autosave as real files, so the draft file *is* the persistence. That
directory — and only that directory, not its parent — is always in scope, so drafts
read and write without widening anything else. `discard_draft` is the one
renderer-callable unlink: it canonicalizes, requires a regular file **strictly inside**
the canonical Autosave directory, and refuses (with a log) anything else. Graduating a
draft writes the current buffer to the chosen path, then deletes the source — never a
rename, which would move the file as of the last autosave tick and lose newer edits.

### Crash and resource bounds
`panic = "abort"` is deliberately **not** set: Plume holds unsaved text and parses
hostile input in several places, so a missed edge case should surface as an error
rather than take every unsaved buffer with it. Because unwinding makes a poisoned
`Mutex` possible, all `AppState` lock sites recover from poisoning instead of
panicking again — otherwise one contained panic would cascade into a permanent
failure of that lock.

Every read of an untrusted or agent-written file is bounded: draft titles, agent
session transcripts and indexes read a bounded head; crash snapshots above a generous
ceiling are **skipped rather than truncated**, because that content is what would be
*restored* and a truncated read would hand back a corrupted document. Response and
URL parsing is char-boundary-safe, and offsets are never derived from a lowercased
copy (case-mapping changes byte length, so such offsets can land mid-codepoint).

### Dependency supply chain
Two CI checks, deliberately in different tiers:

- **`cargo clippy --all-targets -- -D warnings`** runs in the *gating* chain. This
  codebase hand-rolls parsers and sanitizers over hostile input, so a lint that
  suggests a subtly different behaviour is worth failing a build over. (Not every
  suggestion is taken: where a lint would change semantics, the suppression carries a
  comment explaining why — a mechanical `--fix` across this file has already been
  shown to introduce a real bug.)
- **`npm audit` + `cargo audit`** run on PRs, pushes, and weekly, but are **not**
  gating. A gate must be deterministic; advisory databases are not. A new CVE against
  an unchanged dependency would turn every build red overnight and block unrelated
  work — which is the pressure that teaches people to route around gates. A red audit
  is still loud and must be triaged.

The audit earned its place on the first run by finding a real one that review had not:
`linkify-it` ≤ 5.0.1 has a quadratic-complexity DoS in the `mailto:` validator scan
loop over attacker-controlled text. Plume enables `linkify: true` in **all three**
markdown paths, so a hostile document hung the app on **open**, not merely on export —
adversary 2 above, exactly. Resolved lockfile-only. Worth recording that tooling found
it and human review did not: the two are not substitutes.

### Socket permissions (P0-2)
`~/.plume` is `chmod 700` and `~/.plume/plume.sock` is `chmod 600` after bind, so no
other local user can drive the control protocol.

On **Windows** the named pipe is created in the per-session namespace, which is not
the same guarantee: a pipe there has a default DACL and no explicit ACL of our own, so
treat the **handshake token** — not the namespace — as the access control on that
platform. Hardening the DACL is the correct fix if Plume ever runs as a service or in
a shared session.

### Probe-before-bind (P0-3)
The Rust socket server never blindly removes and rebinds the socket. It probes first:
a live Plume answering → leave it alone; a stale socket → reclaim it. This prevents two
shells from hijacking each other's socket. (The rule predates the Tauri port; the
Electron shell it came from is no longer in this tree.)

### Dirty-buffer guard (P1-4)
The renderer reports per-document dirty state (`set_doc_dirty`). `write_document`
refuses with a `dirty_conflict` code rather than clobbering a buffer that has unsaved
edits; the agent is told to ask the user to save or discard first.

### Content Security Policy (P1-5)
`src-tauri/tauri.conf.json` sets an explicit CSP (the Tauri build strips the HTML
`<meta>` CSP and defers to the config). `script-src 'self'` with **no `'unsafe-eval'`**
(verified: the bundle uses zero `eval`/`new Function`, and mermaid/katex/CodeMirror
render fine without it), `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
no remote script. `connect-src` allows only `'self' ipc: http://ipc.localhost blob: data:` (the
`ipc.localhost` origin is Tauri's own IPC transport) — **no `https:`**,
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
- `test/sidecar-export-ssrf.test.js` — spawns the real sidecar against a local
  listener and asserts **zero** requests for remote/protocol-relative/redirecting srcs.
- `test/gdocs-oauth.test.js` — PKCE + `state` on the loopback callback.
- `test/tabs-model.test.js` — tab/close/draft decisions incl. the is-draft prefix rule.

`cargo test` covers the Rust decision functions directly: containment
(`scope_decision`, `path_within_open_scope`, tab-set trust), the sensitive deny list,
close-gate policy, draft/Autosave containment, the export tag rewriter's parser
differentials, char-boundary handling, and poisoned-lock recovery. Where a fix closes
a specific attack, **the attack input is the test input** — several were reproduced
against the pre-fix code first, so the tests are regressions rather than decoration.

## Additional controls (from the adversarial review)

- **SSRF guard (link previews)** — `link_preview` resolves the host **once**, refuses
  any non-public address (loopback, RFC-1918, `169.254/16` incl. cloud metadata, ULA,
  link-local, CGNAT), and connects through a **pinned resolver** so the request cannot
  be re-resolved to a different address at connect time (DNS rebinding). It does
  **not** follow redirects (a public→internal redirect is the classic bypass). The
  check returns the vetted addresses rather than a boolean — a check that discards
  what it vetted invites exactly that re-resolve gap.
- **SSRF guard (export)** — a document's `![](url)` images used to be fetched by the
  export renderers themselves (html-to-docx in the sidecar, WKWebView for PDF),
  reaching internal hosts on export and embedding the result in a file the user may
  share. Every export now passes through one Rust choke point: each remote `<img src>`
  is fetched through the same vetted-address path and inlined as `data:`, or dropped
  to alt text, so the renderers receive no remote URLs and need no network.
  Deliberately **not** a "is this host safe?" helper for the sidecar — a check in one
  process followed by a fetch in another rebuilds the rebinding window. The tag
  rewriting walks attributes like a parser rather than pattern-matching (a `src=`
  hidden inside another attribute's value was measured fetching), `file:` sources are
  dropped like remote ones, and the HTML export is vetted too — otherwise the saved
  file keeps live remote `<img>` that the user's browser fetches later. Backed by a
  `default-src 'none'; img-src data:` CSP on the PDF export document and an in-process
  network kill-switch in the docx sidecar.
- **Node runtime authenticity** — the optional Node download verifies a **build-pinned**
  SHA-256. Fetching the digest at runtime from the same host as the tarball only
  proved the server was self-consistent; a pinned digest is not something that channel
  can influence. An unpinned platform fails closed.
- **DoS bounds** — the socket readers cap a single message at 32 MiB (no unbounded
  no-newline flood), `sidecar()` no longer `unwrap()`s on a path with no filename, and
  `search_sessions` reuses one scratch buffer instead of allocating 4 MiB per candidate.
  Draft titles, agent transcripts and the Codex index read bounded heads; oversized
  crash snapshots are skipped rather than truncated; export image fetching is bounded
  per image, in total time, and in count.
- **Token fails closed** — an empty/unset socket token now denies every command.
- **`open_external`** only launches `http(s)`/`mailto` (never `file:`/custom schemes).
- **`resolve_link`** accepts only relative hrefs resolving **inside the open document's
  own directory** (absolute, scheme-bearing and `../`-escaping hrefs refused), and
  never resolves to credential material.
- **`push_attachment`** project keys are flattened to one safe path segment.
- **Export/clipboard** markdown uses `html:false` — raw `<script>` in a doc can't ride
  into exported HTML.
- **Google refresh token** is written `0600` under a `0700` dir.
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
  gdocs token `0600`; CI SHAs; dyld entitlement
  dropped; updater feed removed. Earlier: asset deny-list, annotation chip, handshake token.
