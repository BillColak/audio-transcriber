// Builds everything the Tauri bundle needs in order to run the Express backend
// without Node.js installed on the user's machine:
//
//   src-tauri/binaries/server-<target-triple>[.exe]  the Node runtime itself, renamed
//                                                    to Tauri's sidecar convention
//   src-tauri/resources/server.mjs                   the whole backend, bundled by esbuild
//   src-tauri/resources/ffmpeg[.exe]                 the ffmpeg-static platform binary
//   src-tauri/resources/api-key.txt                  the build machine's OPENAI_API_KEY, if any
//
// All output is gitignored: it is regenerated on every build. The API key file exists because
// this app is only ever built and installed by its own developer for their own machines, never
// distributed to the public — see AGENTS.md. Anyone shipping this to other people should remove
// this step and rely on the in-app Settings screen instead.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import dotenv from 'dotenv';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaries = path.join(root, 'src-tauri', 'binaries');
const resources = path.join(root, 'src-tauri', 'resources');
const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';

dotenv.config({ path: path.join(root, '.env') });

/** Tauri looks for `<name>-<target-triple>`, so ask rustc what this host actually is. */
function targetTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = output.split('\n').find((line) => line.startsWith('host:'));
  if (!host) throw new Error('Could not read the host target triple from `rustc -vV`.');
  return host.replace('host:', '').trim();
}

function ffmpegSource() {
  const resolved = createRequire(import.meta.url)('ffmpeg-static');
  if (typeof resolved !== 'string') throw new Error('ffmpeg-static did not resolve to a binary path.');
  statSync(resolved);
  return resolved;
}

mkdirSync(binaries, { recursive: true });
mkdirSync(resources, { recursive: true });

// `server/index.ts` uses top-level await, so the bundle has to be ESM. The banner restores the
// CommonJS globals that bundled dependencies still expect.
await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outfile: path.join(resources, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['ffmpeg-static'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_of } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_of(__filename);',
    ].join('\n'),
  },
});

const triple = targetTriple();
const sidecar = path.join(binaries, `server-${triple}${exe}`);
rmSync(sidecar, { force: true });
copyFileSync(process.execPath, sidecar);
if (!windows) chmodSync(sidecar, 0o755);

const ffmpeg = path.join(resources, `ffmpeg${exe}`);
copyFileSync(ffmpegSource(), ffmpeg);
if (!windows) chmodSync(ffmpeg, 0o755);

// Bake in the build machine's own key so the packaged app never shows the setup screen. This
// repo is private and only ever installed by its own developer — see the note at the top of
// this file before copying this pattern into a project that will reach other people.
const apiKeyFile = path.join(resources, 'api-key.txt');
const bundledKey = process.env.OPENAI_API_KEY?.trim();
if (bundledKey) {
  writeFileSync(apiKeyFile, bundledKey, 'utf8');
  if (!windows) chmodSync(apiKeyFile, 0o600);
} else {
  rmSync(apiKeyFile, { force: true });
  console.warn('warning   no OPENAI_API_KEY in .env — the packaged app will still ask for one');
}

console.log(`sidecar   ${path.relative(root, sidecar)}`);
console.log(`backend   ${path.relative(root, path.join(resources, 'server.mjs'))}`);
console.log(`ffmpeg    ${path.relative(root, ffmpeg)}`);
console.log(`api key   ${bundledKey ? 'bundled from .env' : 'not bundled'}`);
