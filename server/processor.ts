import { rm } from 'node:fs/promises';
import { languageCode, mergeChunkSegments } from './domain.js';
import type { RawSegment, Segment } from './types.js';
import { TranscriptStore } from './store.js';

export interface PreparedChunk { path: string; durationSeconds: number }
export interface ProcessingTools {
  prepare(inputPath: string, jobId: string): Promise<PreparedChunk[]>;
  transcribe(chunkPath: string, language?: string): Promise<RawSegment[]>;
}

export class JobProcessor {
  private readonly cancelled = new Set<string>();

  constructor(private readonly store: TranscriptStore, private readonly tools: ProcessingTools) {}

  cancel(id: string): void { this.cancelled.add(id); }

  async process(id: string, uploadPath: string): Promise<void> {
    let chunkPaths: string[] = [];
    try {
      const transcript = await this.store.get(id);
      if (!transcript) return;
      transcript.status = 'processing'; transcript.progress = 2; transcript.updatedAt = new Date().toISOString();
      await this.store.save(transcript);
      const chunks = await this.tools.prepare(uploadPath, id);
      chunkPaths = chunks.map((chunk) => chunk.path);
      const segments: Segment[] = [];
      let offset = 0;
      for (let index = 0; index < chunks.length; index += 1) {
        if (this.cancelled.has(id)) throw new Error('CANCELLED');
        const raw = await this.tools.transcribe(chunks[index].path, languageCode(transcript.language));
        segments.push(...mergeChunkSegments(raw, offset, index));
        offset += chunks[index].durationSeconds;
        transcript.progress = Math.round(10 + ((index + 1) / chunks.length) * 88);
        transcript.segments = segments; transcript.durationSeconds = offset; transcript.updatedAt = new Date().toISOString();
        await this.store.save(transcript);
      }
      transcript.status = 'completed'; transcript.progress = 100; transcript.error = null; transcript.updatedAt = new Date().toISOString();
      await this.store.save(transcript);
    } catch (error) {
      const transcript = await this.store.get(id);
      if (transcript) {
        transcript.status = this.cancelled.has(id) || (error as Error).message === 'CANCELLED' ? 'cancelled' : 'failed';
        transcript.error = transcript.status === 'failed' ? humanizeError(error) : null;
        transcript.updatedAt = new Date().toISOString();
        await this.store.save(transcript);
      }
    } finally {
      this.cancelled.delete(id);
      await Promise.allSettled([...new Set([uploadPath, ...chunkPaths])].map((file) => rm(file, { force: true })));
    }
  }
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown processing error.';
  if (/api.?key|401|authentication/i.test(message)) return 'OpenAI rejected the API key. Check your .env file.';
  return `Transcription failed: ${message}`;
}
