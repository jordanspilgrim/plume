// Plume — Tauri v2 shell (reshell foundation).
//
// The renderer (CodeMirror) is webview-portable; this provides the native side
// over the same `window.plume` API (see tauri/tauri-bridge.js). Core file
// surface is ported here; remaining Electron-main features are tracked in
// src-tauri/MIGRATION.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct AppState {
    current: Mutex<Option<String>>,
    initial: Mutex<Option<String>>,
}

#[tauri::command]
fn read_path(path: String, state: tauri::State<AppState>) -> Result<String, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    *state.current.lock().unwrap() = Some(path);
    Ok(content)
}

#[tauri::command]
fn write_file(
    path: Option<String>,
    content: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let target = match path {
        Some(p) => p,
        None => state
            .current
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "no current file".to_string())?,
    };
    fs::write(&target, content).map_err(|e| e.to_string())?;
    *state.current.lock().unwrap() = Some(target.clone());
    Ok(target)
}

#[derive(serde::Serialize)]
struct InitialFile {
    path: String,
    content: String,
}

#[tauri::command]
fn initial_file(state: tauri::State<AppState>) -> Option<InitialFile> {
    let p = state.initial.lock().unwrap().clone()?;
    let content = fs::read_to_string(&p).ok()?;
    *state.current.lock().unwrap() = Some(p.clone());
    Some(InitialFile { path: p, content })
}

#[tauri::command]
fn open_external(url: String) {
    let _ = open::that(url);
}

const IGNORE_DIRS: [&str; 9] = [
    "node_modules", ".git", "dist", "release", ".cache", "__pycache__", ".next", ".venv", "assets",
];

fn walk(dir: &Path, depth: i32) -> Vec<serde_json::Value> {
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
        let is_dir = full.is_dir();
        if is_dir {
            let children = if depth > 0 { walk(&full, depth - 1) } else { vec![] };
            out.push(serde_json::json!({
                "name": name, "path": full.to_string_lossy(), "type": "dir", "children": children
            }));
        } else {
            out.push(serde_json::json!({
                "name": name, "path": full.to_string_lossy(), "type": "file"
            }));
        }
    }
    // dirs first
    out.sort_by(|a, b| {
        let ad = a["type"] == "dir";
        let bd = b["type"] == "dir";
        bd.cmp(&ad)
    });
    out
}

#[tauri::command]
fn list_dir(dir: String, depth: Option<i32>) -> Vec<serde_json::Value> {
    walk(Path::new(&dir), depth.unwrap_or(3))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            read_path,
            write_file,
            initial_file,
            open_external,
            list_dir
        ])
        .setup(|app| {
            // Capture a file passed on the command line (e.g. `plume note.md`).
            let args: Vec<String> = std::env::args().collect();
            if let Some(p) = args.iter().skip(1).find(|a| !a.starts_with('-')) {
                if Path::new(p).is_file() {
                    *app.state::<AppState>().initial.lock().unwrap() = Some(p.clone());
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Plume");
}
