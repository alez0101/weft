// Calendar: events from every space you can see (row-level security decides), coloured per space.
// Editors drag to create, move and resize; viewers only read. Live: an events notice refetches.
// Each event shows its RSVPs (Going, Maybe, Not going) and lets anyone in its space answer for themselves.
// Open tasks with a due date show as all-day entries (read-only here; clicking one opens its list).
// Bookings of shared things show as entries too (read-only here; clicking one opens it in Bookings).
// Time off shows as all-day "Away" entries (read-only here; clicking one opens Time off).
// Timeline milestones show as all-day entries (clicking one opens that channel's Timeline), and the shifts
// you signed up for show at their times (clicking one opens Shifts). Both read-only here.
// Which of these kinds show is remembered per person (weft.user_prefs.calendar, {"off": [...]}).
// Repeating events: a new event can repeat every day, week or month until a date. Each occurrence is its own
// event (with its own RSVPs and notes); changing, moving or deleting one asks "just this one" or "all of them".
// Download as a file (066): one space's events, past and coming, as an .ics file any calendar app imports. The
// events are read as the person (only spaces they are in), and the file is made here.
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
import { EventRsvps } from './Rsvps.jsx';
import { saveFile, fileName, toIcs } from './download.js';

const label = (s) => (s?.kind === 'personal' ? 'Personal' : s?.kind === 'channel' ? `#${s.name}` : s?.name ?? '');
const when = (a, b) => {
  const s = new Date(a); const e = new Date(b);
  const day = s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const t = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(s)} to ${t(e)}`;
};
const EVENT_COLS = 'id,space_id,project_id,title,starts_at,ends_at,location,item_id,series_id,series:event_series(repeats,until_on)';
const EVERY = { daily: 'every day', weekly: 'every week', monthly: 'every month' };
const ymd = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const longDay = (s) => new Date(`${s}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

// The kinds of entries besides events, each with a switch. Keys are what user_prefs.calendar.off may hold.
const KINDS = [
  { key: 'tasks', label: 'Tasks due' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'shifts', label: 'Your shifts' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'away', label: 'Time off' },
];

export default function Calendar({ me, members, notice, focusId, setFocusId, onOpenItem, onOpenBooking, onOpenTimeOff, onOpenTimeline, onOpenShifts }) {
  const cal = useRef(null);
  const [spaces, setSpaces] = useState([]);
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [away, setAway] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [off, setOff] = useState(() => new Set());   // kinds switched off (saved per person)
  const show = (k) => !off.has(k);
  const [range, setRange] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);   // {start, end}
  const [form, setForm] = useState({ title: '', space: '', project: '', location: '', repeats: '', until: '' });
  // Projects (069, 071): events can belong to a project in their space; the calendar can show just one project.
  const [projects, setProjects] = useState([]);
  const [only, setOnly] = useState('');        // a project id: show only its events and its lists' tasks
  const loadProjects = useCallback(() => api('/projects?archived_at=is.null&select=id,space_id,name&order=name').then(setProjects).catch(() => setProjects([])), []);
  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { if (notice?.t === 'projects') loadProjects(); }, [notice, loadProjects]);
  const projectName = (id) => projects.find((p) => p.id === id)?.name;
  const projectsIn = (spaceId) => projects.filter((p) => p.space_id === spaceId);
  const onlyP = projects.find((p) => p.id === only) || null;
  const [edit, setEdit] = useState(null);     // {title, location} while changing the open event
  const [moving, setMoving] = useState(null); // a dragged occurrence of a repeating event, waiting for "this one or all"
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);     // event row
  const [note, setNote] = useState('');
  const [initial, setInitial] = useState(null);
  const [notes, setNotes] = useState([]);    // meetings linked to the open event

  useEffect(() => {
    api('/spaces?kind=in.(channel,personal)&select=id,kind,name&order=kind.desc,name').then(setSpaces).catch((e) => setError(e.message));
    api('/user_prefs?select=calendar').then(([p]) => { if (Array.isArray(p?.calendar?.off)) setOff(new Set(p.calendar.off)); }).catch(() => {});
    // Open on the next upcoming event or open task due, whichever is sooner, so a far-off schedule is not hidden.
    const now = new Date(); const d = new Date(now); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    Promise.all([
      api(`/events?ends_at=gte.${now.toISOString()}&select=starts_at&order=starts_at&limit=1`).catch(() => []),
      api(`/tasks?done=is.false&due_on=gte.${d.toISOString().slice(0, 10)}&select=due_on&order=due_on&limit=1`).catch(() => []),
    ]).then(([ev, tk]) => {
      const next = [ev[0] && new Date(ev[0].starts_at), tk[0] && new Date(`${tk[0].due_on}T12:00:00`)].filter(Boolean).sort((x, y) => x - y)[0];
      setInitial((cur) => cur ?? (next ?? now).toISOString());   // an event opened from a link wins
    });
  }, []);

  const role = useCallback((spaceId) => members.find((m) => m.space_id === spaceId && m.user?.id === me.id)?.role
    ?? (spaces.find((s) => s.id === spaceId)?.kind === 'personal' ? 'owner' : null), [members, me.id, spaces]);
  const canEdit = useCallback((spaceId) => ['owner', 'editor'].includes(role(spaceId)), [role]);
  const tint = useCallback((spaceId) => Math.max(0, spaces.findIndex((s) => s.id === spaceId)) % 7, [spaces]);

  const load = useCallback(async () => {
    if (!range) return;
    try {
      setEvents(await api(`/events?and=(starts_at.lt.${range.end},ends_at.gt.${range.start})&select=${EVENT_COLS}&order=starts_at&limit=1000`));
      setError('');
    } catch (e) { setError(`Events could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (notice?.t === 'events') load(); }, [notice, load]);
  const loadTasks = useCallback(async () => {
    if (!range) return;
    try {
      setTasks(await api(`/tasks?done=is.false&and=(due_on.gte.${range.day0},due_on.lt.${range.day1})&select=id,title,due_on,list_id,list:items(title,space_id,project_id)&order=due_on&limit=1000`));
    } catch (e) { setError(`Tasks could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => { if (notice?.t === 'tasks' || notice?.t === 'items') loadTasks(); }, [notice, loadTasks]);
  const loadBookings = useCallback(async () => {
    if (!range) return;
    try {
      setBookings(await api(`/bookings?and=(starts_at.lt.${range.end},ends_at.gt.${range.start})&select=id,space_id,resource_id,starts_at,ends_at,note,thing:resources(name),who:users!bookings_booked_by_fkey(display_name)&order=starts_at&limit=1000`));
    } catch (e) { setError(`Bookings could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { loadBookings(); }, [loadBookings]);
  useEffect(() => { if (notice?.t === 'bookings' || notice?.t === 'resources') loadBookings(); }, [notice, loadBookings]);
  // Time off is in whole days: the visible range's first and last day (day1 is the day after the end).
  const loadAway = useCallback(async () => {
    if (!range) return;
    try {
      setAway(await api(`/time_off?and=(starts_on.lt.${range.day1},ends_on.gte.${range.day0})&select=id,space_id,user_id,starts_on,ends_on,note,who:users!time_off_user_id_fkey(display_name)&order=starts_on&limit=1000`));
    } catch (e) { setError(`Time off could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { loadAway(); }, [loadAway]);
  useEffect(() => { if (notice?.t === 'time_off' || notice?.t === 'members') loadAway(); }, [notice, loadAway]);
  const loadMilestones = useCallback(async () => {
    if (!range) return;
    try {
      setMilestones(await api(`/milestones?and=(day.gte.${range.day0},day.lt.${range.day1})&select=id,space_id,title,day,note&order=day&limit=1000`));
    } catch (e) { setError(`Milestones could not load: ${e.message}`); }
  }, [range]);
  useEffect(() => { loadMilestones(); }, [loadMilestones]);
  useEffect(() => { if (notice?.t === 'milestones') loadMilestones(); }, [notice, loadMilestones]);
  // Your shifts: only shifts with your own sign-up (the inner join keeps just those).
  const loadShifts = useCallback(async () => {
    if (!range) return;
    try {
      setShifts(await api(`/shifts?and=(starts_at.lt.${range.end},ends_at.gt.${range.start})&select=id,space_id,title,starts_at,ends_at,mine:shift_signups!inner(user_id)&mine.user_id=eq.${me.id}&order=starts_at&limit=1000`));
    } catch (e) { setError(`Shifts could not load: ${e.message}`); }
  }, [range, me.id]);
  useEffect(() => { loadShifts(); }, [loadShifts]);
  useEffect(() => { if (notice?.t === 'shifts' || notice?.t === 'shift_signups') loadShifts(); }, [notice, loadShifts]);

  const [dlSpace, setDlSpace] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  async function downloadIcs() {
    const [sid, pid = ''] = (dlSpace || `${spaces[0]?.id}|`).split('|');
    const s = spaces.find((x) => x.id === sid);
    if (!s) return;
    const name = pid ? `${label(s)} › ${projectName(pid)}` : label(s);
    setDlBusy(true);
    try {
      const rows = await api(`/events?space_id=eq.${s.id}${pid ? `&project_id=eq.${pid}` : ''}&select=id,title,starts_at,ends_at,location&order=starts_at&limit=5000`);
      saveFile(fileName(`${pid ? projectName(pid) : label(s)} calendar`, 'calendar', 'ics'), toIcs(`${name} (Weft)`, rows), 'text/calendar;charset=utf-8');
      setNote(`Downloaded ${rows.length} event${rows.length === 1 ? '' : 's'} from ${name}.`);
    } catch (e) { setError(`Could not download the calendar: ${e.message}`); }
    setDlBusy(false);
  }

  async function toggleKind(key) {
    const next = new Set(off); if (next.has(key)) next.delete(key); else next.add(key);
    setOff(next);
    try {
      await api('/user_prefs?on_conflict=user_id', { method: 'POST', body: { calendar: { off: KINDS.map((k) => k.key).filter((k) => next.has(k)) } }, prefer: 'resolution=merge-duplicates,return=minimal' });
    } catch (e) { setError(`Your choice shows now, but could not be saved: ${e.message}`); }
  }

  // A link from chat: jump to the event and open it (or say we cannot see it).
  useEffect(() => {
    if (!focusId) return;
    api(`/events?id=eq.${focusId}&select=${EVENT_COLS}`).then((r) => {
      if (!r[0]) { setNote("You don't have access to that event, or it was deleted."); setOpen(null); return; }
      if (cal.current) cal.current.getApi().gotoDate(r[0].starts_at); else setInitial(r[0].starts_at);
      setOpen(r[0]); setNote('');
    }).catch(() => {});
  }, [focusId]);

  // With one project chosen, only its events and the tasks in its lists show; the channel-wide kinds (milestones,
  // shifts, bookings, time off) belong to no project, so they step aside.
  const inProject = (pid) => !only || pid === only;
  const fcEvents = useMemo(() => events.filter((e) => !hidden.has(e.space_id) && inProject(e.project_id)).map((e) => ({
    id: e.id, title: e.title, start: e.starts_at, end: e.ends_at, editable: canEdit(e.space_id),
    className: `ev-t${tint(e.space_id)}${e.series_id ? ' cal-repeat' : ''}`, extendedProps: e, // FullCalendar 7: className (string), not v6 classNames
  })).concat(show('tasks') ? tasks.filter((t) => t.list && !hidden.has(t.list.space_id) && inProject(t.list.project_id)).map((t) => ({
    id: `task-${t.id}`, title: `Task: ${t.title}`, start: t.due_on, allDay: true, editable: false,
    className: `cal-task ev-t${tint(t.list.space_id)}`, extendedProps: { task: true, ...t },
  })) : []).concat(!only && show('milestones') ? milestones.filter((m) => !hidden.has(m.space_id)).map((m) => ({
    id: `milestone-${m.id}`, title: `Milestone: ${m.title}`, start: m.day, allDay: true, editable: false,
    className: `cal-milestone ev-t${tint(m.space_id)}`, extendedProps: { milestone: true, ...m },
  })) : []).concat(!only && show('shifts') ? shifts.filter((x) => !hidden.has(x.space_id)).map((x) => ({
    id: `shift-${x.id}`, title: `Shift: ${x.title}`, start: x.starts_at, end: x.ends_at, editable: false,
    className: `cal-shift ev-t${tint(x.space_id)}`, extendedProps: { shift: true, ...x },
  })) : []).concat(!only && show('bookings') ? bookings.filter((b) => !hidden.has(b.space_id)).map((b) => ({
    id: `booking-${b.id}`, title: `${b.thing?.name ?? 'Booked'}: ${b.who?.display_name ?? 'someone'}${b.note ? ` (${b.note})` : ''}`, start: b.starts_at, end: b.ends_at, editable: false,
    className: `cal-booking ev-t${tint(b.space_id)}`, extendedProps: { booking: true, ...b },
  })) : []).concat(!only && show('away') ? away.filter((a) => !hidden.has(a.space_id)).map((a) => {
    const end = new Date(`${a.ends_on}T12:00`); end.setDate(end.getDate() + 1);   // all-day ends are exclusive
    const pad = (n) => String(n).padStart(2, '0');
    return {
      id: `away-${a.id}`, title: `Away: ${a.user_id === me.id ? 'You' : a.who?.display_name ?? 'someone'}${a.note ? ` (${a.note})` : ''}`,
      start: a.starts_on, end: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`, allDay: true, editable: false,
      className: `cal-away ev-t${tint(a.space_id)}`, extendedProps: { away: true, ...a },
    };
  }) : []), [events, tasks, bookings, away, milestones, shifts, off, hidden, canEdit, tint, me.id, only]); // eslint-disable-line react-hooks/exhaustive-deps

  const editableSpaces = spaces.filter((s) => canEdit(s.id));

  async function save(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.space || !draft) return;
    if (form.repeats && !form.until) { setError('Choose the last day it repeats on.'); return; }
    let row;
    try {
      [row] = await api('/events', { method: 'POST', body: { space_id: form.space, ...(form.project ? { project_id: form.project } : {}), title: form.title.trim(), starts_at: draft.start, ends_at: draft.end, location: form.location || null }, prefer: 'return=representation' });
    } catch (err) { setError(`Could not create the event: ${err.message}`); return; }
    if (form.repeats) {
      try {
        await api('/rpc/repeat_event', { method: 'POST', body: { p_event: row.id, p_repeats: form.repeats, p_until: form.until, p_tz: zone() } });
      } catch (err) { setError(`The first event was added, but it does not repeat: ${err.message}`); }
    }
    setDraft(null); setForm((f) => ({ ...f, title: '', location: '', repeats: '', until: '' })); load();
  }
  // Put the open event (all of a repeating series together) into a project in its space, or take it out.
  async function setProject(pid) {
    try {
      if (open.series_id) await api('/rpc/set_series_project', { method: 'POST', body: { p_event: open.id, p_project: pid || null } });
      else await api(`/events?id=eq.${open.id}`, { method: 'PATCH', body: { project_id: pid || null }, prefer: 'return=minimal' });
      setNote(pid ? `${open.series_id ? 'All of them are' : 'It is'} in ${projectName(pid)} now.` : `${open.series_id ? 'They are' : 'It is'} no longer in a project.`);
      await reopen(open.id); load();
    } catch (err) { setError(`Could not change the project: ${err.message}`); }
  }
  async function reopen(id) {
    const [r] = await api(`/events?id=eq.${id}&select=${EVENT_COLS}`).catch(() => []);
    setOpen(r ?? null);
  }
  async function move(info) {
    if (info.event.extendedProps.series_id) { setOpen(null); setDraft(null); setMoving(info); return; }
    try {
      await api(`/events?id=eq.${info.event.id}`, { method: 'PATCH', body: { starts_at: info.event.start.toISOString(), ends_at: (info.event.end || info.event.start).toISOString() }, prefer: 'return=minimal' });
    } catch (err) { info.revert(); setError(`Could not move it: ${err.message}`); }
  }
  // A dragged occurrence of a repeating event: move just it, or shift all of them by as much.
  async function finishMove(which) {
    const info = moving; setMoving(null);
    if (which === 'cancel') { info.revert(); return; }
    const ev = info.event;
    const start = ev.start.toISOString(); const end = (ev.end || ev.start).toISOString();
    try {
      if (which === 'all') await api('/rpc/change_series', { method: 'POST', body: { p_event: ev.id, p_title: null, p_location: null, p_starts: start, p_ends: end } });
      else await api(`/events?id=eq.${ev.id}`, { method: 'PATCH', body: { starts_at: start, ends_at: end }, prefer: 'return=minimal' });
      load();
    } catch (err) { info.revert(); setError(`Could not move it: ${err.message}`); }
  }
  async function saveEdit(which) {
    if (!edit.title.trim()) return;
    setBusy(true);
    try {
      if (which === 'all') await api('/rpc/change_series', { method: 'POST', body: { p_event: open.id, p_title: edit.title.trim(), p_location: edit.location, p_starts: open.starts_at, p_ends: open.ends_at } });
      else await api(`/events?id=eq.${open.id}`, { method: 'PATCH', body: { title: edit.title.trim(), location: edit.location.trim() || null }, prefer: 'return=minimal' });
      setEdit(null); await reopen(open.id); load();
    } catch (err) { setError(`Could not save: ${err.message}`); }
    setBusy(false);
  }
  async function remove(which = 'one') {
    const where = label(spaces.find((s) => s.id === open?.space_id));
    const ask = which === 'all' ? `Delete every "${open?.title}" in this series, past and coming? Everyone in ${where} will lose them.`
      : `Delete "${open?.title}"${open?.series_id ? ' on this day only' : ''}? Everyone in ${where} will lose it.`;
    if (!open || !window.confirm(ask)) return;
    try {
      if (which === 'all') await api('/rpc/delete_series', { method: 'POST', body: { p_event: open.id } });
      else await api(`/events?id=eq.${open.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      setOpen(null); load();
    } catch (err) { setError(`Could not delete: ${err.message}`); }
  }
  function pickRepeat(v) {
    // Picking a repeat suggests a last day (eight weeks on for daily and weekly, six months for monthly).
    const d = new Date(draft.start); if (v === 'monthly') d.setMonth(d.getMonth() + 6); else d.setDate(d.getDate() + 56);
    setForm((f) => ({ ...f, repeats: v, until: v ? (f.until || ymd(d)) : '' }));
  }
  // Meeting notes linked to the open event (only those the person can see), and starting new ones from it.
  useEffect(() => {
    if (!open) { setNotes([]); return; }
    api(`/meetings?event_id=eq.${open.id}&select=id,item:items!meetings_id_fkey(title)`).then(setNotes).catch(() => setNotes([]));
  }, [open, notice]);
  async function startNotes() {
    try {
      const [row] = await api('/items', { method: 'POST', body: { space_id: open.space_id, ...(open.project_id ? { project_id: open.project_id } : {}), kind: 'meeting', title: open.title }, prefer: 'return=representation' });
      await api(`/meetings?id=eq.${row.id}`, { method: 'PATCH', body: { event_id: open.id, held_at: open.starts_at }, prefer: 'return=minimal' });
      onOpenItem(row.id);
    } catch (err) { setError(`Could not start meeting notes: ${err.message}`); }
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
        {projects.length > 0 && (
          <div className="cal-project">
            <label className="tree-group" htmlFor="cal-only">Project</label>
            <select id="cal-only" value={only} onChange={(e) => setOnly(e.target.value)}>
              <option value="">Everything</option>
              {spaces.flatMap((x) => projectsIn(x.id).map((p) => <option key={p.id} value={p.id}>{label(x)} › {p.name}</option>))}
            </select>
            {onlyP && <p className="cal-hint">Only {onlyP.name}: its events and the tasks in its lists.</p>}
          </div>
        )}
        <fieldset className="cal-kinds">
          <legend className="tree-group">Also show</legend>
          {KINDS.map((k) => (
            <label key={k.key} className={`toggle cal-${k.key === 'away' ? 'aways' : k.key}`}><input type="checkbox" checked={show(k.key)} onChange={() => toggleKind(k.key)} /> {k.label}</label>
          ))}
        </fieldset>
        {spaces.length > 0 && (
          <div className="cal-download">
            <label className="tree-group" htmlFor="cal-dl-space">Download as a file</label>
            <span className="pair">
              <select id="cal-dl-space" value={dlSpace || `${spaces[0].id}|`} onChange={(e) => setDlSpace(e.target.value)}>
                {spaces.flatMap((x) => [<option key={x.id} value={`${x.id}|`}>{label(x)}</option>,
                  ...projectsIn(x.id).map((p) => <option key={p.id} value={`${x.id}|${p.id}`}>{label(x)} › {p.name}</option>)])}
              </select>
              <button className="btn btn--sm" type="button" onClick={downloadIcs} disabled={dlBusy} aria-busy={dlBusy}>Download .ics</button>
            </span>
            <p className="cal-hint">Every event in that space or project, past and coming, for another calendar app. A copy: later changes are not in it.</p>
          </div>
        )}
        <p className="cal-hint">{editableSpaces.length ? 'Drag across the calendar to add an event.' : 'You can view events here. Ask an owner to make you an editor to add them.'}</p>
        {error && <p className="send-error" role="alert">{error}</p>}
        {note && <p className="slot-status" role="status">{note}</p>}

        {moving && (
          <section className="cal-detail cal-choice" aria-label="Move a repeating event">
            <h3>Move a repeating event</h3>
            <p className="cal-when">"{moving.event.title}" repeats {EVERY[moving.event.extendedProps.series?.repeats] ?? ''}. Move just this one, or all of them by the same amount?</p>
            <span className="pair">
              <button className="btn btn--primary btn--sm" type="button" onClick={() => finishMove('one')}>Just this one</button>
              <button className="btn btn--sm" type="button" onClick={() => finishMove('all')}>All of them</button>
              <button className="btn btn--sm" type="button" onClick={() => finishMove('cancel')}>Cancel</button>
            </span>
          </section>
        )}

        {draft && (
          <form className="cal-form" onSubmit={save} aria-label="New event">
            <p className="cal-when">{when(draft.start, draft.end)}</p>
            <label htmlFor="ev-title">Title</label>
            <input id="ev-title" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label htmlFor="ev-space">Space</label>
            <select id="ev-space" value={`${form.space}|${form.project}`} onChange={(e) => { const [sp, pr = ''] = e.target.value.split('|'); setForm({ ...form, space: sp, project: pr }); }}>
              {editableSpaces.flatMap((s) => [<option key={s.id} value={`${s.id}|`}>{label(s)}</option>,
                ...projectsIn(s.id).map((p) => <option key={p.id} value={`${s.id}|${p.id}`}>{label(s)} › {p.name}</option>)])}
            </select>
            <label htmlFor="ev-loc">Location</label>
            <input id="ev-loc" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            <label htmlFor="ev-repeat">Repeat</label>
            <select id="ev-repeat" value={form.repeats} onChange={(e) => pickRepeat(e.target.value)}>
              <option value="">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
            {form.repeats && <>
              <label htmlFor="ev-until">Until (last day)</label>
              <input id="ev-until" type="date" value={form.until} min={ymd(new Date(draft.start))} onChange={(e) => setForm({ ...form, until: e.target.value })} />
              <p className="cal-hint">Up to a year. Each one gets its own answers and notes.</p>
            </>}
            <span className="pair"><button className="btn btn--primary btn--sm" type="submit" disabled={!form.title.trim()}>Add event</button>
              <button className="btn btn--sm" type="button" onClick={() => setDraft(null)}>Cancel</button></span>
          </form>
        )}

        {open && (
          <section className="cal-detail" aria-label="Event">
            {edit ? (
              <form className="cal-form cal-edit" aria-label="Change event" onSubmit={(e) => { e.preventDefault(); saveEdit('one'); }}>
                <label htmlFor="ev-edit-title">Title</label>
                <input id="ev-edit-title" autoFocus value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                <label htmlFor="ev-edit-loc">Location</label>
                <input id="ev-edit-loc" value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} />
                <span className="pair">
                  <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !edit.title.trim()}>{open.series_id ? 'Save this one' : 'Save'}</button>
                  {open.series_id && <button className="btn btn--sm" type="button" disabled={busy || !edit.title.trim()} onClick={() => saveEdit('all')}>Save all of them</button>}
                  <button className="btn btn--sm" type="button" onClick={() => setEdit(null)}>Cancel</button>
                </span>
              </form>
            ) : <>
              <h3>{open.title}</h3>
              <p className="cal-when">{when(open.starts_at, open.ends_at)}</p>
              {open.location && <p>{open.location}</p>}
            </>}
            {open.series && <p className="cal-repeats">Repeats {EVERY[open.series.repeats]} until {longDay(open.series.until_on)}</p>}
            <p className="docs-meta"><span>{label(spaces.find((s) => s.id === open.space_id))}{open.project_id && projectName(open.project_id) ? ` › ${projectName(open.project_id)}` : ''}</span>{!canEdit(open.space_id) && <span className="docs-status">View only</span>}</p>
            {canEdit(open.space_id) && !edit && (
              <span className="pair cal-actions">
                <button className="btn btn--sm" onClick={() => setEdit({ title: open.title, location: open.location ?? '' })}>Change</button>
                {open.series_id ? <>
                  <button className="btn btn--sm" onClick={() => remove('one')}>Delete this one</button>
                  <button className="btn btn--sm" onClick={() => remove('all')}>Delete all of them</button>
                </> : <button className="btn btn--sm" onClick={() => remove('one')}>Delete</button>}
              </span>
            )}
            {canEdit(open.space_id) && !edit && projectsIn(open.space_id).length > 0 && (
              <span className="pair cal-project-pick">
                <label htmlFor="ev-project">Project</label>
                <select id="ev-project" value={open.project_id || ''} onChange={(e) => setProject(e.target.value)}>
                  <option value="">No project</option>
                  {projectsIn(open.space_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </span>
            )}
            <EventRsvps key={open.id} event={open} me={me} notice={notice} />
            {notes.map((n) => <button key={n.id} type="button" className="btn btn--sm cal-notes" onClick={() => onOpenItem(n.id)}>Meeting notes: {n.item?.title}</button>)}
            {!notes.length && canEdit(open.space_id) && <button type="button" className="btn btn--sm cal-notes" onClick={startNotes}>Start meeting notes</button>}
            <span className="pair">
              <label className="visually-hidden" htmlFor="ev-share">Share to channel</label>
              <select id="ev-share" defaultValue="" onChange={(e) => { if (e.target.value) share(e.target.value); e.target.value = ''; }}>
                <option value="">Share to a channel…</option>
                {spaces.filter((s) => s.kind === 'channel').map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
              <button className="btn btn--sm" onClick={() => { setOpen(null); setEdit(null); setFocusId(null); }}>Close</button>
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
            datesSet={(info) => setRange({ start: info.start.toISOString(), end: info.end.toISOString(), day0: info.startStr.slice(0, 10), day1: info.endStr.slice(0, 10) })}
            select={(info) => { setOpen(null); setEdit(null); setDraft({ start: info.start.toISOString(), end: info.end.toISOString() }); setForm((f) => (onlyP && canEdit(onlyP.space_id) ? { ...f, space: onlyP.space_id, project: onlyP.id } : { ...f, space: f.space || editableSpaces[0]?.id || '' })); }}
            eventClick={(info) => { if (info.event.extendedProps.task) { onOpenItem(info.event.extendedProps.list_id); return; } if (info.event.extendedProps.booking) { onOpenBooking?.(info.event.extendedProps.resource_id); return; } if (info.event.extendedProps.away) { onOpenTimeOff?.(); return; } if (info.event.extendedProps.milestone) { onOpenTimeline?.(info.event.extendedProps.space_id); return; } if (info.event.extendedProps.shift) { onOpenShifts?.(); return; } setDraft(null); setNote(''); setEdit(null); setOpen(info.event.extendedProps); }}
            eventDrop={move}
            eventResize={move}
          />
        )}
      </div>
    </div>
  );
}
