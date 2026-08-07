import { describe, expect, it } from 'vitest';
import { chunkSegment, formatTimestamp, joinSegments, languageCodes, validateAudioFile } from './domain.js';
import { toMarkdown } from './exports.js';

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
  it('maps Indonesian to a one-element language array and allows auto detection', () => {
    expect(languageCodes('indonesian')).toEqual(['id']);
    expect(languageCodes('auto')).toBeUndefined();
  });
});

describe('timestamped transcripts', () => {
  it('turns a chunk transcript into one segment spanning the chunk', () => {
    expect(chunkSegment('  Halo dunia  ', 1200, 300, 2)).toEqual({
      id: '2-0', startSeconds: 1200, endSeconds: 1500, text: 'Halo dunia',
    });
  });

  it('joins segments into a single body of text for summarising', () => {
    expect(joinSegments([
      { id: '0-0', startSeconds: 0, endSeconds: 1, text: 'Halo' },
      { id: '1-0', startSeconds: 1, endSeconds: 2, text: '  ' },
      { id: '2-0', startSeconds: 2, endSeconds: 3, text: 'dunia' },
    ])).toBe('Halo\n\ndunia');
  });

  it('formats timestamps', () => {
    expect(formatTimestamp(3661.25)).toBe('01:01:01.250');
  });

  it('exports a summary as Markdown', () => {
    expect(toMarkdown({ title: 'Rapat', summary: '## Summary\nSemua baik.' } as never)).toBe('# Rapat\n\n## Summary\nSemua baik.\n');
  });
});
