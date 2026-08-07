# Auto-update from GitHub Releases

**Date:** 2026-08-07
**Status:** Approved, not yet implemented
**Ships as:** v1.0.2

## Problem

Installers are distributed by hand. Every fix means telling each person to download and reinstall, and there is no way to know who is running what. The verbatim-path bug that shipped in the first build is the case in point: it reached a user, and the only remedy was rebuilding and re-sending the file.

## Goal

An installed app notices a new release on GitHub, offers it, and installs it on consent. One check per launch. Nothing else.

## Approach

Tauri v2's updater plugin reads a signed `latest.json` manifest over HTTP. `tauri-action` generates that manifest and attaches it to the GitHub Release, so the release page is the update feed — no server to run.

Current versions in this repo: `tauri` 2.11.5, `@tauri-apps/cli` ^2.11.4.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Update UX | Prompt on launch | Consent-based. A broken release cannot propagate silently. |
| Install mode | Switch NSIS to `currentUser` | Updates apply without UAC, and someone without admin rights on a work laptop can install at all. Reverses `637c046`. |
| Publish gate | Keep `releaseDraft: true` | A tag builds a draft; a human confirms both installers are attached before the feed sees it. CI green does not mean the app works — the verbatim-path bug passed CI. |
| Check frequency | Once, at launch | No timers, no re-checks while running. |

## Components

### Signing keys

`tauri signer generate` produces a keypair.

- Public key → `tauri.conf.json` under `plugins.updater.pubkey`.
- Private key → repo secret `TAURI_SIGNING_PRIVATE_KEY`.
- Password → repo secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

CI signs each installer; the app verifies the signature before installing. This is what stops a hijacked release URL from delivering arbitrary code.

**The private key must be backed up outside this repo.** If it is lost, every existing install is permanently unreachable — there is no recovery path, because the public key baked into those installs will only accept signatures from the matching private key.

### `src-tauri/tauri.conf.json`

- `plugins.updater.endpoints`: `["https://github.com/BillColak/audio-transcriber/releases/latest/download/latest.json"]`
- `plugins.updater.pubkey`: the generated public key
- `bundle.createUpdaterArtifacts`: `true`
- `bundle.windows.nsis.installMode`: `"currentUser"` (was `"perMachine"`)
- `version`: `1.0.2`

### `src-tauri/src/lib.rs`

Register `tauri-plugin-updater` and `tauri-plugin-process`. The sidecar spawn logic is untouched.

### `src-tauri/capabilities/default.json`

Add `updater:default` and `process:allow-restart`. Nothing else is opened.

### `.github/workflows/release.yml`

`tauri-action` gains `includeUpdaterJson: true` and the two signing secrets in `env`. It merges both runners' artifacts into one `latest.json` attached to the draft release.

### Frontend

`App.tsx` is already a single large component, so the update logic lives in its own file and is tested without mounting the app.

- `src/useUpdate.ts` — a hook owning the whole state machine: `idle → checking → available → downloading → failed`, plus `dismissed`.
- The banner renders in `App.tsx` from that state.

The hook must be inert outside Tauri: if `window.__TAURI_INTERNALS__` is absent it returns `idle` immediately and never imports the plugin. `npm run dev` in a browser must behave exactly as it does today.

## Data flow

```
launch
  → App mounts
  → window.__TAURI_INTERNALS__ present?  no → idle, nothing renders
                                        yes ↓
  → check()
  → no update → idle
  → update    → banner: version + notes, [Later] [Update now]
  → "Update now" → downloadAndInstall(onProgress) → progress in banner
  → Windows: installer takes over, app exits
    macOS:   relaunch()
```

## Error handling

Every failure is non-fatal. An update check must never stop someone transcribing.

| Failure | Behaviour |
| --- | --- |
| Offline / feed unreachable | Log, no banner, app proceeds |
| Malformed manifest | Log, no banner, app proceeds |
| Download fails mid-way | Banner → "Update failed — try again later", dismissible |
| Signature mismatch | Plugin refuses; treated as a failed download |

No retry loops. No nagging. "Later" dismisses for the session.

## Testing

The plugin only exists inside a Tauri webview, so `@tauri-apps/plugin-updater` is mocked in Vitest and the hook's decision logic is what gets tested:

1. Outside Tauri (`__TAURI_INTERNALS__` absent) → no check is attempted, no banner
2. `check()` resolves null → no banner
3. `check()` resolves an update → banner shows its version and notes
4. `check()` rejects → no banner, no thrown error, app still renders
5. `downloadAndInstall()` rejects → failure state, app still usable
6. "Later" → banner dismissed, no further checks that session

The existing 43 tests must stay green.

## Rollout

v1.0.2 is the first build that can receive updates; the updater cannot reach anything older, so 1.0.0 and 1.0.1 installs will never auto-update.

Because install mode changes from per-machine to per-user, **the Program Files copy must be uninstalled first** — otherwise 1.0.2 installs alongside it and two copies coexist. This is the last manual step for everyone.

### One distribution channel only

v1.0.2 comes from CI, which has no `.env`, so it carries **no baked API key** — users paste their own on first launch.

Locally-built installers with `api-key.txt` baked in must stop being distributed. A friend running a key-baked build who auto-updates to a CI build silently loses the key and is asked for one. The two channels cannot coexist.

## Risks

- **Private key loss is unrecoverable.** Back it up before the first signed release.
- **macOS is best-effort.** These builds are unsigned, and Gatekeeper's handling of a replaced unsigned bundle needs verification against real behaviour rather than assumption. Windows is the platform in actual use; verify it properly and treat macOS as unproven until someone tests it.
- **A bad release is harder to recall** once it auto-installs. The draft gate is the mitigation.

## Out of scope

Scheduled re-checks while running, a changelog modal, rollback, update channels (beta/stable), and delta updates. One check at launch is the whole feature.
