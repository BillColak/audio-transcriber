import path from 'node:path';
import type { LanguagePreference, Segment } from './types.js';

const supportedExtensions = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.wav', '.webm']);
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

export function validateAudioFile(filename: string, size: number): { ok: true } | { ok: false; error: string } {
  if (!supportedExtensions.has(path.extname(filename).toLowerCase())) return { ok: false, error: 'Unsupported audio format.' };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: 'File exceeds the 2 GB limit.' };
  if (size === 0) return { ok: false, error: 'The audio file is empty.' };
  return { ok: true };
}

/** `gpt-transcribe` takes a `languages` array; auto-detect means sending nothing at all. */
export function languageCodes(language: LanguagePreference): string[] | undefined {
  return language === 'indonesian' ? ['id'] : undefined;
}

/** One segment per prepared chunk — the model returns no sub-segment timings, so the chunk is the unit. */
export function chunkSegment(text: string, offsetSeconds: number, durationSeconds: number, chunkIndex: number): Segment {
  return {
    id: `${chunkIndex}-0`,
    startSeconds: offsetSeconds,
    endSeconds: offsetSeconds + durationSeconds,
    text: text.trim(),
  };
}

export function joinSegments(segments: Segment[]): string {
  return segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n\n');
}

export function formatTimestamp(seconds: number, milliseconds = true): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const base = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
  return milliseconds ? `${base}.${String(ms).padStart(3, '0')}` : base;
}
