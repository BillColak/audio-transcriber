import OpenAI from 'openai';
import type { KeyCheck } from './types.js';

/**
 * Proves a key works before someone waits out a two-hour transcription to find out it does not.
 * Listing models costs no tokens, and it answers both questions that matter: is the key valid,
 * and can this account actually reach the models this app is configured to use? The second is a
 * real failure mode — a perfectly good key on an account without access to the newer models.
 */
export class OpenAIKeyVerifier {
  constructor(private readonly models: () => string[]) {}

  async verify(key: string): Promise<KeyCheck> {
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, message: 'Enter an API key first.' };

    let available: Set<string>;
    try {
      const client = new OpenAI({ apiKey: trimmed });
      available = new Set<string>();
      for await (const model of client.models.list()) available.add(model.id);
    } catch (error) {
      return { ok: false, message: humanize(error) };
    }

    const missing = [...new Set(this.models())].filter((id) => !available.has(id));
    if (missing.length) {
      return {
        ok: false,
        message: `The key is valid, but this account cannot use ${missing.join(' or ')}. Enable ${missing.length > 1 ? 'those models' : 'that model'} on your OpenAI account, or set an override.`,
      };
    }
    return { ok: true, message: 'The key works, and every model this app needs is available.' };
  }
}

function humanize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthorized|invalid.?api.?key|incorrect api key/i.test(message)) {
    return 'OpenAI rejected this key. Check it was copied in full.';
  }
  if (/429|quota|billing/i.test(message)) {
    return 'The key is valid but the account is out of quota, or billing is not set up.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(message)) {
    return 'Could not reach OpenAI. Check this computer is online.';
  }
  return `Could not verify the key: ${message}`;
}
