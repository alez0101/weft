// The search box in the top bar. Word matches come from weft.search (as you, so only what you can open),
// then matches by meaning from the assistant service, shown after them. Keyboard: / or Ctrl+K to focus,
// arrows to move, Enter to open, Escape to close.
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { api, assistant } from './api.js';

const GROUPS = [
  ['channel', 'Channels'], ['document', 'Documents'], ['wiki', 'Wiki pages'], ['table', 'Tables'],
  ['whiteboard', 'Whiteboards'], ['file', 'Files'], ['event', 'Events'], ['message', 'Messages'], ['related', 'Related by meaning'],
];
const KIND = { document: 'Document', wiki: 'Wiki page', table: 'Table', whiteboard: 'Whiteboard', file: 'File', event: 'Event', message: 'Message', channel: 'Channel' };
const where = (r) => (r.space_kind === 'channel' ? `#${r.space_name}` : r.space_kind === 'personal' ? 'Personal' : r.space_kind === 'dm' ? 'Direct message' : r.space_kind === 'assistant' ? 'Your Weft conversation' : '');
const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');

// « and » mark the matches; everything else is plain text (never HTML).
function Snippet({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(«[^»]*»)/g);
  return <span className="search-snippet">{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}</span>;
}

export default function SearchBox({ onOpenItem, onOpenEvent, onOpenChannel, onOpenMessage }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState([]);
  const [meaning, setMeaning] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const box = useRef(null);
  const seq = useRef(0);
  const listId = useId();

  // / or Ctrl+K focuses the box (unless you are typing somewhere else).
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); input.current?.focus(); input.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) { setWords([]); setMeaning([]); setBusy(false); return undefined; }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const w = await api('/rpc/search', { method: 'POST', body: { p_q: text, p_limit: 6 } });
        if (n !== seq.current) return;
        setWords(w); setError(''); setBusy(false); setActive(0);
        if (text.length >= 3) {
          const r = await assistant(`/search/related?q=${encodeURIComponent(text)}`).catch(() => ({ results: [] }));
          if (n !== seq.current) return;
          const seen = new Set(w.map((x) => x.id));
          setMeaning((r.results || []).filter((x) => !seen.has(x.id)));
        } else setMeaning([]);
      } catch (e) { if (n === seq.current) { setError(e.message); setBusy(false); } }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const rows = [
    ...GROUPS.filter(([k]) => k !== 'related').flatMap(([k]) => words.filter((r) => r.kind === k)),
    ...meaning.map((r) => ({ ...r, related: true })),
  ];
  const go = (r) => {
    if (!r) return;
    setOpen(false); input.current?.blur();
    if (r.kind === 'channel') onOpenChannel(r.id);
    else if (r.kind === 'message') onOpenMessage(r.space_id, r.id);
    else if (r.kind === 'event') onOpenEvent(r.id);
    else onOpenItem(r.id);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(rows[active]); }
    else if (e.key === 'Escape') { if (open) { setOpen(false); } else { setQ(''); input.current?.blur(); } }
  };
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);

  let i = -1;
  const show = open && q.trim();
  return (
    <div className="search-wrap" ref={box}>
      <label className="search">
        <span className="visually-hidden">Search everything you can open</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></svg>
        <input ref={input} type="search" placeholder="Search everything you can open  ( / )" value={q} autoComplete="off"
          role="combobox" aria-expanded={!!show} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={show && rows[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
      </label>
      {show && (
        <div className="search-panel">
          {error ? <p className="send-error" role="alert">Search failed: {error}</p>
            : !rows.length ? <p className="search-empty" role="status">{busy ? 'Searching…' : `Nothing found for "${q.trim()}" in what you can open.`}</p> : (
            <ul id={listId} role="listbox" aria-label="Search results" className="search-list">
              {GROUPS.map(([k, label]) => {
                const group = k === 'related' ? rows.filter((r) => r.related) : rows.filter((r) => !r.related && r.kind === k);
                if (!group.length) return null;
                return (
                  <li key={k} role="presentation">
                    <p className="search-group" aria-hidden="true">{label}</p>
                    <ul role="presentation">
                      {group.map((r) => {
                        i += 1; const idx = i;
                        return (
                          <li key={`${k}-${r.id}`} id={`${listId}-${idx}`} role="option" aria-selected={idx === active}
                            className={`search-row${idx === active ? ' is-active' : ''}`}
                            onMouseEnter={() => setActive(idx)} onMouseDown={(e) => { e.preventDefault(); go(r); }}>
                            <span className="search-title">{r.title || (r.kind === 'message' ? where(r) : '')}</span>
                            <span className="search-meta">{[r.related && KIND[r.kind], r.kind !== 'channel' && r.kind !== 'message' && where(r), when(r.at)].filter(Boolean).join(', ')}</span>
                            {r.kind !== 'channel' && <Snippet text={r.snippet} />}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="search-foot">Only what you can open appears here.{busy && rows.length ? ' Still looking…' : ''}</p>
        </div>
      )}
    </div>
  );
}
