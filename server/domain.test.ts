import { describe, expect, it } from 'vitest';
import { formatTimestamp, languageCode, mergeChunkSegments, validateAudioFile } from './domain.js';
import { toText, toVtt } from './exports.js';

describe('audio validation', () => {
  it('accepts supported audio and rejects unsupported extensions', () => {
    expect(validateAudioFile('meeting.m4a', 10)).toEqual({ ok: true });
    expect(validateAudioFile('notes.txt', 10)).toEqual({ ok: false, error: 'Unsupported audio format.' });
  });

  it('enforces the 2 GB upload ceiling', () => {
    expect(validateAudioFile('meeting.mp3', 2 * 1024 ** 3 + 1)).toEqual({ ok: false, error: 'File exceeds the 2 GB limit.' });
  });
});

describe('language support', () => {
  it('maps Indonesian to its ISO-639-1 code and allows auto detection', () => {
    expect(languageCode('indonesian')).toBe('id');
    expect(languageCode('auto')).toBeUndefined();
  });
});

describe('timestamped transcripts', () => {
  it('offsets segments from later chunks', () => {
    expect(mergeChunkSegments([{ start: 1, end: 3, text: 'Halo' }], 1200, 2)).toEqual([
      { id: '2-0', startSeconds: 1201, endSeconds: 1203, text: 'Halo' },
    ]);
  });

  it('formats text and valid WebVTT', () => {
    const segments = [{ id: 'a', startSeconds: 1.25, endSeconds: 3.5, text: 'Selamat pagi.' }];
    expect(formatTimestamp(3661.25)).toBe('01:01:01.250');
    expect(toText(segments)).toBe('[00:00:01] Selamat pagi.');
    expect(toVtt(segments)).toContain('00:00:01.250 --> 00:00:03.500\nSelamat pagi.');
  });
});
