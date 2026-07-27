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
    // Canonical paths the renderer has flagged as having unsaved edits. writeDocument
    // refuses to clobber one of these (P1-4). Renderer pushes via set_doc_dirty.
    dirty_files: Mutex<HashSet<String>>,
    // Labels of windows holding a never-saved (untitled) buffer with unsaved edits.
    // Close of such a window is intercepted so the renderer can prompt (#4).
    untitled_dirty: Mutex<HashSet<String>>,
    // Per-launch secret written to ~/.plume/token (0600). Socket clients must present
    // it on every request (except ping). Defense-in-depth behind the 0600 socket.
    socket_token: Mutex<String>,
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
    let old = state.docs.lock().unwrap().insert(
        label.to_string(),
        DocState { path: path.to_string(), last_content: content.to_string(), _watcher: watcher },
    );
    // The window now holds a real file — it is no longer a dirty untitled buffer.
    state.untitled_dirty.lock().unwrap().remove(label);
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
        if let Ok(content) = fs::read_to_string(&file) {
            let st = app2.state::<AppState>();
            let mut changed = false;
            {
                let mut docs = st.docs.lock().unwrap();
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

#[tauri::command]
fn read_path(app: AppHandle, window: tauri::WebviewWindow, path: String) -> Result<ReadResult, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let recovery = recovery_for(&path);
    set_current(&app, window.label(), &path, &content);
    Ok(ReadResult { content, recovery })
}

#[tauri::command]
fn write_file(app: AppHandle, window: tauri::WebviewWindow, path: Option<String>, content: String) -> Result<String, String> {
    // Default target = THIS window's document. Falling back to a global "current"
    // here is what let an untitled window save over another window's file (#1).
    let target = match path {
        Some(p) => p,
        None => app
            .state::<AppState>()
            .docs
            .lock()
            .unwrap()
            .get(window.label())
            .map(|d| d.path.clone())
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "no current file".to_string())?,
    };
    fs::write(&target, &content).map_err(|e| e.to_string())?;
    set_current(&app, window.label(), &target, &content);
    Ok(target)
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
    let per_window = st.window_files.lock().unwrap().remove(window.label());
    let p = match per_window {
        Some(p) if p.is_empty() => return None,
        Some(p) => Some(p),
        None => st.initial.lock().unwrap().clone(),
    }?;
    let content = fs::read_to_string(&p).ok()?;
    let recovery = recovery_for(&p);
    // Consuming the pending entry moves the file into docs — write scope keeps it.
    set_current(&app, window.label(), &p, &content);
    Some(InitialFile { path: p, content, recovery })
}

fn spawn_window(app: &AppHandle, file_path: &str) -> Result<(), String> {
    let st = app.state::<AppState>();
    let label = format!("w{}", st.win_counter.fetch_add(1, Ordering::SeqCst));
    st.window_files.lock().unwrap().insert(label.clone(), file_path.to_string());
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
    // Window creation (and its initial_file content load) must run on the main
    // thread — commands run off it, so dispatch like the socket "open" path does.
    // Calling spawn_window directly built the window but left it empty.
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
fn node_runs(p: &Path) -> bool {
    use std::process::{Command, Stdio};
    Command::new(p)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
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
    let err_reader = child.stderr.take().map(|mut err| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf);
            buf
        })
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

// Find `<hex>  <file>` in Node's published SHASUMS256.txt.
fn shasum_for(shasums: &str, file: &str) -> Option<String> {
    shasums.lines().find_map(|l| {
        let (hash, name) = l.split_once(char::is_whitespace)?;
        (name.trim() == file).then(|| hash.trim().to_lowercase())
    })
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

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .build();

    let shasums = agent
        .get(&format!("{NODE_DIST_BASE}/{NODE_VERSION}/SHASUMS256.txt"))
        .call()
        .map_err(|e| dl(format!("couldn't fetch checksums: {e}")))?
        .into_string()
        .map_err(|e| dl(e.to_string()))?;
    let expected = shasum_for(&shasums, &tarball)
        .ok_or_else(|| ("VERIFY_FAILED".to_string(), format!("{tarball} not listed in SHASUMS256.txt")))?;

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
        .add_filter(&ext.to_uppercase(), &[ext])
        .set_file_name(&format!("{}.{}", default_name.unwrap_or_else(|| "document".into()), ext))
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
        return match fs::write(&p, html) {
            Ok(()) => json!({ "ok": true, "path": p }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
    }
    if ext == "docx" {
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
        .set_file_name(&format!("{}.pdf", default_name.unwrap_or_else(|| "document".into())))
        .blocking_save_file()?;
    let out = picked.into_path().ok()?.to_string_lossy().to_string();
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
        deliver_open(app, &p, None);
    }
    Some(p)
}

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Option<String> {
    open_via_dialog(&app)
}

#[tauri::command]
async fn save_dialog(app: AppHandle, window: tauri::WebviewWindow, content: String) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name("Untitled.md")
        .blocking_save_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    fs::write(&p, &content).ok()?;
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
    fs::create_dir_all(&base).ok()?;
    let path = unique_path(&base, &sanitize_stem(&name), "md");
    fs::write(&path, &content).ok()?;
    let p = path.to_string_lossy().to_string();
    // The buffer is now a real file — its untitled crash snapshot is obsolete.
    clear_untitled_recovery(window.label());
    set_current(&app, window.label(), &p, &content);
    Some(p)
}

// Rename the current file in place (same folder, new stem), collision-safe and
// never overwriting an existing file. Returns the new absolute path.
#[tauri::command]
fn rename_file(app: AppHandle, window: tauri::WebviewWindow, old_path: String, new_name: String) -> Option<String> {
    let old = PathBuf::from(&old_path);
    let dir = old.parent()?.to_path_buf();
    let ext = old.extension().and_then(|e| e.to_str()).unwrap_or("md").to_string();
    let stem = sanitize_stem(&new_name);
    let candidate = dir.join(format!("{}.{}", stem, ext));
    let new_path = if candidate == old { candidate } else { unique_path(&dir, &stem, &ext) };
    if new_path != old {
        fs::rename(&old, &new_path).ok()?;
    }
    let p = new_path.to_string_lossy().to_string();
    let content = fs::read_to_string(&p).unwrap_or_default();
    set_current(&app, window.label(), &p, &content);
    Some(p)
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let picked = app.dialog().file().blocking_pick_folder()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().to_string())
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
    let snap: Value = serde_json::from_str(&fs::read_to_string(&file).ok()?).ok()?;
    let snap_content = snap["content"].as_str()?.to_string();
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
        .lock()
        .unwrap()
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
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let key = format!("{}=", attr);
    let pos = lower.find(&key)? + key.len();
    let rest = &tag[pos..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)? + 1;
        Some(rest[1..end].to_string())
    } else {
        None
    }
}

fn extract_meta(html: &str, prop: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let p = prop.to_lowercase();
    let mut i = 0;
    while let Some(rel) = lower[i..].find("<meta") {
        let start = i + rel;
        let end = lower[start..].find('>').map(|e| start + e + 1).unwrap_or(html.len());
        let tag = &html[start..end];
        let tl = tag.to_lowercase();
        let hit = ["property", "name"].iter().any(|k| {
            tl.contains(&format!("{}=\"{}\"", k, p)) || tl.contains(&format!("{}='{}'", k, p))
        });
        if hit {
            if let Some(c) = extract_attr(tag, "content") {
                return Some(c);
            }
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
    let after = url.splitn(2, "://").nth(1)?;
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

// True only if the URL is http(s) AND every address the host resolves to is public.
fn url_is_safe(url: &str) -> bool {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    let (host, port) = match host_port(url) {
        Some(hp) => hp,
        None => return false,
    };
    match (host.as_str(), port).to_socket_addrs() {
        Ok(addrs) => {
            let mut any = false;
            for a in addrs {
                any = true;
                if !ip_is_public(&a.ip()) {
                    return false; // any private/loopback record fails the whole URL
                }
            }
            any
        }
        Err(_) => false,
    }
}

fn fetch_preview(url: &str) -> Value {
    if !url_is_safe(url) {
        return Value::Null;
    }
    // redirects(0): never follow a redirect — a public URL that 30x-redirects to an
    // internal host is the classic SSRF-via-redirect bypass. No follow, no bypass.
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(6))
        .redirects(0)
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
    let body = &body[..body.len().min(600_000)];
    let title = extract_meta(body, "og:title")
        .or_else(|| {
            let l = body.to_lowercase();
            let s = l.find("<title")?;
            let s = l[s..].find('>').map(|e| s + e + 1)?;
            let e = l[s..].find("</title>").map(|e| s + e)?;
            Some(body[s..e].trim().to_string())
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

#[tauri::command]
fn resolve_link(href: String, base: Option<String>) -> Option<String> {
    let base = base?;
    let dir = Path::new(&base).parent()?;
    let target = dir.join(&href);
    for cand in [
        target.clone(),
        target.with_extension("md"),
        target.with_extension("markdown"),
    ] {
        if cand.is_file() {
            // Don't resolve a relative link that escapes the user's home into a system
            // location (../../../../etc/passwd). Legitimate project links stay under home.
            let resolved = canonical_key(&cand);
            let home = home_dir();
            if home.as_os_str().len() > 1 && !resolved.starts_with(&home) {
                return None;
            }
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
fn list_dir(dir: String, depth: Option<i32>) -> Vec<Value> {
    walk(Path::new(&dir), depth.unwrap_or(3))
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
fn search_files(dir: String, query: String) -> Vec<Value> {
    if query.len() < 2 {
        return vec![];
    }
    let mut results = vec![];
    let mut scanned = 0;
    search_walk(Path::new(&dir), &query.to_lowercase(), &mut results, &mut scanned, 4);
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
fn load_annotations(path: Option<String>) -> Value {
    let p = match path {
        Some(p) => p,
        None => return json!([]),
    };
    let (_, file) = sidecar(&p);
    fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!([]))
}

#[tauri::command]
fn save_annotations(path: Option<String>, annotations: Value) -> bool {
    let p = match path {
        Some(p) => p,
        None => return false,
    };
    let (dir, file) = sidecar(&p);
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

// Discard the crash-recovery snapshot for the open file (banner "Discard").
#[tauri::command]
fn discard_recovery(app: AppHandle, window: tauri::WebviewWindow) {
    match window_doc_path(&app, window.label()) {
        Some(path) => { let _ = fs::remove_file(recovery_path(&path)); }
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

// Renderer-confirmed close of an untitled window (after its unsaved-changes
// prompt): the user chose to discard, so drop the dirty flag AND the crash
// snapshot (an explicit discard must not resurrect next launch), then destroy.
// destroy() skips CloseRequested, so this can't re-enter the prompt loop.
#[tauri::command]
fn close_window_now(app: AppHandle, window: tauri::WebviewWindow) {
    app.state::<AppState>().untitled_dirty.lock().unwrap().remove(window.label());
    clear_untitled_recovery(window.label());
    let _ = window.destroy();
}

// The renderer switched this window to an UNTITLED tab: unbind the previous
// file so snapshot/set_doc_dirty/save can't misroute into its slot. The path
// leaves the agent write scope too — matching what the window actually shows.
// Dirty flags for the old path are the renderer's to manage (it owns per-tab
// buffers); only the label-keyed state is reset here.
#[tauri::command]
fn detach_doc(window: tauri::WebviewWindow, state: tauri::State<AppState>) {
    let label = window.label().to_string();
    let old = state.docs.lock().unwrap().remove(&label);
    state.untitled_dirty.lock().unwrap().remove(&label);
    drop(old); // watcher drop outside the lock, same as set_current
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
    if let Ok(txt) = fs::read_to_string(home_dir().join(".codex/session_index.jsonl")) {
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
    files.sort_by(|a, b| file_mtime_ms(b).cmp(&file_mtime_ms(a)));
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
            if let Ok(txt) = fs::read_to_string(&p) {
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
    let mut scanned = 0;
    // One 4 MiB scratch buffer reused across candidates — not a fresh alloc per file
    // (which churned ~2 GB of transient allocation on a full 500-candidate scan).
    let mut buf = vec![0u8; 4 * 1024 * 1024];
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
                let lower = text.to_lowercase();
                if let Some(idx) = lower.find(&q) {
                    let start = idx.saturating_sub(40);
                    let snippet: String =
                        text[start..(idx + 90).min(text.len())].split_whitespace().collect::<Vec<_>>().join(" ");
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
fn list_context(dir: Option<String>) -> Vec<Value> {
    let dir = match dir {
        Some(d) => d,
        None => return vec![],
    };
    let mut out = vec![];
    for name in CONTEXT_FILES {
        let full = Path::new(&dir).join(name);
        if full.is_file() {
            out.push(json!({ "name": name, "path": full.to_string_lossy() }));
        }
    }
    out
}

// Read a file for inline insertion. Claude Code `.jsonl` transcripts are distilled
// to readable markdown — user/assistant prose only, most-recent kept. Transcripts
// run to hundreds of MB, so we tail-read the last ~6 MB rather than load it all.
#[tauri::command]
fn session_read(path: String) -> String {
    const TAIL: u64 = 6 * 1024 * 1024;
    const CAP: usize = 40000;
    let p = Path::new(&path);
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
    if let Some(tx) = app.state::<AppState>().pending.lock().unwrap().remove(&id) {
        let _ = tx.send(data);
    }
}

fn agent_query(app: &AppHandle, kind: &str) -> Value {
    let state = app.state::<AppState>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = std::sync::mpsc::channel();
    state.pending.lock().unwrap().insert(id, tx);
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
            state.pending.lock().unwrap().remove(&id);
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
    for d in st.docs.lock().unwrap().values() {
        if !d.path.is_empty() {
            set.insert(canonical_key(Path::new(&d.path)));
        }
    }
    for f in st.window_files.lock().unwrap().values() {
        if !f.is_empty() {
            set.insert(canonical_key(Path::new(f)));
        }
    }
    set
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

fn write_allowed(app: &AppHandle, target: &Path) -> bool {
    path_within_open_scope(&open_files(app), target)
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
// clobber a buffer with unsaved edits (P1-4). Keyed by canonical path. A null
// path means THIS window's untitled buffer — tracked by label so close can
// intercept and prompt before the content is lost (#4).
#[tauri::command]
fn set_doc_dirty(window: tauri::WebviewWindow, state: tauri::State<AppState>, path: Option<String>, dirty: bool) {
    match path {
        Some(p) => {
            let key = canonical_key(Path::new(&p)).to_string_lossy().to_string();
            let mut set = state.dirty_files.lock().unwrap();
            if dirty {
                set.insert(key);
            } else {
                set.remove(&key);
            }
        }
        None => {
            let mut set = state.untitled_dirty.lock().unwrap();
            if dirty {
                set.insert(window.label().to_string());
            } else {
                set.remove(window.label());
            }
        }
    }
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
fn deliver_open(app: &AppHandle, path: &str, line: Option<i64>) {
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
        let expected = app.state::<AppState>().socket_token.lock().unwrap().clone();
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
            if req["newWindow"].as_bool().unwrap_or(false) {
                if let Some(p) = req["path"].as_str() {
                    let appc = app.clone();
                    let path = p.to_string();
                    let _ = app.run_on_main_thread(move || { let _ = spawn_window(&appc, &path); });
                    return json!({ "ok": true });
                }
            }
            if let Some(p) = req["path"].as_str() {
                if !Path::new(p).is_file() {
                    return json!({ "ok": false, "error": "cannot read file" });
                }
                deliver_open(app, p, req["line"].as_i64());
                return json!({ "ok": true });
            }
            json!({ "ok": false, "error": "no path" })
        }
        "writeDocument" => match req["content"].as_str() {
            Some(content) if req["path"].is_string() => {
                let p = req["path"].as_str().unwrap();
                let target = canonical_key(Path::new(p));
                if !write_allowed(app, &target) {
                    json!({ "ok": false, "code": "outside_workspace",
                        "error": "refused: target is outside the open workspace (open the file or its folder in Plume first)" })
                } else if app.state::<AppState>().dirty_files.lock().unwrap()
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
                        json!({ "ok": true, "path": p, "annotations": load_annotations(Some(p.clone())) })
                    }
                }
                None => json!({ "ok": false, "error": "no path" }),
            }
        }
        "listOpenFiles" => {
            // Every window's document, with real dirty + focused flags — the old
            // single-global answer hid all but one window from agents.
            let focused = focused_label(app);
            let st = app.state::<AppState>();
            let files: Vec<Value> = {
                let docs = st.docs.lock().unwrap();
                let dirty = st.dirty_files.lock().unwrap();
                docs.iter()
                    .filter(|(_, d)| !d.path.is_empty())
                    .map(|(label, d)| {
                        let key = canonical_key(Path::new(&d.path)).to_string_lossy().to_string();
                        json!({
                            "path": d.path,
                            "dirty": dirty.contains(&key),
                            "focused": focused.as_deref() == Some(label.as_str()),
                        })
                    })
                    .collect()
            };
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
    *app.state::<AppState>().socket_token.lock().unwrap() = token.clone();
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
    *app.state::<AppState>().socket_token.lock().unwrap() = token.clone();
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
    *state.recents.lock().unwrap() = paths;
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
    let recents: Vec<String> = app.state::<AppState>().recents.lock().unwrap().clone();
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
    // No macOS app menu on Windows/Linux — Quit belongs under File there.
    #[cfg(not(target_os = "macos"))]
    {
        file_b = file_b.separator().quit();
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
        let app_menu = SubmenuBuilder::new(app, "Plume")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
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

/// Open a file path into the running app (used by single-instance + Opened events).
fn open_external_file(app: &AppHandle, p: &str) {
    if !Path::new(p).is_file() {
        return;
    }
    deliver_open(app, p, None);
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
            untitled_recovery,
            discard_untitled_recovery,
            close_window_now,
            detach_doc
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // "New" spawns a fresh blank window from the main process — the empty
            // path is the sentinel `initial_file` reads as "untitled".
            if id == "new" {
                let _ = spawn_window(app, "");
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
                // Closing a window with unsaved edits would destroy the only copy
                // (#4) — untitled OR path-backed (owner UAT decision: prompt over
                // silent auto-save). Hold the close and let the renderer run its
                // Save / Don't Save / Cancel prompt; it resolves via save /
                // materialize or close_window_now.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let st = app.state::<AppState>();
                    let dirty = match window_doc_path(app, &label) {
                        // Path-backed doc: dirty iff the renderer flagged its path.
                        Some(p) => {
                            let key = canonical_key(Path::new(&p)).to_string_lossy().to_string();
                            st.dirty_files.lock().unwrap().contains(&key)
                        }
                        // Untitled buffer: dirty iff flagged by window label.
                        None => st.untitled_dirty.lock().unwrap().contains(&label),
                    };
                    if dirty {
                        api.prevent_close();
                        let _ = app.emit_to(&label, "close-requested", json!({}));
                    }
                }
                // Window gone: retire its doc state so the agent write scope and
                // dirty set shrink with it (a dead window must not pin either).
                tauri::WindowEvent::Destroyed => {
                    let app = window.app_handle();
                    let st = app.state::<AppState>();
                    let old = st.docs.lock().unwrap().remove(&label);
                    if let Some(d) = &old {
                        if !d.path.is_empty() {
                            let key = canonical_key(Path::new(&d.path)).to_string_lossy().to_string();
                            st.dirty_files.lock().unwrap().remove(&key);
                        }
                    }
                    st.window_files.lock().unwrap().remove(&label);
                    st.untitled_dirty.lock().unwrap().remove(&label);
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
                    *app.state::<AppState>().initial.lock().unwrap() = Some(p.clone());
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
                            if Path::new(&p).is_file() {
                                deliver_open(&dl_handle, &p, line);
                            }
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
                // app alive in the Dock; only an explicit quit (⌘Q → exit code)
                // ends the process. exit(0) arrives with code Some(0), so only
                // the implicit all-windows-closed request (code None) is held.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                // Dock icon click with no windows: reopen a blank one.
                tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                    if !has_visible_windows {
                        let _ = spawn_window(_app, "");
                    }
                }
                _ => {}
            }
        });
}

/// Minimal percent-decode for file:// paths delivered by RunEvent::Opened.
fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
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

    #[test]
    fn shasum_parsing_matches_exact_file() {
        let shasums = "\
abc123DEF  node-v22.22.0-darwin-arm64.tar.gz
999888  node-v22.22.0-darwin-arm64.tar.xz
777666  node-v22.22.0-darwin-x64.tar.gz";
        assert_eq!(
            shasum_for(shasums, "node-v22.22.0-darwin-arm64.tar.gz").as_deref(),
            Some("abc123def")
        );
        assert_eq!(
            shasum_for(shasums, "node-v22.22.0-darwin-x64.tar.gz").as_deref(),
            Some("777666")
        );
        assert_eq!(shasum_for(shasums, "node-v22.22.0-linux-x64.tar.gz"), None);
    }

    #[test]
    fn node_arch_is_a_known_value() {
        assert!(matches!(node_arch(), "arm64" | "x64"));
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
