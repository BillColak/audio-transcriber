import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDataDirectory } from './paths.js';

const platform = process.platform;
function pretend(value: NodeJS.Platform) { Object.defineProperty(process, 'platform', { value, configurable: true }); }
afterEach(() => { pretend(platform); vi.unstubAllEnvs(); });

describe('appDataDirectory', () => {
  it('keeps the established Windows location', () => {
    pretend('win32');
    vi.stubEnv('AUDIO_TRANSCRIBER_DATA_DIR', '');
    vi.stubEnv('APPDATA', 'C:\\Users\\Someone\\AppData\\Roaming');
    expect(appDataDirectory()).toBe(path.join('C:\\Users\\Someone\\AppData\\Roaming', 'Audio Transcriber'));
  });

  it('uses the macOS Application Support convention', () => {
    pretend('darwin');
    vi.stubEnv('AUDIO_TRANSCRIBER_DATA_DIR', '');
    expect(appDataDirectory()).toBe(path.join(homedir(), 'Library', 'Application Support', 'Audio Transcriber'));
  });

  it('honours an explicit override', () => {
    vi.stubEnv('AUDIO_TRANSCRIBER_DATA_DIR', '/tmp/somewhere');
    expect(appDataDirectory()).toBe('/tmp/somewhere');
  });
});
