# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A private, local-only app that transcribes long recordings (including an explicit Indonesian mode) into editable, timestamped transcripts using OpenAI `gpt-transcribe`, and optionally summarises them into meeting minutes. Nothing is exposed publicly — the server binds to `127.0.0.1`.

## Commands

- `npm run dev` — runs Vite (`127.0.0.1:5173`) and the Rust backend (`cargo run --bin serve`, `127.0.0.1:8787`) concurrently. Vite proxies `/api` → `8787`. The first run compiles Rust, so it is slow; after that it is fast.
- `npm test` — `vitest run` (single pass). `npm run test:watch` for watch mode.
- Rust tests: `cargo test --lib --manifest-path src-tauri/Cargo.toml`. Frontend tests: `npx vitest run src/App.test.tsx`.
- `npm run build` — `tsc -b` (type-checks both TS projects) then `vite build` into `dist/`.
- `npm run lint` — ESLint (flat config, `eslint.config.js`).
- `npm run dev:tauri` / `npm run build:tauri` — the desktop app. Both run `npm run tauri:prepare` first (see **Desktop packaging**). `build:tauri` needs Rust and a C toolchain; it writes an installer to `src-tauri/target/release/bundle/`.

Requires Node 22+ (frontend tooling only) and a Rust toolchain, plus `OPENAI_API_KEY` in a `.env` file at the repo root (loaded via `dotenv`; the key never reaches the browser). Three optional overrides: `OPENAI_TRANSCRIBE_MODEL` (default `gpt-transcribe`), `OPENAI_SUMMARY_MODEL` and `OPENAI_CHAT_MODEL` (both default `gpt-5.6-terra`).

## Architecture

The backend is **Rust, compiled into the Tauri binary**. There is no Node runtime, no sidecar, and
no separate server process. `src-tauri/src/` holds it:

- `lib.rs` — the **composition root**, and the only place adapters are constructed. It builds the
  store, settings, FFmpeg media adapter and job queue, then serves axum on `127.0.0.1:8787`. If the
  port is already served it skips starting, so `npm run dev:server` and the desktop app coexist.
- `api.rs` — axum routes. Uploads stream straight to disk (`DefaultBodyLimit::disable()`), because a
  2 GB recording must never be buffered in memory. CORS **rejects** a disallowed origin rather than
  merely omitting the header, which is stricter than the Express version was.
- `processor.rs` — the pipeline: mark processing → `prepare` (chunk) → transcribe each chunk →
  `chunk_segment` with a running offset → save after every chunk → optionally summarise.
  Cancellation is a `HashSet` checked between chunks. The upload and every chunk are deleted at the
  end whatever happened. A summarisation failure is recorded and never fails the job.
- `processor.rs` defines the `ProcessingTools` trait — the ports/adapters seam that keeps the
  pipeline testable without FFmpeg or OpenAI. Tests inject a fake; `lib.rs` injects the real thing.
- `media.rs` — FFmpeg: mono 16 kHz MP3 segmented at 20 minutes. **The argument list determines chunk
  boundaries and therefore every timestamp in existing transcripts — do not change it casually.**
  There is no ffprobe, so chunk duration is parsed out of FFmpeg's stderr banner.
- `openai.rs` — all four OpenAI calls. `gpt-transcribe` takes a **repeated `languages[]` multipart
  field**; that is precisely how the OpenAI SDK encodes an array, and a singular `language` is
  silently ignored by the model. Summarisation sends `reasoning_effort: "high"`. No `temperature` or
  `max_tokens` — the gpt-5 family rejects both.
- `api.rs`'s upload handler treats a multipart **stream error as a failure, not end-of-body**, in both
  the field loop and the chunk loop. The upload Cancel button aborts the request mid-body; swallowing
  that error queues a job against truncated audio, which FFmpeg often still decodes — so the user is
  billed for transcribing an upload they cancelled. `Err` and `Ok(None)` must stay distinct.
- `store.rs` — one JSON file per transcript. Ids come off the URL, so they are **whitelisted**, not
  sanitised. `Transcript` deserialises records the old TypeScript backend wrote; fields added later
  are `serde(default)`, and `list()` skips an unreadable file rather than failing the whole history.
- `settings.rs`, `paths.rs`, `domain.rs`, `exports.rs`, `queue.rs`, `types.rs` — settings (a saved
  key beats `process.env`), per-OS data directory, pure logic, serialisation, the single-worker
  queue, and shared types.

**Request → job flow:** `POST /api/transcriptions` streams the upload to disk, validates it, saves a
`queued` transcript and enqueues it. The frontend polls `GET /api/transcriptions` every 1.5s while
anything is `queued`/`processing`.

### Timestamps are chunk-level

`gpt-transcribe` returns no segment or word timings. Timings come from FFmpeg chunking instead:
**one `Segment` per 20-minute chunk**, `start_seconds` = cumulative offset. Do not reintroduce
per-sentence segments without changing the model.

### Frontend

`src/App.tsx` is the entire UI (single component), plus `src/useUpdate.ts` for auto-update. The
`Transcript`/`Segment`/`Status` types are **redeclared** there rather than shared with the backend —
they now mirror Rust structs in `src-tauri/src/types.rs`, so keep them in sync by hand.

## Conventions / gotchas

- **Two TS projects:** `tsconfig.app.json` (browser, `src/`) and `tsconfig.node.json` (build tooling only — Vite config and `scripts/`). The root `tsconfig.json` references both; `tsc -b` builds them.
- Frontend tests live beside the code (`*.test.tsx`); Vitest uses `jsdom` and `src/test/setup.ts`, and registers Testing Library `cleanup` by hand because it runs without `globals`. Backend tests are Rust unit tests in the same file as the code, using the `ProcessingTools` fake — no network or FFmpeg needed.
- Data locations: transcripts and `settings.json` persist under `%APPDATA%\Audio Transcriber` (Windows) or `~/Library/Application Support/Audio Transcriber` (macOS), via `appDataDirectory()`. Uploads/chunks go to a temp `audio-transcriber` dir and are deleted after each job.

## Desktop packaging

`src-tauri/` wraps the app as a Tauri v2 desktop build. The backend is compiled in, so an installer
carries only the executable and FFmpeg.

- `scripts/prepare-resources.mjs` generates two gitignored artefacts before every dev/build run:
  `src-tauri/resources/ffmpeg[.exe]` and, if the build machine has a key in `.env`,
  `src-tauri/resources/api-key.txt`. CI has no `.env`, so released installers omit the key and users
  paste their own.
- **There is no sidecar.** Removing Node also removed the whole class of packaging bugs it brought:
  the `\?\` verbatim-path crash, the esbuild ESM/CJS rules, and the target-triple binary naming.
  `tauri build` no longer cares what architecture the build machine is, except for FFmpeg.
- The crate has **two binaries**: the Tauri app and `serve` (the dev-only headless backend). Without
  `default-run` in `Cargo.toml` and `mainBinaryName` in `tauri.conf.json` the bundler picks the wrong
  one and ships the console server as the app — it builds and signs cleanly, so the only symptom is
  an installed app that opens no window. Do not remove either setting.
- Auto-update is `tauri-plugin-updater` reading `latest.json` from the GitHub release feed, offered
  by `src/useUpdate.ts`. Three things are easy to get wrong. The **public key in `tauri.conf.json`
  must match** the private key in CI secrets, or clients silently refuse every update. The feed only
  sees **published** releases, so an unpublished draft ships nothing — and publishing a hand-made
  release instead of the CI draft leaves the feed pointing at a release with no `latest.json`.
  And the updater cannot reach installs older than 1.0.2, the first build that shipped it.
- `useUpdate` fails silently by design: offline, unreachable feed, or malformed manifest all leave
  the app as it was. It never imports the plugin outside the Tauri webview.
- Installs are **per-user** (`nsis.installMode: currentUser`) so updates need no elevation.
- The webview origin is not the dev server's, so `src/App.tsx` addresses the API absolutely when
  `window.__TAURI_INTERNALS__` is present, and `api.rs`'s CORS list includes the Tauri origins.
  Changing the port means changing `BACKEND_PORT` in `lib.rs`, the CORS and CSP entries, and `apiBase`.
