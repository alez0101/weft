// Kudos: a wall of thank-yous for each channel, newest first. Everyone in the channel reads it; editors and
// owners thank another member of the channel. You reword or delete your own kudos; owners of the channel can
// also delete any. Row-level security decides; when it says no, the reason is shown and the wall is
// reloaded. Live: any change to a kudos in the open channel refetches. The Home widget "Recent kudos" uses SEL.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export const SEL = 'id,space_id,message,created_at,updated_at,created_by,to_user,to:users!kudos_to_user_fkey(display_name),from:users!kudos_created_by_fkey(display_name)';
const TINTS = ['--p-mon', '--p-tue', '--p-wed', '--p-thu', '--p-fri', '--p-sat', '--p-sun'];
// The same person always gets the same colour on the wall.
const tintFor = (id) => TINTS[[...(id || '')].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % TINTS.length];
export const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
export const nameOf = (u) => u?.display_name || 'a former member';

function KudosForm({ people, initial, onSave, onCancel, label, idp, submit, withTo }) {
  const [f, setF] = useState(initial);
  const ok = f.message.trim() && (!withTo || f.to);
  return (
    <form className="link-form kudos-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      onSave(withTo ? { to_user: f.to, message: f.message.trim() } : { message: f.message.trim() }, () => setF({ to: '', message: '' }));
    }}>
      {withTo && <>
        <label htmlFor={`${idp}-to`}>For</label>
        <select id={`${idp}-to`} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required>
          <option value="">Choose someone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
        </select>
      </>}
      <label htmlFor={`${idp}-message`}>Thank you for</label>
      <textarea id={`${idp}-message`} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={500} rows={3} required
        placeholder="What they did, and why it helped" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Card({ k, me, owner, editable, editing, setEditing, change }) {
  const mine = k.created_by === me.id;
  const who = nameOf(k.to);
  if (editing === k.id) {
    return (
      <li className="kudos-card" style={{ '--kudos-tint': `var(${tintFor(k.to_user)})` }}>
        <p className="kudos-to">For {who}</p>
        <KudosForm initial={{ to: k.to_user, message: k.message }} label={`Edit your kudos for ${who}`} idp={`kudos-${k.id}`} submit="Save"
          onCancel={() => setEditing(null)}
          onSave={async (body) => { if (await change('That change was not saved', () => api(`/kudos?id=eq.${k.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null); }} />
      </li>
    );
  }
  return (
    <li className="kudos-card" style={{ '--kudos-tint': `var(${tintFor(k.to_user)})` }}>
      <p className="kudos-to">For {who}{k.to_user === me.id && <span className="kudos-you">you</span>}</p>
      <p className="kudos-message">{k.message}</p>
      <div className="link-foot kudos-foot">
        <span className="kudos-from">From {nameOf(k.from)}, {ago(k.created_at)}{k.updated_at > k.created_at ? ' (edited)' : ''}</span>
        {mine && editable && <button className="btn btn--sm" type="button" onClick={() => setEditing(k.id)}>Edit<span className="visually-hidden"> your kudos for {who}</span></button>}
        {((mine && editable) || owner) && <button className="btn btn--sm" type="button" onClick={() => {
          if (window.confirm(`Delete this kudos for ${who}? It is removed for everyone in the channel.`)) change('Could not delete', () => api(`/kudos?id=eq.${k.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
        }}>Delete<span className="visually-hidden"> kudos for {who} from {nameOf(k.from)}</span></button>}
      </div>
    </li>
  );
}

export default function Kudos({ me, spaces, members, notice, openId, setOpenId }) {
  const channels = spaces.filter((s) => s.kind === 'channel');
  const [data, setData] = useState({ id: null, rows: null }); // rows of the channel they were loaded for
  const rows = data.id === openId ? data.rows : null;
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const current = channels.find((c) => c.id === openId) || null;
  const role = current && members.find((m) => m.space_id === current.id && m.user?.id === me.id)?.role;
  const editable = role === 'owner' || role === 'editor';
  const owner = role === 'owner';
  const people = current ? members.filter((m) => m.space_id === current.id && m.user && m.user.id !== me.id).map((m) => m.user)
    .sort((a, b) => a.display_name.localeCompare(b.display_name)) : [];

  const load = useCallback(() => (openId ? api(`/kudos?space_id=eq.${openId}&select=${SEL}&order=created_at.desc&limit=200`).then((r) => setData({ id: openId, rows: r })) : Promise.resolve()), [openId]);
  useEffect(() => { setEditing(null); setError(''); load().catch((e) => setError(`Kudos could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if ((notice?.t === 'kudos' || notice?.t === 'members') && notice.space === openId) load().catch(() => {});
  }, [notice, openId, load]);
  // Open the first channel when none is chosen.
  useEffect(() => { if (!current && channels.length) setOpenId(channels[0].id); }, [current, channels, setOpenId]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const give = async (body, reset) => {
    if (await change('Not posted', () => api('/kudos', { method: 'POST', body: { ...body, space_id: current.id }, prefer: 'return=minimal' }))) reset();
  };

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Channels">
        <p className="docs-hint">Each channel has a wall of thank-yous. Everyone in the channel sees it.</p>
        {!channels.length ? <p className="convo-empty">You are not in any channels yet.</p> : (
          <ul>
            {channels.map((c) => (
              <li key={c.id}>
                <button className={`doc-link${c.id === openId ? ' is-active' : ''}`} aria-current={c.id === openId ? 'page' : undefined} onClick={() => setOpenId(c.id)}>#{c.name}</button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <section className="docs-main">
        {!current ? (
          <div className="empty"><h2>Pick a channel</h2><p>Kudos belong to channels. Everyone in the channel sees them; editors and owners give them.</p></div>
        ) : (<>
          <header className="docs-head">
            <h2 className="docs-title kudos-head">#{current.name}</h2>
            <p className="docs-meta"><span>{rows ? `${rows.length} ${rows.length === 1 ? 'thank-you' : 'thank-yous'}` : ''}</span><span>{editable ? 'You can give kudos here' : 'View only'}</span></p>
          </header>
          <div className="docs-links">
            <div className="links">
              {editable
                ? (people.length
                  ? <KudosForm key={current.id} people={people} initial={{ to: '', message: '' }} onSave={give} label="Give kudos" idp="kudos-new" submit="Give kudos" withTo />
                  : <p className="docs-hint">There is nobody else in this channel to thank yet.</p>)
                : <p className="docs-hint">You can read the kudos here. Ask an owner of the channel to make you an editor to give them.</p>}
              {error && <p className="send-error" role="alert">{error}</p>}
              {!rows ? <div className="skeleton" aria-label="Loading kudos"><span /><span /></div>
                : rows.length ? <ul className="kudos-wall" aria-label="Kudos, newest first">
                    {rows.map((k) => <Card key={k.id} k={k} me={me} owner={owner} editable={editable} editing={editing} setEditing={setEditing} change={change} />)}
                  </ul>
                : <p className="convo-empty">{editable ? 'No kudos yet. Thank someone for something they did.' : 'No kudos in this channel yet.'}</p>}
            </div>
          </div>
        </>)}
      </section>
    </div>
  );
}
