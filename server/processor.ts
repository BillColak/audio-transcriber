import { rm } from 'node:fs/promises';
import { chunkSegment, joinSegments, languageCodes } from './domain.js';
import type { ChunkTranscription, Segment } from './types.js';
import { TranscriptStore } from './store.js';

export interface PreparedChunk { path: string; durationSeconds: number }
export interface ProcessingTools {
  prepare(inputPath: string, jobId: string): Promise<PreparedChunk[]>;
  transcribe(chunkPath: string, languages?: string[]): Promise<ChunkTranscription>;
  summarize(transcriptText: string): Promise<string>;
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
        const chunk = await this.tools.transcribe(chunks[index].path, languageCodes(transcript.language));
        segments.push(chunkSegment(chunk.text, offset, chunks[index].durationSeconds, index));
        offset += chunks[index].durationSeconds;
        transcript.progress = Math.round(10 + ((index + 1) / chunks.length) * (transcript.summarize ? 80 : 88));
        transcript.segments = segments; transcript.text = joinSegments(segments); transcript.durationSeconds = offset; transcript.updatedAt = new Date().toISOString();
        await this.store.save(transcript);
      }
      if (transcript.summarize) {
        if (this.cancelled.has(id)) throw new Error('CANCELLED');
        await this.summarize(transcript.id, segments);
      }
      const completed = (await this.store.get(id)) ?? transcript;
      completed.status = 'completed'; completed.progress = 100; completed.error = null; completed.updatedAt = new Date().toISOString();
      await this.store.save(completed);
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

  /** A failed summary never fails the job — the transcript itself is still worth keeping. */
  private async summarize(id: string, segments: Segment[]): Promise<void> {
    const transcript = await this.store.get(id);
    if (!transcript) return;
    transcript.progress = 92; transcript.updatedAt = new Date().toISOString();
    await this.store.save(transcript);
    const text = joinSegments(segments);
    if (!text) { transcript.summaryError = 'There was no transcript text to summarise.'; await this.store.save(transcript); return; }
    try {
      transcript.summary = await this.tools.summarize(text);
      transcript.summaryError = null;
    } catch (error) {
      transcript.summary = null;
      transcript.summaryError = humanizeSummaryError(error);
    }
    transcript.updatedAt = new Date().toISOString();
    await this.store.save(transcript);
  }
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown processing error.';
  if (/api.?key|401|authentication/i.test(message)) return 'OpenAI rejected the API key. Check it in Settings.';
  return `Transcription failed: ${message}`;
}

function humanizeSummaryError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown summarisation error.';
  if (/api.?key|401|authentication/i.test(message)) return 'OpenAI rejected the API key, so the summary was skipped.';
  return `The transcript is complete, but the summary failed: ${message}`;
}
