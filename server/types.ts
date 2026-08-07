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
  text: string;
  error: string | null;
  summarize: boolean;
  summary: string | null;
  summaryError: string | null;
  chatMessages: ChatMessage[];
}

/** The result of testing an API key from the Settings screen. */
export interface KeyCheck {
  ok: boolean;
  message: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
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
