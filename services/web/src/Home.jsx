// Home: the app grid, then the person's widgets. Every widget reads through the API as the person, so it
// shows only what they can open. Which widgets, and their order, are saved per person (weft.user_prefs).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, assistant } from './api.js';
import { dueLabel, today } from './TaskList.jsx';
import { until, useNow } from './Announcements.jsx';
import { heldLabel } from './Meeting.jsx';
import { span } from './Bookings.jsx';
import { shiftSpan } from './Shifts.jsx';

const WIDGETS = {
  announcements: 'Announcements',
  upcoming: 'Coming up',
  yeses: 'Your upcoming yeses',
  bookings: 'Your bookings',
  shifts: 'Your shifts',
  tasks: 'Tasks due soon',
  polls: 'Polls to vote in',
  forms: 'Forms to fill in',
  links: 'New links',
  contacts: 'New contacts',
  profile: 'Your profile',
  meetings: 'Recent meetings',
  unread: 'Unread',
  recent: 'Recently changed',
  files: 'Recent files',
  ask: 'Ask Weft',
};
const DEFAULT = ['announcements', 'upcoming', 'yeses', 'bookings', 'shifts', 'tasks', 'polls', 'forms', 'unread', 'recent', 'ask'];
const KIND = { document: 'Document', wiki: 'Wiki page', whiteboard: 'Whiteboard', table: 'Table', tasklist: 'Task list', poll: 'Poll', form: 'Form', linklist: 'Link list', addressbook: 'Address book', meeting: 'Meeting', file: 'File' };
const where = (s) => (s?.kind === 'channel' ? `#${s.name}` : s?.kind === 'personal' ? 'Personal' : s?.name || '');
const when = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

function Upcoming({ data, onOpenEvent }) {
  if (!data.length) return <p className="widget-empty">Nothing on the calendar in the next two weeks.</p>;
  return <ul className="widget-list">{data.map((e) => (
    <li key={e.id}><button type="button" className="widget-row" onClick={() => onOpenEvent(e.id)}>
      <span className="widget-main">{e.title}</span><span className="widget-sub">{when(e.starts_at)}{e.location ? `, ${e.location}` : ''}, {where(e.space)}</span>
    </button></li>))}</ul>;
}
// Events the person said Going to that have not ended, soonest first. A row opens the event in Calendar.
function Yeses({ data, onOpenEvent }) {
  if (!data.length) return <p className="widget-empty">You have not said Going to anything coming up. Answer in RSVPs or on an event.</p>;
  return <ul className="widget-list">{data.map((e) => (
    <li key={e.id}><button type="button" className="widget-row" onClick={() => onOpenEvent(e.id)}>
      <span className="widget-main">{e.title}</span><span className="widget-sub">{when(e.starts_at)}{e.location ? `, ${e.location}` : ''}, {where(e.space)}</span>
    </button></li>))}</ul>;
}
// The person's own bookings that have not ended, soonest first. A row opens the thing in Bookings.
function MyBookings({ data, onOpenBooking }) {
  if (!data.length) return <p className="widget-empty">You have nothing booked. Book a room or a van in Bookings.</p>;
  return <ul className="widget-list">{data.map((b) => (
    <li key={b.id}><button type="button" className="widget-row" onClick={() => onOpenBooking(b.resource_id)}>
      <span className="widget-main">{b.thing?.name}</span>
      <span className="widget-sub">{new Date(b.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, {span(b.starts_at, b.ends_at)}, {where(b.space)}</span>
    </button></li>))}</ul>;
}
// Shifts the person is on that have not ended, soonest first, with how full each is. A row opens Shifts.
function MyShifts({ data, onOpenShifts }) {
  if (!data.length) return <p className="widget-empty">You are not on any shift coming up. Take a place in Shifts.</p>;
  return <ul className="widget-list">{data.map((s) => (
    <li key={s.id}><button type="button" className="widget-row" onClick={() => onOpenShifts(s.id)}>
      <span className="widget-main">{s.title}</span>
      <span className="widget-sub">{new Date(s.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, {shiftSpan(s.starts_at, s.ends_at)}, {where(s.space)}, {s.signups.length} of {s.places} places taken</span>
    </button></li>))}</ul>;
}
// Open tasks due in the next seven days or overdue, yours first. A row opens its list.
function TasksDue({ data, me, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open tasks due in the next week.</p>;
  return <ul className="widget-list">{data.map((t) => (
    <li key={t.id}><button type="button" className="widget-row" onClick={() => onOpenItem(t.list_id)}>
      <span className="widget-main">{t.title}</span>
      <span className={`widget-sub${t.due_on < today() ? ' is-late' : ''}`}>{dueLabel(t.due_on)}, {t.assignee_id === me.id ? 'you' : t.assignee?.display_name || 'no one'}, {t.list?.title} in {where(t.list?.space)}</span>
    </button></li>))}</ul>;
}
// Open polls the person has not voted in yet, newest first. A row opens the poll.
function PollsToVote({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open polls waiting for your vote.</p>;
  return <ul className="widget-list">{data.map((p) => (
    <li key={p.id}><button type="button" className="widget-row" onClick={() => onOpenItem(p.id)}>
      <span className="widget-main">{p.title}</span><span className="widget-sub">Poll in {where(p.space)}, {ago(p.updated_at)}</span>
    </button></li>))}</ul>;
}
// Open forms the person has not answered yet, newest first. A row opens the form.
function FormsToFill({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open forms waiting for you.</p>;
  return <ul className="widget-list">{data.map((f) => (
    <li key={f.id}><button type="button" className="widget-row" onClick={() => onOpenItem(f.id)}>
      <span className="widget-main">{f.title}</span><span className="widget-sub">Form in {where(f.space)}, {ago(f.updated_at)}</span>
    </button></li>))}</ul>;
}
// The newest contacts in address books the person can see. A row opens the book.
function NewContacts({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No contacts yet. Add them in Contacts.</p>;
  return <ul className="widget-list">{data.map((c) => (
    <li key={c.id}><button type="button" className="widget-row" onClick={() => onOpenItem(c.book_id)}>
      <span className="widget-main">{c.name}{c.organisation ? `, ${c.organisation}` : ''}</span><span className="widget-sub">{c.book?.title} in {where(c.book?.space)}, {ago(c.created_at)}</span>
    </button></li>))}</ul>;
}
// The newest links in lists the person can see. A row opens the list (the link itself opens from there).
function NewLinks({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No links yet. Add them in Links.</p>;
  return <ul className="widget-list">{data.map((l) => (
    <li key={l.id}><button type="button" className="widget-row" onClick={() => onOpenItem(l.list_id)}>
      <span className="widget-main">{l.title}</span><span className="widget-sub">{l.list?.title} in {where(l.list?.space)}, {ago(l.created_at)}</span>
    </button></li>))}</ul>;
}
// Current announcements in every channel the person is in, newest first. A row opens Announcements there.
function Notices({ data, onOpenNotices }) {
  const now = useNow();
  const rows = data.filter((a) => new Date(a.expires_at).getTime() > now);
  if (!rows.length) return <p className="widget-empty">No announcements right now.</p>;
  return <ul className="widget-list">{rows.map((a) => (
    <li key={a.id}><button type="button" className="widget-row" onClick={() => onOpenNotices(a.space_id)}>
      <span className="widget-main">{a.title}</span>
      {a.body && <span className="widget-note">{a.body}</span>}
      <span className="widget-sub">{where(a.space)}, until {until(a.expires_at)}</span>
    </button></li>))}</ul>;
}
// The latest meetings the person can see, by when they are held. A row opens the meeting.
function Meetings({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No meetings yet. Start one in Meetings.</p>;
  return <ul className="widget-list">{data.map((m) => (
    <li key={m.id}><button type="button" className="widget-row" onClick={() => onOpenItem(m.id)}>
      <span className="widget-main">{m.item?.title}</span><span className="widget-sub">{where(m.item?.space)}{m.held_at ? `, ${heldLabel(m.held_at)}` : ''}</span>
    </button></li>))}</ul>;
}
// The person's own profile, or a nudge to fill it in. The button opens Profiles.
function MyProfile({ data, onOpenProfiles }) {
  const p = data[0];
  const has = p && (p.role || p.skills?.length || p.reach || p.availability);
  if (!has) return <><p className="widget-empty">You have not filled in your profile. People you share a space with will see it.</p>
    <button type="button" className="btn btn--sm" onClick={onOpenProfiles}>Fill in your profile</button></>;
  return <ul className="widget-list"><li><button type="button" className="widget-row" onClick={onOpenProfiles}>
    <span className="widget-main">{p.role || 'No role given'}</span>
    {p.skills?.length > 0 && <span className="widget-note">{p.skills.join(', ')}</span>}
    <span className="widget-sub">{p.availability || p.reach || 'Open Profiles to add how and when to reach you'}</span>
  </button></li></ul>;
}
function Unread({ unread, spaces, onOpenConvo }) {
  const rows = unread.filter((u) => u.unread > 0).map((u) => ({ ...u, space: spaces.find((s) => s.id === u.space_id) })).filter((u) => u.space);
  if (!rows.length) return <p className="widget-empty">You're all caught up.</p>;
  return <ul className="widget-list">{rows.map((u) => (
    <li key={u.space_id}><button type="button" className="widget-row" onClick={() => onOpenConvo(u.space_id)}>
      <span className="widget-main">{u.space.kind === 'channel' ? `#${u.space.name}` : u.space.kind === 'assistant' ? 'Weft' : 'Direct message'}</span>
      <span className="widget-sub">{u.unread} unread{u.mentions ? `, ${u.mentions} mention${u.mentions > 1 ? 's' : ''} of you` : ''}</span>
    </button></li>))}</ul>;
}
function Items({ data, onOpenItem, empty }) {
  if (!data.length) return <p className="widget-empty">{empty}</p>;
  return <ul className="widget-list">{data.map((i) => (
    <li key={i.id}><button type="button" className="widget-row" onClick={() => onOpenItem(i.id)}>
      <span className="widget-main">{i.title}</span><span className="widget-sub">{KIND[i.kind] || 'Item'}, {where(i.space)}, {ago(i.updated_at)}</span>
    </button></li>))}</ul>;
}
function Ask({ assistantSpace, onAsked }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!assistantSpace) return <p className="widget-empty">Your Weft conversation is being set up.</p>;
  return (
    <form className="widget-ask" onSubmit={async (e) => {
      e.preventDefault(); const body = q.trim(); if (!body) return;
      setBusy(true); setError('');
      try {
        const [m] = await api('/messages', { method: 'POST', body: { space_id: assistantSpace.id, body }, prefer: 'return=representation' });
        setQ(''); onAsked();
        await assistant('/ask', { method: 'POST', body: { message_id: m.id, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      } catch (err) { setError(err.message); }
      setBusy(false);
    }}>
      <label className="visually-hidden" htmlFor="home-ask">Ask Weft</label>
      <input id="home-ask" placeholder="Ask about anything you can open" value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !q.trim()}>{busy ? 'Asking…' : 'Ask'}</button>
      {error && <p className="send-error" role="alert">{error}</p>}
      <p className="widget-sub">The answer appears in your Weft conversation, with links to where it came from.</p>
    </form>
  );
}

export default function Widgets({ me, spaces, unread, notice, onOpenItem, onOpenEvent, onOpenNotices, onOpenBooking, onOpenShifts, onOpenProfiles, onOpenConvo }) {
  const [order, setOrder] = useState(null);
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState({ announcements: [], upcoming: [], yeses: [], bookings: [], shifts: [], tasks: [], polls: [], forms: [], links: [], contacts: [], profile: [], meetings: [], recent: [], files: [] });
  const [error, setError] = useState('');
  const timer = useRef(null);

  useEffect(() => {
    api('/user_prefs?select=home').then(([p]) => {
      const w = p?.home?.widgets;
      setOrder(Array.isArray(w) ? w.filter((k) => WIDGETS[k]) : DEFAULT);
    }).catch(() => setOrder(DEFAULT));
  }, []);
  const save = async (next) => {
    setOrder(next);
    try { await api('/user_prefs?on_conflict=user_id', { method: 'POST', body: { home: { widgets: next } }, prefer: 'resolution=merge-duplicates,return=minimal' }); }
    catch (e) { setError(`Your layout was not saved: ${e.message}`); }
  };

  const load = useCallback(async () => {
    const now = new Date(); const soon = new Date(now.getTime() + 14 * 86400000);
    try {
      const week = new Date(Date.now() + 7 * 86400000); week.setMinutes(week.getMinutes() - week.getTimezoneOffset());
      const [upcoming, recent, files, due, open, openForms, links, announcements, meetings, yeses, bookings, onShifts, contacts, profile] = await Promise.all([
        api(`/events?ends_at=gte.${now.toISOString()}&starts_at=lte.${soon.toISOString()}&select=id,title,starts_at,location,space:spaces(name,kind)&order=starts_at&limit=5`),
        api('/items?select=id,title,kind,updated_at,space:spaces(name,kind)&order=updated_at.desc&limit=6'),
        api('/items?kind=eq.file&select=id,title,kind,updated_at,space:spaces(name,kind)&order=updated_at.desc&limit=5'),
        api(`/tasks?done=is.false&due_on=lte.${week.toISOString().slice(0, 10)}&select=id,title,due_on,assignee_id,list_id,assignee:users!tasks_assignee_id_fkey(display_name),list:items(title,space:spaces(name,kind))&order=due_on,position&limit=40`),
        api(`/items?kind=eq.poll&select=id,title,updated_at,space:spaces(name,kind),state:polls(closed),mine:poll_votes(voter_id)&mine.voter_id=eq.${me.id}&order=updated_at.desc&limit=40`),
        api(`/items?kind=eq.form&select=id,title,updated_at,space:spaces(name,kind),state:forms(closed),mine:form_responses(respondent_id)&mine.respondent_id=eq.${me.id}&order=updated_at.desc&limit=40`),
        api('/links?select=id,title,list_id,created_at,list:items(title,space:spaces(name,kind))&order=created_at.desc&limit=5'),
        api('/announcements?expires_at=gt.now&select=id,space_id,title,body,expires_at,space:spaces(name,kind)&order=created_at.desc&limit=6'),
        api('/meetings?select=id,held_at,item:items!meetings_id_fkey(title,space:spaces(name,kind))&order=held_at.desc.nullslast&limit=5'),
        api(`/events?ends_at=gte.${now.toISOString()}&select=id,title,starts_at,location,space:spaces(name,kind),mine:rsvps!inner(answer)&mine.user_id=eq.${me.id}&mine.answer=eq.going&order=starts_at&limit=5`),
        api(`/bookings?booked_by=eq.${me.id}&ends_at=gt.${now.toISOString()}&select=id,resource_id,starts_at,ends_at,thing:resources(name),space:spaces(name,kind)&order=starts_at&limit=5`),
        api(`/shifts?ends_at=gt.${now.toISOString()}&select=id,title,starts_at,ends_at,places,space:spaces(name,kind),signups:shift_signups(user_id)&order=starts_at&limit=300`),
        api('/contacts?select=id,name,organisation,book_id,created_at,book:items(title,space:spaces(name,kind))&order=created_at.desc&limit=5'),
        api(`/profiles?user_id=eq.${me.id}&select=role,skills,reach,availability`),
      ]);
      const shifts = onShifts.filter((s) => s.signups.some((x) => x.user_id === me.id)).slice(0, 5);
      const tasks = [...due.filter((t) => t.assignee_id === me.id), ...due.filter((t) => t.assignee_id !== me.id)].slice(0, 6);
      const isClosed = (p) => (Array.isArray(p.state) ? p.state[0]?.closed : p.state?.closed);
      const polls = open.filter((p) => !isClosed(p) && !p.mine?.length).slice(0, 5);
      const forms = openForms.filter((f) => !isClosed(f) && !f.mine?.length).slice(0, 5);
      setData({ announcements, upcoming, yeses, bookings, shifts, tasks, polls, forms, links, contacts, profile, meetings, recent, files }); setError('');
    } catch (e) { setError(`Widgets could not load: ${e.message}`); }
  }, [me.id]);
  useEffect(() => { load(); }, [load]);
  // Live: refresh shortly after anything they show changes (several notices in a row refresh once).
  useEffect(() => {
    if (!notice || !['events', 'items', 'members', 'tasks', 'polls', 'forms', 'links', 'contacts', 'announcements', 'meetings', 'rsvps', 'bookings', 'resources', 'shifts', 'shift_signups', 'profiles'].includes(notice.t)) return;
    clearTimeout(timer.current); timer.current = setTimeout(load, 400);
  }, [notice, load]);

  if (!order) return null;
  const assistantSpace = spaces.find((s) => s.kind === 'assistant');
  const body = (k) => (k === 'announcements' ? <Notices data={data.announcements} onOpenNotices={onOpenNotices} />
    : k === 'upcoming' ? <Upcoming data={data.upcoming} onOpenEvent={onOpenEvent} />
    : k === 'yeses' ? <Yeses data={data.yeses} onOpenEvent={onOpenEvent} />
    : k === 'bookings' ? <MyBookings data={data.bookings} onOpenBooking={onOpenBooking} />
    : k === 'shifts' ? <MyShifts data={data.shifts} onOpenShifts={onOpenShifts} />
    : k === 'tasks' ? <TasksDue data={data.tasks} me={me} onOpenItem={onOpenItem} />
    : k === 'polls' ? <PollsToVote data={data.polls} onOpenItem={onOpenItem} />
    : k === 'forms' ? <FormsToFill data={data.forms} onOpenItem={onOpenItem} />
    : k === 'links' ? <NewLinks data={data.links} onOpenItem={onOpenItem} />
    : k === 'contacts' ? <NewContacts data={data.contacts} onOpenItem={onOpenItem} />
    : k === 'profile' ? <MyProfile data={data.profile} onOpenProfiles={onOpenProfiles} />
    : k === 'meetings' ? <Meetings data={data.meetings} onOpenItem={onOpenItem} />
    : k === 'unread' ? <Unread unread={unread} spaces={spaces} onOpenConvo={onOpenConvo} />
    : k === 'recent' ? <Items data={data.recent} onOpenItem={onOpenItem} empty="Nothing has been written yet." />
    : k === 'files' ? <Items data={data.files} onOpenItem={onOpenItem} empty="No files yet. Upload them in Files." />
    : <Ask assistantSpace={assistantSpace} onAsked={() => onOpenConvo('weft')} />);
  const move = (k, d) => { const i = order.indexOf(k); const j = i + d; if (j < 0 || j >= order.length) return; const n = [...order]; [n[i], n[j]] = [n[j], n[i]]; save(n); };

  return (
    <section className="widgets-area" aria-labelledby="widgets-title">
      <div className="widgets-head">
        <h2 id="widgets-title" className="home-title">Your widgets</h2>
        <button className="btn btn--sm" type="button" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>{editing ? 'Done' : 'Customize'}</button>
      </div>
      {error && <p className="send-error" role="alert">{error}</p>}
      {editing && (
        <ul className="widget-picker" aria-label="Choose widgets">
          {Object.entries(WIDGETS).map(([k, label]) => {
            const on = order.includes(k);
            return (
              <li key={k} className="pair">
                <label className="toggle"><input type="checkbox" checked={on} onChange={() => save(on ? order.filter((x) => x !== k) : [...order, k])} /> {label}</label>
                {on && <span className="pair">
                  <button className="btn btn--sm" type="button" onClick={() => move(k, -1)} disabled={order.indexOf(k) === 0}>Earlier<span className="visually-hidden"> {label}</span></button>
                  <button className="btn btn--sm" type="button" onClick={() => move(k, 1)} disabled={order.indexOf(k) === order.length - 1}>Later<span className="visually-hidden"> {label}</span></button>
                </span>}
              </li>
            );
          })}
        </ul>
      )}
      {!order.length ? <p className="widget-empty">No widgets. Press Customize to add some.</p> : (
        <div className="widgets">
          {order.map((k) => (
            <article key={k} className="widget" aria-labelledby={`widget-${k}`}>
              <h3 id={`widget-${k}`}>{WIDGETS[k]}</h3>
              {body(k)}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
