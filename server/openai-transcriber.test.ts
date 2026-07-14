import { expect, it } from 'vitest';
import { OpenAITranscriber } from './openai-transcriber.js';

it('allows the server to start without a key and reports setup only when transcription is attempted', async () => {
  const transcriber = new OpenAITranscriber(undefined);
  await expect(transcriber.transcribe('missing.mp3', 'id')).rejects.toThrow('OPENAI_API_KEY is not configured');
});
