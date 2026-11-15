// One spreadsheet, in the spreadsheet engine's editor (OnlyOffice Docs, served by Weft at /office/).
// The files service signs the editor's configuration and decides edit or view by the same rule as the
// rest of Weft; people in the sheet at the same time see each other's changes as they type. The engine
// saves to Weft while people edit and when the last person closes it.
import { useEffect, useRef, useState } from 'react';
import { editorConfig, officeStatus } from './api.js';
import { useEffectiveMode } from './mode.js';

let script = null;   // the engine's editor script, loaded once
const loadScript = () => {
  if (window.DocsAPI) return Promise.resolve();
  if (!script) {
    script = new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = '/office/web-apps/apps/api/documents/api.js';
      s.onload = ok; s.onerror = () => { script = null; s.remove(); no(new Error('The spreadsheet engine did not load.')); };
      document.head.appendChild(s);
    });
  }
  return script;
};

export default function SpreadsheetView({ item }) {
  const mode = useEffectiveMode();
  const box = useRef(null);
  const [state, setState] = useState('checking');   // checking | starting | off | open | error
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let alive = true; let editor = null; let timer = null;
    setState('checking'); setError('');
    (async () => {
      try {
        const st = await officeStatus();
        if (!alive) return;
        if (!st.enabled) { setState('off'); return; }
        if (!st.ready) { setState('starting'); timer = setTimeout(() => alive && setTries((n) => n + 1), 10000); return; }
        const [{ config, edit: canEdit }] = await Promise.all([
          editorConfig(item.id, { dark: mode === 'dark', lang: (navigator.language || 'en').slice(0, 2) }),
          loadScript(),
        ]);
        if (!alive || !box.current) return;
        setEdit(canEdit);
        const holder = document.createElement('div');
        holder.id = `sheet-${item.id}-${Date.now()}`;
        box.current.replaceChildren(holder);
        editor = new window.DocsAPI.DocEditor(holder.id, {
          ...config, width: '100%', height: '100%', type: 'desktop',   // also on phones: the engine's mobile editor is view-only in the free Community edition
          events: {
            onAppReady: () => alive && setState('open'),
            onError: (e) => { if (alive) { setError(e?.data?.errorDescription || 'The spreadsheet could not be opened.'); setState('error'); } },
          },
        });
      } catch (e) { if (alive) { setError(e.message); setState('error'); } }
    })();
    return () => { alive = false; clearTimeout(timer); try { editor?.destroyEditor(); } catch { /* already gone */ } };
  }, [item.id, mode, tries]);

  return (
    <div className="sheet-view">
      {state === 'open' && edit === false && <p className="sheet-note">You can look at this spreadsheet but not change it: only people who can edit {item.space_label || 'this space'} can.</p>}
      {state === 'starting' && <p className="sheet-note" role="status">The spreadsheet engine is starting (it takes about a minute after a restart). This page will open the sheet when it is ready.</p>}
      {state === 'off' && <p className="sheet-note" role="status">Spreadsheets are not set up on this Weft. An admin can turn them on (see Spreadsheets in the admin wiki).</p>}
      {state === 'error' && <p className="send-error" role="alert">{error} <button className="btn btn--sm" type="button" onClick={() => setTries((n) => n + 1)}>Try again</button></p>}
      {state === 'checking' && <div className="skeleton" aria-label="Opening the spreadsheet"><span /><span /></div>}
      <div className="sheet-frame" ref={box} hidden={state !== 'open' && state !== 'checking'} />
    </div>
  );
}
