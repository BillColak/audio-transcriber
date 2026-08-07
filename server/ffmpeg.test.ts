import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFfmpegCache, resolveFfmpeg } from './ffmpeg.js';

beforeEach(resetFfmpegCache);
afterEach(() => { resetFfmpegCache(); vi.unstubAllEnvs(); });

describe('resolveFfmpeg', () => {
  it('prefers the binary the packaged app passes in', async () => {
    vi.stubEnv('AUDIO_TRANSCRIBER_FFMPEG', 'C:\\Program Files\\Audio Transcriber\\resources\\ffmpeg.exe');
    await expect(resolveFfmpeg()).resolves.toBe('C:\\Program Files\\Audio Transcriber\\resources\\ffmpeg.exe');
  });

  it('falls back to the ffmpeg-static package during development', async () => {
    vi.stubEnv('AUDIO_TRANSCRIBER_FFMPEG', '');
    await expect(resolveFfmpeg()).resolves.toMatch(/ffmpeg/i);
  });
});
