use std::path::{Path, PathBuf};

use crate::types::{Status, Transcript};

#[derive(Clone)]
pub struct TranscriptStore {
    directory: PathBuf,
}

impl TranscriptStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// Ids come straight off the URL, so they are whitelisted rather than sanitised. Anything
    /// outside this set cannot become a path at all.
    fn file(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Invalid transcript id.".into());
        }
        Ok(self.directory.join(format!("{id}.json")))
    }

    pub async fn save(&self, transcript: &Transcript) -> Result<(), String> {
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        let path = self.file(&transcript.id)?;
        let body = serde_json::to_string_pretty(transcript).map_err(|e| e.to_string())?;
        tokio::fs::write(path, body).await.map_err(|e| e.to_string())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Transcript>, String> {
        let path = self.file(id)?;
        match tokio::fs::read_to_string(&path).await {
            Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn list(&self) -> Result<Vec<Transcript>, String> {
        tokio::fs::create_dir_all(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        let mut entries = tokio::fs::read_dir(&self.directory)
            .await
            .map_err(|e| e.to_string())?;
        let mut transcripts = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // One unreadable record must not take the whole history down with it.
            match tokio::fs::read_to_string(&path).await {
                Ok(raw) => match serde_json::from_str::<Transcript>(&raw) {
                    Ok(transcript) => transcripts.push(transcript),
                    Err(error) => log::warn!("skipping unreadable transcript {path:?}: {error}"),
                },
                Err(error) => log::warn!("could not read {path:?}: {error}"),
            }
        }
        transcripts.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(transcripts)
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let path = self.file(id)?;
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// The queue lives in memory, so anything mid-flight when the app stopped is gone. Mark those
    /// records failed at boot rather than leaving them spinning forever.
    pub async fn recover_interrupted(&self) -> Result<(), String> {
        for mut transcript in self.list().await? {
            if matches!(transcript.status, Status::Queued | Status::Processing) {
                transcript.status = Status::Failed;
                transcript.error = Some("Processing was interrupted when the app stopped.".into());
                transcript.updated_at = now();
                self.save(&transcript).await?;
            }
        }
        Ok(())
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

pub fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::LanguagePreference;

    fn sample(id: &str) -> Transcript {
        Transcript {
            id: id.to_string(),
            title: "Rapat".into(),
            source_name: "rapat.mp3".into(),
            language: LanguagePreference::Indonesian,
            status: Status::Queued,
            progress: 0,
            created_at: now(),
            updated_at: now(),
            duration_seconds: 0.0,
            segments: vec![],
            text: String::new(),
            error: None,
            summarize: false,
            summary: None,
            summary_error: None,
            chat_messages: vec![],
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("audio-transcriber-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn saves_and_reads_a_transcript_back() {
        let store = TranscriptStore::new(scratch("roundtrip"));
        store.save(&sample("abc-123")).await.unwrap();
        let loaded = store.get("abc-123").await.unwrap().unwrap();
        assert_eq!(loaded.title, "Rapat");
        assert!(store.get("missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn refuses_an_id_that_could_escape_the_directory() {
        let store = TranscriptStore::new(scratch("traversal"));
        assert!(store.get("../../etc/passwd").await.is_err());
        assert!(store.get("a/b").await.is_err());
        assert!(store.delete("..").await.is_err());
        assert!(store.get("").await.is_err());
    }

    #[tokio::test]
    async fn marks_interrupted_records_failed_at_boot() {
        let store = TranscriptStore::new(scratch("recover"));
        let mut processing = sample("in-flight");
        processing.status = Status::Processing;
        store.save(&processing).await.unwrap();

        store.recover_interrupted().await.unwrap();

        let recovered = store.get("in-flight").await.unwrap().unwrap();
        assert_eq!(recovered.status, Status::Failed);
        assert!(recovered.error.unwrap().contains("interrupted"));
    }

    #[tokio::test]
    async fn reads_a_record_written_before_the_summary_and_chat_fields_existed() {
        let dir = scratch("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        // Exactly the shape the first release wrote: no text, summary, or chatMessages.
        std::fs::write(
            dir.join("old.json"),
            r#"{"id":"old","title":"Old","sourceName":"old.mp3","language":"auto",
                "status":"completed","progress":100,"createdAt":"2026-01-01T00:00:00.000Z",
                "updatedAt":"2026-01-01T00:00:00.000Z","durationSeconds":3,
                "segments":[{"id":"0-0","startSeconds":0,"endSeconds":3,"text":"hello"}],
                "error":null}"#,
        )
        .unwrap();

        let loaded = TranscriptStore::new(&dir).get("old").await.unwrap().unwrap();
        assert_eq!(loaded.title, "Old");
        assert!(loaded.chat_messages.is_empty());
        assert_eq!(loaded.summary, None);
    }
}
