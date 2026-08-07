use std::path::PathBuf;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::types::SettingsSnapshot;

pub const MIN_API_KEY_LENGTH: usize = 20;

#[derive(Serialize, Deserialize, Default)]
struct StoredSettings {
    #[serde(rename = "openaiApiKey")]
    openai_api_key: Option<String>,
}

pub struct Models {
    pub transcribe: String,
    pub summary: String,
    pub chat: String,
}

/// Holds the OpenAI key for a packaged app, where there is no repo `.env` to read. A key saved
/// here wins over the environment, so the in-app screen always has an effect; a developer who
/// never opens that screen keeps using their `.env`.
pub struct SettingsStore {
    directory: PathBuf,
    models: Models,
    stored: RwLock<Option<String>>,
}

impl SettingsStore {
    pub fn new(directory: impl Into<PathBuf>, models: Models) -> Self {
        Self {
            directory: directory.into(),
            models,
            stored: RwLock::new(None),
        }
    }

    fn file(&self) -> PathBuf {
        self.directory.join("settings.json")
    }

    pub async fn load(&self) {
        let stored = match tokio::fs::read_to_string(self.file()).await {
            Ok(raw) => serde_json::from_str::<StoredSettings>(&raw)
                .ok()
                .and_then(|s| s.openai_api_key)
                .filter(|key| !key.trim().is_empty())
                .map(|key| key.trim().to_string()),
            Err(_) => None,
        };
        *self.stored.write().unwrap() = stored;
    }

    /// An `OPENAI_API_KEY=` line with nothing after it counts as no key at all.
    fn from_environment() -> Option<String> {
        std::env::var("OPENAI_API_KEY")
            .ok()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
    }

    pub fn api_key(&self) -> Option<String> {
        self.stored
            .read()
            .unwrap()
            .clone()
            .or_else(Self::from_environment)
    }

    pub fn snapshot(&self) -> SettingsSnapshot {
        let saved = self.stored.read().unwrap().clone();
        SettingsSnapshot {
            has_api_key: self.api_key().is_some(),
            key_source: if saved.is_some() {
                Some("settings".into())
            } else if Self::from_environment().is_some() {
                Some("environment".into())
            } else {
                None
            },
            transcribe_model: self.models.transcribe.clone(),
            summary_model: self.models.summary.clone(),
        }
    }

    pub fn models(&self) -> &Models {
        &self.models
    }

    pub async fn set_api_key(&self, key: &str) -> Result<(), String> {
        let trimmed = key.trim();
        if trimmed.len() < MIN_API_KEY_LENGTH {
            return Err("That does not look like an OpenAI API key.".into());
        }
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        let body = serde_json::to_string_pretty(&StoredSettings {
            openai_api_key: Some(trimmed.to_string()),
        })
        .map_err(|e| e.to_string())?;
        tokio::fs::write(self.file(), body)
            .await
            .map_err(|e| e.to_string())?;
        // The file holds a credential, so keep it to the owner where the OS supports that.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(self.file(), std::fs::Permissions::from_mode(0o600))
                .await;
        }
        *self.stored.write().unwrap() = Some(trimmed.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Models {
        Models {
            transcribe: "gpt-transcribe".into(),
            summary: "gpt-5.6-terra".into(),
            chat: "gpt-5.6-terra".into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("audio-transcriber-settings-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn rejects_something_that_is_not_a_key() {
        let store = SettingsStore::new(scratch("reject"), models());
        assert_eq!(
            store.set_api_key("nope").await.unwrap_err(),
            "That does not look like an OpenAI API key."
        );
    }

    #[tokio::test]
    async fn a_saved_key_wins_over_the_environment_and_is_never_exposed() {
        let store = SettingsStore::new(scratch("precedence"), models());
        store.load().await;
        store.set_api_key("sk-saved-in-the-app-1234567890").await.unwrap();

        assert_eq!(
            store.api_key().as_deref(),
            Some("sk-saved-in-the-app-1234567890")
        );
        let snapshot = store.snapshot();
        assert!(snapshot.has_api_key);
        assert_eq!(snapshot.key_source.as_deref(), Some("settings"));
        // The snapshot is what goes over HTTP; it must never carry the key itself.
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("sk-saved"));
    }

    #[tokio::test]
    async fn survives_a_settings_file_that_is_corrupt() {
        let dir = scratch("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), "{ not json").unwrap();

        let store = SettingsStore::new(&dir, models());
        store.load().await;

        assert_eq!(store.snapshot().key_source, None);
    }
}
