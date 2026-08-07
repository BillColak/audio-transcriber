import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import './styles.css';

type Status = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
interface Segment { id: string; startSeconds: number; endSeconds: number; text: string }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
interface Transcript {
  id: string; title: string; sourceName: string; language: 'auto' | 'indonesian'; status: Status; progress: number;
  createdAt: string; updatedAt: string; durationSeconds: number; segments: Segment[]; text: string; error: string | null;
  summarize: boolean; summary: string | null; summaryError: string | null; chatMessages: ChatMessage[];
}

// In a browser the Vite dev server (or Express itself) proxies `/api`. Inside the Tauri webview the
// origin is `tauri://localhost`, so the backend has to be addressed absolutely.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const apiBase = inTauri ? 'http://127.0.0.1:8787' : '';
const api = `${apiBase}/api/transcriptions`;
const settingsApi = `${apiBase}/api/settings`;

interface Settings { hasApiKey: boolean; keySource: 'settings' | 'environment' | null; transcribeModel: string; summaryModel: string }

export default function App() {
  const [history, setHistory] = useState<Transcript[]>([]);
  const [selected, setSelected] = useState<Transcript | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<'auto' | 'indonesian'>('auto');
  const [summarize, setSummarize] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [chatSelectedId, setChatSelectedId] = useState<string | null>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);

  if ((selected?.id ?? null) !== chatSelectedId) {
    setChatSelectedId(selected?.id ?? null);
    setChatDraft(''); setChatError(null); setPendingQuestion(null);
  }

  const loadHistory = async (quiet = false) => {
    try {
      const response = await fetch(api); if (!response.ok) throw new Error();
      const items = await response.json() as Transcript[]; setHistory(items);
      setSelected((current) => current ? items.find((item) => item.id === current.id) ?? current : current);
      return true;
    } catch { if (!quiet) setMessage('Could not reach the local transcription server.'); return false; }
  };

  const loadSettings = async () => {
    try {
      const response = await fetch(settingsApi); if (!response.ok) throw new Error();
      setSettings(await response.json() as Settings);
    } catch { /* the history poll below already reports an unreachable backend */ }
  };

  // The packaged app starts its backend as a child process, so the first few polls can miss.
  useEffect(() => {
    let stopped = false; let attempts = 0;
    const attempt = async () => {
      if (stopped) return;
      attempts += 1;
      const reached = await loadHistory(attempts < 15);
      if (reached) { void loadSettings(); return; }
      if (!stopped && attempts < 15) window.setTimeout(() => void attempt(), 700);
    };
    void attempt();
    return () => { stopped = true; };
  }, []);

  const saveApiKey = async () => {
    setSavingKey(true);
    try {
      const response = await fetch(settingsApi, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: apiKeyDraft }) });
      const body = await response.json() as Settings & { error?: string };
      if (!response.ok) { setMessage(body.error ?? 'Could not save the API key.'); return; }
      setSettings(body); setApiKeyDraft(''); setSettingsOpen(false); setMessage('API key saved.');
    } catch { setMessage('Could not reach the local transcription server.'); }
    finally { setSavingKey(false); }
  };
  useEffect(() => {
    if (!history.some((item) => item.status === 'queued' || item.status === 'processing')) return;
    const timer = window.setInterval(() => void loadHistory(), 1500); return () => window.clearInterval(timer);
  }, [history]);

  const chooseFile = (next: File | undefined) => { if (next) { setFile(next); setMessage(''); } };
  const upload = () => {
    if (!file) { setMessage('Choose an audio file first.'); return; }
    const form = new FormData(); form.append('audio', file); form.append('language', language); form.append('summarize', String(summarize));
    const xhr = new XMLHttpRequest(); requestRef.current = xhr; setUploadProgress(0); setMessage('Uploading…');
    xhr.open('POST', api);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onload = () => {
      setUploadProgress(null); requestRef.current = null;
      if (xhr.status === 202) { setFile(null); setMessage('Upload complete. Transcription is queued.'); void loadHistory(); }
      else { setMessage(readError(xhr.responseText)); }
    };
    xhr.onerror = () => { setUploadProgress(null); setMessage('Upload failed. Is the local server running?'); };
    xhr.onabort = () => { setUploadProgress(null); setMessage('Upload cancelled.'); };
    xhr.send(form);
  };

  const save = async () => {
    if (!selected) return;
    const response = await fetch(`${api}/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: selected.title, text: selected.text }) });
    setMessage(response.ok ? 'Changes saved.' : 'Could not save changes.'); if (response.ok) void loadHistory();
  };
  const remove = async (item: Transcript) => {
    if (!window.confirm(item.status === 'processing' ? 'Cancel this transcription?' : 'Delete this transcript?')) return;
    await fetch(`${api}/${item.id}`, { method: 'DELETE' }); if (selected?.id === item.id) setSelected(null); void loadHistory();
  };
  const copyAll = async () => { if (selected) { await navigator.clipboard.writeText(selected.text); setMessage('Transcript copied.'); } };
  const copySummary = async () => { if (selected?.summary) { await navigator.clipboard.writeText(selected.summary); setMessage('Summary copied.'); } };
  const askQuestion = async () => {
    if (!selected || chatSending || !chatDraft.trim()) return;
    const question = chatDraft.trim();
    setChatSending(true); setPendingQuestion(question); setChatError(null);
    try {
      const response = await fetch(`${api}/${selected.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const body = await response.json() as Transcript & { error?: string };
      if (!response.ok) { setChatError(body.error ?? 'The question could not be answered.'); return; }
      setHistory((items) => items.map((item) => item.id === body.id ? body : item));
      setSelected((current) => current?.id === body.id ? body : current);
      setChatDraft('');
    } catch { setChatError('Could not reach the local transcription server.'); }
    finally { setChatSending(false); setPendingQuestion(null); }
  };
  const active = useMemo(() => history.filter((item) => item.status === 'queued' || item.status === 'processing'), [history]);
  const needsKey = settings !== null && !settings.hasApiKey;

  return <div className="app-shell">
    <header className="hero"><div className="brand-mark" aria-hidden="true">⌁</div><div><p className="eyebrow">PRIVATE · LOCAL · TIMESTAMPED</p><h1>Audio to text,<br/><span>without the clutter.</span></h1><p className="intro">Drop in a recording. Get a clean, editable transcript with precise timestamps—kept in your own local history.</p></div>
      {settings && !needsKey && <button className="settings-button" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>Settings</button>}</header>
    <main>
      {(needsKey || settingsOpen) && <section className="setup-card" aria-labelledby="setup-title">
        <div><p className="section-number">00</p><h2 id="setup-title">{needsKey ? 'Add your OpenAI key' : 'Settings'}</h2></div>
        <div className="setup-body">
          <p>{needsKey
            ? 'Audio Transcriber sends audio chunks to OpenAI to transcribe them. Paste an API key to get started — it is saved on this computer only, never uploaded anywhere else.'
            : 'Your key is saved on this computer only. Pasting a new one replaces it.'}</p>
          <label htmlFor="api-key">OpenAI API key
            <input id="api-key" type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" value={apiKeyDraft} onChange={(e) => setApiKeyDraft(e.target.value)}/>
          </label>
          <div className="setup-actions">
            <button className="primary" onClick={() => void saveApiKey()} disabled={savingKey || !apiKeyDraft.trim()}>{savingKey ? 'Saving…' : 'Save key'}</button>
            {!needsKey && <button className="text-button" onClick={() => { setSettingsOpen(false); setApiKeyDraft(''); }}>Close</button>}
          </div>
          {needsKey && message && <p className="notice" role="status">{message}</p>}
          {settings && <p className="setup-meta">Transcription · {settings.transcribeModel} — Summaries · {settings.summaryModel}{settings.keySource === 'environment' ? ' — currently using the key from .env' : ''}</p>}
        </div>
      </section>}

      {!needsKey && <section className="upload-card" aria-labelledby="upload-title">
        <div><p className="section-number">01</p><h2 id="upload-title">New transcription</h2></div>
        <label className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".flac,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm" onChange={(e) => chooseFile(e.target.files?.[0])}/>
          <span className="upload-icon" aria-hidden="true">↑</span><strong>{file ? file.name : 'Drop audio here'}</strong><small>{file ? formatBytes(file.size) : 'or click to browse · up to 2 GB'}</small>
        </label>
        <div className="upload-options"><label>Spoken language<select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}><option value="auto">Auto-detect</option><option value="indonesian">Indonesian (Bahasa Indonesia)</option></select></label>
          <div className="upload-actions">
            <label className="toggle"><input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)}/>Summarise when done</label>
            <button className="primary" onClick={upload} disabled={!file || uploadProgress !== null}>Transcribe audio <span>→</span></button>
          </div></div>
        {uploadProgress !== null && <div className="progress-wrap"><progress value={uploadProgress} max="100"/><span>{uploadProgress}% uploaded</span><button className="text-button" onClick={() => requestRef.current?.abort()}>Cancel</button></div>}
        {message && <p className="notice" role="status">{message}</p>}
      </section>}

      {active.length > 0 &&<section className="active-jobs"><p className="section-number">02</p><h2>In progress</h2>{active.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.status === 'queued' ? 'Waiting in queue' : 'Transcribing and timestamping'}</span></div><progress value={item.progress} max="100"/><b>{item.progress}%</b><button onClick={() => void remove(item)}>Cancel</button></article>)}</section>}

      <section className="workspace">
        <aside><div className="history-heading"><div><p className="section-number">{active.length ? '03' : '02'}</p><h2>History</h2></div><span>{history.length}</span></div>
          <div className="history-list">{history.length === 0 && <p className="empty">Your transcripts will appear here.</p>}{history.map((item) => <button className={selected?.id === item.id ? 'selected' : ''} key={item.id} onClick={() => setSelected(item)} aria-label={`${item.title}, ${item.status}`}><span className={`status-dot ${item.status}`}/><span><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.language === 'indonesian' ? 'Bahasa Indonesia' : 'Auto language'}</small></span><em>{item.status}</em></button>)}</div>
        </aside>
        <section className="editor" aria-label="Transcript editor">
          {!selected ? <div className="editor-empty"><span>⌁</span><h3>Select a transcript</h3><p>Choose an item from history to review, edit, copy, or export it.</p></div> : <>
            <div className="editor-header"><input aria-label="Transcript title" value={selected.title} onChange={(e) => setSelected({ ...selected, title: e.target.value })}/><div className="editor-actions"><button onClick={() => void copyAll()}>Copy all</button><a href={`${api}/${selected.id}/download?format=txt`}>TXT</a>{selected.summary && <a href={`${api}/${selected.id}/download?format=md`}>MD</a>}<button className="danger" onClick={() => void remove(selected)}>Delete</button></div></div>
            {selected.error && <p className="error">{selected.error}</p>}
            {selected.summaryError && <p className="error">{selected.summaryError}</p>}
            {selected.summarize && !selected.summary && !selected.summaryError && selected.status !== 'completed' && <p className="notice-inline">A meeting summary will be written once the transcript finishes.</p>}
            {selected.summary && <section className="summary-panel" aria-label="Meeting summary">
              <header><div><p className="section-number">MEETING MINUTES</p><h3>Summary</h3></div><div className="summary-actions"><button onClick={() => void copySummary()}>Copy summary</button><button onClick={() => setSummaryOpen((open) => !open)} aria-expanded={summaryOpen} aria-label={summaryOpen ? 'Hide summary' : 'Show summary'}>{summaryOpen ? 'Hide' : 'Show'}</button></div></header>
              {summaryOpen && <div className="summary-body"><ReactMarkdown>{selected.summary}</ReactMarkdown></div>}
            </section>}
            {selected.text.trim() ? <section className="chat-panel" aria-label="Ask about this transcript">
              <header><p className="section-number">ASK</p><h3>Ask about this transcript</h3></header>
              <div className="chat-messages">
                {selected.chatMessages.length === 0 && !pendingQuestion && <p className="notice-inline">Ask a question about what was said.</p>}
                {selected.chatMessages.map((msg) => <div className={`chat-message ${msg.role}`} key={msg.id}>
                  <strong>{msg.role === 'user' ? 'You' : 'Assistant'}</strong>
                  {msg.role === 'assistant' ? <ReactMarkdown>{msg.content}</ReactMarkdown> : <p>{msg.content}</p>}
                </div>)}
                {pendingQuestion && <>
                  <div className="chat-message user"><strong>You</strong><p>{pendingQuestion}</p></div>
                  <div className="chat-message assistant"><strong>Assistant</strong><p className="notice-inline">Thinking…</p></div>
                </>}
              </div>
              {chatError && <p className="error">{chatError}</p>}
              <div className="chat-input">
                <input aria-label="Ask a question" placeholder="What did they decide about…" value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void askQuestion(); } }}/>
                <button className="primary" onClick={() => void askQuestion()} disabled={chatSending || !chatDraft.trim()}>{chatSending ? 'Asking…' : 'Ask'}</button>
              </div>
            </section> : <p className="notice-inline">Nothing to chat about yet.</p>}
            <section className="transcript-editor" aria-label="Full transcript editor">
              <header><div><p className="section-number">TRANSCRIPT</p><h3>Transcript</h3></div><div className="transcript-actions"><button onClick={() => setTranscriptOpen((open) => !open)} aria-expanded={transcriptOpen} aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'}>{transcriptOpen ? 'Hide' : 'Show'}</button></div></header>
              {transcriptOpen && <div className="transcript-body">
                <textarea id="transcript-text" aria-label="Full transcript" value={selected.text} rows={Math.max(10, Math.ceil(selected.text.length / 80))} onChange={(e) => setSelected({ ...selected, text: e.target.value })}/>
              </div>}
            </section>
            <div className="save-bar"><span>{duration(selected.durationSeconds)}</span><button className="primary" onClick={() => void save()}>Save changes</button></div>
          </>}
        </section>
      </section>
    </main>
    <footer><span>Audio Transcriber</span><p>Original recordings are removed after processing. Transcripts stay on this computer.</p></footer>
  </div>;
}

function readError(body: string): string { try { return (JSON.parse(body) as { error?: string }).error ?? 'Upload failed.'; } catch { return 'Upload failed.'; } }
function clock(seconds: number): string { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = Math.floor(seconds % 60); return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':'); }
function duration(seconds: number): string { const minutes = Math.floor(seconds / 60); return `${minutes}m ${Math.round(seconds % 60)}s`; }
function formatBytes(bytes: number): string { return bytes > 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
