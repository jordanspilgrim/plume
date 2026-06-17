// Plume — Tauri v2 shell.
//
// The renderer (CodeMirror) is webview-portable; this provides the native side
// over the same `window.plume` API (see tauri/tauri-bridge.js). See
// src-tauri/MIGRATION.md for what is ported vs remaining.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
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
}

fn plume_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".plume")
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
#[tauri::command]
fn read_path(app: AppHandle, path: String) -> Result<String, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    set_current(&app, &path, &content);
    Ok(content)
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
}

#[tauri::command]
fn initial_file(app: AppHandle) -> Option<InitialFile> {
    let p = app.state::<AppState>().initial.lock().unwrap().clone()?;
    let content = fs::read_to_string(&p).ok()?;
    set_current(&app, &p, &content);
    Some(InitialFile { path: p, content })
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
        set_current(&app, &p, &content);
        let _ = app.emit("file-opened", json!({ "filePath": p, "content": content }));
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
        let dir = plume_dir().join("recovery");
        let _ = fs::create_dir_all(&dir);
        let mut hash: u64 = 1469598103934665603;
        for b in path.bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(1099511628211);
        }
        let file = dir.join(format!("{:x}.json", hash));
        let _ = fs::write(file, json!({ "filePath": path, "content": content }).to_string());
    }
}

// ---- Claude Code sessions + context ----
fn claude_projects() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".claude/projects")
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
    json!({ "path": file.to_string_lossy(), "title": title, "ts": ts })
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
    out.sort_by(|a, b| b["ts"].as_u64().cmp(&a["ts"].as_u64()));
    out.truncate(80);
    out
}

#[tauri::command]
fn search_sessions(query: String, dir: Option<String>) -> Vec<Value> {
    if query.len() < 2 {
        return vec![];
    }
    let q = query.to_lowercase();
    let mut results = vec![];
    let mut scanned = 0;
    'outer: for pd in project_dirs(&dir) {
        if let Ok(entries) = fs::read_dir(&pd) {
            for e in entries.flatten() {
                if results.len() >= 40 || scanned > 500 {
                    break 'outer;
                }
                if e.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                scanned += 1;
                if let Ok(mut f) = fs::File::open(e.path()) {
                    let mut buf = vec![0u8; 4 * 1024 * 1024];
                    if let Ok(n) = f.read(&mut buf) {
                        let text = String::from_utf8_lossy(&buf[..n]);
                        let lower = text.to_lowercase();
                        if let Some(idx) = lower.find(&q) {
                            let start = idx.saturating_sub(40);
                            let snippet: String =
                                text[start..(idx + 90).min(text.len())].split_whitespace().collect::<Vec<_>>().join(" ");
                            let mut meta = session_meta(&e.path());
                            meta["snippet"] = json!(snippet);
                            results.push(meta);
                        }
                    }
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
    let _ = app.emit("agent-request", json!({ "id": id, "kind": kind }));
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

// ---- control socket (the `plume` CLI + MCP server talk here) ----
fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn dispatch(app: &AppHandle, req: &Value) -> Value {
    match req["cmd"].as_str().unwrap_or("") {
        "ping" => json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
        "focus" => {
            focus_main(app);
            json!({ "ok": true })
        }
        "open" => {
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
                match fs::write(p, content) {
                    Ok(_) => json!({ "ok": true, "path": p }),
                    Err(e) => json!({ "ok": false, "error": e.to_string() }),
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
        "getActiveDocument" => agent_query(app, "getActiveDocument"),
        "getSelection" => agent_query(app, "getSelection"),
        other => json!({ "ok": false, "error": format!("unknown cmd: {}", other) }),
    }
}

fn start_socket(app: AppHandle) {
    std::thread::spawn(move || {
        let sock = plume_dir().join("plume.sock");
        let _ = fs::create_dir_all(plume_dir());
        let _ = fs::remove_file(&sock);
        let listener = match std::os::unix::net::UnixListener::bind(&sock) {
            Ok(l) => l,
            Err(_) => return,
        };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut writer = match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let reader = BufReader::new(stream);
                for line in reader.lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                    let resp = dispatch(&app, &req);
                    if writeln!(writer, "{}", resp).is_err() {
                        break;
                    }
                }
            });
        }
    });
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

    let file = SubmenuBuilder::new(app, "File")
        .item(&mi("open", "Open…", Some("CmdOrCtrl+O"))?)
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            read_path,
            write_file,
            initial_file,
            open_external,
            open_dialog,
            save_dialog,
            resolve_link,
            list_dir,
            search_files,
            load_annotations,
            save_annotations,
            snapshot,
            list_sessions,
            search_sessions,
            list_context,
            agent_reply
        ])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
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
            start_socket(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Plume");
}
