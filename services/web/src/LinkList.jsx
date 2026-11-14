// A link list: useful links with a title, a note and tags. Weft stores the address and never fetches the
// page. Editors add, change and delete; viewers read. Row-level security decides; when it says no, the
// reason is shown and the list is reloaded. Live: any change to this list's links refetches it.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const EMPTY = { url: '', title: '', note: '', tags: '' };
// "example.org/page" becomes "https://example.org/page"; anything that is not http(s) stays as typed
// (the database refuses it, and the reason is shown).
const fixUrl = (s) => { const v = s.trim(); return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : v ? `https://${v}` : ''; };
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
const safe = (url) => /^https?:\/\//i.test(url);
const splitTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);

function LinkForm({ initial, onSave, onCancel, label, idp, submit: submitLabel }) {
  const [f, setF] = useState(initial);
  const submit = (e) => {
    e.preventDefault();
    const url = fixUrl(f.url);
    if (!url) return;
    onSave({ url, title: f.title.trim() || hostOf(url), note: f.note.trim(), tags: splitTags(f.tags) }, () => setF(EMPTY));
  };
  return (
    <form className="link-form" onSubmit={submit} aria-label={label}>
      <label htmlFor={`${idp}-url`}>Address</label>
      <input id={`${idp}-url`} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" maxLength={2000} inputMode="url" autoComplete="off" required />
      <label htmlFor={`${idp}-title`}>Title</label>
      <input id={`${idp}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="The site's name if left empty" maxLength={200} />
      <label htmlFor={`${idp}-note`}>Note</label>
      <textarea id={`${idp}-note`} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="What it is for, when to use it" maxLength={1000} rows={2} />
      <label htmlFor={`${idp}-tags`}>Tags</label>
      <input id={`${idp}-tags`} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="Separated by commas" maxLength={400} />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.url.trim()}>{submitLabel}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function LinkList({ item, editable, notice }) {
  const [links, setLinks] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => api(`/links?list_id=eq.${item.id}&select=id,url,title,note,tags,position,created_at,author:users!links_created_by_fkey(display_name)&order=position,created_at`)
    .then((r) => { setLinks(r); }), [item.id]);
  useEffect(() => { load().catch((e) => setError(`The list could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'links' && notice.list === item.id) load().catch(() => {}); }, [notice, item.id, load]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const add = async (body, reset) => {
    const position = Math.max(-1, ...(links || []).map((l) => l.position)) + 1;
    if (await change('Could not add the link', () => api('/links', { method: 'POST', body: { ...body, list_id: item.id, position }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };
  const save = async (l, body) => {
    if (await change('That change was not saved', () => api(`/links?id=eq.${l.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null);
  };
  const remove = (l) => {
    if (!window.confirm(`Delete the link "${l.title}"? Everyone who can see this list loses it.`)) return;
    change('Could not delete', () => api(`/links?id=eq.${l.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!links) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading the list"><span /><span /><span /></div>;
  const allTags = [...new Set(links.flatMap((l) => l.tags))].sort();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = links.filter((l) => (!tag || l.tags.includes(tag))
    && words.every((w) => `${l.title} ${l.url} ${l.note} ${l.tags.join(' ')}`.toLowerCase().includes(w)));

  return (
    <div className="links">
      {editable ? (adding
        ? <LinkForm initial={EMPTY} onSave={add} onCancel={() => setAdding(false)} label="Add a link" idp="link-new" submit="Add link" />
        : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add a link</button>
            <p className="docs-hint">Weft keeps the address, title, note and tags. It never opens the page itself.</p></div>)
        : <p className="docs-hint">You can read and open these links. Ask an owner of the space to make you an editor to add or change them.</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {links.length > 0 && (
        <div className="links-filters">
          <label className="visually-hidden" htmlFor="links-find">Filter links</label>
          <input id="links-find" type="search" placeholder="Filter links" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="task-count" role="status">{shown.length === links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : `${shown.length} of ${links.length}`}</span>
        </div>
      )}
      {allTags.length > 0 && (
        <div className="links-tags" role="group" aria-label="Show only one tag">
          {allTags.map((t) => <button key={t} type="button" className="link-tag" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>)}
          {tag && <button type="button" className="btn btn--sm" onClick={() => setTag('')}>Show all</button>}
        </div>
      )}
      {!links.length ? <p className="convo-empty">{editable ? 'No links yet. Add the first one above.' : 'No links yet.'}</p>
        : !shown.length ? <p className="convo-empty">No links match.</p> : (
        <ul className="link-list" aria-label="Links">
          {shown.map((l) => (
            <li key={l.id} className="link">
              {editing === l.id ? (
                <LinkForm initial={{ url: l.url, title: l.title, note: l.note, tags: l.tags.join(', ') }} onSave={(b) => save(l, b)} onCancel={() => setEditing(null)} label={`Edit ${l.title}`} idp={`link-${l.id}`} submit="Save" />
              ) : (<>
                <div className="link-head">
                  {safe(l.url) ? <a className="link-title" href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.title}</a> : <span className="link-title">{l.title}</span>}
                  <span className="link-host">{hostOf(l.url)}</span>
                </div>
                {l.note && <p className="link-note">{l.note}</p>}
                <div className="link-foot">
                  {l.tags.map((t) => <button key={t} type="button" className="link-tag" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>{t}</button>)}
                  <span className="link-by">{l.author?.display_name ? `Added by ${l.author.display_name}` : ''}</span>
                  {editable && <>
                    <button className="btn btn--sm" type="button" onClick={() => setEditing(l.id)}>Edit<span className="visually-hidden"> {l.title}</span></button>
                    <button className="btn btn--sm" type="button" onClick={() => remove(l)}>Delete<span className="visually-hidden"> {l.title}</span></button>
                  </>}
                </div>
              </>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
