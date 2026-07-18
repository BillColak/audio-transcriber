# Transcription Cost Controls — Design

**Date:** 2026-07-14
**Status:** Approved (pending spec review)

## Goal

Reduce OpenAI transcription cost and give the user control over the accuracy/cost trade-off, without breaking the timestamped-transcript experience for people who want it.

Three cost levers, all approved:

1. **Optional segment timestamps** — a UI toggle that switches the transcription model. Timestamps ON keeps the current `whisper-1` behavior; OFF uses the cheaper `gpt-4o-mini-transcribe` (~50% less) and produces a timestamp-free transcript.
2. **Silence trimming** — strip long silences before sending audio, cutting billed minutes. Applied in **both modes**, with exact timestamp remapping so ON-mode timestamps stay accurate.
3. **Retry without double-pay** — per-chunk retry with backoff so a transient failure doesn't discard (and force re-billing of) chunks already transcribed.

## Behavior

- A **timestamps toggle** sits next to the language selector in the upload card. Default **ON** (preserves today's behavior).
- **ON** → `whisper-1`, `response_format: 'verbose_json'`, segment granularity → real timestamped segments. TXT + VTT export.
- **OFF** → `gpt-4o-mini-transcribe`, `response_format: 'text'` → plain text, split into sentence-sized segments with `null` start/end. TXT export (no `[time]` prefix); VTT disabled.
- The toggle choice is stored on the transcript (`timestamps: boolean`) so the editor and exports render correctly on every later view, regardless of the current toggle state.
- **Pre-upload cost estimate**: on file selection the browser reads the audio duration and shows an "up to ~$X" estimate for the current toggle state ("up to" because silence trimming only reduces it).

## Data model changes (`server/types.ts`)

- `Transcript` gains `timestamps: boolean`.
- `Segment.startSeconds` and `Segment.endSeconds` become `number | null`.
- `RawSegment.start` and `RawSegment.end` become `number | null`.

Existing transcript JSON files predate this field. On read, treat a missing `timestamps` as `true` (they were all made with the timestamped path). This is handled where transcripts are loaded/rendered; no migration pass required.

## Server pipeline

### `openai-transcriber.ts`

`transcribe(filePath, opts: { language?: string; timestamps: boolean }): Promise<RawSegment[]>`

- **ON**: current path — `whisper-1`, `verbose_json`, `timestamp_granularities: ['segment']`, optional `language`. Returns segments with numeric times.
- **OFF**: `gpt-4o-mini-transcribe`, `response_format: 'text'`, optional `language`. Take the returned text, run `splitIntoSentences()`, return `RawSegment[]` with `start: null, end: null`.

### `domain.ts` (new pure functions)

- `splitIntoSentences(text): string[]` — split on sentence-ending punctuation (`.`, `!`, `?`, `…`) followed by whitespace; trim; drop empties; merge very short fragments into the previous sentence. Indonesian uses the same punctuation, so no locale-specific logic needed.
- `remapSegmentTimes(segments, keepIntervals): Segment[]` — map each segment's trimmed-timeline start/end back to the original timeline using the kept-audio intervals. `null` times pass through unchanged. When `keepIntervals` is a single full-span interval (no silence removed) the mapping is the identity.
- `mergeChunkSegments` updated: when a raw time is `null`, keep it `null` (do not add the chunk offset); otherwise behave as today.

### `media.ts` — silence trimming + remap map

Two-pass ffmpeg:

1. **Detect** — measure original total duration (existing stderr `Duration:` parse), then run `silencedetect=noise=-30dB:d=2` and parse `silence_start` / `silence_end` pairs from stderr. A trailing `silence_start` with no `silence_end` closes at the total duration.
2. Build **keep-intervals** = the complement of the detected silences over `[0, totalDuration]`.
3. **Trim + normalize** (pass A) — one ffmpeg command using `aselect='between(t,s,e)+…',asetpts=N/SR/TB` over the keep-intervals, output mono 16 kHz MP3.
4. **Segment** (pass B) — split the trimmed file into 20-minute chunks as today (`-f segment -segment_time 1200 -reset_timestamps 1`).

`prepare()` returns the existing `PreparedChunk[]` **plus** `keepIntervals` and the `originalDurationSeconds`.

**Bounding:** only silences ≥ 2 s at ≤ −30 dB are removed. If the keep-interval count would exceed a cap (~400) the min-silence duration is raised until it fits, and `log()` reports the final threshold, total seconds removed, and interval count. Degenerate case (no silence found) → one full-span keep-interval → identity remap.

### `processor.ts` — retry + remap wiring

- Each `transcribe` call is wrapped in `withRetry` (see below). Segment offsets accumulate in **trimmed** time as chunks are processed.
- After all chunks: if `timestamps` is ON, `remapSegmentTimes(segments, keepIntervals)` converts trimmed → original time; if OFF, times stay `null`.
- `transcript.durationSeconds` = the **original** measured duration (not the trimmed total), so the UI reflects the real recording length.
- Cancellation, cleanup, and partial-progress saving are unchanged.

### `retry.ts` (new)

`withRetry(fn, { attempts, isTransient, delayMs, sleep, isCancelled })`

- Up to 3 attempts; backoff 1 s / 2 s / 4 s.
- **Transient** (retry): HTTP `429`, HTTP `>= 500`, or network errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, or no status). **Non-transient** (fail fast, no wasted spend): `401`/`403`/`400`.
- `sleep` is injected so tests run instantly. Cancellation is checked between attempts.

### `exports.ts`

- `toText`: omit the `[time]` prefix when a segment's start is `null`.
- `toVtt`: only called for timestamped transcripts (guarded at the route).

### `app.ts`

- `POST /api/transcriptions`: read `timestamps` from the form body (default `true`; FormData sends the string `'false'` to disable). Store it on the transcript.
- `GET /api/transcriptions/:id/download?format=vtt`: return `400` ("This transcript has no timestamps — use TXT.") when `transcript.timestamps === false`.
- `PATCH` and other routes unchanged.

## Frontend (`src/App.tsx`)

- Add a `timestamps` boolean state (default `true`) and a toggle control in `.upload-options`.
- On file select, read duration via `URL.createObjectURL(file)` + a hidden `<audio>`'s `loadedmetadata`; store it and revoke the object URL. Show "up to ~$X.XX" using client-side rates (`whisper-1` $0.006/min, `gpt-4o-mini-transcribe` $0.003/min — approximate, commented as subject to change). Hide the estimate gracefully if the browser can't read duration.
- Append `timestamps` to the upload `FormData`.
- `Transcript` interface gains `timestamps: boolean`; `Segment` times become `number | null`.
- Editor: render the `<time>` element only when `segment.startSeconds !== null`; show the VTT link only when `selected.timestamps`.

## Testing strategy

Pure logic is unit-tested; the ffmpeg path gets a real integration test on synthesized audio.

- **`domain.test.ts`**: `splitIntoSentences` (multiple sentences, Indonesian punctuation, trailing fragment, empty input); `remapSegmentTimes` (identity with one interval, correct offsets across gaps, `null` passthrough, segment spanning a boundary); `mergeChunkSegments` (offset applied for numeric times, `null` passthrough).
- **`retry.test.ts`**: succeeds first try; retries a transient error then succeeds; gives up after 3 persistent transient errors; fails fast on a non-transient error; honors cancellation; uses injected instant `sleep`.
- **`exports.test.ts`**: TXT with `null` times (no prefix); TXT with times; VTT with times.
- **`app.test.ts`**: `POST` with `timestamps=false` creates a transcript with `timestamps: false`; VTT download returns `400` for a no-timestamp transcript; TXT download works for it.
- **`processor.test.ts`**: ON mode with fake tools returns timed segments and applies remap using fake keep-intervals; OFF mode fake `transcribe` returns text → sentence segments with `null` times; a transient failure on one chunk retries and the job still completes with no lost segments; cancellation between chunks still cancels.
- **`media` integration test**: synthesize a short clip with a known silent gap (ffmpeg `sine` + `anullsrc` concat), run `prepare`, assert chunks are produced and the reported removed duration / keep-intervals match the gap within tolerance.
- **`App.test.tsx`**: toggle renders and flips; cost estimate appears on file select (mocked audio duration); editor hides the time column and VTT link when `timestamps` is `false`.

## Out of scope

- Audio speed-up (`atempo`) cost hack.
- Full resume-from-crash / "Resume" button (only in-run retry is included).
- Word-level timestamps.
- Changing the `whisper-1` model version used for the ON path.

## Risks / verify at implementation time

- Confirm the installed `openai` SDK accepts `gpt-4o-mini-transcribe` with `response_format: 'text'` and the `language` param; adjust if the model rejects `language`.
- `aselect` filter-string length for pathological files — mitigated by the interval cap; if a file still overflows, fall back to a filter-script file.
- Browser duration read fails for some containers — the estimate hides itself; no functional impact.
