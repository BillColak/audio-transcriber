use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Processing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePreference {
    Auto,
    Indonesian,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: String,
    #[serde(rename = "startSeconds")]
    pub start_seconds: f64,
    #[serde(rename = "endSeconds")]
    pub end_seconds: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Mirrors the JSON the TypeScript backend wrote, field for field. Records on disk predate this
/// port, so every field added after the original release stays optional and is filled in by
/// `serde(default)` rather than failing the whole read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcript {
    pub id: String,
    pub title: String,
    #[serde(rename = "sourceName")]
    pub source_name: String,
    pub language: LanguagePreference,
    pub status: Status,
    pub progress: u8,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: f64,
    pub segments: Vec<Segment>,
    #[serde(default)]
    pub text: String,
    pub error: Option<String>,
    #[serde(default)]
    pub summarize: bool,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "summaryError")]
    pub summary_error: Option<String>,
    #[serde(default, rename = "chatMessages")]
    pub chat_messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsSnapshot {
    #[serde(rename = "hasApiKey")]
    pub has_api_key: bool,
    #[serde(rename = "keySource")]
    pub key_source: Option<String>,
    #[serde(rename = "transcribeModel")]
    pub transcribe_model: String,
    #[serde(rename = "summaryModel")]
    pub summary_model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyCheck {
    pub ok: bool,
    pub message: String,
}
