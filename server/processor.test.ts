import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobProcessor } from './processor.js';
import { TranscriptStore } from './store.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('JobProcessor', () => {
  it('forwards Indonesian and merges chunks while removing temporary files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'processor-'));
    dirs.push(dir);
    const upload = path.join(dir, 'upload.mp3');
    await writeFile(upload, 'audio');
    const store = new TranscriptStore(path.join(dir, 'data'));
    await store.save({
      id: 'job', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'queued', progress: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 0, segments: [], error: null,
    });
    const transcribe = vi.fn().mockResolvedValue([{ start: 1, end: 2, text: 'Halo dunia' }]);
    const processor = new JobProcessor(store, {
      prepare: vi.fn().mockResolvedValue([{ path: upload, durationSeconds: 10 }]),
      transcribe,
    });

    await processor.process('job', upload);

    expect(transcribe).toHaveBeenCalledWith(upload, 'id');
    expect((await store.get('job'))?.segments[0].text).toBe('Halo dunia');
    await expect(readFile(upload)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
