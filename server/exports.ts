import { formatTimestamp } from './domain.js';
import type { Segment, Transcript } from './types.js';

export function toText(segments: Segment[]): string {
  return segments.map((segment) => `[${formatTimestamp(segment.startSeconds, false)}] ${segment.text}`).join('\n');
}

export function toVtt(segments: Segment[]): string {
  const cues = segments.map((segment, index) =>
    `${index + 1}\n${formatTimestamp(segment.startSeconds)} --> ${formatTimestamp(segment.endSeconds)}\n${segment.text}`,
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function toMarkdown(transcript: Transcript): string {
  return `# ${transcript.title}\n\n${transcript.summary ?? ''}\n`;
}
