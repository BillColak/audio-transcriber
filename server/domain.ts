import path from 'node:path';
import type { LanguagePreference, RawSegment, Segment } from './types.js';

const supportedExtensions = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.wav', '.webm']);
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

export function validateAudioFile(filename: string, size: number): { ok: true } | { ok: false; error: string } {
  if (!supportedExtensions.has(path.extname(filename).toLowerCase())) return { ok: false, error: 'Unsupported audio format.' };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: 'File exceeds the 2 GB limit.' };
  if (size === 0) return { ok: false, error: 'The audio file is empty.' };
  return { ok: true };
}

export function languageCode(language: LanguagePreference): string | undefined {
  return language === 'indonesian' ? 'id' : undefined;
}

export function mergeChunkSegments(raw: RawSegment[], offsetSeconds: number, chunkIndex: number): Segment[] {
  return raw.map((segment, index) => ({
    id: `${chunkIndex}-${index}`,
    startSeconds: offsetSeconds + segment.start,
    endSeconds: offsetSeconds + segment.end,
    text: segment.text.trim(),
  }));
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
