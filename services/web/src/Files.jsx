// One file: what it is, a preview when the browser can show it safely, download, and the text Weft
// can read from it (which is what search and the assistant use).
import { useEffect, useState } from 'react';
import { api, fetchFile } from './api.js';

const size = (n) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const KIND = { 'application/pdf': 'PDF', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'text/plain': 'Text', 'text/markdown': 'Markdown', 'text/csv': 'CSV', 'application/json': 'JSON', 'image/png': 'Picture', 'image/jpeg': 'Picture',
  'image/gif': 'Picture', 'image/webp': 'Picture' };
const PREVIEW = (m) => m === 'application/pdf' || m.startsWith('image/');

export default function FileView({ item }) {
  const [info, setInfo] = useState(null);
  const [text, setText] = useState(null);
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let made = null;
    setInfo(null); setUrl(null); setText(null); setError('');
    (async () => {
      try {
        const [[fi], [it]] = await Promise.all([
          api(`/file_info?item_id=eq.${item.id}&select=mime,size,text_note,created_at`),
          api(`/items?id=eq.${item.id}&select=body_text`),
        ]);
        if (!alive) return;
        setInfo(fi || null); setText(it?.body_text ?? null);
        if (fi && PREVIEW(fi.mime) && fi.size <= 15 * 1048576) {
          const blob = await fetchFile(item.id);
          if (!alive) return;
          made = URL.createObjectURL(blob); setUrl(made);
        }
      } catch (e) { if (alive) setError(e.message); }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [item.id]);

  async function download() {
    try {
      const blob = await fetchFile(item.id, true);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = u; a.download = item.title; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 10000);
    } catch (e) { setError(e.message); }
  }

  if (error) return <p className="send-error" role="alert">{error}</p>;
  if (!info) return <div className="skeleton" aria-label="Opening the file"><span /><span /></div>;
  return (
    <div className="file-view">
      <p className="file-meta">{KIND[info.mime] || 'File'}, {size(Number(info.size))}, added {new Date(info.created_at).toLocaleDateString([], { dateStyle: 'medium' })}</p>
      <p><button className="btn btn--primary btn--sm" type="button" onClick={download}>Download</button></p>
      {url && (info.mime.startsWith('image/')
        ? <img className="file-preview" src={url} alt={item.title} />
        : <iframe className="file-preview file-preview--pdf" src={url} title={`Preview of ${item.title}`} />)}
      {text ? (
        <details className="file-text">
          <summary>Text Weft can read ({text.length.toLocaleString()} characters)</summary>
          <pre>{text.slice(0, 20000)}{text.length > 20000 ? '\n…' : ''}</pre>
        </details>
      ) : <p className="file-note">{info.text_note || 'Weft has no text from this file.'}</p>}
      {text && info.text_note && <p className="file-note">{info.text_note}</p>}
    </div>
  );
}
