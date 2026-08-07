# Audio Transcriber

A private, local app for turning long recordings into editable timestamped transcripts with OpenAI's `gpt-transcribe` model, and — optionally — meeting-minutes summaries. It supports automatic language detection and an explicit **Indonesian (Bahasa Indonesia)** mode, which sends the ISO-639-1 language code `id` for better accuracy and latency.

It ships two ways: as a **desktop app** (Windows and macOS, built with Tauri) and as the **local web app** it started as. Both run the same code.

## Installing the desktop app

Download the installer for your platform from the [Releases page](https://github.com/BillColak/audio-transcriber/releases), run it, and launch Audio Transcriber from the Start Menu or Applications folder. There is nothing else to install — Node.js and FFmpeg are bundled.

> **This is a private build, never distributed publicly.** `scripts/prepare-resources.mjs` bakes the build machine's own `OPENAI_API_KEY` (from its `.env`) into the packaged app, so a fresh install never shows the "add your key" screen — it just works on any machine the developer installs it on. If this project is ever going to be shared with anyone else, remove that step and rely on the in-app Settings screen (still there, still functional) instead.

Use the **Settings** button in the top right to replace the key later, or to check which key/model is currently active. **Test key** checks a key before you commit to it: it confirms OpenAI accepts the key and that the account can actually reach the models this app uses. That second check matters — a valid key on an account without access to the configured model would otherwise fail silently, hours later, part-way through a job. Testing never saves anything.

> The macOS build is unsigned, so Gatekeeper quarantines it on first launch. Right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Audio Transcriber.app"`.

## How it works

The interface is React. The backend — uploads, FFmpeg chunking, the OpenAI calls, the job queue and
the transcript store — is **Rust, compiled into the desktop binary** and served on `127.0.0.1:8787`.
There is no Node runtime in the installer and no separate server process, which is why it is about
25 MB rather than 48 MB.

## Developing

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Create a `.env` file in the project root with `OPENAI_API_KEY=your-key`. The key stays in the local server and is never sent to the browser.
3. Run `npm install`.
4. Either:
   - **In a browser** — `npm run dev`, then open `http://127.0.0.1:5173`.
   - **As the desktop app** — `npm run dev:tauri`, which starts Vite and opens the native window with the backend running inside it.

`npm run dev` runs Vite alongside the Rust backend (`cargo run --bin serve`) on `127.0.0.1:8787`. The first run compiles Rust and is slow; later runs are quick.

Building the desktop app also needs [Rust](https://rustup.rs/) plus your platform's C toolchain (MSVC Build Tools with the "Desktop development with C++" workload on Windows, Xcode command line tools on macOS) — see [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Required unless a key has been saved in the app's Settings screen, which takes precedence. Read fresh for every job, so it can change without a restart. |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-transcribe` | Speech-to-text model. |
| `OPENAI_SUMMARY_MODEL` | `gpt-5.6-terra` | Model used to write meeting minutes. |
| `OPENAI_CHAT_MODEL` | `gpt-5.6-terra` | Model used to answer questions about a transcript. |

## Supported recordings

FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, and WebM files up to 2 GB. Recordings are converted to mono 16 kHz MP3 and split into measured 20-minute chunks before transcription.

Choose **Indonesian (Bahasa Indonesia)** when you know the recording is Indonesian. Choose **Auto-detect** for mixed or unknown languages.

## How timestamps work

`gpt-transcribe` returns the text of an audio file but **no segment- or word-level timestamps** — only the older `whisper-1` and `gpt-4o-transcribe-diarize` models do. Timestamps therefore come from the chunking step rather than the model: each measured 20-minute chunk becomes **one timestamped, editable block** starting at that chunk's cumulative offset.

The practical effect is that the transcript is coarser than it used to be — one block per ~20 minutes instead of one per sentence. TXT and VTT exports still work, with one cue per chunk.

## Summaries

Tick **Write meeting minutes** next to the Transcribe button and, once the transcript is finished, the app sends the joined text to `OPENAI_SUMMARY_MODEL` and stores detailed minutes alongside it: an overview, the discussion broken down by topic, decisions and the reasoning behind them, action items, and open questions. They appear in a collapsible **Meeting minutes** panel in the editor, with a Copy button and an **MD** download.

The transcript is machine-generated and will contain mishearings, so the model is told to work out what was meant from the surrounding context rather than repeat a garbled phrase — and to say a passage is unclear rather than guess.

A summary that fails does not fail the job: the transcript is still saved and marked complete, and the reason is shown above the segments.

## Privacy and cost

- The app binds only to `127.0.0.1` and has no accounts or public access.
- Original uploads and temporary chunks are deleted after completion, failure, or cancellation.
- Transcripts and the saved API key live in the per-user app data directory: `%APPDATA%\Audio Transcriber` on Windows, `~/Library/Application Support/Audio Transcriber` on macOS. The desktop app and `npm run dev` share that location, so a transcript made in one shows up in the other.
- Audio chunks are sent to OpenAI for transcription — and, if you ask for one, the transcript text is sent for summarisation. Both incur normal OpenAI API usage charges. Review current pricing and data controls in your OpenAI account.

## Updates

From 1.0.2 on, the app checks GitHub for a newer release each time it launches and offers it — nothing installs without you clicking **Update now**. Installs older than 1.0.2 have no updater and must be replaced by hand once.

Cutting a release:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
2. Tag it (`git tag v1.0.3 && git push origin v1.0.3`) — CI builds both platforms and drafts a release
3. Check the draft has its installers **and `latest.json`**, then publish that draft

Step 3 is the one that bites. The update feed reads the *latest published* release, so publishing a hand-made release instead of the CI draft leaves the feed pointing at something with no `latest.json`, and every client silently stops seeing updates.

Signing: CI needs `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets, matching `plugins.updater.pubkey` in `tauri.conf.json`. **If the private key is lost, existing installs can never be updated again** — there is no recovery path, so keep a backup outside this machine.

## Building installers

`npm run build:tauri` produces an installer for **the machine you run it on**, under `src-tauri/target/release/bundle/` — `nsis/Audio Transcriber_<version>_x64-setup.exe` on Windows, `dmg/*.dmg` on macOS.

To build both platforms without owning both machines, use the **Release** GitHub Actions workflow (`.github/workflows/release.yml`). Either push a version tag:

```
git tag v1.0.0 && git push origin v1.0.0
```

…or trigger it by hand from the repository's **Actions** tab. It builds on `windows-latest` and `macos-latest` in parallel and attaches the installers to a draft GitHub Release. Installers are also uploaded as workflow artifacts, so a manual run is a safe way to get a build without publishing anything.

The workflow builds natively on each runner. The backend is compiled into the binary now, so the only architecture-specific payload is FFmpeg — but supporting Intel Macs still means adding a matrix entry on an Intel runner rather than a cross-compile flag.

## Commands

- `npm run dev` — run the interface (Vite) and the Rust backend together, in a browser.
- `npm run dev:tauri` — run the desktop app against the Vite dev server.
- `npm test` — run automated tests.
- `npm run lint` — lint the TypeScript.
- `npm run build` — type-check and build the interface.
- `npm run build:tauri` — build the desktop installer for this platform.
- `npm run tauri:prepare` — copy FFmpeg (and the bundled key, if any) into `src-tauri/resources` (`dev:tauri` and `build:tauri` do this automatically).
