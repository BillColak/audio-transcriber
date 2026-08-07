// Copies the only two things the packaged app still needs beside the executable:
//
//   src-tauri/resources/ffmpeg[.exe]   the ffmpeg-static platform binary
//   src-tauri/resources/api-key.txt    the build machine's OPENAI_API_KEY, if any
//
// The backend itself is compiled into the Tauri binary now, so there is no Node runtime to copy
// and no esbuild bundle to produce. Both outputs are gitignored and regenerated on every build.
//
// The API key file exists so a private build installed by its own developer never shows the setup
// screen. CI has no `.env`, so released installers omit it and users paste their own key.
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const resources = path.join(root, 'src-tauri', 'resources');
const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';

dotenv.config({ path: path.join(root, '.env') });

function ffmpegSource() {
  const resolved = createRequire(import.meta.url)('ffmpeg-static');
  if (typeof resolved !== 'string') throw new Error('ffmpeg-static did not resolve to a binary path.');
  statSync(resolved);
  return resolved;
}

mkdirSync(resources, { recursive: true });

// `resources/*` bundles whatever is in this directory, so a leftover from the Node sidecar era
// would silently add megabytes to every installer.
rmSync(path.join(resources, 'server.mjs'), { force: true });

const ffmpeg = path.join(resources, `ffmpeg${exe}`);
copyFileSync(ffmpegSource(), ffmpeg);
if (!windows) chmodSync(ffmpeg, 0o755);

const apiKeyFile = path.join(resources, 'api-key.txt');
const bundledKey = process.env.OPENAI_API_KEY?.trim();
if (bundledKey) {
  writeFileSync(apiKeyFile, bundledKey, 'utf8');
  if (!windows) chmodSync(apiKeyFile, 0o600);
} else {
  rmSync(apiKeyFile, { force: true });
}

console.log(`ffmpeg    ${path.relative(root, ffmpeg)}`);
console.log(`api key   ${bundledKey ? 'bundled from .env' : 'not bundled — the app will ask for one'}`);
