// Away warnings (052): when someone is picked for something on a day their time off covers, a gentle
// "Pat is away then" shows next to the choice. Used by Tasks, Meetings, Shifts and the Home widget.
// The days come from weft.away_between, which reads time off as the person: only time off in channels they
// are a member of counts, so a note never says more than Time off would show them. The note never blocks
// anything. Live: a time_off or members notice refetches.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { addDays, dayKey, daysLabel } from './TimeOff.jsx';

// Who is away when, from a week ago to a year ahead (the helper takes at most 400 days).
// Returns awayOn(userId, day, lastDay = day) -> the time off covering any of those days, or null.
export function useAway(notice, days = 366) {
  const [rows, setRows] = useState([]);
  const load = useCallback(() => {
    const t = dayKey(new Date());
    return api(`/rpc/away_between?p_from=${addDays(t, -7)}&p_to=${addDays(t, days)}`).then(setRows);
  }, [days]);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  useEffect(() => { if (notice?.t === 'time_off' || notice?.t === 'members') load().catch(() => {}); }, [notice, load]);
  return useCallback((user, day, last = day) => (user && day
    ? rows.find((r) => r.user_id === user && r.starts_on <= last && r.ends_on >= day) ?? null : null), [rows]);
}

export const awayText = (name, isMe) => (isMe ? 'You are away then' : `${name || 'They'} is away then`);

// The note itself, next to a choice. Nothing when the person is not away.
export function AwayNote({ away, name, isMe, className = '' }) {
  if (!away) return null;
  return (
    <span className={`away-note ${className}`} title={`Time off ${daysLabel(away.starts_on, away.ends_on)}`}>
      {awayText(name, isMe)}<span className="visually-hidden">, time off {daysLabel(away.starts_on, away.ends_on)}</span>
    </span>
  );
}

// In a form: always present, so a screen reader hears it when the choice changes.
export function AwayLive({ away, name, isMe }) {
  return (
    <p className="away-live" role="status">
      {away ? <span className="away-note">{awayText(name, isMe)} (time off {daysLabel(away.starts_on, away.ends_on)})</span> : null}
    </p>
  );
}
