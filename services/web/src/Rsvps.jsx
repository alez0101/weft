// RSVPs: Going, Maybe or Not going on a calendar event. Everyone in the event's space (viewers too) answers
// for themselves and sees who else is coming; nobody answers for someone else. Once an event has ended its
// answers are fixed. The same box shows on the event in Calendar; this app lists upcoming events from every
// space you can see, with a filter. Row-level security decides; when it says no, the reason is shown and the
// answers are reloaded. Live: an rsvps or events notice refetches.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

export const ANSWERS = [
  { id: 'going', label: 'Going' },
  { id: 'maybe', label: 'Maybe' },
  { id: 'no', label: 'Not going' },
];
const SEL = 'event_id,user_id,answer,updated_at,user:users(display_name)';
const where = (s) => (s?.kind === 'channel' ? `#${s.name}` : s?.kind === 'personal' ? 'Personal' : s?.name || '');
export const eventWhen = (a, b) => {
  const s = new Date(a); const e = new Date(b);
  const t = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${t(s)} to ${t(e)}`;
};
const dayOf = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
export const countsLabel = (answers) => {
  const n = (k) => answers.filter((a) => a.answer === k).length;
  const parts = [n('going') && `${n('going')} going`, n('maybe') && `${n('maybe')} maybe`, n('no') && `${n('no')} not going`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No answers yet';
};

// Set, change or clear the person's own answer (null clears it).
async function saveAnswer(eventId, meId, had, answer) {
  if (!answer) return api(`/rsvps?event_id=eq.${eventId}&user_id=eq.${meId}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (had) return api(`/rsvps?event_id=eq.${eventId}&user_id=eq.${meId}`, { method: 'PATCH', body: { answer }, prefer: 'return=minimal' });
  return api('/rsvps', { method: 'POST', body: { event_id: eventId, answer }, prefer: 'return=minimal' });
}

// The three buttons, the counts and who answered what. Pure: the caller owns the data.
export function RsvpBox({ event, answers, me, onSet, error }) {
  const ended = new Date(event.ends_at).getTime() < Date.now();
  const mine = answers.find((a) => a.user_id === me.id)?.answer || null;
  const names = (k) => answers.filter((a) => a.answer === k)
    .sort((a, b) => (a.user_id === me.id ? -1 : b.user_id === me.id ? 1 : (a.user?.display_name || '').localeCompare(b.user?.display_name || '')))
    .map((a) => (a.user_id === me.id ? 'You' : a.user?.display_name || 'Someone'));
  return (
    <div className="rsvp">
      <div className="rsvp-buttons" role="group" aria-label={`Your answer for ${event.title}`}>
        {ANSWERS.map((o) => {
          const n = answers.filter((a) => a.answer === o.id).length;
          return (
            <button key={o.id} type="button" className={`btn btn--sm rsvp-btn rsvp-${o.id}`} aria-pressed={mine === o.id} disabled={ended}
              title={mine === o.id && !ended ? 'Press again to clear your answer' : undefined}
              onClick={() => onSet(mine === o.id ? null : o.id)}>
              {o.label}<span className="rsvp-n" aria-label={`, ${n} so far`}>{n}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="send-error" role="alert">{error}</p>}
      {ANSWERS.filter((o) => o.id !== 'no').map((o) => {
        const who = names(o.id);
        return who.length > 0 && <p key={o.id} className="rsvp-who"><span className="rsvp-who-label">{o.label}:</span> {who.join(', ')}</p>;
      })}
      {names('no').length > 0 && <p className="rsvp-who rsvp-who--no"><span className="rsvp-who-label">Not going:</span> {names('no').join(', ')}</p>}
      {ended && <p className="rsvp-note">This event has ended, so the answers stay as they were.</p>}
    </div>
  );
}

// The box for one event, loading its own answers (used on the event in Calendar).
export function EventRsvps({ event, me, notice }) {
  const [answers, setAnswers] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/rsvps?event_id=eq.${event.id}&select=${SEL}&order=updated_at`).then(setAnswers), [event.id]);
  useEffect(() => { setAnswers(null); setError(''); load().catch((e) => setError(`Answers could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (notice?.t === 'rsvps' && notice.event === event.id) load().catch(() => {}); }, [notice, event.id, load]);
  if (!answers) return error ? <p className="send-error" role="alert">{error}</p> : null;
  const had = answers.some((a) => a.user_id === me.id);
  const set = async (answer) => {
    setAnswers((xs) => [...xs.filter((a) => a.user_id !== me.id), ...(answer ? [{ event_id: event.id, user_id: me.id, answer }] : [])]);
    try { await saveAnswer(event.id, me.id, had, answer); setError(''); } catch (e) { setError(`Your answer was not saved: ${e.message}`); }
    load().catch(() => {});
  };
  return (
    <section className="rsvp-event" aria-label="RSVPs">
      <p className="rsvp-sum">{countsLabel(answers)}</p>
      <RsvpBox event={event} answers={answers} me={me} onSet={set} error={error} />
    </section>
  );
}

const FILTERS = [
  { id: 'all', label: 'All upcoming', test: () => true },
  { id: 'open', label: 'Not answered', test: (m) => !m },
  { id: 'going', label: 'Going', test: (m) => m === 'going' },
  { id: 'maybe', label: 'Maybe', test: (m) => m === 'maybe' },
];

export default function Rsvps({ me, notice, onOpenEvent }) {
  const [events, setEvents] = useState(null);
  const [filter, setFilter] = useState('all');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');

  const load = useCallback(() => api(`/events?ends_at=gte.${new Date().toISOString()}&select=id,space_id,title,starts_at,ends_at,location,space:spaces(name,kind),rsvps(${SEL})&order=starts_at&limit=200`)
    .then((r) => { setEvents(r); setError(''); }), []);
  useEffect(() => { load().catch((e) => setError(`Events could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (['rsvps', 'events', 'members'].includes(notice?.t)) load().catch(() => {}); }, [notice, load]);

  const mineOf = (e) => e.rsvps.find((a) => a.user_id === me.id)?.answer || null;
  const set = async (e, answer) => {
    const had = !!mineOf(e);
    setEvents((xs) => xs.map((x) => (x.id !== e.id ? x : { ...x, rsvps: [...x.rsvps.filter((a) => a.user_id !== me.id), ...(answer ? [{ event_id: e.id, user_id: me.id, answer }] : [])] })));
    try { await saveAnswer(e.id, me.id, had, answer); setErrors((m) => ({ ...m, [e.id]: '' })); }
    catch (err) { setErrors((m) => ({ ...m, [e.id]: `Your answer was not saved: ${err.message}` })); }
    load().catch(() => {});
  };

  const all = events || [];
  const f = FILTERS.find((x) => x.id === filter);
  const shown = all.filter((e) => f.test(mineOf(e)));
  const days = [];
  for (const e of shown) {
    const d = dayOf(e.starts_at);
    if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, events: [] });
    days[days.length - 1].events.push(e);
  }
  const going = all.filter((e) => mineOf(e) === 'going').length;

  return (
    <div className="docs">
      <nav className="docs-list" aria-label="Show">
        <p className="docs-hint">Say whether you are coming to events in your spaces. Everyone in the event's space sees who is coming.</p>
        <ul>
          {FILTERS.map((x) => {
            const n = all.filter((e) => x.test(mineOf(e))).length;
            return (
              <li key={x.id}>
                <button type="button" className={`doc-link rsvp-filter${x.id === filter ? ' is-active' : ''}`} aria-current={x.id === filter ? 'page' : undefined} onClick={() => setFilter(x.id)}>
                  <span>{x.label}</span>{events && <span className="convo-count" aria-label={`${n} events`}>{n}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section className="docs-main">
        <header className="docs-head">
          <h2 className="docs-title rsvp-head">{f.id === 'all' ? 'Upcoming events' : f.label}</h2>
          <p className="docs-meta"><span>{all.length} upcoming</span><span>{going ? `You are going to ${going}` : 'You have not said yes to any yet'}</span></p>
        </header>
        <div className="docs-links">
          {error && <p className="send-error" role="alert">{error}</p>}
          {!events ? <div className="skeleton" aria-label="Loading events"><span /><span /></div>
            : !shown.length ? <p className="convo-empty">{!all.length ? 'Nothing coming up in your spaces. Events added in Calendar show here.' : filter === 'open' ? 'You have answered every upcoming event.' : 'No events here.'}</p>
            : days.map((d) => (
              <section key={d.day} className="rsvp-day" aria-label={d.day}>
                <h3 className="notice-group">{d.day}</h3>
                <ul className="link-list">
                  {d.events.map((e) => (
                    <li key={e.id} className={`link rsvp-card${mineOf(e) === 'going' ? ' is-going' : ''}`}>
                      <div className="link-head">
                        <button type="button" className="link-btn rsvp-title" onClick={() => onOpenEvent(e.id)}>{e.title}</button>
                        <span className="link-host">{eventWhen(e.starts_at, e.ends_at)}{e.location ? `, ${e.location}` : ''}</span>
                        <span className="link-by">{where(e.space)}</span>
                      </div>
                      <p className="rsvp-sum">{countsLabel(e.rsvps)}</p>
                      <RsvpBox event={e} answers={e.rsvps} me={me} onSet={(a) => set(e, a)} error={errors[e.id]} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          <p className="docs-hint rsvp-foot">Press your answer again to clear it. You can change it until the event ends.</p>
        </div>
      </section>
    </div>
  );
}
