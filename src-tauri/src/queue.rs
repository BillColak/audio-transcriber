use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::processor::JobProcessor;
use crate::store::{now, TranscriptStore};
use crate::types::Status;

#[derive(Clone, Debug)]
struct Job {
    id: String,
    upload_path: PathBuf,
}

struct Inner {
    pending: VecDeque<Job>,
    active: Option<String>,
}

/// A single-worker queue: one job at a time, in order. A job that has not started yet can be
/// cancelled outright; the running one is cancelled through the processor, which checks between
/// chunks.
#[derive(Clone)]
pub struct JobQueue {
    inner: Arc<Mutex<Inner>>,
    wake: Arc<Notify>,
    processor: JobProcessor,
    store: TranscriptStore,
}

impl JobQueue {
    pub fn new(processor: JobProcessor, store: TranscriptStore) -> Self {
        let queue = Self {
            inner: Arc::new(Mutex::new(Inner {
                pending: VecDeque::new(),
                active: None,
            })),
            wake: Arc::new(Notify::new()),
            processor,
            store,
        };
        let worker = queue.clone();
        tokio::spawn(async move { worker.run().await });
        queue
    }

    pub fn enqueue(&self, id: &str, upload_path: PathBuf) {
        self.inner.lock().unwrap().pending.push_back(Job {
            id: id.to_string(),
            upload_path,
        });
        self.wake.notify_one();
    }

    /// Returns true when the id was actually queued or running.
    pub async fn cancel(&self, id: &str) -> bool {
        let queued = {
            let mut inner = self.inner.lock().unwrap();
            if inner.active.as_deref() == Some(id) {
                drop(inner);
                self.processor.cancel(id);
                return true;
            }
            match inner.pending.iter().position(|job| job.id == id) {
                Some(index) => inner.pending.remove(index),
                None => None,
            }
        };
        let Some(job) = queued else { return false };
        let _ = tokio::fs::remove_file(&job.upload_path).await;
        if let Ok(Some(mut transcript)) = self.store.get(id).await {
            transcript.status = Status::Cancelled;
            transcript.updated_at = now();
            let _ = self.store.save(&transcript).await;
        }
        true
    }

    async fn run(self) {
        loop {
            let job = {
                let mut inner = self.inner.lock().unwrap();
                match inner.pending.pop_front() {
                    Some(job) => {
                        inner.active = Some(job.id.clone());
                        Some(job)
                    }
                    None => None,
                }
            };
            match job {
                Some(job) => {
                    self.processor.process(&job.id, &job.upload_path).await;
                    self.inner.lock().unwrap().active = None;
                }
                None => self.wake.notified().await,
            }
        }
    }
}
