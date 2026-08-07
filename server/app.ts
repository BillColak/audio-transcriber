import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES, validateAudioFile } from './domain.js';
import { toMarkdown, toText } from './exports.js';
import { humanizeChatError } from './openai-chat.js';
import type { TranscriptStore } from './store.js';
import type { ChatMessage, KeyCheck, LanguagePreference, Segment, SettingsSnapshot, Transcript } from './types.js';

/** The slice of `SettingsStore` the HTTP layer is allowed to see. */
export interface SettingsPort {
  snapshot(): SettingsSnapshot;
  setApiKey(key: string): Promise<void>;
}

interface AppOptions {
  store: TranscriptStore;
  uploadDirectory: string;
  settings: SettingsPort;
  enqueue(id: string, uploadPath: string): void;
  cancel(id: string): boolean;
  ask(transcriptText: string, history: ChatMessage[], question: string): Promise<string>;
  /** Called with an empty string to test whatever key is already saved. */
  verify(apiKey: string): Promise<KeyCheck>;
}

export function createApp(options: AppOptions) {
  const app = express();
  // Browsers reach the API from the Vite dev server; the packaged app reaches it from the
  // Tauri webview, whose origin differs per platform.
  app.use(cors({ origin: [/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/, 'tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'] }));
  app.use(express.json({ limit: '2mb' }));
  const upload = multer({ dest: options.uploadDirectory, limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/settings', (_req, res) => res.json(options.settings.snapshot()));
  app.put('/api/settings', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    try {
      await options.settings.setApiKey(apiKey);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save the API key.' });
    }
    res.json(options.settings.snapshot());
  });
  // Tests the key typed into the form, or the saved one when the field is left blank, so it can
  // be checked before saving and re-checked afterwards.
  app.post('/api/settings/test', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    res.json(await options.verify(apiKey));
  });
  app.get('/api/transcriptions', async (_req, res) => res.json(await options.store.list()));
  app.get('/api/transcriptions/:id', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    res.json(transcript);
  });
  app.post('/api/transcriptions', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an audio file.' });
    const validation = validateAudioFile(req.file.originalname, req.file.size);
    const language = req.body.language === 'indonesian' ? 'indonesian' : req.body.language === 'auto' || !req.body.language ? 'auto' : null;
    if (!validation.ok || !language) {
      await import('node:fs/promises').then(({ rm }) => rm(req.file!.path, { force: true }));
      return res.status(400).json({ error: validation.ok ? 'Unsupported language selection.' : validation.error });
    }
    const now = new Date().toISOString();
    const transcript: Transcript = {
      id: randomUUID(), title: path.parse(req.file.originalname).name, sourceName: req.file.originalname,
      language: language as LanguagePreference, status: 'queued', progress: 0, createdAt: now, updatedAt: now,
      durationSeconds: 0, segments: [], text: '', error: null,
      summarize: req.body.summarize === 'true' || req.body.summarize === true, summary: null, summaryError: null,
      chatMessages: [],
    };
    await options.store.save(transcript);
    options.enqueue(transcript.id, req.file.path);
    res.status(202).json({ id: transcript.id, status: transcript.status });
  });
  app.patch('/api/transcriptions/:id', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    if (typeof req.body.title === 'string' && req.body.title.trim()) transcript.title = req.body.title.trim().slice(0, 160);
    if (typeof req.body.text === 'string') transcript.text = req.body.text.slice(0, 1_000_000);
    if (Array.isArray(req.body.segments)) {
      const edits = new Map<string, string>(req.body.segments.filter((item: unknown): item is Pick<Segment, 'id' | 'text'> =>
        !!item && typeof (item as Segment).id === 'string' && typeof (item as Segment).text === 'string').map((item: Pick<Segment, 'id' | 'text'>) => [item.id, item.text]));
      transcript.segments = transcript.segments.map((segment) => edits.has(segment.id) ? { ...segment, text: edits.get(segment.id)!.slice(0, 20_000) } : segment);
    }
    transcript.updatedAt = new Date().toISOString(); await options.store.save(transcript); res.json(transcript);
  });
  app.post('/api/transcriptions/:id/chat', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 4_000) : '';
    if (!question) return res.status(400).json({ error: 'Ask a question.' });
    const transcriptText = transcript.text.trim();
    if (!transcriptText) return res.status(400).json({ error: 'There is no transcript text to chat about yet.' });
    try {
      const answer = await options.ask(transcriptText, transcript.chatMessages, question);
      // Answering takes seconds, and the record may have been edited in the meantime. Re-read it
      // so the reply appends to whatever is current instead of restoring the copy read above.
      const current = await options.store.get(req.params.id);
      if (!current) return res.status(404).json({ error: 'Transcript not found.' });
      const now = new Date().toISOString();
      current.chatMessages = [
        ...current.chatMessages,
        { id: randomUUID(), role: 'user', content: question, createdAt: now },
        { id: randomUUID(), role: 'assistant', content: answer, createdAt: now },
      ];
      current.updatedAt = now;
      await options.store.save(current);
      res.json(current);
    } catch (error) {
      res.status(502).json({ error: humanizeChatError(error) });
    }
  });
  app.delete('/api/transcriptions/:id', async (req, res) => {
    if (options.cancel(req.params.id)) return res.status(202).json({ status: 'cancelling' });
    await options.store.delete(req.params.id); res.status(204).end();
  });
  app.get('/api/transcriptions/:id/download', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    const requested = String(req.query.format ?? '');
    const format = requested === 'txt' || requested === 'md' ? requested : null;
    if (!format) return res.status(400).json({ error: 'Format must be txt or md.' });
    if (format === 'md' && !transcript.summary) return res.status(404).json({ error: 'This transcript has no summary.' });
    const body = format === 'md' ? toMarkdown(transcript) : toText(transcript);
    const type = format === 'md' ? 'text/markdown' : 'text/plain';
    res.type(type).attachment(`${safeFilename(transcript.title)}.${format}`).send(body);
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 2 GB limit.' : 'Upload failed.';
    res.status(400).json({ error: message });
  });
  void mkdir(options.uploadDirectory, { recursive: true });
  return app;
}

function safeFilename(title: string): string {
  const printable = Array.from(title, (character) => character.charCodeAt(0) < 32 ? '_' : character).join('');
  return printable.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100) || 'transcript';
}
