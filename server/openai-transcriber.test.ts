import { expect, it } from 'vitest';
import { DEFAULT_TRANSCRIBE_MODEL, OpenAITranscriber } from './openai-transcriber.js';

it('defaults to the gpt-transcribe speech-to-text model', () => {
  expect(DEFAULT_TRANSCRIBE_MODEL).toBe('gpt-transcribe');
});

it('allows the server to start without a key and reports setup only when transcription is attempted', async () => {
  const transcriber = new OpenAITranscriber(undefined);
  await expect(transcriber.transcribe('missing.mp3', ['id'])).rejects.toThrow('OPENAI_API_KEY is not configured');
});
