use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::domain::{chunk_segment, join_segments, language_codes};
use crate::media::PreparedChunk;
use crate::store::{now, TranscriptStore};
use crate::types::{Segment, Status};

/// Everything the processor needs from the outside world. Injecting it keeps the pipeline
/// testable without FFmpeg or OpenAI, exactly as the TypeScript version did.
#[async_trait::async_trait]
pub trait ProcessingTools: Send + Sync {
    async fn prepare(&self, input: &Path, job_id: &str) -> Result<Vec<PreparedChunk>, String>;
    async fn transcribe(
        &self,
        chunk: &Path,
        languages: Option<Vec<String>>,
    ) -> Result<String, String>;
    async fn summarize(&self, transcript_text: &str) -> Result<String, String>;
}

const CANCELLED: &str = "CANCELLED";

#[derive(Clone)]
pub struct JobProcessor {
    store: TranscriptStore,
    tools: Arc<dyn ProcessingTools>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl JobProcessor {
    pub fn new(store: TranscriptStore, tools: Arc<dyn ProcessingTools>) -> Self {
        Self {
            store,
            tools,
            cancelled: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn cancel(&self, id: &str) {
        self.cancelled.lock().unwrap().insert(id.to_string());
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled.lock().unwrap().contains(id)
    }

    pub async fn process(&self, id: &str, upload_path: &Path) {
        let mut chunk_paths: Vec<PathBuf> = Vec::new();
        let outcome = self.run(id, upload_path, &mut chunk_paths).await;

        if let Err(error) = outcome {
            if let Ok(Some(mut transcript)) = self.store.get(id).await {
                let cancelled = self.is_cancelled(id) || error == CANCELLED;
                transcript.status = if cancelled {
                    Status::Cancelled
                } else {
                    Status::Failed
                };
                transcript.error = if cancelled {
                    None
                } else {
                    Some(crate::openai::humanize_error(&error))
                };
                transcript.updated_at = now();
                let _ = self.store.save(&transcript).await;
            }
        }

        // Always runs: the upload and every chunk are deleted whether the job succeeded, failed,
        // or was cancelled. Audio never lingers on disk.
        self.cancelled.lock().unwrap().remove(id);
        let mut files: Vec<PathBuf> = vec![upload_path.to_path_buf()];
        files.extend(chunk_paths);
        files.sort();
        files.dedup();
        for file in files {
            let _ = tokio::fs::remove_file(file).await;
        }
    }

    async fn run(
        &self,
        id: &str,
        upload_path: &Path,
        chunk_paths: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        let Some(mut transcript) = self.store.get(id).await? else {
            return Ok(());
        };
        transcript.status = Status::Processing;
        transcript.progress = 2;
        transcript.updated_at = now();
        self.store.save(&transcript).await?;

        let chunks = self.tools.prepare(upload_path, id).await?;
        chunk_paths.extend(chunks.iter().map(|chunk| chunk.path.clone()));

        let mut segments: Vec<Segment> = Vec::new();
        let mut offset = 0.0_f64;
        for (index, chunk) in chunks.iter().enumerate() {
            if self.is_cancelled(id) {
                return Err(CANCELLED.into());
            }
            let text = self
                .tools
                .transcribe(&chunk.path, language_codes(transcript.language))
                .await?;
            segments.push(chunk_segment(&text, offset, chunk.duration_seconds, index));
            offset += chunk.duration_seconds;

            // Same arithmetic as before: leave headroom at the end for summarisation.
            let span = if transcript.summarize { 80.0 } else { 88.0 };
            transcript.progress =
                (10.0 + ((index + 1) as f64 / chunks.len() as f64) * span).round() as u8;
            transcript.segments = segments.clone();
            transcript.text = join_segments(&segments);
            transcript.duration_seconds = offset;
            transcript.updated_at = now();
            // Saved after every chunk so progress and partial results survive a crash.
            self.store.save(&transcript).await?;
        }

        if transcript.summarize {
            if self.is_cancelled(id) {
                return Err(CANCELLED.into());
            }
            self.summarize(id, &segments).await?;
        }

        let mut completed = self.store.get(id).await?.unwrap_or(transcript);
        completed.status = Status::Completed;
        completed.progress = 100;
        completed.error = None;
        completed.updated_at = now();
        self.store.save(&completed).await
    }

    /// A failed summary never fails the job — the transcript itself is still worth keeping.
    async fn summarize(&self, id: &str, segments: &[Segment]) -> Result<(), String> {
        let Some(mut transcript) = self.store.get(id).await? else {
            return Ok(());
        };
        transcript.progress = 92;
        transcript.updated_at = now();
        self.store.save(&transcript).await?;

        let text = join_segments(segments);
        if text.is_empty() {
            transcript.summary_error = Some("There was no transcript text to summarise.".into());
            return self.store.save(&transcript).await;
        }
        match self.tools.summarize(&text).await {
            Ok(summary) => {
                transcript.summary = Some(summary);
                transcript.summary_error = None;
            }
            Err(error) => {
                transcript.summary = None;
                transcript.summary_error = Some(crate::openai::humanize_summary_error(&error));
            }
        }
        transcript.updated_at = now();
        self.store.save(&transcript).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LanguagePreference, Transcript};

    struct Fake {
        chunks: Vec<f64>,
        transcripts: Vec<String>,
        summary: Result<String, String>,
        fail_prepare: bool,
    }

    #[async_trait::async_trait]
    impl ProcessingTools for Fake {
        async fn prepare(&self, _input: &Path, _job: &str) -> Result<Vec<PreparedChunk>, String> {
            if self.fail_prepare {
                return Err("The file did not contain readable audio.".into());
            }
            Ok(self
                .chunks
                .iter()
                .enumerate()
                .map(|(i, seconds)| PreparedChunk {
                    path: std::env::temp_dir().join(format!("fake-chunk-{i}.mp3")),
                    duration_seconds: *seconds,
                })
                .collect())
        }
        async fn transcribe(&self, chunk: &Path, _l: Option<Vec<String>>) -> Result<String, String> {
            let name = chunk.file_name().unwrap().to_string_lossy().to_string();
            let index: usize = name
                .trim_start_matches("fake-chunk-")
                .trim_end_matches(".mp3")
                .parse()
                .unwrap();
            Ok(self.transcripts[index].clone())
        }
        async fn summarize(&self, _text: &str) -> Result<String, String> {
            self.summary.clone()
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("audio-transcriber-proc-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn seed(store: &TranscriptStore, id: &str, summarize: bool) -> Transcript {
        let transcript = Transcript {
            id: id.into(),
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
            summarize,
            summary: None,
            summary_error: None,
            chat_messages: vec![],
        };
        store.save(&transcript).await.unwrap();
        transcript
    }

    #[tokio::test]
    async fn stitches_chunks_into_one_offset_timeline() {
        let dir = scratch("timeline");
        let store = TranscriptStore::new(&dir);
        seed(&store, "job", false).await;
        let upload = dir.join("upload.mp3");
        std::fs::write(&upload, b"x").unwrap();

        let processor = JobProcessor::new(
            store.clone(),
            Arc::new(Fake {
                chunks: vec![1200.0, 600.0],
                transcripts: vec!["first".into(), "second".into()],
                summary: Ok("unused".into()),
                fail_prepare: false,
            }),
        );
        processor.process("job", &upload).await;

        let done = store.get("job").await.unwrap().unwrap();
        assert_eq!(done.status, Status::Completed);
        assert_eq!(done.progress, 100);
        assert_eq!(done.segments.len(), 2);
        assert_eq!(done.segments[1].start_seconds, 1200.0);
        assert_eq!(done.segments[1].end_seconds, 1800.0);
        assert_eq!(done.duration_seconds, 1800.0);
        assert_eq!(done.text, "first\n\nsecond");
        // The upload is always removed, even on success.
        assert!(!upload.exists());
    }

    #[tokio::test]
    async fn a_failed_summary_still_leaves_a_completed_transcript() {
        let dir = scratch("summary-fail");
        let store = TranscriptStore::new(&dir);
        seed(&store, "job", true).await;
        let upload = dir.join("upload.mp3");
        std::fs::write(&upload, b"x").unwrap();

        let processor = JobProcessor::new(
            store.clone(),
            Arc::new(Fake {
                chunks: vec![10.0],
                transcripts: vec!["halo".into()],
                summary: Err("429 rate limited".into()),
                fail_prepare: false,
            }),
        );
        processor.process("job", &upload).await;

        let done = store.get("job").await.unwrap().unwrap();
        assert_eq!(done.status, Status::Completed);
        assert_eq!(done.summary, None);
        assert!(done.summary_error.unwrap().contains("transcript is complete"));
        assert_eq!(done.text, "halo");
    }

    #[tokio::test]
    async fn a_cancelled_job_is_marked_cancelled_and_carries_no_error() {
        let dir = scratch("cancel");
        let store = TranscriptStore::new(&dir);
        seed(&store, "job", false).await;
        let upload = dir.join("upload.mp3");
        std::fs::write(&upload, b"x").unwrap();

        let processor = JobProcessor::new(
            store.clone(),
            Arc::new(Fake {
                chunks: vec![10.0],
                transcripts: vec!["halo".into()],
                summary: Ok("unused".into()),
                fail_prepare: false,
            }),
        );
        processor.cancel("job");
        processor.process("job", &upload).await;

        let done = store.get("job").await.unwrap().unwrap();
        assert_eq!(done.status, Status::Cancelled);
        assert_eq!(done.error, None);
    }

    #[tokio::test]
    async fn a_broken_upload_fails_the_job_with_a_readable_message() {
        let dir = scratch("prepare-fail");
        let store = TranscriptStore::new(&dir);
        seed(&store, "job", false).await;
        let upload = dir.join("upload.mp3");
        std::fs::write(&upload, b"x").unwrap();

        let processor = JobProcessor::new(
            store.clone(),
            Arc::new(Fake {
                chunks: vec![],
                transcripts: vec![],
                summary: Ok(String::new()),
                fail_prepare: true,
            }),
        );
        processor.process("job", &upload).await;

        let done = store.get("job").await.unwrap().unwrap();
        assert_eq!(done.status, Status::Failed);
        assert!(done.error.unwrap().contains("did not contain readable audio"));
        assert!(!upload.exists());
    }
}
