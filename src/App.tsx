import { useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';

type Status = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
interface Segment { id: string; startSeconds: number; endSeconds: number; text: string }
interface Transcript {
  id: string; title: string; sourceName: string; language: 'auto' | 'indonesian'; status: Status; progress: number;
  createdAt: string; updatedAt: string; durationSeconds: number; segments: Segment[]; error: string | null;
}

const api = '/api/transcriptions';

export default function App() {
  const [history, setHistory] = useState<Transcript[]>([]);
  const [selected, setSelected] = useState<Transcript | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<'auto' | 'indonesian'>('auto');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const requestRef = useRef<XMLHttpRequest | null>(null);

  const loadHistory = async () => {
    try {
      const response = await fetch(api); if (!response.ok) throw new Error();
      const items = await response.json() as Transcript[]; setHistory(items);
      setSelected((current) => current ? items.find((item) => item.id === current.id) ?? current : current);
    } catch { setMessage('Could not reach the local transcription server.'); }
  };

  useEffect(() => { const timer = window.setTimeout(() => void loadHistory(), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (!history.some((item) => item.status === 'queued' || item.status === 'processing')) return;
    const timer = window.setInterval(() => void loadHistory(), 1500); return () => window.clearInterval(timer);
  }, [history]);

  const chooseFile = (next: File | undefined) => { if (next) { setFile(next); setMessage(''); } };
  const upload = () => {
    if (!file) { setMessage('Choose an audio file first.'); return; }
    const form = new FormData(); form.append('audio', file); form.append('language', language);
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
    const response = await fetch(`${api}/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: selected.title, segments: selected.segments }) });
    setMessage(response.ok ? 'Changes saved.' : 'Could not save changes.'); if (response.ok) void loadHistory();
  };
  const remove = async (item: Transcript) => {
    if (!window.confirm(item.status === 'processing' ? 'Cancel this transcription?' : 'Delete this transcript?')) return;
    await fetch(`${api}/${item.id}`, { method: 'DELETE' }); if (selected?.id === item.id) setSelected(null); void loadHistory();
  };
  const copyAll = async () => { if (selected) { await navigator.clipboard.writeText(selected.segments.map((s) => s.text).join(' ')); setMessage('Transcript copied.'); } };
  const active = useMemo(() => history.filter((item) => item.status === 'queued' || item.status === 'processing'), [history]);

  return <div className="app-shell">
    <header className="hero"><div className="brand-mark" aria-hidden="true">⌁</div><div><p className="eyebrow">PRIVATE · LOCAL · TIMESTAMPED</p><h1>Audio to text,<br/><span>without the clutter.</span></h1><p className="intro">Drop in a recording. Get a clean, editable transcript with precise timestamps—kept in your own local history.</p></div></header>
    <main>
      <section className="upload-card" aria-labelledby="upload-title">
        <div><p className="section-number">01</p><h2 id="upload-title">New transcription</h2></div>
        <label className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".flac,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm" onChange={(e) => chooseFile(e.target.files?.[0])}/>
          <span className="upload-icon" aria-hidden="true">↑</span><strong>{file ? file.name : 'Drop audio here'}</strong><small>{file ? formatBytes(file.size) : 'or click to browse · up to 2 GB'}</small>
        </label>
        <div className="upload-options"><label>Spoken language<select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}><option value="auto">Auto-detect</option><option value="indonesian">Indonesian (Bahasa Indonesia)</option></select></label>
          <button className="primary" onClick={upload} disabled={!file || uploadProgress !== null}>Transcribe audio <span>→</span></button></div>
        {uploadProgress !== null && <div className="progress-wrap"><progress value={uploadProgress} max="100"/><span>{uploadProgress}% uploaded</span><button className="text-button" onClick={() => requestRef.current?.abort()}>Cancel</button></div>}
        {message && <p className="notice" role="status">{message}</p>}
      </section>

      {active.length > 0 && <section className="active-jobs"><p className="section-number">02</p><h2>In progress</h2>{active.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{item.status === 'queued' ? 'Waiting in queue' : 'Transcribing and timestamping'}</span></div><progress value={item.progress} max="100"/><b>{item.progress}%</b><button onClick={() => void remove(item)}>Cancel</button></article>)}</section>}

      <section className="workspace">
        <aside><div className="history-heading"><div><p className="section-number">{active.length ? '03' : '02'}</p><h2>History</h2></div><span>{history.length}</span></div>
          <div className="history-list">{history.length === 0 && <p className="empty">Your transcripts will appear here.</p>}{history.map((item) => <button className={selected?.id === item.id ? 'selected' : ''} key={item.id} onClick={() => setSelected(item)} aria-label={`${item.title}, ${item.status}`}><span className={`status-dot ${item.status}`}/><span><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.language === 'indonesian' ? 'Bahasa Indonesia' : 'Auto language'}</small></span><em>{item.status}</em></button>)}</div>
        </aside>
        <section className="editor" aria-label="Transcript editor">
          {!selected ? <div className="editor-empty"><span>⌁</span><h3>Select a transcript</h3><p>Choose an item from history to review, edit, copy, or export it.</p></div> : <>
            <div className="editor-header"><input aria-label="Transcript title" value={selected.title} onChange={(e) => setSelected({ ...selected, title: e.target.value })}/><div className="editor-actions"><button onClick={() => void copyAll()}>Copy all</button><a href={`${api}/${selected.id}/download?format=txt`}>TXT</a><a href={`${api}/${selected.id}/download?format=vtt`}>VTT</a><button className="danger" onClick={() => void remove(selected)}>Delete</button></div></div>
            {selected.error && <p className="error">{selected.error}</p>}
            <div className="segments">{selected.segments.map((segment, index) => <div className="segment" key={segment.id}><time>{clock(segment.startSeconds)}</time><span>{String(index + 1).padStart(2, '0')}</span><textarea aria-label={`Transcript segment ${index + 1}`} value={segment.text} rows={Math.max(2, Math.ceil(segment.text.length / 75))} onChange={(e) => setSelected({ ...selected, segments: selected.segments.map((item) => item.id === segment.id ? { ...item, text: e.target.value } : item) })}/></div>)}</div>
            <div className="save-bar"><span>{selected.segments.length} timestamped segments · {duration(selected.durationSeconds)}</span><button className="primary" onClick={() => void save()}>Save changes</button></div>
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
