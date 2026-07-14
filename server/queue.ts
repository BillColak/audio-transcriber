import { rm } from 'node:fs/promises';
import type { JobProcessor } from './processor.js';
import type { TranscriptStore } from './store.js';

interface Job { id: string; uploadPath: string }

export class JobQueue {
  private jobs: Job[] = [];
  private active: Job | null = null;
  constructor(private readonly processor: JobProcessor, private readonly store: TranscriptStore) {}

  enqueue = (id: string, uploadPath: string): void => { this.jobs.push({ id, uploadPath }); void this.drain(); };

  cancel = (id: string): boolean => {
    if (this.active?.id === id) { this.processor.cancel(id); return true; }
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) return false;
    const [job] = this.jobs.splice(index, 1);
    void rm(job.uploadPath, { force: true });
    void this.markCancelled(id);
    return true;
  };

  private async markCancelled(id: string): Promise<void> {
    const transcript = await this.store.get(id);
    if (transcript) { transcript.status = 'cancelled'; transcript.updatedAt = new Date().toISOString(); await this.store.save(transcript); }
  }

  private async drain(): Promise<void> {
    if (this.active || !this.jobs.length) return;
    this.active = this.jobs.shift()!;
    await this.processor.process(this.active.id, this.active.uploadPath);
    this.active = null;
    void this.drain();
  }
}
