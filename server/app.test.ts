import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { SettingsStore } from './settings.js';
import { TranscriptStore } from './store.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function scaffold() {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-'));
  dirs.push(dir);
  const settings = new SettingsStore(path.join(dir, 'config'), { transcribe: 'gpt-transcribe', summary: 'gpt-5-mini' });
  await settings.load();
  return { dir, store: new TranscriptStore(path.join(dir, 'data')), settings };
}

describe('transcript API', () => {
  it('lists, edits, downloads, and deletes saved transcripts', async () => {
    const { dir, store, settings } = await scaffold();
    await store.save({
      id: 'saved', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 3,
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], error: null,
      summarize: true, summary: '## Summary\nSemua baik.', summaryError: null,
    });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

    expect((await request(app).get('/api/transcriptions')).body[0].language).toBe('indonesian');
    await request(app).patch('/api/transcriptions/saved').send({ title: 'Pertemuan', segments: [{ id: '0-0', text: 'Selamat pagi' }] }).expect(200);
    const download = await request(app).get('/api/transcriptions/saved/download?format=vtt').expect(200);
    expect(download.text).toContain('Selamat pagi');
    const summary = await request(app).get('/api/transcriptions/saved/download?format=md').expect(200);
    expect(summary.text).toContain('Semua baik.');
    await request(app).delete('/api/transcriptions/saved').expect(204);
    await request(app).get('/api/transcriptions/saved').expect(404);
  });

  it('records the summarize choice from the upload form', async () => {
    const { dir, store, settings } = await scaffold();
    const enqueue = vi.fn();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue, cancel: () => false });

    await request(app).post('/api/transcriptions')
      .field('language', 'indonesian').field('summarize', 'true')
      .attach('audio', Buffer.from('audio'), 'rapat.mp3').expect(202);
    await request(app).post('/api/transcriptions')
      .field('language', 'auto').field('summarize', 'false')
      .attach('audio', Buffer.from('audio'), 'notulen.mp3').expect(202);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const byName = new Map((await store.list()).map((item) => [item.sourceName, item]));
    expect(byName.get('rapat.mp3')).toMatchObject({ summarize: true, summary: null, status: 'queued' });
    expect(byName.get('notulen.mp3')).toMatchObject({ summarize: false, summary: null });
  });

  it('will not offer a summary download when there is no summary', async () => {
    const { dir, store, settings } = await scaffold();
    await store.save({
      id: 'plain', title: 'Rapat', sourceName: 'rapat.mp3', language: 'auto', status: 'completed', progress: 100,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 3,
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], error: null,
      summarize: false, summary: null, summaryError: null,
    });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

    await request(app).get('/api/transcriptions/plain/download?format=md').expect(404);
  });
});

describe('settings API', () => {
  it('reports whether a key is configured and accepts a new one, never echoing it back', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { dir, store, settings } = await scaffold();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

    const before = await request(app).get('/api/settings').expect(200);
    expect(before.body).toEqual({ hasApiKey: false, keySource: null, transcribeModel: 'gpt-transcribe', summaryModel: 'gpt-5-mini' });

    const after = await request(app).put('/api/settings').send({ apiKey: 'sk-pasted-into-the-app-5678' }).expect(200);
    expect(after.body).toMatchObject({ hasApiKey: true, keySource: 'settings' });
    expect(JSON.stringify(after.body)).not.toContain('sk-pasted');
    expect(settings.apiKey()).toBe('sk-pasted-into-the-app-5678');
  });

  it('refuses a key that is obviously wrong', async () => {
    const { dir, store, settings } = await scaffold();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

    const response = await request(app).put('/api/settings').send({ apiKey: 'nope' }).expect(400);
    expect(response.body.error).toMatch(/does not look like an OpenAI API key/);
  });
});
