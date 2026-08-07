import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

afterEach(() => vi.restoreAllMocks());

const saved = {
  id: 'one', title: 'Rapat', sourceName: 'rapat.mp3', language: 'indonesian', status: 'completed', progress: 100,
  createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', durationSeconds: 3,
  segments: [{ id: '0-0', startSeconds: 1, endSeconds: 3, text: 'Selamat pagi' }], text: 'Selamat pagi', error: null,
  summarize: false, summary: null, summaryError: null, chatMessages: [],
};

const configured = { hasApiKey: true, keySource: 'settings', transcribeModel: 'gpt-transcribe', summaryModel: 'gpt-5-mini' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface ApiMock { history?: unknown[]; settings?: unknown; onPut?: (body: string) => Response; onChat?: (body: string) => Response; onTest?: (body: string) => Response }

/** The app calls /api/transcriptions, /api/settings, and per-transcript /chat, so the mock has to route. */
function mockApi({ history = [], settings = configured, onPut, onChat, onTest }: ApiMock = {}) {
  const put = onPut ?? (() => json(settings));
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/api/settings/test')) {
      return Promise.resolve((onTest ?? (() => json({ ok: true, message: 'The key works.' })))(String(init?.body ?? '')));
    }
    if (url.endsWith('/api/settings')) {
      return Promise.resolve(init?.method === 'PUT' ? put(String(init.body)) : json(settings));
    }
    if (url.endsWith('/chat')) {
      return Promise.resolve((onChat ?? (() => json({ error: 'chat not mocked' }, 500)))(String(init?.body ?? '')));
    }
    return Promise.resolve(json(history));
  });
}

it('offers Indonesian upload and renders a saved timestamped transcript', async () => {
  mockApi({ history: [saved] });

  render(<App />);

  expect(screen.getByRole('option', { name: 'Indonesian (Bahasa Indonesia)' })).toHaveValue('indonesian');
  expect(await screen.findByRole('button', { name: /Rapat/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Selamat pagi')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
});

it('offers a summarise toggle beside the transcribe button', async () => {
  mockApi();

  render(<App />);

  const toggle = screen.getByRole('checkbox', { name: /Write meeting minutes/ });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});

it('shows the generated summary with a copy affordance', async () => {
  mockApi({ history: [{ ...saved, summarize: true, summary: '## Summary\nSemua berjalan baik.' }] });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByText(/Semua berjalan baik\./)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Copy minutes' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide minutes' }));
  expect(screen.queryByText(/Semua berjalan baik\./)).not.toBeInTheDocument();
});

it('surfaces a failed summary without hiding the transcript', async () => {
  mockApi({ history: [{ ...saved, summarize: true, summaryError: 'The transcript is complete, but the summary failed: rate limited' }] });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByDisplayValue('Selamat pagi')).toBeInTheDocument());
  expect(screen.getByText(/the summary failed: rate limited/)).toBeInTheDocument();
});

it('asks for an API key on first run instead of showing the upload form', async () => {
  const unconfigured = { hasApiKey: false, keySource: null, transcribeModel: 'gpt-transcribe', summaryModel: 'gpt-5-mini' };
  const put = vi.fn(() => json(configured));
  mockApi({ settings: unconfigured, onPut: put });

  render(<App />);

  expect(await screen.findByRole('heading', { name: 'Add your OpenAI key' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Transcribe audio/ })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/OpenAI API key/), { target: { value: 'sk-pasted-into-the-app-5678' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));

  await waitFor(() => expect(screen.getByRole('button', { name: /Transcribe audio/ })).toBeInTheDocument());
  expect(put).toHaveBeenCalledWith(JSON.stringify({ apiKey: 'sk-pasted-into-the-app-5678' }));
  expect(screen.queryByRole('heading', { name: 'Add your OpenAI key' })).not.toBeInTheDocument();
});

it('lets a configured user reopen settings to replace the key', async () => {
  mockApi();

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  expect(screen.getByText(/gpt-transcribe/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
});

it('shows the chat panel for a transcript with text and answers a question', async () => {
  const answered = { ...saved, chatMessages: [
    { id: 'q1', role: 'user', content: 'What was discussed?', createdAt: '2026-07-13T00:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'The budget.', createdAt: '2026-07-13T00:00:00.000Z' },
  ] };
  const onChat = vi.fn(() => json(answered));
  mockApi({ history: [saved], onChat });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  const input = await screen.findByLabelText('Ask a question');
  fireEvent.change(input, { target: { value: 'What was discussed?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

  expect(screen.getByText('Thinking…')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('The budget.')).toBeInTheDocument());
  expect(onChat).toHaveBeenCalledWith(JSON.stringify({ question: 'What was discussed?' }));
});

it('shows a placeholder instead of the chat panel when there is no transcript text yet', async () => {
  mockApi({ history: [{ ...saved, text: '', segments: [] }] });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByText('Nothing to chat about yet.')).toBeInTheDocument());
  expect(screen.queryByLabelText('Ask a question')).not.toBeInTheDocument();
});

it('lets the full transcript be hidden to reduce clutter', async () => {
  mockApi({ history: [saved] });

  render(<App />);

  fireEvent.click(await screen.findByRole('button', { name: /Rapat/ }));
  await waitFor(() => expect(screen.getByLabelText('Full transcript')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
  expect(screen.queryByLabelText('Full transcript')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show transcript' }));
  expect(screen.getByLabelText('Full transcript')).toBeInTheDocument();
});

it('tests a typed API key and reports the verdict without saving it', async () => {
  const fetchMock = mockApi({ settings: { ...configured, hasApiKey: false, keySource: null } });

  render(<App />);

  const field = await screen.findByLabelText(/OpenAI API key/);
  fireEvent.change(field, { target: { value: 'sk-a-key-long-enough-to-pass' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test key' }));

  expect(await screen.findByText(/The key works\./)).toBeInTheDocument();
  const tested = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/settings/test'));
  expect(JSON.parse(String(tested?.[1]?.body))).toEqual({ apiKey: 'sk-a-key-long-enough-to-pass' });
  // Testing is not saving: nothing should have been PUT.
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('surfaces a rejected key as an error', async () => {
  mockApi({
    settings: { ...configured, hasApiKey: false, keySource: null },
    onTest: () => json({ ok: false, message: 'OpenAI rejected this key. Check it was copied in full.' }),
  });

  render(<App />);

  fireEvent.change(await screen.findByLabelText(/OpenAI API key/), { target: { value: 'sk-wrong' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test key' }));

  expect(await screen.findByText(/OpenAI rejected this key/)).toBeInTheDocument();
});
