import { useEffect, useState } from 'react';

export type UpdateStage = 'idle' | 'available' | 'downloading' | 'failed';

export interface UpdateState {
  stage: UpdateStage;
  version: string | null;
  notes: string | null;
  /** 0–100 while downloading, null otherwise. */
  progress: number | null;
  install: () => void;
  dismiss: () => void;
}

/** The slice of the Tauri update object this hook uses. Keeps the plugin's types out of tests. */
interface PendingUpdate {
  version: string;
  body?: string | null;
  downloadAndInstall(onEvent: (event: DownloadEvent) => void): Promise<void>;
}

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Checks GitHub for a newer release once per launch and offers it.
 *
 * Every failure here is deliberately silent: someone transcribing a two-hour recording should
 * never be interrupted because an update check could not reach the network. Outside the Tauri
 * webview the plugin does not exist at all, so nothing is imported and nothing renders.
 */
export function useUpdate(): UpdateState {
  const [stage, setStage] = useState<UpdateStage>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(null);

  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (cancelled || !update) return;
        setPending(update as unknown as PendingUpdate);
        setVersion(update.version);
        setNotes(update.body ?? null);
        setStage('available');
      } catch (error) {
        // Offline, unreachable feed, malformed manifest — none of it is the user's problem.
        console.warn('Update check failed', error);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const install = () => {
    if (!pending) return;
    setStage('downloading');
    setProgress(0);
    void (async () => {
      try {
        let total = 0;
        let received = 0;
        await pending.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          if (event.event === 'Progress') {
            received += event.data.chunkLength;
            if (total > 0) setProgress(Math.min(100, Math.round((received / total) * 100)));
          }
          if (event.event === 'Finished') setProgress(100);
        });
        // Windows hands over to the installer and this process exits on its own. macOS needs a nudge.
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch (error) {
        console.warn('Update failed', error);
        setStage('failed');
        setProgress(null);
      }
    })();
  };

  const dismiss = () => { setStage('idle'); setProgress(null); };

  return { stage, version, notes, progress, install, dismiss };
}
