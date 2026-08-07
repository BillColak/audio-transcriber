import type { Transcript } from './types.js';

export function toText(transcript: Transcript): string {
  return transcript.text;
}

export function toMarkdown(transcript: Transcript): string {
  return `# ${transcript.title}\n\n${transcript.summary ?? ''}\n`;
}
