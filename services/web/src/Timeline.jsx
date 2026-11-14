// Timeline: milestones for each channel on a horizontal line, in date order, with today marked and past
// milestones greyed. Everyone in the channel reads it; editors and owners add, change and delete milestones.
// Row-level security decides; when it says no, the reason is shown and the timeline is reloaded. Live: any
// change to a milestone in the open channel refetches. The Home widget "Next milestones" uses SEL and when().
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { dayKey } from './TimeOff.jsx';

export const SEL = 'id,space_id,title,day,note,created_at,updated_at,created_by,by:users!milestones_created_by_fkey(display_name)';
export const longDay = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
// "today", "in 3 days", "2 weeks ago", from the person's own today.
export const when = (day, today) => {
  const d = Math.round((new Date(`${day}T12:00`) - new Date(`${today}T12:00`)) / 86400000);
  if (d === 0) return 'today';
  const n = Math.abs(d);
  const span = n === 1 ? '1 day' : n < 14 ? `${n} days` : n < 60 ? `${Math.round(n / 7)} weeks` : n < 730 ? `${Math.round(n / 30.4)} months` : `${Math.round(n / 365)} years`;
  return d > 0 ? `in ${span}` : `${span} ago`;
};

function MilestoneForm({ initial, onSave, onCancel, label, idp, submit }) {
  const [f, setF] = useState(initial);
  const ok = f.title.trim() && f.day;
  return (
    <form className="link-form tl-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      onSave({ title: f.title.trim(), day: f.day, note: f.note.trim() }, () => setF({ title: '', day: '', note: '' }));
    }}>
      <label htmlFor={`${idp}-title`}>Milestone</label>
      <input id={`${idp}-title`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} required placeholder="What happens, in a few words" />
      <label htmlFor={`${idp}-day`}>Date</label>
      <input id={`${idp}-day`} type="date" value={f.day} min="2000-01-01" max="2100-12-31" onChange={(e) => setF({ ...f, day: e.target.value })} required />
      <label htmlFor={`${idp}-note`}>Note</label>
      <textarea id={`${idp}-note`} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={300} rows={2} placeholder="Optional" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={!ok}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Stop({ m, today, editable, editing, setEditing, change }) {
  const state = m.day < today ? 'is-past' : m.day === today ? 'is-today' : 'is-future';
  const rel = when(m.day, today);
  return (
    <li className={`tl-stop ${state}${editing === m.id ? ' is-editing' : ''}`} data-id={m.id}>
      <p className="tl-date"><time dateTime={m.day}>{longDay(m.day)}</time></p>
      <span className="tl-dot" aria-hidden="true" />
      <div className="tl-card">
        {editing === m.id ? (
          <MilestoneForm initial={{ title: m.title, day: m.day, note: m.note || '' }} label={`Edit milestone ${m.title}`} idp={`tl-${m.id}`} submit="Save"
            onCancel={() => setEditing(null)}
            onSave={async (body) => { if (await change('That change was not saved', () => api(`/milestones?id=eq.${m.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }), m.id)) setEditing(null); }} />
        ) : (<>
          <p className="tl-title">{m.title}</p>
          <p className="tl-when">{state === 'is-past' ? <span className="visually-hidden">Past: </span> : null}{rel}</p>
          {m.note && <p className="tl-note">{m.note}</p>}
          {editable && <div className="link-foot tl-foot">
            <button className="btn btn--sm" type="button" onClick={() => setEditing(m.id)}>Edit<span className="visually-hidden"> {m.title}</span></button>
            <button className="btn btn--sm" type="button" onClick={() => {
              if (window.confirm(`Delete the milestone "${m.title}"? It is removed for everyone in the channel.`)) change('Could not delete', () => api(`/milestones?id=eq.${m.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
            }}>Delete<span className="visually-hidden"> {m.title}</span></button>
          </div>}
        </>)}
      </div>
    </li>
  );
}

export default function Timeline({ me, spaces, members, notice, openId, setOpenId }) {
  const channels = spaces.filter((s) => s.kind === 'channel');
  const [data, setData] = useState({ id: null, rows: null }); // rows of the channel they were loaded for
  const rows = data.id === openId ? data.rows : null;
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [today, setToday] = useState(() => dayKey(new Date()));
  const track = useRef(null);
  const [focus, setFocus] = useState({ id: null }); // what to bring into view: today (null) or a milestone you just added or changed
  const current = channels.find((c) => c.id === openId) || null;
  const role = current && members.find((m) => m.space_id === current.id && m.user?.id === me.id)?.role;
  const editable = role === 'owner' || role === 'editor';

  const load = useCallback(() => (openId ? api(`/milestones?space_id=eq.${openId}&select=${SEL}&order=day,created_at&limit=500`).then((r) => setData({ id: openId, rows: r })) : Promise.resolve()), [openId]);
  useEffect(() => { setEditing(null); setError(''); load().catch((e) => setError(`The timeline could not load: ${e.message}`)); }, [load]);
  useEffect(() => {
    if ((notice?.t === 'milestones' || notice?.t === 'members') && notice.space === openId) load().catch(() => {});
  }, [notice, openId, load]);
  // Open the first channel when none is chosen.
  useEffect(() => { if (!current && channels.length) setOpenId(channels[0].id); }, [current, channels, setOpenId]);
  // Today moves at midnight.
  useEffect(() => { const t = setInterval(() => setToday(dayKey(new Date())), 60000); return () => clearInterval(t); }, []);
  // Bring today into view when a channel's timeline first shows, and a milestone into view after you add or
  // change it (not on every live refresh, so someone else's change does not move your view).
  const shown = rows !== null;
  useEffect(() => { setFocus({ id: null }); }, [openId]);
  useEffect(() => {
    const el = track.current;
    const mark = el && (focus.id ? el.querySelector(`[data-id="${focus.id}"]`) : el.querySelector('.tl-today'));
    if (mark) el.scrollTo({ left: Math.max(0, mark.offsetLeft - el.clientWidth / 2 + mark.offsetWidth / 2) });
  }, [shown, openId, focus]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run, id) => {
    let ok = false;
    try { const r = await run(); setError(''); ok = true; id = id || r?.[0]?.id; } catch (e) { setError(`${what}: ${e.message}`); }
    await load().catch(() => {});
    if (ok && id) setFocus({ id });
    return ok;
  };
  const add = async (body, reset) => {
    if (await change('Not added', () => api('/milestones?select=id', { method: 'POST', body: { ...body, space_id: current.id }, prefer: 'return=representation' }))) reset();
  };

  // The today marker goes before the first milestone that is today or later.
  const cut = rows ? rows.findIndex((m) => m.day >= today) : -1;
  const at = cut === -1 ? (rows?.length || 0) : cut;
  const past = rows ? rows.filter((m) => m.day < today).length : 0;
  const next = rows?.[at];

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Channels">
        <p className="docs-hint">Each channel has one timeline of milestones. Everyone in the channel sees it.</p>
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
          <div className="empty"><h2>Pick a channel</h2><p>Milestones belong to channels. Everyone in the channel sees them; editors and owners add them.</p></div>
        ) : (<>
          <header className="docs-head tl-headbox">
            <h2 className="docs-title tl-head">#{current.name}</h2>
            <p className="docs-meta">
              <span>{rows ? `${rows.length} ${rows.length === 1 ? 'milestone' : 'milestones'}${rows.length ? `, ${past} past` : ''}` : ''}</span>
              {next && <span className="tl-next">Next: {next.title}, {when(next.day, today)}</span>}
              <span>{editable ? 'You can add and change milestones here' : 'View only'}</span>
            </p>
          </header>
          <div className="tl-wrap">
            {error && <p className="send-error" role="alert">{error}</p>}
            {!rows ? <div className="skeleton" aria-label="Loading the timeline"><span /><span /></div>
              : rows.length ? (
                <div className="tl-scroll" ref={track} tabIndex={0} role="region" aria-label={`Timeline of #${current.name}, oldest first`}>
                  <ol className="tl-track">
                    {rows.slice(0, at).map((m) => <Stop key={m.id} m={m} today={today} editable={editable} editing={editing} setEditing={setEditing} change={change} />)}
                    <li className="tl-today" aria-label={`Today, ${longDay(today)}`}>
                      <p className="tl-date">Today</p>
                      <span className="tl-today-line" aria-hidden="true" />
                      <p className="tl-today-day">{longDay(today)}</p>
                    </li>
                    {rows.slice(at).map((m) => <Stop key={m.id} m={m} today={today} editable={editable} editing={editing} setEditing={setEditing} change={change} />)}
                  </ol>
                </div>
              )
              : <p className="convo-empty tl-empty">{editable ? 'No milestones yet. Add the first one below: a launch, a deadline, the day the doors open.' : 'No milestones in this channel yet.'}</p>}
            <div className="tl-below">
              {editable
                ? <MilestoneForm key={current.id} initial={{ title: '', day: '', note: '' }} onSave={add} label="Add a milestone" idp="tl-new" submit="Add milestone" />
                : <p className="docs-hint">You can read the timeline here. Ask an owner of the channel to make you an editor to add milestones.</p>}
            </div>
          </div>
        </>)}
      </section>
    </div>
  );
}
