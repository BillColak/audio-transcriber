import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transcript } from './types.js';

export class TranscriptStore {
  constructor(private readonly directory: string) {}

  private file(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid transcript id.');
    return path.join(this.directory, `${id}.json`);
  }

  async save(transcript: Transcript): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file(transcript.id), JSON.stringify(transcript, null, 2), 'utf8');
  }

  async get(id: string): Promise<Transcript | null> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')) as Transcript; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async list(): Promise<Transcript[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json'));
    const transcripts = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as Transcript));
    return transcripts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  async recoverInterrupted(): Promise<void> {
    for (const transcript of await this.list()) {
      if (transcript.status === 'queued' || transcript.status === 'processing') {
        transcript.status = 'failed';
        transcript.error = 'Processing was interrupted when the app stopped.';
        transcript.updatedAt = new Date().toISOString();
        await this.save(transcript);
      }
    }
  }
}
