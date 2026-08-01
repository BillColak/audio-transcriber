use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The Express backend binds this port on 127.0.0.1; the frontend talks to it directly.
const BACKEND_PORT: u16 = 8787;

/// Holds the sidecar so it can be killed when the app closes.
#[derive(Default)]
struct Backend(Mutex<Option<CommandChild>>);

/// A developer running `npm run dev` already owns the port — don't fight them for it.
fn backend_already_running() -> bool {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, BACKEND_PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Resources are declared in tauri.conf.json as `resources/*`, so they keep that prefix
/// inside the bundle. The flat fallback keeps this working if that ever changes.
fn resource_root(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = app.path().resource_dir()?;
    let nested = base.join("resources");
    Ok(if nested.join("server.mjs").is_file() {
        nested
    } else {
        base
    })
}

/// The sidecar binary is a plain Node runtime, so the backend is handed to it as a script argument.
fn spawn_backend(app: &AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let root = resource_root(app)?;
    let script = root.join("server.mjs");
    if !script.is_file() {
        return Err(format!("bundled backend is missing at {}", script.display()).into());
    }
    let ffmpeg = root.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

    let mut env = HashMap::new();
    env.insert(
        "AUDIO_TRANSCRIBER_FFMPEG".to_string(),
        ffmpeg.to_string_lossy().to_string(),
    );

    // Baked in by scripts/prepare-sidecar.mjs from the build machine's .env, so this private,
    // never-publicly-distributed build never shows the in-app "add your key" screen.
    let api_key_file = root.join("api-key.txt");
    if let Ok(key) = std::fs::read_to_string(&api_key_file) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            env.insert("OPENAI_API_KEY".to_string(), trimmed.to_string());
        }
    }

    let (mut events, child) = app
        .shell()
        .sidecar("server")?
        .args([script.to_string_lossy().to_string()])
        .envs(env)
        .spawn()?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("backend: {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("backend: {}", String::from_utf8_lossy(&line).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!("backend exited with {:?}", payload.code);
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(Backend::default())
        .setup(|app| {
            if backend_already_running() {
                log::info!("127.0.0.1:{BACKEND_PORT} is already served; reusing that backend");
            } else {
                match spawn_backend(app.handle()) {
                    Ok(child) => {
                        *app.state::<Backend>().0.lock().unwrap() = Some(child);
                        log::info!("backend starting on 127.0.0.1:{BACKEND_PORT}");
                    }
                    // The window still opens: the frontend retries, then explains itself.
                    Err(error) => log::error!("could not start the backend: {error}"),
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
