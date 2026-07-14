# Audio Transcriber

A private, local web app for turning long recordings into editable timestamped transcripts with OpenAI Whisper. It supports automatic language detection and an explicit **Indonesian (Bahasa Indonesia)** mode, which sends the ISO-639-1 language code `id` for better accuracy and latency.

## Setup

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Copy `.env.example` to `.env`.
3. Add your OpenAI API key to `.env`. The key stays in the local server and is never sent to the browser.
4. Run `npm install` and then `npm run dev`.
5. Open `http://127.0.0.1:5173`.

For a production-style local run, use `npm run build`, set `NODE_ENV=production`, run `npm start`, and open `http://127.0.0.1:8787`.

## Supported recordings

FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, and WebM files up to 2 GB. Recordings are converted to mono 16 kHz MP3 and split into measured 20-minute chunks before transcription.

Choose **Indonesian (Bahasa Indonesia)** when you know the recording is Indonesian. Choose **Auto-detect** for mixed or unknown languages.

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
