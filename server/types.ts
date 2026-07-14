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
}

export interface RawSegment {
  start: number;
  end: number;
  text: string;
}
