import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import type { RawSegment } from './types.js';

export class OpenAITranscriber {
  constructor(private readonly apiKey: string | undefined) {}

  async transcribe(filePath: string, language?: string): Promise<RawSegment[]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.audio.transcriptions.create({
      file: createReadStream(filePath), model: 'whisper-1', response_format: 'verbose_json',
      timestamp_granularities: ['segment'], ...(language ? { language } : {}),
    });
    const segments = (response as unknown as { segments?: Array<{ start: number; end: number; text: string }> }).segments;
    if (!segments) throw new Error('OpenAI returned no timestamped segments.');
    return segments;
  }
}
