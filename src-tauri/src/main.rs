// Plume — Tauri v2 shell.
//
// The renderer (CodeMirror) is webview-portable; this provides the native side
// over the same `window.plume` API (see tauri/tauri-bridge.js). See
// src-tauri/MIGRATION.md for what is ported vs remaining.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
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

#[derive(Default)]
struct AppState {
    current: Mutex<Option<String>>,
    initial: Mutex<Option<String>>,
    last_content: Mutex<Option<String>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    next_id: AtomicU64,
    window_files: Mutex<HashMap<String, String>>,
    win_counter: AtomicU64,
    recents: Mutex<Vec<String>>, // recent file paths for the File > Open Recent menu
    // Canonical paths the renderer has flagged as having unsaved edits. writeDocument
    // refuses to clobber one of these (P1-4). Renderer pushes via set_doc_dirty.
    dirty_files: Mutex<HashSet<String>>,
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
fn set_current(app: &AppHandle, path: &str, content: &str) {
    let state = app.state::<AppState>();
    *state.current.lock().unwrap() = Some(path.to_string());
    *state.last_content.lock().unwrap() = Some(content.to_string());
    start_watcher(app, path);
}

fn start_watcher(app: &AppHandle, path: &str) {
    let state = app.state::<AppState>();
    *state.watcher.lock().unwrap() = None; // drop the old watcher
    let dir = match Path::new(path).parent() {
        Some(d) => d.to_path_buf(),
        None => return,
    };
    let file = path.to_string();
    let app2 = app.clone();
    // Re-read the tracked file on any event in its directory and emit only when
    // the content actually changed. Avoids fragile path matching (e.g. /tmp vs
    // /private/tmp) and naturally ignores our own writes via the content compare.
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        if let Ok(content) = fs::read_to_string(&file) {
            let st = app2.state::<AppState>();
            let mut last = st.last_content.lock().unwrap();
            if last.as_deref() != Some(content.as_str()) {
                *last = Some(content.clone());
                let _ = app2.emit("file-changed", json!({ "content": content }));
            }
        }
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    // Watch the canonical dir so FSEvents reliably delivers.
    let watch_dir = fs::canonicalize(&dir).unwrap_or(dir);
    let _ = watcher.watch(&watch_dir, RecursiveMode::NonRecursive);
    *state.watcher.lock().unwrap() = Some(watcher);
}

// ---- core file commands ----
#[derive(serde::Serialize)]
struct ReadResult {
    content: String,
    recovery: Option<String>,
}

#[tauri::command]
fn read_path(app: AppHandle, path: String) -> Result<ReadResult, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let recovery = recovery_for(&path);
    set_current(&app, &path, &content);
    Ok(ReadResult { content, recovery })
}

#[tauri::command]
fn write_file(app: AppHandle, path: Option<String>, content: String) -> Result<String, String> {
    let target = match path {
        Some(p) => p,
        None => app
            .state::<AppState>()
            .current
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no current file".to_string())?,
    };
    fs::write(&target, &content).map_err(|e| e.to_string())?;
    set_current(&app, &target, &content);
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
    set_current(&app, &p, &content);
    Some(InitialFile { path: p, content, recovery })
}

fn spawn_window(app: &AppHandle, file_path: &str) -> Result<(), String> {
    let st = app.state::<AppState>();
    let label = format!("w{}", st.win_counter.fetch_add(1, Ordering::SeqCst));
    st.window_files.lock().unwrap().insert(label.clone(), file_path.to_string());
    let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
        .title("Plume")
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

fn run_sidecar(app: &AppHandle, req: &Value) -> Value {
    use std::process::{Command, Stdio};
    let script = match sidecar_script(app) {
        Some(p) => p,
        None => return json!({ "ok": false, "error": "export sidecar not found" }),
    };
    let mut child = match Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return json!({ "ok": false, "error": "Node.js not found on PATH — it's required for DOCX and Google Docs export. Install Node 18+ and restart Plume." }),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(req.to_string().as_bytes());
    }
    match child.wait_with_output() {
        Ok(o) => serde_json::from_slice(&o.stdout).unwrap_or(json!({ "ok": false, "error": "no result" })),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
async fn export_doc(app: AppHandle, format: String, html: String, default_name: Option<String>) -> Option<String> {
    let ext = match format.as_str() { "html" => "html", "pdf" => "pdf", "docx" => "docx", _ => "html" };
    let picked = app
        .dialog()
        .file()
        .add_filter(&ext.to_uppercase(), &[ext])
        .set_file_name(&format!("{}.{}", default_name.unwrap_or_else(|| "document".into()), ext))
        .blocking_save_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    if ext == "html" {
        fs::write(&p, html).ok()?;
        return Some(p);
    }
    if ext == "docx" {
        let res = run_sidecar(&app, &json!({ "cmd": "docx", "html": html, "out": p }));
        return if res["ok"] == true { Some(p) } else { None };
    }
    None // pdf — see MIGRATION.md
}

#[tauri::command]
async fn publish_google(app: AppHandle, markdown: String, default_name: Option<String>) -> Value {
    run_sidecar(&app, &json!({ "cmd": "gdocs", "markdown": markdown, "defaultName": default_name }))
}

// ---- PDF export: render HTML in a hidden WKWebView, then WKWebView.createPDF ----
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
        let win = match tauri::WebviewWindowBuilder::new(&app_main, &label_main, tauri::WebviewUrl::App("index.html".into()))
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
        let win = match tauri::WebviewWindowBuilder::new(&app_main, &label_main, tauri::WebviewUrl::App("index.html".into()))
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
    let _ = open::that(url);
}

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "mdx", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    if let Ok(content) = fs::read_to_string(&p) {
        let recovery = recovery_for(&p);
        set_current(&app, &p, &content);
        let _ = app.emit("file-opened", json!({ "filePath": p, "content": content, "recovery": recovery }));
    }
    Some(p)
}

#[tauri::command]
async fn save_dialog(app: AppHandle, content: String) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name("Untitled.md")
        .blocking_save_file()?;
    let path = picked.into_path().ok()?;
    let p = path.to_string_lossy().to_string();
    fs::write(&p, &content).ok()?;
    set_current(&app, &p, &content);
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
fn materialize_doc(app: AppHandle, dir: Option<String>, name: String, content: String) -> Option<String> {
    let base = match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => default_plume_dir(),
    };
    fs::create_dir_all(&base).ok()?;
    let path = unique_path(&base, &sanitize_stem(&name), "md");
    fs::write(&path, &content).ok()?;
    let p = path.to_string_lossy().to_string();
    set_current(&app, &p, &content);
    Some(p)
}

// Rename the current file in place (same folder, new stem), collision-safe and
// never overwriting an existing file. Returns the new absolute path.
#[tauri::command]
fn rename_file(app: AppHandle, old_path: String, new_name: String) -> Option<String> {
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
    set_current(&app, &p, &content);
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
    let key = if project_key.trim().is_empty() { "_global".to_string() } else { project_key };
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
fn assets_rel(app: &AppHandle, ext: &str) -> Option<(PathBuf, String)> {
    let cur = app.state::<AppState>().current.lock().unwrap().clone()?;
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
fn save_image(app: AppHandle, bytes: Vec<u8>, ext: String) -> Option<String> {
    let (path, rel) = assets_rel(&app, &ext)?;
    fs::write(path, bytes).ok()?;
    Some(rel)
}

#[tauri::command]
async fn pick_image(app: AppHandle) -> Value {
    if app.state::<AppState>().current.lock().unwrap().is_none() {
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
    match assets_rel(&app, ext) {
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

fn fetch_preview(url: &str) -> Value {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(6)).build();
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
    let name = format!("{}.notes.json", p.file_name().unwrap().to_string_lossy());
    let file = dir.join(name);
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
#[tauri::command]
fn snapshot(app: AppHandle, content: String) {
    let cur = app.state::<AppState>().current.lock().unwrap().clone();
    if let Some(path) = cur {
        let file = recovery_path(&path);
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, json!({ "filePath": path, "content": content }).to_string());
    }
}

// Discard the crash-recovery snapshot for the open file (banner "Discard").
#[tauri::command]
fn discard_recovery(app: AppHandle) {
    let cur = app.state::<AppState>().current.lock().unwrap().clone();
    if let Some(path) = cur {
        let _ = fs::remove_file(recovery_path(&path));
    }
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
            let mut buf = vec![0u8; 4 * 1024 * 1024];
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
        Err(_) => json!({ "ok": false, "error": "renderer timeout" }),
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

// The files Plume currently has open: the focused doc plus every window's file.
fn open_files(app: &AppHandle) -> HashSet<PathBuf> {
    let st = app.state::<AppState>();
    let mut set = HashSet::new();
    if let Some(c) = st.current.lock().unwrap().clone() {
        set.insert(canonical_key(Path::new(&c)));
    }
    for f in st.window_files.lock().unwrap().values() {
        set.insert(canonical_key(Path::new(f)));
    }
    set
}

// A write is allowed iff its canonical target is (a) a file Plume already has open,
// or (b) inside the workspace root the MCP server declared (its real cwd). The agent
// can't make the MCP server lie about its own cwd, and the socket is owner-only
// (0600), so a prompt-injected agent can't escalate write_document into an arbitrary
// write to ~/.ssh, a sibling repo, or a git hook. See SECURITY.md.
fn write_allowed(app: &AppHandle, target: &Path, root: Option<&str>) -> bool {
    if open_files(app).contains(target) {
        return true;
    }
    if let Some(r) = root {
        let rc = canonical_key(Path::new(r));
        if rc.as_os_str().len() > 1 && target.starts_with(&rc) {
            return true;
        }
    }
    false
}

// The renderer reports per-document dirty state so writeDocument can refuse to
// clobber a buffer with unsaved edits (P1-4). Keyed by canonical path.
#[tauri::command]
fn set_doc_dirty(state: tauri::State<AppState>, path: Option<String>, dirty: bool) {
    let Some(p) = path else { return };
    let key = canonical_key(Path::new(&p)).to_string_lossy().to_string();
    let mut set = state.dirty_files.lock().unwrap();
    if dirty {
        set.insert(key);
    } else {
        set.remove(&key);
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
        if !expected.is_empty() && req["token"].as_str().unwrap_or("") != expected {
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
                if let Ok(content) = fs::read_to_string(p) {
                    set_current(app, p, &content);
                    let line = req["line"].clone();
                    let _ = app.emit("file-opened", json!({ "filePath": p, "content": content, "gotoLine": line }));
                    focus_main(app);
                    return json!({ "ok": true });
                }
                return json!({ "ok": false, "error": "cannot read file" });
            }
            json!({ "ok": false, "error": "no path" })
        }
        "writeDocument" => match req["content"].as_str() {
            Some(content) if req["path"].is_string() => {
                let p = req["path"].as_str().unwrap();
                let target = canonical_key(Path::new(p));
                let root = req["root"].as_str();
                if !write_allowed(app, &target, root) {
                    json!({ "ok": false, "code": "outside_workspace",
                        "error": format!("refused: {} is outside the workspace and is not open in Plume", p) })
                } else if app.state::<AppState>().dirty_files.lock().unwrap()
                    .contains(&target.to_string_lossy().to_string())
                {
                    json!({ "ok": false, "code": "dirty_conflict",
                        "error": format!("refused: {} has unsaved changes open in Plume — save or discard first", p) })
                } else {
                    match fs::write(p, content) {
                        Ok(_) => json!({ "ok": true, "path": p }),
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    }
                }
            }
            _ => json!({ "ok": false, "error": "path and content required" }),
        },
        "getAnnotations" => {
            let p = req["path"].as_str().map(|s| s.to_string()).or_else(|| {
                app.state::<AppState>().current.lock().unwrap().clone()
            });
            match p {
                Some(p) => json!({ "ok": true, "path": p, "annotations": load_annotations(Some(p.clone())) }),
                None => json!({ "ok": false, "error": "no path" }),
            }
        }
        "listOpenFiles" => {
            let cur = app.state::<AppState>().current.lock().unwrap().clone();
            json!({ "ok": true, "files": [{ "path": cur, "dirty": false, "focused": true }] })
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
fn handle_conn<S: Read + Write>(app: &AppHandle, stream: S) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
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

    let file = SubmenuBuilder::new(app, "File")
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
        .item(&PredefinedMenuItem::close_window(app, Some("Close"))?)
        .build()?;

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

    let format = SubmenuBuilder::new(app, "Format")
        .item(&mi("format:bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&mi("format:italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&mi("format:code", "Inline Code", Some("CmdOrCtrl+E"))?)
        .item(&mi("format:link", "Link", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&mi("addNote", "Add Note for Agent", Some("CmdOrCtrl+J"))?)
        .separator()
        .item(&mi("heading:1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&mi("heading:2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&mi("heading:3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&mi("heading:0", "Body Text", Some("CmdOrCtrl+0"))?)
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

    let menu = MenuBuilder::new(app)
        .item(&file)
        .item(&edit)
        .item(&format)
        .item(&view)
        .item(&go)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Open a file path into the running app (used by single-instance + Opened events).
fn open_external_file(app: &AppHandle, p: &str) {
    if !Path::new(p).is_file() {
        return;
    }
    if let Ok(content) = fs::read_to_string(p) {
        let recovery = recovery_for(p);
        set_current(app, p, &content);
        let _ = app.emit("file-opened", json!({ "filePath": p, "content": content, "recovery": recovery }));
        focus_main(app);
    }
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
            set_doc_dirty
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // "New" spawns a fresh blank window from the main process — the empty
            // path is the sentinel `initial_file` reads as "untitled".
            if id == "new" {
                let _ = spawn_window(app, "");
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
            let _ = app.emit("menu", json!({ "channel": format!("menu:{}", base), "arg": arg_val }));
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let args: Vec<String> = std::env::args().collect();
            if let Some(p) = args.iter().skip(1).find(|a| !a.starts_with('-')) {
                if Path::new(p).is_file() {
                    *app.state::<AppState>().initial.lock().unwrap() = Some(p.clone());
                }
            }
            let _ = build_and_set_menu(&handle);
            start_socket(handle.clone());

            // plume://open?path=/abs/file.md deep links
            use tauri_plugin_deep_link::DeepLinkExt;
            let _ = app.deep_link().register("plume");
            let dl_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let s = url.to_string();
                    if let Some(q) = s.split('?').nth(1) {
                        for kv in q.split('&') {
                            if let Some(p) = kv.strip_prefix("path=") {
                                open_external_file(&dl_handle, &urlencoding_decode(p));
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
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    let s = url.to_string();
                    let p = s.strip_prefix("file://").unwrap_or(&s);
                    let p = urlencoding_decode(p);
                    open_external_file(_app, &p);
                }
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
