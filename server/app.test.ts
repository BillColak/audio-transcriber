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
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], text: 'Halo', error: null,
      summarize: true, summary: '## Summary\nSemua baik.', summaryError: null, chatMessages: [],
    });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub answer') });

    expect((await request(app).get('/api/transcriptions')).body[0].language).toBe('indonesian');
    await request(app).patch('/api/transcriptions/saved').send({ title: 'Pertemuan', text: 'Selamat pagi semuanya' }).expect(200);
    const download = await request(app).get('/api/transcriptions/saved/download?format=txt').expect(200);
    expect(download.text).toContain('Selamat pagi');
    const summary = await request(app).get('/api/transcriptions/saved/download?format=md').expect(200);
    expect(summary.text).toContain('Semua baik.');
    await request(app).delete('/api/transcriptions/saved').expect(204);
    await request(app).get('/api/transcriptions/saved').expect(404);
  });

  it('records the summarize choice from the upload form', async () => {
    const { dir, store, settings } = await scaffold();
    const enqueue = vi.fn();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub answer') });

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
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], text: 'Halo', error: null,
      summarize: false, summary: null, summaryError: null, chatMessages: [],
    });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub answer') });

    await request(app).get('/api/transcriptions/plain/download?format=md').expect(404);
  });
});

describe('settings API', () => {
  it('reports whether a key is configured and accepts a new one, never echoing it back', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { dir, store, settings } = await scaffold();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub answer') });

    const before = await request(app).get('/api/settings').expect(200);
    expect(before.body).toEqual({ hasApiKey: false, keySource: null, transcribeModel: 'gpt-transcribe', summaryModel: 'gpt-5-mini' });

    const after = await request(app).put('/api/settings').send({ apiKey: 'sk-pasted-into-the-app-5678' }).expect(200);
    expect(after.body).toMatchObject({ hasApiKey: true, keySource: 'settings' });
    expect(JSON.stringify(after.body)).not.toContain('sk-pasted');
    expect(settings.apiKey()).toBe('sk-pasted-into-the-app-5678');
  });

  it('refuses a key that is obviously wrong', async () => {
    const { dir, store, settings } = await scaffold();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub answer') });

    const response = await request(app).put('/api/settings').send({ apiKey: 'nope' }).expect(400);
    expect(response.body.error).toMatch(/does not look like an OpenAI API key/);
  });

  it('tests the key that was typed in, without saving it', async () => {
    const { dir, store, settings } = await scaffold();
    const verify = vi.fn().mockResolvedValue({ ok: true, message: 'The key works.' });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify, ask: () => Promise.resolve('stub answer') });

    const response = await request(app).post('/api/settings/test').send({ apiKey: 'sk-typed-but-not-saved-1234' }).expect(200);
    expect(verify).toHaveBeenCalledWith('sk-typed-but-not-saved-1234');
    expect(response.body).toEqual({ ok: true, message: 'The key works.' });
    // Testing must not persist anything — that is what Save is for.
    expect(settings.apiKey()).toBeUndefined();
  });

  it('tests the saved key when the field is left blank', async () => {
    const { dir, store, settings } = await scaffold();
    const verify = vi.fn().mockResolvedValue({ ok: true, message: 'The key works.' });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify, ask: () => Promise.resolve('stub answer') });

    await request(app).post('/api/settings/test').send({}).expect(200);
    expect(verify).toHaveBeenCalledWith('');
  });

  it('reports a rejected key without turning it into an HTTP error', async () => {
    const { dir, store, settings } = await scaffold();
    const verify = vi.fn().mockResolvedValue({ ok: false, message: 'OpenAI rejected this key. Check it was copied in full.' });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify, ask: () => Promise.resolve('stub answer') });

    const response = await request(app).post('/api/settings/test').send({ apiKey: 'sk-wrong' }).expect(200);
    expect(response.body).toEqual({ ok: false, message: 'OpenAI rejected this key. Check it was copied in full.' });
  });
});

describe('chat API', () => {
  async function withTranscript(overrides: Partial<Parameters<TranscriptStore['save']>[0]> = {}) {
    const { dir, store, settings } = await scaffold();
    await store.save({
      id: 'saved', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 3,
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], text: 'Halo', error: null,
      summarize: false, summary: null, summaryError: null, chatMessages: [],
      ...overrides,
    });
    return { dir, store, settings };
  }

  it('404s for an unknown transcript', async () => {
    const { dir, store, settings } = await scaffold();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub') });

    const response = await request(app).post('/api/transcriptions/missing/chat').send({ question: 'What was discussed?' });
    expect(response.status).toBe(404);
  });

  it('400s for an empty question', async () => {
    const { dir, store, settings } = await withTranscript();
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub') });

    const response = await request(app).post('/api/transcriptions/saved/chat').send({ question: '   ' });
    expect(response.status).toBe(400);
  });

  it('400s when the transcript has no text yet', async () => {
    const { dir, store, settings } = await withTranscript({ text: '', status: 'processing' });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask: () => Promise.resolve('stub') });

    const response = await request(app).post('/api/transcriptions/saved/chat').send({ question: 'What was discussed?' });
    expect(response.status).toBe(400);
  });

  it('answers a question and appends it to the persisted chat history', async () => {
    const { dir, store, settings } = await withTranscript();
    const ask = vi.fn().mockResolvedValue('They discussed the budget.');
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask });

    const response = await request(app).post('/api/transcriptions/saved/chat').send({ question: 'What did they discuss?' }).expect(200);
    expect(ask).toHaveBeenCalledWith('Halo', [], 'What did they discuss?');
    expect(response.body.chatMessages).toMatchObject([
      { role: 'user', content: 'What did they discuss?' },
      { role: 'assistant', content: 'They discussed the budget.' },
    ]);
    expect((await store.get('saved'))?.chatMessages).toHaveLength(2);
  });

  it('keeps a transcript edit made while the model was still answering', async () => {
    const { dir, store, settings } = await withTranscript();
    // Stands in for the user editing the transcript during the seconds the model takes.
    const ask = vi.fn(async () => {
      const edited = (await store.get('saved'))!;
      edited.title = 'Rapat mingguan';
      edited.text = 'Halo, apa kabar';
      await store.save(edited);
      return 'They discussed the budget.';
    });
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask });

    await request(app).post('/api/transcriptions/saved/chat').send({ question: 'What did they discuss?' }).expect(200);

    const saved = (await store.get('saved'))!;
    expect(saved.title).toBe('Rapat mingguan');
    expect(saved.text).toBe('Halo, apa kabar');
    expect(saved.chatMessages).toHaveLength(2);
  });

  it('maps an upstream failure to a 502 with a humanized message', async () => {
    const { dir, store, settings } = await withTranscript();
    const ask = vi.fn().mockRejectedValue(new Error('401 authentication failed'));
    const app = createApp({ store, settings, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false, verify: () => Promise.resolve({ ok: true, message: 'stub' }), ask });

    const response = await request(app).post('/api/transcriptions/saved/chat').send({ question: 'Anything?' });
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/rejected the API key/);
  });
});
