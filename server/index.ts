import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { createApp } from './app.js';
import { FfmpegMedia } from './media.js';
import { appDataDirectory } from './paths.js';
import { DEFAULT_CHAT_MODEL, OpenAIChatAssistant } from './openai-chat.js';
import { DEFAULT_SUMMARY_MODEL, OpenAISummarizer } from './openai-summarizer.js';
import { DEFAULT_TRANSCRIBE_MODEL, OpenAITranscriber } from './openai-transcriber.js';
import { OpenAIKeyVerifier } from './openai-verify.js';
import { JobProcessor } from './processor.js';
import { JobQueue } from './queue.js';
import { SettingsStore } from './settings.js';
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
const chatModel = process.env.OPENAI_CHAT_MODEL || DEFAULT_CHAT_MODEL;
const settings = new SettingsStore(appData, { transcribe: transcribeModel, summary: summaryModel });
await settings.load();
// The key is read per job, not at boot, so saving one in Settings takes effect without a restart.
const processor = new JobProcessor(store, {
  prepare: (input, id) => new FfmpegMedia(workDirectory).prepare(input, id),
  transcribe: (file, languages) => new OpenAITranscriber(settings.apiKey(), transcribeModel).transcribe(file, languages),
  summarize: (text) => new OpenAISummarizer(settings.apiKey(), summaryModel).summarize(text),
});
const queue = new JobQueue(processor, store);
const verifier = new OpenAIKeyVerifier(() => [transcribeModel, summaryModel, chatModel]);
const app = createApp({
  store, uploadDirectory, settings, enqueue: queue.enqueue, cancel: queue.cancel,
  ask: (transcriptText, history, question) => new OpenAIChatAssistant(settings.apiKey(), chatModel).ask(transcriptText, history, question),
  // An empty field means "test the key already saved".
  verify: (apiKey) => verifier.verify(apiKey || settings.apiKey() || ''),
});
const dist = path.join(root, 'dist');
if (process.env.NODE_ENV === 'production') { app.use(express.static(dist)); app.get('*path', (_req, res) => res.sendFile(path.join(dist, 'index.html'))); }
app.listen(8787, '127.0.0.1', () => console.log('Audio Transcriber server: http://127.0.0.1:8787'));
