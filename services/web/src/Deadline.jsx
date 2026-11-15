// Poll and form deadlines (058): a "closes at" time on a poll or a form. Once it passes, the poll or form is
// closed by itself; the database refuses votes and answers from then on, so this only shows it. Editors set,
// change or clear the time; the database checks it is in the future and within a year and says so if not.
import { useEffect, useState } from 'react';

export const isPast = (iso, now = Date.now()) => !!iso && new Date(iso).getTime() <= now;
// Closed by hand, or by the time.
export const isShut = (state) => !!state && (state.closed || isPast(state.closes_at));
export const closesWords = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
};
// "closes Fri 20 Nov, 5:00 PM", or "closed by itself ..." once the time has passed (not closed by hand).
export const deadlineWords = (state) => (!state?.closes_at || state.closed ? ''
  : isPast(state.closes_at) ? `closed by itself ${closesWords(state.closes_at)}` : `closes ${closesWords(state.closes_at)}`);

// Run `fn` when the time comes (the screen reloads and shows it closed).
export function useAtTime(iso, fn) {
  useEffect(() => {
    if (!iso) return undefined;
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0 || ms > 2 ** 31 - 1) return undefined;
    const t = setTimeout(fn, ms + 300);
    return () => clearTimeout(t);
  }, [iso, fn]);
}

// The value a datetime-local box wants, in the person's own time zone.
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Editors only. `onSave(iso or null)` returns true when the database took it.
export function DeadlineEditor({ id, closesAt, onSave, busy }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const start = () => { setValue(toLocalInput(closesAt && !isPast(closesAt) ? new Date(closesAt) : new Date(Date.now() + 7 * 86400000))); setOpen(true); };
  const save = async (v) => { if (await onSave(v)) setOpen(false); };
  if (!open) {
    return (
      <div className="deadline">
        <button className="btn btn--sm" type="button" onClick={start}>{closesAt ? 'Change closing time' : 'Set closing time'}</button>
        {closesAt && <button className="btn btn--sm" type="button" disabled={busy} onClick={() => save(null)}>No closing time</button>}
      </div>
    );
  }
  return (
    <form className="deadline" aria-label="Closing time" onSubmit={(e) => { e.preventDefault(); if (value) save(new Date(value).toISOString()); }}>
      <label htmlFor={id}>Closes at</label>
      <input id={id} className="deadline-input" type="datetime-local" value={value} min={toLocalInput(new Date())} required onChange={(e) => setValue(e.target.value)} />
      <button className="btn btn--primary btn--sm" type="submit" disabled={!value || busy}>Save time</button>
      <button className="btn btn--sm" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
