// Home: the app grid, then the person's widgets. Every widget reads through the API as the person, so it
// shows only what they can open. Which widgets, and their order, are saved per person (weft.user_prefs).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, assistant } from './api.js';
import { dueLabel, today } from './TaskList.jsx';
import { until, useNow } from './Announcements.jsx';
import { heldLabel } from './Meeting.jsx';
import { span } from './Bookings.jsx';
import { shiftSpan } from './Shifts.jsx';
import { money } from './Expenses.jsx';
import { addDays, dayKey, daysLabel, weekStart } from './TimeOff.jsx';
import { Bar, setProgress } from './Goals.jsx';
import { nameOf } from './Kudos.jsx';

const WIDGETS = {
  announcements: 'Announcements',
  upcoming: 'Coming up',
  yeses: 'Your upcoming yeses',
  bookings: 'Your bookings',
  shifts: 'Your shifts',
  away: 'Out this week',
  tasks: 'Tasks due soon',
  polls: 'Polls to vote in',
  forms: 'Forms to fill in',
  links: 'New links',
  contacts: 'New contacts',
  glossary: 'New terms',
  ideas: 'Top ideas',
  kudos: 'Recent kudos',
  decisions: 'Recent decisions',
  questions: 'Open questions',
  checklists: 'Checklists in progress',
  balances: 'Your balances',
  holding: 'Things you have',
  goals: 'Goal progress',
  retros: 'Open retro actions',
  profile: 'Your profile',
  meetings: 'Recent meetings',
  unread: 'Unread',
  recent: 'Recently changed',
  files: 'Recent files',
  ask: 'Ask Weft',
};
const DEFAULT = ['announcements', 'upcoming', 'yeses', 'bookings', 'shifts', 'away', 'tasks', 'polls', 'forms', 'unread', 'recent', 'ask'];
const KIND = { document: 'Document', wiki: 'Wiki page', whiteboard: 'Whiteboard', table: 'Table', tasklist: 'Task list', poll: 'Poll', form: 'Form', linklist: 'Link list', addressbook: 'Address book', decisionlog: 'Decision log', qa: 'Q and A board', checklist: 'Checklist', expenselist: 'Expense list', inventory: 'Inventory', goalset: 'Goal set', retro: 'Retro', glossary: 'Glossary', ideaboard: 'Ideas board', meeting: 'Meeting', file: 'File' };
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
// Who is away at some point this week (Monday to Sunday), soonest first. The same person and days recorded in
// two channels show once, with both channels. A row opens Time off.
function OutThisWeek({ data, me, onOpenTimeOff }) {
  if (!data.length) return <p className="widget-empty">Nobody is away this week.</p>;
  const today = dayKey(new Date());
  const rows = [];
  for (const r of data) {
    const same = rows.find((x) => x.user_id === r.user_id && x.starts_on === r.starts_on && x.ends_on === r.ends_on);
    if (same) { if (!same.where.includes(where(r.space))) same.where.push(where(r.space)); } else rows.push({ ...r, where: [where(r.space)] });
  }
  return <ul className="widget-list">{rows.slice(0, 8).map((r) => (
    <li key={r.id}><button type="button" className="widget-row" onClick={() => onOpenTimeOff()}>
      <span className="widget-main">{r.user_id === me.id ? 'You' : r.who?.display_name ?? 'Someone'}{r.starts_on <= today && r.ends_on >= today ? ', away today' : ''}</span>
      <span className="widget-sub">{daysLabel(r.starts_on, r.ends_on)}{r.note ? `, ${r.note}` : ''}, {r.where.join(', ')}</span>
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
// The newest questions without an accepted answer, on Q and A boards the person can see. A row opens the board.
function OpenQuestions({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open questions. Ask one in Q and A.</p>;
  return <ul className="widget-list">{data.map((q) => (
    <li key={q.id}><button type="button" className="widget-row" onClick={() => onOpenItem(q.board_id)}>
      <span className="widget-main">{q.title}</span><span className="widget-sub">{q.answers.length ? `${q.answers.length} answer${q.answers.length === 1 ? '' : 's'}` : 'No answers yet'}, {q.board?.title} in {where(q.board?.space)}</span>
    </button></li>))}</ul>;
}
// Checklist runs not finished yet, newest first, with how far each has got. A row opens the checklist.
function ChecklistsInProgress({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No checklists in progress. Start a run in Checklists.</p>;
  return <ul className="widget-list">{data.map((r) => {
    const done = r.steps.filter((s) => s.done).length;
    return (<li key={r.id}><button type="button" className="widget-row" onClick={() => onOpenItem(r.checklist_id)}>
      <span className="widget-main">{r.label || r.checklist?.title}</span><span className="widget-sub">{done} of {r.steps.length} done{r.label ? `, ${r.checklist?.title}` : ''} in {where(r.checklist?.space)}, started {ago(r.started_at)}</span>
    </button></li>);
  })}</ul>;
}
// Where the person is owed or owes money: their running balance in each expense list where it is not zero.
// A row opens the list.
function MyBalances({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">You are even everywhere. Shared costs are in Expenses.</p>;
  return <ul className="widget-list">{data.map((b) => (
    <li key={b.list_id}><button type="button" className="widget-row" onClick={() => onOpenItem(b.list_id)}>
      <span className="widget-main">{b.net_cents > 0 ? `You are owed ${money(b.net_cents)}` : `You owe ${money(-b.net_cents)}`}</span><span className="widget-sub">{b.list?.title} in {where(b.list?.space)}</span>
    </button></li>))}</ul>;
}
// Things checked out to the person, longest held first, with the inventory they belong to. A row opens it.
function ThingsYouHave({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">You have nothing checked out. Shared things are in Inventory.</p>;
  return <ul className="widget-list">{data.map((t) => (
    <li key={t.id}><button type="button" className="widget-row" onClick={() => onOpenItem(t.inventory_id)}>
      <span className="widget-main">{t.name}</span><span className="widget-sub">since {new Date(t.held_since).toLocaleDateString([], { day: 'numeric', month: 'short' })}, {t.inventory?.title} in {where(t.inventory?.space)}</span>
    </button></li>))}</ul>;
}
// Goal sets the person can see, most recently changed first, each with its overall progress. A row opens it.
function GoalProgress({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No goals yet. Set them in Goals.</p>;
  return <ul className="widget-list">{data.map((s) => {
    const p = setProgress((s.goals || []).map((g) => ({ krs: g.krs })));
    return (
      <li key={s.id}><button type="button" className="widget-row widget-goal" onClick={() => onOpenItem(s.id)}>
        <span className="widget-main">{s.title}<span className="widget-goal-pct">{p == null ? '' : ` ${Math.round(p * 100)}%`}</span></span>
        <Bar value={p} label={`Progress of ${s.title}`} />
        <span className="widget-sub">{(s.goals || []).length} goal{(s.goals || []).length === 1 ? '' : 's'} in {where(s.space)}</span>
      </button></li>
    );
  })}</ul>;
}
// Actions from retros the person can see that are not yet a task, or whose task is not done, newest first.
// A row opens the retro.
function RetroActions({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open actions. Look back on a period in Retros.</p>;
  return <ul className="widget-list">{data.map((n) => (
    <li key={n.id}><button type="button" className="widget-row" onClick={() => onOpenItem(n.retro_id)}>
      <span className="widget-main">{n.body}</span>
      <span className="widget-sub">{n.task ? 'Task open' : 'Not a task yet'}, {n.retro?.title} in {where(n.retro?.space)}</span>
    </button></li>))}</ul>;
}
// The most recently decided decisions in logs the person can see. A row opens the log.
function RecentDecisions({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No decisions yet. Write them down in Decisions.</p>;
  const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return <ul className="widget-list">{data.map((d) => (
    <li key={d.id}><button type="button" className="widget-row" onClick={() => onOpenItem(d.log_id)}>
      <span className="widget-main">{d.title}</span><span className="widget-sub">{day(d.decided_on)}{d.decided_by ? `, ${d.decided_by}` : ''}, {d.log?.title} in {where(d.log?.space)}</span>
    </button></li>))}</ul>;
}
// Open ideas (new or planned) with the most votes, on boards the person can see. A row opens the board.
function TopIdeas({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No open ideas. Suggest one in Ideas.</p>;
  return <ul className="widget-list">{data.map((d) => (
    <li key={d.id}><button type="button" className="widget-row" onClick={() => onOpenItem(d.board_id)}>
      <span className="widget-main">{d.title}</span><span className="widget-sub">{d.votes.length} vote{d.votes.length === 1 ? '' : 's'}{d.status === 'planned' ? ', planned' : ''}, {d.board?.title} in {where(d.board?.space)}</span>
    </button></li>))}</ul>;
}
// The newest terms in glossaries the person can see. A row opens the glossary.
function NewTerms({ data, onOpenItem }) {
  if (!data.length) return <p className="widget-empty">No terms yet. Add them in Glossary.</p>;
  return <ul className="widget-list">{data.map((t) => (
    <li key={t.id}><button type="button" className="widget-row" onClick={() => onOpenItem(t.glossary_id)}>
      <span className="widget-main">{t.term}</span><span className="widget-sub">{t.glossary?.title} in {where(t.glossary?.space)}, {ago(t.created_at)}</span>
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
// The newest kudos in every channel the person is in. A row opens that channel's wall.
function RecentKudos({ data, onOpenKudos }) {
  if (!data.length) return <p className="widget-empty">No kudos yet. Thank someone in Kudos.</p>;
  return <ul className="widget-list">{data.map((k) => (
    <li key={k.id}><button type="button" className="widget-row" onClick={() => onOpenKudos(k.space_id)}>
      <span className="widget-main">For {nameOf(k.to)}</span>
      <span className="widget-note">{k.message}</span>
      <span className="widget-sub">From {nameOf(k.from)}, {where(k.space)}, {ago(k.created_at)}</span>
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

export default function Widgets({ me, spaces, unread, notice, onOpenItem, onOpenEvent, onOpenNotices, onOpenKudos, onOpenBooking, onOpenShifts, onOpenProfiles, onOpenTimeOff, onOpenConvo }) {
  const [order, setOrder] = useState(null);
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState({ announcements: [], upcoming: [], yeses: [], bookings: [], shifts: [], away: [], tasks: [], polls: [], forms: [], links: [], contacts: [], glossary: [], ideas: [], kudos: [], decisions: [], questions: [], checklists: [], balances: [], holding: [], goals: [], retros: [], profile: [], meetings: [], recent: [], files: [] });
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
      const [upcoming, recent, files, due, open, openForms, links, announcements, meetings, yeses, bookings, onShifts, contacts, profile, decisions, questions, checklists, owed, holding, away, goals, retroActions, glossary, openIdeas, kudos] = await Promise.all([
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
        api('/decisions?select=id,title,decided_by,decided_on,log_id,log:items(title,space:spaces(name,kind))&order=decided_on.desc,created_at.desc&limit=5'),
        api('/questions?accepted_id=is.null&select=id,title,board_id,board:items(title,space:spaces(name,kind)),answers:answers!answers_question_id_fkey(id)&order=created_at.desc&limit=5'),
        api('/checklist_runs?finished=is.false&select=id,label,started_at,checklist_id,checklist:items(title,space:spaces(name,kind)),steps:checklist_run_steps(done)&order=started_at.desc&limit=5'),
        api(`/expense_balances?user_id=eq.${me.id}&net_cents=neq.0&select=list_id,net_cents`),
        api(`/inventory_things?holder_id=eq.${me.id}&select=id,name,held_since,inventory_id,inventory:items(title,space:spaces(name,kind))&order=held_since&limit=6`),
        (() => { const mon = weekStart(dayKey(now)); return api(`/time_off?starts_on=lte.${addDays(mon, 6)}&ends_on=gte.${mon}&select=id,user_id,starts_on,ends_on,note,who:users!time_off_user_id_fkey(display_name),space:spaces(name,kind)&order=starts_on,ends_on&limit=60`); })(),
        api('/items?kind=eq.goalset&select=id,title,updated_at,space:spaces(name,kind),goals(krs:key_results(progress))&order=updated_at.desc&limit=5'),
        api(`/retro_notes?kind=eq.action&created_at=gte.${new Date(Date.now() - 60 * 86400000).toISOString()}&select=id,body,retro_id,task:tasks(done),retro:items(title,space:spaces(name,kind))&order=created_at.desc&limit=40`),
        api('/glossary_terms?select=id,term,glossary_id,created_at,glossary:items(title,space:spaces(name,kind))&order=created_at.desc&limit=5'),
        api('/ideas?status=in.(new,planned)&select=id,title,status,board_id,created_at,votes:idea_votes(voter_id),board:items(title,space:spaces(name,kind))&order=created_at.desc&limit=100'),
        api('/kudos?select=id,space_id,message,created_at,to:users!kudos_to_user_fkey(display_name),from:users!kudos_created_by_fkey(display_name),space:spaces(name,kind)&order=created_at.desc&limit=5'),
      ]);
      const lists = owed.length ? await api(`/items?id=in.(${owed.map((b) => b.list_id).join(',')})&select=id,title,updated_at,space:spaces(name,kind)&order=updated_at.desc`) : [];
      const balances = lists.slice(0, 5).map((l) => ({ ...owed.find((b) => b.list_id === l.id), list: l }));
      const shifts = onShifts.filter((s) => s.signups.some((x) => x.user_id === me.id)).slice(0, 5);
      const tasks = [...due.filter((t) => t.assignee_id === me.id), ...due.filter((t) => t.assignee_id !== me.id)].slice(0, 6);
      const isClosed = (p) => (Array.isArray(p.state) ? p.state[0]?.closed : p.state?.closed);
      const polls = open.filter((p) => !isClosed(p) && !p.mine?.length).slice(0, 5);
      const ideas = [...openIdeas].sort((a, b) => b.votes.length - a.votes.length || b.created_at.localeCompare(a.created_at)).slice(0, 5);
      const retros = retroActions.filter((n) => !n.task?.done).slice(0, 5);
      const forms = openForms.filter((f) => !isClosed(f) && !f.mine?.length).slice(0, 5);
      setData({ announcements, upcoming, yeses, bookings, shifts, away, tasks, polls, forms, links, contacts, glossary, ideas, kudos, decisions, questions, checklists, balances, holding, goals, retros, profile, meetings, recent, files }); setError('');
    } catch (e) { setError(`Widgets could not load: ${e.message}`); }
  }, [me.id]);
  useEffect(() => { load(); }, [load]);
  // Live: refresh shortly after anything they show changes (several notices in a row refresh once).
  useEffect(() => {
    if (!notice || !['events', 'items', 'members', 'tasks', 'polls', 'forms', 'links', 'contacts', 'glossary', 'ideas', 'kudos', 'decisions', 'qa', 'checklists', 'expenses', 'inventory', 'goals', 'retros', 'announcements', 'meetings', 'rsvps', 'bookings', 'resources', 'shifts', 'shift_signups', 'profiles', 'time_off'].includes(notice.t)) return;
    clearTimeout(timer.current); timer.current = setTimeout(load, 400);
  }, [notice, load]);

  if (!order) return null;
  const assistantSpace = spaces.find((s) => s.kind === 'assistant');
  const body = (k) => (k === 'announcements' ? <Notices data={data.announcements} onOpenNotices={onOpenNotices} />
    : k === 'upcoming' ? <Upcoming data={data.upcoming} onOpenEvent={onOpenEvent} />
    : k === 'yeses' ? <Yeses data={data.yeses} onOpenEvent={onOpenEvent} />
    : k === 'bookings' ? <MyBookings data={data.bookings} onOpenBooking={onOpenBooking} />
    : k === 'shifts' ? <MyShifts data={data.shifts} onOpenShifts={onOpenShifts} />
    : k === 'away' ? <OutThisWeek data={data.away} me={me} onOpenTimeOff={onOpenTimeOff} />
    : k === 'tasks' ? <TasksDue data={data.tasks} me={me} onOpenItem={onOpenItem} />
    : k === 'polls' ? <PollsToVote data={data.polls} onOpenItem={onOpenItem} />
    : k === 'forms' ? <FormsToFill data={data.forms} onOpenItem={onOpenItem} />
    : k === 'links' ? <NewLinks data={data.links} onOpenItem={onOpenItem} />
    : k === 'contacts' ? <NewContacts data={data.contacts} onOpenItem={onOpenItem} />
    : k === 'glossary' ? <NewTerms data={data.glossary} onOpenItem={onOpenItem} />
    : k === 'ideas' ? <TopIdeas data={data.ideas} onOpenItem={onOpenItem} />
    : k === 'kudos' ? <RecentKudos data={data.kudos} onOpenKudos={onOpenKudos} />
    : k === 'decisions' ? <RecentDecisions data={data.decisions} onOpenItem={onOpenItem} />
    : k === 'questions' ? <OpenQuestions data={data.questions} onOpenItem={onOpenItem} />
    : k === 'checklists' ? <ChecklistsInProgress data={data.checklists} onOpenItem={onOpenItem} />
    : k === 'balances' ? <MyBalances data={data.balances} onOpenItem={onOpenItem} />
    : k === 'holding' ? <ThingsYouHave data={data.holding} onOpenItem={onOpenItem} />
    : k === 'goals' ? <GoalProgress data={data.goals} onOpenItem={onOpenItem} />
    : k === 'retros' ? <RetroActions data={data.retros} onOpenItem={onOpenItem} />
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
