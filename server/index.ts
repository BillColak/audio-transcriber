import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { createApp } from './app.js';
import { FfmpegMedia } from './media.js';
import { appDataDirectory } from './paths.js';
import { DEFAULT_SUMMARY_MODEL, OpenAISummarizer } from './openai-summarizer.js';
import { DEFAULT_TRANSCRIBE_MODEL, OpenAITranscriber } from './openai-transcriber.js';
import { JobProcessor } from './processor.js';
import { JobQueue } from './queue.js';
import { TranscriptStore } from './store.js';

dotenv.config();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appData = appDataDirectory();
const dataDirectory = path.join(appData, 'transcripts');
const workDirectory = path.join(tmpdir(), 'audio-transcriber');
const uploadDirectory = path.join(workDirectory, 'uploads');
await Promise.all([mkdir(dataDirectory, { recursive: true }), mkdir(uploadDirectory, { recursive: true })]);
const store = new TranscriptStore(dataDirectory);
await store.recoverInterrupted();
const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
const summaryModel = process.env.OPENAI_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
// The key is read per job, not at boot, so saving one in Settings takes effect without a restart.
const processor = new JobProcessor(store, {
  prepare: (input, id) => new FfmpegMedia(workDirectory).prepare(input, id),
  transcribe: (file, languages) => new OpenAITranscriber(process.env.OPENAI_API_KEY, transcribeModel).transcribe(file, languages),
  summarize: (text) => new OpenAISummarizer(process.env.OPENAI_API_KEY, summaryModel).summarize(text),
});
const queue = new JobQueue(processor, store);
const app = createApp({ store, uploadDirectory, enqueue: queue.enqueue, cancel: queue.cancel });
const dist = path.join(root, 'dist');
if (process.env.NODE_ENV === 'production') { app.use(express.static(dist)); app.get('*path', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.listen(8787, '127.0.0.1', () => console.log('Audio Transcriber server: http://127.0.0.1:8787'));
