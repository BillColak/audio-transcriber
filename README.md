# Audio Transcriber

A private, local app for turning long recordings into editable timestamped transcripts with OpenAI's `gpt-transcribe` model, and — optionally — meeting-minutes summaries. It supports automatic language detection and an explicit **Indonesian (Bahasa Indonesia)** mode, which sends the ISO-639-1 language code `id` for better accuracy and latency.

It ships two ways: as a **desktop app** (Windows and macOS, built with Tauri) and as the **local web app** it started as. Both run the same code.

## Installing the desktop app

Download the installer for your platform from the [Releases page](https://github.com/BillColak/audio-transcriber/releases), run it, and launch Audio Transcriber from the Start Menu or Applications folder. On first run the app asks for an OpenAI API key; paste one and it is saved on that computer only. There is nothing else to install — Node.js and FFmpeg are bundled.

Use the **Settings** button in the top right to replace the key later.

> The macOS build is unsigned, so Gatekeeper quarantines it on first launch. Right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Audio Transcriber.app"`.

## Developing

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Create a `.env` file in the project root with `OPENAI_API_KEY=your-key`. The key stays in the local server and is never sent to the browser.
3. Run `npm install`.
4. Either:
   - **In a browser** — `npm run dev`, then open `http://127.0.0.1:5173`.
   - **As the desktop app** — `npm run dev:tauri`, which starts Vite, builds the backend bundle, and opens the native window.

For a production-style local run in the browser, use `npm run build`, set `NODE_ENV=production`, run `npm start`, and open `http://127.0.0.1:8787`.

Building the desktop app also needs [Rust](https://rustup.rs/) plus your platform's C toolchain (MSVC Build Tools with the "Desktop development with C++" workload on Windows, Xcode command line tools on macOS) — see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required unless a key has been saved in the app's Settings screen, which takes precedence. Read fresh for every job, so it can change without a restart. |
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
- Transcripts and the saved API key live in the per-user app data directory: `%APPDATA%\Audio Transcriber` on Windows, `~/Library/Application Support/Audio Transcriber` on macOS. The desktop app and `npm run dev` share that location.
- Audio chunks are sent to OpenAI for transcription — and, if you ask for one, the transcript text is sent for summarisation. Both incur normal OpenAI API usage charges. Review current pricing and data controls in your OpenAI account.

## Building installers

`npm run build:tauri` produces an installer for **the machine you run it on**, under `src-tauri/target/release/bundle/` — `nsis/Audio Transcriber_<version>_x64-setup.exe` on Windows, `dmg/*.dmg` on macOS.

To build both platforms without owning both machines, use the **Release** GitHub Actions workflow (`.github/workflows/release.yml`). Either push a version tag:

```
git tag v1.0.0 && git push origin v1.0.0
```

…or trigger it by hand from the repository's **Actions** tab. It builds on `windows-latest` and `macos-latest` in parallel and attaches the installers to a draft GitHub Release. Installers are also uploaded as workflow artifacts, so a manual run is a safe way to get a build without publishing anything.

The workflow deliberately never passes `--target` to Tauri. The sidecar is the build machine's own Node binary, named from `rustc -vV`'s host triple, so cross-compiling would bundle the wrong architecture. Supporting Intel Macs means adding a matrix entry on an Intel runner rather than a cross-compile flag.

## Commands

- `npm run dev` — run the interface and local API in a browser.
- `npm run dev:tauri` — run the desktop app against the Vite dev server.
- `npm test` — run automated tests.
- `npm run lint` — lint the TypeScript.
- `npm run build` — type-check and build the interface.
- `npm run build:tauri` — build the desktop installer for this platform.
- `npm run tauri:prepare` — regenerate the sidecar payloads on their own (`dev:tauri` and `build:tauri` do this automatically).
- `npm start` — run the local API and built interface.
