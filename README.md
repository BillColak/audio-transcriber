# Audio Transcriber

A private, local app for turning long recordings into editable timestamped transcripts with OpenAI's `gpt-transcribe` model, and — optionally — meeting-minutes summaries. It supports automatic language detection and an explicit **Indonesian (Bahasa Indonesia)** mode, which sends the ISO-639-1 language code `id` for better accuracy and latency.

## Setup

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Create a `.env` file in the project root with `OPENAI_API_KEY=your-key`. The key stays in the local server and is never sent to the browser.
3. Run `npm install` and then `npm run dev`.
4. Open `http://127.0.0.1:5173`.

For a production-style local run, use `npm run build`, set `NODE_ENV=production`, run `npm start`, and open `http://127.0.0.1:8787`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required. Read fresh for every job, so it can be changed without restarting. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Speech-to-text model. |
| `OPENAI_SUMMARY_MODEL` | `gpt-5-mini` | Chat model used for meeting-minutes summaries. |

## Supported recordings

FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, and WebM files up to 2 GB. Recordings are converted to mono 16 kHz MP3 and split into measured 20-minute chunks before transcription.

Choose **Indonesian (Bahasa Indonesia)** when you know the recording is Indonesian. Choose **Auto-detect** for mixed or unknown languages.

## How timestamps work

`gpt-transcribe` returns the text of an audio file but **no segment- or word-level timestamps** — only the older `whisper-1` and `gpt-4o-transcribe-diarize` models do. Timestamps therefore come from the chunking step rather than the model: each measured 20-minute chunk becomes **one timestamped, editable block** starting at that chunk's cumulative offset.

The practical effect is that the transcript is coarser than it used to be — one block per ~20 minutes instead of one per sentence. TXT and VTT exports still work, with one cue per chunk.

## Summaries

Tick **Summarise when done** next to the Transcribe button and, once the transcript is finished, the app sends the joined text to `OPENAI_SUMMARY_MODEL` and stores meeting-minutes-style notes (summary, key points, decisions, action items) alongside it. The notes appear in a collapsible **Summary** panel in the editor, with a Copy button and an **MD** download.

A summary that fails does not fail the job: the transcript is still saved and marked complete, and the reason is shown above the segments.

## Privacy and cost

- The app binds only to `127.0.0.1` and has no accounts or public access.
- Original uploads and temporary chunks are deleted after completion, failure, or cancellation.
- Transcript JSON files are saved under `%APPDATA%\Audio Transcriber\transcripts` on Windows.
- Audio chunks are sent to OpenAI for transcription and incur normal OpenAI API usage charges. Review current pricing and data controls in your OpenAI account.

## Commands

- `npm run dev` — run the interface and local API during development.
- `npm test` — run automated tests.
- `npm run build` — type-check and build the interface.
- `npm start` — run the local API and built interface.
