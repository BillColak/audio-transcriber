import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveFfmpeg } from './ffmpeg.js';
import type { PreparedChunk } from './processor.js';

const run = promisify(execFile);

export class FfmpegMedia {
  constructor(private readonly workDirectory: string) {}

  async prepare(inputPath: string, jobId: string): Promise<PreparedChunk[]> {
    const ffmpeg = await resolveFfmpeg();
    const directory = path.join(this.workDirectory, jobId);
    await mkdir(directory, { recursive: true });
    const pattern = path.join(directory, 'chunk-%03d.mp3');
    await run(ffmpeg, ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'segment', '-segment_time', '1200', '-reset_timestamps', '1', pattern], { maxBuffer: 10 * 1024 * 1024 });
    const files = (await readdir(directory)).filter((file) => file.endsWith('.mp3')).sort().map((file) => path.join(directory, file));
    if (!files.length) throw new Error('The file did not contain readable audio.');
    return Promise.all(files.map(async (file) => ({ path: file, durationSeconds: await this.duration(file) })));
  }

  private async duration(file: string): Promise<number> {
    const ffmpeg = await resolveFfmpeg();
    try { await run(ffmpeg, ['-i', file], { maxBuffer: 1024 * 1024 }); return 0; }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      const match = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) throw new Error('Could not measure an audio chunk.', { cause: error });
      return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
  }
}
