export type TranscriptStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type LanguagePreference = 'auto' | 'indonesian';

export interface Segment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface Transcript {
  id: string;
  title: string;
  sourceName: string;
  language: LanguagePreference;
  status: TranscriptStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  segments: Segment[];
  error: string | null;
  summarize: boolean;
  summary: string | null;
  summaryError: string | null;
}

/** What a transcription model returns for one prepared chunk. `gpt-transcribe` has no sub-segment timings. */
export interface ChunkTranscription {
  text: string;
}

/** Everything the settings screen needs. Deliberately never includes the key itself. */
export interface SettingsSnapshot {
  hasApiKey: boolean;
  keySource: 'settings' | 'environment' | null;
  transcribeModel: string;
  summaryModel: string;
}
