use std::path::Path;

use serde_json::{json, Value};

use crate::types::{ChatMessage, KeyCheck};

pub const DEFAULT_TRANSCRIBE_MODEL: &str = "gpt-transcribe";
pub const DEFAULT_SUMMARY_MODEL: &str = "gpt-5.6-terra";
pub const DEFAULT_CHAT_MODEL: &str = "gpt-5.6-terra";

/// A cost guard rather than a capacity limit — the models hold far more than this.
const MAX_INPUT_CHARACTERS: usize = 800_000;
/// All Q&A is persisted, but only the most recent turns are replayed to the model.
const MAX_HISTORY_MESSAGES: usize = 20;

const API_BASE: &str = "https://api.openai.com/v1";

const SUMMARY_INSTRUCTIONS: &str = "\
You write detailed meeting minutes from raw transcripts, for someone who was not in the room.
Use plain Markdown with exactly these sections, in order:
## Overview — a short paragraph: what the meeting was about, who took part, and what came out of it.
## Discussion — the substance, grouped under `###` headings by topic. Cover what was said, who said it where the transcript makes that clear, and why it mattered. Give enough detail that someone who missed the meeting follows the reasoning, not just the conclusion.
## Decisions — what was agreed and the reasoning behind each. Write \"None recorded.\" if there were none.
## Action items — bullets as \"Owner — task (deadline)\". Use \"Unassigned\" when no owner is named.
## Open questions — anything raised but left unresolved. Write \"None recorded.\" if there were none.
Be thorough. A two-hour conversation should not collapse into a handful of bullets.
Write in everyday language, and spell out jargon or acronyms the first time they appear.
Write in the transcript's own language.
The transcript is machine-generated from audio and will contain mishearings. Work out from the surrounding context what was actually meant and write that, rather than repeating a garbled phrase. Where a passage is genuinely unintelligible, say so plainly instead of guessing.
Never invent details, names, numbers, or commitments the transcript does not support.";

const CHAT_INSTRUCTIONS: &str = "\
You answer questions about a single transcript, using only the transcript text provided.
If the answer is not in the transcript, say so plainly rather than guessing.
The transcript is machine-generated from audio and will contain mishearings. Work out from the surrounding context what was meant rather than taking a garbled phrase literally, and say when a passage is genuinely unintelligible instead of guessing.
Answer in the same language as the question when reasonable, otherwise match the transcript's own language.
Keep answers concise unless the user asks for detail.";

fn truncate(text: &str) -> &str {
    match text.char_indices().nth(MAX_INPUT_CHARACTERS) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A 20-minute chunk of audio can take a while to come back; the default is far too short.
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())
}

async fn read_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("{status}: {detail}")
}

/// `gpt-transcribe` with plain `response_format: json` — the only format it supports. The
/// `languages` parameter is sent as repeated `languages[]` fields, which is exactly how the
/// OpenAI SDK encodes an array in multipart. Sending a singular `language` does nothing.
pub async fn transcribe(
    api_key: &str,
    model: &str,
    file: &Path,
    languages: Option<Vec<String>>,
) -> Result<String, String> {
    let bytes = tokio::fs::read(file).await.map_err(|e| e.to_string())?;
    let filename = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio.mp3".into());

    let codes = languages.unwrap_or_default();

    with_retries(|| async {
        // The form is not cloneable, so it is rebuilt per attempt from the bytes already read.
        let part = reqwest::multipart::Part::bytes(bytes.clone())
            .file_name(filename.clone())
            .mime_str("audio/mpeg")
            .map_err(|e| e.to_string())?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("model", model.to_string())
            .text("response_format", "json");
        for code in codes.clone() {
            form = form.text("languages[]", code);
        }
        let response = client()?
            .post(format!("{API_BASE}/audio/transcriptions"))
            .bearer_auth(api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(read_error(response).await);
        }
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        body["text"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "OpenAI returned no transcription text.".to_string())
    })
    .await
}

/// No `temperature` or `max_tokens`: the gpt-5 family rejects both on chat completions.
/// The OpenAI SDK the TypeScript backend used retried twice by default. Without that a single
/// 429 or 5xx kills a two-hour job that has already cost real money, so it is reproduced here.
/// Only transient failures are retried — an authentication error is returned immediately.
async fn with_retries<F, Fut>(attempt: F) -> Result<String, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let mut last = String::new();
    for tries in 0..3u32 {
        match attempt().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let transient = contains_any(&error, &["429", "500", "502", "503", "504", "timeout", "connect"])
                    && !contains_any(&error, &["401", "invalid api key", "invalid_api_key"]);
                last = error;
                if !transient || tries == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(tries))).await;
            }
        }
    }
    Err(last)
}

async fn chat_completion(
    api_key: &str,
    model: &str,
    messages: Vec<Value>,
    reasoning_effort: Option<&str>,
) -> Result<String, String> {
    let mut payload = json!({ "model": model, "messages": messages });
    if let Some(effort) = reasoning_effort {
        payload["reasoning_effort"] = json!(effort);
    }
    with_retries(|| async {
        let response = client()?
            .post(format!("{API_BASE}/chat/completions"))
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(read_error(response).await);
        }
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        let content = body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("OpenAI returned an empty response.".into());
        }
        Ok(content)
    })
    .await
}

pub async fn summarize(api_key: &str, model: &str, transcript: &str) -> Result<String, String> {
    let text = transcript.trim();
    if text.is_empty() {
        return Err("There is no transcript text to summarise.".into());
    }
    chat_completion(
        api_key,
        model,
        vec![
            json!({ "role": "system", "content": SUMMARY_INSTRUCTIONS }),
            json!({ "role": "user", "content": truncate(text) }),
        ],
        // Minutes are written once and kept, so buy accuracy with reasoning effort.
        Some("high"),
    )
    .await
}

pub async fn ask(
    api_key: &str,
    model: &str,
    transcript: &str,
    history: &[ChatMessage],
    question: &str,
) -> Result<String, String> {
    let text = transcript.trim();
    if text.is_empty() {
        return Err("There is no transcript text to chat about.".into());
    }
    let mut messages = vec![
        json!({ "role": "system", "content": CHAT_INSTRUCTIONS }),
        json!({ "role": "user", "content": format!("Transcript:\n\n{}", truncate(text)) }),
    ];
    let start = history.len().saturating_sub(MAX_HISTORY_MESSAGES);
    for message in &history[start..] {
        messages.push(json!({ "role": message.role, "content": message.content }));
    }
    messages.push(json!({ "role": "user", "content": question }));
    chat_completion(api_key, model, messages, None).await
}

/// Listing models costs no tokens, and answers both questions that matter: is the key valid, and
/// can this account actually reach the models this app is configured to use?
pub async fn verify_key(api_key: &str, models: &[String]) -> KeyCheck {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return KeyCheck {
            ok: false,
            message: "Enter an API key first.".into(),
        };
    }
    let client = match client() {
        Ok(client) => client,
        Err(error) => {
            return KeyCheck {
                ok: false,
                message: humanize_key_error(&error),
            }
        }
    };
    let response = match client
        .get(format!("{API_BASE}/models"))
        .bearer_auth(trimmed)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return KeyCheck {
                ok: false,
                message: humanize_key_error(&error.to_string()),
            }
        }
    };
    if !response.status().is_success() {
        return KeyCheck {
            ok: false,
            message: humanize_key_error(&read_error(response).await),
        };
    }
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(error) => {
            return KeyCheck {
                ok: false,
                message: humanize_key_error(&error.to_string()),
            }
        }
    };
    let available: Vec<&str> = body["data"]
        .as_array()
        .map(|items| items.iter().filter_map(|m| m["id"].as_str()).collect())
        .unwrap_or_default();

    let mut missing: Vec<String> = Vec::new();
    for model in models {
        if !available.contains(&model.as_str()) && !missing.contains(model) {
            missing.push(model.clone());
        }
    }
    if !missing.is_empty() {
        let plural = if missing.len() > 1 {
            "those models"
        } else {
            "that model"
        };
        return KeyCheck {
            ok: false,
            message: format!(
                "The key is valid, but this account cannot use {}. Enable {plural} on your OpenAI account, or set an override.",
                missing.join(" or ")
            ),
        };
    }
    KeyCheck {
        ok: true,
        message: "The key works, and every model this app needs is available.".into(),
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

pub fn humanize_key_error(message: &str) -> String {
    if contains_any(message, &["401", "unauthorized", "invalid api key", "invalid_api_key", "incorrect api key"]) {
        return "OpenAI rejected this key. Check it was copied in full.".into();
    }
    if contains_any(message, &["429", "quota", "billing"]) {
        return "The key is valid but the account is out of quota, or billing is not set up.".into();
    }
    if contains_any(message, &["dns", "connect", "timeout", "network", "unreachable"]) {
        return "Could not reach OpenAI. Check this computer is online.".into();
    }
    format!("Could not verify the key: {message}")
}

pub fn humanize_error(message: &str) -> String {
    if contains_any(message, &["api key", "api-key", "api_key", "apikey", "401", "authentication"]) {
        return "OpenAI rejected the API key. Check it in Settings.".into();
    }
    format!("Transcription failed: {message}")
}

pub fn humanize_summary_error(message: &str) -> String {
    if contains_any(message, &["api key", "api-key", "api_key", "apikey", "401", "authentication"]) {
        return "OpenAI rejected the API key, so the summary was skipped.".into();
    }
    format!("The transcript is complete, but the summary failed: {message}")
}

pub fn humanize_chat_error(message: &str) -> String {
    if contains_any(message, &["api key", "api-key", "api_key", "apikey", "401", "authentication"]) {
        return "OpenAI rejected the API key. Check it in Settings.".into();
    }
    format!("The question could not be answered: {message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_an_auth_failure_to_a_pointed_message() {
        assert_eq!(
            humanize_error("401 authentication failed"),
            "OpenAI rejected the API key. Check it in Settings."
        );
        assert_eq!(
            humanize_summary_error("401 Unauthorized"),
            "OpenAI rejected the API key, so the summary was skipped."
        );
        assert_eq!(
            humanize_key_error("401 Unauthorized"),
            "OpenAI rejected this key. Check it was copied in full."
        );
    }

    #[test]
    fn keeps_an_unrecognised_failure_visible() {
        assert_eq!(
            humanize_error("connection reset"),
            "Transcription failed: connection reset"
        );
        assert!(humanize_summary_error("rate limited").contains("transcript is complete"));
    }

    #[test]
    fn distinguishes_quota_from_a_bad_key() {
        assert!(humanize_key_error("429 quota exceeded").contains("out of quota"));
        assert!(humanize_key_error("dns error").contains("online"));
    }

    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        // Indonesian and other non-ASCII transcripts must not panic on a byte-index slice.
        let text = "é".repeat(MAX_INPUT_CHARACTERS + 100);
        let cut = truncate(&text);
        assert_eq!(cut.chars().count(), MAX_INPUT_CHARACTERS);
    }

    #[test]
    fn short_text_is_left_alone() {
        assert_eq!(truncate("halo"), "halo");
    }

    #[test]
    fn a_missing_key_still_tells_the_user_where_to_fix_it() {
        // The Rust adapter reports `OPENAI_API_KEY is not configured.`, which a list of literal
        // "api key" spellings would miss, leaving the user with a raw internal string.
        assert_eq!(
            humanize_error("OPENAI_API_KEY is not configured."),
            "OpenAI rejected the API key. Check it in Settings."
        );
        assert!(humanize_summary_error("OPENAI_API_KEY is not configured.")
            .contains("summary was skipped"));
    }

    #[tokio::test]
    async fn retries_a_transient_failure_and_then_succeeds() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let calls = AtomicU32::new(0);
        let result = with_retries(|| async {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("429 rate limited".to_string())
            } else {
                Ok("done".to_string())
            }
        })
        .await;
        assert_eq!(result.unwrap(), "done");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn never_retries_an_authentication_failure() {
        use std::sync::atomic::{AtomicU32, Ordering};
        let calls = AtomicU32::new(0);
        // Retrying a bad key just burns time on a job that cannot succeed.
        let result = with_retries(|| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err("401 invalid api key".to_string())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
