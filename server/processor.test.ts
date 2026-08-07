import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobProcessor } from './processor.js';
import { TranscriptStore } from './store.js';
import type { Transcript } from './types.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function scaffold(overrides: Partial<Transcript> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'processor-'));
  dirs.push(dir);
  const upload = path.join(dir, 'upload.mp3');
  await writeFile(upload, 'audio');
  const store = new TranscriptStore(path.join(dir, 'data'));
  await store.save({
    id: 'job', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'queued', progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 0, segments: [], text: '',
    error: null, summarize: false, summary: null, summaryError: null, chatMessages: [], ...overrides,
  });
  return { store, upload };
}

describe('JobProcessor', () => {
  it('forwards Indonesian and turns each chunk into one segment while removing temporary files', async () => {
    const { store, upload } = await scaffold();
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ text: 'Halo dunia' })
      .mockResolvedValueOnce({ text: 'Sampai jumpa' });
    const summarize = vi.fn();
    const processor = new JobProcessor(store, {
      prepare: vi.fn().mockResolvedValue([{ path: upload, durationSeconds: 1200 }, { path: `${upload}.2`, durationSeconds: 300 }]),
      transcribe, summarize,
    });

    await processor.process('job', upload);

    expect(transcribe).toHaveBeenCalledWith(upload, ['id']);
    const saved = await store.get('job');
    expect(saved?.status).toBe('completed');
    expect(saved?.segments).toEqual([
      { id: '0-0', startSeconds: 0, endSeconds: 1200, text: 'Halo dunia' },
      { id: '1-0', startSeconds: 1200, endSeconds: 1500, text: 'Sampai jumpa' },
    ]);
    expect(saved?.durationSeconds).toBe(1500);
    expect(summarize).not.toHaveBeenCalled();
    expect(saved?.summary).toBeNull();
    await expect(readFile(upload)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('summarises the joined transcript when the job asked for it', async () => {
    const { store, upload } = await scaffold({ summarize: true });
    const summarize = vi.fn().mockResolvedValue('## Summary\nSemua baik.');
    const processor = new JobProcessor(store, {
      prepare: vi.fn().mockResolvedValue([{ path: upload, durationSeconds: 60 }]),
      transcribe: vi.fn().mockResolvedValue({ text: 'Halo dunia' }),
      summarize,
    });

    await processor.process('job', upload);

    expect(summarize).toHaveBeenCalledWith('Halo dunia');
    const saved = await store.get('job');
    expect(saved?.status).toBe('completed');
    expect(saved?.progress).toBe(100);
    expect(saved?.summary).toBe('## Summary\nSemua baik.');
    expect(saved?.summaryError).toBeNull();
  });

  it('keeps the transcript when summarising fails', async () => {
    const { store, upload } = await scaffold({ summarize: true });
    const processor = new JobProcessor(store, {
      prepare: vi.fn().mockResolvedValue([{ path: upload, durationSeconds: 60 }]),
      transcribe: vi.fn().mockResolvedValue({ text: 'Halo dunia' }),
      summarize: vi.fn().mockRejectedValue(new Error('rate limited')),
    });

    await processor.process('job', upload);

    const saved = await store.get('job');
    expect(saved?.status).toBe('completed');
    expect(saved?.error).toBeNull();
    expect(saved?.segments[0].text).toBe('Halo dunia');
    expect(saved?.summary).toBeNull();
    expect(saved?.summaryError).toContain('rate limited');
  });
});
