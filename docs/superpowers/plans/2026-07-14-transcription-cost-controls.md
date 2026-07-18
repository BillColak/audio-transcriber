# Transcription Cost Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional-timestamps toggle (switching to a cheaper model when off), silence trimming with exact timestamp remapping, per-chunk retry, and a pre-upload cost estimate.

**Architecture:** The server keeps its ports/adapters shape. Pure logic (sentence splitting, silence→keep-interval math, timestamp remap, retry) lands in small testable modules; the ffmpeg adapter gains a silence-detect/trim pass that returns kept-audio intervals; the processor remaps trimmed timestamps back to the original timeline and wraps each transcription in retry-with-backoff. The React client gains a toggle and a browser-side duration→cost estimate.

**Tech Stack:** TypeScript, React, Vite, Express, Vitest, OpenAI SDK, ffmpeg-static.

## Global Constraints

- Node 22+. Server modules are ESM with `NodeNext` resolution — import siblings with a `.js` extension even for `.ts` files.
- Timestamps toggle defaults **ON** (preserves current behavior). Missing `timestamps` on old transcript JSON is treated as `true`.
- Models: `whisper-1` (timestamps ON, `verbose_json`), `gpt-4o-mini-transcribe` (timestamps OFF, `response_format: 'text'`).
- Client cost rates (approximate, comment as subject to change): `whisper-1` $0.006/min, `gpt-4o-mini-transcribe` $0.003/min.
- Silence detection: `silencedetect=noise=-30dB:d=2`; remove at most 400 intervals (drop shortest beyond the cap).
- Retry: 3 attempts, backoff 1 s / 2 s / 4 s, transient only (HTTP 429, HTTP ≥ 500, network error codes). Auth/400 fail fast.
- Server binds `127.0.0.1` only (unchanged). Tests run with `npx vitest run`.

---

### Task 1: Nullable-timestamp data model

Make timestamps optional end-to-end at the type level so the build stays green: add `Transcript.timestamps`, allow `null` segment times, and make `mergeChunkSegments` / exports null-safe. Update existing test fixtures to satisfy the new type.

**Files:**
- Modify: `server/types.ts`
- Modify: `server/domain.ts` (`mergeChunkSegments`)
- Modify: `server/exports.ts` (`toText`, `toVtt`)
- Modify: `server/store.ts` (default missing `timestamps` to `true` on read)
- Modify: `server/app.ts` (stopgap `timestamps: true` on the POST literal — Task 9 replaces it)
- Modify (fixtures): `server/store.test.ts`, `server/app.test.ts`, `server/processor.test.ts`, `src/App.test.tsx`
- Test: `server/domain.test.ts`, `server/store.test.ts`

**Interfaces:**
- Produces: `Transcript.timestamps: boolean`; `Segment.startSeconds: number | null`, `Segment.endSeconds: number | null`; `RawSegment.start: number | null`, `RawSegment.end: number | null`; `KeepInterval { start: number; end: number }`; `Silence { start: number; end: number }`; `TranscribeOptions { language?: string; timestamps: boolean }`.
- `TranscriptStore.get`/`list` return transcripts with `timestamps` always populated (legacy files → `true`).

- [ ] **Step 1: Write the failing test** — add to `server/domain.test.ts` inside `describe('timestamped transcripts', ...)`:

```ts
it('passes null chunk times through without offsetting', () => {
  expect(mergeChunkSegments([{ start: null, end: null, text: 'Halo' }], 1200, 0)).toEqual([
    { id: '0-0', startSeconds: null, endSeconds: null, text: 'Halo' },
  ]);
});

it('renders text export without a timestamp prefix when times are null', () => {
  expect(toText([{ id: '0-0', startSeconds: null, endSeconds: null, text: 'Halo dunia' }])).toBe('Halo dunia');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/domain.test.ts`
Expected: FAIL (type error on `null`, or `toText` emits a `[00:00:00]` prefix).

- [ ] **Step 3: Update the types** in `server/types.ts`:

```ts
export interface Segment {
  id: string;
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
}

export interface Transcript {
  id: string;
  title: string;
  sourceName: string;
  language: LanguagePreference;
  status: TranscriptStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  segments: Segment[];
  error: string | null;
  timestamps: boolean;
}

export interface RawSegment {
  start: number | null;
  end: number | null;
  text: string;
}

export interface KeepInterval {
  start: number;
  end: number;
}

export interface Silence {
  start: number;
  end: number;
}

export interface TranscribeOptions {
  language?: string;
  timestamps: boolean;
}
```

- [ ] **Step 4: Make `mergeChunkSegments` null-safe** in `server/domain.ts`:

```ts
export function mergeChunkSegments(raw: RawSegment[], offsetSeconds: number, chunkIndex: number): Segment[] {
  return raw.map((segment, index) => ({
    id: `${chunkIndex}-${index}`,
    startSeconds: segment.start === null ? null : offsetSeconds + segment.start,
    endSeconds: segment.end === null ? null : offsetSeconds + segment.end,
    text: segment.text.trim(),
  }));
}
```

- [ ] **Step 5: Make exports null-safe** in `server/exports.ts`:

```ts
export function toText(segments: Segment[]): string {
  return segments
    .map((segment) => (segment.startSeconds === null ? segment.text : `[${formatTimestamp(segment.startSeconds, false)}] ${segment.text}`))
    .join('\n');
}

export function toVtt(segments: Segment[]): string {
  const cues = segments.map((segment, index) =>
    `${index + 1}\n${formatTimestamp(segment.startSeconds ?? 0)} --> ${formatTimestamp(segment.endSeconds ?? 0)}\n${segment.text}`,
  );
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
```

- [ ] **Step 6: Write the failing legacy-read test** — add to `server/store.test.ts` (add `writeFile` to the `node:fs/promises` import):

```ts
it('defaults missing timestamps to true when reading legacy transcripts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'legacy-'));
  dirs.push(dir);
  const store = new TranscriptStore(dir);
  await writeFile(path.join(dir, 'old.json'), JSON.stringify({
    id: 'old', title: 'Old', sourceName: 'o.mp3', language: 'auto', status: 'completed', progress: 100,
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', durationSeconds: 3, segments: [], error: null,
  }), 'utf8');
  expect((await store.get('old'))?.timestamps).toBe(true);
  expect((await store.list())[0].timestamps).toBe(true);
});
```

Run: `npx vitest run server/store.test.ts` — Expected: FAIL (`timestamps` is `undefined`).

- [ ] **Step 7: Normalize on read** in `server/store.ts`. Add a helper and apply it in `get` and `list`:

```ts
async get(id: string): Promise<Transcript | null> {
  try { return normalize(JSON.parse(await readFile(this.file(id), 'utf8')) as Transcript); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async list(): Promise<Transcript[]> {
  await mkdir(this.directory, { recursive: true });
  const files = (await readdir(this.directory)).filter((file) => file.endsWith('.json'));
  const transcripts = await Promise.all(files.map(async (file) => normalize(JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as Transcript)));
  return transcripts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
```

Add at the bottom of `server/store.ts`:

```ts
function normalize(transcript: Transcript): Transcript {
  return { ...transcript, timestamps: transcript.timestamps ?? true };
}
```

Run: `npx vitest run server/store.test.ts` — Expected: PASS.

- [ ] **Step 8: Stopgap the API literal** in `server/app.ts` — add `timestamps: true` to the `Transcript` object built in the `POST /api/transcriptions` handler (the object with `id: randomUUID()`). Task 9 replaces this with the form-read value. This keeps `tsc` green now that `Transcript.timestamps` is required.

- [ ] **Step 9: Add `timestamps` to existing fixtures.** In `server/app.test.ts` and `server/processor.test.ts`, add `timestamps: true` to each transcript object literal passed to `store.save(...)`. In `server/store.test.ts`, add `timestamps: true` to the existing `transcript` literal. In `src/App.test.tsx`, add `timestamps: true` to the `saved` object.

- [ ] **Step 10: Run the full suite to verify green**

Run: `npx vitest run`
Expected: PASS (all files).

- [ ] **Step 11: Commit**

```bash
git add server/types.ts server/domain.ts server/exports.ts server/store.ts server/app.ts server/*.test.ts src/App.test.tsx docs/superpowers
git commit -m "feat: make transcript timestamps optional at the type level"
```

---

### Task 2: `splitIntoSentences`

Pure helper that turns the plain text from the no-timestamp model into editable sentence-sized pieces.

**Files:**
- Modify: `server/domain.ts`
- Test: `server/domain.test.ts`

**Interfaces:**
- Produces: `splitIntoSentences(text: string): string[]`

- [ ] **Step 1: Write the failing test** — add to `server/domain.test.ts`:

```ts
describe('sentence splitting', () => {
  it('splits on sentence punctuation and trims', () => {
    expect(splitIntoSentences('Halo dunia. Ini contoh. Terima kasih.')).toEqual(['Halo dunia.', 'Ini contoh.', 'Terima kasih.']);
    expect(splitIntoSentences('Selamat pagi! Apa kabar?')).toEqual(['Selamat pagi!', 'Apa kabar?']);
  });

  it('merges tiny fragments into the previous sentence', () => {
    expect(splitIntoSentences('Terima kasih. A. Bagaimana?')).toEqual(['Terima kasih. A.', 'Bagaimana?']);
  });

  it('handles empty and unpunctuated input', () => {
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences('halo dunia')).toEqual(['halo dunia']);
  });
});
```

Add `splitIntoSentences` to the import in `server/domain.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/domain.test.ts`
Expected: FAIL with "splitIntoSentences is not a function".

- [ ] **Step 3: Implement** in `server/domain.ts`:

```ts
export function splitIntoSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/).map((part) => part.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length && part.length < 3) merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
    else merged.push(part);
  }
  if (merged.length) return merged;
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/domain.ts server/domain.test.ts
git commit -m "feat: split no-timestamp transcripts into sentences"
```

---

### Task 3: `keepIntervalsFromSilences`

Pure helper converting detected silences into the complementary "keep" intervals, with a cap on how many silences get removed.

**Files:**
- Modify: `server/domain.ts`
- Test: `server/domain.test.ts`

**Interfaces:**
- Consumes: `Silence`, `KeepInterval` (Task 1).
- Produces: `keepIntervalsFromSilences(silences: Silence[], totalDuration: number, maxRemovals: number): KeepInterval[]`

- [ ] **Step 1: Write the failing test** — add to `server/domain.test.ts`:

```ts
describe('silence keep-intervals', () => {
  it('returns the full span when nothing is silent', () => {
    expect(keepIntervalsFromSilences([], 7, 400)).toEqual([{ start: 0, end: 7 }]);
  });

  it('keeps the audio around an interior silence', () => {
    expect(keepIntervalsFromSilences([{ start: 2, end: 5 }], 7, 400)).toEqual([{ start: 0, end: 2 }, { start: 5, end: 7 }]);
  });

  it('drops leading silence', () => {
    expect(keepIntervalsFromSilences([{ start: 0, end: 3 }], 7, 400)).toEqual([{ start: 3, end: 7 }]);
  });

  it('removes only the longest silences past the cap', () => {
    const silences = [{ start: 1, end: 2 }, { start: 4, end: 8 }, { start: 9, end: 9.5 }];
    expect(keepIntervalsFromSilences(silences, 12, 1)).toEqual([{ start: 0, end: 4 }, { start: 8, end: 12 }]);
  });
});
```

Add `keepIntervalsFromSilences` to the domain import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/domain.test.ts`
Expected: FAIL with "keepIntervalsFromSilences is not a function".

- [ ] **Step 3: Implement** in `server/domain.ts` (add the `Silence`, `KeepInterval` types to the existing type import):

```ts
export function keepIntervalsFromSilences(silences: Silence[], totalDuration: number, maxRemovals: number): KeepInterval[] {
  let removals = silences.filter((silence) => silence.end > silence.start);
  if (removals.length > maxRemovals) {
    removals = [...removals].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, maxRemovals);
  }
  removals = [...removals].sort((a, b) => a.start - b.start);
  const keep: KeepInterval[] = [];
  let cursor = 0;
  for (const silence of removals) {
    const start = Math.min(Math.max(0, silence.start), totalDuration);
    const end = Math.min(Math.max(0, silence.end), totalDuration);
    if (start > cursor) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
  return keep.length ? keep : [{ start: 0, end: totalDuration }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/domain.ts server/domain.test.ts
git commit -m "feat: compute keep-intervals from detected silences"
```

---

### Task 4: `remapSegmentTimes`

Pure helper mapping trimmed-timeline segment times back onto the original recording timeline. This is the accuracy-critical piece, so it gets the most test cases.

**Files:**
- Modify: `server/domain.ts`
- Test: `server/domain.test.ts`

**Interfaces:**
- Consumes: `Segment`, `KeepInterval` (Task 1).
- Produces: `remapSegmentTimes(segments: Segment[], keepIntervals: KeepInterval[]): Segment[]`

- [ ] **Step 1: Write the failing test** — add to `server/domain.test.ts`:

```ts
describe('timestamp remapping', () => {
  it('is the identity when no silence was removed', () => {
    expect(remapSegmentTimes([{ id: 'a', startSeconds: 3, endSeconds: 4, text: 'x' }], [{ start: 0, end: 10 }]))
      .toEqual([{ id: 'a', startSeconds: 3, endSeconds: 4, text: 'x' }]);
  });

  it('shifts times past a removed gap back to the original timeline', () => {
    // kept [0,2] then [5,7]; trimmed 3 sits in the second interval (trimmed offset 2) -> original 6
    const out = remapSegmentTimes([{ id: 'a', startSeconds: 1, endSeconds: 3, text: 'x' }], [{ start: 0, end: 2 }, { start: 5, end: 7 }]);
    expect(out[0].startSeconds).toBeCloseTo(1);
    expect(out[0].endSeconds).toBeCloseTo(6);
  });

  it('passes null times through unchanged', () => {
    expect(remapSegmentTimes([{ id: 'a', startSeconds: null, endSeconds: null, text: 'x' }], [{ start: 0, end: 5 }]))
      .toEqual([{ id: 'a', startSeconds: null, endSeconds: null, text: 'x' }]);
  });
});
```

Add `remapSegmentTimes` to the domain import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/domain.test.ts`
Expected: FAIL with "remapSegmentTimes is not a function".

- [ ] **Step 3: Implement** in `server/domain.ts`:

```ts
export function remapSegmentTimes(segments: Segment[], keepIntervals: KeepInterval[]): Segment[] {
  const trimmedStarts: number[] = [];
  let accumulated = 0;
  for (const interval of keepIntervals) {
    trimmedStarts.push(accumulated);
    accumulated += interval.end - interval.start;
  }
  const toOriginal = (time: number): number => {
    if (!keepIntervals.length) return time;
    for (let index = keepIntervals.length - 1; index >= 0; index -= 1) {
      if (time >= trimmedStarts[index] - 1e-9) return keepIntervals[index].start + (time - trimmedStarts[index]);
    }
    return keepIntervals[0].start + time;
  };
  return segments.map((segment) => ({
    ...segment,
    startSeconds: segment.startSeconds === null ? null : toOriginal(segment.startSeconds),
    endSeconds: segment.endSeconds === null ? null : toOriginal(segment.endSeconds),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/domain.ts server/domain.test.ts
git commit -m "feat: remap trimmed segment times to the original timeline"
```

---

### Task 5: Retry with backoff

Reusable retry helper plus the transient-error classifier, so a network blip or rate-limit doesn't discard already-transcribed chunks.

**Files:**
- Create: `server/retry.ts`
- Test: `server/retry.test.ts`

**Interfaces:**
- Produces: `withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>` where `RetryOptions { attempts: number; isTransient: (error: unknown) => boolean; delayMs: (attempt: number) => number; sleep: (ms: number) => Promise<void>; isCancelled?: () => boolean }`; and `isTransientError(error: unknown): boolean`.

- [ ] **Step 1: Write the failing test** — create `server/retry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { isTransientError, withRetry } from './retry.js';

const opts = (isTransient = isTransientError) => ({ attempts: 3, isTransient, delayMs: () => 0, sleep: () => Promise.resolve() });

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, opts())).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue('ok');
    expect(await withRetry(fn, opts())).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt limit', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 });
    await expect(withRetry(fn, opts())).rejects.toEqual({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 401 });
    await expect(withRetry(fn, opts())).rejects.toEqual({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops when cancelled', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { ...opts(), isCancelled: () => true })).rejects.toThrow('CANCELLED');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('isTransientError', () => {
  it('classifies rate-limit, server, and network errors as transient', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('classifies auth, bad-request, and generic errors as permanent', () => {
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError(new Error('no segments'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/retry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `server/retry.ts`:

```ts
export interface RetryOptions {
  attempts: number;
  isTransient: (error: unknown) => boolean;
  delayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
  isCancelled?: () => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (options.isCancelled?.()) throw new Error('CANCELLED');
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!options.isTransient(error) || attempt === options.attempts) throw error;
      await options.sleep(options.delayMs(attempt));
    }
  }
  throw lastError;
}

export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const code = (error as { code?: string }).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/retry.ts server/retry.test.ts
git commit -m "feat: add retry-with-backoff helper"
```

---

### Task 6: Two-model transcriber

Switch the transcriber between the timestamped `whisper-1` path and the cheaper `gpt-4o-mini-transcribe` text path based on `TranscribeOptions`.

**Files:**
- Modify: `server/openai-transcriber.ts`
- Test: `server/openai-transcriber.test.ts`

**Interfaces:**
- Consumes: `TranscribeOptions` (Task 1), `splitIntoSentences` (Task 2), `RawSegment` (Task 1).
- Produces: `OpenAITranscriber.transcribe(filePath: string, opts: TranscribeOptions): Promise<RawSegment[]>`

- [ ] **Step 1: Rewrite the test** — replace `server/openai-transcriber.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({ default: class { audio = { transcriptions: { create } }; } }));

import { OpenAITranscriber } from './openai-transcriber.js';

beforeEach(() => create.mockReset());

it('reports missing setup only when transcription is attempted', async () => {
  const transcriber = new OpenAITranscriber(undefined);
  await expect(transcriber.transcribe('missing.mp3', { language: 'id', timestamps: true })).rejects.toThrow('OPENAI_API_KEY is not configured');
});

it('uses whisper-1 verbose_json when timestamps are on', async () => {
  create.mockResolvedValue({ segments: [{ start: 0, end: 1, text: 'Halo' }] });
  const out = await new OpenAITranscriber('key').transcribe('a.mp3', { language: 'id', timestamps: true });
  expect(create.mock.calls[0][0]).toMatchObject({ model: 'whisper-1', response_format: 'verbose_json', language: 'id' });
  expect(out).toEqual([{ start: 0, end: 1, text: 'Halo' }]);
});

it('uses gpt-4o-mini-transcribe text and splits into sentences when timestamps are off', async () => {
  create.mockResolvedValue('Halo dunia. Apa kabar?');
  const out = await new OpenAITranscriber('key').transcribe('a.mp3', { timestamps: false });
  expect(create.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o-mini-transcribe', response_format: 'text' });
  expect(out).toEqual([{ start: null, end: null, text: 'Halo dunia.' }, { start: null, end: null, text: 'Apa kabar?' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/openai-transcriber.test.ts`
Expected: FAIL (old signature / no model branching).

- [ ] **Step 3: Implement** — replace `server/openai-transcriber.ts`:

```ts
import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
import { splitIntoSentences } from './domain.js';
import type { RawSegment, TranscribeOptions } from './types.js';

export class OpenAITranscriber {
  constructor(private readonly apiKey: string | undefined) {}

  async transcribe(filePath: string, opts: TranscribeOptions): Promise<RawSegment[]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not configured.');
    const client = new OpenAI({ apiKey: this.apiKey });
    const language = opts.language ? { language: opts.language } : {};

    if (opts.timestamps) {
      const response = await client.audio.transcriptions.create({
        file: createReadStream(filePath), model: 'whisper-1', response_format: 'verbose_json',
        timestamp_granularities: ['segment'], ...language,
      });
      const segments = (response as unknown as { segments?: Array<{ start: number; end: number; text: string }> }).segments;
      if (!segments) throw new Error('OpenAI returned no timestamped segments.');
      return segments;
    }

    const text = await client.audio.transcriptions.create({
      file: createReadStream(filePath), model: 'gpt-4o-mini-transcribe', response_format: 'text', ...language,
    });
    return splitIntoSentences(String(text)).map((sentence) => ({ start: null, end: null, text: sentence }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/openai-transcriber.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/openai-transcriber.ts server/openai-transcriber.test.ts
git commit -m "feat: switch transcriber model on the timestamps option"
```

---

### Task 7: Silence-trimming ffmpeg adapter

Add a silence-detect pass, trim via an exact `aselect` filter during chunking, and return the kept intervals plus the original duration.

**Files:**
- Modify: `server/media.ts`
- Test: `server/media.test.ts` (create)

**Interfaces:**
- Consumes: `keepIntervalsFromSilences` (Task 3), `Silence` (Task 1), and the type-only imports `PreparedChunk` / `PreparedAudio` from `./processor.js` (their shapes are declared in Task 8).
- Produces: `FfmpegMedia.prepare(inputPath: string, jobId: string): Promise<PreparedAudio>`

> Ordering note: `PreparedAudio` / `PreparedChunk` are declared in Task 8. The imports here are `import type` (erased at transpile), so this task's `npx vitest run server/media.test.ts` passes on its own. The full `tsc` type-check across `media.ts` ↔ `processor.ts` ↔ `index.ts` is the Task 12 gate — expect a red `tsc` only in the window between this task and Task 8, never a failing test.

- [ ] **Step 1: Write the failing test** — create `server/media.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { afterEach, expect, it } from 'vitest';
import { FfmpegMedia } from './media.js';

const run = promisify(execFile);
const ffmpeg = ffmpegPath as unknown as string;
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

it('trims a long interior silence and reports the kept intervals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
  dirs.push(dir);
  const input = path.join(dir, 'input.wav');
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-f', 'lavfi', '-i', 'anullsrc=cl=mono:r=44100:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', input]);

  const prepared = await new FfmpegMedia(path.join(dir, 'work')).prepare(input, 'job');

  expect(prepared.originalDurationSeconds).toBeGreaterThan(6.5);
  expect(prepared.chunks.length).toBeGreaterThanOrEqual(1);
  const kept = prepared.keepIntervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
  expect(kept).toBeLessThan(prepared.originalDurationSeconds - 1.5);
}, 30_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/media.test.ts`
Expected: FAIL (`prepare` returns an array, has no `keepIntervals`).

- [ ] **Step 3: Implement** — replace `server/media.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { keepIntervalsFromSilences } from './domain.js';
import type { PreparedAudio, PreparedChunk } from './processor.js';
import type { Silence } from './types.js';

const run = promisify(execFile);
const ffmpegExecutable = ffmpegPath as unknown as string | null;
const MAX_SILENCE_REMOVALS = 400;

export class FfmpegMedia {
  constructor(private readonly workDirectory: string) {}

  async prepare(inputPath: string, jobId: string): Promise<PreparedAudio> {
    if (!ffmpegExecutable) throw new Error('FFmpeg binary is unavailable.');
    const directory = path.join(this.workDirectory, jobId);
    await mkdir(directory, { recursive: true });
    const { totalDuration, silences } = await this.analyze(inputPath);
    const keepIntervals = keepIntervalsFromSilences(silences, totalDuration, MAX_SILENCE_REMOVALS);
    const select = keepIntervals.map((interval) => `between(t,${interval.start},${interval.end})`).join('+');
    const pattern = path.join(directory, 'chunk-%03d.mp3');
    await run(ffmpegExecutable, ['-y', '-i', inputPath, '-vn', '-af', `aselect='${select}',asetpts=N/SR/TB`,
      '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'segment', '-segment_time', '1200', '-reset_timestamps', '1', pattern],
      { maxBuffer: 10 * 1024 * 1024 });
    const files = (await readdir(directory)).filter((file) => file.startsWith('chunk-') && file.endsWith('.mp3')).sort()
      .map((file) => path.join(directory, file));
    if (!files.length) throw new Error('The file did not contain readable audio.');
    const chunks: PreparedChunk[] = await Promise.all(files.map(async (file) => ({ path: file, durationSeconds: await this.duration(file) })));
    return { chunks, keepIntervals, originalDurationSeconds: totalDuration };
  }

  private async analyze(inputPath: string): Promise<{ totalDuration: number; silences: Silence[] }> {
    const stderr = await this.probe(inputPath, ['-af', 'silencedetect=noise=-30dB:d=2', '-f', 'null', '-']);
    const totalDuration = parseDuration(stderr);
    const starts = [...stderr.matchAll(/silence_start: (-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
    const ends = [...stderr.matchAll(/silence_end: (-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
    const silences: Silence[] = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = Math.max(0, starts[index]);
      const end = index < ends.length ? ends[index] : totalDuration;
      if (end > start) silences.push({ start, end });
    }
    return { totalDuration, silences };
  }

  private async duration(file: string): Promise<number> {
    const seconds = parseDuration(await this.probe(file, []));
    if (!seconds) throw new Error('Could not measure an audio chunk.');
    return seconds;
  }

  private async probe(file: string, extraArgs: string[]): Promise<string> {
    if (!ffmpegExecutable) throw new Error('FFmpeg binary is unavailable.');
    try {
      const { stderr } = await run(ffmpegExecutable, ['-i', file, ...extraArgs], { maxBuffer: 10 * 1024 * 1024 });
      return stderr ?? '';
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? '');
    }
  }
}

function parseDuration(stderr: string): number {
  const match = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/media.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/media.ts server/media.test.ts
git commit -m "feat: detect and trim long silences before chunking"
```

---

### Task 8: Processor wiring (retry + remap + new prepare shape)

Consume the new `PreparedAudio`, wrap each transcription in retry, pass the timestamps option, and remap times at the end for timestamped jobs.

**Files:**
- Modify: `server/processor.ts`
- Test: `server/processor.test.ts`

**Interfaces:**
- Consumes: `withRetry`, `isTransientError` (Task 5); `remapSegmentTimes`, `languageCode`, `mergeChunkSegments` (Tasks 1/4); `TranscribeOptions`, `KeepInterval` (Task 1).
- Produces: `PreparedChunk { path: string; durationSeconds: number }`; `PreparedAudio { chunks: PreparedChunk[]; keepIntervals: KeepInterval[]; originalDurationSeconds: number }`; `ProcessingTools { prepare(...): Promise<PreparedAudio>; transcribe(chunkPath, opts: TranscribeOptions): Promise<RawSegment[]> }`; `new JobProcessor(store, tools, sleep?)`.

- [ ] **Step 1: Rewrite the test** — replace `server/processor.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobProcessor } from './processor.js';
import { TranscriptStore } from './store.js';
import type { Transcript } from './types.js';

const dirs: string[] = [];
const instant = () => Promise.resolve();
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function seed(timestamps: boolean): Promise<{ store: TranscriptStore; upload: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'processor-'));
  dirs.push(dir);
  const upload = path.join(dir, 'upload.mp3');
  await writeFile(upload, 'audio');
  const store = new TranscriptStore(path.join(dir, 'data'));
  const transcript: Transcript = {
    id: 'job', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'queued', progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 0, segments: [], error: null, timestamps,
  };
  await store.save(transcript);
  return { store, upload };
}

describe('JobProcessor', () => {
  it('forwards the language and timestamps option, remaps times, and cleans up', async () => {
    const { store, upload } = await seed(true);
    const transcribe = vi.fn().mockResolvedValue([{ start: 1, end: 2, text: 'Halo dunia' }]);
    const prepare = vi.fn().mockResolvedValue({ chunks: [{ path: upload, durationSeconds: 10 }], keepIntervals: [{ start: 0, end: 10 }], originalDurationSeconds: 10 });
    const processor = new JobProcessor(store, { prepare, transcribe }, instant);

    await processor.process('job', upload);

    expect(transcribe).toHaveBeenCalledWith(upload, { language: 'id', timestamps: true });
    const saved = await store.get('job');
    expect(saved?.segments[0]).toMatchObject({ text: 'Halo dunia', startSeconds: 1, endSeconds: 2 });
    expect(saved?.durationSeconds).toBe(10);
    expect(saved?.status).toBe('completed');
    await expect(readFile(upload)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps null times for a no-timestamp job', async () => {
    const { store, upload } = await seed(false);
    const transcribe = vi.fn().mockResolvedValue([{ start: null, end: null, text: 'Halo dunia' }]);
    const prepare = vi.fn().mockResolvedValue({ chunks: [{ path: upload, durationSeconds: 10 }], keepIntervals: [{ start: 0, end: 10 }], originalDurationSeconds: 10 });

    await new JobProcessor(store, { prepare, transcribe }, instant).process('job', upload);

    expect(transcribe).toHaveBeenCalledWith(upload, { language: 'id', timestamps: false });
    expect((await store.get('job'))?.segments[0]).toMatchObject({ startSeconds: null, endSeconds: null });
  });

  it('retries a transient transcription failure and still completes', async () => {
    const { store, upload } = await seed(true);
    const transcribe = vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue([{ start: 0, end: 1, text: 'Halo' }]);
    const prepare = vi.fn().mockResolvedValue({ chunks: [{ path: upload, durationSeconds: 5 }], keepIntervals: [{ start: 0, end: 5 }], originalDurationSeconds: 5 });

    await new JobProcessor(store, { prepare, transcribe }, instant).process('job', upload);

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect((await store.get('job'))?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/processor.test.ts`
Expected: FAIL (constructor arity / prepare shape / no remap).

- [ ] **Step 3: Implement** — replace `server/processor.ts`:

```ts
import { rm } from 'node:fs/promises';
import { languageCode, mergeChunkSegments, remapSegmentTimes } from './domain.js';
import { isTransientError, withRetry } from './retry.js';
import type { KeepInterval, RawSegment, Segment, TranscribeOptions } from './types.js';
import { TranscriptStore } from './store.js';

export interface PreparedChunk { path: string; durationSeconds: number }
export interface PreparedAudio { chunks: PreparedChunk[]; keepIntervals: KeepInterval[]; originalDurationSeconds: number }
export interface ProcessingTools {
  prepare(inputPath: string, jobId: string): Promise<PreparedAudio>;
  transcribe(chunkPath: string, opts: TranscribeOptions): Promise<RawSegment[]>;
}

export class JobProcessor {
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly tools: ProcessingTools,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  cancel(id: string): void { this.cancelled.add(id); }

  async process(id: string, uploadPath: string): Promise<void> {
    let chunkPaths: string[] = [];
    try {
      const transcript = await this.store.get(id);
      if (!transcript) return;
      transcript.status = 'processing'; transcript.progress = 2; transcript.updatedAt = new Date().toISOString();
      await this.store.save(transcript);
      const prepared = await this.tools.prepare(uploadPath, id);
      chunkPaths = prepared.chunks.map((chunk) => chunk.path);
      const segments: Segment[] = [];
      let offset = 0;
      for (let index = 0; index < prepared.chunks.length; index += 1) {
        if (this.cancelled.has(id)) throw new Error('CANCELLED');
        const raw = await withRetry(
          () => this.tools.transcribe(prepared.chunks[index].path, { language: languageCode(transcript.language), timestamps: transcript.timestamps }),
          { attempts: 3, isTransient: isTransientError, delayMs: (attempt) => 1000 * 2 ** (attempt - 1), sleep: this.sleep, isCancelled: () => this.cancelled.has(id) },
        );
        segments.push(...mergeChunkSegments(raw, offset, index));
        offset += prepared.chunks[index].durationSeconds;
        transcript.progress = Math.round(10 + ((index + 1) / prepared.chunks.length) * 88);
        transcript.segments = segments; transcript.updatedAt = new Date().toISOString();
        await this.store.save(transcript);
      }
      transcript.segments = transcript.timestamps ? remapSegmentTimes(segments, prepared.keepIntervals) : segments;
      transcript.durationSeconds = prepared.originalDurationSeconds;
      transcript.status = 'completed'; transcript.progress = 100; transcript.error = null; transcript.updatedAt = new Date().toISOString();
      await this.store.save(transcript);
    } catch (error) {
      const transcript = await this.store.get(id);
      if (transcript) {
        transcript.status = this.cancelled.has(id) || (error as Error).message === 'CANCELLED' ? 'cancelled' : 'failed';
        transcript.error = transcript.status === 'failed' ? humanizeError(error) : null;
        transcript.updatedAt = new Date().toISOString();
        await this.store.save(transcript);
      }
    } finally {
      this.cancelled.delete(id);
      await Promise.allSettled([...new Set([uploadPath, ...chunkPaths])].map((file) => rm(file, { force: true })));
    }
  }
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown processing error.';
  if (/api.?key|401|authentication/i.test(message)) return 'OpenAI rejected the API key. Check your .env file.';
  return `Transcription failed: ${message}`;
}
```

- [ ] **Step 4: Update the composition root** in `server/index.ts`. The `ProcessingTools.transcribe` signature is now `(chunkPath, opts)`, so rename the wiring lambda's second parameter for honesty (functionally it already forwards positionally). Replace the `transcribe:` line inside the `new JobProcessor(...)` tools object:

```ts
  transcribe: (file, opts) => new OpenAITranscriber(process.env.OPENAI_API_KEY).transcribe(file, opts),
```

The `prepare:` line needs no change — it forwards the new `PreparedAudio` shape unchanged.

- [ ] **Step 5: Run the full suite to verify green**

Run: `npx vitest run`
Expected: PASS (processor, media, domain, retry, transcriber, store, app).

- [ ] **Step 6: Commit**

```bash
git add server/processor.ts server/processor.test.ts server/index.ts
git commit -m "feat: wire retry, remap, and the timestamps option into the processor"
```

---

### Task 9: API — accept the toggle, guard VTT

Read `timestamps` on upload, persist it, and block VTT downloads for no-timestamp transcripts.

**Files:**
- Modify: `server/app.ts`
- Test: `server/app.test.ts`

**Interfaces:**
- Consumes: `Transcript.timestamps` (Task 1).
- Produces: `POST /api/transcriptions` reads form field `timestamps` (default true); `GET …/download?format=vtt` returns 400 when `timestamps === false`.

- [ ] **Step 1: Write the failing test** — add to `server/app.test.ts` (inside the existing `describe`, after the current `it`):

```ts
it('stores the timestamps choice and blocks VTT for text-only transcripts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'api-ts-'));
  dirs.push(dir);
  const store = new TranscriptStore(path.join(dir, 'data'));
  await store.save({
    id: 'text', title: 'Notes', sourceName: 'notes.mp3', language: 'auto', status: 'completed', progress: 100,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationSeconds: 3,
    segments: [{ id: '0-0', startSeconds: null, endSeconds: null, text: 'Halo dunia' }], error: null, timestamps: false,
  });
  const app = createApp({ store, uploadDirectory: path.join(dir, 'uploads'), enqueue: () => undefined, cancel: () => false });

  await request(app).get('/api/transcriptions/text/download?format=vtt').expect(400);
  const txt = await request(app).get('/api/transcriptions/text/download?format=txt').expect(200);
  expect(txt.text).toBe('Halo dunia');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/app.test.ts`
Expected: FAIL (VTT returns 200, not 400).

- [ ] **Step 3: Implement** — in `server/app.ts`, update the POST handler's transcript construction to read and store the flag. Replace the `language` line and the `transcript` object with:

```ts
    const language = req.body.language === 'indonesian' ? 'indonesian' : req.body.language === 'auto' || !req.body.language ? 'auto' : null;
    const timestamps = req.body.timestamps !== 'false' && req.body.timestamps !== false;
    if (!validation.ok || !language) {
      await import('node:fs/promises').then(({ rm }) => rm(req.file!.path, { force: true }));
      return res.status(400).json({ error: validation.ok ? 'Unsupported language selection.' : validation.error });
    }
    const now = new Date().toISOString();
    const transcript: Transcript = {
      id: randomUUID(), title: path.parse(req.file.originalname).name, sourceName: req.file.originalname,
      language: language as LanguagePreference, status: 'queued', progress: 0, createdAt: now, updatedAt: now,
      durationSeconds: 0, segments: [], error: null, timestamps,
    };
```

Then update the download handler to guard VTT:

```ts
  app.get('/api/transcriptions/:id/download', async (req, res) => {
    const transcript = await options.store.get(req.params.id);
    if (!transcript) return res.status(404).json({ error: 'Transcript not found.' });
    const format = req.query.format === 'vtt' ? 'vtt' : req.query.format === 'txt' ? 'txt' : null;
    if (!format) return res.status(400).json({ error: 'Format must be txt or vtt.' });
    if (format === 'vtt' && !transcript.timestamps) return res.status(400).json({ error: 'This transcript has no timestamps — use TXT.' });
    res.type(format === 'vtt' ? 'text/vtt' : 'text/plain').attachment(`${safeFilename(transcript.title)}.${format}`).send(format === 'vtt' ? toVtt(transcript.segments) : toText(transcript.segments));
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.ts server/app.test.ts
git commit -m "feat: accept the timestamps toggle and guard VTT downloads"
```

---

### Task 10: Client cost estimate helper

Pure client module for the pre-upload estimate.

**Files:**
- Create: `src/cost.ts`
- Test: `src/cost.test.ts`

**Interfaces:**
- Produces: `estimateCostUsd(durationSeconds: number, timestamps: boolean): number`; `formatCostEstimate(durationSeconds: number, timestamps: boolean): string`.

- [ ] **Step 1: Write the failing test** — create `src/cost.test.ts`:

```ts
import { expect, it } from 'vitest';
import { estimateCostUsd, formatCostEstimate } from './cost';

it('estimates cost from duration and the timestamps choice', () => {
  expect(estimateCostUsd(3600, true)).toBeCloseTo(0.36);
  expect(estimateCostUsd(3600, false)).toBeCloseTo(0.18);
});

it('formats an upper-bound estimate string', () => {
  expect(formatCostEstimate(3600, true)).toBe('up to ~$0.36');
  expect(formatCostEstimate(600, false)).toBe('up to ~$0.03');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cost.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `src/cost.ts`:

```ts
// Approximate OpenAI per-minute rates (USD); verify against current pricing.
const RATE_PER_MINUTE = { withTimestamps: 0.006, withoutTimestamps: 0.003 };

export function estimateCostUsd(durationSeconds: number, timestamps: boolean): number {
  const rate = timestamps ? RATE_PER_MINUTE.withTimestamps : RATE_PER_MINUTE.withoutTimestamps;
  return (durationSeconds / 60) * rate;
}

export function formatCostEstimate(durationSeconds: number, timestamps: boolean): string {
  return `up to ~$${estimateCostUsd(durationSeconds, timestamps).toFixed(2)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cost.ts src/cost.test.ts
git commit -m "feat: add client cost-estimate helper"
```

---

### Task 11: UI — toggle, estimate, conditional rendering

Add the timestamps toggle, show the estimate on file select, send the flag, and hide timestamp UI for text-only transcripts.

**Files:**
- Modify: `src/App.tsx`
- Modify: `README.md`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `formatCostEstimate` (Task 10); API `timestamps` field (Task 9).

- [ ] **Step 1: Write the failing test** — add to `src/App.test.tsx`:

```ts
it('renders the timestamps toggle and hides times for a text-only transcript', async () => {
  const textOnly = {
    id: 'txt', title: 'Notes', sourceName: 'notes.mp3', language: 'auto', status: 'completed', progress: 100,
    createdAt: '2026-07-14T00:00:00.000Z', updatedAt: '2026-07-14T00:00:00.000Z', durationSeconds: 3,
    segments: [{ id: '0-0', startSeconds: null, endSeconds: null, text: 'Halo dunia' }], error: null, timestamps: false,
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([textOnly]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  render(<App />);

  expect(screen.getByRole('checkbox', { name: /timestamps/i })).toBeChecked();
  fireEvent.click(await screen.findByRole('button', { name: /Notes/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Halo dunia')).toBeInTheDocument());
  expect(screen.queryByText('00:00:00')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'VTT' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL (no checkbox named "timestamps").

- [ ] **Step 3: Implement the state, duration read, and estimate.** In `src/App.tsx`:

Update the interfaces at the top:

```ts
interface Segment { id: string; startSeconds: number | null; endSeconds: number | null; text: string }
interface Transcript {
  id: string; title: string; sourceName: string; language: 'auto' | 'indonesian'; status: Status; progress: number;
  createdAt: string; updatedAt: string; durationSeconds: number; segments: Segment[]; error: string | null; timestamps: boolean;
}
```

Add the import and new state (near the other `useState` calls):

```ts
import { formatCostEstimate } from './cost';
```

```ts
  const [timestamps, setTimestamps] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
```

Replace `chooseFile` to also read the duration:

```ts
  const chooseFile = (next: File | undefined) => {
    if (!next) return;
    setFile(next); setMessage(''); setDurationSeconds(null);
    const url = URL.createObjectURL(next);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => { setDurationSeconds(Number.isFinite(audio.duration) ? audio.duration : null); URL.revokeObjectURL(url); };
    audio.onerror = () => { setDurationSeconds(null); URL.revokeObjectURL(url); };
    audio.src = url;
  };
```

In `upload`, add the flag to the form:

```ts
    const form = new FormData(); form.append('audio', file); form.append('language', language); form.append('timestamps', String(timestamps));
```

- [ ] **Step 4: Implement the toggle, estimate display, and conditional rendering.** In the `.upload-options` block, add the toggle after the language `<label>`:

```tsx
          <label className="toggle"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)}/> Include timestamps</label>
```

Add the estimate near the file `<small>` (inside the drop zone label, replacing the existing `<small>`):

```tsx
          <span className="upload-icon" aria-hidden="true">↑</span><strong>{file ? file.name : 'Drop audio here'}</strong>
          <small>{file ? (durationSeconds ? `${formatBytes(file.size)} · ${formatCostEstimate(durationSeconds, timestamps)}` : formatBytes(file.size)) : 'or click to browse · up to 2 GB'}</small>
```

In the editor header, show the VTT link only when the transcript has timestamps:

```tsx
<div className="editor-actions"><button onClick={() => void copyAll()}>Copy all</button><a href={`${api}/${selected.id}/download?format=txt`}>TXT</a>{selected.timestamps !== false && <a href={`${api}/${selected.id}/download?format=vtt`}>VTT</a>}<button className="danger" onClick={() => void remove(selected)}>Delete</button></div>
```

In the segment map, render `<time>` only when the segment has a start time:

```tsx
<div className="segment" key={segment.id}>{segment.startSeconds !== null && <time>{clock(segment.startSeconds)}</time>}<span>{String(index + 1).padStart(2, '0')}</span><textarea aria-label={`Transcript segment ${index + 1}`} value={segment.text} rows={Math.max(2, Math.ceil(segment.text.length / 75))} onChange={(e) => setSelected({ ...selected, segments: selected.segments.map((item) => item.id === segment.id ? { ...item, text: e.target.value } : item) })}/></div>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS.

- [ ] **Step 6: Update the README.** Under "Supported recordings", add:

```markdown
Turn off **Include timestamps** to transcribe with a cheaper model (about half the cost) when you only need the text — the transcript is saved without timestamps and cannot be exported as VTT. Long silences are trimmed automatically before transcription to reduce cost. The upload card shows an approximate cost estimate once you pick a file.
```

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.test.tsx README.md
git commit -m "feat: add timestamps toggle and cost estimate to the UI"
```

---

### Task 12: Full verification

Confirm the whole change type-checks, lints, builds, and passes tests together.

**Files:** none (verification only).

- [ ] **Step 1: Type-check and build**

Run: `npm run build`
Expected: no TypeScript errors; `dist/` produced.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`
Expected: all suites PASS (domain, retry, exports, transcriber, media, processor, store, app, cost, App).

- [ ] **Step 4: Manual smoke check (documented, run by the user)**

Run `npm run dev`, upload a short clip with a silent gap twice — once with **Include timestamps** on (expect timestamped segments and a working VTT download) and once off (expect sentence blocks, no times, VTT link hidden). Confirm the cost estimate appears on file select.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore: verify transcription cost controls build and tests"
```
