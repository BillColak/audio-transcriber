# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A private, local-only app that transcribes long recordings (including an explicit Indonesian mode) into editable, timestamped transcripts using OpenAI `gpt-transcribe`, and optionally summarises them into meeting minutes. Nothing is exposed publicly — the server binds to `127.0.0.1`.

## Commands

- `npm run dev` — runs **two** processes concurrently: Vite (frontend, `127.0.0.1:5173`) and `tsx watch server/index.ts` (Express API, `127.0.0.1:8787`). Vite proxies `/api` → `8787`. Open the Vite URL.
- `npm test` — `vitest run` (single pass). `npm run test:watch` for watch mode.
- Run one test file: `npx vitest run server/domain.test.ts`. By name: `npx vitest run -t "lists, edits, downloads"`.
- `npm run build` — `tsc -b` (type-checks both TS projects) then `vite build` into `dist/`.
- `npm start` — production-style run: serves built `dist/` from the Express server on `8787`. Requires `NODE_ENV=production` and a prior `npm run build`.
- `npm run lint` — ESLint (flat config, `eslint.config.js`).
- `npm run dev:tauri` / `npm run build:tauri` — the desktop app. Both run `npm run tauri:prepare` first (see **Desktop packaging**). `build:tauri` needs Rust and a C toolchain; it writes an installer to `src-tauri/target/release/bundle/`.

Requires Node 22+, and `OPENAI_API_KEY` in a `.env` file at the repo root (loaded via `dotenv`; the key never reaches the browser). Three optional overrides: `OPENAI_TRANSCRIBE_MODEL` (default `gpt-transcribe`), `OPENAI_SUMMARY_MODEL` and `OPENAI_CHAT_MODEL` (both default `gpt-5.6-terra`).

## Architecture

The server is built around **ports/adapters dependency injection** so the core is testable without FFmpeg or OpenAI. This is the main thing to understand before editing `server/`:

- `server/index.ts` — the **composition root**. Nothing else wires dependencies. It constructs the store, injects `prepare`/`transcribe`/`summarize` adapters into `JobProcessor`, and passes `enqueue`/`cancel` into `createApp`. It also builds the `SettingsStore` and passes it to both. The adapters ask it for the API key **per job, not at boot**, so a key saved from the Settings screen takes effect without a restart. This is also where data/work directories and production static-file serving are configured.
- `server/app.ts` — `createApp(options)` is a pure factory returning an Express app. It receives `store`, `uploadDirectory`, a `settings` port, and `enqueue`/`cancel` callbacks; it never imports the queue or processor directly. Tests call it with fakes.
- `server/processor.ts` — `JobProcessor.process()` orchestrates the pipeline: mark processing → `prepare` (chunk) → loop `transcribe` each chunk → `chunkSegment` with a running time offset → save after each chunk (so progress/partial results persist) → optionally `summarize`. Cancellation is a `Set<id>` checked between chunks; the `finally` block always deletes the upload and chunk files. A summarisation failure is recorded in `summaryError` and never fails the job.
- `server/media.ts` — `FfmpegMedia` (adapter for `prepare`). Transcodes to mono 16 kHz MP3 and segments into 20-minute chunks (`-segment_time 1200`), using whatever binary `server/ffmpeg.ts` resolves. Chunk duration is measured by **parsing ffmpeg stderr** (there is no ffprobe).
- `server/openai-transcriber.ts` — `OpenAITranscriber` (adapter for `transcribe`). `gpt-transcribe` with plain `response_format: 'json'` and a `languages` **array**. The SDK types do not model `languages` yet, so the request object is cast once at the call site — do not "fix" that by reverting to the singular `language`.
- `server/openai-summarizer.ts` — `OpenAISummarizer` (adapter for `summarize`). `chat.completions.create` with a detailed meeting-minutes system prompt and `reasoning_effort: 'high'` — the transcriber has no speaker labels and mishears names constantly, so reconstructing intent from context is the model's actual job. Sends **no** `temperature` or `max_tokens`: the gpt-5 family rejects both. The input cap is a cost guard (staying inside the cheaper short-context price tier), not a capacity limit; the context window is far larger.
- `server/openai-verify.ts` — `OpenAIKeyVerifier` (adapter for `verify`), behind `POST /api/settings/test`. Lists models, which costs no tokens, and checks the configured models are actually reachable on that account — a valid key without access to them is a real failure that would otherwise only surface hours later, mid-job. It is deliberately not wired into save: testing never persists anything.
- `server/queue.ts` — `JobQueue`, a single-worker in-process queue (`drain()` runs one job at a time). Queued-but-not-started jobs can be cancelled directly; the active job is cancelled through the processor.
- `server/store.ts` — `TranscriptStore`, one JSON file per transcript in the data dir. `get`/`list` backfill the summary fields so records written before that feature still load. `recoverInterrupted()` runs at boot and marks any `queued`/`processing` records as `failed` (the queue is in-memory, so it does not survive restarts).
- `server/domain.ts` — pure, framework-free functions (validation, `languageCodes`, `chunkSegment`, `joinSegments`, `formatTimestamp`). Prefer adding logic here where it can be unit-tested in isolation.
- `server/settings.ts` — `SettingsStore`, the OpenAI key for a packaged app (there is no repo `.env` there). Persists `settings.json` beside the transcripts. **A saved key wins over `process.env`**, so the in-app screen always takes effect; a developer who never opens it keeps using their `.env`. The key is write-only over HTTP — `GET /api/settings` reports `hasApiKey`/`keySource`, never the key.
- `server/paths.ts` — `appDataDirectory()`, the per-OS data location. The Windows path is unchanged from before so existing transcripts still load.
- `server/ffmpeg.ts` — resolves the FFmpeg binary lazily. In the packaged app there is no `node_modules`, so `AUDIO_TRANSCRIBER_FFMPEG` (set by the Rust side) wins; otherwise it falls back to the `ffmpeg-static` package. The `createRequire` call is deliberately opaque to esbuild — do not turn it back into a top-level import.
- `server/exports.ts` — TXT, VTT, and summary-Markdown serialization. `server/types.ts` — shared server-side types.

**Request → job flow:** `POST /api/transcriptions` (multer upload) validates, reads the `language` and `summarize` text fields, saves a `queued` transcript, and calls `enqueue`. The frontend polls `GET /api/transcriptions` every 1.5s while any job is `queued`/`processing`.

### Timestamps are chunk-level

`gpt-transcribe` returns no segment or word timings — only `whisper-1` and `gpt-4o-transcribe-diarize` support `timestamp_granularities`/`verbose_json` segments. This was a deliberate, accepted tradeoff. Timings come from ffmpeg chunking instead: **one `Segment` per 20-minute chunk**, `startSeconds` = cumulative offset, `endSeconds` = offset + measured chunk duration. Do not reintroduce per-sentence segments without changing the model.

### Frontend

`src/App.tsx` is the entire UI (single component). Upload uses `XMLHttpRequest` for progress events; everything else uses `fetch`. Note the `Transcript`/`Segment`/`Status` types are **redeclared** here rather than imported from `server/types.ts` — keep them in sync manually when changing the API shape.

## Conventions / gotchas

- **ESM with `NodeNext`:** `server/` code imports sibling modules with a `.js` extension even though the files are `.ts` (e.g. `import { createApp } from './app.js'`). Match this — omitting `.js` breaks resolution.
- **Two TS projects:** `tsconfig.app.json` (browser, `src/`, `Bundler` resolution) and `tsconfig.node.json` (server, `NodeNext`). The root `tsconfig.json` only references them; `tsc -b` builds both.
- Tests live beside the code they cover (`*.test.ts` / `*.test.tsx`); Vitest uses `jsdom` and `src/test/setup.ts`. Vitest runs without `globals`, so `setup.ts` registers Testing Library `cleanup` by hand — component tests leak into each other otherwise. API tests use `supertest` against `createApp` with injected fakes — no network or FFmpeg needed.
- Data locations: transcripts and `settings.json` persist under `%APPDATA%\Audio Transcriber` (Windows) or `~/Library/Application Support/Audio Transcriber` (macOS), via `appDataDirectory()`. Uploads/chunks go to a temp `audio-transcriber` dir and are deleted after each job.

## Desktop packaging

`src-tauri/` wraps the app as a Tauri v2 desktop build. The React frontend is unchanged; the Express server is shipped as a **sidecar child process** so end users need no Node.js.

- `scripts/prepare-sidecar.mjs` generates three gitignored artefacts before every dev/build run: `src-tauri/binaries/server-<target-triple>[.exe]` (a copy of the build machine's own Node runtime, named to Tauri's sidecar convention), `src-tauri/resources/server.mjs` (esbuild bundle of `server/index.ts`), and `src-tauri/resources/ffmpeg[.exe]`.
- The bundle must be **ESM**: `server/index.ts` uses top-level await, which esbuild refuses to emit as CJS. A banner restores `require`/`__dirname` for bundled CommonJS dependencies.
- `src-tauri/src/lib.rs` spawns the sidecar in `setup` (Node runtime, with the script path as argv and the ffmpeg path via env) and kills it on `RunEvent::ExitRequested`/`Exit`. If something already serves `127.0.0.1:8787` it skips the spawn, so `tauri dev` coexists with `npm run dev`.
- `resource_dir()` returns a Windows **verbatim** path (`\\?\C:\...`), and Node cannot resolve a main module through that prefix — it dies with `EISDIR: illegal operation on a directory, lstat 'C:'` before the script runs. `lib.rs`'s `plain()` strips the prefix on the way out to the sidecar; keep every path handed to the child process going through it. Rust's own fs calls are fine with the verbatim form, so the `PathBuf`s stay unstripped. This only reproduces in an installed build — running the bundle by hand from the repo path passes a plain path and hides it.
- Auto-update is the `tauri-plugin-updater` reading `latest.json` from the GitHub release feed, offered by `src/useUpdate.ts` and rendered as a banner in `App.tsx`. Three things are easy to get wrong. The **public key in `tauri.conf.json` must match** the private key in the CI secrets, or clients silently refuse every update. The feed only sees **published** releases, so a draft left unpublished ships nothing — and publishing a hand-made release instead of the CI draft leaves the feed pointing at a release with no `latest.json` at all. And the updater cannot reach installs older than the first build that shipped the plugin (1.0.2), so those upgrade by hand once.
- `useUpdate` fails silently by design: offline, unreachable feed, or malformed manifest all leave the app exactly as it was. An update check must never interrupt someone transcribing. It also never imports the plugin outside the Tauri webview, so `npm run dev` in a browser behaves as before.
- The sidecar is **not** started with `NODE_ENV=production`: Tauri serves the frontend, so Express stays API-only.
- The webview origin is not the dev server's, so `src/App.tsx` addresses the API absolutely when `window.__TAURI_INTERNALS__` is present, and `app.ts`'s CORS list includes the Tauri origins. Changing the port means changing `BACKEND_PORT` in `lib.rs`, the CORS and CSP entries, and `apiBase`.
- Never pass `--target` to `tauri build`: the sidecar is the build machine's own Node binary named from `rustc -vV`'s host triple, so a cross-compile bundles the wrong architecture. `.github/workflows/release.yml` builds natively per runner instead.
