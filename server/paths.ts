import { homedir } from 'node:os';
import path from 'node:path';

const APP_FOLDER = 'Audio Transcriber';

/**
 * Where this app keeps transcripts and settings, per OS convention. Deliberately the same
 * location whether the backend runs from `npm run dev` or from inside the packaged app, so a
 * developer and the installed app share one history.
 */
export function appDataDirectory(): string {
  const override = process.env.AUDIO_TRANSCRIBER_DATA_DIR;
  if (override) return override;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), APP_FOLDER);
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', APP_FOLDER);
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'audio-transcriber');
}
