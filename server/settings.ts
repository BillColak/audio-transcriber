import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsSnapshot } from './types.js';

/** Anything shorter than this is a typo, not a key. */
export const MIN_API_KEY_LENGTH = 20;

/**
 * Holds the OpenAI key for a packaged app, where there is no repo `.env` to read.
 * A key saved here wins over the environment, so the in-app screen always has an effect;
 * a developer who never opens that screen keeps using their `.env`.
 */
export class SettingsStore {
  private stored: string | null = null;

  constructor(private readonly directory: string, private readonly models: { transcribe: string; summary: string }) {}

  private get file(): string { return path.join(this.directory, 'settings.json'); }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { openaiApiKey?: unknown };
      this.stored = typeof raw.openaiApiKey === 'string' && raw.openaiApiKey.trim() ? raw.openaiApiKey.trim() : null;
    } catch {
      this.stored = null;
    }
  }

  /** An `OPENAI_API_KEY=` line with nothing after it counts as no key at all. */
  private get fromEnvironment(): string | undefined {
    return process.env.OPENAI_API_KEY?.trim() || undefined;
  }

  apiKey(): string | undefined {
    return this.stored ?? this.fromEnvironment;
  }

  snapshot(): SettingsSnapshot {
    return {
      hasApiKey: Boolean(this.apiKey()),
      keySource: this.stored ? 'settings' : this.fromEnvironment ? 'environment' : null,
      transcribeModel: this.models.transcribe,
      summaryModel: this.models.summary,
    };
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed.length < MIN_API_KEY_LENGTH) throw new Error('That does not look like an OpenAI API key.');
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file, JSON.stringify({ openaiApiKey: trimmed }, null, 2), 'utf8');
    // The file holds a credential, so keep it to the owner where the OS supports that.
    if (process.platform !== 'win32') await chmod(this.file, 0o600).catch(() => undefined);
    this.stored = trimmed;
  }
}
