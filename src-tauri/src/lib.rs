mod api;
mod domain;
mod exports;
mod media;
mod openai;
mod paths;
mod processor;
mod queue;
mod settings;
mod store;
mod types;

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};

use crate::api::AppState;
use crate::media::FfmpegMedia;
use crate::processor::{JobProcessor, ProcessingTools};
use crate::queue::JobQueue;
use crate::settings::{Models, SettingsStore};
use crate::store::TranscriptStore;

/// The backend binds this port on 127.0.0.1; the frontend talks to it directly.
pub const BACKEND_PORT: u16 = 8787;

/// A developer running the standalone server already owns the port — don't fight them for it.
fn backend_already_running() -> bool {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, BACKEND_PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Resources are declared in tauri.conf.json as `resources/*`, so they keep that prefix inside
/// the bundle. The flat fallback keeps this working if that ever changes.
fn resource_root(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?;
    let nested = base.join("resources");
    let ffmpeg = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    Some(if nested.join(ffmpeg).is_file() {
        nested
    } else {
        base
    })
}

/// Everything the processor needs, wired to the real FFmpeg binary and OpenAI. This is the only
/// place adapters are constructed; the pipeline itself never learns where they came from.
struct Tools {
    media: FfmpegMedia,
    settings: Arc<SettingsStore>,
}

#[async_trait::async_trait]
impl ProcessingTools for Tools {
    async fn prepare(
        &self,
        input: &Path,
        job_id: &str,
    ) -> Result<Vec<crate::media::PreparedChunk>, String> {
        self.media.prepare(input, job_id).await
    }

    async fn transcribe(
        &self,
        chunk: &Path,
        languages: Option<Vec<String>>,
    ) -> Result<String, String> {
        // Read per job, not at boot, so a key saved in Settings takes effect without a restart.
        let key = self
            .settings
            .api_key()
            .ok_or("OPENAI_API_KEY is not configured.")?;
        let model = self.settings.models().transcribe.clone();
        crate::openai::transcribe(&key, &model, chunk, languages).await
    }

    async fn summarize(&self, transcript_text: &str) -> Result<String, String> {
        let key = self
            .settings
            .api_key()
            .ok_or("OPENAI_API_KEY is not configured.")?;
        let model = self.settings.models().summary.clone();
        crate::openai::summarize(&key, &model, transcript_text).await
    }
}

/// Builds the whole backend and serves it. Shared by the desktop app and the standalone dev
/// binary so there is exactly one composition root.
pub async fn serve(bundled_ffmpeg: Option<PathBuf>) -> Result<(), String> {
    // A developer's repo `.env` still works; a packaged app has none and uses Settings instead.
    let _ = dotenvy::dotenv();
    let app_data = paths::app_data_directory();
    let data_directory = app_data.join("transcripts");
    let work_directory = std::env::temp_dir().join("audio-transcriber");
    let upload_directory = work_directory.join("uploads");
    tokio::fs::create_dir_all(&data_directory)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(&upload_directory)
        .await
        .map_err(|e| e.to_string())?;

    let store = TranscriptStore::new(&data_directory);
    // The queue lives in memory, so anything left mid-flight by a crash is marked failed here.
    store.recover_interrupted().await?;

    let models = Models {
        transcribe: std::env::var("OPENAI_TRANSCRIBE_MODEL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| openai::DEFAULT_TRANSCRIBE_MODEL.to_string()),
        summary: std::env::var("OPENAI_SUMMARY_MODEL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| openai::DEFAULT_SUMMARY_MODEL.to_string()),
        chat: std::env::var("OPENAI_CHAT_MODEL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| openai::DEFAULT_CHAT_MODEL.to_string()),
    };
    let settings = Arc::new(SettingsStore::new(&app_data, models));
    settings.load().await;

    let ffmpeg = media::resolve_ffmpeg(bundled_ffmpeg.as_deref());
    log::info!("ffmpeg: {}", ffmpeg.display());
    let tools = Arc::new(Tools {
        media: FfmpegMedia::new(&work_directory, ffmpeg),
        settings: settings.clone(),
    });
    let processor = JobProcessor::new(store.clone(), tools);
    let queue = JobQueue::new(processor, store.clone());

    let state = Arc::new(AppState {
        store,
        settings,
        queue,
        upload_directory,
    });
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, BACKEND_PORT))
        .await
        .map_err(|e| format!("Could not bind 127.0.0.1:{BACKEND_PORT}: {e}"))?;
    log::info!("Audio Transcriber server: http://127.0.0.1:{BACKEND_PORT}");
    axum::serve(listener, api::router(state))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            if backend_already_running() {
                log::info!("127.0.0.1:{BACKEND_PORT} is already served; reusing that backend");
            } else {
                let root = resource_root(app.handle());
                // Baked in by scripts/prepare-resources.mjs from the build machine's .env, so a
                // private build never shows the "add your key" screen. Public CI has no key, so
                // the file is absent there and Settings takes over.
                if let Some(root) = &root {
                    if let Ok(key) = std::fs::read_to_string(root.join("api-key.txt")) {
                        if !key.trim().is_empty() {
                            unsafe { std::env::set_var("OPENAI_API_KEY", key.trim()) };
                        }
                    }
                }
                let bundled = root
                    .map(|root| root.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }));
                // The backend now runs inside this process, so there is no child to kill on exit
                // and no sidecar to keep alive — it goes when the app goes.
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = serve(bundled).await {
                        log::error!("backend stopped: {error}");
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event: RunEvent| {});
}
