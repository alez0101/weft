// Bookings: shared things a channel can book (a room, a van, a projector) in time slots. The left lists the
// things in each channel; the right shows one thing: a day strip with its booked slots, a form to book it,
// and its upcoming bookings. The database refuses a slot that overlaps another booking of the same thing,
// and its answer is shown as it is. Editors and owners add things and book; the booker (or an owner) changes
// or cancels a booking; only owners delete a thing; viewers read. Bookings also show on the Calendar.
// Live: a resources or bookings notice refetches.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const SEL = 'id,resource_id,space_id,starts_at,ends_at,note,booked_by,who:users!bookings_booked_by_fkey(display_name)';
const DAY0 = 7; const DAY1 = 22;   // the day strip runs from 07:00 to 22:00
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const timeKey = (d) => { const x = new Date(d); return `${pad(x.getHours())}:${pad(x.getMinutes())}`; };
const at = (day, time) => new Date(`${day}T${time}`);
const addDays = (day, n) => { const x = new Date(`${day}T12:00`); x.setDate(x.getDate() + n); return dayKey(x); };
const dayLabel = (d) => new Date(d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const t = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const span = (a, b) => (dayKey(a) === dayKey(b) ? `${t(a)} to ${t(b)}` : `${t(a)} to ${dayLabel(b)}, ${t(b)}`);
// The next whole hour, as the default start of a new booking.
const nextHour = () => { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; };

function BookingForm({ initial, onSave, onCancel, idp, submit, label }) {
  const [f, setF] = useState(initial);
  const start = at(f.day, f.from); const end = at(f.endDay || f.day, f.to);
  const bad = !(end > start);
  return (
    <form className="link-form booking-form" aria-label={label} onSubmit={(e) => {
      e.preventDefault(); if (bad) return;
      onSave({ starts_at: start.toISOString(), ends_at: end.toISOString(), note: f.note.trim() });
    }}>
      <label htmlFor={`${idp}-day`}>Day</label>
      <input id={`${idp}-day`} type="date" value={f.day} required onChange={(e) => setF({ ...f, day: e.target.value, endDay: f.endDay && f.endDay < e.target.value ? e.target.value : f.endDay })} />
      <label htmlFor={`${idp}-from`}>From</label>
      <input id={`${idp}-from`} type="time" value={f.from} required step={900} onChange={(e) => setF({ ...f, from: e.target.value })} />
      <label htmlFor={`${idp}-to`}>To</label>
      <span className="pair">
        <input id={`${idp}-to`} type="time" value={f.to} required step={900} onChange={(e) => setF({ ...f, to: e.target.value })} />
        {f.endDay !== undefined && f.endDay !== null
          ? <><label className="visually-hidden" htmlFor={`${idp}-endday`}>Until day</label>
              <input id={`${idp}-endday`} type="date" value={f.endDay} min={f.day} onChange={(e) => setF({ ...f, endDay: e.target.value })} /></>
          : <button type="button" className="link-btn booking-more" onClick={() => setF({ ...f, endDay: f.day })}>Ends on another day</button>}
      </span>
      <label htmlFor={`${idp}-note`}>Note</label>
      <input id={`${idp}-note`} value={f.note} maxLength={200} autoComplete="off" placeholder="What it is for (optional)" onChange={(e) => setF({ ...f, note: e.target.value })} />
      {bad && <p className="booking-warn" role="status">The end must be after the start.</p>}
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={bad}>{submit}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// One day of a thing: booked slots as blocks between 07:00 and 22:00 (earlier or later slots are clipped).
function DayStrip({ day, rows, me }) {
  const d0 = at(day, `${pad(DAY0)}:00`).getTime(); const d1 = at(day, `${pad(DAY1)}:00`).getTime();
  const shown = rows.filter((b) => new Date(b.starts_at).getTime() < d1 && new Date(b.ends_at).getTime() > d0);
  const hours = Array.from({ length: DAY1 - DAY0 + 1 }, (_, i) => DAY0 + i);
  return (
    <div className="booking-strip" role="group" aria-label={`Booked on ${dayLabel(at(day, '12:00'))}`}>
      <div className="booking-track">
        {hours.slice(0, -1).map((h) => <span key={h} className="booking-hour" style={{ left: `${((h - DAY0) / (DAY1 - DAY0)) * 100}%` }} aria-hidden="true" />)}
        {shown.map((b) => {
          const s = Math.max(d0, new Date(b.starts_at).getTime()); const e = Math.min(d1, new Date(b.ends_at).getTime());
          const who = b.booked_by === me.id ? 'You' : b.who?.display_name || 'Someone';
          return (
            <span key={b.id} className={`booking-block${b.booked_by === me.id ? ' is-mine' : ''}`}
              style={{ left: `${((s - d0) / (d1 - d0)) * 100}%`, width: `${((e - s) / (d1 - d0)) * 100}%` }}
              title={`${span(b.starts_at, b.ends_at)}, ${who}${b.note ? `: ${b.note}` : ''}`}>
              <span className="booking-block-text">{who}</span>
            </span>
          );
        })}
      </div>
      <div className="booking-scale" aria-hidden="true">{hours.filter((h) => h % 3 === 1).map((h) => <span key={h} style={{ left: `${((h - DAY0) / (DAY1 - DAY0)) * 100}%` }}>{pad(h)}:00</span>)}</div>
      <p className="visually-hidden">{shown.length ? shown.map((b) => `${span(b.starts_at, b.ends_at)} booked by ${b.booked_by === me.id ? 'you' : b.who?.display_name || 'someone'}`).join('; ') : 'Nothing booked.'}</p>
      {!shown.length && <p className="booking-free">Free all day</p>}
    </div>
  );
}

function Booking({ b, me, canChange, editing, setEditing, change }) {
  const who = b.booked_by === me.id ? 'You' : b.who?.display_name || 'Someone';
  if (editing === b.id) {
    const sameDay = dayKey(b.starts_at) === dayKey(b.ends_at);
    return (
      <li className="link booking">
        <BookingForm idp={`bk-${b.id}`} label="Change booking" submit="Save" onCancel={() => setEditing(null)}
          initial={{ day: dayKey(b.starts_at), from: timeKey(b.starts_at), to: timeKey(b.ends_at), endDay: sameDay ? undefined : dayKey(b.ends_at), note: b.note }}
          onSave={async (body) => { if (await change('That change was not saved', () => api(`/bookings?id=eq.${b.id}`, { method: 'PATCH', body, prefer: 'return=minimal' }))) setEditing(null); }} />
      </li>
    );
  }
  return (
    <li className={`link booking${b.booked_by === me.id ? ' is-mine' : ''}`}>
      <p className="booking-when">{span(b.starts_at, b.ends_at)}</p>
      {b.note && <p className="link-note">{b.note}</p>}
      <div className="link-foot">
        <span className="link-by booking-who">Booked by {who}</span>
        {canChange && <>
          <button className="btn btn--sm" type="button" onClick={() => setEditing(b.id)}>Change<span className="visually-hidden"> booking at {span(b.starts_at, b.ends_at)}</span></button>
          <button className="btn btn--sm" type="button" onClick={() => {
            if (window.confirm(`Cancel the booking ${dayLabel(b.starts_at)}, ${span(b.starts_at, b.ends_at)}?`)) change('Could not cancel', () => api(`/bookings?id=eq.${b.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
          }}>Cancel booking<span className="visually-hidden"> at {span(b.starts_at, b.ends_at)}</span></button>
        </>}
      </div>
    </li>
  );
}

export default function Bookings({ me, spaces, members, notice, openId, setOpenId }) {
  const channels = useMemo(() => spaces.filter((s) => s.kind === 'channel'), [spaces]);
  const role = useCallback((sid) => members.find((m) => m.space_id === sid && m.user?.id === me.id)?.role, [members, me.id]);
  const canEdit = (sid) => ['owner', 'editor'].includes(role(sid));
  const [things, setThings] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState(() => dayKey(new Date()));
  const [editing, setEditing] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [booking, setBooking] = useState(false);
  const [draft, setDraft] = useState({ space: '', name: '', note: '' });
  const current = (things || []).find((x) => x.id === openId) || null;
  const editable = current && canEdit(current.space_id);
  const owner = current && role(current.space_id) === 'owner';

  const loadThings = useCallback(() => api('/resources?select=id,space_id,name,note&order=name&limit=500').then(setThings)
    .catch((e) => setError(`Things to book could not load: ${e.message}`)), []);
  // Upcoming bookings (and the chosen day's, even if it is in the past) of the open thing.
  const load = useCallback(() => {
    if (!openId) return Promise.resolve();
    const since = new Date(Math.min(Date.now(), at(day, '00:00').getTime())).toISOString();
    return api(`/bookings?resource_id=eq.${openId}&ends_at=gt.${since}&select=${SEL}&order=starts_at&limit=500`).then(setRows);
  }, [openId, day]);
  useEffect(() => { loadThings(); }, [loadThings]);
  useEffect(() => { setRows(null); load().catch((e) => setError(`Bookings could not load: ${e.message}`)); }, [load]);
  useEffect(() => { setEditing(null); setRenaming(false); setBooking(false); }, [openId]);
  useEffect(() => {
    if (!notice) return;
    if (notice.t === 'resources' || notice.t === 'members') loadThings();
    if ((notice.t === 'bookings' || notice.t === 'resources') && notice.space === current?.space_id) load().catch(() => {});
  }, [notice, current?.space_id, load, loadThings]);
  // Open the first thing when none is chosen (or the chosen one is gone).
  useEffect(() => { if (things && things.length && !current) setOpenId(things[0].id); }, [things, current, setOpenId]);

  const change = async (what, run) => {
    let ok = false;
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    load().catch(() => {});
    return ok;
  };
  const addThing = async (e) => {
    e.preventDefault();
    const space = draft.space || channels.find((c) => canEdit(c.id))?.id;
    if (!draft.name.trim() || !space) return;
    try {
      const [row] = await api('/resources', { method: 'POST', body: { space_id: space, name: draft.name.trim(), note: draft.note.trim() }, prefer: 'return=representation' });
      setDraft({ space, name: '', note: '' }); setAdding(false); setError('');
      await loadThings(); setOpenId(row.id);
    } catch (err) { setError(`Not added: ${err.message}`); }
  };
  const book = async (body) => {
    if (await change('Not booked', () => api('/bookings', { method: 'POST', body: { ...body, resource_id: current.id }, prefer: 'return=minimal' }))) {
      setBooking(false); setDay(dayKey(body.starts_at));
    }
  };
  const removeThing = async () => {
    if (!window.confirm(`Delete "${current.name}" and all its bookings? Everyone in the channel loses them.`)) return;
    try { await api(`/resources?id=eq.${current.id}`, { method: 'DELETE', prefer: 'return=minimal' }); setError(''); setOpenId(null); loadThings(); }
    catch (err) { setError(`Could not delete: ${err.message}`); }
  };

  const now = Date.now();
  const upcoming = (rows || []).filter((b) => new Date(b.ends_at).getTime() > now);
  const byDay = upcoming.reduce((acc, b) => { const k = dayKey(b.starts_at); (acc[k] ||= []).push(b); return acc; }, {});
  const editableChannels = channels.filter((c) => canEdit(c.id));
  const chName = (sid) => channels.find((c) => c.id === sid)?.name ?? '';
  const startDefault = () => { const s = nextHour(); const sameDay = dayKey(s) === day || day < dayKey(new Date()); const d = sameDay ? s : at(day, '09:00');
    const e = new Date(d.getTime() + 3600000); return { day: dayKey(d), from: timeKey(d), to: timeKey(e), endDay: dayKey(e) !== dayKey(d) ? dayKey(e) : undefined, note: '' }; };

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Things to book">
        <p className="docs-hint">Rooms, vans, projectors: anything a channel shares. A slot can only be booked once.</p>
        {editableChannels.length > 0 && (adding ? (
          <form className="cal-form booking-add" onSubmit={addThing} aria-label="New thing to book">
            <label htmlFor="bk-new-name">Name</label>
            <input id="bk-new-name" autoFocus maxLength={80} value={draft.name} placeholder="Meeting room, van…" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <label htmlFor="bk-new-space">Channel</label>
            <select id="bk-new-space" value={draft.space || editableChannels[0].id} onChange={(e) => setDraft({ ...draft, space: e.target.value })}>
              {editableChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
            <label htmlFor="bk-new-note">Note</label>
            <input id="bk-new-note" maxLength={500} value={draft.note} placeholder="Where it is, how to get the key (optional)" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            <span className="pair"><button className="btn btn--primary btn--sm" type="submit" disabled={!draft.name.trim()}>Add</button>
              <button className="btn btn--sm" type="button" onClick={() => setAdding(false)}>Cancel</button></span>
          </form>
        ) : <button className="btn btn--sm booking-newbtn" type="button" onClick={() => setAdding(true)}>New thing to book</button>)}
        {!things ? <div className="skeleton" aria-label="Loading"><span /><span /></div>
          : !things.length ? <p className="convo-empty">{editableChannels.length ? 'Nothing to book yet. Add the first thing above.' : 'Nothing to book in your channels yet.'}</p>
          : channels.filter((c) => things.some((x) => x.space_id === c.id)).map((c) => (
            <div key={c.id}>
              <p className="tree-group">#{c.name}</p>
              <ul>
                {things.filter((x) => x.space_id === c.id).map((x) => (
                  <li key={x.id}><button className={`doc-link${x.id === openId ? ' is-active' : ''}`} aria-current={x.id === openId ? 'page' : undefined} onClick={() => setOpenId(x.id)}>{x.name}</button></li>
                ))}
              </ul>
            </div>
          ))}
      </nav>
      <section className="docs-main">
        {!current ? (
          <div className="empty"><h2>Pick something to book</h2><p>Each channel keeps its own list. Everyone in the channel sees the bookings; editors and owners book.</p>
            {error && <p className="send-error" role="alert">{error}</p>}</div>
        ) : (<>
          <header className="docs-head">
            {renaming ? (
              <form className="cal-form booking-rename" aria-label="Rename" onSubmit={async (e) => {
                e.preventDefault(); const fd = new FormData(e.currentTarget);
                try { await api(`/resources?id=eq.${current.id}`, { method: 'PATCH', body: { name: String(fd.get('name')).trim(), note: String(fd.get('note')).trim() }, prefer: 'return=minimal' }); setRenaming(false); setError(''); loadThings(); }
                catch (err) { setError(`Not saved: ${err.message}`); }
              }}>
                <label htmlFor="bk-rename">Name</label><input id="bk-rename" name="name" defaultValue={current.name} maxLength={80} required autoFocus />
                <label htmlFor="bk-renote">Note</label><input id="bk-renote" name="note" defaultValue={current.note} maxLength={500} />
                <span className="pair"><button className="btn btn--primary btn--sm" type="submit">Save</button><button className="btn btn--sm" type="button" onClick={() => setRenaming(false)}>Cancel</button></span>
              </form>
            ) : <h2 className="docs-title booking-title">{current.name}</h2>}
            <p className="docs-meta booking-meta"><span>#{chName(current.space_id)}</span><span>{editable ? 'You can book this' : 'View only'}</span>
              {editable && !renaming && <button className="btn btn--sm" type="button" onClick={() => setRenaming(true)}>Rename</button>}
              {owner && <button className="btn btn--sm" type="button" onClick={removeThing}>Delete</button>}</p>
            {current.note && !renaming && <p className="link-note">{current.note}</p>}
          </header>
          <div className="docs-links">
            <div className="links">
              <div className="booking-daybar">
                <button className="btn btn--sm" type="button" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</button>
                <label className="visually-hidden" htmlFor="bk-day">Day</label>
                <input id="bk-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
                <button className="btn btn--sm" type="button" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">›</button>
                <button className="btn btn--sm" type="button" onClick={() => setDay(dayKey(new Date()))}>Today</button>
                <span className="booking-dayname">{dayLabel(at(day, '12:00'))}</span>
              </div>
              {rows && <DayStrip day={day} rows={rows} me={me} />}
              {editable ? (booking
                ? <BookingForm idp="bk-new" label="New booking" submit="Book" initial={startDefault()} onSave={book} onCancel={() => setBooking(false)} />
                : <div className="links-bar"><button className="btn btn--primary btn--sm" type="button" onClick={() => setBooking(true)}>Book {current.name}</button>
                    <p className="docs-hint">A slot that overlaps another booking is refused. Bookings show on the Calendar too.</p></div>)
                : <p className="docs-hint">You can see when this is booked. Ask an owner of the channel to make you an editor to book it.</p>}
              {error && <p className="send-error" role="alert">{error}</p>}
              {!rows ? <div className="skeleton" aria-label="Loading bookings"><span /><span /></div> : (<>
                <h3 className="notice-group">Coming up</h3>
                {!upcoming.length ? <p className="convo-empty">No bookings coming up.</p> : Object.entries(byDay).map(([k, list]) => (
                  <div key={k} className="rsvp-day">
                    <h4 className="booking-dayhead">{dayLabel(at(k, '12:00'))}</h4>
                    <ul className="link-list" aria-label={dayLabel(at(k, '12:00'))}>
                      {list.map((b) => <Booking key={b.id} b={b} me={me} editing={editing} setEditing={setEditing} change={change}
                        canChange={owner || (editable && b.booked_by === me.id)} />)}
                    </ul>
                  </div>
                ))}
              </>)}
            </div>
          </div>
        </>)}
      </section>
    </div>
  );
}
