// Journal: private dated pages in your personal space, one page per day. Only you read or write them: the
// database refuses everyone else, Weft's assistant included, and pages are not in Weft search. The left lists
// your pages, newest first, with a search box over your own pages; the right is one day's page. Saving makes
// or changes that day's page; an empty page is not saved (delete it instead). Live: a journal_entries notice
// (for example from your other browser) refetches; a page you are typing in is never overwritten.
// The Home widget "Your journal" uses SEL and firstLine.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { addDays, dayKey } from './TimeOff.jsx';

export const SEL = 'id,day,body,updated_at';
export const today = () => dayKey(new Date());
export const longDay = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDay = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const firstLine = (body, n = 90) => { const l = (body || '').trim().split('\n')[0]; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };
// PostgREST ilike: * is the wildcard; escape the SQL ones so a search for "50%" means 50%.
const pattern = (q) => encodeURIComponent(`*${q.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '')}*`);
const MAX = 20000;

export default function Journal({ notice, openDay, setOpenDay }) {
  const day = openDay && /^\d{4}-\d{2}-\d{2}$/.test(openDay) ? openDay : today();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [draft, setDraft] = useState({ day: null, text: '', base: '' }); // base: the saved text the draft started from
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const entry = rows?.find((r) => r.day === day) || null;
  const dirty = draft.day === day && draft.text !== draft.base;

  const load = useCallback(() => api(`/journal_entries?select=${SEL}&order=day.desc&limit=400`).then(setRows), []);
  useEffect(() => { load().catch((e) => setError(`Your journal could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'journal_entries') load().catch(() => {}); }, [notice, load]);
  // When the day or its saved page changes, start the draft from it, unless you are typing in that day.
  useEffect(() => {
    if (!rows) return;
    const saved = entry?.body || '';
    setDraft((d) => (d.day === day && d.text !== d.base ? d : { day, text: saved, base: saved }));
  }, [day, rows, entry?.body]);
  // Search your own pages (the database only ever returns yours).
  useEffect(() => {
    const t = q.trim();
    if (!t) { setFound(null); return undefined; }
    const timer = setTimeout(() => {
      api(`/journal_entries?body=ilike.${pattern(t)}&select=${SEL}&order=day.desc&limit=100`).then(setFound).catch((e) => setError(`Search failed: ${e.message}`));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, rows]);

  const go = (next) => {
    if (next === day) return;
    if (dirty && !window.confirm('Your changes to this page are not saved. Leave it anyway?')) return;
    setError(''); setStatus(''); setOpenDay(next);
  };
  const save = async () => {
    const text = draft.text;
    if (!text.trim()) { setError(entry ? 'An empty page is not saved. To remove this page, press Delete page.' : 'Write something first.'); return; }
    setBusy(true);
    try {
      if (entry) await api(`/journal_entries?id=eq.${entry.id}`, { method: 'PATCH', body: { body: text }, prefer: 'return=minimal' });
      else await api('/journal_entries', { method: 'POST', body: { day, body: text }, prefer: 'return=minimal' });
      setDraft({ day, text, base: text }); setError(''); setStatus('Saved');
    } catch (e) { setError(`Not saved: ${e.message}`); setStatus(''); }
    await load().catch(() => {});
    setBusy(false);
  };
  const remove = async () => {
    if (!entry || !window.confirm(`Delete your page for ${longDay(day)}? The text cannot be brought back.`)) return;
    try {
      await api(`/journal_entries?id=eq.${entry.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      setDraft({ day, text: '', base: '' }); setError(''); setStatus('Deleted');
    } catch (e) { setError(`Could not delete: ${e.message}`); }
    load().catch(() => {});
  };

  const now = today();
  const list = found ?? rows;
  return (
    <div className="docs">
      <nav className="docs-list journal-list" aria-label="Your journal pages">
        <p className="docs-hint">Only you can read your journal. It is not in Weft search, and Weft's assistant does not read it.</p>
        <label className="visually-hidden" htmlFor="journal-search">Search your journal</label>
        <input id="journal-search" className="journal-search" type="search" placeholder="Search your journal" value={q} onChange={(e) => setQ(e.target.value)} />
        {!list ? <div className="skeleton" aria-label="Loading your pages"><span /><span /></div>
          : !list.length ? <p className="convo-empty">{found ? 'No page has those words.' : 'No pages yet. Write today’s.'}</p>
          : <ul aria-label={found ? `${list.length} ${list.length === 1 ? 'page' : 'pages'} found` : 'Pages, newest first'}>
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`doc-link journal-link${r.day === day ? ' is-active' : ''}`} aria-current={r.day === day ? 'page' : undefined} onClick={() => go(r.day)}>
                    <span className="journal-link-day">{r.day === now ? 'Today' : shortDay(r.day)}</span>
                    <span className="journal-link-line">{firstLine(r.body, 60)}</span>
                  </button>
                </li>
              ))}
            </ul>}
      </nav>
      <section className="docs-main">
        <header className="docs-head">
          <div className="journal-nav">
            <button className="btn btn--sm" type="button" onClick={() => go(addDays(day, -1))}>Previous day</button>
            <button className="btn btn--sm" type="button" onClick={() => go(addDays(day, 1))} disabled={day >= now}>Next day</button>
            <button className="btn btn--sm" type="button" onClick={() => go(now)} disabled={day === now}>Today</button>
            <label className="visually-hidden" htmlFor="journal-day">Go to a day</label>
            <input id="journal-day" className="journal-date" type="date" value={day} max={now} onChange={(e) => e.target.value && go(e.target.value)} />
          </div>
          <h2 className="docs-title journal-title">{longDay(day)}</h2>
          <p className="docs-meta">
            <span>{entry ? `Last saved ${new Date(entry.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'No page for this day yet'}</span>
            <span>Private to you</span>
          </p>
        </header>
        <div className="docs-links">
          <form className="journal-page" aria-label={`Your page for ${longDay(day)}`} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="visually-hidden" htmlFor="journal-text">What happened, what you thought</label>
            <textarea id="journal-text" className="journal-text" value={draft.day === day ? draft.text : ''} maxLength={MAX} rows={16}
              placeholder={day === now ? 'How was today?' : 'What happened that day?'} disabled={!rows}
              onChange={(e) => { setStatus(''); setDraft({ ...draft, day, text: e.target.value }); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }} />
            <div className="journal-actions">
              <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !dirty}>{entry ? 'Save' : 'Save page'}</button>
              {entry && <button className="btn btn--sm btn--danger" type="button" onClick={remove}>Delete page</button>}
              <span className="journal-status" role="status">{dirty ? 'Not saved yet' : status}</span>
              <span className="journal-count">{(draft.day === day ? draft.text : '').length.toLocaleString()} / {MAX.toLocaleString()}</span>
            </div>
            {error && <p className="send-error" role="alert">{error}</p>}
          </form>
        </div>
      </section>
    </div>
  );
}
