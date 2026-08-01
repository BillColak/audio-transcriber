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

Requires Node 22+, and `OPENAI_API_KEY` in a `.env` file at the repo root (loaded via `dotenv`; the key never reaches the browser). Two optional overrides: `OPENAI_TRANSCRIBE_MODEL` (default `gpt-transcribe`) and `OPENAI_SUMMARY_MODEL` (default `gpt-5-mini`).

## Architecture

The server is built around **ports/adapters dependency injection** so the core is testable without FFmpeg or OpenAI. This is the main thing to understand before editing `server/`:

- `server/index.ts` — the **composition root**. Nothing else wires dependencies. It constructs the store, injects `prepare`/`transcribe`/`summarize` adapters into `JobProcessor`, and passes `enqueue`/`cancel` into `createApp`. The adapters read `process.env.OPENAI_API_KEY` **per job, not at boot**, so a key saved at runtime takes effect without a restart. This is also where data/work directories and production static-file serving are configured.
- `server/app.ts` — `createApp(options)` is a pure factory returning an Express app. It receives `store`, `uploadDirectory`, and `enqueue`/`cancel` callbacks; it never imports the queue or processor directly. Tests call it with fakes.
- `server/processor.ts` — `JobProcessor.process()` orchestrates the pipeline: mark processing → `prepare` (chunk) → loop `transcribe` each chunk → `chunkSegment` with a running time offset → save after each chunk (so progress/partial results persist) → optionally `summarize`. Cancellation is a `Set<id>` checked between chunks; the `finally` block always deletes the upload and chunk files. A summarisation failure is recorded in `summaryError` and never fails the job.
- `server/media.ts` — `FfmpegMedia` (adapter for `prepare`). Uses `ffmpeg-static` to transcode to mono 16 kHz MP3 and segment into 20-minute chunks (`-segment_time 1200`). Chunk duration is measured by **parsing ffmpeg stderr** (there is no ffprobe).
- `server/openai-transcriber.ts` — `OpenAITranscriber` (adapter for `transcribe`). `gpt-transcribe` with plain `response_format: 'json'` and a `languages` **array**. The SDK types do not model `languages` yet, so the request object is cast once at the call site — do not "fix" that by reverting to the singular `language`.
- `server/openai-summarizer.ts` — `OpenAISummarizer` (adapter for `summarize`). `chat.completions.create` with a meeting-minutes system prompt. Sends **no** `temperature` or `max_tokens`: the gpt-5 family rejects both.
- `server/queue.ts` — `JobQueue`, a single-worker in-process queue (`drain()` runs one job at a time). Queued-but-not-started jobs can be cancelled directly; the active job is cancelled through the processor.
- `server/store.ts` — `TranscriptStore`, one JSON file per transcript in the data dir. `get`/`list` backfill the summary fields so records written before that feature still load. `recoverInterrupted()` runs at boot and marks any `queued`/`processing` records as `failed` (the queue is in-memory, so it does not survive restarts).
- `server/domain.ts` — pure, framework-free functions (validation, `languageCodes`, `chunkSegment`, `joinSegments`, `formatTimestamp`). Prefer adding logic here where it can be unit-tested in isolation.
- `server/exports.ts` — TXT and VTT serialization. `server/types.ts` — shared server-side types.

**Request → job flow:** `POST /api/transcriptions` (multer upload) validates, reads the `language` and `summarize` text fields, saves a `queued` transcript, and calls `enqueue`. The frontend polls `GET /api/transcriptions` every 1.5s while any job is `queued`/`processing`.

### Timestamps are chunk-level

`gpt-transcribe` returns no segment or word timings — only `whisper-1` and `gpt-4o-transcribe-diarize` support `timestamp_granularities`/`verbose_json` segments. This was a deliberate, accepted tradeoff. Timings come from ffmpeg chunking instead: **one `Segment` per 20-minute chunk**, `startSeconds` = cumulative offset, `endSeconds` = offset + measured chunk duration. Do not reintroduce per-sentence segments without changing the model.

### Frontend

`src/App.tsx` is the entire UI (single component). Upload uses `XMLHttpRequest` for progress events; everything else uses `fetch`. Note the `Transcript`/`Segment`/`Status` types are **redeclared** here rather than imported from `server/types.ts` — keep them in sync manually when changing the API shape.

## Conventions / gotchas

- **ESM with `NodeNext`:** `server/` code imports sibling modules with a `.js` extension even though the files are `.ts` (e.g. `import { createApp } from './app.js'`). Match this — omitting `.js` breaks resolution.
- **Two TS projects:** `tsconfig.app.json` (browser, `src/`, `Bundler` resolution) and `tsconfig.node.json` (server, `NodeNext`). The root `tsconfig.json` only references them; `tsc -b` builds both.
- Tests live beside the code they cover (`*.test.ts` / `*.test.tsx`); Vitest uses `jsdom` and `src/test/setup.ts`. Vitest runs without `globals`, so `setup.ts` registers Testing Library `cleanup` by hand — component tests leak into each other otherwise. API tests use `supertest` against `createApp` with injected fakes — no network or FFmpeg needed.
- Data locations: transcripts persist under `%APPDATA%\Audio Transcriber\transcripts` (Windows); uploads/chunks go to a temp `audio-transcriber` dir and are deleted after each job.
