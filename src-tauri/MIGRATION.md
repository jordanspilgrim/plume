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

## Remaining

1. **Export PDF** — the real gap: no `printToPDF` in WKWebView via Tauri. Best
   path: `WKWebView.createPDF` (public on macOS 11+) through objc2.
2. **Export DOCX + Google publish** — reuse the verified Node code
   (`html-to-docx`, `gdocs.js`) via an esbuild-bundled Node sidecar spawned by
   Rust (no node_modules at runtime).
3. **`setDirty`** — N/A: the window title is hidden, and the renderer already
   shows the dirty dot in its own titlebar.

Not yet live-verified (renderer-observable, mirror the verified Electron impls):
link-preview render, image save, recovery banner, HTML export write.

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
