// Calendar: events from every space you can see (row-level security decides), coloured per space.
// Editors drag to create, move and resize; viewers only read. Live: an events notice refetches.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import classicThemePlugin from '@fullcalendar/react/themes/classic';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import listPlugin from '@fullcalendar/react/list';
import interactionPlugin from '@fullcalendar/react/interaction';
import '@fullcalendar/react/skeleton.css';
import '@fullcalendar/react/themes/classic/theme.css';
import { api } from './api.js';

const label = (s) => (s?.kind === 'personal' ? 'Personal' : s?.kind === 'channel' ? `#${s.name}` : s?.name ?? '');
const when = (a, b) => {
  const s = new Date(a); const e = new Date(b);
  const day = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const t = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(s)} to ${t(e)}`;
};

export default function Calendar({ me, members, notice, focusId, setFocusId }) {
  const cal = useRef(null);
  const [spaces, setSpaces] = useState([]);
  const [events, setEvents] = useState([]);
  const [range, setRange] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);   // {start, end}
  const [form, setForm] = useState({ title: '', space: '', location: '' });
  const [open, setOpen] = useState(null);     // event row
  const [note, setNote] = useState('');
  const [initial, setInitial] = useState(null);

  useEffect(() => {
    api('/spaces?kind=in.(channel,personal)&select=id,kind,name&order=kind.desc,name').then(setSpaces).catch((e) => setError(e.message));
    // Open on the month of the next upcoming event, so a far-off schedule is not hidden.
    api(`/events?ends_at=gte.${new Date().toISOString()}&select=starts_at&order=starts_at&limit=1`)
      .then((r) => setInitial(r[0]?.starts_at ?? new Date().toISOString())).catch(() => setInitial(new Date().toISOString()));
  }, []);

  const role = useCallback((spaceId) => members.find((m) => m.space_id === spaceId && m.user?.id === me.id)?.role
    ?? (spaces.find((s) => s.id === spaceId)?.kind === 'personal' ? 'owner' : null), [members, me.id, spaces]);
  const canEdit = useCallback((spaceId) => ['owner', 'editor'].includes(role(spaceId)), [role]);
  const tint = useCallback((spaceId) => Math.max(0, spaces.findIndex((s) => s.id === spaceId)) % 7, [spaces]);

  const load = useCallback(async () => {
    if (!range) return;
    try {
      setEvents(await api(`/events?and=(starts_at.lt.${range.end},ends_at.gt.${range.start})&select=id,space_id,title,starts_at,ends_at,location,item_id&order=starts_at&limit=1000`));
      setError('');
    } catch (e) { setError(`Events could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (notice?.t === 'events') load(); }, [notice, load]);

  // A link from chat: jump to the event and open it (or say we cannot see it).
  useEffect(() => {
    if (!focusId) return;
    api(`/events?id=eq.${focusId}&select=id,space_id,title,starts_at,ends_at,location,item_id`).then((r) => {
      if (!r[0]) { setNote("You don't have access to that event, or it was deleted."); setOpen(null); return; }
      cal.current?.getApi().gotoDate(r[0].starts_at); setOpen(r[0]); setNote('');
    }).catch(() => {});
  }, [focusId]);

  const fcEvents = useMemo(() => events.filter((e) => !hidden.has(e.space_id)).map((e) => ({
    id: e.id, title: e.title, start: e.starts_at, end: e.ends_at, editable: canEdit(e.space_id),
    className: `ev-t${tint(e.space_id)}`, extendedProps: e, // FullCalendar 7: className (string), not v6 classNames
  })), [events, hidden, canEdit, tint]);

  const editableSpaces = spaces.filter((s) => canEdit(s.id));

  async function save(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.space || !draft) return;
    try {
      await api('/events', { method: 'POST', body: { space_id: form.space, title: form.title.trim(), starts_at: draft.start, ends_at: draft.end, location: form.location || null }, prefer: 'return=minimal' });
      setDraft(null); setForm((f) => ({ ...f, title: '', location: '' })); load();
    } catch (err) { setError(`Could not create the event: ${err.message}`); }
  }
  async function move(info) {
    try {
      await api(`/events?id=eq.${info.event.id}`, { method: 'PATCH', body: { starts_at: info.event.start.toISOString(), ends_at: (info.event.end || info.event.start).toISOString() }, prefer: 'return=minimal' });
    } catch (err) { info.revert(); setError(`Could not move it: ${err.message}`); }
  }
  async function remove() {
    if (!open || !window.confirm(`Delete "${open.title}"? Everyone in ${label(spaces.find((s) => s.id === open.space_id))} will lose it.`)) return;
    try { await api(`/events?id=eq.${open.id}`, { method: 'DELETE', prefer: 'return=minimal' }); setOpen(null); load(); } catch (err) { setError(`Could not delete: ${err.message}`); }
  }
  async function share(channelId) {
    try {
      await api('/messages', { method: 'POST', body: { space_id: channelId, body: `Shared an event, "${open.title}": weft://event/${open.id}` }, prefer: 'return=minimal' });
      setNote('Shared. Only people who can see this event\'s space can open it.');
    } catch (err) { setError(`Could not share: ${err.message}`); }
  }

  return (
    <div className="cal">
      <div className="cal-bar">
        <p className="tree-group">Spaces</p>
        <ul className="cal-spaces">
          {spaces.map((s) => (
            <li key={s.id}>
              <label className={`cal-space ev-t${tint(s.id)}`}>
                <input type="checkbox" checked={!hidden.has(s.id)} onChange={() => setHidden((h) => { const n = new Set(h); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                <span className="cal-swatch" aria-hidden="true" />{label(s)}
              </label>
            </li>
          ))}
        </ul>
        <p className="cal-hint">{editableSpaces.length ? 'Drag across the calendar to add an event.' : 'You can view events here. Ask an owner to make you an editor to add them.'}</p>
        {error && <p className="send-error" role="alert">{error}</p>}
        {note && <p className="slot-status" role="status">{note}</p>}

        {draft && (
          <form className="cal-form" onSubmit={save} aria-label="New event">
            <p className="cal-when">{when(draft.start, draft.end)}</p>
            <label htmlFor="ev-title">Title</label>
            <input id="ev-title" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label htmlFor="ev-space">Space</label>
            <select id="ev-space" value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })}>
              {editableSpaces.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
            </select>
            <label htmlFor="ev-loc">Location</label>
            <input id="ev-loc" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            <span className="pair"><button className="btn btn--primary btn--sm" type="submit" disabled={!form.title.trim()}>Add event</button>
              <button className="btn btn--sm" type="button" onClick={() => setDraft(null)}>Cancel</button></span>
          </form>
        )}

        {open && (
          <section className="cal-detail" aria-label="Event">
            <h3>{open.title}</h3>
            <p className="cal-when">{when(open.starts_at, open.ends_at)}</p>
            {open.location && <p>{open.location}</p>}
            <p className="docs-meta"><span>{label(spaces.find((s) => s.id === open.space_id))}</span>{!canEdit(open.space_id) && <span className="docs-status">View only</span>}</p>
            <span className="pair">
              <label className="visually-hidden" htmlFor="ev-share">Share to channel</label>
              <select id="ev-share" defaultValue="" onChange={(e) => { if (e.target.value) share(e.target.value); e.target.value = ''; }}>
                <option value="">Share to a channel…</option>
                {spaces.filter((s) => s.kind === 'channel').map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
              {canEdit(open.space_id) && <button className="btn btn--sm" onClick={remove}>Delete</button>}
              <button className="btn btn--sm" onClick={() => { setOpen(null); setFocusId(null); }}>Close</button>
            </span>
          </section>
        )}
      </div>

      <div className="cal-main">
        {initial && (
          <FullCalendar
            ref={cal}
            plugins={[classicThemePlugin, dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            initialView="timeGridWeek"
            initialDate={initial}
            headerToolbar={{ start: 'prev,next today', center: 'title', end: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek' }}
            height="100%"
            nowIndicator
            eventMaxStack={3}
            dayMaxEvents
            moreLinkClick="day"
            slotMinTime="07:00:00"
            selectable={editableSpaces.length > 0}
            selectMirror
            events={fcEvents}
            datesSet={(info) => setRange({ start: info.start.toISOString(), end: info.end.toISOString() })}
            select={(info) => { setOpen(null); setDraft({ start: info.start.toISOString(), end: info.end.toISOString() }); setForm((f) => ({ ...f, space: f.space || editableSpaces[0]?.id || '' })); }}
            eventClick={(info) => { setDraft(null); setNote(''); setOpen(info.event.extendedProps); }}
            eventDrop={move}
            eventResize={move}
          />
        )}
      </div>
    </div>
  );
}
