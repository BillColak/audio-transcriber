import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import type { ChunkTranscription } from './types.js';

export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-transcribe';

type TranscriptionRequest = Parameters<OpenAI['audio']['transcriptions']['create']>[0];

export class OpenAITranscriber {
  constructor(private readonly apiKey: string | undefined, private readonly model: string = DEFAULT_TRANSCRIBE_MODEL) {}

  async transcribe(filePath: string, languages?: string[]): Promise<ChunkTranscription> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const client = new OpenAI({ apiKey: this.apiKey });
    // `languages` is a gpt-transcribe parameter the SDK types do not model yet, so the request is cast.
    // Plain `json` is the only format this model supports; it returns the whole chunk as one string.
    const request = {
      file: createReadStream(filePath),
      model: this.model,
      response_format: 'json',
      ...(languages?.length ? { languages } : {}),
    } as unknown as TranscriptionRequest;
    const response = (await client.audio.transcriptions.create(request)) as unknown as { text?: string };
    if (typeof response.text !== 'string') throw new Error('OpenAI returned no transcription text.');
    return { text: response.text };
  }
}
