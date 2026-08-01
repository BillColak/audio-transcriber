import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

afterEach(() => vi.restoreAllMocks());

const saved = {
  id: 'one', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
  createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', durationSeconds: 3,
  segments: [{ id: '0-0', startSeconds: 1, endSeconds: 3, text: 'Selamat pagi' }], error: null,
  summarize: false, summary: null, summaryError: null,
};

function mockHistory(...items: unknown[]) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

it('offers Indonesian upload and renders a saved timestamped transcript', async () => {
  mockHistory(saved);

  render(<App />);

  expect(screen.getByRole('option', { name: 'Indonesian (Bahasa Indonesia)' })).toHaveValue('indonesian');
  expect(await screen.findByRole('button', { name: /Rapat/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Selamat pagi')).toBeInTheDocument());
  expect(screen.getByText('00:00:01')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
});

it('offers a summarise toggle beside the transcribe button', async () => {
  mockHistory();

  render(<App />);

  const toggle = screen.getByRole('checkbox', { name: /Summarise when done/ });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});

it('shows the generated summary with a copy affordance', async () => {
  mockHistory({ ...saved, summarize: true, summary: '## Summary\nSemua berjalan baik.' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByText(/Semua berjalan baik\./)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Copy summary' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.queryByText(/Semua berjalan baik\./)).not.toBeInTheDocument();
});

it('surfaces a failed summary without hiding the transcript', async () => {
  mockHistory({ ...saved, summarize: true, summaryError: 'The transcript is complete, but the summary failed: rate limited' });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Selamat pagi')).toBeInTheDocument());
  expect(screen.getByText(/the summary failed: rate limited/)).toBeInTheDocument();
});
