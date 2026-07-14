import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptStore } from './store.js';
import type { Transcript } from './types.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('TranscriptStore', () => {
  it('persists transcripts and marks interrupted work failed during recovery', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'transcriber-'));
    dirs.push(dir);
    const store = new TranscriptStore(dir);
    const transcript: Transcript = {
      id: 'one', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'processing', progress: 35,
      createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', durationSeconds: 0, segments: [], error: null,
    };
    await store.save(transcript);
    await store.recoverInterrupted();
    expect((await store.get('one'))?.status).toBe('failed');
    expect((await store.list())[0].title).toBe('Rapat');
  });
});
