// Plume — Tauri v2 shell.
//
// The renderer (CodeMirror) is webview-portable; this provides the native side
// over the same `window.plume` API (see tauri/tauri-bridge.js). See
// src-tauri/MIGRATION.md for what is ported vs remaining.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

// The document a single window has open, plus the watcher that live-reloads it.
// One per window label — the old global (current/last_content/watcher) meant a
// second window silently retargeted saves, snapshots, and image drops onto the
// FIRST window's file (the multi-window data-loss bug, #1/#3).
struct DocState {
    path: String,
    last_content: String,
    // Held for RAII only: dropping it unwatches the file. Never read.
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
struct AppState {
    initial: Mutex<Option<String>>,
    // Per-window document state, keyed by window label.
    docs: Mutex<HashMap<String, DocState>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
    // Windows spawned with a target file that haven't consumed it via initial_file
    // yet ("" = blank untitled sentinel). Consumed entries move into `docs`, so a
    // window's file is in scope from spawn to close with no gap (#5).
    window_files: Mutex<HashMap<String, String>>,
    win_counter: AtomicU64,
    recents: Mutex<Vec<String>>, // recent file paths for the File > Open Recent menu
    // Canonical paths the renderer has flagged as having unsaved edits. Feeds ONLY
    // the agent writeDocument guard (P1-4). The renderer is the single live writer
    // (explicit path per set_doc_dirty, cleared per tab transition); the only
    // native touch is the Destroyed-time GC sweep (cluster A, coord-ratified).
    dirty_files: Mutex<HashSet<String>>,
    // Cluster A delta 4: each window's full open TAB path-set (canonical), pushed
    // by the renderer via set_open_paths. Feeds the agent write scope +
    // listOpenFiles (background tabs stay visible/writable) and scopes the
    // Destroyed-time dirty_files GC.
    open_tabs: Mutex<HashMap<String, Vec<PathBuf>>>,
    // Close prompts in flight, keyed by label: (emitted-at, acked). Close is
    // always-prevent + close-requested (renderer-authoritative); the bridge
    // auto-ACKs receipt to prove the webview is alive (coord ruling 6068).
    pending_close: Mutex<HashMap<String, (std::time::Instant, bool)>>,
    // ⌘Q in flight: the custom quit item fans the close flow out to every window;
    // cancelClose from any window aborts (clears this), last destroy exits.
    quitting: std::sync::atomic::AtomicBool,
    // Cluster B: user-established territory beyond the open/bound scope —
    // files the user explicitly opened (canonical: File▸Open, launch arg,
    // delivered opens, resolved doc links) and directories they explicitly
    // picked (canonical scope roots from pick_folder). Renderer FS commands are
    // contained to this union; nothing here is caller-supplied trust.
    approved_files: Mutex<HashSet<PathBuf>>,
    approved_dirs: Mutex<HashSet<PathBuf>>,
    // Per-launch secret written to ~/.plume/token (0600). Socket clients must present
    // it on every request (except ping). Defense-in-depth behind the 0600 socket.
    socket_token: Mutex<String>,
}

// Dead-renderer deadline: the bridge ACKs close-requested in milliseconds when
// the webview is alive; silence for this long means it is wedged and the window
// is destroyed natively (crash-recovery snapshots are the data net).
const CLOSE_ACK_DEADLINE: Duration = Duration::from_millis(1500);
// A prompt that was ACKed but never resolved (hung after ack — rare) would make
// the window unclosable under pure swallow; after this age a new OS close
// re-emits close-requested instead (safe for a live renderer: its flow is
// loop-guarded).
const CLOSE_REPROMPT_AFTER: Duration = Duration::from_secs(10);

// Pure close-gate policy for an incoming OS close, given the pending marker
// (age, acked) if any. Emit = record + emit close-requested + arm ack timer;
// Swallow = keep preventing, no new emit (a prompt round-trip is in flight).
#[derive(Debug, PartialEq)]
enum CloseAction {
    Emit,
    Swallow,
}

fn close_action(entry: Option<(Duration, bool)>) -> CloseAction {
    match entry {
        None => CloseAction::Emit,
        // Acked long ago but never resolved: re-prompt rather than wedge.
        Some((age, true)) if age >= CLOSE_REPROMPT_AFTER => CloseAction::Emit,
        // Un-acked past the deadline: the ack timer should have destroyed the
        // window; if it somehow didn't, re-emitting re-arms the escape hatch.
        Some((age, false)) if age >= CLOSE_ACK_DEADLINE => CloseAction::Emit,
        Some(_) => CloseAction::Swallow,
    }
}

// Poison-tolerant locking (cluster C follow-on). With panic = "unwind" — which
// this crate deliberately uses so a stray panic can't take unsaved buffers down
// with it — a panic while a Mutex is held POISONS that Mutex, and every later
// `lock().unwrap()` panics in turn. One contained panic would become a
// permanent cascade on that lock. We cannot prove no panic ever occurs under a
// lock (the watcher callback and socket threads do fallible work, and a
// dependency panic is exactly what unwind exists to survive), so recover
// instead: take the guard anyway and carry on with the state as it stands.
// AppState holds plain collections — a half-finished insert leaves a stale or
// missing entry, never memory unsafety — so continuing is strictly better than
// bricking the lock.
trait LockExt<'a, T> {
    fn lock_or_recover(&'a self) -> std::sync::MutexGuard<'a, T>;
}

impl<'a, T> LockExt<'a, T> for Mutex<T> {
    fn lock_or_recover(&'a self) -> std::sync::MutexGuard<'a, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

// Home directory, cross-platform: HOME on unix, USERPROFILE on Windows.
fn home_dir() -> PathBuf {
    let h = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(h)
}

fn plume_dir() -> PathBuf {
    home_dir().join(".plume")
}

// ---- file watcher (live auto-reload) ----
// Bind `path` as `label`'s document: record it in docs and watch it. The watcher
// emits `file-changed` with { path, content } to THAT window only — never a
// global broadcast, so window B's reload can't clobber window A's buffer.
fn set_current(app: &AppHandle, label: &str, path: &str, content: &str) {
    let state = app.state::<AppState>();
    let watcher = start_watcher(app, label, path);
    let old = state.docs.lock_or_recover().insert(
        label.to_string(),
        DocState { path: path.to_string(), last_content: content.to_string(), _watcher: watcher },
    );
    // Drop the replaced watcher OUTSIDE the docs lock: its callback takes the same
    // lock, and some backends join the callback thread on drop (deadlock otherwise).
    drop(old);
}

fn start_watcher(app: &AppHandle, label: &str, path: &str) -> Option<RecommendedWatcher> {
    let dir = Path::new(path).parent()?.to_path_buf();
    let file = path.to_string();
    let lbl = label.to_string();
    let app2 = app.clone();
    // Re-read the tracked file on any event in its directory and emit only when
    // the content actually changed. Avoids fragile path matching (e.g. /tmp vs
    // /private/tmp) and naturally ignores our own writes via the content compare.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        // OOM amplifier: this fires on every change to the OPEN file, so an
        // agent appending gigabytes to it would read the whole thing here and
        // take the process down — with every other window's unsaved work. Skip
        // the emit past a generous ceiling (the editor keeps its last-known
        // content) rather than truncating, which would silently replace the
        // buffer with a partial document. Deliberately scoped to the WATCHER:
        // read_path/bind_doc/initial_file stay unbounded because those are
        // documents the user chose to open.
        if fs::metadata(&file).map(|m| m.len() > MAX_WATCHED_RELOAD_BYTES).unwrap_or(false) {
            return;
        }
        if let Ok(content) = fs::read_to_string(&file) {
            let st = app2.state::<AppState>();
            let mut changed = false;
            {
                let mut docs = st.docs.lock_or_recover();
                if let Some(doc) = docs.get_mut(&lbl) {
                    // Stale-watcher guard: this window may have moved to another file.
                    if doc.path == file && doc.last_content != content {
                        doc.last_content = content.clone();
                        changed = true;
                    }
                }
            }
            if changed {
                let _ = app2.emit_to(&lbl, "file-changed", json!({ "path": file, "content": content }));
            }
        }
    })
    .ok()?;
    // Watch the canonical dir so FSEvents reliably delivers.
    let watch_dir = fs::canonicalize(&dir).unwrap_or(dir);
    watcher.watch(&watch_dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

// ---- core file commands ----
#[derive(serde::Serialize)]
struct ReadResult {
    content: String,
    recovery: Option<String>,
}

// Cluster A: PURE read — no binding side effect. The renderer uses it for
// disk-freshness compares on background-tab activation; binding a document to
// a window happens ONLY through bind_doc (and the initial_file bootstrap).
// Cluster B: contained to user-established territory.
#[tauri::command]
fn read_path(app: AppHandle, path: String) -> Result<ReadResult, String> {
    // Read the CANONICAL path we validated, never the raw argument — the same
    // rule write_file follows on the write side, applied at the point of use.
    // Gating on canonical_key(path) and then reading `path` leaves a
    // check-vs-use gap: a symlink swapped in between means the bytes returned
    // are not the file that passed the gate. Doing it here closes the gap for
    // every caller at once, rather than depending on each one to pre-resolve.
    let target = canonical_key(Path::new(&path));
    if !fs_scope_allows(&app, &target) {
        return Err("outside the open workspace".to_string());
    }
    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    let recovery = recovery_for(&target.to_string_lossy());
    Ok(ReadResult { content, recovery })
}

// Cluster A: the sole binding entry point — read + bind atomically. On read
// failure NOTHING is bound (the renderer drops the binding and the next save
// forces Save As), so a moved/deleted file can never leave a stale path behind
// to be written into (P1-A wrong-file write).
// Cluster B: contained — every path that legitimately reaches here arrived via
// a user action that pre-approved it (dialog pick, delivered open, tree click
// inside scope, resolved link).
#[tauri::command]
fn bind_doc(app: AppHandle, window: tauri::WebviewWindow, path: String) -> Result<ReadResult, String> {
    // Read — and BIND — the canonical path we validated, not the raw argument
    // (see read_path). Binding the canonical also means the window's doc, its
    // watcher, and everything derived from the binding all refer to the file
    // that actually passed the gate.
    let target = canonical_key(Path::new(&path));
    if !fs_scope_allows(&app, &target) {
        return Err("outside the open workspace".to_string());
    }
    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    let p = target.to_string_lossy().to_string();
    let recovery = recovery_for(&p);
    set_current(&app, window.label(), &p, &content);
    Ok(ReadResult { content, recovery })
}

// Cluster A: unbind this window (untitled tab activated): drop the docs entry
// and its watcher. The old path leaves the agent write scope unless another
// window's binding or registered tab-set still covers it. Per-path dirty flags
// stay renderer-owned and are NOT touched here.
#[tauri::command]
fn detach_doc(window: tauri::WebviewWindow, state: tauri::State<AppState>) {
    let old = state.docs.lock_or_recover().remove(window.label());
    drop(old); // watcher drop outside the lock, same as set_current
}

#[tauri::command]
fn write_file(app: AppHandle, window: tauri::WebviewWindow, path: String, content: String) -> Result<String, String> {
    // Cluster A invariant: a plain save may ONLY write this window's bound
    // document. Any other target is refused — writes to arbitrary paths go
    // through save_dialog/materialize_doc/rename_file, which rebind atomically.
    // This makes a wrong-file write structurally impossible even if the
    // renderer's tab model has a bug.
    let bound = app
        .state::<AppState>()
        .docs
        .lock_or_recover()
        .get(window.label())
        .map(|d| d.path.clone())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "no document bound to this window".to_string())?;
    let target = canonical_key(Path::new(&bound));
    if canonical_key(Path::new(&path)) != target {
        return Err("refused: not this window's bound document (use Save As)".to_string());
    }
    // Write the canonicalized target we validated, never the raw path — a
    // symlink swap between check and write must not diverge (TOCTOU), matching
    // the socket writeDocument path.
    fs::write(&target, &content).map_err(|e| e.to_string())?;
    set_current(&app, window.label(), &bound, &content);
    Ok(bound)
}

#[derive(serde::Serialize)]
struct InitialFile {
    path: String,
    content: String,
    recovery: Option<String>,
}

#[tauri::command]
fn initial_file(app: AppHandle, window: tauri::WebviewWindow) -> Option<InitialFile> {
    let st = app.state::<AppState>();
    // A window opened via open_in_new_window / "New" has its own target file.
    // An empty per-window entry is the sentinel for a blank, untitled window:
    // resolve to None so the renderer starts empty instead of inheriting the
    // launch file held in `initial`.
    let per_window = st.window_files.lock_or_recover().remove(window.label());
    let p = match per_window {
        Some(p) if p.is_empty() => return None,
        Some(p) => Some(p),
        None => st.initial.lock_or_recover().clone(),
    }?;
    // Defense in depth: this is the one read that never passes fs_scope_allows
    // (it IS the bootstrap that establishes scope), so it gets the deny
    // directly. A sensitive file may only arrive here if a human explicitly
    // picked it — a launch argument, or a dialog — which is exactly what
    // approved_files records. Everything else is refused even if some earlier
    // gate was bypassed.
    let target = canonical_key(Path::new(&p));
    if is_sensitive_path(&target)
        && !app.state::<AppState>().approved_files.lock_or_recover().contains(&target)
    {
        eprintln!("initial_file refused: {} is sensitive and was not explicitly opened", target.display());
        return None;
    }
    let p = target.to_string_lossy().to_string();
    let content = fs::read_to_string(&p).ok()?;
    let recovery = recovery_for(&p);
    // Consuming the pending entry moves the file into docs — write scope keeps it.
    set_current(&app, window.label(), &p, &content);
    Some(InitialFile { path: p, content, recovery })
}

fn spawn_window(app: &AppHandle, file_path: &str) -> Result<(), String> {
    let st = app.state::<AppState>();
    let label = format!("w{}", st.win_counter.fetch_add(1, Ordering::SeqCst));
    st.window_files.lock_or_recover().insert(label.clone(), file_path.to_string());
    let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Plume")
        .focused(true) // a newly opened doc window comes to the front, not behind
        .inner_size(920.0, 720.0)
        .min_inner_size(480.0, 320.0);
    // The overlay title bar + hidden title are macOS-only builder methods.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_in_new_window(app: AppHandle, file_path: String) -> Result<(), String> {
    // Cluster B: this is a RENDERER-supplied path, and spawn_window records it
    // in window_files, which open_files() unions into the (dir-inclusive)
    // scope feeding both the renderer read gate and the socket's write_allowed.
    // Ungated it is the same privilege escalation as an unfiltered tab set —
    // so the target must already be user-established territory.
    let target = canonical_key(Path::new(&file_path));
    if !fs_scope_allows(&app, &target) {
        return Err("outside the open workspace".to_string());
    }
    // Window creation (and its initial_file content load) must run on the main
    // thread — commands run off it, so dispatch like the socket "open" path does.
    // Calling spawn_window directly built the window but left it empty.
    // Spawn the CANONICAL path: window_files feeds initial_file, which reads it
    // milliseconds later on another thread — a raw path leaves a symlink to swap
    // in between (class 1).
    let file_path = target.to_string_lossy().to_string();
    let appc = app.clone();
    app.run_on_main_thread(move || { let _ = spawn_window(&appc, &file_path); })
        .map_err(|e| e.to_string())
}

// Reuse verified Node code (html-to-docx, gdocs.js) via the bundled sidecar.
fn sidecar_script(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path().resource_dir().ok()?.join("sidecar/plume-sidecar.cjs");
    if p.exists() { Some(p) } else { None }
}

// ---- lazy app-local Node runtime (#8) ----
// The sidecar needs a Node runtime, which is NOT bundled (it would add ~50 MB
// to a ~5 MB app). Resolution order: Plume's private runtime in app-data
// (installed once via `install_node` below), then `node` reachable from this
// process. Neither → structured NODE_MISSING, which the renderer turns into
// the one-time "Enable export" download flow (ensureExportRuntime).
const NODE_VERSION: &str = "v22.22.0";
const NODE_DIST_BASE: &str = "https://nodejs.org/dist";

fn managed_node_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("node/bin/node"))
}

// A path that exists isn't necessarily a runtime that works: a broken Homebrew
// install (missing dylibs), a wrong-arch binary, or an nvm shim all pass
// is_file() and then die at spawn — and a working node one probe later never
// gets tried (F3). Only offer nodes that prove they run.
// Bounded (P1): a wedged shim that hangs on --version must cost at most this
// long before we move to the next candidate — an unbounded .status() here
// blocked resolve_node/node_status (and export's UI promise) forever.
const NODE_PROBE_TIMEOUT_SECS: u64 = 3;

// Kill the probe AND everything it spawned. A wrapper/shim's hang usually
// lives in a descendant (sh → sleep); Child::kill() reaps only the shim and
// orphans the rest, and repeated probes accumulate strays. The probe is
// spawned as its own process-group leader, so signalling -pid takes the tree.
fn kill_probe_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill(); // non-unix path; harmless no-op after the group kill
    let _ = child.wait(); // reap
}

fn node_runs(p: &Path) -> bool {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(p);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group, leader pid = child pid
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(NODE_PROBE_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    kill_probe_tree(&mut child);
                    return false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                kill_probe_tree(&mut child);
                return false;
            }
        }
    }
}

fn first_working_node(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file() && node_runs(p))
}

fn system_node() -> Option<PathBuf> {
    // GUI-launched macOS apps inherit a minimal PATH (/usr/bin:/bin:...), so a
    // plain `Command::new("node")` misses Homebrew/nvm installs. Probe the
    // common install spots, then whatever PATH we do have.
    let probes = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .into_iter()
        .map(PathBuf::from);
    if let Some(p) = first_working_node(probes) {
        return Some(p);
    }
    let paths = std::env::var_os("PATH")?;
    first_working_node(
        std::env::split_paths(&paths).map(|d| d.join(if cfg!(windows) { "node.exe" } else { "node" })),
    )
}

fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    // Health-check the managed runtime too: a half-copied or corrupted app-data
    // install should fall through to a system node, not wedge export.
    if let Some(p) = managed_node_path(app) {
        if p.is_file() && node_runs(&p) { return Some(p); }
    }
    system_node()
}

// Drain a stream to EOF keeping only the last `cap` bytes.
fn read_tail(mut r: impl Read, cap: usize) -> Vec<u8> {
    let mut tail: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > cap {
                    let cut = tail.len() - cap;
                    tail.drain(..cut);
                }
            }
        }
    }
    tail
}

// Hard deadline on any sidecar run (#8): a hung Node process (stuck OAuth flow,
// dead network fetch) previously blocked wait_with_output forever, wedging the
// export path for the rest of the session. Generous enough for a first-time
// Google OAuth round-trip; the sidecar itself carries tighter per-step deadlines.
const SIDECAR_TIMEOUT_SECS: u64 = 180;

fn run_sidecar(app: &AppHandle, req: &Value) -> Value {
    use std::process::{Command, Stdio};
    let script = match sidecar_script(app) {
        Some(p) => p,
        None => return json!({ "ok": false, "error": "export sidecar not found" }),
    };
    let node = match resolve_node(app) {
        Some(n) => n,
        None => return json!({ "ok": false, "error": "export needs a Node runtime", "code": "NODE_MISSING" }),
    };
    let mut child = match Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Piped, not null (F2): when the runtime crashes at launch (broken
        // Homebrew dylibs, wrong arch), stderr holds the only useful evidence.
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("export helper failed to start: {e}") }),
    };
    // Feed stdin and drain stdout/stderr on their own threads so a child that
    // never reads (or floods) a pipe can't deadlock us against the timeout loop below.
    if let Some(mut stdin) = child.stdin.take() {
        let payload = req.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(payload.as_bytes());
            // stdin drops here, closing the pipe so the sidecar sees EOF.
        });
    }
    let reader = child.stdout.take().map(|mut out| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            buf
        })
    });
    let err_reader = child.stderr.take().map(|err| {
        // Bounded (P2): only the last ~300 chars ever reach the UI, so keep a
        // rolling tail — a helper that floods stderr for the full 180s window
        // must not be able to exhaust memory.
        std::thread::spawn(move || read_tail(err, 8 * 1024))
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(SIDECAR_TIMEOUT_SECS);
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap; also unblocks the reader thread
                    return json!({ "ok": false, "error": "export timed out — the helper process was stopped" });
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        }
    };
    let stdout = reader.and_then(|t| t.join().ok()).unwrap_or_default();
    if let Ok(v) = serde_json::from_slice::<Value>(&stdout) {
        return v;
    }
    // No parseable result: the helper died before it could answer. Surface the
    // reason — exit code + stderr tail — instead of a blank "no result" (F2).
    let stderr = err_reader.and_then(|t| t.join().ok()).unwrap_or_default();
    let msg = String::from_utf8_lossy(&stderr);
    let msg = msg.trim();
    let start = msg.char_indices().rev().nth(299).map(|(i, _)| i).unwrap_or(0);
    let tail = &msg[start..];
    let code_txt = exit_status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "killed by signal".into());
    let error = if tail.is_empty() {
        format!("export helper exited (code {code_txt}) without producing a result")
    } else {
        format!("export helper failed (exit {code_txt}): {tail}")
    };
    json!({ "ok": false, "error": error })
}

// Runtime hardware arch — NOT the compile target: an x64 build running under
// Rosetta should still install the native arm64 runtime.
fn node_arch() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.optional.arm64"]).output() {
            if String::from_utf8_lossy(&o.stdout).trim() == "1" {
                return "arm64";
            }
        }
        "x64"
    }
    #[cfg(not(target_os = "macos"))]
    {
        if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
    }
}

// Build-time pinned SHA-256 digests for the tarballs we install (Cluster D /
// review #9). Previously the expected digest was fetched at runtime from
// SHASUMS256.txt over the SAME channel as the tarball, so the check only ever
// proved "the server was self-consistent" — anyone able to serve the tarball
// (a compromised mirror, or TLS interception on the user's machine) could
// serve a matching checksum file alongside it. A digest baked into the binary
// is something an attacker on that channel cannot influence.
//
// Supplied by pkg-dev: arm64 independently re-downloaded and hashed locally,
// x64 from the published SHASUMS256.txt. Bumping NODE_VERSION REQUIRES
// re-pinning both — `pinned_digests_match_node_version` fails the build's test
// run if a half-bump leaves these stale.
const NODE_TARBALL_SHA256: [(&str, &str); 2] = [
    (
        "node-v22.22.0-darwin-arm64.tar.gz",
        "5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640",
    ),
    (
        "node-v22.22.0-darwin-x64.tar.gz",
        "5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce",
    ),
];

// The pinned digest for a tarball name, if we have one.
fn pinned_sha256(file: &str) -> Option<&'static str> {
    NODE_TARBALL_SHA256
        .iter()
        .find_map(|(name, hash)| (*name == file).then_some(*hash))
}

// Download the official pinned-LTS Node for this machine into
// <data_dir>/node/bin/node: fetch SHASUMS256.txt, stream the tarball to disk
// hashing as we go, verify, extract only bin/node (it's self-contained), and
// prove the result runs. No sudo, no PATH mutation; survives app updates
// because app-data does. Errors are (code, message) — codes are part of the
// renderer contract (DOWNLOAD_FAILED / VERIFY_FAILED / EXTRACT_FAILED /
// UNSUPPORTED / IN_PROGRESS).
fn install_node_runtime(
    data_dir: &Path,
    progress: &dyn Fn(&str, u64, u64),
) -> Result<(PathBuf, String), (String, String)> {
    use sha2::{Digest, Sha256};
    if cfg!(windows) {
        return Err(("UNSUPPORTED".into(), "automatic Node install isn't supported on Windows yet — install Node from nodejs.org and relaunch Plume".into()));
    }
    let platform = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let name = format!("node-{NODE_VERSION}-{platform}-{}", node_arch());
    let tarball = format!("{name}.tar.gz");
    let dl = |m: String| ("DOWNLOAD_FAILED".to_string(), m);

    // redirects(0): the download must come from the host we chose. A redirect
    // to another origin is not a download path we want to follow silently.
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .redirects(0)
        .build();

    // Build-pinned digest — no runtime SHASUMS256.txt fetch (see the constant).
    let expected = pinned_sha256(&tarball)
        .ok_or_else(|| {
            (
                "UNSUPPORTED".to_string(),
                format!("no pinned checksum for {tarball} — this build can't install Node for this platform"),
            )
        })?
        .to_string();

    let resp = agent
        .get(&format!("{NODE_DIST_BASE}/{NODE_VERSION}/{tarball}"))
        .call()
        .map_err(|e| dl(format!("download failed: {e}")))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);

    let work = data_dir.join("node.download");
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| dl(e.to_string()))?;
    let tgz = work.join(&tarball);

    const MAX_BYTES: u64 = 256 * 1024 * 1024; // sanity cap, tarballs are ~50 MB
    let mut hasher = Sha256::new();
    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&tgz).map_err(|e| dl(e.to_string()))?;
    let mut buf = [0u8; 128 * 1024];
    let mut received: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| dl(format!("download interrupted: {e}")))?;
        if n == 0 { break; }
        received += n as u64;
        if received > MAX_BYTES {
            let _ = fs::remove_dir_all(&work);
            return Err(dl("download exceeded size cap".into()));
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| dl(e.to_string()))?;
        progress("download", received, total);
    }
    drop(file);

    progress("verify", received, total);
    let got = format!("{:x}", hasher.finalize());
    if got != expected {
        let _ = fs::remove_dir_all(&work);
        return Err(("VERIFY_FAILED".into(), format!("checksum mismatch for {tarball}")));
    }

    progress("extract", received, total);
    let status = std::process::Command::new("tar")
        .arg("-xzf").arg(&tgz).arg("-C").arg(&work).arg(format!("{name}/bin/node"))
        .status()
        .map_err(|e| ("EXTRACT_FAILED".to_string(), e.to_string()))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&work);
        return Err(("EXTRACT_FAILED".into(), "tar extraction failed".into()));
    }

    let bin_dir = data_dir.join("node/bin");
    fs::create_dir_all(&bin_dir).map_err(|e| ("EXTRACT_FAILED".to_string(), e.to_string()))?;
    let final_path = bin_dir.join("node");
    let _ = fs::remove_file(&final_path);
    fs::rename(work.join(&name).join("bin/node"), &final_path)
        .map_err(|e| ("EXTRACT_FAILED".to_string(), e.to_string()))?;
    let _ = fs::remove_dir_all(&work);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&final_path, fs::Permissions::from_mode(0o755));
    }

    // Prove it: runs and is the pinned version.
    let out = std::process::Command::new(&final_path)
        .arg("--version")
        .output()
        .map_err(|e| ("VERIFY_FAILED".to_string(), format!("installed node won't run: {e}")))?;
    let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !ver.starts_with(NODE_VERSION) {
        return Err(("VERIFY_FAILED".into(), format!("installed node reports unexpected version '{ver}'")));
    }
    progress("done", received, total);
    Ok((final_path, ver))
}

static NODE_INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn node_status(app: AppHandle) -> Value {
    let managed = managed_node_path(&app).map(|p| p.is_file()).unwrap_or(false);
    json!({ "available": managed || system_node().is_some(), "managed": managed })
}

#[tauri::command]
async fn install_node(app: AppHandle) -> Value {
    if NODE_INSTALLING.swap(true, Ordering::SeqCst) {
        return json!({ "ok": false, "error": "a Node install is already running", "code": "IN_PROGRESS" });
    }
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            NODE_INSTALLING.store(false, Ordering::SeqCst);
            return json!({ "ok": false, "error": e.to_string(), "code": "DOWNLOAD_FAILED" });
        }
    };
    let appc = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        install_node_runtime(&data_dir, &|phase, received, total| {
            let _ = appc.emit("node-install-progress", json!({ "phase": phase, "received": received, "total": total }));
        })
    })
    .await;
    NODE_INSTALLING.store(false, Ordering::SeqCst);
    match res {
        Ok(Ok((_, ver))) => json!({ "ok": true, "version": ver }),
        Ok(Err((code, msg))) => json!({ "ok": false, "error": msg, "code": code }),
        Err(e) => json!({ "ok": false, "error": e.to_string(), "code": "DOWNLOAD_FAILED" }),
    }
}

// Returns { ok:true, path } | { ok:false, cancelled:true } (save dialog closed)
// | { ok:false, error, code? }. Failures used to collapse to None here, which
// left the renderer nothing to show the user (F2).
#[tauri::command]
async fn export_doc(app: AppHandle, format: String, html: String, default_name: Option<String>) -> Value {
    let ext = match format.as_str() { "html" => "html", "pdf" => "pdf", "docx" => "docx", _ => "html" };
    let picked = match app
        .dialog()
        .file()
        .add_filter(ext.to_uppercase(), &[ext])
        .set_file_name(format!("{}.{}", default_name.unwrap_or_else(|| "document".into()), ext))
        .blocking_save_file()
    {
        Some(p) => p,
        None => return json!({ "ok": false, "cancelled": true }),
    };
    let path = match picked.into_path() {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let p = path.to_string_lossy().to_string();
    if ext == "html" {
        // Same vetting as docx/PDF. Nothing in OUR process fetches here, but
        // the saved file keeps live remote <img> that the user's browser
        // fetches on open — a beacon fired later, from their machine. Inlining
        // also makes the export self-contained, which is what people expect a
        // saved HTML document to be.
        let html = sanitize_export_html(&html);
        return match fs::write(&p, html) {
            Ok(()) => json!({ "ok": true, "path": p }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
    }
    if ext == "docx" {
        // Vet + inline every remote image BEFORE the sidecar sees the HTML, so
        // html-to-docx never fetches anything (export SSRF choke point).
        let html = sanitize_export_html(&html);
        let mut res = run_sidecar(&app, &json!({ "cmd": "docx", "html": html, "out": p }));
        if res["ok"] == true {
            res["path"] = Value::String(p);
        }
        return res; // failures keep run_sidecar's error + code (e.g. NODE_MISSING)
    }
    json!({ "ok": false, "error": "pdf export goes through export_pdf" })
}

#[tauri::command]
async fn publish_google(app: AppHandle, markdown: String, default_name: Option<String>) -> Value {
    run_sidecar(&app, &json!({ "cmd": "gdocs", "markdown": markdown, "defaultName": default_name }))
}

// ---- export SSRF choke point ----
// A document is untrusted, and `![](http://169.254.169.254/…)` becomes a plain
// <img src>. Both export renderers used to fetch those themselves — html-to-docx
// in the Node sidecar (twice per image, following redirects) and WKWebView for
// PDF — reaching cloud metadata, loopback and intranet hosts from the user's
// machine, and embedding whatever came back into a file they may then share.
// link_preview's guard never saw those paths.
//
// So every export now goes through here FIRST: each remote <img src> is fetched
// by Rust through the same vetted-address path as link_preview and inlined as a
// data: URI, or dropped to its alt text. The renderers receive zero remote URLs
// and never need the network. Deliberately NOT a "is this host safe?" helper for
// the sidecar: a check in one process followed by a fetch in another re-creates
// the DNS-rebinding window cluster D closed — whoever connects must be whoever
// vetted the address.
const EXPORT_IMG_MAX_BYTES: u64 = 8 * 1024 * 1024; // per image
const EXPORT_IMG_TIMEOUT: Duration = Duration::from_secs(10);
const EXPORT_TOTAL_BUDGET: Duration = Duration::from_secs(45);
const EXPORT_MAX_IMAGES: usize = 40;

// Minimal base64 (no new dependency for ~20 lines).
fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// True for the schemes this rewriter must vet. Anything else (data:, relative,
// file:, asset:) is left exactly as-is: those never make Plume fetch a remote
// host, and rewriting them would change existing export behavior.
fn is_remote_url(src: &str) -> bool {
    let s = src.trim().to_ascii_lowercase();
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("//")
}

// Sources this rewriter refuses to carry into an export. Remote ones are
// fetched + vetted; `file:` is dropped outright — an absolute file URL in a
// hostile document is an attempt to pull a local file into a document the user
// may then share, and no export format needs it (local images arrive as
// relative paths or data:). Downstream layers already stop it; refusing here
// too means one layer is enough on its own.
fn is_refusable_src(src: &str) -> bool {
    is_remote_url(src) || src.trim().to_ascii_lowercase().starts_with("file:")
}

// Fetch one image through the vetted-address path and return a data: URI.
// Fail-closed at every step: non-public address, redirect, non-image type, or
// oversize all yield None, and the caller falls back to alt text.
fn fetch_image_data_uri(url: &str) -> Option<String> {
    // Protocol-relative "//host/x.png" has no scheme for the resolver; assume
    // https rather than guessing http (and never silently downgrade).
    let absolute = if url.trim().starts_with("//") { format!("https:{}", url.trim()) } else { url.trim().to_string() };
    let vetted = resolve_public_addrs(&absolute)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(EXPORT_IMG_TIMEOUT)
        .redirects(0) // a public URL that 30x's to an internal host is refused, not followed
        .resolver(move |_: &str| Ok(vetted.clone()))
        .build();
    let resp = agent.get(&absolute).set("User-Agent", PREVIEW_UA).call().ok()?;
    let ct = resp.content_type().to_string();
    let mime = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return None;
    }
    let mut buf = Vec::new();
    resp.into_reader()
        .take(EXPORT_IMG_MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.is_empty() || buf.len() as u64 > EXPORT_IMG_MAX_BYTES {
        return None;
    }
    Some(format!("data:{};base64,{}", mime, base64_encode(&buf)))
}

// Escape a string for use as HTML text (alt-text fallback).
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// Walk a tag's attributes the way an HTML parser does: name, optional '=',
// then a quoted-or-bare value, with the FIRST occurrence of a name winning.
// Returns None if the tag does not cleanly parse, so the caller can fail closed.
//
// Substring matching (`find("src=")`) is NOT good enough here, and the failure
// is exploitable — pkg-dev measured it fetching. In
//   <img alt="<img src=data:image/png;base64,AAA>" src="http://attacker/x.png">
// the first `src=` lives inside the ALT value, so a substring reader either
// concludes "already data:, leave it" or finds no usable src and passes the tag
// through — while the converter's real parser sees the remote src and fetches
// it. Walking attributes means the src we vet is the src the parser will use.
// First-wins also matches how parsers resolve duplicates, so a trailing
// `src="data:…"` decoy cannot rescue a leading remote one.
fn parse_tag_attrs(tag: &str) -> Option<Vec<(String, String)>> {
    let inner = tag.strip_prefix('<')?.strip_suffix('>')?;
    let inner = inner.strip_suffix('/').unwrap_or(inner);
    let c: Vec<char> = inner.chars().collect();
    let mut i = 0;
    while i < c.len() && !c[i].is_whitespace() {
        i += 1; // tag name
    }
    let mut attrs: Vec<(String, String)> = vec![];
    loop {
        while i < c.len() && c[i].is_whitespace() {
            i += 1;
        }
        if i >= c.len() {
            return Some(attrs);
        }
        let name_start = i;
        while i < c.len() && !c[i].is_whitespace() && c[i] != '=' {
            i += 1;
        }
        if i == name_start {
            return None; // no progress (e.g. a stray '=') — unparseable, fail closed
        }
        let name: String = c[name_start..i].iter().collect::<String>().to_ascii_lowercase();
        while i < c.len() && c[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < c.len() && c[i] == '=' {
            i += 1;
            while i < c.len() && c[i].is_whitespace() {
                i += 1;
            }
            if i < c.len() && (c[i] == '"' || c[i] == '\'') {
                let q = c[i];
                i += 1;
                let vs = i;
                while i < c.len() && c[i] != q {
                    i += 1;
                }
                if i >= c.len() {
                    return None; // unterminated quote — unparseable, fail closed
                }
                value = c[vs..i].iter().collect();
                i += 1;
            } else {
                let vs = i;
                while i < c.len() && !c[i].is_whitespace() {
                    i += 1;
                }
                value = c[vs..i].iter().collect();
            }
        }
        if !attrs.iter().any(|(n, _)| n == &name) {
            attrs.push((name, value)); // first occurrence wins
        }
    }
}

fn attr_of<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

// Rewrite ONE <img …> tag. `fetch` is injected so the policy is unit-testable
// without a network. Every path REBUILDS the tag from the attributes we vetted
// (src + alt) rather than passing the original through — pass-through is what
// lets an unrecognised attribute carry a second remote reference.
fn rewrite_img_tag(tag: &str, fetch: &mut dyn FnMut(&str) -> Option<String>) -> String {
    let Some(attrs) = parse_tag_attrs(tag) else {
        return String::new(); // unparseable → drop, never trust
    };
    let alt = attr_of(&attrs, "alt").unwrap_or_default().to_string();
    let alt_fallback = || {
        if alt.trim().is_empty() {
            String::new()
        } else {
            format!("<span>{}</span>", html_escape(&alt))
        }
    };
    let src = match attr_of(&attrs, "src") {
        Some(s) if !s.trim().is_empty() => s.to_string(),
        _ => return alt_fallback(), // no usable src — nothing to render
    };
    if !is_refusable_src(&src) {
        // data: and relative paths never make Plume fetch a remote host. Keep
        // the src, but still emit only the attributes we parsed.
        return format!("<img src=\"{}\" alt=\"{}\">", html_escape(&src), html_escape(&alt));
    }
    if !is_remote_url(&src) {
        return alt_fallback(); // file: — never fetched, never carried through
    }
    match fetch(&src) {
        Some(data_uri) => format!("<img src=\"{}\" alt=\"{}\">", data_uri, html_escape(&alt)),
        // Refused: keep the author's alt text so the document still reads.
        None => alt_fallback(),
    }
}

// End of the tag starting at `start`, QUOTE-AWARE: the terminating '>' is the
// first one outside an attribute value.
//
// A naive `find('>')` truncates the tag at a '>' inside a quoted value, and
// that is a BYPASS, not a cosmetic bug: for `<img alt="a>b" src="http://evil/">`
// the scan would stop before `src`, leave the whole thing untouched — and a
// real HTML parser (WKWebView, html-to-docx) would then read one well-formed
// tag with a live remote src and fetch it. Our own markdown pipeline escapes
// '>' inside attributes, but a sanitizer must not be correct only because of
// what its current caller happens to emit.
fn tag_end(html: &str, start: usize) -> usize {
    let mut quote: Option<char> = None;
    for (off, c) in html[start..].char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '>' => return start + off + c.len_utf8(),
            None => {}
        }
    }
    html.len() // unterminated tag — consume the rest
}

// Rewrite every <img> in `html` (see rewrite_img_tag). Offsets index the
// ORIGINAL string via find_ci — never a lowercased copy (cluster C).
fn sanitize_export_html_with(html: &str, fetch: &mut dyn FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while let Some(rel) = html.get(i..).and_then(|s| find_ci(s, "<img")) {
        let start = i + rel;
        let end = tag_end(html, start);
        if end <= start {
            break; // defensive: never spin on a zero-width step
        }
        out.push_str(slice_clamped(html, i, start));
        out.push_str(&rewrite_img_tag(slice_clamped(html, start, end), fetch));
        i = end;
    }
    out.push_str(slice_clamped(html, i, html.len()));
    out
}

fn sanitize_export_html(html: &str) -> String {
    let deadline = std::time::Instant::now() + EXPORT_TOTAL_BUDGET;
    let mut fetched = 0usize;
    let mut fetch = move |url: &str| -> Option<String> {
        // Bound the work a hostile document can cause: a doc with hundreds of
        // images, or slow hosts, must not hang the export indefinitely. Past
        // either bound everything remaining degrades to alt text.
        if fetched >= EXPORT_MAX_IMAGES || std::time::Instant::now() >= deadline {
            return None;
        }
        fetched += 1;
        fetch_image_data_uri(url)
    };
    sanitize_export_html_with(html, &mut fetch)
}

// Defense in depth for the PDF path (pkg-dev's measurement: WebKit enforces a
// document CSP, so an unenumerated subresource vector still cannot fetch after
// inlining). Injected into <head> if there is one; otherwise prepended.
const EXPORT_CSP: &str = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

fn with_export_csp(html: &str) -> String {
    match find_ci(html, "<head>") {
        Some(i) => {
            let at = i + "<head>".len();
            format!("{}{}{}", slice_clamped(html, 0, at), EXPORT_CSP, slice_clamped(html, at, html.len()))
        }
        None => format!("{}{}", EXPORT_CSP, html),
    }
}

// ---- PDF export: render HTML in a hidden WKWebView, then WKWebView.createPDF ----
// The hidden export window starts on about:blank (never the editor app) and its
// pdf* label is not in capabilities/default.json — exported HTML gets no IPC.
fn pdf_blank_url() -> tauri::WebviewUrl {
    tauri::WebviewUrl::External("about:blank".parse().expect("about:blank is a valid URL"))
}

#[cfg(target_os = "macos")]
fn pdf_load_html(pw: &tauri::webview::PlatformWebview, html: &str) {
    use objc2_foundation::NSString;
    use objc2_web_kit::WKWebView;
    unsafe {
        let wv: &WKWebView = &*(pw.inner() as *const WKWebView);
        let _ = wv.loadHTMLString_baseURL(&NSString::from_str(html), None);
    }
}

#[cfg(target_os = "macos")]
fn pdf_create(pw: &tauri::webview::PlatformWebview, tx: std::sync::mpsc::Sender<Result<Vec<u8>, String>>) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};
    unsafe {
        let wv: &WKWebView = &*(pw.inner() as *const WKWebView);
        let mtm = MainThreadMarker::new().expect("pdf_create must run on the main thread");
        let config = WKPDFConfiguration::new(mtm);
        let block = RcBlock::new(move |data: *mut NSData, _err: *mut NSError| {
            if data.is_null() {
                let _ = tx.send(Err("createPDF returned no data".into()));
            } else {
                let d: &NSData = &*data;
                let _ = tx.send(Ok(d.to_vec()));
            }
        });
        wv.createPDFWithConfiguration_completionHandler(Some(&config), &block);
    }
}

// macOS PDF export via WKWebView.createPDF. Windows/Linux land in Phase 2
// (WebView2 PrintToPdfAsync / WebKitGTK print) — for now a graceful stub so the
// build is green on every platform.
#[cfg(target_os = "macos")]
fn generate_pdf(app: &AppHandle, html: String) -> Result<Vec<u8>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    let label = format!("pdf{}", app.state::<AppState>().win_counter.fetch_add(1, Ordering::SeqCst));
    let app_main = app.clone();
    let label_main = label.clone();
    app.run_on_main_thread(move || {
        // about:blank, not index.html: the export HTML is arbitrary document
        // content, so the hidden window must never boot the editor app — and its
        // pdf* label is deliberately absent from capabilities/default.json, so it
        // has no IPC surface at all.
        let win = match tauri::WebviewWindowBuilder::new(&app_main, &label_main, pdf_blank_url())
            .visible(false)
            .inner_size(816.0, 1056.0)
            .build()
        {
            Ok(w) => w,
            Err(e) => { let _ = tx.send(Err(e.to_string())); return; }
        };
        let _ = win.with_webview(move |pw| pdf_load_html(&pw, &html));
        let app2 = app_main.clone();
        let label2 = label_main.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1000));
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || {
                if let Some(win) = app3.get_webview_window(&label2) {
                    let _ = win.with_webview(move |pw| pdf_create(&pw, tx));
                }
            });
        });
    }).map_err(|e| e.to_string())?;

    let result = rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "pdf timeout".to_string())?;
    let app_close = app.clone();
    let label_close = label.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_close.get_webview_window(&label_close) { let _ = w.close(); }
    });
    result
}

// Windows/Linux PDF export: render the HTML in a hidden webview, print it to a
// temp PDF via the platform webview's print API, then read the bytes back so the
// export_pdf flow (pick path -> write bytes) is identical across platforms.
//
// NOTE: this is compiled + CI-verified against the pinned webview2-com/webkit2gtk
// versions, but the runtime print path is unverified pending Windows/Linux VM
// testing. Failures surface as a normal export error (toast), never a crash.
#[cfg(not(target_os = "macos"))]
fn generate_pdf(app: &AppHandle, html: String) -> Result<Vec<u8>, String> {
    let n = app.state::<AppState>().win_counter.fetch_add(1, Ordering::SeqCst);
    let label = format!("pdf{}", n);
    let tmp = std::env::temp_dir().join(format!("plume-export-{}.pdf", n));
    let tmp_str = tmp.to_string_lossy().to_string();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let app_main = app.clone();
    let label_main = label.clone();
    app.run_on_main_thread(move || {
        // about:blank + no capability entry for pdf* — same rationale as macOS.
        let win = match tauri::WebviewWindowBuilder::new(&app_main, &label_main, pdf_blank_url())
            .visible(false)
            .inner_size(816.0, 1056.0)
            .build()
        {
            Ok(w) => w,
            Err(e) => { let _ = tx.send(Err(e.to_string())); return; }
        };
        let _ = win.with_webview(move |pw| pdf_print(pw, html, tmp_str, tx));
    }).map_err(|e| e.to_string())?;

    let result = rx.recv_timeout(Duration::from_secs(25)).map_err(|_| "pdf timeout".to_string())?;
    let app_close = app.clone();
    let label_close = label.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_close.get_webview_window(&label_close) { let _ = w.close(); }
    });
    result?;
    let bytes = fs::read(&tmp).map_err(|e| format!("read pdf: {e}"))?;
    let _ = fs::remove_file(&tmp);
    if bytes.is_empty() { return Err("generated PDF was empty".into()); }
    Ok(bytes)
}

// Linux: load the HTML into the hidden WebKitGTK view, and once it finishes
// loading run a print operation configured to write a PDF to `out_path`.
#[cfg(target_os = "linux")]
fn pdf_print(
    pw: tauri::webview::PlatformWebview,
    html: String,
    out_path: String,
    tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use webkit2gtk::{LoadEvent, PrintOperation, PrintOperationExt, WebViewExt};
    let web_view = pw.inner();
    let fired = std::rc::Rc::new(std::cell::Cell::new(false));
    web_view.connect_load_changed(move |view, event| {
        if event != LoadEvent::Finished || fired.get() {
            return;
        }
        fired.set(true);
        let op = PrintOperation::new(view);
        let settings = gtk::PrintSettings::new();
        settings.set("output-uri", Some(format!("file://{}", out_path).as_str()));
        settings.set("output-file-format", Some("pdf"));
        op.set_print_settings(&settings);
        let tx_done = tx.clone();
        op.connect_finished(move |_| {
            let _ = tx_done.send(Ok(()));
        });
        // Keep the operation alive through the async print (bounded: one per export).
        std::mem::forget(op);
    });
    web_view.load_html(&html, None);
}

// Windows: navigate the hidden WebView2 to the HTML string, and on navigation
// completion call PrintToPdf to write a PDF to `out_path`.
#[cfg(windows)]
fn pdf_print(
    pw: tauri::webview::PlatformWebview,
    html: String,
    out_path: String,
    tx: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2PrintSettings, ICoreWebView2_7};
    use webview2_com::{NavigationCompletedEventHandler, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};
    unsafe {
        let core = match pw.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => { let _ = tx.send(Err(e.to_string())); return; }
        };
        let core_for_print = core.clone();
        let out = out_path.clone();
        let tx_nav = tx.clone();
        let handler = NavigationCompletedEventHandler::create(Box::new(move |_sender, _args| {
            let wv7: ICoreWebView2_7 = match core_for_print.cast() {
                Ok(w) => w,
                Err(e) => { let _ = tx_nav.send(Err(e.to_string())); return Ok(()); }
            };
            let tx_pdf = tx_nav.clone();
            let pdf_handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                if hr.is_ok() && ok {
                    let _ = tx_pdf.send(Ok(()));
                } else {
                    let _ = tx_pdf.send(Err(format!("PrintToPdf failed: hr={hr:?} ok={ok:?}")));
                }
                Ok(())
            }));
            if let Err(e) = wv7.PrintToPdf(
                &HSTRING::from(out.as_str()),
                None::<&ICoreWebView2PrintSettings>,
                &pdf_handler,
            ) {
                let _ = tx_nav.send(Err(e.to_string()));
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        if let Err(e) = core.add_NavigationCompleted(&handler, &mut token) {
            let _ = tx.send(Err(e.to_string()));
            return;
        }
        if let Err(e) = core.NavigateToString(&HSTRING::from(html.as_str())) {
            let _ = tx.send(Err(e.to_string()));
        }
    }
}

#[tauri::command]
async fn export_pdf(app: AppHandle, html: String, default_name: Option<String>) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(format!("{}.pdf", default_name.unwrap_or_else(|| "document".into())))
        .blocking_save_file()?;
    let out = picked.into_path().ok()?.to_string_lossy().to_string();
    // Same choke point for PDF: WKWebView receives no remote URLs, and the
    // injected CSP stops any vector we didn't enumerate from fetching.
    let html = with_export_csp(&sanitize_export_html(&html));
    match generate_pdf(&app, html) {
        Ok(bytes) if !bytes.is_empty() => { fs::write(&out, bytes).ok()?; Some(out) }
        _ => None,
    }
}

#[tauri::command]
fn open_external(url: String) {
    // Only hand safe web/mail schemes to the OS opener. open::that would otherwise
    // launch file://, custom app schemes (vscode://, smb://, …), etc.
    let lower = url.trim_start().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:") {
        let _ = open::that(url);
    }
}

// Shared by the open_dialog command and the zero-window File > Open path (on
// macOS the app now outlives its last window, so the menu must work windowless).
fn open_via_dialog(app: &AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "mdx", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    if Path::new(&p).is_file() {
        // A native file dialog IS the human picking this exact path, so this is
        // the one source allowed to approve a sensitive file — File ▸ Open of
        // your own .env must keep working.
        deliver_open(app, &p, None, true);
    }
    Some(p)
}

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Option<String> {
    open_via_dialog(&app)
}

#[tauri::command]
async fn save_dialog(app: AppHandle, window: tauri::WebviewWindow, content: String) -> Option<String> {
    // The doc bound to this window BEFORE we rebind. If it is a draft, ⌘S is a
    // graduation: write the current buffer to the chosen path, then delete the
    // Autosave source (SAVEFLOW write-then-delete — never a rename, which would
    // lose edits newer than the last autosave tick and fail across volumes).
    let prev = window_doc_path(&app, window.label());
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        // SAVEFLOW: the save dialog opens on ~/Documents by default.
        .set_directory(home_dir().join("Documents"))
        .set_file_name("Untitled.md")
        .blocking_save_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    // Write the CURRENT buffer and confirm it landed before touching the source.
    fs::write(&p, &content).ok()?;
    // Graduate: only a DRAFT source is deleted (a normal Save As leaves its
    // original in place); never delete the very file we just wrote.
    if let Some(prev) = prev {
        if graduate_should_delete_source(&autosave_key(), Path::new(&prev), &path) {
            // Move the annotations sidecar BEFORE deleting the draft. The
            // notes live at <parent>/.plume/<filename>.notes.json, so a
            // graduation left them stranded in Autosave/.plume/ and reopening
            // the saved file loaded zero annotations — silently losing steer
            // directives the user wrote. Migrate first: if this fails, the
            // draft (and its notes) are still on disk to recover from.
            migrate_annotations(Path::new(&prev), &path);
            let _ = fs::remove_file(&prev);
            let _ = fs::remove_file(recovery_path(&prev)); // orphaned draft snapshot
        }
    }
    // The user picked this location in a native dialog — its dir is now
    // user-established territory (same trust as pick_folder).
    if let Some(parent) = path.parent() {
        app.state::<AppState>()
            .approved_dirs
            .lock_or_recover()
            .insert(canonical_key(parent));
    }
    clear_untitled_recovery(window.label());
    set_current(&app, window.label(), &p, &content);
    Some(p)
}

// ---- autosave / auto-place ----
fn sanitize_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.chars().take(60).collect();
    if s.is_empty() { "untitled".into() } else { s }
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{}.{}", stem, ext));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{}-{}.{}", stem, n, ext));
        n += 1;
    }
    p
}

fn default_plume_dir() -> PathBuf {
    home_dir().join("Documents").join("Plume")
}

#[tauri::command]
fn default_docs_dir() -> String {
    default_plume_dir().to_string_lossy().to_string()
}

// Create a new file for a never-saved doc: resolve the target folder (default
// ~/Documents/Plume), ensure it exists, pick a collision-free name, write, and
// make it the current doc so autosave takes over.
#[tauri::command]
fn materialize_doc(app: AppHandle, window: tauri::WebviewWindow, dir: Option<String>, name: String, content: String) -> Option<String> {
    let base = match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => default_plume_dir(),
    };
    // Cluster B: a renderer-supplied target folder must be user territory; the
    // default ~/Documents/Plume is always Plume's own to create into.
    let base = canonical_key(&base); // create in the dir we vet (class 1)
    let base_ok = base == canonical_key(&default_plume_dir()) || fs_scope_allows(&app, &base);
    if !base_ok {
        return None;
    }
    fs::create_dir_all(&base).ok()?;
    let path = unique_path(&base, &sanitize_stem(&name), "md");
    fs::write(&path, &content).ok()?;
    let p = path.to_string_lossy().to_string();
    // The buffer is now a real file — its untitled crash snapshot is obsolete.
    clear_untitled_recovery(window.label());
    set_current(&app, window.label(), &p, &content);
    Some(p)
}

// ---- SAVEFLOW: draft autosave ----
// Untitled markdown buffers autosave here as real .md files — the Autosave file
// IS the draft's persistence. "Is a draft" is DERIVED (a bound path inside this
// ONE canonical dir), never a stored flag; the renderer mirrors the rule via the
// authoritative drafts_dir() prefix. This subdir alone is always in fs scope (see
// fs_scope_allows); its parent ~/Documents/Plume is NOT blanket-allowed.
fn autosave_dir() -> PathBuf {
    default_plume_dir().join("Autosave")
}

// Canonicalized Autosave dir for containment/prefix comparisons. Falls back to the
// literal path only when the dir does not exist yet; every caller that needs a
// stable canonical form (drafts_dir, create_draft) ensures the dir first.
fn autosave_key() -> PathBuf {
    canonical_key(&autosave_dir())
}

// Component-wise containment: ".../Autosave-evil" does NOT count as inside
// ".../Autosave" (Path::starts_with compares whole components). The dir itself
// counts as "in scope"; discard_draft additionally demands STRICTLY inside.
fn is_within_autosave(autosave: &Path, target: &Path) -> bool {
    target == autosave || target.starts_with(autosave)
}

// On Save As: delete the previous binding as a graduated draft iff it lived inside
// Autosave AND is not the very file we just wrote. A normal (non-draft) Save As
// leaves its original untouched.
fn graduate_should_delete_source(autosave: &Path, prev: &Path, chosen: &Path) -> bool {
    let prev = canonical_key(prev);
    is_within_autosave(autosave, &prev) && prev.as_path() != autosave && prev != canonical_key(chosen)
}

// discard_draft's containment gate (pure, unit-tested): a deletable draft is a
// REGULAR FILE strictly inside the Autosave dir.
fn draft_delete_ok(autosave: &Path, target: &Path, is_regular_file: bool) -> bool {
    is_regular_file && target != autosave && target.starts_with(autosave)
}

// Write a fresh, collision-free draft file (pure FS — no AppHandle, so it
// unit-tests against a temp dir). Ensures the dir, uniquifies the sanitized stem.
fn write_new_draft(autosave: &Path, suggested: &str, content: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(autosave)?;
    let path = unique_path(autosave, &sanitize_stem(suggested), "md");
    fs::write(&path, content)?;
    Ok(path)
}

// Move a document's annotations sidecar when the document itself moves.
// Best-effort and non-destructive: rename first (same volume), fall back to
// copy+remove, and NEVER clobber notes that already exist at the destination —
// the user's directives there are worth more than a stale draft's.
fn migrate_annotations(from: &Path, to: &Path) {
    let (_, src) = sidecar(&from.to_string_lossy());
    if !src.is_file() {
        return;
    }
    let (dst_dir, dst) = sidecar(&to.to_string_lossy());
    if dst.exists() {
        return;
    }
    if fs::create_dir_all(&dst_dir).is_err() {
        return;
    }
    if fs::rename(&src, &dst).is_ok() {
        return;
    }
    if fs::copy(&src, &dst).is_ok() {
        let _ = fs::remove_file(&src); // copied across volumes; drop the original
    }
}

// The canonical Autosave dir — the authoritative prefix the renderer uses for
// is-draft derivation (bridge draftsDir). Created on demand so the returned path
// is fully canonical and shares create_draft's form.
#[tauri::command]
fn drafts_dir() -> Option<String> {
    let dir = autosave_dir();
    fs::create_dir_all(&dir).ok()?;
    Some(canonical_key(&dir).to_string_lossy().to_string())
}

// Create + bind a new draft from a never-saved markdown buffer. The renderer calls
// this on the first autosave tick of an untitled markdown doc; after binding, the
// normal bound write_file autosave path takes over. Returns { path } (canonical,
// so it shares the drafts_dir prefix). None on failure (bridge catches -> null).
#[tauri::command]
fn create_draft(app: AppHandle, window: tauri::WebviewWindow, suggested_name: String, content: String) -> Option<Value> {
    let path = write_new_draft(&autosave_dir(), &suggested_name, &content).ok()?;
    let p = canonical_key(&path).to_string_lossy().to_string();
    set_current(&app, window.label(), &p, &content);
    Some(json!({ "path": p }))
}

// A human label for a draft: the first non-empty line (heading/bullet markers
// stripped), falling back to the filename stem. The stem is the creation-time
// name and goes stale as the draft is edited, so the live first line wins.
fn draft_title(content: &str, stem_fallback: &str) -> String {
    for line in content.lines() {
        let t = line
            .trim()
            .trim_start_matches('#')
            .trim_start_matches(['-', '*', '+'])
            .trim();
        if !t.is_empty() {
            return t.chars().take(120).collect();
        }
    }
    stem_fallback.to_string()
}

// Pure (unit-testable against a temp dir): the .md drafts in `dir`, newest first,
// as { path, ts, title }. Each path is CANONICALIZED so it shares the exact form
// drafts_dir()/create_draft return — otherwise a draft opened from this list on a
// Mac with a symlinked ~/Documents (iCloud sync) would carry a divergent prefix
// and silently stop classifying as a draft (N1).
// Enough to hold a first line by any sane measure; a draft whose first 64 KiB
// contain no newline gets a truncated title rather than an OOM.
const DRAFT_TITLE_SCAN_BYTES: u64 = 64 * 1024;

// Agent-written files (session transcripts, the Codex session index) have no
// size ceiling we control, and these run on listing paths. Bound every read of
// them; a title/index entry past the window is simply not found.
const AGENT_SESSION_SCAN_BYTES: u64 = 256 * 1024;
const AGENT_INDEX_SCAN_BYTES: u64 = 4 * 1024 * 1024;

// An annotations sidecar is a list of margin notes; far above any real one.
const MAX_ANNOTATIONS_BYTES: u64 = 16 * 1024 * 1024;

// Ceiling for auto-reloading a watched file. Far above any document a person
// edits; only an automated writer reaches it.
const MAX_WATCHED_RELOAD_BYTES: u64 = 128 * 1024 * 1024;

// Read at most `cap` bytes from the head of a file, lossily. Never loads a file
// whole, so an attacker-sized (or agent-sized) draft can't exhaust memory.
fn read_head(path: &Path, cap: u64) -> String {
    let Ok(f) = fs::File::open(path) else { return String::new() };
    let mut buf = Vec::new();
    if f.take(cap).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn list_drafts_in(dir: &Path) -> Vec<Value> {
    let mut rows: Vec<(u64, Value)> = vec![];
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() || p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let path = canonical_key(&p);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        // Read only the HEAD of the file: the title comes from the first
        // non-empty line, but this ran on the welcome screen and slurped every
        // draft WHOLE — one multi-GB file in Autosave (an agent appending to a
        // draft, a pasted dump) exhausted memory and aborted the app before it
        // drew. Bounded like search_walk's scan guard.
        let title = draft_title(&read_head(&path, DRAFT_TITLE_SCAN_BYTES), stem);
        let ts = file_mtime_ms(&path);
        rows.push((ts, json!({ "path": path.to_string_lossy(), "ts": ts, "title": title })));
    }
    rows.sort_by_key(|(ts, _)| std::cmp::Reverse(*ts)); // newest first
    rows.into_iter().map(|(_, v)| v).collect()
}

// The .md drafts currently in Autosave/ (renderer welcome/palette group). Read-only,
// newest first.
#[tauri::command]
fn list_drafts() -> Vec<Value> {
    list_drafts_in(&autosave_dir())
}

// Delete a draft — the ONLY renderer-callable unlink primitive, so HARD-CONTAINED:
// canonicalize, require STRICTLY inside the canonical Autosave dir AND a regular
// file, then unlink (+ clear its recovery snapshot). Anything else is refused with
// an eprintln! and never touched.
#[tauri::command]
fn discard_draft(path: String) -> bool {
    let target = canonical_key(Path::new(&path));
    let autosave = autosave_key();
    let inside = target != autosave && target.starts_with(&autosave);
    if !draft_delete_ok(&autosave, &target, target.is_file()) {
        if inside {
            eprintln!("discard_draft refused: {path} is not a regular file");
        } else {
            eprintln!("discard_draft refused: {path} is not inside the Autosave dir");
        }
        return false;
    }
    match fs::remove_file(&target) {
        Ok(()) => {
            // Remove the notes with the draft (class 2). Otherwise unique_path
            // later hands the freed name to a NEW draft, which silently adopts
            // the discarded directives — resurrected onto unrelated content.
            let (_, notes) = sidecar(&target.to_string_lossy());
            let _ = fs::remove_file(&notes);
            // Clear the recovery snapshot keyed by the CANONICAL bound path
            // snapshot() wrote under (create_draft binds the canonical form) —
            // not the raw arg, which can diverge under a symlinked ~/Documents (N3).
            let _ = fs::remove_file(recovery_path(&target.to_string_lossy()));
            true
        }
        Err(e) => {
            eprintln!("discard_draft failed to delete {path}: {e}");
            false
        }
    }
}

#[cfg(test)]
mod saveflow_tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("plume-saveflow-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    // The Autosave subdir is in scope; its PARENT ~/Documents/Plume is NOT blanket
    // allowed, and a sibling "Autosave-evil" must not be swept in.
    #[test]
    fn autosave_containment_is_subdir_only() {
        let av = Path::new("/Users/x/Documents/Plume/Autosave");
        assert!(is_within_autosave(av, av)); // the dir itself is in scope
        assert!(is_within_autosave(av, &av.join("note.md")));
        assert!(is_within_autosave(av, &av.join("sub/deep.md")));
        // parent Plume dir is NOT in scope (only the Autosave subdir is)
        assert!(!is_within_autosave(av, Path::new("/Users/x/Documents/Plume/other.md")));
        assert!(!is_within_autosave(av, Path::new("/Users/x/Documents/Plume")));
        // sibling prefix trap
        assert!(!is_within_autosave(av, Path::new("/Users/x/Documents/Plume/Autosave-evil/x.md")));
        assert!(!is_within_autosave(av, Path::new("/etc/passwd")));
    }

    // create_draft's core: uniquifies within Autosave and writes the content.
    #[test]
    fn write_new_draft_uniquifies() {
        let av = tmp("uniq").join("Autosave");
        let a = write_new_draft(&av, "My Note!", "alpha").unwrap();
        let b = write_new_draft(&av, "My Note!", "beta").unwrap();
        assert_ne!(a, b, "second draft with the same name must uniquify");
        assert!(a.exists() && b.exists());
        assert_eq!(a.file_name().unwrap().to_string_lossy(), "My-Note.md"); // sanitized stem
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "My-Note-2.md");
        assert_eq!(fs::read_to_string(&a).unwrap(), "alpha");
        assert_eq!(fs::read_to_string(&b).unwrap(), "beta");
        let _ = fs::remove_dir_all(av.parent().unwrap());
    }

    // Graduate = WRITE-THEN-DELETE: the chosen file exists and NOTHING is left in
    // Autosave. A non-draft source or the same-file case is never deleted.
    #[test]
    fn graduate_write_then_delete_leaves_autosave_empty() {
        let root = tmp("grad");
        let av = root.join("Autosave");
        let draft = write_new_draft(&av, "draft", "old-tick").unwrap();
        // av now exists; canonicalize for containment (prod passes autosave_key(),
        // already canonical — macOS temp_dir resolves /var -> /private/var).
        let avk = canonical_key(&av);
        let chosen = root.join("final.md");
        assert!(graduate_should_delete_source(&avk, &draft, &chosen));
        assert!(!graduate_should_delete_source(&avk, &draft, &draft), "same file must not self-delete");
        let outside = root.join("outside.md");
        fs::write(&outside, "x").unwrap();
        assert!(!graduate_should_delete_source(&avk, &outside, &chosen), "a non-draft source stays");
        // mirror save_dialog's core: write the CURRENT buffer, then delete the source
        fs::write(&chosen, "current-buffer").unwrap();
        if graduate_should_delete_source(&avk, &draft, &chosen) {
            fs::remove_file(&draft).unwrap();
        }
        assert!(!draft.exists());
        assert!(chosen.exists());
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "current-buffer");
        assert_eq!(fs::read_dir(&av).unwrap().count(), 0, "Autosave left empty after graduation");
        let _ = fs::remove_dir_all(&root);
    }

    // HIGH-2: graduating a draft moved the .md but stranded its annotations in
    // Autosave/.plume/, so reopening the saved file showed zero steer
    // directives — silent loss of user-authored content on a normal ⌘S.
    // Class 2: the sidecar follows the doc on EVERY lifecycle move, not only
    // graduation. A rename that leaves notes behind loses them silently —
    // getAnnotations(new) returns [] and nothing reports an error.
    #[test]
    fn renaming_a_doc_carries_its_annotations_across() {
        let root = tmp("rename-notes");
        let old = root.join("draft-name.md");
        fs::write(&old, "body").unwrap();
        let (od, on) = sidecar(&old.to_string_lossy());
        fs::create_dir_all(&od).unwrap();
        fs::write(&on, r#"[{"quote":"body","note":"keep me"}]"#).unwrap();

        // Mirror rename_file's core: move the doc, then the notes follow.
        let new = root.join("better-name.md");
        fs::rename(&old, &new).unwrap();
        migrate_annotations(&old, &new);

        let (_, nn) = sidecar(&new.to_string_lossy());
        assert!(nn.is_file(), "notes must land beside the renamed doc");
        assert!(fs::read_to_string(&nn).unwrap().contains("keep me"));
        assert!(!on.exists(), "and must not be stranded at the old name");
        let _ = fs::remove_dir_all(&root);
    }

    // Class 2, the delete half: a discarded draft's notes must go with it, or
    // unique_path hands the freed name to a NEW draft that adopts them.
    #[test]
    fn a_discarded_drafts_notes_cannot_resurrect_on_a_later_draft() {
        let root = tmp("discard-notes");
        let av = root.join("Autosave");
        let draft = write_new_draft(&av, "notes-me", "first").unwrap();
        let (sd, sn) = sidecar(&draft.to_string_lossy());
        fs::create_dir_all(&sd).unwrap();
        fs::write(&sn, r#"[{"quote":"first","note":"discarded directive"}]"#).unwrap();

        // Mirror discard_draft's core: remove the .md AND its sidecar.
        fs::remove_file(&draft).unwrap();
        let (_, notes) = sidecar(&draft.to_string_lossy());
        let _ = fs::remove_file(&notes);
        assert!(!sn.exists(), "the discarded draft's notes must not survive it");

        // A later draft reusing the freed name inherits nothing.
        let reused = write_new_draft(&av, "notes-me", "unrelated content").unwrap();
        assert_eq!(reused.file_name(), draft.file_name(), "same slug is reused");
        let (_, rn) = sidecar(&reused.to_string_lossy());
        assert!(!rn.exists(), "a fresh draft must not adopt a discarded draft's directives");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn graduating_a_draft_carries_its_annotations_across() {
        let root = tmp("notes");
        let av = root.join("Autosave");
        let draft = write_new_draft(&av, "with-notes", "body").unwrap();
        let (src_dir, src_notes) = sidecar(&draft.to_string_lossy());
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(&src_notes, r#"[{"quote":"body","note":"tighten this"}]"#).unwrap();

        let chosen = root.join("final.md");
        fs::write(&chosen, "body").unwrap();
        migrate_annotations(&draft, &chosen);

        let (_, dst_notes) = sidecar(&chosen.to_string_lossy());
        assert!(dst_notes.is_file(), "annotations must land beside the saved file");
        assert!(fs::read_to_string(&dst_notes).unwrap().contains("tighten this"));
        assert!(!src_notes.exists(), "and must not be left stranded in Autosave");

        // Never clobber directives that already exist at the destination.
        let other = root.join("other.md");
        let (od, on) = sidecar(&other.to_string_lossy());
        fs::create_dir_all(&od).unwrap();
        fs::write(&on, "KEEP").unwrap();
        let d2 = write_new_draft(&av, "second", "x").unwrap();
        let (sd2, sn2) = sidecar(&d2.to_string_lossy());
        fs::create_dir_all(&sd2).unwrap();
        fs::write(&sn2, "INCOMING").unwrap();
        migrate_annotations(&d2, &other);
        assert_eq!(fs::read_to_string(&on).unwrap(), "KEEP", "existing notes win");

        // A draft with no notes is a no-op, not an error.
        let d3 = write_new_draft(&av, "third", "y").unwrap();
        migrate_annotations(&d3, &root.join("third-final.md"));
        let _ = fs::remove_dir_all(&root);
    }

    // discard_draft's gate refuses a path outside Autosave and a non-regular file;
    // accepts a regular file strictly inside.
    #[test]
    fn draft_delete_gate_refuses_outside_and_nonfile() {
        let av = Path::new("/Users/x/Documents/Plume/Autosave");
        assert!(draft_delete_ok(av, &av.join("d.md"), true));
        assert!(!draft_delete_ok(av, Path::new("/tmp/evil.md"), true), "outside Autosave refused");
        assert!(!draft_delete_ok(av, &av.join("subdir"), false), "non-regular file refused");
        assert!(!draft_delete_ok(av, av, true), "the Autosave dir itself is not a draft");
    }

    // The live command refuses non-contained targets without unlinking anything
    // (HOME-independent: /tmp is never inside ~/Documents/Plume/Autosave, and an
    // in-Autosave path that isn't a regular file is refused too).
    #[test]
    fn discard_draft_refuses_and_never_unlinks_outside() {
        let outside = tmp("disc").join("keep.md");
        fs::write(&outside, "keep me").unwrap();
        assert!(!discard_draft(outside.to_string_lossy().to_string()));
        assert!(outside.exists(), "a path outside Autosave must never be unlinked");
        // inside-but-nonexistent → not a regular file → refused, no side effect
        let ghost = autosave_dir().join(format!("ghost-{}.md", std::process::id()));
        assert!(!discard_draft(ghost.to_string_lossy().to_string()));
        let _ = fs::remove_dir_all(outside.parent().unwrap());
    }

    // N1 + N4: every list_drafts path is CANONICAL (shares the drafts_dir prefix)
    // even when reached through a symlinked entry point — the iCloud ~/Documents
    // symlink case that made drafts silently stop classifying. Also asserts the
    // { path, ts, title } contract shape and title semantics.
    #[test]
    #[cfg(unix)]
    fn list_drafts_canonicalizes_through_symlink() {
        use std::os::unix::fs::symlink;
        let root = tmp("list");
        let real_av = root.join("real").join("Autosave");
        // first-line title (markers stripped) vs empty-file → stem fallback
        write_new_draft(&real_av, "old-stem", "# Live Title\n\nbody").unwrap();
        write_new_draft(&real_av, "just-stem", "").unwrap();
        let canon_av = canonical_key(&real_av);

        // A symlinked view of the same tree (mimics iCloud's ~/Documents symlink).
        let link_root = root.join("link");
        symlink(root.join("real"), &link_root).unwrap();
        let link_av = link_root.join("Autosave");

        for rows in [list_drafts_in(&real_av), list_drafts_in(&link_av)] {
            assert_eq!(rows.len(), 2, "both .md drafts listed");
            for r in &rows {
                let path = PathBuf::from(r["path"].as_str().unwrap());
                assert_eq!(path, canonical_key(&path), "path must be canonical");
                assert!(
                    path.starts_with(&canon_av),
                    "path must share the canonical Autosave prefix regardless of symlink: {path:?}"
                );
                assert!(r["ts"].is_u64(), "contract: ts present");
                assert!(r["title"].is_string(), "contract: title present");
                assert!(r.get("name").is_none() && r.get("modified").is_none(), "old keys gone");
            }
        }

        let titles: Vec<String> = list_drafts_in(&real_av)
            .iter()
            .map(|r| r["title"].as_str().unwrap().to_string())
            .collect();
        assert!(titles.contains(&"Live Title".to_string()), "first-line title wins: {titles:?}");
        assert!(titles.contains(&"just-stem".to_string()), "empty draft falls back to stem: {titles:?}");
        let _ = fs::remove_dir_all(&root);
    }
}

// Rename the current file in place (same folder, new stem), collision-safe and
// never overwriting an existing file. Returns the new absolute path.
#[tauri::command]
fn rename_file(app: AppHandle, window: tauri::WebviewWindow, old_path: String, new_name: String) -> Option<String> {
    // Same containment as write_file: only this window's bound document may be
    // renamed from this window.
    let bound = window_doc_path(&app, window.label())?;
    if canonical_key(Path::new(&old_path)) != canonical_key(Path::new(&bound)) {
        return None;
    }
    let old = PathBuf::from(&old_path);
    let dir = old.parent()?.to_path_buf();
    let ext = old.extension().and_then(|e| e.to_str()).unwrap_or("md").to_string();
    let stem = sanitize_stem(&new_name);
    let candidate = dir.join(format!("{}.{}", stem, ext));
    let new_path = if candidate == old { candidate } else { unique_path(&dir, &stem, &ext) };
    if new_path != old {
        fs::rename(&old, &new_path).ok()?;
        // The sidecar follows the document on EVERY move, not just graduation
        // (class 2). Without this a rename silently loses the user's steer
        // directives: getAnnotations(new) returns [] and the old notes sit
        // orphaned at <old>.notes.json. Same ordering as graduate — the move
        // is confirmed first, then the notes follow it.
        migrate_annotations(&old, &new_path);
    }
    let p = new_path.to_string_lossy().to_string();
    let content = fs::read_to_string(&p).unwrap_or_default();
    set_current(&app, window.label(), &p, &content);
    Some(p)
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    let p = picked.into_path().ok()?;
    // A user-picked folder becomes a scope root (Cluster B) — the sidebar tree
    // and folder search over it are user-established territory.
    app.state::<AppState>().approved_dirs.lock_or_recover().insert(canonical_key(&p));
    Some(p.to_string_lossy().to_string())
}

// Stage the current document for a specific project's agent: drop a JSON record
// in ~/.plume/attachments/<project_key>/ that the plume-mcp `get_attachments`
// tool (and the alert hook) read off disk, filtered to the agent's own project.
// project_key is dashify(project_cwd) — the same key Claude Code uses for its
// ~/.claude/projects/ dirs — so the agent running in that cwd finds its own.
#[tauri::command]
fn push_attachment(app: AppHandle, project_key: String, name: String, content: String) -> Result<String, String> {
    // Sanitize the project key to a single flat path segment — never let it contain
    // path separators or ".." that would escape the attachments directory.
    let cleaned: String = project_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let key = if cleaned.trim_matches('-').is_empty() { "_global".to_string() } else { cleaned };
    let dir = plume_dir().join("attachments").join(&key);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = app.state::<AppState>().win_counter.fetch_add(1, Ordering::SeqCst);
    let safe: String = name.chars().map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c }).collect();
    let rec = json!({ "name": safe, "content": content, "pushedAt": ts });
    fs::write(dir.join(format!("{}-{}.json", ts, n)), rec.to_string()).map_err(|e| e.to_string())?;
    Ok(safe)
}

// Readable label from a dashified project key, e.g. "-Users-me-code-plume" -> "code/plume".
fn project_label(key: &str) -> String {
    let parts: Vec<&str> = key.split('-').filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 => key.to_string(),
        1 => parts[0].to_string(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

// One target per Claude Code project (deduped — routing keys on project), with the
// dashify(cwd) key the agent's MCP server matches, a readable label, and the most
// recent session's title. Sorted most-recently-active first (≈ the thread you're in).
#[tauri::command]
fn list_session_targets() -> Vec<Value> {
    let mut out = vec![];
    for pd in project_dirs(&None) {
        let key = match pd.file_name().and_then(|n| n.to_str()) {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => continue,
        };
        let (mut best, mut best_ts) = (None, 0u64);
        if let Ok(entries) = fs::read_dir(&pd) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    let m = session_meta(&e.path());
                    let ts = m["ts"].as_u64().unwrap_or(0);
                    if ts >= best_ts { best_ts = ts; best = Some(m); }
                }
            }
        }
        if let Some(m) = best {
            out.push(json!({ "key": key, "label": project_label(&key), "title": m["title"], "ts": best_ts }));
        }
    }
    out.sort_by(|a, b| b["ts"].as_u64().cmp(&a["ts"].as_u64()));
    out.truncate(15);
    out
}

// ---- crash-recovery snapshot read ----
// Per-file snapshot path: FNV-1a hash of the absolute path → recovery/<hash>.json.
fn recovery_path(path: &str) -> PathBuf {
    let mut hash: u64 = 1469598103934665603;
    for b in path.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    plume_dir().join("recovery").join(format!("{:x}.json", hash))
}

fn recovery_for(path: &str) -> Option<String> {
    let file = recovery_path(path);
    // Skip an implausibly large snapshot rather than truncating it: this
    // content is what would be RESTORED, so a truncated read would hand back a
    // corrupted document (same reasoning as untitled_recovery).
    if file.metadata().map(|m| m.len() > MAX_RECOVERY_SNAPSHOT_BYTES).unwrap_or(true) {
        return None;
    }
    let snap: Value = serde_json::from_str(&fs::read_to_string(&file).ok()?).ok()?;
    let snap_content = snap["content"].as_str()?.to_string();
    if Path::new(path).metadata().map(|m| m.len() > MAX_RECOVERY_SNAPSHOT_BYTES).unwrap_or(true) {
        return None;
    }
    let disk = fs::read_to_string(path).ok()?;
    // Only surface if the snapshot differs from disk (best-effort; ts compare omitted).
    if snap_content != disk { Some(snap_content) } else { None }
}

// ---- images ----
// The document path THIS window has open (empty/None = untitled). Keying off the
// caller's window — not a global — is what stops a paste in window B from filing
// the image under window A's assets/ folder (#3 misroute).
fn window_doc_path(app: &AppHandle, label: &str) -> Option<String> {
    app.state::<AppState>()
        .docs
        .lock_or_recover()
        .get(label)
        .map(|d| d.path.clone())
        .filter(|p| !p.is_empty())
}

fn assets_rel(app: &AppHandle, label: &str, ext: &str) -> Option<(PathBuf, String)> {
    let cur = window_doc_path(app, label)?;
    let dir = Path::new(&cur).parent()?.join("assets");
    fs::create_dir_all(&dir).ok()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let clean: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let name = format!("image-{}.{}", ts, if clean.is_empty() { "png".into() } else { clean });
    Some((dir.join(&name), format!("assets/{}", name)))
}

#[tauri::command]
fn save_image(app: AppHandle, window: tauri::WebviewWindow, bytes: Vec<u8>, ext: String) -> Option<String> {
    let (path, rel) = assets_rel(&app, window.label(), &ext)?;
    fs::write(path, bytes).ok()?;
    Some(rel)
}

#[tauri::command]
async fn pick_image(app: AppHandle, window: tauri::WebviewWindow) -> Value {
    if window_doc_path(&app, window.label()).is_none() {
        return json!({ "error": "unsaved" });
    }
    let picked = app
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff"])
        .blocking_pick_file();
    let src = match picked.and_then(|p| p.into_path().ok()) {
        Some(p) => p,
        None => return Value::Null,
    };
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    match assets_rel(&app, window.label(), ext) {
        Some((dest, rel)) if fs::copy(&src, &dest).is_ok() => json!({ "rel": rel }),
        _ => Value::Null,
    }
}

// ---- link preview unfurl ----
// Cluster C (review #3): every byte-offset slice on RESPONSE-derived text must
// be char-boundary safe. The old code computed offsets on `to_lowercase()`d
// copies and applied them to the originals — Unicode case-mapping can change
// byte lengths ('İ' 2B → "i̇" 3B, 'K' 3B → 'k' 1B), so a crafted page produced
// mid-codepoint slices → panic. Under panic=abort that killed the whole app
// (all unsaved buffers) just by opening a document with a hostile URL.

// Largest index ≤ i that sits on a char boundary of s (clamped to s.len()).
fn floor_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// Case-insensitive search that returns an offset into the ORIGINAL string.
//
// Offsets from a `to_lowercase()` copy must NEVER be applied to the original.
// The first cut of this fix bailed out when the two differed in TOTAL length,
// which is not sufficient: an expansion and a contraction cancel. In
// "İİ<title>Hello</title>K" the copy is the same total length, yet `<title>`
// sits 2 bytes later in it — so the old code sliced from the wrong place and
// returned "llo</" as the page title. (It also threw away the preview for any
// page merely CONTAINING such a character.) Searching the original directly
// removes the whole class: the returned index is always a real boundary of
// `haystack`, whatever the case-mapping does.
//
// `needle_lower` must already be lowercase. Comparison flattens each side's
// full Unicode lowercase mapping, so multi-char expansions match correctly.
fn find_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    if needle_lower.is_empty() {
        return None;
    }
    for (i, _) in haystack.char_indices() {
        let mut hs = haystack[i..].chars().flat_map(char::to_lowercase);
        let mut matched = true;
        for nc in needle_lower.chars() {
            if hs.next() != Some(nc) {
                matched = false;
                break;
            }
        }
        if matched {
            return Some(i);
        }
    }
    None
}

// Panic-proof slice: both ends clamped to char boundaries, start ≤ end.
fn slice_clamped(s: &str, start: usize, end: usize) -> &str {
    let e = floor_boundary(s, end);
    let st = floor_boundary(s, start.min(e));
    &s[st..e]
}

// Case-insensitive `contains`, used only for presence checks (no offsets).
fn contains_ci(haystack: &str, needle_lower: &str) -> bool {
    find_ci(haystack, needle_lower).is_some()
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    // Search the ORIGINAL tag: the returned index is a real boundary of `tag`,
    // so no case-mapping length change can misalign the slice.
    let key = format!("{}=", attr.to_lowercase());
    let pos = find_ci(tag, &key)? + key.len();
    let rest = slice_clamped(tag, pos, tag.len());
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)? + 1;
        Some(slice_clamped(rest, 1, end).to_string())
    } else {
        None
    }
}

fn extract_meta(html: &str, prop: &str) -> Option<String> {
    let p = prop.to_lowercase();
    let mut i = 0;
    // All offsets below index the ORIGINAL html (see find_ci).
    while let Some(rel) = html.get(i..).and_then(|s| find_ci(s, "<meta")) {
        let start = i + rel;
        let end = html
            .get(start..)
            .and_then(|s| s.find('>'))
            .map(|e| start + e + 1)
            .unwrap_or(html.len());
        let tag = slice_clamped(html, start, end);
        let hit = ["property", "name"].iter().any(|k| {
            contains_ci(tag, &format!("{}=\"{}\"", k, p)) || contains_ci(tag, &format!("{}='{}'", k, p))
        });
        if hit {
            if let Some(c) = extract_attr(tag, "content") {
                return Some(c);
            }
        }
        if end <= start {
            break; // defensive: never spin on a zero-width step
        }
        i = end;
    }
    None
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap_or(url)
        .trim_start_matches("www.")
        .to_string()
}

// Link-preview fetch UA — advertise the host OS so sites that vary markup by
// platform behave the same as a real browser on that machine.
#[cfg(target_os = "macos")]
const PREVIEW_UA: &str = "Mozilla/5.0 (Macintosh) Plume/1.0";
#[cfg(target_os = "windows")]
const PREVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Plume/1.0";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const PREVIEW_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) Plume/1.0";

// SSRF guard: reject any address that isn't publicly routable so a document/agent
// can't make the app fetch cloud metadata (169.254.169.254), localhost admin ports,
// or intranet hosts.
fn ip_is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local() // 169.254.0.0/16, incl. the metadata IP
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)) // 100.64.0.0/10 CGNAT
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4() {
                return ip_is_public(&IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (seg0 & 0xfe00) == 0xfc00  // fc00::/7 unique-local
                || (seg0 & 0xffc0) == 0xfe80) // fe80::/10 link-local
        }
    }
}

// Parse host:port from an http(s) URL without pulling a URL crate.
fn host_port(url: &str) -> Option<(String, u16)> {
    let https = url.starts_with("https://");
    let after = url.split_once("://")?.1;
    let authority = after.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?; // strip any userinfo
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.parse().ok()?)
        }
        _ => (authority.to_string(), if https { 443 } else { 80 }),
    };
    Some((host.trim_matches(|c| c == '[' || c == ']').to_string(), port))
}

// Resolve a URL's host ONCE and return the vetted addresses, or None if the URL
// isn't http(s) or ANY record is non-public.
//
// Cluster D (review #6, DNS rebinding): the old shape was a boolean check
// followed by a separate `agent.get(url)`, so ureq re-resolved the hostname at
// connect time — a second lookup the guard never saw. An attacker controlling
// the DNS answer (short TTL, round-robin) returns a public address for the
// check and 127.0.0.1 or 169.254.169.254 for the connect: the classic
// check-then-connect rebinding window. Returning the vetted addresses lets the
// caller connect to an address that was actually inspected.
fn resolve_public_addrs(url: &str) -> Option<Vec<std::net::SocketAddr>> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    let (host, port) = host_port(url)?;
    let addrs: Vec<std::net::SocketAddr> = (host.as_str(), port).to_socket_addrs().ok()?.collect();
    if addrs.is_empty() {
        return None;
    }
    // Every record must be public: a host that answers with one public and one
    // private address fails the whole URL rather than racing which one is used.
    if addrs.iter().any(|a| !ip_is_public(&a.ip())) {
        return None;
    }
    Some(addrs)
}

// (The former `url_is_safe` boolean is gone: a check that doesn't hand back the
// addresses it vetted invites exactly the re-resolve gap this cluster closes.
// Callers take resolve_public_addrs and connect to what it returned.)

fn fetch_preview(url: &str) -> Value {
    // Resolve ONCE and keep the vetted addresses (Cluster D / review #6).
    let vetted = match resolve_public_addrs(url) {
        Some(a) => a,
        None => return Value::Null,
    };
    // redirects(0): never follow a redirect — a public URL that 30x-redirects to an
    // internal host is the classic SSRF-via-redirect bypass. No follow, no bypass.
    //
    // The pinned resolver closes the *other* half: without it ureq performs its
    // own DNS lookup at connect time, which the guard above never inspected, so
    // a short-TTL / round-robin answer could hand back 127.0.0.1 or
    // 169.254.169.254 for the connection (DNS rebinding). Every connection this
    // agent makes now goes to an address that was actually vetted; anything
    // else — including a host we didn't resolve — is refused rather than
    // silently falling back to the system resolver.
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .redirects(0)
        .resolver(move |_netloc: &str| Ok(vetted.clone()))
        .build();
    let resp = match agent
        .get(url)
        .set("User-Agent", PREVIEW_UA)
        .call()
    {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    let final_url = resp.get_url().to_string();
    let host = host_of(&final_url);
    let ct = resp.content_type().to_string();
    if ct.starts_with("image/") {
        return json!({ "isImage": true, "image": final_url, "title": host, "site": host });
    }
    if !ct.contains("html") {
        return json!({ "title": host, "description": "", "image": "", "site": host });
    }
    let body = resp.into_string().unwrap_or_default();
    // Truncate on a char boundary — a multibyte char straddling the 600k mark
    // must not panic the slice (Cluster C).
    let body = slice_clamped(&body, 0, 600_000);
    let title = extract_meta(body, "og:title")
        .or_else(|| {
            // Offsets index the ORIGINAL body — see find_ci for why a
            // lowercased copy cannot be used here.
            let s = find_ci(body, "<title")?;
            let s = body.get(s..)?.find('>').map(|e| s + e + 1)?;
            let e = find_ci(body.get(s..)?, "</title>").map(|e| s + e)?;
            Some(slice_clamped(body, s, e).trim().to_string())
        })
        .unwrap_or_else(|| host.clone());
    let mut image = extract_meta(body, "og:image").or_else(|| extract_meta(body, "twitter:image")).unwrap_or_default();
    if !image.is_empty() && !image.starts_with("http") {
        if let Some(base) = final_url.split('/').take(3).collect::<Vec<_>>().get(..3).map(|s| s.join("/")) {
            image = format!("{}/{}", base.trim_end_matches('/'), image.trim_start_matches('/'));
        }
    }
    json!({
        "title": title,
        "description": extract_meta(body, "og:description").or_else(|| extract_meta(body, "description")).unwrap_or_default(),
        "image": image,
        "site": extract_meta(body, "og:site_name").unwrap_or(host),
    })
}

#[tauri::command]
async fn link_preview(url: String) -> Value {
    if !url.starts_with("http") {
        return Value::Null;
    }
    tauri::async_runtime::spawn_blocking(move || fetch_preview(&url))
        .await
        .unwrap_or(Value::Null)
}

// Pure link-resolution policy (unit-tested): an in-document relative link may
// only reach a file inside the SAME directory subtree as the document, and
// never credential material.
//
// SECURITY (Codex P1 on cluster B): the previous version passed `href`
// straight to Path::join, which REPLACES the base when the href is absolute
// ("/Users/me/.ssh/id_rsa") and happily walks "../../.ssh/id_rsa" — the
// home-directory check then passed, because credentials live under home, and
// the resolved target got permanently approved for a follow-up read. An
// absolute or escaping href is not a document link; it is a request to leave
// the document's territory, and is refused.
fn link_target_allowed(base_dir_canon: &Path, resolved: &Path) -> bool {
    if is_sensitive_path(resolved) {
        return false;
    }
    base_dir_canon.as_os_str().len() > 1 && resolved.starts_with(base_dir_canon)
}

fn href_is_relative(href: &str) -> bool {
    let h = href.trim();
    !(h.is_empty()
        || Path::new(h).is_absolute()
        || h.starts_with('/')
        || h.starts_with('\\')
        || h.contains("://")
        // Windows drive-relative ("C:foo") / UNC forms.
        || h.as_bytes().get(1) == Some(&b':'))
}

#[tauri::command]
fn resolve_link(app: AppHandle, href: String, base: Option<String>) -> Option<String> {
    let base = base?;
    // Cluster B: links only resolve FROM a doc that is itself in scope.
    if !fs_scope_allows(&app, &canonical_key(Path::new(&base))) {
        return None;
    }
    if !href_is_relative(&href) {
        return None;
    }
    let dir = Path::new(&base).parent()?;
    let dir_canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let target = dir.join(&href);
    for cand in [
        target.clone(),
        target.with_extension("md"),
        target.with_extension("markdown"),
    ] {
        if cand.is_file() {
            // Resolve symlinks/.. BEFORE deciding: the target must still live
            // inside the document's own directory subtree.
            let resolved = canonical_key(&cand);
            if !link_target_allowed(&dir_canon, &resolved) {
                return None;
            }
            // Safe to approve: it is inside territory the open document
            // already establishes, so this widens nothing.
            approve_file(&app, &cand, false);
            return Some(cand.to_string_lossy().to_string());
        }
    }
    None
}

// ---- folder tree + search ----
const IGNORE_DIRS: [&str; 9] = [
    "node_modules", ".git", "dist", "release", ".cache", "__pycache__", ".next", ".venv", "assets",
];
const TEXT_EXT: [&str; 30] = [
    "md", "markdown", "mdown", "mkd", "mdx", "text", "txt", "json", "jsonc", "jsonl", "ndjson",
    "yaml", "yml", "toml", "env", "ini", "diff", "patch", "log", "csv", "tsv", "mmd", "xml", "sh",
    "bash", "zsh", "js", "ts", "py", "rs",
];

fn walk(dir: &Path, depth: i32) -> Vec<Value> {
    let mut out = vec![];
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let mut items: Vec<_> = entries.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for e in items {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = e.path();
        if full.is_dir() {
            let children = if depth > 0 { walk(&full, depth - 1) } else { vec![] };
            out.push(json!({ "name": name, "path": full.to_string_lossy(), "type": "dir", "children": children }));
        } else {
            out.push(json!({ "name": name, "path": full.to_string_lossy(), "type": "file" }));
        }
    }
    out.sort_by(|a, b| (b["type"] == "dir").cmp(&(a["type"] == "dir")));
    out
}

#[tauri::command]
fn list_dir(app: AppHandle, dir: String, depth: Option<i32>) -> Vec<Value> {
    // Cluster B: the sidebar tree may only walk user-established territory
    // (an open doc's folder or a picked folder). Fail soft — empty tree.
    let target = canonical_key(Path::new(&dir));
    if !fs_scope_allows(&app, &target) {
        return vec![];
    }
    walk(&target, depth.unwrap_or(3)) // walk what we gated (class 1)
}

fn search_walk(dir: &Path, q: &str, results: &mut Vec<Value>, scanned: &mut u32, depth: i32) {
    if depth < 0 || results.len() >= 200 || *scanned > 2000 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = e.path();
        if full.is_dir() {
            search_walk(&full, q, results, scanned, depth - 1);
            continue;
        }
        let ext = full.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !ext.is_empty() && !TEXT_EXT.contains(&ext) {
            continue;
        }
        if full.metadata().map(|m| m.len() > 1_048_576).unwrap_or(true) {
            continue;
        }
        *scanned += 1;
        if let Ok(text) = fs::read_to_string(&full) {
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(q) {
                    results.push(json!({
                        "path": full.to_string_lossy(), "name": name,
                        "line": i + 1, "text": line.trim().chars().take(200).collect::<String>()
                    }));
                    if results.len() >= 200 {
                        return;
                    }
                }
            }
        }
    }
}

#[tauri::command]
fn search_files(app: AppHandle, dir: String, query: String) -> Vec<Value> {
    if query.len() < 2 {
        return vec![];
    }
    // Cluster B: same territory rule as list_dir — no scanning outside it.
    let target = canonical_key(Path::new(&dir));
    if !fs_scope_allows(&app, &target) {
        return vec![];
    }
    let mut results = vec![];
    let mut scanned = 0;
    search_walk(&target, &query.to_lowercase(), &mut results, &mut scanned, 4); // class 1
    results
}

// ---- annotations sidecar ----
fn sidecar(path: &str) -> (PathBuf, PathBuf) {
    let p = Path::new(path);
    let dir = p.parent().unwrap_or(Path::new(".")).join(".plume");
    // Never unwrap: a path with no filename (e.g. "/") must not panic-abort the process.
    let stem = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled".to_string());
    let file = dir.join(format!("{}.notes.json", stem));
    (dir, file)
}

#[tauri::command]
fn load_annotations(app: AppHandle, path: Option<String>) -> Value {
    let p = match path {
        Some(p) => p,
        None => return json!([]),
    };
    // Cluster B: read scope = write scope, matching the socket's getAnnotations.
    let target = canonical_key(Path::new(&p));
    if !fs_scope_allows(&app, &target) {
        return json!([]);
    }
    let (_, file) = sidecar(&target.to_string_lossy()); // class 1
    // Bounded: the sidecar sits next to a user's document and can be written by
    // an agent, so it gets the same ceiling as every other untrusted read.
    if file.metadata().map(|m| m.len() > MAX_ANNOTATIONS_BYTES).unwrap_or(true) {
        return json!([]);
    }
    fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!([]))
}

#[tauri::command]
fn save_annotations(app: AppHandle, path: Option<String>, annotations: Value) -> bool {
    let p = match path {
        Some(p) => p,
        None => return false,
    };
    // Cluster B: the .plume/<file>.notes.json sidecar write stays inside the
    // territory of the doc it annotates.
    let target = canonical_key(Path::new(&p));
    if !fs_scope_allows(&app, &target) {
        return false;
    }
    let (dir, file) = sidecar(&target.to_string_lossy()); // class 1
    if annotations.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        let _ = fs::remove_file(&file);
        return true;
    }
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    fs::write(&file, serde_json::to_string_pretty(&annotations).unwrap_or_default()).is_ok()
}

// ---- crash-recovery snapshot ----
// Untitled (never-saved) buffers snapshot to recovery/untitled-<label>.json (#4).
// Labels restart each launch, so surfacing recovery scans the whole set and offers
// the newest — see untitled_recovery.
fn untitled_recovery_dir() -> PathBuf {
    plume_dir().join("recovery")
}

// Generous OOM backstop, not a policy limit: far above any document a person
// edits, so no realistic recovery is lost, while a runaway snapshot can't
// abort the app during startup recovery.
const MAX_RECOVERY_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

fn untitled_recovery_file(label: &str) -> PathBuf {
    let clean: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    untitled_recovery_dir().join(format!("untitled-{}.json", clean))
}

fn clear_untitled_recovery(label: &str) {
    let _ = fs::remove_file(untitled_recovery_file(label));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Pinned in setup(). Snapshots written before this instant are crash leftovers
// from a PREVIOUS run; anything newer belongs to a live untitled window in THIS
// session and must never be offered to another window as "recovery".
static LAUNCHED_AT_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

fn launched_at_ms() -> u64 {
    *LAUNCHED_AT_MS.get_or_init(now_ms)
}

#[tauri::command]
fn snapshot(app: AppHandle, window: tauri::WebviewWindow, content: String) {
    let label = window.label();
    if let Some(path) = window_doc_path(&app, label) {
        let file = recovery_path(&path);
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, json!({ "filePath": path, "content": content }).to_string());
    } else if content.trim().is_empty() {
        // Nothing worth recovering — don't leave a stale untitled snapshot behind.
        clear_untitled_recovery(label);
    } else {
        let file = untitled_recovery_file(label);
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, json!({ "content": content }).to_string());
    }
}

// Discard the crash-recovery snapshot (banner "Discard", or a Don't-Save close
// resolution). Cluster A: `path` is explicit when the discarded doc is a TAB
// that isn't this window's binding; no path falls back to the binding (or the
// untitled slot). An explicit discard must never resurrect on reopen.
#[tauri::command]
fn discard_recovery(app: AppHandle, window: tauri::WebviewWindow, path: Option<String>) {
    match path.filter(|p| !p.trim().is_empty()).or_else(|| window_doc_path(&app, window.label())) {
        Some(p) => { let _ = fs::remove_file(recovery_path(&p)); }
        None => clear_untitled_recovery(window.label()),
    }
}

// Newest untitled crash snapshot, if any — the renderer calls this when a blank
// window opens and offers a restore banner. Non-destructive; the renderer clears
// it via discard_untitled_recovery(key) after restoring or dismissing.
#[tauri::command]
fn untitled_recovery() -> Option<Value> {
    let dir = untitled_recovery_dir();
    let mut best: Option<(u64, String, String)> = None; // (mtime, key, content)
    for e in fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("untitled-") && name.ends_with(".json")) {
            continue;
        }
        let p = e.path();
        // Same unbounded-read class as list_drafts_in, but the fix differs:
        // this content is the document to be RESTORED, so truncating it would
        // silently hand back a corrupted buffer. Skip an implausibly large
        // snapshot instead — losing one recovery beats aborting the process
        // (and every other window's unsaved work) on the welcome screen.
        if p.metadata().map(|m| m.len() > MAX_RECOVERY_SNAPSHOT_BYTES).unwrap_or(true) {
            eprintln!("untitled_recovery: skipping oversized snapshot {}", p.display());
            continue;
        }
        let Some(content) = fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["content"].as_str().map(|c| c.to_string()))
        else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        let ts = file_mtime_ms(&p);
        // Only pre-launch snapshots are recovery; newer ones belong to a live
        // untitled window in this session (offering those would cross-talk).
        if ts >= launched_at_ms() {
            continue;
        }
        if best.as_ref().map(|(t, _, _)| ts > *t).unwrap_or(true) {
            best = Some((ts, name, content));
        }
    }
    best.map(|(_, key, content)| json!({ "key": key, "content": content }))
}

// Remove one untitled snapshot by the key untitled_recovery returned. The key is
// re-derived through the same sanitizer + fixed prefix/suffix so a caller can
// never turn it into a path traversal.
#[tauri::command]
fn discard_untitled_recovery(key: String) {
    let stem = key
        .strip_prefix("untitled-")
        .and_then(|s| s.strip_suffix(".json"))
        .unwrap_or(&key);
    clear_untitled_recovery(stem);
}

// Renderer-confirmed close (its Save/Don't-Save/Cancel flow fully resolved):
// clear the pending-close marker, clear this window's untitled crash slot as a
// backstop (per-tab path-backed snapshots were cleared by the renderer via
// discard_recovery as each tab resolved), then destroy. destroy() skips
// CloseRequested, so this can't re-enter the prompt loop.
#[tauri::command]
fn close_window_now(app: AppHandle, window: tauri::WebviewWindow) {
    app.state::<AppState>().pending_close.lock_or_recover().remove(window.label());
    clear_untitled_recovery(window.label());
    let _ = window.destroy();
}

// Bridge auto-ACK of close-requested receipt (fires in ms when the webview is
// alive). After the ack the native side waits INDEFINITELY for the user's
// confirm/cancel — the deadline only guards against a dead renderer.
#[tauri::command]
fn close_prompt_ack(window: tauri::WebviewWindow, state: tauri::State<AppState>) {
    if let Some(m) = state.pending_close.lock_or_recover().get_mut(window.label()) {
        m.1 = true;
    }
}

// The renderer's prompt flow aborted (any Cancel, failed Save-As, Escape):
// clear the pending marker so the next close re-prompts cleanly, and abort any
// in-flight ⌘Q — Cancel in one window stops the whole quit (macOS convention).
#[tauri::command]
fn cancel_close(window: tauri::WebviewWindow, state: tauri::State<AppState>) {
    state.pending_close.lock_or_recover().remove(window.label());
    state.quitting.store(false, Ordering::SeqCst);
}

// ⌘Q / File▸Exit: fan the standard per-window close flow out to every doc
// window (each hits CloseRequested → always-prevent → close-requested; clean
// windows auto-confirm instantly on the renderer side). The predefined Quit
// menu item calls `NSApp terminate:` directly and never reaches ExitRequested
// (verified against muda/tao), so quit MUST be a custom item routed here.
fn request_quit(app: &AppHandle) {
    let st = app.state::<AppState>();
    st.quitting.store(true, Ordering::SeqCst);
    let wins: Vec<_> = app
        .webview_windows()
        .into_values()
        .filter(|w| !w.label().starts_with("pdf"))
        .collect();
    if wins.is_empty() {
        app.exit(0); // nothing to prompt — quit immediately
        return;
    }
    for w in wins {
        let _ = w.close();
    }
    // When the last window is destroyed with `quitting` set, the runtime's
    // ExitRequested{code:None} is allowed through and the process exits.
}

// ---- Claude Code sessions + context ----
fn claude_projects() -> PathBuf {
    home_dir().join(".claude/projects")
}
fn dashify(dir: &str) -> String {
    dir.chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect()
}

fn project_dirs(dir: &Option<String>) -> Vec<PathBuf> {
    if let Some(d) = dir {
        let pd = claude_projects().join(dashify(d));
        if pd.is_dir() {
            return vec![pd];
        }
    }
    fs::read_dir(claude_projects())
        .map(|e| e.flatten().map(|x| x.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

fn session_meta(file: &Path) -> Value {
    let ts = file
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut title = "(empty session)".to_string();
    if let Ok(mut f) = fs::File::open(file) {
        let mut buf = vec![0u8; 32768];
        if let Ok(n) = f.read(&mut buf) {
            let head = String::from_utf8_lossy(&buf[..n]);
            for line in head.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(o) = serde_json::from_str::<Value>(line) {
                    if o["type"] == "user" {
                        let c = &o["message"]["content"];
                        let t = if c.is_string() {
                            c.as_str().unwrap_or("").to_string()
                        } else if let Some(arr) = c.as_array() {
                            arr.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ")
                        } else {
                            String::new()
                        };
                        let t = t.trim();
                        if !t.is_empty() && !t.starts_with('<') && !t.starts_with("Caveat") {
                            title = t.chars().take(90).collect();
                            break;
                        }
                    }
                }
            }
        }
    }
    json!({ "path": file.to_string_lossy(), "title": title, "ts": ts, "agent": "claude" })
}

fn file_mtime_ms(p: &Path) -> u64 {
    p.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Codex CLI sessions: ~/.codex/sessions/**/rollout-*.jsonl. The session_meta first
// line carries cwd + id; titles come from session_index.jsonl (id -> thread_name).
fn walk_rollouts(d: &Path, depth: u32, acc: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    if let Ok(entries) = fs::read_dir(d) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_rollouts(&p, depth + 1, acc);
            } else if let Some(n) = p.file_name().and_then(|x| x.to_str()) {
                if n.starts_with("rollout-") && n.ends_with(".jsonl") {
                    acc.push(p);
                }
            }
        }
    }
}
fn codex_index() -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    // Bounded: this index is appended to by another tool and has no size
    // ceiling of our own.
    let txt = read_head(&home_dir().join(".codex/session_index.jsonl"), AGENT_INDEX_SCAN_BYTES);
    {
        for line in txt.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(o) = serde_json::from_str::<Value>(line) {
                if let (Some(id), Some(name)) = (o["id"].as_str(), o["thread_name"].as_str()) {
                    map.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    map
}
fn codex_sessions_for(dir: &str) -> Vec<Value> {
    let mut files = vec![];
    walk_rollouts(&home_dir().join(".codex/sessions"), 0, &mut files);
    // _cached_key, not _key: the key is a stat(), and sort_by_key may call it
    // many times per element — O(n log n) syscalls over up to 250 files on the
    // welcome path. Cached computes it exactly once each.
    files.sort_by_cached_key(|f| std::cmp::Reverse(file_mtime_ms(f))); // newest first
    files.truncate(250);
    let idx = codex_index();
    let mut out = vec![];
    for f in files {
        let mut head = [0u8; 8192];
        let n = fs::File::open(&f).and_then(|mut fh| fh.read(&mut head)).unwrap_or(0);
        if n == 0 {
            continue;
        }
        let first = String::from_utf8_lossy(&head[..n]);
        let line = match first.lines().find(|l| !l.trim().is_empty()) {
            Some(l) => l,
            None => continue,
        };
        let o = match serde_json::from_str::<Value>(line) {
            Ok(o) => o,
            Err(_) => continue,
        };
        if o["type"] != "session_meta" {
            continue;
        }
        let cwd = o["payload"]["cwd"].as_str().unwrap_or("");
        if cwd != dir && !cwd.starts_with(&format!("{}/", dir)) {
            continue;
        }
        let title = o["payload"]["id"]
            .as_str()
            .and_then(|id| idx.get(id))
            .map(|s| s.chars().take(90).collect::<String>())
            .unwrap_or_else(|| "(Codex session)".to_string());
        out.push(json!({ "path": f.to_string_lossy(), "title": title, "ts": file_mtime_ms(&f), "agent": "codex" }));
    }
    out
}

// Gemini CLI sessions: ~/.gemini/tmp/<project-basename>/chats/session-*.json
fn gemini_sessions_for(dir: &str) -> Vec<Value> {
    let base = Path::new(dir).file_name().and_then(|x| x.to_str()).unwrap_or("");
    let chats = home_dir().join(".gemini/tmp").join(base).join("chats");
    let mut out = vec![];
    if let Ok(entries) = fs::read_dir(&chats) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("");
            if !(name.starts_with("session-") && name.ends_with(".json")) {
                continue;
            }
            let mut title = "(Gemini session)".to_string();
            // Bounded head, like session_meta (32 KiB) and codex_sessions_for
            // (8 KiB): these files are agent-written and unbounded, and this
            // runs on the welcome path — reading them whole is the same OOM
            // class already fixed for draft titles.
            let txt = read_head(&p, AGENT_SESSION_SCAN_BYTES);
            if !txt.is_empty() {
                if let Ok(o) = serde_json::from_str::<Value>(&txt) {
                    if let Some(arr) = o["messages"].as_array() {
                        if let Some(u) = arr.iter().find(|m| m["type"] == "user") {
                            let t = if let Some(c) = u["content"].as_array() {
                                c.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ")
                            } else {
                                u["content"].as_str().unwrap_or("").to_string()
                            };
                            let t = t.trim();
                            if !t.is_empty() && !t.starts_with('<') {
                                title = t.chars().take(90).collect();
                            }
                        }
                    }
                }
            }
            out.push(json!({ "path": p.to_string_lossy(), "title": title, "ts": file_mtime_ms(&p), "agent": "gemini" }));
        }
    }
    out
}

#[tauri::command]
fn list_sessions(dir: Option<String>) -> Vec<Value> {
    let mut out = vec![];
    for pd in project_dirs(&dir) {
        if let Ok(entries) = fs::read_dir(&pd) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    out.push(session_meta(&e.path()));
                }
            }
        }
    }
    if let Some(d) = &dir {
        out.extend(codex_sessions_for(d));
        out.extend(gemini_sessions_for(d));
    }
    out.sort_by(|a, b| b["ts"].as_u64().cmp(&a["ts"].as_u64()));
    out.truncate(100);
    out
}

#[tauri::command]
fn search_sessions(query: String, dir: Option<String>) -> Vec<Value> {
    if query.len() < 2 {
        return vec![];
    }
    let q = query.to_lowercase();
    // Candidate transcripts across all three agents, each carrying its agent + meta.
    let mut cands: Vec<Value> = vec![];
    for pd in project_dirs(&dir) {
        if let Ok(entries) = fs::read_dir(&pd) {
            for e in entries.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    cands.push(json!({ "path": e.path().to_string_lossy(), "agent": "claude" }));
                }
            }
        }
    }
    if let Some(d) = &dir {
        cands.extend(codex_sessions_for(d));
        cands.extend(gemini_sessions_for(d));
    }
    let mut results = vec![];
    // A scan BUDGET, not an index: it bounds how many files we actually open,
    // and the loop can `continue` past candidates without spending any. An
    // enumerate() index would count those too and cut the search short.
    let mut scanned = 0;
    // One 4 MiB scratch buffer reused across candidates — not a fresh alloc per file
    // (which churned ~2 GB of transient allocation on a full 500-candidate scan).
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    #[allow(clippy::explicit_counter_loop)]
    for c in cands {
        if results.len() >= 40 || scanned > 500 {
            break;
        }
        scanned += 1;
        let path = match c["path"].as_str() {
            Some(p) => p.to_string(),
            None => continue,
        };
        if let Ok(mut f) = fs::File::open(&path) {
            if let Ok(n) = f.read(&mut buf) {
                let text = String::from_utf8_lossy(&buf[..n]);
                // Two-stage on purpose: the lowercased copy is only a FAST
                // REJECT (memchr-backed find over up to 4 MiB). Its offset is
                // never used — case-mapping shifts interior positions even when
                // total lengths match, which drifted the snippet off the match.
                // Once a file is known to match, locate the hit in the ORIGINAL.
                if text.to_lowercase().contains(&q) {
                    let idx = find_ci(&text, &q).unwrap_or(0);
                    let snippet: String = slice_clamped(&text, idx.saturating_sub(40), idx + 90)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ");
                    let mut meta = if c["agent"] == "claude" { session_meta(Path::new(&path)) } else { c.clone() };
                    meta["snippet"] = json!(snippet);
                    results.push(meta);
                }
            }
        }
    }
    results.sort_by(|a, b| b["ts"].as_u64().cmp(&a["ts"].as_u64()));
    results
}

const CONTEXT_FILES: [&str; 6] = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", "README.md", "TODO.md"];

#[tauri::command]
fn list_context(app: AppHandle, dir: Option<String>) -> Vec<Value> {
    let dir = match dir {
        Some(d) => d,
        None => return vec![],
    };
    // Cluster B: context files are probed only inside user territory.
    let target = canonical_key(Path::new(&dir));
    if !fs_scope_allows(&app, &target) {
        return vec![];
    }
    let mut out = vec![];
    for name in CONTEXT_FILES {
        let full = target.join(name); // probe under what we gated (class 1)
        if full.is_file() {
            out.push(json!({ "name": name, "path": full.to_string_lossy() }));
        }
    }
    out
}

// Read a file for inline insertion. Claude Code `.jsonl` transcripts are distilled
// to readable markdown — user/assistant prose only, most-recent kept. Transcripts
// run to hundreds of MB, so we tail-read the last ~6 MB rather than load it all.
// Cluster B: session_read's whole purpose is agent transcripts + workspace
// context files — constrain it to exactly those roots. Anything else (e.g.
// ~/.ssh/…) returns empty, same shape as a missing file.
fn session_read_allowed(app: &AppHandle, target: &Path) -> bool {
    let canon = canonical_key(target);
    // The deny applies inside the transcript roots too — those roots are a
    // read grant for transcripts, not for anything that happens to sit there.
    if is_sensitive_path(&canon) {
        return false;
    }
    for root in [
        claude_projects(),
        home_dir().join(".codex/sessions"),
        home_dir().join(".gemini/tmp"),
    ] {
        if let Ok(r) = root.canonicalize() {
            if canon.starts_with(&r) {
                return true;
            }
        }
    }
    fs_scope_allows(app, &canon)
}

#[tauri::command]
fn session_read(app: AppHandle, path: String) -> String {
    // Class 1: gate and read the same resolved value.
    let path = canonical_key(Path::new(&path)).to_string_lossy().to_string();
    const TAIL: u64 = 6 * 1024 * 1024;
    const CAP: usize = 40000;
    let p = Path::new(&path);
    if !session_read_allowed(&app, p) {
        return String::new();
    }
    let size = match fs::metadata(p) {
        Ok(m) => m.len(),
        Err(_) => return String::new(),
    };
    let raw: String = if size > TAIL {
        let mut f = match fs::File::open(p) {
            Ok(f) => f,
            Err(_) => return String::new(),
        };
        if f.seek(SeekFrom::Start(size - TAIL)).is_err() {
            return String::new();
        }
        let mut buf = vec![0u8; TAIL as usize];
        let n = f.read(&mut buf).unwrap_or(0);
        let mut s = String::from_utf8_lossy(&buf[..n]).into_owned();
        if let Some(idx) = s.find('\n') {
            s = s[idx + 1..].to_string(); // drop the partial first line
        }
        s
    } else {
        match fs::read_to_string(p) {
            Ok(s) => s,
            Err(_) => return String::new(),
        }
    };
    if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
        return raw;
    }
    let mut out: Vec<String> = vec![];
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let o: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let msg = if o.get("message").is_some() { &o["message"] } else { &o };
        let role = msg["role"].as_str().or_else(|| o["type"].as_str()).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let c = &msg["content"];
        let text = if c.is_string() {
            c.as_str().unwrap_or("").to_string()
        } else if let Some(arr) = c.as_array() {
            arr.iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        } else {
            String::new()
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let label = if role == "assistant" { "**Claude:**" } else { "**You:**" };
        out.push(format!("{}\n\n{}", label, text));
    }
    let joined = out.join("\n\n");
    let chars: Vec<char> = joined.chars().collect();
    if chars.len() > CAP {
        let tail: String = chars[chars.len() - CAP..].iter().collect();
        return format!("_…earlier conversation trimmed…_\n\n{}", tail);
    }
    joined
}

// ---- agent round-trip (socket → webview → reply) ----
#[tauri::command]
fn agent_reply(app: AppHandle, id: u64, data: Value) {
    if let Some(tx) = app.state::<AppState>().pending.lock_or_recover().remove(&id) {
        let _ = tx.send(data);
    }
}

fn agent_query(app: &AppHandle, kind: &str) -> Value {
    let state = app.state::<AppState>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel();
    state.pending.lock_or_recover().insert(id, tx);
    let payload = json!({ "id": id, "kind": kind });
    // Target the focused window (correct with multiple windows open).
    match app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
        Some(w) => { let _ = w.emit("agent-request", payload); }
        None => { let _ = app.emit("agent-request", payload); }
    }
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("ok".into(), json!(true));
                return v;
            }
            json!({ "ok": true, "value": v })
        }
        Err(_) => {
            // Reap the abandoned sender — otherwise every renderer timeout leaks
            // a pending-map entry (and its channel) for the life of the process.
            state.pending.lock_or_recover().remove(&id);
            json!({ "ok": false, "error": "renderer timeout" })
        }
    }
}

// ---- write containment (P0-1) ----
// Canonicalize a path for comparison. For a not-yet-existing target, canonicalize
// the parent dir and re-append the file name so a new file inside an allowed dir
// still resolves (and can't be smuggled past the check via `..` or a symlink).
fn canonical_key(p: &Path) -> PathBuf {
    if let Ok(c) = p.canonicalize() {
        return c;
    }
    match (p.parent(), p.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(pc) => pc.join(name),
            Err(_) => p.to_path_buf(),
        },
        _ => p.to_path_buf(),
    }
}

// The files Plume currently has open: the union of every window's document (#5)
// plus any spawned-but-not-yet-loaded window targets. Previously this leaned on a
// global `current` while initial_file deleted the per-window entry, so all but
// the most recently touched window silently fell OUT of the agent write scope.
fn open_files(app: &AppHandle) -> HashSet<PathBuf> {
    let st = app.state::<AppState>();
    let mut set = HashSet::new();
    for d in st.docs.lock_or_recover().values() {
        if !d.path.is_empty() {
            set.insert(canonical_key(Path::new(&d.path)));
        }
    }
    for f in st.window_files.lock_or_recover().values() {
        if !f.is_empty() {
            set.insert(canonical_key(Path::new(f)));
        }
    }
    // Cluster A delta 4: BACKGROUND tabs count as open — the user opened them,
    // so they stay in the agent write scope even while another tab is active.
    //
    // SECURITY (Codex P1 on cluster B): the tab set is RENDERER-SUPPLIED, so it
    // is evidence of what's open, never a grant. Unfiltered, a compromised
    // renderer could set_open_paths(["~/.ssh/anything"]) and — because this set
    // feeds both the renderer read gate AND the socket's write_allowed, both
    // dir-inclusive — grant itself reads of that whole directory and widen the
    // AGENT WRITE scope into it. A tab path therefore counts only if it was
    // INDEPENDENTLY approved by a real user action (dialog pick, delivered
    // open, followed doc link, launch arg). Every legitimate open route
    // approves first, and the tab model is session-only (no cross-launch
    // restore), so genuine background tabs are unaffected.
    {
        let approved_files = st.approved_files.lock_or_recover();
        let approved_dirs = st.approved_dirs.lock_or_recover();
        for tabs in st.open_tabs.lock_or_recover().values() {
            for p in tabs {
                if tab_counts_as_scope(p, &approved_files, &approved_dirs) {
                    set.insert(p.clone());
                }
            }
        }
    }
    set
}

// Pure (unit-tested): may a renderer-registered tab path widen the scope?
// Only when a real user action already approved it — see the security note in
// open_files. Kept separate so the rule is testable without an AppHandle.
fn tab_counts_as_scope(
    tab: &Path,
    approved_files: &HashSet<PathBuf>,
    approved_dirs: &HashSet<PathBuf>,
) -> bool {
    approved_files.contains(tab) || within_any_dir(approved_dirs, tab)
}

// Pure containment decision (unit-tested): a target is in scope iff it is one of the
// open files, or lives inside the directory (or a subdir) of an open file. This is
// territory the USER established by opening something — it does NOT trust any value
// supplied by the caller. The previous design trusted a client `root` field, which a
// raw-socket attacker could forge (root:"/Users/you") to authorize writing anywhere
// under it — the containment bypass fixed here.
fn path_within_open_scope(opens: &HashSet<PathBuf>, target: &Path) -> bool {
    if opens.contains(target) {
        return true;
    }
    for f in opens {
        if let Some(dir) = f.parent() {
            // len > 1 rejects "/" as a scope root.
            if dir.as_os_str().len() > 1 && target.starts_with(dir) {
                return true;
            }
        }
    }
    false
}

// The socket write/annotation-read gate (`writeDocument`, `getAnnotations`).
//
// This used to be scope-only, on the reasoning that the socket is token-gated
// and an agent editing a `.env` the user pointed it at is legitimate work. That
// reasoning was incomplete: it weighed secret DISCLOSURE and missed CODE
// EXECUTION. Scope is directory-inclusive, so opening one file in a repo made
// `<repo>/.git/hooks/pre-commit` writable — arbitrary code on the user's next
// commit — plus `.git/config` (remote URLs, credential helpers) and committed
// keys. An authenticated channel doesn't help when the threat is a compromised
// or confused agent rather than an unauthenticated attacker.
//
// Same shape as the read gate now: the deny wins over territory, EXCEPT for a
// file the user opened explicitly, so deliberately editing your own `.env`
// still works.
fn write_allowed(app: &AppHandle, target: &Path) -> bool {
    let st = app.state::<AppState>();
    let explicitly_opened = st.approved_files.lock_or_recover().contains(target);
    scope_decision(
        target,
        explicitly_opened,
        path_within_open_scope(&open_files(app), target),
        false, // dir grants are a READ affordance; a write still needs scope or an explicit open
    )
}

// Pure: is `target` inside (or equal to) any of the granted directory roots?
// The len > 1 check rejects "/" as a root, same as path_within_open_scope.
fn within_any_dir(dirs: &HashSet<PathBuf>, target: &Path) -> bool {
    dirs.iter().any(|d| d.as_os_str().len() > 1 && target.starts_with(d))
}

// Pure containment policy (unit-tested), split out so the rule can be checked
// without an AppHandle.
//
// Territory alone is NOT sufficient for a sensitive file. Scope is
// dir-inclusive, so opening one document in a repo puts the whole repo in
// scope — which let a compromised renderer read `<repo>/.env`,
// `<repo>/.git/config` (OAuth tokens), or a committed key, defeating this
// module's own deny list through the primary read path. The deny now applies
// to everything EXCEPT a file the user opened explicitly — a path lands in
// approved_files only via File ▸ Open, a launch argument, the token-gated
// socket, or a link inside the document's own directory — so deliberately
// editing your own .env still works, while a renderer-driven read of an
// un-opened secret sitting in an in-scope directory does not.
fn scope_decision(
    target: &Path,
    explicitly_opened: bool,
    in_open_scope: bool,
    in_approved_dir: bool,
) -> bool {
    if explicitly_opened {
        return true;
    }
    if is_sensitive_path(target) {
        return false;
    }
    in_open_scope || in_approved_dir
}

// Cluster B: the single containment gate for renderer-driven FS access.
// `target` must already be canonicalized (canonical_key). Territory = the
// socket's proven open-file scope (bound docs + pending spawns + approved
// registered tabs, dir-inclusive) ∪ files the user explicitly opened ∪ dirs
// the user explicitly picked, minus the sensitive deny (see scope_decision).
fn fs_scope_allows(app: &AppHandle, target: &Path) -> bool {
    let st = app.state::<AppState>();
    // Scoped so the guard is released before open_files() takes it again.
    let explicitly_opened = st.approved_files.lock_or_recover().contains(target);
    if explicitly_opened {
        return true;
    }
    if is_sensitive_path(target) {
        return false; // cheap and decisive — skip the scope walk entirely
    }
    // SAVEFLOW: the canonical Autosave draft home is always in scope so draft
    // reads/writes pass — but ONLY this subdir, never ~/Documents/Plume at large.
    // BELOW the sensitive deny (N2): a sensitive-NAMED file dropped into Autosave
    // by something other than Plume must not become readable through this grant.
    // Zero functional loss — Plume's own drafts are always sanitized .md.
    if is_within_autosave(&autosave_key(), target) {
        return true;
    }
    let in_open_scope = path_within_open_scope(&open_files(app), target);
    let in_approved_dir = {
        let dirs = st.approved_dirs.lock_or_recover();
        within_any_dir(&dirs, target)
    };
    scope_decision(target, false, in_open_scope, in_approved_dir)
}

// Record a file as explicitly opened. That set is a CARVE-OUT from the
// sensitive deny (so you can edit your own .env), which makes every writer of
// it security-relevant: whatever lands here can later be read and written no
// matter what its name is.
//
// `user_picked` is therefore the real question — not which function is calling,
// but whether a HUMAN chose this exact path: a native file dialog, or the
// argument they launched Plume with. A path named by a socket client, a deep
// link, or a document's own markup is not user-picked, and a sensitive one from
// those sources is refused rather than approved. (The socket `open` handler
// refuses sensitive paths outright as well; this is the backstop that keeps a
// future caller from quietly re-opening the same door.)
fn approve_file(app: &AppHandle, path: &Path, user_picked: bool) {
    let key = canonical_key(path);
    if !user_picked && is_sensitive_path(&key) {
        eprintln!("refused to mark {} explicitly-opened: sensitive, and not a user pick", key.display());
        return;
    }
    app.state::<AppState>().approved_files.lock_or_recover().insert(key);
}

// Sensitive-path deny for EXTERNALLY-driven opens (plume:// deep links, Finder
// Opened events, second-instance argv) — mirrors the assetProtocol deny globs
// in tauri.conf.json. Review #2: an unscoped plume://open?path= bypassed this
// list entirely. A user who genuinely wants to view such a file still can via
// File ▸ Open (a fully-trusted, user-driven pick).
fn is_sensitive_path(p: &Path) -> bool {
    // Normalize BOTH separators before matching (Codex P1): a Windows path
    // (C:\Users\x\.ssh\id_rsa) has no '/' at all, so '/'-only matching let it
    // through the hard refusal. A deny-list must fail closed, so this treats
    // '\' as a separator on every platform — on Unix the only cost is that a
    // file literally named with a backslash is judged conservatively.
    let s = p.to_string_lossy().to_lowercase().replace('\\', "/");
    let joined = format!("{}/", s); // so a path ENDING in a guarded dir also hits
    // "/.git/" covers .git/config, which carries OAuth tokens in remote URLs
    // and credential-helper settings. Nothing in the editor needs to read a
    // repo's internals — and a `git commit` launch (Plume as $EDITOR opening
    // .git/COMMIT_EDITMSG) still works, because a launch argument lands in
    // approved_files and the explicit-open exception wins.
    const DIR_MARKS: [&str; 11] = [
        "/.ssh/", "/.aws/", "/.gnupg/", "/.kube/", "/.docker/", "/.config/",
        "/.password-store/", "/secrets/", "/library/keychains/", "/.git-credentials/",
        "/.git/",
    ];
    if DIR_MARKS.iter().any(|d| joined.contains(d)) {
        return true;
    }
    // Take the final segment from the NORMALIZED string, not Path::file_name:
    // on Unix, file_name() of "c:\\users\\x\\.ssh\\id_rsa" is the whole
    // backslash string, which would miss the id_rsa/.env checks below.
    let name = s.rsplit('/').next().unwrap_or_default().to_string();
    const NAMES: [&str; 13] = [
        ".env", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pgpass",
        // DB/registry client configs hold plaintext passwords. The GLOBAL git
        // config earns its place for the same reason .git/hooks does: it can
        // set a credential.helper, i.e. code that runs on the next auth.
        ".my.cnf", ".dockercfg", ".gitconfig",
        // .envrc: direnv, routinely holds AWS/API secrets. .htpasswd: hashes.
        ".envrc", ".htpasswd",
        // Shell/REPL history routinely contains pasted tokens and passwords.
        ".history", ".lesshst",
    ];
    if NAMES.contains(&name.as_str()) || name.starts_with(".env.") {
        return true;
    }
    // Covers .bash_history, .zsh_history, .python_history, .node_repl_history,
    // .psql_history, .mysql_history, … as one rule rather than a stale list.
    if name.starts_with('.') && name.ends_with("_history") {
        return true;
    }
    if ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|k| name.starts_with(k)) {
        return true;
    }
    if name.contains(".keychain") {
        return true;
    }
    // Extension from the normalized final segment, for the same reason.
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    // .p8 = Apple AuthKey; .jks/.keystore = Java keystores.
    ["pem", "key", "p12", "pfx", "ovpn", "p8", "jks", "keystore"].contains(&ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(paths: &[&str]) -> HashSet<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn open_file_and_its_directory_are_in_scope() {
        let s = scope(&["/proj/doc.md"]);
        assert!(path_within_open_scope(&s, Path::new("/proj/doc.md")));
        assert!(path_within_open_scope(&s, Path::new("/proj/other.md")));
        assert!(path_within_open_scope(&s, Path::new("/proj/sub/x.md")));
    }

    #[test]
    fn paths_outside_open_dirs_are_refused() {
        let s = scope(&["/proj/doc.md"]);
        assert!(!path_within_open_scope(&s, Path::new("/Users/you/.ssh/authorized_keys")));
        assert!(!path_within_open_scope(&s, Path::new("/etc/passwd")));
        // component-wise prefix — a sibling directory sharing a name prefix is NOT in scope
        assert!(!path_within_open_scope(&s, Path::new("/proj-evil/x.md")));
        assert!(!path_within_open_scope(&s, Path::new("/proj2/x.md")));
    }

    #[test]
    fn empty_scope_and_root_parent_authorize_nothing() {
        assert!(!path_within_open_scope(&HashSet::new(), Path::new("/anything")));
        // an open file directly at "/" has parent "/", which must not grant blanket access
        let s = scope(&["/x"]);
        assert!(!path_within_open_scope(&s, Path::new("/etc/passwd")));
    }

    #[test]
    fn close_gate_policy_covers_live_dead_and_hung_renderers() {
        // Fresh close → prompt.
        assert_eq!(close_action(None), CloseAction::Emit);
        // Prompt acked and live (user reading the dialog) → swallow duplicate
        // closes; native never destroys on its own after an ack, no matter how
        // long the user deliberates.
        assert_eq!(close_action(Some((Duration::from_millis(10), true))), CloseAction::Swallow);
        assert_eq!(close_action(Some((Duration::from_secs(9), true))), CloseAction::Swallow);
        // Second click within the ack window → swallow (round-trip in flight).
        assert_eq!(close_action(Some((Duration::from_millis(200), false))), CloseAction::Swallow);
        // Un-acked past the deadline (ack timer missed somehow) → re-emit.
        assert_eq!(close_action(Some((Duration::from_secs(2), false))), CloseAction::Emit);
        // Acked but never resolved for a long time (hung after ack) → re-prompt
        // instead of leaving the window permanently unclosable.
        assert_eq!(close_action(Some((CLOSE_REPROMPT_AFTER, true))), CloseAction::Emit);
    }

    // ---- cluster C: hostile-input slicing (review #3 remote DoS, #8 decoder) ----

    // A string whose lowercase form has a DIFFERENT byte length than the
    // original — the exact condition that made lowercase-derived offsets
    // invalid on the original and produced mid-codepoint slices.
    // Written as escapes ON PURPOSE: typing these literally is unreliable —
    // U+212A silently normalizes to ASCII 'K' in some editors/toolchains, which
    // would make the "shrinking" case not shrink and quietly weaken every test
    // that depends on it.
    const CASE_GROWS: &str = "\u{0130}"; // İ — 2 bytes, lowercases to 3 (+1)
    const CASE_SHRINKS: &str = "\u{212A}"; // KELVIN SIGN — 3 bytes, lowercases to 1 (−2)

    #[test]
    fn a_poisoned_lock_recovers_instead_of_cascading() {
        // Under panic = "unwind", a panic while a lock is held poisons it and
        // every later lock().unwrap() panics too — one contained panic would
        // become a permanent failure of that lock. lock_or_recover keeps the
        // app usable with the state as it stood.
        let m: Mutex<Vec<&str>> = Mutex::new(vec!["a"]);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut g = m.lock_or_recover();
            g.push("b");
            panic!("boom while holding the lock");
        }));
        assert!(m.lock().is_err(), "precondition: the mutex is poisoned");
        // The plain path would panic here; ours returns the guard.
        let g = m.lock_or_recover();
        assert_eq!(*g, vec!["a", "b"]); // state as it stood, no data loss
        drop(g);
        assert_eq!(m.lock_or_recover().len(), 2); // still usable afterwards
    }

    #[test]
    fn slice_clamped_never_splits_a_codepoint() {
        let s = "aé漢🎉z"; // 1 + 2 + 3 + 4 + 1 bytes
        for start in 0..=s.len() + 3 {
            for end in 0..=s.len() + 3 {
                let out = slice_clamped(s, start, end);
                assert!(s.contains(out) || out.is_empty());
            }
        }
        assert_eq!(slice_clamped(s, 0, 0), "");
        assert_eq!(slice_clamped(s, 99, 3), ""); // start past end → empty, no panic
        assert_eq!(slice_clamped(s, 0, usize::MAX), s);
        assert_eq!(slice_clamped(s, 1, 2), ""); // both land inside 'é' → empty
    }

    #[test]
    fn extract_meta_is_correct_under_case_mapping_length_changes() {
        // Well-formed input still parses.
        let html = r#"<html><meta property="og:title" content="Hello"></html>"#;
        assert_eq!(extract_meta(html, "og:title").as_deref(), Some("Hello"));
        // Case-INSENSITIVE tag/attribute matching (real pages use <META>).
        assert_eq!(
            extract_meta(r#"<META PROPERTY="og:title" CONTENT="Hi">"#, "og:title").as_deref(),
            Some("Hi")
        );
        // Length-changing chars must not break extraction — the first fix
        // bailed out here and silently lost the preview for such pages.
        for (input, want) in [
            (format!(r#"{CASE_GROWS}<meta property="og:title" content="Hello">"#), "Hello"),
            (format!(r#"{CASE_SHRINKS}<meta property="og:title" content="Hello">"#), "Hello"),
            // Expansion + contraction CANCEL: equal total length, misaligned
            // interior — the exact case that defeated the length guard.
            (
                format!(r#"{CASE_GROWS}{CASE_GROWS}<meta property="og:title" content="Hello">{CASE_SHRINKS}"#),
                "Hello",
            ),
        ] {
            assert_eq!(extract_meta(&input, "og:title").as_deref(), Some(want), "input: {input}");
        }
        // Truncated/garbage tags must not panic or hang.
        for junk in ["<meta", "<meta property=", "<meta property=\"og:title\" content=", "<<<>>>", "<meta><meta><meta"] {
            let _ = extract_meta(junk, "og:title");
        }
    }

    #[test]
    fn title_fallback_survives_the_cancellation_case() {
        // Codex's case: İİ (+1 byte each when lowercased) before the title and
        // KELVIN (−2) after it ⇒ identical TOTAL length, but <title> sits 2
        // bytes later in the lowercased copy. Slicing the original at the
        // copy's offset returned "llo</" as the page title.
        let body = format!("{CASE_GROWS}{CASE_GROWS}<title>Hello</title>{CASE_SHRINKS}");
        // Preconditions that make this a real regression test, not decoration:
        // the copy is the SAME total length (so a length guard passes) yet the
        // interior offset of <title> has drifted.
        assert_eq!(body.to_lowercase().len(), body.len(), "precondition: lengths cancel");
        assert_ne!(
            body.to_lowercase().find("<title").unwrap(),
            find_ci(&body, "<title").unwrap(),
            "precondition: the lowercased copy's offset is misaligned"
        );
        let s = find_ci(&body, "<title").unwrap();
        let s = body[s..].find('>').map(|e| s + e + 1).unwrap();
        let e = find_ci(&body[s..], "</title>").map(|e| s + e).unwrap();
        assert_eq!(slice_clamped(&body, s, e).trim(), "Hello");
    }

    #[test]
    fn find_ci_returns_offsets_into_the_original() {
        // Offset is a real boundary of the ORIGINAL, whatever case-mapping does.
        let s = format!("{CASE_GROWS}abc<TITLE>x");
        let i = find_ci(&s, "<title>").unwrap();
        assert!(s.is_char_boundary(i));
        assert!(s[i..].starts_with("<TITLE>"));
        // Unicode case-insensitivity, not just ASCII.
        assert_eq!(find_ci("ÉCOLE", "école"), Some(0));
        // Misses and edge cases.
        assert_eq!(find_ci("abc", "zzz"), None);
        assert_eq!(find_ci("", "x"), None);
        assert_eq!(find_ci("abc", ""), None);
        assert_eq!(find_ci("aXbc", "xb"), Some(1));
    }

    #[test]
    fn extract_attr_handles_unterminated_and_multibyte_values() {
        assert_eq!(extract_attr(r#"<meta content="v">"#, "content").as_deref(), Some("v"));
        assert_eq!(extract_attr(r#"<meta content='v'>"#, "content").as_deref(), Some("v"));
        assert_eq!(extract_attr(r#"<meta CONTENT="v">"#, "content").as_deref(), Some("v"));
        assert_eq!(extract_attr(r#"<meta content=v>"#, "content"), None); // unquoted
        assert_eq!(extract_attr(r#"<meta content="#, "content"), None); // truncated
        assert_eq!(extract_attr(r#"<meta content="漢字">"#, "content").as_deref(), Some("漢字"));
        // Length-changing prefix no longer discards the value.
        assert_eq!(
            extract_attr(&format!(r#"<meta alt="{CASE_GROWS}" content="v">"#), "content").as_deref(),
            Some("v")
        );
    }

    #[test]
    fn urlencoding_decode_never_panics_on_hostile_input() {
        assert_eq!(urlencoding_decode("/tmp/a%20b.md"), "/tmp/a b.md");
        assert_eq!(urlencoding_decode("/tmp/%C3%A9.md"), "/tmp/é.md");
        // '%' immediately followed by multibyte text — the old &s[i+1..i+3]
        // str-slice panicked here (review #8).
        assert_eq!(urlencoding_decode("/tmp/%é.md"), "/tmp/%é.md");
        assert_eq!(urlencoding_decode("%漢%%🎉"), "%漢%%🎉");
        // Truncated / invalid escapes pass through untouched.
        assert_eq!(urlencoding_decode("%"), "%");
        assert_eq!(urlencoding_decode("%2"), "%2");
        assert_eq!(urlencoding_decode("%zz"), "%zz");
        assert_eq!(urlencoding_decode("%2G"), "%2G");
        // Uppercase and lowercase hex both decode.
        assert_eq!(urlencoding_decode("%2f%2F"), "//");
    }

    // ---- export SSRF choke point ----
    // The policy is tested with an injected fetch, so these assert what the
    // rewriter DOES rather than what a network happens to answer.

    #[test]
    fn remote_images_are_inlined_and_failures_degrade_to_alt_text() {
        let mut seen: Vec<String> = vec![];
        let mut fetch = |u: &str| {
            seen.push(u.to_string());
            (u.contains("good")).then(|| "data:image/png;base64,AAAA".to_string())
        };
        let html = r#"<p><img src="https://good.example/a.png" alt="Chart"><img src="http://169.254.169.254/latest/meta-data/iam" alt="secret"></p>"#;
        let out = sanitize_export_html_with(html, &mut fetch);
        // The vetted one is inlined; nothing remote survives in the output.
        assert!(out.contains("data:image/png;base64,AAAA"));
        assert!(!out.contains("169.254.169.254"));
        assert!(!out.contains("https://good.example"));
        // A refused fetch keeps the author's alt text so the doc still reads.
        assert!(out.contains("secret"));
        // Both were offered to the guard — the rewriter never decides on its own.
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn non_remote_srcs_are_kept_without_fetching() {
        // NB: this asserts SEMANTICS (src preserved, no fetch), not byte
        // identity. The original version demanded output == input, which forced
        // pass-through of the untouched tag — and pass-through is precisely
        // what let a hidden remote src survive (see the parser-differential
        // test below). Rebuilding from vetted attributes is the safe shape.
        let mut fetch = |_: &str| -> Option<String> { panic!("must not fetch a non-remote src") };
        for (html, keep) in [
            (r#"<img src="data:image/png;base64,AAAA" alt="x">"#, "data:image/png;base64,AAAA"),
            (r#"<img src="assets/local.png" alt="x">"#, "assets/local.png"),
        ] {
            let out = sanitize_export_html_with(html, &mut fetch);
            assert!(out.contains(keep), "local src must survive: {out}");
            assert!(out.starts_with("<img "), "still an image: {out}");
        }
        // file: is NOT kept: an absolute file URL in an untrusted document is an
        // attempt to pull a local file into an export the user may share, and no
        // format needs it (local images arrive relative or as data:). It is
        // never fetched either — it drops straight to alt text.
        let out = sanitize_export_html_with(r#"<img src="file:///etc/passwd" alt="report">"#, &mut fetch);
        assert!(!out.contains("/etc/passwd"), "file: src must not survive: {out}");
        assert_eq!(out, "<span>report</span>");
        // No usable src → nothing to render; alt text carries the meaning.
        assert_eq!(sanitize_export_html_with(r#"<img alt="no src">"#, &mut fetch), "<span>no src</span>");
    }

    #[test]
    fn a_src_hidden_inside_another_attribute_cannot_escape_vetting() {
        // pkg-dev's measured parser differential: the FIRST `src=` in the byte
        // stream lives inside the alt VALUE, so a substring reader sees a
        // harmless data: (or no usable src) and passes the tag through — while
        // the converter's real parser uses the trailing remote src and fetches
        // it. Walking attributes is what makes the vetted src the used src.
        let mut seen: Vec<String> = vec![];
        let mut fetch = |u: &str| { seen.push(u.to_string()); None };
        let out = sanitize_export_html_with(
            r#"<img alt="<img src=data:image/png;base64,AAA>" src="http://attacker.example/x.png">"#,
            &mut fetch,
        );
        assert_eq!(seen, vec!["http://attacker.example/x.png"], "the REAL src must be the one vetted");
        assert!(!out.contains("attacker.example"), "refused src must not survive: {out}");

        // Duplicate attributes: first wins, matching HTML parsers — a trailing
        // data: decoy cannot rescue a leading remote src.
        let mut seen2: Vec<String> = vec![];
        let mut f2 = |u: &str| { seen2.push(u.to_string()); None };
        let out2 = sanitize_export_html_with(
            r#"<img src="http://evil.example/a.png" src="data:image/png;base64,AAAA" alt="d">"#,
            &mut f2,
        );
        assert_eq!(seen2, vec!["http://evil.example/a.png"]);
        assert!(!out2.contains("evil.example"));

        // Quoted inner decoy, single quotes, and a bare (unquoted) remote src.
        let mut seen3: Vec<String> = vec![];
        let mut f3 = |u: &str| { seen3.push(u.to_string()); None };
        let out3 = sanitize_export_html_with(
            r#"<img title="x src='data:image/png;base64,AA'" src=http://evil.example/b.png alt='t'>"#,
            &mut f3,
        );
        assert_eq!(seen3, vec!["http://evil.example/b.png"], "bare values parse too");
        assert!(!out3.contains("evil.example"));
    }

    #[test]
    fn unparseable_tags_are_dropped_not_trusted() {
        let mut fetch = |_: &str| -> Option<String> { panic!("must not fetch from an unparseable tag") };
        // Unterminated quote: a real parser may still recover a src, so we must
        // not emit the original markup.
        let out = sanitize_export_html_with(r#"<img src="http://evil.example/x.png alt=y>"#, &mut fetch);
        assert!(!out.contains("evil.example"), "unparseable tag must be dropped: {out}");
        assert_eq!(parse_tag_attrs(r#"<img src="unterminated>"#), None);
        assert_eq!(parse_tag_attrs("<img ="), None);
    }

    #[test]
    fn parse_tag_attrs_reads_quoted_bare_and_valueless_attributes() {
        let a = parse_tag_attrs(r#"<img SRC="a b.png" alt='q' hidden data-x=bare />"#).unwrap();
        assert_eq!(attr_of(&a, "src"), Some("a b.png"));
        assert_eq!(attr_of(&a, "alt"), Some("q"));
        assert_eq!(attr_of(&a, "hidden"), Some("")); // valueless
        assert_eq!(attr_of(&a, "data-x"), Some("bare"));
        assert_eq!(attr_of(&a, "missing"), None);
        assert_eq!(parse_tag_attrs("<img>").unwrap().len(), 0);
    }

    #[test]
    fn rewritten_tags_cannot_smuggle_a_second_remote_reference() {
        // Attributes we don't control are dropped, not carried over: the
        // replacement tag is rebuilt from src + alt only.
        let mut fetch = |_: &str| Some("data:image/png;base64,AAAA".to_string());
        let html = r#"<img src="https://a.example/x.png" srcset="https://evil.example/y.png 2x" style="background:url(https://evil.example/z.png)" onerror="x()" alt="ok">"#;
        let out = sanitize_export_html_with(html, &mut fetch);
        assert!(!out.contains("evil.example"), "no other remote ref may survive: {out}");
        assert!(!out.contains("onerror"));
        assert_eq!(out, r#"<img src="data:image/png;base64,AAAA" alt="ok">"#);
    }

    #[test]
    fn protocol_relative_and_uppercase_tags_are_still_vetted() {
        let mut seen: Vec<String> = vec![];
        let mut fetch = |u: &str| { seen.push(u.to_string()); None };
        let out = sanitize_export_html_with(r#"<IMG SRC="//evil.example/x.png" ALT="a">"#, &mut fetch);
        assert_eq!(seen, vec!["//evil.example/x.png"], "case-insensitive tag/attr matching");
        assert!(!out.contains("evil.example"));
        assert!(out.contains('a'));
    }

    #[test]
    fn alt_text_is_escaped_and_surrounding_markup_survives() {
        let mut fetch = |_: &str| -> Option<String> { None };
        let out = sanitize_export_html_with(
            r#"<h1>T</h1><img src="https://a.example/x.png" alt="<script>x</script>"><p>after</p>"#,
            &mut fetch,
        );
        assert!(out.starts_with("<h1>T</h1>"));
        assert!(out.ends_with("<p>after</p>"));
        assert!(!out.contains("<script>"), "alt text must be escaped: {out}");
        assert!(out.contains("&lt;script&gt;"));
    }

    #[test]
    fn a_gt_inside_an_attribute_cannot_hide_a_remote_src() {
        // Found by the escaping test below: with a naive find('>') the tag was
        // truncated at the '>' inside alt, so `src` was never seen and the
        // ORIGINAL markup passed through — while a real HTML parser reads one
        // well-formed tag with a live remote src and fetches it. Quote-aware
        // scanning is what makes the vetting unskippable.
        let mut seen: Vec<String> = vec![];
        let mut fetch = |u: &str| { seen.push(u.to_string()); None };
        let out = sanitize_export_html_with(
            r#"<img alt="a>b" src="http://169.254.169.254/latest/meta-data/">"#,
            &mut fetch,
        );
        assert_eq!(seen, vec!["http://169.254.169.254/latest/meta-data/"], "src must still be vetted");
        assert!(!out.contains("169.254.169.254"), "refused src must not survive: {out}");
        // Single quotes and a '>' in a title attribute behave the same.
        let mut seen2: Vec<String> = vec![];
        let mut f2 = |u: &str| { seen2.push(u.to_string()); None };
        let out2 = sanitize_export_html_with(
            r#"<img title='x>y' src='http://evil.example/p.png' alt='t'>"#,
            &mut f2,
        );
        assert_eq!(seen2, vec!["http://evil.example/p.png"]);
        assert!(!out2.contains("evil.example"));
    }

    #[test]
    fn tag_end_is_quote_aware() {
        let s = r#"<img alt="a>b" src="x">tail"#;
        assert_eq!(&s[..tag_end(s, 0)], r#"<img alt="a>b" src="x">"#);
        assert_eq!(tag_end("<img src=\"x\"", 0), 12); // unterminated → rest of input
        assert_eq!(&"<img>"[..tag_end("<img>", 0)], "<img>");
    }

    #[test]
    fn malformed_and_hostile_img_markup_terminates() {
        let mut fetch = |_: &str| Some("data:image/png;base64,AAAA".to_string());
        // Unclosed tags, empty srcs, and a stream of them must not hang or panic.
        for html in ["<img", "<img src=", "<img><img><img>", "<img src=\"\">", "a<img src=\"https://x.example/1.png\">b"] {
            let _ = sanitize_export_html_with(html, &mut fetch);
        }
    }

    #[test]
    fn export_csp_is_injected_into_head() {
        let with_head = with_export_csp("<html><head><title>t</title></head><body>x</body></html>");
        assert!(with_head.contains("default-src 'none'; img-src data:"));
        assert!(with_head.find("Content-Security-Policy") < with_head.find("<title>"), "CSP must precede content");
        // No <head>: still present, ahead of everything.
        assert!(with_export_csp("<p>x</p>").starts_with("<meta http-equiv=\"Content-Security-Policy\""));
    }

    #[test]
    fn base64_encodes_with_correct_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79"); // binary, incl. + / alphabet
    }

    #[test]
    fn is_remote_url_classifies_schemes() {
        for r in ["http://a/x.png", "HTTPS://A/x.png", " //a/x.png", "https://a/x"] {
            assert!(is_remote_url(r), "should be remote: {r}");
        }
        for l in ["data:image/png;base64,AA", "assets/x.png", "/abs/x.png", "file:///x.png", "asset://localhost/x"] {
            assert!(!is_remote_url(l), "should be local: {l}");
        }
    }

    #[test]
    fn sensitive_paths_are_refused_for_external_opens() {
        for bad in [
            "/Users/x/.ssh/id_rsa",
            "/Users/x/.ssh/known_hosts",
            "/Users/x/.aws/credentials",
            "/Users/x/project/.env",
            "/Users/x/project/.env.production",
            "/Users/x/.netrc",
            "/Users/x/certs/server.pem",
            "/Users/x/certs/private.key",
            "/Users/x/Library/Keychains/login.keychain-db",
            "/Users/x/work/secrets/api.txt",
            "/Users/x/.gnupg/pubring.kbx",
            "/Users/x/vpn/office.ovpn",
        ] {
            assert!(is_sensitive_path(Path::new(bad)), "should refuse: {bad}");
        }
        for ok in [
            "/Users/x/notes/todo.md",
            "/Users/x/project/README.md",
            "/Users/x/envision.md",   // ".env" prefix in a stem is NOT .env
            "/Users/x/keynotes.txt",  // contains "key" but not a key file
        ] {
            assert!(!is_sensitive_path(Path::new(ok)), "should allow: {ok}");
        }
    }

    #[test]
    fn draft_titles_read_only_the_head_of_a_file() {
        // M3: this ran on the welcome screen and slurped every draft WHOLE.
        let dir = std::env::temp_dir().join(format!("plume-readhead-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big.md");
        // First line, then far more than the scan window.
        let mut content = String::from("# Real Title\n");
        content.push_str(&"x".repeat((DRAFT_TITLE_SCAN_BYTES as usize) * 3));
        fs::write(&big, &content).unwrap();

        let head = read_head(&big, DRAFT_TITLE_SCAN_BYTES);
        assert!(head.len() as u64 <= DRAFT_TITLE_SCAN_BYTES, "must not read the whole file");
        assert!(head.starts_with("# Real Title"), "the head still carries the title");
        // The title survives despite the bound.
        assert!(draft_title(&head, "stem").contains("Real Title"));
        // Missing file → empty, never a panic.
        assert_eq!(read_head(&dir.join("nope.md"), DRAFT_TITLE_SCAN_BYTES), "");
        let _ = fs::remove_dir_all(&dir);
    }

    // HIGH-1: the explicit-open carve-out was launderable. A token-holding
    // socket client could `open` a sensitive path — which marked it
    // explicitly-opened — and then write it, because the carve-out
    // short-circuits the deny. That turned a document editor into arbitrary
    // code execution (a git credential-helper line runs on the next auth).
    // The carve-out's premise is "a HUMAN chose this exact path", so the flag
    // must track that, not merely which function called.
    // The read side must consume the SAME value the gate approved. A symlink is
    // the concrete way those diverge: gating on the resolved target and then
    // reading the raw argument means the bytes returned aren't the file that
    // passed. canonical_key is the join point, so assert it collapses the two.
    #[cfg(unix)]
    #[test]
    fn a_gated_read_resolves_to_the_same_file_the_gate_saw() {
        let root = std::env::temp_dir().join(format!("plume-readcanon-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let real = root.join("real.md");
        fs::write(&real, "real contents").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Gate and read now derive from one value: the link resolves to the
        // real file, and that is what a caller passing the link gets.
        let gated = canonical_key(&link);
        assert_eq!(gated, canonical_key(&real), "the gate sees through the symlink");
        assert_eq!(fs::read_to_string(&gated).unwrap(), "real contents");

        // Repointing the link cannot change what a already-resolved target
        // reads — the previous shape re-resolved at read time and would have.
        let other = root.join("other.md");
        fs::write(&other, "swapped contents").unwrap();
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&other, &link).unwrap();
        assert_eq!(
            fs::read_to_string(&gated).unwrap(),
            "real contents",
            "a resolved target is immune to a later swap of the path used to reach it"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_human_pick_may_approve_a_sensitive_path() {
        for sensitive in [
            "/Users/x/repo/.git/config",
            "/Users/x/.ssh/id_rsa",
            "/Users/x/repo/.env",
            "/Users/x/.pgpass",
        ] {
            let p = Path::new(sensitive);
            // A socket client, a deep link, or a document's own markup naming
            // the path is NOT a user pick — refuse to approve it.
            assert!(is_sensitive_path(p), "precondition: {sensitive} is sensitive");
            // …and with it unapproved, the write gate refuses even in scope.
            assert!(
                !scope_decision(p, false, true, true),
                "unapproved sensitive path must stay unwritable: {sensitive}"
            );
            // A genuine File > Open (user_picked) still authorizes it.
            assert!(scope_decision(p, true, false, false), "user pick must still work: {sensitive}");
        }
    }

    // Class 1, the async shape: the socket newWindow branch checked a resolved
    // path, then stored the RAW one for initial_file to read milliseconds later
    // on another thread — ample room to repoint the symlink in between. Storing
    // the resolved path leaves nothing to swap.
    #[cfg(unix)]
    #[test]
    fn a_spawned_windows_target_cannot_be_swapped_after_the_gate() {
        let root = std::env::temp_dir().join(format!("plume-spawnswap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let harmless = root.join("harmless.md");
        fs::write(&harmless, "harmless").unwrap();
        let secret = root.join("secret.env");
        fs::write(&secret, "SECRET=1").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(&harmless, &link).unwrap();

        // What the handler now stores: the resolved target, not the link.
        let stored = canonical_key(&link);
        assert_eq!(stored, canonical_key(&harmless));

        // Repoint the link at the secret, as an attacker would between the
        // gate and the spawned window's read.
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // The stored path still reads the vetted file. (Reading the raw link
        // here — the old behavior — would return SECRET=1.)
        assert_eq!(fs::read_to_string(&stored).unwrap(), "harmless");
        assert_eq!(fs::read_to_string(&link).unwrap(), "SECRET=1", "the swap really happened");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn round3_deny_list_additions() {
        for p in [
            "/Users/x/proj/.envrc",      // direnv — AWS/API secrets
            "/Users/x/site/.htpasswd",
            "/Users/x/keys/AuthKey.p8",  // Apple
            "/Users/x/android/release.jks",
            "/Users/x/android/my.keystore",
        ] {
            assert!(is_sensitive_path(Path::new(p)), "should refuse: {p}");
        }
        // False-positive guards: these are ordinary documents.
        for ok in ["/Users/x/notes/envrc-guide.md", "/Users/x/notes/keystore-setup.md"] {
            assert!(!is_sensitive_path(Path::new(ok)), "should allow: {ok}");
        }
    }

    #[test]
    fn pgpass_and_netrc_are_denied() {
        assert!(is_sensitive_path(Path::new("/Users/x/.pgpass")));
        assert!(is_sensitive_path(Path::new("/Users/x/.netrc"))); // already covered before this batch
        assert!(is_sensitive_path(Path::new("/Users/x/.ssh/config"))); // via the /.ssh/ dir mark
        assert!(!is_sensitive_path(Path::new("/Users/x/notes/pgpass-notes.md")));
    }

    #[test]
    fn socket_writes_cannot_reach_code_execution_or_secrets_from_scope_alone() {
        // H2: the socket write gate shares scope_decision with reads, so an
        // agent that has the repo in scope still cannot write the paths that
        // turn a document edit into code execution or credential theft.
        for exec_or_secret in [
            "/Users/x/repo/.git/hooks/pre-commit", // runs on the next commit
            "/Users/x/repo/.git/config",           // remote URLs + credential helper
            "/Users/x/repo/.git-credentials",
            "/Users/x/repo/.env",
            "/Users/x/repo/deploy/id_rsa",
            "/Users/x/.bash_history",
        ] {
            assert!(
                !scope_decision(Path::new(exec_or_secret), false, true, true),
                "socket write must be refused from scope alone: {exec_or_secret}"
            );
        }
        // Ordinary documents in that same scope stay writable — the agent
        // workflow this gate exists to serve is untouched.
        assert!(scope_decision(Path::new("/Users/x/repo/notes.md"), false, true, false));
        // And a file the user explicitly opened stays writable even if its name
        // is on the deny list: editing your own .env is legitimate work.
        assert!(scope_decision(Path::new("/Users/x/repo/.env"), true, false, false));
    }

    #[test]
    fn in_scope_directories_do_not_authorize_the_secrets_inside_them() {
        // The reported gap: the user opens README.md in a repo, so the whole
        // repo dir is in scope (scope is dir-inclusive) — and a compromised
        // renderer could then read the repo's secrets, defeating the deny list
        // through the primary read path.
        let repo_secret = Path::new("/Users/x/repo/.env");
        assert!(
            !scope_decision(repo_secret, false, true, false),
            "in-scope dir must NOT authorize a secret inside it"
        );
        // …but a file the user deliberately opened (File > Open, launch arg,
        // token-gated socket) is still allowed — editing your own .env works.
        assert!(scope_decision(repo_secret, true, false, false));
        // Ordinary documents in that same scope are unaffected.
        assert!(scope_decision(Path::new("/Users/x/repo/README.md"), false, true, false));
        assert!(scope_decision(Path::new("/Users/x/repo/docs/a.md"), false, false, true));
        // Nothing is authorized without territory at all.
        assert!(!scope_decision(Path::new("/Users/x/other/a.md"), false, false, false));
        // Same for the rest of the in-repo secret class.
        for secret in [
            "/Users/x/repo/.git/config",
            "/Users/x/repo/.git-credentials",
            "/Users/x/repo/deploy/id_rsa",
            "/Users/x/repo/certs/server.pem",
            "/Users/x/repo/.env.production",
            "/Users/x/repo/secrets/token.txt",
        ] {
            assert!(
                !scope_decision(Path::new(secret), false, true, true),
                "should refuse from scope alone: {secret}"
            );
        }
    }

    #[test]
    fn shell_and_repl_history_files_are_sensitive() {
        for h in [
            "/Users/x/.bash_history",
            "/Users/x/.zsh_history",
            "/Users/x/.python_history",
            "/Users/x/.node_repl_history",
            "/Users/x/.psql_history",
            "/Users/x/.history",
            "/Users/x/.lesshst",
        ] {
            assert!(is_sensitive_path(Path::new(h)), "should refuse: {h}");
        }
        // Not everything with "history" in the name is a shell history file.
        for ok in ["/Users/x/notes/history.md", "/Users/x/repo/CHANGE_history.md"] {
            assert!(!is_sensitive_path(Path::new(ok)), "should allow: {ok}");
        }
    }

    #[test]
    fn renderer_registered_tabs_cannot_self_authorize() {
        // The Codex P1: a compromised renderer registers a tab it never
        // legitimately opened. Nothing is approved, so it grants nothing —
        // neither the read gate nor (critically) the socket write scope.
        let approved_files: HashSet<PathBuf> = HashSet::new();
        let approved_dirs: HashSet<PathBuf> = HashSet::new();
        assert!(!tab_counts_as_scope(
            Path::new("/Users/x/.ssh/id_rsa"),
            &approved_files,
            &approved_dirs
        ));
        // A tab the user really opened (dialog/delivered open/link/launch arg
        // all call approve_file) still counts — the feature is preserved.
        let mut approved_files = HashSet::new();
        approved_files.insert(PathBuf::from("/Users/x/notes/todo.md"));
        assert!(tab_counts_as_scope(
            Path::new("/Users/x/notes/todo.md"),
            &approved_files,
            &approved_dirs
        ));
        // …and a tab inside a folder the user picked counts too.
        let mut approved_dirs = HashSet::new();
        approved_dirs.insert(PathBuf::from("/Users/x/project"));
        assert!(tab_counts_as_scope(
            Path::new("/Users/x/project/sub/a.md"),
            &approved_files,
            &approved_dirs
        ));
        // But a forged path merely NEAR an approved one does not.
        assert!(!tab_counts_as_scope(
            Path::new("/Users/x/project-evil/a.md"),
            &approved_files,
            &approved_dirs
        ));
        assert!(!tab_counts_as_scope(
            Path::new("/Users/x/notes/other.md"),
            &approved_files,
            &approved_dirs
        ));
    }

    #[test]
    fn windows_style_sensitive_paths_are_refused_too() {
        // Codex P1: '/'-only matching let backslash paths through the deny.
        for bad in [
            r"C:\Users\x\.ssh\id_rsa",
            r"C:\Users\x\.aws\credentials",
            r"C:\Users\x\project\.env",
            r"C:\Users\x\certs\server.pem",
            r"\\host\share\secrets\api.txt",
            r"C:\Users\x\.gnupg\pubring.kbx",
        ] {
            assert!(is_sensitive_path(Path::new(bad)), "should refuse: {bad}");
        }
        for ok in [r"C:\Users\x\notes\todo.md", r"C:\Users\x\envision.md"] {
            assert!(!is_sensitive_path(Path::new(ok)), "should allow: {ok}");
        }
    }

    #[test]
    fn doc_links_cannot_escape_the_document_directory() {
        let dir = Path::new("/Users/x/notes");
        // Inside the doc's own subtree — allowed.
        assert!(link_target_allowed(dir, Path::new("/Users/x/notes/other.md")));
        assert!(link_target_allowed(dir, Path::new("/Users/x/notes/sub/deep.md")));
        // Escaping the subtree — refused even though both are under $HOME,
        // which is what the old home-only check wrongly permitted.
        assert!(!link_target_allowed(dir, Path::new("/Users/x/.ssh/id_rsa")));
        assert!(!link_target_allowed(dir, Path::new("/Users/x/other/secret.md")));
        // Sibling dir with a shared name prefix is NOT inside.
        assert!(!link_target_allowed(dir, Path::new("/Users/x/notes-evil/a.md")));
        // Sensitive material inside the subtree is still refused.
        assert!(!link_target_allowed(dir, Path::new("/Users/x/notes/.env")));
        assert!(!link_target_allowed(dir, Path::new("/Users/x/notes/key.pem")));
        // "/" can never act as the containing dir.
        assert!(!link_target_allowed(Path::new("/"), Path::new("/etc/passwd")));
    }

    #[test]
    fn only_relative_hrefs_are_resolvable() {
        for good in ["other.md", "./other.md", "sub/deep.md", "../sibling.md", "a b.md"] {
            assert!(href_is_relative(good), "should accept: {good}");
        }
        // Absolute / scheme / drive-relative hrefs are not document links —
        // Path::join would REPLACE the base with them (the P1 bypass).
        for bad in [
            "/Users/x/.ssh/id_rsa",
            "//Users/x/.ssh/id_rsa",
            r"\Users\x\.ssh\id_rsa",
            r"C:\Users\x\.ssh\id_rsa",
            "C:notes.md",
            "file:///Users/x/.ssh/id_rsa",
            "https://evil.example/x",
            "",
        ] {
            assert!(!href_is_relative(bad), "should reject: {bad}");
        }
        // Sanity: the escaping relative href is accepted HERE and stopped by
        // link_target_allowed after canonicalization (defense in depth).
        assert!(href_is_relative("../../.ssh/id_rsa"));
        assert!(!link_target_allowed(
            Path::new("/Users/x/notes"),
            Path::new("/Users/x/.ssh/id_rsa")
        ));
    }

    #[test]
    fn approved_dir_roots_are_dir_inclusive_and_reject_root() {
        let mut dirs = HashSet::new();
        dirs.insert(PathBuf::from("/Users/x/notes"));
        assert!(within_any_dir(&dirs, Path::new("/Users/x/notes")));
        assert!(within_any_dir(&dirs, Path::new("/Users/x/notes/sub/a.md")));
        assert!(!within_any_dir(&dirs, Path::new("/Users/x/notes-evil/a.md")));
        assert!(!within_any_dir(&dirs, Path::new("/Users/x/other/a.md")));
        // "/" must never be a scope root even if it somehow got granted.
        let mut root = HashSet::new();
        root.insert(PathBuf::from("/"));
        assert!(!within_any_dir(&root, Path::new("/etc/passwd")));
    }

    #[test]
    fn untitled_recovery_key_cannot_escape_recovery_dir() {
        // A hostile key (e.g. via discard_untitled_recovery) must sanitize into a
        // flat file name inside the recovery dir — never a traversal.
        for evil in ["../../evil", "..", "a/b/c", "..\\..\\x"] {
            let f = untitled_recovery_file(evil);
            assert!(f.starts_with(untitled_recovery_dir()), "escaped: {evil}");
            assert!(!f.to_string_lossy().contains(".."), "kept dots: {evil}");
        }
    }
}

// The renderer reports per-document dirty state so writeDocument can refuse to
// clobber a buffer with unsaved edits (P1-4). Cluster A contract: explicit
// path, path-backed docs only, and the renderer is the SINGLE live writer
// (pushes on every transition, clears on tab close/save). Untitled dirty state
// is renderer-internal now — the close flow no longer consults native flags.
#[tauri::command]
fn set_doc_dirty(state: tauri::State<AppState>, path: String, dirty: bool) {
    let key = canonical_key(Path::new(&path)).to_string_lossy().to_string();
    let mut set = state.dirty_files.lock_or_recover();
    if dirty {
        set.insert(key);
    } else {
        set.remove(&key);
    }
}

// Round-2: another window may already hold this path. Window B opening a draft
// that Window A has open double-binds it — two autosave loops on one file, and
// graduating in A resurrects it via B. The renderer asks here BEFORE binding.
//
// Native owns this decision because native owns the path→window map; handing
// the raw map to the renderer would put the same policy in two places and give
// it a copy that can desync — the class cluster A exists to prevent.
//
// Returns true only if another window was actually found AND focused, so a
// false answer always means "go ahead and bind" rather than a dead end.
#[tauri::command]
fn focus_path(app: AppHandle, window: tauri::WebviewWindow, path: String) -> bool {
    let target = canonical_key(Path::new(&path));
    let me = window.label().to_string();
    let st = app.state::<AppState>();
    // Search registered tab sets UNION each window's bound doc: a window that
    // has bound a path but not yet pushed its tab set would otherwise be
    // invisible for exactly the interval in which a race double-binds.
    let owner = {
        let tabs = st.open_tabs.lock_or_recover();
        let docs = st.docs.lock_or_recover();
        tabs.iter()
            .find(|(label, paths)| **label != me && paths.contains(&target))
            .map(|(label, _)| label.clone())
            .or_else(|| {
                docs.iter()
                    .find(|(label, d)| {
                        **label != me
                            && !d.path.is_empty()
                            && canonical_key(Path::new(&d.path)) == target
                    })
                    .map(|(label, _)| label.clone())
            })
    };
    let Some(label) = owner else { return false };
    let Some(win) = app.get_webview_window(&label) else {
        return false; // it closed between the lookup and now — caller binds normally
    };
    // Emit BEFORE focusing so the owning window activates the right tab whether
    // or not the OS honors the focus request.
    let _ = app.emit_to(&label, "activate-path", json!({ "path": target.to_string_lossy() }));
    let _ = win.show();
    let _ = win.set_focus();
    true
}

// Cluster A delta 4: the renderer registers THIS window's full open tab
// path-set (canonical) on every tab add/remove/retarget and at startup. Keeps
// background tabs inside the agent write scope + listOpenFiles, and gives the
// Destroyed-time dirty_files GC its sweep set.
#[tauri::command]
fn set_open_paths(window: tauri::WebviewWindow, state: tauri::State<AppState>, paths: Vec<String>) {
    let set: Vec<PathBuf> = paths
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| canonical_key(Path::new(p)))
        .collect();
    state.open_tabs.lock_or_recover().insert(window.label().to_string(), set);
}

// The window that should receive an open request: the focused one, else main.
fn focused_or_main(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

fn focused_label(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .map(|w| w.label().to_string())
}

// The document open in the focused window (None if unfocused/untitled).
fn focused_doc(app: &AppHandle) -> Option<String> {
    let label = focused_label(app)?;
    window_doc_path(app, &label)
}

// Route an open to ONE window's smartOpen (reuse it if it's an empty/untitled
// buffer, else spawn a new window on top), then bring it forward. Replaces the old
// global `emit("file-opened")` broadcast, which loaded the doc into every window and
// then focused "main" regardless of where it went — the cause of both the
// opens-behind and the intermittent replace-the-foreground-window bugs.
fn deliver_open(app: &AppHandle, path: &str, line: Option<i64>, user_picked: bool) {
    // Resolve ONCE and hand the canonical path onward — to the approval, to the
    // renderer (which binds and reads it), and to any spawned window. The write
    // path already writes the canonical target it validated, precisely so a
    // symlink swapped between check and write cannot redirect it; the READ path
    // lacked that, vetting a canonical form and then passing the RAW string on
    // to be resolved a second time, later.
    let canon = canonical_key(Path::new(path));
    let canon_str = canon.to_string_lossy().to_string();
    let path: &str = &canon_str;
    // Every delivery point is a legitimate grant: user dialog picks, the
    // token-gated socket, and externally-driven opens that already passed the
    // deliver_external_open gate. Approving here lets the renderer's follow-up
    // bind_doc through containment.
    approve_file(app, Path::new(path), user_picked);
    let payload = json!({ "path": path, "line": line });
    if let Some(win) = focused_or_main(app) {
        let label = win.label().to_string();
        let _ = app.emit_to(&label, "open-file", payload); // this window only
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let appc = app.clone();
        let p = path.to_string();
        let _ = app.run_on_main_thread(move || { let _ = spawn_window(&appc, &p); });
    }
}

// ---- control socket (the `plume` CLI + MCP server talk here) ----
fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// 256-bit hex secret for the socket handshake. getrandom is already in the tree;
// the time-based fallback only fires if the OS RNG is unavailable (effectively never).
fn random_token() -> String {
    let mut b = [0u8; 32];
    if getrandom::getrandom(&mut b).is_err() {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, x) in b.iter_mut().enumerate() {
            *x = ((t >> (i % 16)) as u8) ^ (i as u8).wrapping_mul(31);
        }
    }
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn dispatch(app: &AppHandle, req: &Value) -> Value {
    let cmd = req["cmd"].as_str().unwrap_or("");
    // Handshake-token gate (every cmd except the liveness ping). The socket is
    // already 0600; this also blocks a same-user process that hasn't read the
    // 0600 token file. ping stays open so probe-before-bind / `plume --version`
    // can check liveness without the secret.
    if cmd != "ping" {
        let expected = app.state::<AppState>().socket_token.lock_or_recover().clone();
        // Fail CLOSED: an empty/unset token denies every command rather than opening
        // the gate. The token is written before bind, so this never blocks a live app.
        if expected.is_empty() || req["token"].as_str() != Some(expected.as_str()) {
            return json!({ "ok": false, "error": "unauthorized" });
        }
    }
    match cmd {
        "ping" => json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
        "focus" => {
            focus_main(app);
            json!({ "ok": true })
        }
        "open" => {
            let Some(p) = req["path"].as_str() else {
                return json!({ "ok": false, "error": "no path" });
            };
            // A token-holding client is exactly the threat the write deny
            // exists for, so `open` must not be able to launder a path into
            // approved_files and out the other side. Without this, an agent
            // could: open <repo>/.git/config → it becomes "explicitly opened" →
            // writeDocument short-circuits the deny via that carve-out → a
            // credential-helper line runs on the next git auth. The same
            // laundering also disclosed arbitrary files: the newWindow branch
            // reaches initial_file, which reads the target and hands it to the
            // renderer. Refusing here covers BOTH branches at the door.
            //
            // File ▸ Open of your own .env is deliberately untouched — that
            // path is a human picking a file in a native dialog, not a caller
            // naming one over a socket.
            let canon = canonical_key(Path::new(p));
            if is_sensitive_path(&canon) {
                eprintln!("socket open refused: {p} is sensitive (open it from File ▸ Open if you mean to edit it)");
                return json!({ "ok": false, "code": "sensitive_path",
                    "error": "refused: sensitive path — open it from File ▸ Open if you mean to edit it" });
            }
            if req["newWindow"].as_bool().unwrap_or(false) {
                // Spawn the CANONICAL path. The raw one was checked above and
                // then handed to spawn_window, which stores it for initial_file
                // to read on another thread milliseconds later — ample room to
                // repoint a symlink between the check and the read, turning a
                // gated open of ws/link.md into a read of .git/config. A
                // resolved path has no symlink left to swap.
                let appc = app.clone();
                let path = canon.to_string_lossy().to_string();
                let _ = app.run_on_main_thread(move || { let _ = spawn_window(&appc, &path); });
                return json!({ "ok": true });
            }
            if !Path::new(p).is_file() {
                return json!({ "ok": false, "error": "cannot read file" });
            }
            deliver_open(app, p, req["line"].as_i64(), false);
            json!({ "ok": true })
        }
        "writeDocument" => match req["content"].as_str() {
            Some(content) if req["path"].is_string() => {
                let p = req["path"].as_str().unwrap();
                let target = canonical_key(Path::new(p));
                if !write_allowed(app, &target) {
                    json!({ "ok": false, "code": "outside_workspace",
                        "error": "refused: target is outside the open workspace (open the file or its folder in Plume first)" })
                } else if app.state::<AppState>().dirty_files.lock_or_recover()
                    .contains(&target.to_string_lossy().to_string())
                {
                    json!({ "ok": false, "code": "dirty_conflict",
                        "error": "refused: the target has unsaved changes open in Plume — save or discard first" })
                } else {
                    // Write the canonicalized target we validated, never the raw path —
                    // otherwise a symlink swap between check and write diverges (TOCTOU).
                    match fs::write(&target, content) {
                        Ok(_) => json!({ "ok": true, "path": p }),
                        Err(_) => json!({ "ok": false, "error": "write failed" }),
                    }
                }
            }
            _ => json!({ "ok": false, "error": "path and content required" }),
        },
        "getAnnotations" => {
            let p = req["path"].as_str().map(|s| s.to_string()).or_else(|| focused_doc(app));
            match p {
                Some(p) => {
                    // Read scope = write scope: don't let a socket caller pull a
                    // <path>.notes.json from outside the open workspace.
                    if !write_allowed(app, &canonical_key(Path::new(&p))) {
                        json!({ "ok": false, "error": "refused: path is outside the open workspace" })
                    } else {
                        json!({ "ok": true, "path": p, "annotations": load_annotations(app.clone(), Some(p.clone())) })
                    }
                }
                None => json!({ "ok": false, "error": "no path" }),
            }
        }
        "listOpenFiles" => {
            // Cluster A: every open TAB across every window (renderer-registered
            // via set_open_paths), deduped, unioned with bound docs so windows
            // that haven't pushed a tab set yet still report. `focused` marks
            // the focused window's ACTIVE (bound) document.
            let focused_path = focused_doc(app).map(|p| canonical_key(Path::new(&p)));
            let st = app.state::<AppState>();
            let mut all: Vec<PathBuf> = vec![];
            for tabs in st.open_tabs.lock_or_recover().values() {
                all.extend(tabs.iter().cloned());
            }
            for d in st.docs.lock_or_recover().values() {
                if !d.path.is_empty() {
                    all.push(canonical_key(Path::new(&d.path)));
                }
            }
            let dirty = st.dirty_files.lock_or_recover();
            let mut seen = HashSet::new();
            let files: Vec<Value> = all
                .into_iter()
                .filter(|p| seen.insert(p.clone()))
                .map(|p| {
                    let key = p.to_string_lossy().to_string();
                    json!({
                        "path": key,
                        "dirty": dirty.contains(&key),
                        "focused": focused_path.as_ref() == Some(&p),
                    })
                })
                .collect();
            json!({ "ok": true, "files": files })
        }
        "windows" => {
            let labels: Vec<String> = app.webview_windows().into_keys().collect();
            json!({ "ok": true, "count": labels.len(), "labels": labels })
        }
        "getActiveDocument" => agent_query(app, "getActiveDocument"),
        "getSelection" => agent_query(app, "getSelection"),
        other => json!({ "ok": false, "error": format!("unknown cmd: {}", other) }),
    }
}

// Per-connection handler: newline-delimited JSON request → response on the same
// full-duplex stream (no try_clone — works for any Read+Write transport).
// 32 MiB is far above any legitimate control message (incl. a large document write)
// and bounds a no-newline flood that would otherwise buffer unboundedly (DoS).
const MAX_SOCKET_LINE: u64 = 32 * 1024 * 1024;

fn handle_conn<S: Read + Write>(app: &AppHandle, stream: S) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let n = match reader.by_ref().take(MAX_SOCKET_LINE + 1).read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => n as u64,
            Err(_) => break,
        };
        if n > MAX_SOCKET_LINE {
            break; // oversized line (no newline within the cap) — drop the connection
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let req: Value = serde_json::from_str(t).unwrap_or(Value::Null);
        let resp = dispatch(app, &req);
        if writeln!(reader.get_mut(), "{}", resp).is_err() {
            break;
        }
    }
}

// Control socket transport: Unix domain socket on macOS/Linux, Windows named
// pipe on Windows. The name must match the Node CLI/MCP clients (bin/*.js).
#[cfg(unix)]
fn run_socket_server(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    let dir = plume_dir();
    let _ = fs::create_dir_all(&dir);
    // Owner-only on the directory and (below) the socket: nothing else on a
    // multi-user box may connect and drive writeDocument (P0-2).
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    // Write the handshake token (0600) BEFORE binding, so by the time a client can
    // connect the secret is already on disk for it to read.
    let token = random_token();
    *app.state::<AppState>().socket_token.lock_or_recover() = token.clone();
    let tokfile = dir.join("token");
    let _ = fs::write(&tokfile, &token);
    let _ = fs::set_permissions(&tokfile, fs::Permissions::from_mode(0o600));
    let sock = dir.join("plume.sock");
    // Probe-before-bind (P0-3): never steal a socket a live Plume already owns.
    // A successful connect means a real owner is listening — leave it alone. A
    // refused connect (or any error) means the file is stale; reclaim it. This
    // mirrors the Electron control.js ownership logic so two shells don't fight.
    if sock.exists() {
        match std::os::unix::net::UnixStream::connect(&sock) {
            Ok(_) => return,                  // a live Plume answered — don't steal
            Err(_) => { let _ = fs::remove_file(&sock); } // stale, safe to reclaim
        }
    }
    let listener = match std::os::unix::net::UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(_) => return,
    };
    let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));
    for stream in listener.incoming().flatten() {
        let app = app.clone();
        std::thread::spawn(move || handle_conn(&app, stream));
    }
}

#[cfg(windows)]
fn run_socket_server(app: AppHandle) {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
    // Security note (P0-2 Windows analogue): a named pipe created in the default
    // (non-global) namespace is reachable only within the creating user's session;
    // other interactive users get their own \\.\pipe namespace, so no cross-user
    // access is granted here. A hardened DACL would belong here if Plume ever ran
    // as a service. Maps to \\.\pipe\plume.sock — the Node clients connect to the same name.
    let _ = fs::create_dir_all(plume_dir());
    let token = random_token();
    *app.state::<AppState>().socket_token.lock_or_recover() = token.clone();
    let _ = fs::write(plume_dir().join("token"), &token);
    let name = match "plume.sock".to_ns_name::<GenericNamespaced>() {
        Ok(n) => n,
        Err(_) => return,
    };
    let listener = match ListenerOptions::new().name(name).create_sync() {
        Ok(l) => l,
        Err(_) => return,
    };
    loop {
        match listener.accept() {
            Ok(conn) => {
                let app = app.clone();
                std::thread::spawn(move || handle_conn(&app, conn));
            }
            Err(_) => break,
        }
    }
}

fn start_socket(app: AppHandle) {
    std::thread::spawn(move || run_socket_server(app));
}

// Renderer pushes its recent-files list here; store it and rebuild the menu so
// File > Open Recent reflects it.
#[tauri::command]
fn set_recent_files(app: AppHandle, state: tauri::State<AppState>, paths: Vec<String>) {
    *state.recents.lock_or_recover() = paths;
    let _ = build_and_set_menu(&app);
}

// ---- menu ----
fn build_and_set_menu(app: &AppHandle) -> tauri::Result<()> {
    let mi = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    // Open Recent submenu, populated from the recents the renderer pushes up.
    let recents: Vec<String> = app.state::<AppState>().recents.lock_or_recover().clone();
    let mut recent_b = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        recent_b = recent_b.item(
            &MenuItemBuilder::with_id("recent:none", "No Recent Files").enabled(false).build(app)?,
        );
    } else {
        for p in recents.iter().take(15) {
            let label = Path::new(p).file_name().and_then(|s| s.to_str()).unwrap_or(p.as_str());
            recent_b = recent_b.item(&mi(&format!("openRecent:{}", p), label, None)?);
        }
        recent_b = recent_b.separator().item(&mi("clearRecent", "Clear Recent", None)?);
    }
    let recent_menu = recent_b.build()?;

    #[allow(unused_mut)]
    let mut file_b = SubmenuBuilder::new(app, "File")
        .item(&mi("new", "New", Some("CmdOrCtrl+N"))?)
        .item(&mi("open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent_menu)
        .item(&mi("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&mi("saveAs", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&mi("export:html", "Export HTML…", None)?)
        .item(&mi("export:pdf", "Export PDF…", None)?)
        .item(&mi("export:docx", "Export Word…", None)?)
        .item(&mi("publishGoogle", "Publish to Google Docs…", None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("Close"))?);
    // No macOS app menu on Windows/Linux — Quit belongs under File there. It is
    // a CUSTOM item (not PredefinedMenuItem::quit) so quit routes through the
    // per-window close-prompt fan-out instead of terminating instantly.
    #[cfg(not(target_os = "macos"))]
    {
        file_b = file_b.separator().item(&mi("quit", "Exit", Some("CmdOrCtrl+Q"))?);
    }
    let file = file_b.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&mi("copyRich", "Copy as Rich Text", Some("CmdOrCtrl+Shift+C"))?)
        .item(&mi("copyHtml", "Copy as HTML", None)?)
        .separator()
        .item(&mi("find", "Find…", Some("CmdOrCtrl+F"))?)
        .build()?;

    // Format-menu parity with the in-app block controls (#12): strike, lists,
    // quote, code block, table, rule — every action discoverable from the menu bar.
    let format = SubmenuBuilder::new(app, "Format")
        .item(&mi("format:bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&mi("format:italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&mi("format:strike", "Strikethrough", Some("CmdOrCtrl+Shift+X"))?)
        .item(&mi("format:code", "Inline Code", Some("CmdOrCtrl+E"))?)
        .item(&mi("format:link", "Link", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&mi("heading:1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&mi("heading:2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&mi("heading:3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&mi("heading:0", "Body Text", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&mi("list:bullet", "Bullet List", Some("CmdOrCtrl+Shift+8"))?)
        .item(&mi("list:ordered", "Numbered List", Some("CmdOrCtrl+Shift+7"))?)
        .item(&mi("list:task", "To-do List", None)?)
        .separator()
        .item(&mi("block:quote", "Block Quote", None)?)
        .item(&mi("block:code", "Code Block", None)?)
        .item(&mi("insert:table", "Table", None)?)
        .item(&mi("insert:hr", "Horizontal Rule", None)?)
        .separator()
        .item(&mi("addNote", "Add Note for Agent", Some("CmdOrCtrl+J"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&mi("toggleSidebar", "Toggle Files Sidebar", Some("CmdOrCtrl+Shift+E"))?)
        .item(&mi("toggleOutline", "Toggle Outline", Some("CmdOrCtrl+Shift+O"))?)
        .item(&mi("toggleReveal", "Reveal Markdown Marks", Some("CmdOrCtrl+Shift+M"))?)
        .item(&mi("toggleFocus", "Focus Mode", Some("CmdOrCtrl+Shift+L"))?)
        .item(&mi("toggleMode", "Toggle Source / Preview", Some("CmdOrCtrl+/"))?)
        .separator()
        .item(&mi("theme:system", "Appearance: System", None)?)
        .item(&mi("theme:light", "Appearance: Light", None)?)
        .item(&mi("theme:dark", "Appearance: Dark", None)?)
        .build()?;

    let go = SubmenuBuilder::new(app, "Go")
        .item(&mi("palette", "Command Palette…", Some("CmdOrCtrl+P"))?)
        .item(&mi("searchFolder", "Search in Folder…", Some("CmdOrCtrl+Shift+F"))?)
        .item(&mi("workspace", "Sessions & Context…", Some("CmdOrCtrl+Shift+P"))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize() // "Zoom" on macOS
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    let mut mb = MenuBuilder::new(app);
    // On macOS the FIRST submenu becomes the application menu. Without one, File
    // was silently promoted — so there was no About/Hide and, critically, no
    // Quit ⌘Q (#2). Windows/Linux skip it: Quit lives under File there instead.
    #[cfg(target_os = "macos")]
    {
        // Quit is a CUSTOM item: the predefined one calls NSApp terminate:
        // directly (never reaching ExitRequested), which would skip the
        // unsaved-changes fan-out entirely. ⌘Q now runs the same per-window
        // close-prompt flow as ⌘W (cluster A pillar 3).
        let app_menu = SubmenuBuilder::new(app, "Plume")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&mi("quit", "Quit Plume", Some("CmdOrCtrl+Q"))?)
            .build()?;
        mb = mb.item(&app_menu);
    }
    let menu = mb
        .item(&file)
        .item(&edit)
        .item(&format)
        .item(&view)
        .item(&go)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Externally-DRIVEN open (plume:// deep links, macOS Finder `Opened` events,
/// second-instance argv). Review #2: this path was unscoped — any web page
/// could open ~/.ssh/id_rsa into the editor via plume://open?path=. Gate:
/// 1. sensitive credential material → hard refuse (File ▸ Open remains the
///    trusted route if the user genuinely wants such a file);
/// 2. inside user-established territory → open directly;
/// 3. anything else → native Open/Cancel confirm (non-blocking), approve on
///    Open only. Finder double-clicks of new files land in (3) as a one-click
///    confirm; scripted plume:// floods can no longer silently exfiltrate.
fn deliver_external_open(app: &AppHandle, path: &str, line: Option<i64>) {
    if !Path::new(path).is_file() {
        return;
    }
    let canon = canonical_key(Path::new(path));
    // Everything below hands THIS resolved value onward — deliver_open would
    // otherwise canonicalize the raw path a second time, leaving a (narrow,
    // synchronous) window in which the path vetted and the path read are two
    // different resolves.
    let canon_str = canon.to_string_lossy().to_string();
    if is_sensitive_path(&canon) {
        eprintln!("plume: refused externally-driven open of sensitive path {}", canon.display());
        return;
    }
    if fs_scope_allows(app, &canon) {
        deliver_open(app, &canon_str, line, false);
        return;
    }
    let appc = app.clone();
    let p = canon_str;
    app.dialog()
        .message(format!("Open “{}” in Plume?\n\nThis request came from outside Plume (a link, another app, or Finder).", canon.display()))
        .title("Open File")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Open".to_string(), "Cancel".to_string()))
        .show(move |yes| {
            if yes {
                deliver_open(&appc, &p, line, false);
            }
        });
}

/// Open a file path into the running app (used by single-instance + Opened events).
fn open_external_file(app: &AppHandle, p: &str) {
    deliver_external_open(app, p, None);
}

fn main() {
    tauri::Builder::default()
        // single-instance must be registered first; forwards a second launch's args.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(p) = argv.iter().skip(1).find(|a| !a.starts_with('-')) {
                open_external_file(app, p);
            } else {
                focus_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            read_path,
            write_file,
            initial_file,
            open_in_new_window,
            export_doc,
            export_pdf,
            publish_google,
            node_status,
            install_node,
            open_external,
            open_dialog,
            save_dialog,
            materialize_doc,
            create_draft,
            list_drafts,
            discard_draft,
            drafts_dir,
            rename_file,
            pick_folder,
            default_docs_dir,
            push_attachment,
            list_session_targets,
            resolve_link,
            list_dir,
            search_files,
            load_annotations,
            save_annotations,
            snapshot,
            discard_recovery,
            list_sessions,
            search_sessions,
            list_context,
            session_read,
            save_image,
            pick_image,
            link_preview,
            agent_reply,
            set_recent_files,
            set_doc_dirty,
            set_open_paths,
            focus_path,
            bind_doc,
            detach_doc,
            untitled_recovery,
            discard_untitled_recovery,
            close_window_now,
            close_prompt_ack,
            cancel_close
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // "New" spawns a fresh blank window from the main process — the empty
            // path is the sentinel `initial_file` reads as "untitled".
            if id == "new" {
                let _ = spawn_window(app, "");
                return;
            }
            // ⌘Q / File▸Exit: renderer-authoritative quit via per-window fan-out.
            if id == "quit" {
                request_quit(app);
                return;
            }
            // Open Recent runs through the external-open gate rather than the
            // renderer (Codex P2). Two reasons: (a) after a fresh launch a
            // prior-session path is in no scope yet, so the gated read would
            // reject it — the regression; (b) the recents list is pushed by
            // the RENDERER (set_recent_files) and the menu shows only the
            // basename, so a compromised renderer could label a credential
            // file "notes.md". Through the gate: sensitive → refused,
            // in-scope → opens directly, otherwise → one confirm showing the
            // full path.
            if let Some(p) = id.strip_prefix("openRecent:") {
                let appc = app.clone();
                let path = p.to_string();
                std::thread::spawn(move || deliver_external_open(&appc, &path, None));
                return;
            }
            // File > Open with no window alive (macOS after ⌘W): there is no
            // renderer to run the dialog, so run it natively off-thread.
            if id == "open" && app.webview_windows().is_empty() {
                let appc = app.clone();
                std::thread::spawn(move || { let _ = open_via_dialog(&appc); });
                return;
            }
            let (base, arg) = match id.split_once(':') {
                Some((b, a)) => (b, Some(a.to_string())),
                None => (id, None),
            };
            let arg_val: Value = match (base, &arg) {
                ("heading", Some(a)) => json!(a.parse::<i64>().unwrap_or(0)),
                (_, Some(a)) => json!(a),
                (_, None) => Value::Null,
            };
            let payload = json!({ "channel": format!("menu:{}", base), "arg": arg_val });
            // Deliver to the FOCUSED window only. The old app-wide broadcast made
            // every window apply the action (bold in three buffers at once).
            match focused_or_main(app) {
                Some(win) => { let _ = app.emit_to(win.label(), "menu", payload); }
                None => { let _ = app.emit("menu", payload); }
            }
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            // Hidden pdf* export windows carry no document state.
            if label.starts_with("pdf") {
                return;
            }
            match event {
                // Closing a doc with unsaved edits would lose them — hold the
                // Cluster A pillar 3 — close is RENDERER-AUTHORITATIVE: native
                // always prevents and emits close-requested; the renderer owns
                // the full tab set + dirty state, prompts every dirty tab, and
                // resolves via close_window_now (proceed) or cancel_close
                // (abort). Native consults NO dirty flags here. Liveness: the
                // bridge auto-ACKs receipt; no ack within CLOSE_ACK_DEADLINE
                // means the webview is dead → destroy natively (crash-recovery
                // snapshots are the data net).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let st = app.state::<AppState>();
                    api.prevent_close();
                    let action = {
                        let mut pend = st.pending_close.lock_or_recover();
                        let entry = pend.get(&label).map(|(t, a)| (t.elapsed(), *a));
                        let action = close_action(entry);
                        if action == CloseAction::Emit {
                            pend.insert(label.clone(), (std::time::Instant::now(), false));
                        }
                        action
                    };
                    if action == CloseAction::Swallow {
                        return; // a prompt round-trip is already in flight
                    }
                    let _ = app.emit_to(&label, "close-requested", json!({}));
                    let appc = app.clone();
                    let lbl = label.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(CLOSE_ACK_DEADLINE);
                        let st = appc.state::<AppState>();
                        let dead = matches!(
                            st.pending_close.lock_or_recover().get(&lbl),
                            Some((_, false))
                        );
                        if dead {
                            eprintln!(
                                "plume: window {lbl} never ACKed close-requested within {CLOSE_ACK_DEADLINE:?} — treating renderer as dead, closing"
                            );
                            st.pending_close.lock_or_recover().remove(&lbl);
                            let a2 = appc.clone();
                            let l2 = lbl.clone();
                            let _ = appc.run_on_main_thread(move || {
                                if let Some(w) = a2.get_webview_window(&l2) {
                                    let _ = w.destroy();
                                }
                            });
                        }
                    });
                }
                // Window gone: retire its doc state so the agent write scope
                // shrinks with it, and GC dirty_files (coord-ratified nuance):
                // sweep THIS window's registered tab paths — death-cleanup for a
                // crashed renderer that can't clear its own flags — but never a
                // path another live window still lists.
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let st = app.state::<AppState>();
                    let old = st.docs.lock_or_recover().remove(&label);
                    let mut swept: Vec<PathBuf> =
                        st.open_tabs.lock_or_recover().remove(&label).unwrap_or_default();
                    if let Some(d) = &old {
                        if !d.path.is_empty() {
                            swept.push(canonical_key(Path::new(&d.path)));
                        }
                    }
                    let survivors: HashSet<PathBuf> = st
                        .open_tabs
                        .lock_or_recover()
                        .values()
                        .flatten()
                        .cloned()
                        .collect();
                    {
                        let mut dirty = st.dirty_files.lock_or_recover();
                        for p in swept {
                            if !survivors.contains(&p) {
                                dirty.remove(&p.to_string_lossy().to_string());
                            }
                        }
                    }
                    st.window_files.lock_or_recover().remove(&label);
                    st.pending_close.lock_or_recover().remove(&label);
                    drop(old); // watcher dropped outside any state lock
                }
                _ => {}
            }
        })
        .setup(|app| {
            launched_at_ms(); // pin the recovery cutoff to actual app start
            let handle = app.handle().clone();
            let args: Vec<String> = std::env::args().collect();
            if let Some(p) = args.iter().skip(1).find(|a| !a.starts_with('-')) {
                if Path::new(p).is_file() {
                    // The user launched Plume with this file — trusted pick;
                    // approve it so the bootstrap bind passes containment.
                    approve_file(&handle, Path::new(p), true); // user launched Plume with this file
                    *app.state::<AppState>().initial.lock_or_recover() = Some(p.clone());
                }
            }
            let _ = build_and_set_menu(&handle);
            start_socket(handle.clone());

            // plume://open?path=/abs/file.md&line=42 deep links (#9: line= jumps
            // the opened window to that line, same as the CLI's --line).
            use tauri_plugin_deep_link::DeepLinkExt;
            let _ = app.deep_link().register("plume");
            let dl_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let s = url.to_string();
                    if let Some(q) = s.split('?').nth(1) {
                        let mut path: Option<String> = None;
                        let mut line: Option<i64> = None;
                        for kv in q.split('&') {
                            if let Some(p) = kv.strip_prefix("path=") {
                                path = Some(urlencoding_decode(p));
                            } else if let Some(l) = kv.strip_prefix("line=") {
                                line = l.parse().ok();
                            }
                        }
                        if let Some(p) = path {
                            // Cluster B: deep links are attacker-reachable (any
                            // web page) — always through the external-open gate.
                            deliver_external_open(&dl_handle, &p, line);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Plume")
        .run(|_app, _event| {
            // macOS Finder "Open With" delivers files via RunEvent::Opened (a
            // macOS-only variant). Windows/Linux receive paths via argv +
            // single-instance + OS file associations instead.
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    for url in urls {
                        let s = url.to_string();
                        let p = s.strip_prefix("file://").unwrap_or(&s);
                        let p = urlencoding_decode(p);
                        open_external_file(_app, &p);
                    }
                }
                // macOS convention (#2): closing the last window (⌘W) keeps the
                // app alive in the Dock; only an explicit quit ends the process.
                // exit(0) arrives with code Some(0). The implicit request (code
                // None, all windows closed) is held UNLESS a ⌘Q fan-out is in
                // flight — then the last confirmed close completes the quit.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    let quitting = _app.state::<AppState>().quitting.load(Ordering::SeqCst);
                    if code.is_none() && !quitting {
                        api.prevent_exit();
                    }
                }
                // Dock icon click with no windows: reopen a blank one.
                tauri::RunEvent::Reopen { has_visible_windows, .. }
                    if !has_visible_windows => {
                        let _ = spawn_window(_app, "");
                    }
                _ => {}
            }
        });
}

/// Minimal percent-decode for file:// paths delivered by RunEvent::Opened.
/// Fully byte-based (Cluster C / review #8): the old `&s[i+1..i+3]` str-slice
/// panicked when a multibyte char sat right after a '%' in a crafted plume://
/// URL — under panic=abort that was a remote crash of the whole app.
fn urlencoding_decode(s: &str) -> String {
    fn hex(b: u8) -> Option<u8> {
        (b as char).to_digit(16).map(|d| d as u8)
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod node_runtime_tests {
    use super::*;

    // A half-bump — NODE_VERSION moved but the pinned digests left stale —
    // would silently make every install fail verification (or, worse, pin the
    // wrong build). Fail loudly here instead.
    #[test]
    fn pinned_digests_match_node_version() {
        assert_eq!(NODE_TARBALL_SHA256.len(), 2, "expected one pin per supported arch");
        for (name, hash) in NODE_TARBALL_SHA256 {
            assert!(
                name.starts_with(&format!("node-{NODE_VERSION}-")),
                "pinned tarball {name} does not match NODE_VERSION {NODE_VERSION} — re-pin both digests when bumping"
            );
            assert!(name.ends_with(".tar.gz"), "unexpected archive form: {name}");
            assert_eq!(hash.len(), 64, "SHA-256 must be 64 hex chars: {name}");
            assert!(
                hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "digest must be lowercase hex (compared against a lowercase hex encoding): {name}"
            );
        }
    }

    // The tarball this build actually asks for must be one we pinned; if it
    // isn't, install fails closed with UNSUPPORTED rather than downloading
    // something unverifiable.
    #[test]
    fn this_platforms_tarball_is_pinned() {
        let name = format!("node-{NODE_VERSION}-darwin-{}.tar.gz", node_arch());
        assert!(pinned_sha256(&name).is_some(), "no pinned digest for {name}");
        assert!(pinned_sha256("node-v22.22.0-linux-x64.tar.gz").is_none());
        assert!(pinned_sha256("nonsense.tar.gz").is_none());
    }

    #[test]
    fn node_arch_is_a_known_value() {
        assert!(matches!(node_arch(), "arm64" | "x64"));
    }

    // P1: a candidate that HANGS on --version must be killed at the probe
    // deadline and skipped — not block resolution forever.
    #[test]
    #[cfg(unix)]
    fn node_runs_kills_hung_probe_at_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("plume-probe-hang-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let hung = dir.join("node-hung");
        // Distinctive duration so we can pgrep for exactly this descendant; the
        // trailing `true` stops sh from exec-optimizing sleep into the direct
        // child — the hang must live in a DESCENDANT to prove the group kill.
        fs::write(&hung, "#!/bin/sh\nsleep 30303\ntrue\n").unwrap();
        fs::set_permissions(&hung, fs::Permissions::from_mode(0o755)).unwrap();
        let working = dir.join("node-working");
        fs::write(&working, "#!/bin/sh\necho v22.22.0\nexit 0\n").unwrap();
        fs::set_permissions(&working, fs::Permissions::from_mode(0o755)).unwrap();

        let started = std::time::Instant::now();
        let picked = first_working_node([hung, working.clone()]);
        let elapsed = started.elapsed();
        assert_eq!(picked.as_deref(), Some(working.as_path()), "hung probe skipped, next candidate wins");
        assert!(
            elapsed < Duration::from_secs(NODE_PROBE_TIMEOUT_SECS + 5),
            "probe must give up at ~{NODE_PROBE_TIMEOUT_SECS}s, took {elapsed:?}"
        );

        // The group kill must take the forked descendant with it — poll until
        // the sentinel sleep is gone (signal delivery is async).
        let mut orphaned = true;
        for _ in 0..40 {
            let out = std::process::Command::new("pgrep")
                .args(["-f", "sleep 30303"])
                .output()
                .unwrap();
            if !out.status.success() || out.stdout.is_empty() {
                orphaned = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if orphaned {
            // Don't leak the sentinel on assertion failure.
            let _ = std::process::Command::new("pkill").args(["-f", "sleep 30303"]).status();
        }
        assert!(!orphaned, "descendant `sleep 30303` survived the process-group kill");
        let _ = fs::remove_dir_all(&dir);
    }

    // P2: the stderr drain keeps only a bounded tail no matter how much the
    // helper floods.
    #[test]
    fn read_tail_is_bounded_and_keeps_the_end() {
        let mb = 3 * 1024 * 1024;
        let mut input = vec![b'x'; mb];
        let marker = b"THE-ACTUAL-ERROR";
        let start = mb - marker.len();
        input[start..].copy_from_slice(marker);

        let tail = read_tail(std::io::Cursor::new(&input), 8 * 1024);
        assert_eq!(tail.len(), 8 * 1024, "capped at exactly the tail size");
        assert_eq!(&tail[..], &input[mb - 8 * 1024..], "keeps the END of the stream");
        assert!(tail.ends_with(marker), "the actual error survives");

        let short = read_tail(std::io::Cursor::new(b"tiny".to_vec()), 8 * 1024);
        assert_eq!(short, b"tiny", "short streams pass through untouched");
    }

    // F3: a candidate that exists but can't run (broken Homebrew node with a
    // missing dylib, wrong arch, no exec bit) must be SKIPPED, not selected —
    // a working node later in the list wins.
    #[test]
    #[cfg(unix)]
    fn first_working_node_skips_broken_candidates() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("plume-nodepick-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let write_fake = |name: &str, body: &str, mode: u32| -> PathBuf {
            let p = dir.join(name);
            fs::write(&p, body).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
            p
        };
        // Executable but exits non-zero — the broken-Homebrew shape.
        let broken = write_fake("node-broken", "#!/bin/sh\nexit 1\n", 0o755);
        // Exists but not executable at all.
        let noexec = write_fake("node-noexec", "#!/bin/sh\necho v0.0.0\n", 0o644);
        // Healthy.
        let working = write_fake("node-working", "#!/bin/sh\necho v22.22.0\nexit 0\n", 0o755);
        let missing = dir.join("node-missing");

        let picked = first_working_node([missing, broken.clone(), noexec, working.clone()]);
        assert_eq!(picked.as_deref(), Some(working.as_path()), "skips missing/broken/noexec, picks the runner");
        assert_eq!(first_working_node([broken]), None, "no working candidate → None");
        let _ = fs::remove_dir_all(&dir);
    }

    // Real network, ~50 MB download. Run explicitly:
    //   cargo test -- --ignored node_install_end_to_end
    // Set PLUME_NODE_TEST_DIR to install into a fixed dir and keep it (lets a
    // harness chain the installed runtime into a sidecar-level export check).
    #[test]
    #[ignore]
    fn node_install_end_to_end() {
        let (dir, keep) = match std::env::var("PLUME_NODE_TEST_DIR") {
            Ok(d) => (PathBuf::from(d), true),
            Err(_) => (std::env::temp_dir().join(format!("plume-node-test-{}", std::process::id())), false),
        };
        let _ = fs::remove_dir_all(&dir);
        let (path, ver) = install_node_runtime(&dir, &|_, _, _| {}).expect("install should succeed");
        assert!(path.is_file());
        assert!(ver.starts_with(NODE_VERSION), "got {ver}");
        assert_eq!(path, dir.join("node/bin/node"), "lands at the managed location");
        let out = std::process::Command::new(&path)
            .args(["-e", "console.log(21*2)"])
            .output()
            .expect("installed node should run");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "42");
        if !keep { let _ = fs::remove_dir_all(&dir); }
    }
}
