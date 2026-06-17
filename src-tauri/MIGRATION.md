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

## Ported (in this scaffold)

| Capability | Electron | Tauri |
|---|---|---|
| Open file (CLI arg) | `open-file` / argv | `initial_file` command + setup |
| Open a path in window | `file:openInThisWindow` | `read_path` command |
| Save (in place) | `file:save` | `write_file` command |
| Folder listing (sidebar) | `dir:list` | `list_dir` command |
| Open external URL | `file:openExternal` | `open_external` (open crate) |
| Window chrome | `titleBarStyle: hiddenInset` | `titleBarStyle: Overlay` + hiddenTitle |

## Remaining (stubbed in the bridge — ordered by effort)

1. **Native dialogs** — `openDialog`, `saveAs`, image picker. Add
   `tauri-plugin-dialog` + a capability entry; wire `open_dialog`/`save_dialog`.
2. **File watcher (live auto-reload)** — the killer feature. Use the `notify`
   crate, watch the open file's dir, emit `file-changed` (mirror `setupWatcher`'s
   self-write guard via a `known_content` compare).
3. **Control socket** — re-host the `~/.plume/plume.sock` server (Wave 1/2) in
   Rust: a `UnixListener` + the same newline-JSON protocol, dispatching
   `open`/`getActiveDocument`/`getSelection`/`getAnnotations`/`writeDocument` to
   the focused webview via `eval`/`emit`. The CLI + MCP server are unchanged.
4. **Menu** — rebuild the app menu with Tauri's `Menu` API; emit `menu:*` events
   the bridge forwards to `onMenu`. (muda is already compiled in.)
5. **Annotations sidecar** — port `annotations:load/save` (trivial std::fs).
6. **Sessions + context** — port `sessions:list/search`, `context:list`
   (std::fs walk of `~/.claude/projects`).
7. **macOS file association + `plume://`** — `tauri.conf.json` `bundle ▸
   fileAssociations` + `deep-link` plugin / `RunEvent::Opened`.
8. **Export** — DOCX via the existing `html-to-docx` (run renderer-side or a Node
   sidecar). **PDF is the real gap**: there is no `printToPDF` in WKWebView via
   Tauri. Options: (a) a tiny bundled `wkhtmltopdf`/`weasyprint` sidecar, (b)
   `WKWebView.createPDF` via objc2 (private-ish), (c) keep a headless print path.
   Recommend (b) — `createPDF(configuration:)` is public on macOS 11+.
9. **Link preview unfurl** — port `link:preview` to Rust `reqwest` + a small
   OpenGraph regex (or keep it in a Node sidecar).
10. **Google Docs publish** — `gdocs.js` is plain Node; run it via a Node sidecar
    that the bridge invokes, or port the OAuth loopback + fetch to Rust.
11. **Crash-recovery snapshots** — port `doc:snapshot` (std::fs to userData).

## Notes / risks

- **CSP**: set to `null` in `tauri.conf.json` for the scaffold; tighten before
  shipping (Tauri's asset protocol replaces `file:` — image src resolution for
  relative images will need the `convertFileSrc` helper).
- **Single instance**: add `tauri-plugin-single-instance` to match Electron's
  `requestSingleInstanceLock` (needed so the socket has one owner).
- This scaffold proves the renderer runs in WKWebView and the core file loop
  works; it is **not** feature-complete. Items 1–11 are the remaining work.
