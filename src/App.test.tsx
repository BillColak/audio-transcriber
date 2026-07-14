import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

afterEach(() => vi.restoreAllMocks());

it('offers Indonesian upload and renders a saved timestamped transcript', async () => {
  const saved = {
    id: 'one', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', durationSeconds: 3,
    segments: [{ id: '0-0', startSeconds: 1, endSeconds: 3, text: 'Selamat pagi' }], error: null,
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([saved]), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  render(<App />);

  expect(screen.getByRole('option', { name: 'Indonesian (Bahasa Indonesia)' })).toHaveValue('indonesian');
  expect(await screen.findByRole('button', { name: /Rapat/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Selamat pagi')).toBeInTheDocument());
  expect(screen.getByText('00:00:01')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
});
