import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES, validateAudioFile } from './domain.js';
import { toMarkdown, toText, toVtt } from './exports.js';
import type { TranscriptStore } from './store.js';
import type { LanguagePreference, Segment, Transcript } from './types.js';

interface AppOptions {
  store: TranscriptStore;
  uploadDirectory: string;
  enqueue(id: string, uploadPath: string): void;
  cancel(id: string): boolean;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.use(cors({ origin: /^http:\/\/127\.0\.0\.1(?::\d+)?$/ }));
  app.use(express.json({ limit: '2mb' }));
  const upload = multer({ dest: options.uploadDirectory, limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
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
      durationSeconds: 0, segments: [], error: null,
      summarize: req.body.summarize === 'true' || req.body.summarize === true, summary: null, summaryError: null,
    };
    await options.store.save(transcript);
    options.enqueue(transcript.id, req.file.path);
    res.status(202).json({ id: transcript.id, status: transcript.status });
  });
  app.patch('/api/transcriptions/:id', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    if (typeof req.body.title === 'string' && req.body.title.trim()) transcript.title = req.body.title.trim().slice(0, 160);
    if (Array.isArray(req.body.segments)) {
      const edits = new Map<string, string>(req.body.segments.filter((item: unknown): item is Pick<Segment, 'id' | 'text'> =>
        !!item && typeof (item as Segment).id === 'string' && typeof (item as Segment).text === 'string').map((item: Pick<Segment, 'id' | 'text'>) => [item.id, item.text]));
      transcript.segments = transcript.segments.map((segment) => edits.has(segment.id) ? { ...segment, text: edits.get(segment.id)!.slice(0, 20_000) } : segment);
    }
    transcript.updatedAt = new Date().toISOString(); await options.store.save(transcript); res.json(transcript);
  });
  app.delete('/api/transcriptions/:id', async (req, res) => {
    if (options.cancel(req.params.id)) return res.status(202).json({ status: 'cancelling' });
    await options.store.delete(req.params.id); res.status(204).end();
  });
  app.get('/api/transcriptions/:id/download', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    const requested = String(req.query.format ?? '');
    const format = requested === 'vtt' || requested === 'txt' || requested === 'md' ? requested : null;
    if (!format) return res.status(400).json({ error: 'Format must be txt, vtt, or md.' });
    if (format === 'md' && !transcript.summary) return res.status(404).json({ error: 'This transcript has no summary.' });
    const body = format === 'vtt' ? toVtt(transcript.segments) : format === 'md' ? toMarkdown(transcript) : toText(transcript.segments);
    const type = format === 'vtt' ? 'text/vtt' : format === 'md' ? 'text/markdown' : 'text/plain';
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
