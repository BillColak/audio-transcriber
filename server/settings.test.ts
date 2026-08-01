import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from './settings.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function scaffold() {
  const dir = await mkdtemp(path.join(tmpdir(), 'settings-'));
  dirs.push(dir);
  return { dir, store: new SettingsStore(dir, { transcribe: 'gpt-transcribe', summary: 'gpt-5-mini' }) };
}

describe('SettingsStore', () => {
  it('reports no key when neither a saved key nor the environment provides one', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const { store } = await scaffold();
    await store.load();
    expect(store.apiKey()).toBeUndefined();
    expect(store.snapshot()).toEqual({ hasApiKey: false, keySource: null, transcribeModel: 'gpt-transcribe', summaryModel: 'gpt-5-mini' });
  });

  it('falls back to the environment for developers running from a .env', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-the-env-file-1234');
    const { store } = await scaffold();
    await store.load();
    expect(store.apiKey()).toBe('sk-from-the-env-file-1234');
    expect(store.snapshot().keySource).toBe('environment');
  });

  it('saves a key that survives a reload and wins over the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-the-env-file-1234');
    const { dir, store } = await scaffold();
    await store.load();
    await store.setApiKey('  sk-pasted-into-the-app-5678  ');

    expect(store.apiKey()).toBe('sk-pasted-into-the-app-5678');
    expect(store.snapshot().keySource).toBe('settings');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ openaiApiKey: 'sk-pasted-into-the-app-5678' });

    const reopened = new SettingsStore(dir, { transcribe: 'gpt-transcribe', summary: 'gpt-5-mini' });
    await reopened.load();
    expect(reopened.apiKey()).toBe('sk-pasted-into-the-app-5678');
  });

  it('rejects something that is obviously not a key', async () => {
    const { store } = await scaffold();
    await expect(store.setApiKey('nope')).rejects.toThrow('does not look like an OpenAI API key');
  });
});
