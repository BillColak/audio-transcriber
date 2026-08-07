use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::domain::validate_audio_file;
use crate::exports::{safe_filename, to_markdown, to_text};
use crate::queue::JobQueue;
use crate::settings::SettingsStore;
use crate::store::{now, TranscriptStore};
use crate::types::{ChatMessage, LanguagePreference, Status, Transcript};

pub struct AppState {
    pub store: TranscriptStore,
    pub settings: Arc<SettingsStore>,
    pub queue: JobQueue,
    pub upload_directory: PathBuf,
}

type Shared = Arc<AppState>;

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/settings/test", post(test_settings))
        .route("/api/transcriptions", get(list).post(create))
        .route(
            "/api/transcriptions/{id}",
            get(read).patch(update).delete(remove),
        )
        .route("/api/transcriptions/{id}/chat", post(chat))
        .route("/api/transcriptions/{id}/download", get(download))
        // Uploads are up to 2 GB and stream straight to disk, so the default 2 MB cap is removed
        // here and the real limit is enforced by `validate_audio_file` on the bytes written.
        .layer(DefaultBodyLimit::disable())
        .layer(cors())
        .with_state(state)
}

/// The webview origin is not the dev server's, so both are allowed. Unlike the Express version
/// this rejects a disallowed origin outright rather than merely omitting the header, which closes
/// the cross-origin upload that could previously still reach the handler.
fn cors() -> tower_http::cors::CorsLayer {
    tower_http::cors::CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(
            |origin: &HeaderValue, _| {
                let Ok(origin) = origin.to_str() else {
                    return false;
                };
                origin == "tauri://localhost"
                    || origin == "https://tauri.localhost"
                    || origin == "http://tauri.localhost"
                    || origin.starts_with("http://127.0.0.1")
                    || origin.starts_with("http://localhost")
            },
        ))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
}

async fn get_settings(State(state): State<Shared>) -> Response {
    Json(state.settings.snapshot()).into_response()
}

#[derive(Deserialize)]
struct ApiKeyBody {
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
}

async fn put_settings(State(state): State<Shared>, Json(body): Json<ApiKeyBody>) -> Response {
    match state
        .settings
        .set_api_key(&body.api_key.unwrap_or_default())
        .await
    {
        Ok(()) => Json(state.settings.snapshot()).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

async fn test_settings(State(state): State<Shared>, Json(body): Json<ApiKeyBody>) -> Response {
    let typed = body.api_key.unwrap_or_default();
    // An empty field means "test the key already saved".
    let key = if typed.trim().is_empty() {
        state.settings.api_key().unwrap_or_default()
    } else {
        typed
    };
    let models = state.settings.models();
    let wanted = vec![
        models.transcribe.clone(),
        models.summary.clone(),
        models.chat.clone(),
    ];
    Json(crate::openai::verify_key(&key, &wanted).await).into_response()
}

async fn list(State(state): State<Shared>) -> Response {
    match state.store.list().await {
        Ok(items) => Json(items).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn read(State(state): State<Shared>, AxumPath(id): AxumPath<String>) -> Response {
    match state.store.get(&id).await {
        Ok(Some(transcript)) => Json(transcript).into_response(),
        _ => error(StatusCode::NOT_FOUND, "Transcript not found."),
    }
}

async fn create(State(state): State<Shared>, mut multipart: Multipart) -> Response {
    let mut upload_path: Option<PathBuf> = None;
    let mut original_name = String::new();
    let mut written: u64 = 0;
    let mut language_field = String::new();
    let mut summarize_field = String::new();

    while let Ok(Some(mut field)) = multipart.next_field().await {
        match field.name().unwrap_or_default() {
            "audio" => {
                original_name = field.file_name().unwrap_or("audio").to_string();
                if tokio::fs::create_dir_all(&state.upload_directory)
                    .await
                    .is_err()
                {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed.");
                }
                let path = state.upload_directory.join(uuid::Uuid::new_v4().to_string());
                let Ok(mut file) = tokio::fs::File::create(&path).await else {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed.");
                };
                // Streamed to disk rather than buffered: a 2 GB recording must never sit in RAM.
                while let Ok(Some(chunk)) = field.chunk().await {
                    written += chunk.len() as u64;
                    if file.write_all(&chunk).await.is_err() {
                        let _ = tokio::fs::remove_file(&path).await;
                        return error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed.");
                    }
                }
                let _ = file.flush().await;
                upload_path = Some(path);
            }
            "language" => language_field = field.text().await.unwrap_or_default(),
            "summarize" => summarize_field = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }

    let Some(path) = upload_path else {
        return error(StatusCode::BAD_REQUEST, "Choose an audio file.");
    };

    let language = match language_field.as_str() {
        "indonesian" => Some(LanguagePreference::Indonesian),
        "auto" | "" => Some(LanguagePreference::Auto),
        _ => None,
    };
    let validation = validate_audio_file(&original_name, written);
    if validation.is_err() || language.is_none() {
        let _ = tokio::fs::remove_file(&path).await;
        let message = match validation {
            Err(message) => message,
            Ok(()) => "Unsupported language selection.".to_string(),
        };
        return error(StatusCode::BAD_REQUEST, &message);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let stamp = now();
    let transcript = Transcript {
        id: id.clone(),
        title: PathBuf::from(&original_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| original_name.clone()),
        source_name: original_name,
        language: language.unwrap(),
        status: Status::Queued,
        progress: 0,
        created_at: stamp.clone(),
        updated_at: stamp,
        duration_seconds: 0.0,
        segments: vec![],
        text: String::new(),
        error: None,
        summarize: summarize_field == "true",
        summary: None,
        summary_error: None,
        chat_messages: vec![],
    };
    if state.store.save(&transcript).await.is_err() {
        let _ = tokio::fs::remove_file(&path).await;
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed.");
    }
    state.queue.enqueue(&id, path);
    (
        StatusCode::ACCEPTED,
        Json(json!({ "id": id, "status": "queued" })),
    )
        .into_response()
}

async fn update(
    State(state): State<Shared>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let Ok(Some(mut transcript)) = state.store.get(&id).await else {
        return error(StatusCode::NOT_FOUND, "Transcript not found.");
    };
    if let Some(title) = body["title"].as_str() {
        if !title.trim().is_empty() {
            transcript.title = title.trim().chars().take(160).collect();
        }
    }
    if let Some(text) = body["text"].as_str() {
        transcript.text = text.chars().take(1_000_000).collect();
    }
    if let Some(edits) = body["segments"].as_array() {
        for edit in edits {
            let (Some(edit_id), Some(text)) = (edit["id"].as_str(), edit["text"].as_str()) else {
                continue;
            };
            if let Some(segment) = transcript.segments.iter_mut().find(|s| s.id == edit_id) {
                segment.text = text.chars().take(20_000).collect();
            }
        }
    }
    transcript.updated_at = now();
    match state.store.save(&transcript).await {
        Ok(()) => Json(transcript).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn chat(
    State(state): State<Shared>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let Ok(Some(transcript)) = state.store.get(&id).await else {
        return error(StatusCode::NOT_FOUND, "Transcript not found.");
    };
    let question: String = body["question"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .chars()
        .take(4_000)
        .collect();
    if question.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Ask a question.");
    }
    let text = transcript.text.trim().to_string();
    if text.is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "There is no transcript text to chat about yet.",
        );
    }
    let Some(key) = state.settings.api_key() else {
        return error(
            StatusCode::BAD_GATEWAY,
            "OpenAI rejected the API key. Check it in Settings.",
        );
    };
    let model = state.settings.models().chat.clone();
    let answer = match crate::openai::ask(&key, &model, &text, &transcript.chat_messages, &question)
        .await
    {
        Ok(answer) => answer,
        Err(message) => {
            return error(
                StatusCode::BAD_GATEWAY,
                &crate::openai::humanize_chat_error(&message),
            )
        }
    };

    // Answering takes seconds, and the record may have been edited meanwhile. Re-read it so the
    // reply appends to whatever is current instead of restoring the copy read above.
    let Ok(Some(mut current)) = state.store.get(&id).await else {
        return error(StatusCode::NOT_FOUND, "Transcript not found.");
    };
    let stamp = now();
    current.chat_messages.push(ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: "user".into(),
        content: question,
        created_at: stamp.clone(),
    });
    current.chat_messages.push(ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: "assistant".into(),
        content: answer,
        created_at: stamp.clone(),
    });
    current.updated_at = stamp;
    match state.store.save(&current).await {
        Ok(()) => Json(current).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

async fn remove(State(state): State<Shared>, AxumPath(id): AxumPath<String>) -> Response {
    if state.queue.cancel(&id).await {
        return (StatusCode::ACCEPTED, Json(json!({ "status": "cancelling" }))).into_response();
    }
    match state.store.delete(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, &message),
    }
}

#[derive(Deserialize)]
struct DownloadQuery {
    format: Option<String>,
}

async fn download(
    State(state): State<Shared>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<DownloadQuery>,
) -> Response {
    let Ok(Some(transcript)) = state.store.get(&id).await else {
        return error(StatusCode::NOT_FOUND, "Transcript not found.");
    };
    let format = query.format.unwrap_or_default();
    if format != "txt" && format != "md" {
        return error(StatusCode::BAD_REQUEST, "Format must be txt or md.");
    }
    if format == "md" && transcript.summary.is_none() {
        return error(StatusCode::NOT_FOUND, "This transcript has no summary.");
    }
    let (body, mime) = if format == "md" {
        (to_markdown(&transcript), "text/markdown")
    } else {
        (to_text(&transcript), "text/plain")
    };
    let filename = format!("{}.{format}", safe_filename(&transcript.title));
    (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    )
        .into_response()
}
