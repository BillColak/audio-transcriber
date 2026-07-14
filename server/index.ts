import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { createApp } from './app.js';
import { FfmpegMedia } from './media.js';
import { OpenAITranscriber } from './openai-transcriber.js';
import { JobProcessor } from './processor.js';
import { JobQueue } from './queue.js';
import { TranscriptStore } from './store.js';

dotenv.config();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appData = process.env.APPDATA ?? path.join(homedir(), '.audio-transcriber');
const dataDirectory = path.join(appData, 'Audio Transcriber', 'transcripts');
const workDirectory = path.join(tmpdir(), 'audio-transcriber');
const uploadDirectory = path.join(workDirectory, 'uploads');
await Promise.all([mkdir(dataDirectory, { recursive: true }), mkdir(uploadDirectory, { recursive: true })]);
const store = new TranscriptStore(dataDirectory);
await store.recoverInterrupted();
const processor = new JobProcessor(store, {
  prepare: (input, id) => new FfmpegMedia(workDirectory).prepare(input, id),
  transcribe: (file, language) => new OpenAITranscriber(process.env.OPENAI_API_KEY).transcribe(file, language),
});
const queue = new JobQueue(processor, store);
const app = createApp({ store, uploadDirectory, enqueue: queue.enqueue, cancel: queue.cancel });
const dist = path.join(root, 'dist');
if (process.env.NODE_ENV === 'production') { app.use(express.static(dist)); app.get('*path', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.listen(8787, '127.0.0.1', () => console.log('Audio Transcriber server: http://127.0.0.1:8787'));
