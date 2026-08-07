import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

const check = vi.fn();
const relaunch = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

/** The hook only runs inside the Tauri webview, so tests have to fake that marker. */
function pretendTauri(present: boolean) {
  if (present) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
  // App itself polls the backend; none of these tests care what it returns.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  pretendTauri(false);
  vi.restoreAllMocks();
});

it('never checks for updates outside the desktop app', async () => {
  pretendTauri(false);

  render(<App />);

  await waitFor(() => expect(screen.getByRole('contentinfo')).toBeInTheDocument());
  expect(check).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Application update')).not.toBeInTheDocument();
});

it('says nothing when the app is already up to date', async () => {
  pretendTauri(true);
  check.mockResolvedValue(null);

  render(<App />);

  await waitFor(() => expect(check).toHaveBeenCalled());
  expect(screen.queryByLabelText('Application update')).not.toBeInTheDocument();
});

it('offers an available update with its version and notes', async () => {
  pretendTauri(true);
  check.mockResolvedValue({ version: '1.0.3', body: 'Fixes summary formatting.', downloadAndInstall: vi.fn() });

  render(<App />);

  expect(await screen.findByText('Version 1.0.3 is available.')).toBeInTheDocument();
  expect(screen.getByText('Fixes summary formatting.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument();
});

it('stays quiet when the update feed cannot be reached', async () => {
  pretendTauri(true);
  check.mockRejectedValue(new Error('network unreachable'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  render(<App />);

  await waitFor(() => expect(check).toHaveBeenCalled());
  expect(screen.queryByLabelText('Application update')).not.toBeInTheDocument();
  // The rest of the app must still be usable — an update check is never a blocker.
  // The footer is always present, so it stands in for 'the app still rendered'.
  expect(screen.getByRole('contentinfo')).toBeInTheDocument();
});

it('downloads on consent and relaunches when it finishes', async () => {
  pretendTauri(true);
  const downloadAndInstall = vi.fn(async (onEvent: (event: unknown) => void) => {
    onEvent({ event: 'Started', data: { contentLength: 100 } });
    onEvent({ event: 'Progress', data: { chunkLength: 50 } });
    onEvent({ event: 'Finished' });
  });
  check.mockResolvedValue({ version: '1.0.3', body: null, downloadAndInstall });

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));

  await waitFor(() => expect(relaunch).toHaveBeenCalled());
  expect(downloadAndInstall).toHaveBeenCalled();
});

it('leaves the app usable when an update fails to install', async () => {
  pretendTauri(true);
  check.mockResolvedValue({ version: '1.0.3', body: null, downloadAndInstall: vi.fn().mockRejectedValue(new Error('disk full')) });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));

  expect(await screen.findByText('The update could not be installed.')).toBeInTheDocument();
  expect(relaunch).not.toHaveBeenCalled();
  // The footer is always present, so it stands in for 'the app still rendered'.
  expect(screen.getByRole('contentinfo')).toBeInTheDocument();
});

it('dismisses the offer for the rest of the session', async () => {
  pretendTauri(true);
  check.mockResolvedValue({ version: '1.0.3', body: null, downloadAndInstall: vi.fn() });

  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Later' }));

  expect(screen.queryByLabelText('Application update')).not.toBeInTheDocument();
});
