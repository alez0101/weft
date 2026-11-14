// Shift sign-up: time slots with a number of places that members claim and give back. The left picks what
// to show (all upcoming, still open, your shifts) and a channel; the right lists the shifts by day, each with
// who is on it and how many places are open. Every member, viewers included, takes or gives back their own
// place; editors and owners add, change and delete shifts and can take someone off. The database refuses a
// claim on a full or ended shift, and its answer is shown as it is. Live: a shifts or shift_signups notice
// refetches.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const SEL = 'id,space_id,title,starts_at,ends_at,places,note,signups:shift_signups(id,user_id,created_at,who:users!shift_signups_user_id_fkey(display_name))';
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const timeKey = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
const at = (day, time) => new Date(`${day}T${time}`);
const addDays = (day, n) => { const x = new Date(`${day}T12:00`); x.setDate(x.getDate() + n); return dayKey(x); };
const dayLabel = (d) => new Date(d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
const t = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const shiftSpan = (a, b) => (dayKey(a) === dayKey(b) ? `${t(a)} to ${t(b)}`
  : `${t(a)} to ${new Date(b).toLocaleDateString([], { weekday: 'short' })} ${t(b)}`);
const MAX_DOTS = 24;   // places drawn one by one up to this; more are only counted

// New or changed shift. An end time at or before the start means the shift ends the next day.
function ShiftForm({ initial, channels, onSave, onCancel, idp, label, submit }) {
  const [f, setF] = useState(initial);
  const start = at(f.day, f.from);
  let end = at(f.day, f.to); if (end <= start) end = at(addDays(f.day, 1), f.to);
  const overnight = dayKey(end) !== f.day;
  const places = Number(f.places);
  const bad = !f.title.trim() || !(places >= 1 && places <= 200);
  return (
    <form className="link-form shift-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault(); if (bad) return;
      onSave({ ...(channels ? { space_id: f.space } : {}), title: f.title.trim(), starts_at: start.toISOString(), ends_at: end.toISOString(), places, note: f.note.trim() });
    }}>
      {channels && <>
        <label htmlFor={`${idp}-space`}>Channel</label>
        <select id={`${idp}-space`} value={f.space} onChange={(e) => setF({ ...f, space: e.target.value })}>
          {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </>}
      <label htmlFor={`${idp}-title`}>Shift</label>
      <input id={`${idp}-title`} value={f.title} maxLength={80} required autoComplete="off" placeholder="Bar, gate, set-up…" onChange={(e) => setF({ ...f, title: e.target.value })} />
      <label htmlFor={`${idp}-day`}>Day</label>
      <input id={`${idp}-day`} type="date" value={f.day} required onChange={(e) => e.target.value && setF({ ...f, day: e.target.value })} />
      <label htmlFor={`${idp}-from`}>From</label>
      <span className="pair">
        <input id={`${idp}-from`} type="time" value={f.from} required step={900} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <label htmlFor={`${idp}-to`}>to</label>
        <input id={`${idp}-to`} type="time" value={f.to} required step={900} onChange={(e) => setF({ ...f, to: e.target.value })} />
        {overnight && <span className="shift-hint">ends the next day</span>}
      </span>
      <label htmlFor={`${idp}-places`}>Places</label>
      <input id={`${idp}-places`} className="shift-places-input" type="number" min={1} max={200} required value={f.places} onChange={(e) => setF({ ...f, places: e.target.value })} />
      <label htmlFor={`${idp}-note`}>Note</label>
      <input id={`${idp}-note`} value={f.note} maxLength={500} autoComplete="off" placeholder="Where to meet, what to bring (optional)" onChange={(e) => setF({ ...f, note: e.target.value })} />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={bad}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// The places as a row of dots: taken ones filled (yours marked), open ones hollow.
function Places({ shift, me }) {
  const n = shift.signups.length; const open = Math.max(0, shift.places - n);
  const mine = shift.signups.some((s) => s.user_id === me.id);
  const dots = shift.places <= MAX_DOTS ? Array.from({ length: shift.places }, (_, i) => (i < n ? (mine && i === 0 ? 'mine' : 'taken') : 'open')) : null;
  return (
    <div className="shift-places">
      {dots && <span className="shift-dots" aria-hidden="true">{dots.map((d, i) => <span key={i} className={`shift-dot is-${d}`} />)}</span>}
      <span className={`shift-count${open === 0 ? ' is-full' : ''}`}>{open === 0 ? `Full, ${n} of ${shift.places}` : `${open} of ${shift.places} open`}</span>
    </div>
  );
}

function Shift({ s, me, ended, canEdit, error, act, editing, setEditing }) {
  const mine = s.signups.find((x) => x.user_id === me.id);
  const full = s.signups.length >= s.places;
  // You first, then the others in the order they signed up.
  const people = [...s.signups].sort((a, b) => (a.user_id === me.id ? -1 : b.user_id === me.id ? 1 : a.created_at.localeCompare(b.created_at)));
  const name = (x) => (x.user_id === me.id ? 'You' : x.who?.display_name || 'Someone');
  if (editing === s.id) {
    return (
      <li className="link shift">
        <ShiftForm idp={`sh-${s.id}`} label="Change shift" submit="Save" onCancel={() => setEditing(null)}
          initial={{ title: s.title, day: dayKey(s.starts_at), from: timeKey(s.starts_at), to: timeKey(s.ends_at), places: String(s.places), note: s.note }}
          onSave={async (body) => { if (await act(s.id, 'That change was not saved', () => api(`/shifts?id=eq.${s.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null); }} />
        {error && <p className="send-error" role="alert">{error}</p>}
      </li>
    );
  }
  return (
    <li className={`link shift${mine ? ' is-mine' : ''}${full ? ' is-full' : ''}${ended ? ' is-ended' : ''}`} aria-label={`${s.title}, ${shiftSpan(s.starts_at, s.ends_at)}`}>
      <div className="link-head">
        <h4 className="shift-title">{s.title}</h4>
        <span className="shift-when">{shiftSpan(s.starts_at, s.ends_at)}</span>
        <span className="link-by">{s.channel}</span>
      </div>
      {s.note && <p className="link-note">{s.note}</p>}
      <Places shift={s} me={me} />
      <p className="shift-who">
        {people.length ? <><span className="shift-who-label">On this shift:</span>{' '}
          {people.map((x, i) => (
            <span key={x.id} className="shift-person">
              {name(x)}
              {canEdit && !ended && x.user_id !== me.id && (
                <button type="button" className="shift-off" aria-label={`Take ${name(x)} off ${s.title}`} title="Take off this shift"
                  onClick={() => { if (window.confirm(`Take ${name(x)} off "${s.title}"?`)) act(s.id, 'Could not take them off', () => api(`/shift_signups?id=eq.${x.id}`, { method: 'DELETE', prefer: 'return=minimal' })); }}>×</button>
              )}
              {i < people.length - 1 ? ', ' : ''}
            </span>
          ))}</> : <span className="shift-nobody">Nobody yet.</span>}
      </p>
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="link-foot">
        {ended ? <span className="shift-hint">This shift has ended.</span>
          : mine ? <button className="btn btn--sm" type="button" onClick={() => act(s.id, 'Your place was not given back', () => api(`/shift_signups?id=eq.${mine.id}`, { method: 'DELETE', prefer: 'return=minimal' }))}>
              Give back my place<span className="visually-hidden"> on {s.title}</span></button>
          : <button className="btn btn--primary btn--sm" type="button" disabled={full} onClick={() => act(s.id, 'You were not signed up', () => api('/shift_signups', { method: 'POST', body: { shift_id: s.id }, prefer: 'return=minimal' }))}>
              {full ? 'Full' : 'Take a place'}<span className="visually-hidden"> on {s.title}</span></button>}
        {mine && !ended && <span className="shift-hint shift-yours">You are on this shift</span>}
        {canEdit && !ended && <span className="shift-admin">
          <button className="btn btn--sm" type="button" onClick={() => setEditing(s.id)}>Change<span className="visually-hidden"> {s.title}</span></button>
          <button className="btn btn--sm" type="button" onClick={() => {
            if (window.confirm(`Delete the shift "${s.title}"${s.signups.length ? ` and its ${s.signups.length} sign-up${s.signups.length > 1 ? 's' : ''}` : ''}?`)) act(s.id, 'Could not delete', () => api(`/shifts?id=eq.${s.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
          }}>Delete<span className="visually-hidden"> {s.title}</span></button>
        </span>}
      </div>
    </li>
  );
}

const FILTERS = [
  { id: 'all', label: 'All upcoming', test: () => true },
  { id: 'open', label: 'Still open', test: (s) => s.signups.length < s.places },
  { id: 'mine', label: 'Your shifts', test: (s, me) => s.signups.some((x) => x.user_id === me.id) },
];

export default function Shifts({ me, spaces, members, notice }) {
  const channels = useMemo(() => spaces.filter((s) => s.kind === 'channel'), [spaces]);
  const role = useCallback((sid) => members.find((m) => m.space_id === sid && m.user?.id === me.id)?.role, [members, me.id]);
  const canEdit = (sid) => ['owner', 'editor'].includes(role(sid));
  const [shifts, setShifts] = useState(null);
  const [filter, setFilter] = useState('all');
  const [channel, setChannel] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');

  // Shifts that have not ended, plus the last day's ended ones (shown greyed, so a just-finished shift
  // does not vanish mid-glance).
  const load = useCallback(() => api(`/shifts?ends_at=gt.${new Date(Date.now() - 86400000).toISOString()}&select=${SEL}&order=starts_at,title&limit=500`)
    .then((r) => { setShifts(r); setError(''); }), []);
  useEffect(() => { load().catch((e) => setError(`Shifts could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (['shifts', 'shift_signups', 'members'].includes(notice?.t)) load().catch(() => {}); }, [notice, load]);
  useEffect(() => { setErrors({}); }, [editing]);   // opening or closing a form starts without an old error

  const act = async (id, what, run) => {
    let ok = false;
    try { await run(); setErrors((m) => ({ ...m, [id]: '' })); ok = true; } catch (e) { setErrors((m) => ({ ...m, [id]: `${what}: ${e.message}` })); }
    load().catch(() => {});
    return ok;
  };
  const editableChannels = channels.filter((c) => canEdit(c.id));
  const add = async (body) => {
    try { await api('/shifts', { method: 'POST', body, prefer: 'return=minimal' }); setAdding(false); setError(''); await load(); }
    catch (e) { setError(`Not added: ${e.message}`); }
  };
  const newDefault = () => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const space = (channel && canEdit(channel) ? channel : editableChannels[0]?.id) || '';
    return { space, title: '', day: dayKey(d), from: '10:00', to: '14:00', places: '2', note: '' };
  };

  const now = Date.now();
  const chName = (sid) => channels.find((c) => c.id === sid)?.name;
  const all = (shifts || []).filter((s) => chName(s.space_id) !== undefined).map((s) => ({ ...s, channel: `#${chName(s.space_id)}` }));
  const inChannel = all.filter((s) => !channel || s.space_id === channel);
  const upcoming = inChannel.filter((s) => new Date(s.ends_at).getTime() > now);
  const f = FILTERS.find((x) => x.id === filter);
  const shown = inChannel.filter((s) => f.test(s, me) && (filter === 'all' || new Date(s.ends_at).getTime() > now));
  const days = [];
  for (const s of shown) {
    const d = dayKey(s.starts_at);
    if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, shifts: [] });
    days[days.length - 1].shifts.push(s);
  }
  const openPlaces = upcoming.reduce((n, s) => n + Math.max(0, s.places - s.signups.length), 0);
  const mineCount = upcoming.filter((s) => s.signups.some((x) => x.user_id === me.id)).length;
  const withShifts = channels.filter((c) => all.some((s) => s.space_id === c.id));

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Show shifts">
        <p className="docs-hint">Take a place on a shift, or give it back. Everyone in the channel sees who is on each one.</p>
        <ul>
          {FILTERS.map((x) => {
            const n = upcoming.filter((s) => x.test(s, me)).length;
            return (
              <li key={x.id}>
                <button type="button" className={`doc-link rsvp-filter${x.id === filter ? ' is-active' : ''}`} aria-current={x.id === filter ? 'page' : undefined} onClick={() => setFilter(x.id)}>
                  <span>{x.label}</span>{shifts && <span className="convo-count" aria-label={`${n} shifts`}>{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {withShifts.length > 1 && <>
          <p className="tree-group">Channel</p>
          <ul>
            {[{ id: '', name: null }, ...withShifts].map((c) => (
              <li key={c.id || 'all'}><button type="button" className={`doc-link${channel === c.id ? ' is-active' : ''}`} aria-current={channel === c.id ? 'page' : undefined}
                onClick={() => setChannel(c.id)}>{c.name ? `#${c.name}` : 'All channels'}</button></li>
            ))}
          </ul>
        </>}
      </nav>
      <section className="docs-main">
        <header className="docs-head">
          <h2 className="docs-title shift-head">{filter === 'all' ? 'Upcoming shifts' : f.label}{channel ? ` in #${chName(channel)}` : ''}</h2>
          <p className="docs-meta"><span>{upcoming.length} upcoming</span><span>{openPlaces === 1 ? '1 open place' : `${openPlaces} open places`}</span>
            <span>{mineCount ? `You are on ${mineCount}` : 'You are not on any yet'}</span></p>
        </header>
        <div className="docs-links">
          <div className="links">
            {editableChannels.length > 0 && (adding
              ? <ShiftForm idp="sh-new" label="New shift" submit="Add shift" channels={editableChannels} initial={newDefault()} onSave={add} onCancel={() => setAdding(false)} />
              : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>New shift</button>
                  <p className="docs-hint">Set how many people each shift needs; members sign themselves up.</p></div>)}
            {error && <p className="send-error" role="alert">{error}</p>}
            {!shifts ? <div className="skeleton" aria-label="Loading shifts"><span /><span /></div>
              : !shown.length ? <p className="convo-empty">{!upcoming.length ? (editableChannels.length ? 'No shifts coming up. Add the first one above.' : 'No shifts coming up in your channels.')
                : filter === 'open' ? 'Every upcoming shift is full.' : filter === 'mine' ? 'You are not on any upcoming shift. Pick one under Still open.' : 'No shifts here.'}</p>
              : days.map((d) => (
                <section key={d.day} className="rsvp-day" aria-label={dayLabel(at(d.day, '12:00'))}>
                  <h3 className="notice-group">{dayLabel(at(d.day, '12:00'))}</h3>
                  <ul className="link-list">
                    {d.shifts.map((s) => <Shift key={s.id} s={s} me={me} ended={new Date(s.ends_at).getTime() <= now} canEdit={canEdit(s.space_id)}
                      error={errors[s.id]} act={act} editing={editing} setEditing={setEditing} />)}
                  </ul>
                </section>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}
