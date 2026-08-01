import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';

let cached: string | null | undefined;

/**
 * In development the binary comes from the `ffmpeg-static` package. The packaged app has no
 * node_modules, so Tauri's Rust side passes the bundled binary's path in `AUDIO_TRANSCRIBER_FFMPEG`.
 */
export async function resolveFfmpeg(): Promise<string> {
  if (cached === undefined) cached = await locate();
  if (!cached) throw new Error('FFmpeg binary is unavailable.');
  return cached;
}

/** Only for tests — the resolved path is cached for the life of the process. */
export function resetFfmpegCache(): void {
  cached = undefined;
}

async function locate(): Promise<string | null> {
  const bundled = process.env.AUDIO_TRANSCRIBER_FFMPEG;
  if (bundled) {
    // Resource files can lose their executable bit when a bundler copies them.
    if (process.platform !== 'win32') await chmod(bundled, 0o755).catch(() => undefined);
    return bundled;
  }
  try {
    // Resolved lazily and outside the import graph so esbuild leaves it alone: in the packaged
    // bundle this throws, and the environment variable above is what answers instead.
    const resolved: unknown = createRequire(import.meta.url)('ffmpeg-static');
    return typeof resolved === 'string' ? resolved : null;
  } catch {
    return null;
  }
}
