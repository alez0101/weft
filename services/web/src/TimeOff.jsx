// Time off: who in a channel is away when, in whole days. The left picks a channel (or all of them); the
// right shows one week as a grid (a row per person away, a column per day), a form to add time off, and
// the list of time off now and coming up. Every member, viewers included, adds, changes and removes their
// own; editors and owners can do so for anyone in the channel. The database's answer is shown as it is.
// Time off also shows on the Calendar and in the Home widget "Out this week". Live: a time_off notice
// (or a members one) refetches.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const SEL = 'id,space_id,user_id,starts_on,ends_on,note,created_by,who:users!time_off_user_id_fkey(display_name)';
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
export const addDays = (day, n) => { const x = new Date(`${day}T12:00`); x.setDate(x.getDate() + n); return dayKey(x); };
// The Monday of the week a day is in.
export const weekStart = (day) => { const x = new Date(`${day}T12:00`); return addDays(day, -((x.getDay() + 6) % 7)); };
const short = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const dow = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { weekday: 'short' });
const dnum = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { day: 'numeric' });
// "Mon, Nov 16" or "Mon, Nov 16 to Fri, Nov 20".
export const daysLabel = (a, b) => (a === b ? short(a) : `${short(a)} to ${short(b)}`);
const count = (a, b) => Math.round((new Date(`${b}T12:00`) - new Date(`${a}T12:00`)) / 86400000) + 1;

function AwayForm({ initial, channels, people, onSave, onCancel, idp, label, submit }) {
  const [f, setF] = useState(initial);
  const who = channels ? people(f.space) : null;
  const bad = !f.from || !f.to || f.to < f.from || (channels && !f.space);
  return (
    <form className="link-form away-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault(); if (bad) return;
      onSave({ ...(channels ? { space_id: f.space, user_id: f.user } : {}), starts_on: f.from, ends_on: f.to, note: f.note.trim() });
    }}>
      {channels && <>
        <label htmlFor={`${idp}-space`}>Channel</label>
        <select id={`${idp}-space`} value={f.space} onChange={(e) => setF({ ...f, space: e.target.value, user: initial.user })}>
          {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
        <label htmlFor={`${idp}-who`}>Who</label>
        {who.length > 1
          ? <select id={`${idp}-who`} value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })}>
              {who.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          : <span id={`${idp}-who`} className="away-me">{who[0]?.label ?? 'You'}</span>}
      </>}
      <label htmlFor={`${idp}-from`}>From</label>
      <span className="pair">
        <input id={`${idp}-from`} type="date" value={f.from} required onChange={(e) => setF({ ...f, from: e.target.value, to: f.to && f.to < e.target.value ? e.target.value : f.to })} />
        <label htmlFor={`${idp}-to`}>to</label>
        <input id={`${idp}-to`} type="date" value={f.to} min={f.from} required onChange={(e) => setF({ ...f, to: e.target.value })} />
        {f.from && f.to && f.to >= f.from && <span className="shift-hint">{count(f.from, f.to) === 1 ? '1 day' : `${count(f.from, f.to)} days`}</span>}
      </span>
      <label htmlFor={`${idp}-note`}>Note</label>
      <input id={`${idp}-note`} value={f.note} maxLength={200} autoComplete="off" placeholder="Holiday, sick, at a conference… (optional)" onChange={(e) => setF({ ...f, note: e.target.value })} />
      {f.to && f.from && f.to < f.from && <p className="booking-warn" role="status">The last day must be on or after the first.</p>}
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={bad}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// One week: a row per person away at some point in it, a cell per day, filled on days they are away.
function Week({ start, rows, me, chName }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const end = days[6];
  const today = dayKey(new Date());
  const inWeek = rows.filter((r) => r.starts_on <= end && r.ends_on >= start);
  const people = [];
  for (const r of inWeek) {
    let p = people.find((x) => x.id === r.user_id);
    if (!p) { p = { id: r.user_id, name: r.user_id === me.id ? 'You' : r.who?.display_name || 'Someone', rows: [] }; people.push(p); }
    p.rows.push(r);
  }
  people.sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));
  return (
    <div className="away-week">
      <table className="away-grid">
        <caption className="visually-hidden">Who is away, {daysLabel(start, end)}</caption>
        <thead><tr>
          <th scope="col" className="away-name">Person</th>
          {days.map((d) => <th key={d} scope="col" className={d === today ? 'is-today' : undefined} aria-label={short(d)}><span className="away-dow">{dow(d)}</span> <span className="away-dnum">{dnum(d)}</span></th>)}
        </tr></thead>
        <tbody>
          {!people.length ? <tr><td colSpan={8} className="away-nobody">Nobody is away this week.</td></tr>
            : people.map((p) => (
              <tr key={p.id} className={p.id === me.id ? 'is-mine' : undefined}>
                <th scope="row" className="away-name">{p.name}</th>
                {days.map((d) => {
                  const r = p.rows.find((x) => x.starts_on <= d && x.ends_on >= d);
                  const first = r && (r.starts_on === d || d === start);
                  return (
                    <td key={d} className={`${r ? 'is-away' : ''}${d === today ? ' is-today' : ''}`}
                      title={r ? `${p.name}: ${daysLabel(r.starts_on, r.ends_on)}${r.note ? `, ${r.note}` : ''} (#${chName(r.space_id)})` : undefined}>
                      {r ? <span className="away-bar">{first ? <span className="away-bar-text">{r.note || 'Away'}</span> : null}<span className="visually-hidden">{first ? '' : 'Away'}</span></span> : <span className="visually-hidden">In</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Entry({ r, me, canChange, editing, setEditing, act, error, chName }) {
  const name = r.user_id === me.id ? 'You' : r.who?.display_name || 'Someone';
  const today = dayKey(new Date());
  const now = r.starts_on <= today && r.ends_on >= today;
  if (editing === r.id) {
    return (
      <li className="link away">
        <AwayForm idp={`to-${r.id}`} label="Change time off" submit="Save" onCancel={() => setEditing(null)}
          initial={{ from: r.starts_on, to: r.ends_on, note: r.note }}
          onSave={async (body) => { if (await act(r.id, 'That change was not saved', () => api(`/time_off?id=eq.${r.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null); }} />
        {error && <p className="send-error" role="alert">{error}</p>}
      </li>
    );
  }
  return (
    <li className={`link away${r.user_id === me.id ? ' is-mine' : ''}${now ? ' is-now' : ''}`} aria-label={`${name}, ${daysLabel(r.starts_on, r.ends_on)}`}>
      <div className="link-head">
        <h4 className="shift-title away-who">{name}</h4>
        <span className="shift-when">{daysLabel(r.starts_on, r.ends_on)}</span>
        {now && <span className="away-now">Away now</span>}
        <span className="link-by">#{chName(r.space_id)}</span>
      </div>
      {r.note && <p className="link-note">{r.note}</p>}
      {error && <p className="send-error" role="alert">{error}</p>}
      {canChange && <div className="link-foot">
        <span className="shift-hint">{count(r.starts_on, r.ends_on) === 1 ? '1 day' : `${count(r.starts_on, r.ends_on)} days`}</span>
        <span className="shift-admin">
          <button className="btn btn--sm" type="button" onClick={() => setEditing(r.id)}>Change<span className="visually-hidden"> time off of {name}, {daysLabel(r.starts_on, r.ends_on)}</span></button>
          <button className="btn btn--sm" type="button" onClick={() => {
            if (window.confirm(`Remove ${r.user_id === me.id ? 'your' : `${name}'s`} time off, ${daysLabel(r.starts_on, r.ends_on)}?`)) act(r.id, 'Could not remove', () => api(`/time_off?id=eq.${r.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
          }}>Remove<span className="visually-hidden"> time off of {name}, {daysLabel(r.starts_on, r.ends_on)}</span></button>
        </span>
      </div>}
    </li>
  );
}

export default function TimeOff({ me, spaces, members, notice }) {
  const channels = useMemo(() => spaces.filter((s) => s.kind === 'channel'), [spaces]);
  const role = useCallback((sid) => members.find((m) => m.space_id === sid && m.user?.id === me.id)?.role, [members, me.id]);
  const canEdit = (sid) => ['owner', 'editor'].includes(role(sid));
  const [rows, setRows] = useState(null);
  const [channel, setChannel] = useState('');
  const [week, setWeek] = useState(() => weekStart(dayKey(new Date())));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');

  // Everything that has not ended before the shown week (or before today, whichever is earlier).
  const since = week < dayKey(new Date()) ? week : dayKey(new Date());
  const load = useCallback(() => api(`/time_off?ends_on=gte.${since}&select=${SEL}&order=starts_on,ends_on&limit=1000`)
    .then((r) => { setRows(r); setError(''); }), [since]);
  useEffect(() => { load().catch((e) => setError(`Time off could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (['time_off', 'members'].includes(notice?.t)) load().catch(() => {}); }, [notice, load]);
  useEffect(() => { setErrors({}); }, [editing]);

  const act = async (id, what, run) => {
    let ok = false;
    try { await run(); setErrors((m) => ({ ...m, [id]: '' })); ok = true; } catch (e) { setErrors((m) => ({ ...m, [id]: `${what}: ${e.message}` })); }
    load().catch(() => {});
    return ok;
  };
  // Who the form offers for a channel: yourself, and for editors and owners everyone in it.
  const people = (sid) => {
    const mine = { id: me.id, label: 'You' };
    if (!canEdit(sid)) return [mine];
    const others = members.filter((m) => m.space_id === sid && m.user && m.user.id !== me.id)
      .map((m) => ({ id: m.user.id, label: m.user.display_name })).sort((a, b) => a.label.localeCompare(b.label));
    return [mine, ...others];
  };
  const add = async (body) => {
    try { await api('/time_off', { method: 'POST', body, prefer: 'return=minimal' }); setAdding(false); setError(''); setWeek(weekStart(body.starts_on)); await load(); }
    catch (e) { setError(`Not added: ${e.message}`); }
  };
  const newDefault = () => {
    const d = addDays(dayKey(new Date()), 1);
    return { space: channel || channels[0]?.id || '', user: me.id, from: d, to: d, note: '' };
  };

  const today = dayKey(new Date());
  const chName = (sid) => channels.find((c) => c.id === sid)?.name;
  const all = (rows || []).filter((r) => chName(r.space_id) !== undefined);
  const shown = all.filter((r) => !channel || r.space_id === channel);
  const upcoming = shown.filter((r) => r.ends_on >= today);
  const awayNow = new Set(upcoming.filter((r) => r.starts_on <= today).map((r) => r.user_id)).size;
  const thisWeek = weekStart(today);

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Show time off">
        <p className="docs-hint">Who is away when. Add your own days off; everyone in the channel sees them.</p>
        <p className="tree-group">Channel</p>
        <ul>
          {[{ id: '', name: null }, ...(channels.length > 1 ? channels : [])].map((c) => (
            <li key={c.id || 'all'}><button type="button" className={`doc-link${channel === c.id ? ' is-active' : ''}`} aria-current={channel === c.id ? 'page' : undefined}
              onClick={() => setChannel(c.id)}>{c.name ? `#${c.name}` : 'All channels'}</button></li>
          ))}
        </ul>
      </nav>
      <section className="docs-main">
        <header className="docs-head">
          <h2 className="docs-title shift-head">Time off{channel ? ` in #${chName(channel)}` : ''}</h2>
          <p className="docs-meta"><span>{awayNow === 1 ? '1 person away today' : `${awayNow} people away today`}</span>
            <span>{upcoming.length === 1 ? '1 entry now or coming up' : `${upcoming.length} entries now or coming up`}</span></p>
        </header>
        <div className="docs-links">
          <div className="links">
            <div className="booking-daybar away-weekbar">
              <button className="btn btn--sm" type="button" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">‹</button>
              <button className="btn btn--sm" type="button" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">›</button>
              <button className="btn btn--sm" type="button" onClick={() => setWeek(thisWeek)} disabled={week === thisWeek}>This week</button>
              <h3 className="booking-dayname away-weekname">{week === thisWeek ? 'This week' : week === addDays(thisWeek, 7) ? 'Next week' : week === addDays(thisWeek, -7) ? 'Last week' : 'Week'}: {daysLabel(week, addDays(week, 6))}</h3>
            </div>
            {!rows ? <div className="skeleton" aria-label="Loading time off"><span /><span /></div> : <Week start={week} rows={shown} me={me} chName={chName} />}
            {channels.length > 0 ? (adding
              ? <AwayForm idp="to-new" label="New time off" submit="Add time off" channels={channel ? channels.filter((c) => c.id === channel) : channels} people={people} initial={newDefault()} onSave={add} onCancel={() => setAdding(false)} />
              : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setAdding(true)}>Add time off</button>
                  <p className="docs-hint">Whole days, first and last included. It shows on the Calendar too.</p></div>)
              : <p className="convo-empty">Join a channel to share your time off with it.</p>}
            {error && <p className="send-error" role="alert">{error}</p>}
            {rows && <>
              <h3 className="notice-group">Now and coming up</h3>
              {!upcoming.length ? <p className="convo-empty">Nobody has time off coming up{channel ? ' here' : ''}.</p>
                : <ul className="link-list away-list" aria-label="Now and coming up">
                    {upcoming.map((r) => <Entry key={r.id} r={r} me={me} chName={chName} error={errors[r.id]} act={act} editing={editing} setEditing={setEditing}
                      canChange={r.user_id === me.id || canEdit(r.space_id)} />)}
                  </ul>}
            </>}
          </div>
        </div>
      </section>
    </div>
  );
}
