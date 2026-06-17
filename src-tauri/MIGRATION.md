# Tauri reshell — migration status

Goal: replace the Electron shell (~120 MB) with Tauri v2 (WKWebView + Rust,
~10 MB) **without touching the renderer**. The renderer (CodeMirror + all
viewers) is webview-portable; only the native layer (`window.plume`) changes.

## Architecture

- **Renderer**: unchanged. Built by esbuild to `dist/`, assembled into
  `build-tauri/` by `scripts/build-tauri.mjs`.
- **Bridge**: `tauri/tauri-bridge.js` reimplements the `window.plume` API over
  Tauri `invoke()` + `listen()`. Loaded as a classic script before the renderer
  module, so the renderer sees the same API it had under Electron's preload.
- **Native**: `src-tauri/src/main.rs` — Rust commands + app setup.
- **Shared, shell-agnostic by design**: the `plume` CLI, the MCP server, and the
  `~/.plume/plume.sock` control protocol are separate processes and do **not**
  change. The socket server itself (currently in Electron `main.js`) is the one
  piece that must be re-hosted in Rust — see below.

Build: `npm run tauri:build` (assembles frontend, then `tauri build`).

## Ported + verified

| Capability | Tauri | Verified |
|---|---|---|
| Open file (CLI arg) | `initial_file` + setup | ✅ renders in WKWebView |
| Open a path in window | `read_path` | ✅ |
| Save / Save As | `write_file` / `save_dialog` | save ✅ / dialog compiled |
| Open dialog | `open_dialog` (plugin-dialog, Rust-side) | compiled (native modal) |
| Folder listing + search | `list_dir` / `search_files` | ✅ |
| Open external URL | `open_external` | ✅ |
| **Live auto-reload (watcher)** | `notify`, re-read on dir event + content compare | ✅ external edit propagates |
| **Control socket** | Rust `UnixListener`, full newline-JSON protocol | ✅ `plume --version`, open |
| **Agent round-trip** | `agent-request` event → `agent_reply` | ✅ get_active_document / get_selection |
| `getAnnotations` / `writeDocument` (socket) | sidecar read / fs write | ✅ full MCP steer loop |
| Annotations sidecar | `load_annotations` / `save_annotations` | ✅ (read via socket) |
| Sessions + context | `list_sessions` / `search_sessions` / `list_context` | compiled (same std::fs as Electron) |
| Menu | Tauri `Menu` API → `menu` event → `onMenu` | compiled (native) |
| Crash snapshot (write) | `snapshot` → `~/.plume/recovery` | compiled |
| Resolve relative link | `resolve_link` | compiled |
| Window chrome | `titleBarStyle: Overlay` + hiddenTitle | ✅ |

The CLI (`bin/plume.js`) and MCP server (`bin/plume-mcp.js`) are **unchanged** and
work against the Tauri build — the socket protocol is identical.

### Also ported

| Capability | Tauri | Verified |
|---|---|---|
| Link-preview unfurl | `link_preview` (ureq + OG parse) | compiled |
| Images (paste/drop save + pick) | `save_image` / `pick_image` | compiled |
| macOS file association | `tauri.conf` fileAssociations | ✅ Info.plist |
| Open file at runtime (Finder "Open With") | `RunEvent::Opened` | ✅ delivers file |
| Single-instance | `tauri-plugin-single-instance` | ✅ one process |
| Crash-recovery restore | `recovery_for` in open paths | compiled |

### Also ported (batch 3)

| Capability | Tauri | Verified |
|---|---|---|
| Multi-window | `open_in_new_window` / `spawn_window` + per-window `initial_file`; socket `--new` | ✅ window count 1→2 |
| Export HTML | `export_doc` (save dialog + write) | compiled (native modal) |
| `plume://` scheme | `tauri-plugin-deep-link` + `on_open_url` | ✅ in Info.plist |
| Focused-window agent query | `agent_query` targets focused window | — |

### Also ported (batch 4)

| Capability | Tauri | Verified |
|---|---|---|
| Export DOCX | `export_doc` docx → bundled Node sidecar (`html-to-docx`) | ✅ valid .docx bytes |
| Google Docs publish | `publish_google` → sidecar (`gdocs.js`, openUrl injected) | ✅ NO_CREDS path; live gated on creds |

## Remaining — one item

**Export PDF.** The genuine gap: WKWebView has no `printToPDF` exposed to JS, and
Tauri doesn't wrap it. The correct fix is `WKWebView.createPDF` (public, macOS 11+)
via objc2 — but that's unsafe Rust (raw webview-handle cast + an objc completion
block + load-timing) that segfaults on mistakes, so it needs a focused, iterative
pass rather than a blind one-shot. Until then, PDF export falls through (HTML and
DOCX both work; the Electron build still does PDF).

`setDirty` is **N/A** (hidden title; the renderer shows its own dirty dot).

Not yet live-verified (renderer-observable; mirror the verified Electron impls):
link-preview render, image save, recovery banner, HTML/DOCX dialog write.

## Notes / risks

- **Socket ownership**: only one Plume (Electron *or* Tauri) can own
  `~/.plume/plume.sock` at a time. Run one.
- **CSP** is `null` for now; tighten before shipping. Relative `file:` image src
  needs `convertFileSrc`.

## Notes / risks

- **CSP**: set to `null` in `tauri.conf.json` for the scaffold; tighten before
  shipping (Tauri's asset protocol replaces `file:` — image src resolution for
  relative images will need the `convertFileSrc` helper).
- **Single instance**: add `tauri-plugin-single-instance` to match Electron's
  `requestSingleInstanceLock` (needed so the socket has one owner).
- This scaffold proves the renderer runs in WKWebView and the core file loop
  works; it is **not** feature-complete. Items 1–11 are the remaining work.
