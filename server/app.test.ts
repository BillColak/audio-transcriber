import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { TranscriptStore } from './store.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('transcript API', () => {
  it('lists, edits, downloads, and deletes saved transcripts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'api-'));
    dirs.push(dir);
    const store = new TranscriptStore(path.join(dir, 'data'));
    await store.save({
      id: 'saved', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 3,
      segments: [{ id: '0-0', startSeconds: 0, endSeconds: 3, text: 'Halo' }], error: null,
    });
    const app = createApp({ store, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

    expect((await request(app).get('/api/transcriptions')).body[0].language).toBe('indonesian');
    await request(app).patch('/api/transcriptions/saved').send({ title: 'Pertemuan', segments: [{ id: '0-0', text: 'Selamat pagi' }] }).expect(200);
    const download = await request(app).get('/api/transcriptions/saved/download?format=vtt').expect(200);
    expect(download.text).toContain('Selamat pagi');
    await request(app).delete('/api/transcriptions/saved').expect(204);
    await request(app).get('/api/transcriptions/saved').expect(404);
  });
});
