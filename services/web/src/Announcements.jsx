// Announcements: short notices pinned to a channel until they end. The app lists each channel's current
// and ended notices; editors and owners post, change, end early, show again and delete; viewers read.
// The same notices show at the top of the channel's chat (Pinned) and in the Home widget. Row-level
// security decides; when it says no, the reason is shown and the list is reloaded. Live: any change to
// an announcement refetches.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export const SEL = 'id,space_id,title,body,expires_at,created_at,author:users!announcements_created_by_fkey(display_name)';
const WEEK = 7 * 86400000;
// datetime-local works in local time, without seconds.
const toLocal = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
export const until = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const isCurrent = (a, now) => new Date(a.expires_at).getTime() > now;

// A clock that ticks every 30 seconds, so a notice disappears when it ends without a reload.
export function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  return now;
}

// The strip at the top of a channel's chat: its current notices, newest first.
export function Pinned({ spaceId, notice, onOpenAll }) {
  const [rows, setRows] = useState([]);
  const now = useNow();
  const load = useCallback(() => api(`/announcements?space_id=eq.${spaceId}&expires_at=gt.now&select=${SEL}&order=created_at.desc&limit=20`)
    .then(setRows).catch(() => setRows([])), [spaceId]);
  useEffect(() => { setRows([]); load(); }, [load]);
  useEffect(() => { if (notice?.t === 'announcements' && notice.space === spaceId) load(); }, [notice, spaceId, load]);
  const shown = rows.filter((a) => isCurrent(a, now));
  if (!shown.length) return null;
  return (
    <section className="pinned" aria-label="Announcements">
      {shown.slice(0, 2).map((a) => (
        <article key={a.id} className="pinned-note">
          <p className="pinned-title"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8.5v3l9 4V4.5zM13 7.5h1.5a2.5 2.5 0 0 1 0 5H13M6.5 12.5l1 4h2l-1-3.2" /></svg>{a.title}</p>
          {a.body && <p className="pinned-body">{a.body}</p>}
          <p className="pinned-meta">Until {until(a.expires_at)}{a.author?.display_name ? `, from ${a.author.display_name}` : ''}</p>
        </article>
      ))}
      <button type="button" className="link-btn pinned-all" onClick={onOpenAll}>
        {shown.length > 2 ? `${shown.length - 2} more in Announcements` : 'Open in Announcements'}
      </button>
    </section>
  );
}

function NoticeForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  return (
    <form className="link-form notice-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault();
      if (!f.title.trim() || !f.until) return;
      onSave({ title: f.title.trim(), body: f.body.trim(), expires_at: new Date(f.until).toISOString() }, () => setF({ title: '', body: '', until: toLocal(Date.now() + WEEK) }));
    }}>
      <label htmlFor={`${idp}-title`}>Title</label>
      <input id={`${idp}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} required autoComplete="off" placeholder="What everyone should know" />
      <label htmlFor={`${idp}-body`}>Text</label>
      <textarea id={`${idp}-body`} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={1000} rows={3} placeholder="Details (optional)" />
      <label htmlFor={`${idp}-until`}>Show until</label>
      <input id={`${idp}-until`} type="datetime-local" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} required />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!f.title.trim() || !f.until}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Notice({ a, editable, ended, editing, setEditing, change }) {
  if (editing === a.id) {
    return (
      <li className="link notice">
        <NoticeForm initial={{ title: a.title, body: a.body, until: toLocal(a.expires_at) }} label={`Edit ${a.title}`} idp={`notice-${a.id}`} submit="Save"
          onCancel={() => setEditing(null)}
          onSave={async (body) => { if (await change('That change was not saved', () => api(`/announcements?id=eq.${a.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null); }} />
      </li>
    );
  }
  const patch = (what, body) => change(what, () => api(`/announcements?id=eq.${a.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }));
  return (
    <li className={`link notice${ended ? ' is-ended' : ''}`}>
      <p className="notice-title">{a.title}</p>
      {a.body && <p className="link-note">{a.body}</p>}
      <div className="link-foot">
        <span className="notice-when">{ended ? `Ended ${until(a.expires_at)}` : `Showing until ${until(a.expires_at)}`}</span>
        <span className="link-by">{a.author?.display_name ? `Posted by ${a.author.display_name}` : ''}</span>
        {editable && <>
          <button className="btn btn--sm" type="button" onClick={() => setEditing(a.id)}>Edit<span className="visually-hidden"> {a.title}</span></button>
          {ended
            ? <button className="btn btn--sm" type="button" onClick={() => patch('Could not show it again', { expires_at: new Date(Date.now() + WEEK).toISOString() })}>Show for a week<span className="visually-hidden"> {a.title}</span></button>
            : <button className="btn btn--sm" type="button" onClick={() => patch('Could not end it', { expires_at: new Date().toISOString() })}>End now<span className="visually-hidden"> {a.title}</span></button>}
          <button className="btn btn--sm" type="button" onClick={() => {
            if (window.confirm(`Delete the announcement "${a.title}"? It is removed for everyone in the channel.`)) change('Could not delete', () => api(`/announcements?id=eq.${a.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
          }}>Delete<span className="visually-hidden"> {a.title}</span></button>
        </>}
      </div>
    </li>
  );
}

export default function Announcements({ me, spaces, members, notice, openId, setOpenId }) {
  const channels = spaces.filter((s) => s.kind === 'channel');
  const [counts, setCounts] = useState(null); // current notices per channel
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const now = useNow();
  const current = channels.find((c) => c.id === openId) || null;
  const role = current && members.find((m) => m.space_id === current.id && m.user?.id === me.id)?.role;
  const editable = role === 'owner' || role === 'editor';

  const loadCounts = useCallback(() => api('/announcements?expires_at=gt.now&select=space_id,expires_at&limit=1000')
    .then((r) => setCounts(r)).catch((e) => setError(`Announcements could not load: ${e.message}`)), []);
  const load = useCallback(() => (openId ? api(`/announcements?space_id=eq.${openId}&select=${SEL}&order=expires_at.desc&limit=60`).then(setRows) : Promise.resolve()), [openId]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { setRows(null); setAdding(false); setEditing(null); load().catch((e) => setError(`Announcements could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if (notice?.t !== 'announcements' && notice?.t !== 'members') return;
    loadCounts(); if (notice.space === openId) load().catch(() => {});
  }, [notice, openId, load, loadCounts]);
  // Open the first channel with something showing (or the first channel) when none is chosen.
  useEffect(() => {
    if (current || !channels.length || !counts) return;
    const busy = channels.find((c) => counts.some((x) => x.space_id === c.id));
    setOpenId((busy || channels[0]).id);
  }, [current, channels, counts, setOpenId]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {}); loadCounts();
    return ok;
  };
  const post = async (body, reset) => {
    if (await change('Not posted', () => api('/announcements', { method: 'POST', body: { ...body, space_id: current.id }, prefer: 'return=minimal' }))) { reset(); setAdding(false); }
  };

  const countIn = (id) => (counts || []).filter((x) => x.space_id === id && isCurrent(x, now)).length;
  const showing = (rows || []).filter((a) => isCurrent(a, now)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const ended = (rows || []).filter((a) => !isCurrent(a, now)).slice(0, 20);
  const item = (a, isEnded) => <Notice key={a.id} a={a} editable={editable} ended={isEnded} editing={editing} setEditing={setEditing} change={change} />;

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Channels">
        <p className="docs-hint">Notices pinned to a channel show at the top of its chat and on everyone's Home until they end.</p>
        {!channels.length ? <p className="convo-empty">You are not in any channels yet.</p> : (
          <ul>
            {channels.map((c) => {
              const n = countIn(c.id);
              return (
                <li key={c.id}>
                  <button className={`doc-link notice-channel${c.id === openId ? ' is-active' : ''}`} aria-current={c.id === openId ? 'page' : undefined} onClick={() => setOpenId(c.id)}>
                    <span>#{c.name}</span>{n > 0 && <span className="convo-count" aria-label={`${n} showing`}>{n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      <section className="docs-main">
        {!current ? (
          <div className="empty"><h2>Pick a channel</h2><p>Announcements belong to channels. Everyone in the channel sees them; editors and owners post them.</p></div>
        ) : (<>
          <header className="docs-head">
            <h2 className="docs-title notice-head">#{current.name}</h2>
            <p className="docs-meta"><span>{showing.length ? `${showing.length} showing` : 'Nothing showing'}</span><span>{editable ? 'You can post here' : 'View only'}</span></p>
          </header>
          <div className="docs-links">
            <div className="links">
              {editable ? (adding
                ? <NoticeForm initial={{ title: '', body: '', until: toLocal(Date.now() + WEEK) }} onSave={post} onCancel={() => setAdding(false)} label="New announcement" idp="notice-new" submit="Post" />
                : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>New announcement</button>
                    <p className="docs-hint">It shows until the time you choose, at most a year ahead. You can end it early.</p></div>)
                : <p className="docs-hint">You can read the announcements here. Ask an owner of the channel to make you an editor to post them.</p>}
              {error && <p className="send-error" role="alert">{error}</p>}
              {!rows ? <div className="skeleton" aria-label="Loading announcements"><span /><span /></div> : (<>
                <h3 className="notice-group">Showing now</h3>
                {showing.length ? <ul className="link-list" aria-label="Showing now">{showing.map((a) => item(a, false))}</ul>
                  : <p className="convo-empty">{editable ? 'Nothing is pinned to this channel. Post the first announcement above.' : 'Nothing is pinned to this channel.'}</p>}
                {ended.length > 0 && <>
                  <h3 className="notice-group">Ended</h3>
                  <ul className="link-list" aria-label="Ended">{ended.map((a) => item(a, true))}</ul>
                </>}
              </>)}
            </div>
          </div>
        </>)}
      </section>
    </div>
  );
}
