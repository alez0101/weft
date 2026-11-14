// A glossary: the words a space uses (abbreviations, nicknames, jargon) and what each means, A to Z under
// letter headings, with a find box over terms and definitions. Editors add, change and delete; viewers read.
// Row-level security decides; when it says no (a term already defined, for example), the reason is shown
// and the glossary is reloaded. Live: any change to this glossary's terms refetches it. Weft reads the
// glossary (its text summary) when answering questions in the space.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const EMPTY = { term: '', definition: '' };
// The letter a term is filed under: its first letter without accents, or # for digits and symbols.
const letterOf = (t) => {
  const c = t.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
};

function TermForm({ initial, onSave, onCancel, label, idp, submit: submitLabel }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ready = f.term.trim() && f.definition.trim();
  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    onSave({ term: f.term.trim(), definition: f.definition.trim() }, () => setF(EMPTY));
  };
  return (
    <form className="link-form" onSubmit={submit} aria-label={label} noValidate>
      <label htmlFor={`${idp}-term`}>Term</label>
      <input id={`${idp}-term`} value={f.term} onChange={set('term')} maxLength={80} autoComplete="off" placeholder="FOH" required />
      <label htmlFor={`${idp}-def`}>Meaning</label>
      <textarea id={`${idp}-def`} value={f.definition} onChange={set('definition')} maxLength={2000} rows={3} required
        placeholder="Front of house: everything the audience sees, from the gate to the bar." />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ready}>{submitLabel}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function Glossary({ item, editable, notice }) {
  const [terms, setTerms] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api(`/glossary_terms?glossary_id=eq.${item.id}&select=id,term,definition,created_at,author:users!glossary_terms_created_by_fkey(display_name)&order=term`)
    .then((r) => { setTerms(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The glossary could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'glossary' && notice.glossary === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const add = async (body, reset) => {
    if (await change('Could not add the term', () => api('/glossary_terms', { method: 'POST', body: { ...body, glossary_id: item.id }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };
  const save = async (t, body) => {
    if (await change('That change was not saved', () => api(`/glossary_terms?id=eq.${t.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const remove = (t) => {
    if (!window.confirm(`Delete "${t.term}"? Everyone who can see this glossary loses it.`)) return;
    change('Could not delete', () => api(`/glossary_terms?id=eq.${t.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!terms) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the glossary"><span /><span /><span /></div>;
  const sorted = [...terms].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base', numeric: true }));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sorted.filter((t) => words.every((w) => `${t.term} ${t.definition}`.toLowerCase().includes(w)));
  const groups = [];
  for (const t of shown) {
    const l = letterOf(t.term);
    if (groups.at(-1)?.letter !== l) groups.push({ letter: l, terms: [] });
    groups.at(-1).terms.push(t);
  }

  return (
    <div className="links glossary">
      {editable ? (adding
        ? <TermForm initial={EMPTY} onSave={add} onCancel={() => setAdding(false)} label="Add a term" idp="glossary-new" submit="Add term" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a term</button>
            <p className="docs-hint">Weft uses these meanings when it answers questions in this space.</p></div>)
        : <p className="docs-hint">You can read this glossary. Ask an owner of the space to make you an editor to add or change terms.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {terms.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="glossary-find">Find a term</label>
          <input id="glossary-find" type="search" placeholder="Find a word or what it means…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="task-count" role="status">{shown.length === terms.length ? `${terms.length} term${terms.length === 1 ? '' : 's'}` : `${shown.length} of ${terms.length}`}</span>
        </div>
      )}
      {!words.length && groups.length > 1 && (
        <nav className="glossary-index" aria-label="Jump to a letter">
          {groups.map((g) => <a key={g.letter} href={`#glossary-${item.id}-${g.letter === '#' ? 'num' : g.letter}`}
            onClick={(e) => { e.preventDefault(); document.getElementById(e.currentTarget.hash.slice(1))?.scrollIntoView({ block: 'start' }); }}>{g.letter}</a>)}
        </nav>
      )}
      {!terms.length ? <p className="convo-empty">{editable ? 'No terms yet. Add the first word a newcomer would ask about.' : 'No terms yet.'}</p>
        : !shown.length ? <p className="convo-empty">No terms match.</p> : (
        <div className="glossary-groups">
          {groups.map((g) => (
            <section key={g.letter} className="glossary-group" aria-labelledby={`glossary-${item.id}-${g.letter === '#' ? 'num' : g.letter}`}>
              <h3 className="glossary-letter" id={`glossary-${item.id}-${g.letter === '#' ? 'num' : g.letter}`}>{g.letter}</h3>
              <ul className="link-list glossary-list" aria-label={`Terms under ${g.letter}`}>
                {g.terms.map((t) => (
                  <li key={t.id} className="link glossary-entry">
                    {editing === t.id ? (
                      <TermForm initial={{ term: t.term, definition: t.definition }} onSave={(b) => save(t, b)} onCancel={() => setEditing(null)} label={`Edit ${t.term}`} idp={`glossary-${t.id}`} submit="Save" />
                    ) : (<>
                      <dfn className="glossary-term">{t.term}</dfn>
                      <p className="glossary-def">{t.definition}</p>
                      <div className="link-foot">
                        <span className="link-by">{t.author?.display_name ? `Added by ${t.author.display_name}` : ''}</span>
                        {editable && <>
                          <button className="btn btn--sm" type="button" onClick={() => setEditing(t.id)}>Edit<span className="visually-hidden"> {t.term}</span></button>
                          <button className="btn btn--sm" type="button" onClick={() => remove(t)}>Delete<span className="visually-hidden"> {t.term}</span></button>
                        </>}
                      </div>
                    </>)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
