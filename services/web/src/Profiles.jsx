// People profiles: a short profile for each person (role, skills, how and when to reach them). Your own is
// at the top, where you fill it in, change it or clear it; below are the profiles of everyone you share a
// space with, with a filter over names, roles, skills and notes, and the skills as buttons that filter.
// Only you can change your profile; everyone else's is read-only. Row-level security decides who is listed
// at all; when it says no, the reason is shown and the list is reloaded. Live: a profiles or members notice
// refetches.
// Who knows what (062): every skill among those people with how many hold it, from weft.skill_holders (one
// row per skill, person and shared space, under the caller's row-level security), and a channel chooser that
// narrows the counts and the list to members of one of your channels. Home's "Who knows what" widget opens
// this screen with a skill already picked (ask).
// Kudos on profiles (063): each card shows the newest three kudos the person received and how many in all,
// from weft.kudos_received (under the caller's row-level security on kudos, so only from channels the viewer
// is in). A channel name opens that channel's Kudos wall (openKudos). Live: a kudos notice refetches.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { ago, nameOf } from './Kudos.jsx';

const EMPTY = { role: '', skills: '', reach: '', availability: '' };
const SEL = 'id,display_name,profile:profiles(role,skills,reach,availability,updated_at)';
const one = (p) => (Array.isArray(p) ? p[0] : p) || null;
// Initials from words that start with a letter or digit, so "Alex (test admin)" is "AT", not "A(".
const initials = (n) => n.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';
const filled = (p) => !!p && !!(p.role || p.skills?.length || p.reach || p.availability);
const skillList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const KUDOS = 'id,to_user,space_id,message,created_at,n,received,from:users!created_by(display_name)';
const day = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

function ProfileForm({ initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const n = skillList(f.skills).length;
  return (
    <form className="link-form profile-form" aria-label="Your profile" noValidate onSubmit={(e) => {
      e.preventDefault();
      onSave({ role: f.role.trim(), skills: skillList(f.skills), reach: f.reach.trim(), availability: f.availability.trim() });
    }}>
      <label htmlFor="profile-role">Role</label>
      <input id="profile-role" value={f.role} onChange={set('role')} maxLength={80} autoComplete="off" placeholder="Stage manager, volunteer lead…" />
      <label htmlFor="profile-skills">Skills</label>
      <input id="profile-skills" value={f.skills} onChange={set('skills')} autoComplete="off" placeholder="first aid, van licence, Spanish" aria-describedby="profile-skills-hint" />
      <p id="profile-skills-hint" className="profile-hint">Separate skills with commas, up to 12.{n > 12 ? ` You have ${n}.` : ''}</p>
      <label htmlFor="profile-reach">How to reach me</label>
      <textarea id="profile-reach" value={f.reach} onChange={set('reach')} maxLength={300} rows={2} placeholder="Message me in Weft; call for anything urgent on the day" />
      <label htmlFor="profile-when">When I'm available</label>
      <textarea id="profile-when" value={f.availability} onChange={set('availability')} maxLength={300} rows={2} placeholder="Weekday evenings, all festival weekend" />
      <div className="link-form-actions">
        <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
        {onCancel && <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

// The newest kudos the person received, from channels you are in (the database leaves out the rest).
function Thanks({ person, mine, kudos, channelName, openKudos }) {
  if (!kudos?.length) return null;
  const all = Number(kudos[0].received);
  return (
    <section className="profile-kudos" aria-label={`Kudos for ${person.display_name}`}>
      <p className="profile-label profile-kudos-title">Kudos{mine ? ' you received' : ''}
        <span className="profile-kudos-count"> {all} in all</span></p>
      <ul>
        {kudos.map((k) => (
          <li key={k.id} className="profile-kudos-item">
            <p className="profile-kudos-message">{k.message}</p>
            <p className="profile-kudos-from">From {nameOf(k.from)}{channelName(k.space_id) && <> in <button type="button" className="profile-kudos-channel" onClick={() => openKudos?.(k.space_id)}>#{channelName(k.space_id)}<span className="visually-hidden"> (open its kudos)</span></button></>}, {ago(k.created_at)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ person, shared, mine, active, onSkill, thanks, children }) {
  const p = person.profile;
  return (
    <li className={`link profile${mine ? ' is-mine' : ''}`} aria-label={person.display_name}>
      <div className="contact-head">
        <span className="contact-badge profile-badge" aria-hidden="true">{initials(person.display_name)}</span>
        <div className="contact-who">
          <span className="contact-name">{person.display_name}{mine && <span className="profile-you"> (you)</span>}</span>
          {p?.role && <span className="link-host profile-role">{p.role}</span>}
        </div>
      </div>
      {p?.skills?.length > 0 && (
        <div className="links-tags" role="group" aria-label={`Skills of ${person.display_name}`}>
          {p.skills.map((s) => <button key={s} type="button" className="link-tag" aria-pressed={active === s} onClick={() => onSkill(s)}>{s}</button>)}
        </div>
      )}
      {p?.reach && <p className="profile-line"><span className="profile-label">How to reach</span> {p.reach}</p>}
      {p?.availability && <p className="profile-line"><span className="profile-label">Available</span> {p.availability}</p>}
      {thanks}
      <div className="link-foot">
        {shared && <span className="link-by profile-shared">{shared}</span>}
        {children}
      </div>
    </li>
  );
}

export default function Profiles({ me, spaces, members, notice, ask, openKudos }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [skill, setSkill] = useState('');
  const [channelId, setChannelId] = useState('');
  const [holders, setHolders] = useState([]);
  const [kudos, setKudos] = useState([]);

  const load = useCallback(() => Promise.all([
    api(`/users?is_assistant=is.false&disabled=is.false&select=${SEL}&order=display_name`),
    api('/skill_holders?select=skill,user_id,space_id'),
    api(`/kudos_received?n=lte.3&select=${KUDOS}&order=to_user,n`),
  ]).then(([r, h, k]) => { setPeople(r.map((u) => ({ ...u, profile: one(u.profile) }))); setHolders(h); setKudos(k); }), []);
  useEffect(() => { load().catch((e) => setError(`Profiles could not load: ${e.message}`)); }, [load]);
  useEffect(() => { if (['profiles', 'members', 'kudos'].includes(notice?.t)) load().catch(() => {}); }, [notice, load]);
  // Opened from the Home widget with a skill: show everyone who has it.
  useEffect(() => { if (ask?.skill) { setSkill(ask.skill); setChannelId(''); setQuery(''); } }, [ask]);

  // Every change: show the database's answer if it refuses, and reload so the screen matches the data.
  const change = async (what, run) => {
    let ok = false;
    setBusy(true);
    try { await run(); setError(''); ok = true; } catch (e) { setError(`${what}: ${e.message}`); }
    setBusy(false);
    load().catch(() => {});
    return ok;
  };
  const save = async (body) => {
    if (await change('Your profile was not saved', () => api('/profiles?on_conflict=user_id', { method: 'POST', body, prefer: 'resolution=merge-duplicates,return=minimal' }))) setEditing(false);
  };
  const clear = () => {
    if (!window.confirm('Clear your profile? People will see only your name.')) return;
    change('Your profile was not cleared', () => api(`/profiles?user_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' }));
  };

  if (!people) return error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading profiles"><span /><span /><span /></div>;

  // Which channels each person shares with you (the help channel, which everyone is in, is left out).
  const channels = spaces.filter((s) => s.kind === 'channel' && !s.everyone).sort((a, b) => a.name.localeCompare(b.name));
  const channel = Object.fromEntries(channels.map((s) => [s.id, s.name]));
  const sharedOf = (id) => {
    const names = [...new Set(members.filter((m) => m.user?.id === id && channel[m.space_id]).map((m) => `#${channel[m.space_id]}`))].sort();
    return names.length ? `In ${names.join(', ')}` : '';
  };
  const kudosFor = (id) => kudos.filter((k) => k.to_user === id);
  const channelName = (id) => spaces.find((s) => s.id === id)?.name || '';
  const thanksOf = (u, isMine) => <Thanks person={u} mine={isMine} kudos={kudosFor(u.id)} channelName={channelName} openKudos={openKudos} />;
  const mine = people.find((u) => u.id === me.id) || { id: me.id, display_name: me.display_name, profile: null };
  const others = people.filter((u) => u.id !== me.id);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // The channel filter: people who are members of the chosen channel (a channel you left is ignored).
  const inChannel = channel[channelId] ? channelId : '';
  const inIt = (id) => !inChannel || members.some((m) => m.space_id === inChannel && m.user?.id === id);
  const matches = (u) => inIt(u.id) && words.every((w) => [u.display_name, u.profile?.role, ...(u.profile?.skills || []), u.profile?.reach, u.profile?.availability]
    .some((x) => x && x.toLowerCase().includes(w))) && (!skill || u.profile?.skills?.includes(skill));
  // Who knows what: how many people (not you) hold each skill, in the chosen channel or anywhere you share.
  const holding = {};
  for (const h of holders) {
    if (h.user_id === me.id || (inChannel && h.space_id !== inChannel)) continue;
    (holding[h.skill] ||= new Set()).add(h.user_id);
  }
  const known = Object.entries(holding).map(([s, who]) => [s, who.size]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const withProfile = others.filter((u) => filled(u.profile));
  const shown = withProfile.filter(matches);
  const without = others.filter((u) => !filled(u.profile) && !skill && matches(u));
  const pick = (s) => setSkill((x) => (x === s ? '' : s));
  const where = inChannel ? ` in #${channel[inChannel]}` : '';
  const status = skill ? `${shown.length} ${shown.length === 1 ? 'person knows' : 'people know'} ${skill}${where}`
    : words.length || inChannel ? `${shown.length} of ${withProfile.length} profile${withProfile.length === 1 ? '' : 's'}${where}`
      : `${withProfile.length} profile${withProfile.length === 1 ? '' : 's'}`;

  return (
    <div className="docs-main profiles">
      <header className="docs-head">
        <h2 className="docs-title profiles-title">People</h2>
        <p className="docs-meta">Your profile is seen by everyone you share a channel or direct message with. Only you can change it.</p>
      </header>
      <div className="docs-links">
      <div className="links">
        {error && <p className="send-error" role="alert">{error}</p>}
        <section aria-labelledby="profile-mine-title" className="links">
          <h3 id="profile-mine-title" className="notice-group">Your profile</h3>
          {editing ? (
            <ProfileForm initial={mine.profile ? { role: mine.profile.role, skills: mine.profile.skills.join(', '), reach: mine.profile.reach, availability: mine.profile.availability } : EMPTY}
              onSave={save} onCancel={() => setEditing(false)} busy={busy} />
          ) : filled(mine.profile) ? (
            <ul className="link-list">
              <Card person={mine} mine active={skill} onSkill={pick} thanks={thanksOf(mine, true)}>
                <span className="link-by">Updated {day(mine.profile.updated_at)}</span>
                <button className="btn btn--sm" type="button" onClick={() => setEditing(true)}>Edit profile</button>
                <button className="btn btn--sm" type="button" onClick={clear} disabled={busy}>Clear</button>
              </Card>
            </ul>
          ) : (<>
            <div className="links-bar">
              <button className="btn btn--primary btn--sm" type="button" onClick={() => setEditing(true)}>Fill in your profile</button>
              <p className="docs-hint">Say what you do, what you are good at, and how and when people can reach you.</p>
            </div>
            {kudosFor(mine.id).length > 0 && <ul className="link-list"><Card person={mine} mine active={skill} onSkill={pick} thanks={thanksOf(mine, true)} /></ul>}
          </>)}
        </section>

        <section aria-labelledby="profile-others-title" className="links">
          <h3 id="profile-others-title" className="notice-group">People you share a space with</h3>
          {others.length > 0 && (
            <div className="links-filters">
              <label className="visually-hidden" htmlFor="profiles-find">Find a person</label>
              <input id="profiles-find" type="search" placeholder="Find by name, role or skill…" value={query} onChange={(e) => setQuery(e.target.value)} />
              {channels.length > 0 && (
                <label className="idea-sort">Channel{' '}
                  <select id="profiles-channel" value={inChannel} onChange={(e) => setChannelId(e.target.value)}>
                    <option value="">Any channel</option>
                    {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                </label>
              )}
              {skill && <button type="button" className="link-tag" aria-pressed="true" onClick={() => setSkill('')}>{skill}<span aria-hidden="true"> ×</span><span className="visually-hidden"> (remove this filter)</span></button>}
              <span className="task-count" role="status">{status}</span>
            </div>
          )}
          {others.length > 0 && (
            <div className="who-knows" role="group" aria-labelledby="who-knows-title">
              <span id="who-knows-title" className="who-knows-title">Who knows what{where}</span>
              {known.length ? known.map(([s, n]) => (
                <button key={s} type="button" className="link-tag" aria-pressed={skill === s} onClick={() => pick(s)}>
                  {s} <span className="idea-count" aria-hidden="true">{n}</span><span className="visually-hidden">, {n} {n === 1 ? 'person' : 'people'}</span>
                </button>
              )) : <span className="docs-hint">{inChannel ? 'No one in this channel has listed a skill yet.' : 'No one has listed a skill yet.'}</span>}
            </div>
          )}
          {!others.length ? <p className="convo-empty">You do not share a space with anyone yet.</p>
            : !shown.length && !without.length ? <p className="convo-empty">{skill && !words.length ? `No one${where} has listed ${skill}.` : withProfile.length ? 'No one matches.' : 'No one has filled in a profile yet.'}</p> : (<>
              {shown.length > 0 && (
                <ul className="link-list profile-list" aria-label="Profiles">
                  {shown.map((u) => <Card key={u.id} person={u} shared={sharedOf(u.id)} active={skill} onSkill={pick} thanks={thanksOf(u, false)} />)}
                </ul>
              )}
              {without.length > 0 && <p className="docs-hint profile-without">No profile yet: {without.map((u) => u.display_name).join(', ')}</p>}
            </>)}
        </section>
      </div>
      </div>
    </div>
  );
}
