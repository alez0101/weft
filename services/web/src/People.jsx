// People: a channel's members (owners add people, set roles, rename or delete the channel; anyone can
// leave), creating a channel, and the admin list of accounts. Every rule is enforced by the database;
// these screens only offer what the rules allow and show the database's answer when it says no.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, auth } from './api.js';

const ROLE = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HINT = { owner: 'manages the channel and its people', editor: 'writes documents, tables and events', viewer: 'reads and chats' };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

// The database's refusals, in plain words.
function plain(msg) {
  if (/needs an owner/.test(msg)) return 'A channel needs an owner. Make someone else owner first.';
  if (/row-level security|permission denied|42501/.test(msg)) return 'Only owners of this channel can do that.';
  if (/duplicate key/.test(msg)) return 'They are already in this channel.';
  return msg;
}

export function ChannelPeople({ me, space, onClose, onGone }) {
  const ref = useRef(null);
  const [rows, setRows] = useState(null);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [add, setAdd] = useState({ user: '', role: 'viewer' });
  const [name, setName] = useState(space.name);

  const load = useCallback(async () => {
    const [m, u] = await Promise.all([
      api(`/members?space_id=eq.${space.id}&select=user_id,role,user:users(id,display_name,email,disabled)`),
      api('/users?is_assistant=is.false&disabled=is.false&select=id,display_name,email&order=display_name'),
    ]);
    setRows(m.sort((a, b) => Object.keys(ROLE).indexOf(a.role) - Object.keys(ROLE).indexOf(b.role) || a.user.display_name.localeCompare(b.user.display_name)));
    setPeople(u);
  }, [space.id]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);

  const mine = rows?.find((r) => r.user_id === me.id)?.role;
  const owner = mine === 'owner';
  const owners = rows?.filter((r) => r.role === 'owner').length ?? 0;
  const run = async (fn, done) => {
    setError(''); setStatus('');
    try { await fn(); if (done) setStatus(done); await load(); } catch (e) { setError(plain(e.message)); }
  };
  const candidates = people.filter((p) => !rows?.some((r) => r.user_id === p.id));

  return (
    <dialog ref={ref} className="people" aria-labelledby="people-title" onClose={onClose}>
      <header className="people-head">
        <h2 id="people-title">People in # {space.name}</h2>
        <button className="icon-btn" type="button" aria-label="Close" onClick={() => ref.current.close()}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      {!rows ? (error ? <p className="send-error" role="alert">{error}</p> : <div className="skeleton" aria-label="Loading people"><span /><span /></div>) : (<>
        <ul className="people-list">
          {rows.map((r) => (
            <li key={r.user_id} className="person">
              <span className="who" aria-hidden="true">{r.user.display_name.charAt(0).toUpperCase()}</span>
              <span className="person-name">{r.user.display_name}{r.user_id === me.id ? ' (you)' : ''}
                <small>{r.user.email}{r.user.disabled ? ', disabled' : ''}</small></span>
              {owner ? (<>
                <label className="visually-hidden" htmlFor={`role-${r.user_id}`}>Role for {r.user.display_name}</label>
                <select id={`role-${r.user_id}`} value={r.role} disabled={r.role === 'owner' && owners === 1}
                  onChange={(e) => run(() => api(`/members?space_id=eq.${space.id}&user_id=eq.${r.user_id}`, { method: 'PATCH', body: { role: e.target.value }, prefer: 'return=minimal' }), `${r.user.display_name} is now ${ROLE[e.target.value].toLowerCase()}.`)}>
                  {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {r.user_id !== me.id && <button className="btn btn--sm" type="button"
                  onClick={() => window.confirm(`Remove ${r.user.display_name} from # ${space.name}? They lose access to its messages, documents, tables and events.`)
                    && run(() => api(`/members?space_id=eq.${space.id}&user_id=eq.${r.user_id}`, { method: 'DELETE', prefer: 'return=minimal' }), `${r.user.display_name} was removed.`)}>Remove</button>}
              </>) : <span className="person-role">{ROLE[r.role]}</span>}
            </li>
          ))}
        </ul>
        {space.admins_only && <p className="people-hint">Every admin is in this channel, and only admins. Membership follows the admin setting in Settings.</p>}
        {space.everyone && <p className="people-hint">Everyone who signs in to Weft can read this channel.</p>}
        <p className="people-hint">{Object.entries(ROLE).map(([k, v]) => `${v}: ${ROLE_HINT[k]}`).join('. ')}.</p>

        {owner && (
          <form className="people-add" aria-label="Add a person" onSubmit={(e) => { e.preventDefault(); const p = people.find((x) => x.id === add.user);
            if (p) run(() => api('/members', { method: 'POST', body: { space_id: space.id, user_id: p.id, role: add.role }, prefer: 'return=minimal' }), `${p.display_name} was added as ${ROLE[add.role].toLowerCase()}.`).then(() => setAdd({ user: '', role: add.role })); }}>
            <label htmlFor="people-add-user">Add a person</label>
            <span className="pair">
              <select id="people-add-user" value={add.user} onChange={(e) => setAdd({ ...add, user: e.target.value })}>
                <option value="">{candidates.length ? 'Choose someone' : 'Everyone is already here'}</option>
                {candidates.map((p) => <option key={p.id} value={p.id}>{p.display_name} ({p.email})</option>)}
              </select>
              <label className="visually-hidden" htmlFor="people-add-role">Role</label>
              <select id="people-add-role" value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
                {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="btn btn--primary btn--sm" type="submit" disabled={!add.user}>Add</button>
            </span>
            <p className="people-hint">People appear here after they first sign in to Weft.</p>
          </form>
        )}

        {owner && (
          <form className="people-add" aria-label="Rename the channel" onSubmit={(e) => { e.preventDefault();
            run(() => api(`/spaces?id=eq.${space.id}`, { method: 'PATCH', body: { name: name.trim() }, prefer: 'return=minimal' }), 'Renamed.'); }}>
            <label htmlFor="people-name">Channel name</label>
            <span className="pair">
              <input id="people-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <button className="btn btn--sm" type="submit" disabled={!name.trim() || name.trim() === space.name}>Rename</button>
            </span>
          </form>
        )}

        {status && <p className="slot-status" role="status">{status}</p>}
        {error && <p className="send-error" role="alert">{error}</p>}

        <footer className="people-foot">
          {!space.everyone && !space.admins_only && mine && !(owner && owners === 1) && (
            <button className="btn btn--sm" type="button" onClick={() => window.confirm(`Leave # ${space.name}? You will need an owner to add you back.`)
              && run(async () => { await api(`/members?space_id=eq.${space.id}&user_id=eq.${me.id}`, { method: 'DELETE', prefer: 'return=minimal' }); onGone(); })}>Leave channel</button>
          )}
          {owner && !space.everyone && (
            <button className="btn btn--sm btn--danger" type="button" onClick={() => window.prompt(`Deleting # ${space.name} deletes its messages, documents, tables, whiteboards and events for everyone. Type the channel name to delete it.`) === space.name
              && run(async () => { await api(`/spaces?id=eq.${space.id}`, { method: 'DELETE', prefer: 'return=minimal' }); onGone(); })}>Delete channel</button>
          )}
        </footer>
      </>)}
    </dialog>
  );
}

export function NewChannel({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="new-channel" aria-label="New channel" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        onCreated(await api('/rpc/create_channel', { method: 'POST', body: { p_name: name.trim() } }));
      } catch (err) { setError(`Not created: ${err.message}`); }
      setBusy(false);
    }}>
      <label className="visually-hidden" htmlFor="new-channel-name">Channel name</label>
      <input id="new-channel-name" autoFocus placeholder="Channel name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }} />
      <span className="pair">
        <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !name.trim()}>Create</button>
        <button className="btn btn--sm" type="button" onClick={onCancel}>Cancel</button>
      </span>
      {error && <p className="send-error" role="alert">{error}</p>}
      <p className="people-hint">You become its owner and can add people from its member count.</p>
    </form>
  );
}

// A link made for someone, shown once: only a hash of its secret is kept.
function NewLink({ link, onDone }) {
  const url = `${location.origin}/#link=${link.token}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="new-link" role="status">
      <p>{link.purpose === 'invite' ? 'Invite' : 'Password reset'} link for <strong>{link.email}</strong>, single use, until {new Date(link.expires_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Send it to them privately; it is shown only now.</p>
      <span className="pair">
        <label className="visually-hidden" htmlFor="new-link-url">Link</label>
        <input id="new-link-url" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className="btn btn--sm" type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); } catch { document.getElementById('new-link-url').select(); } }}>{copied ? 'Copied' : 'Copy'}</button>
        <button className="btn btn--sm" type="button" onClick={onDone}>Done</button>
      </span>
    </div>
  );
}

export function AdminUsers({ me, info }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const accounts = info?.methods?.includes('password');
  const [links, setLinks] = useState([]);
  const [made, setMade] = useState(null);
  const [inviteTo, setInviteTo] = useState('');
  const loadLinks = useCallback(() => (accounts ? auth('/admin/links').then(setLinks).catch(() => {}) : Promise.resolve()), [accounts]);
  useEffect(() => { loadLinks(); }, [loadLinks]);
  const makeLink = async (email, purpose) => {
    setError(''); setStatus('');
    try { setMade(await auth('/admin/links', { method: 'POST', body: { email, purpose } })); setInviteTo(''); loadLinks(); } catch (e) { setError(e.message); }
  };
  const load = useCallback(() => api('/rpc/admin_users').then(setRows), []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const change = async (u, body, done) => {
    setError(''); setStatus('');
    try { await api('/rpc/admin_set_user', { method: 'POST', body: { p_user: u.id, ...body } }); setStatus(done); await load(); }
    catch (e) { setError(e.message); }
  };
  return (
    <section className="slot users" aria-labelledby="users-title">
      <header className="slot-head"><h3 id="users-title">People</h3></header>
      <p className="admin-lead">{accounts
        ? 'Everyone with a Weft account. To let someone in, make an invite link and send it to them; they choose their own password. A disabled account cannot sign in or see anything, and keeps its channels for when it is enabled again.'
        : 'Everyone who has signed in. Accounts are created on first sign-in through Cloudflare Access, so to let someone new in, add their email to the Access policy first. A disabled account cannot sign in or see anything, and keeps its channels for when it is enabled again.'}</p>
      {accounts && (
        <form className="people-add" aria-label="Invite someone" onSubmit={(e) => { e.preventDefault(); makeLink(inviteTo.trim(), 'invite'); }}>
          <label htmlFor="invite-email">Invite someone</label>
          <span className="pair">
            <input id="invite-email" type="email" placeholder="Their email" value={inviteTo} onChange={(e) => setInviteTo(e.target.value)} />
            <button className="btn btn--primary btn--sm" type="submit" disabled={!inviteTo.includes('@')}>Make invite link</button>
          </span>
        </form>
      )}
      {made && <NewLink link={made} onDone={() => setMade(null)} />}
      {error && <p className="send-error" role="alert">{error}</p>}
      {status && <p className="slot-status" role="status">{status}</p>}
      {!rows ? <div className="skeleton" aria-label="Loading people"><span /><span /></div> : (
        <table className="users-table">
          <thead><tr><th scope="col">Name</th><th scope="col">Channels</th><th scope="col">Last sign-in</th>{accounts && <th scope="col">Password</th>}<th scope="col">Admin</th><th scope="col">Account</th></tr></thead>
          <tbody>
            {rows.map((u) => {
              const self = u.id === me.id;
              return (
                <tr key={u.id} className={u.disabled ? 'is-disabled' : undefined}>
                  <th scope="row">{u.display_name}{self ? ' (you)' : ''}<small>{u.email}</small></th>
                  <td>{u.spaces}</td>
                  <td>{day(u.last_seen_at)}</td>
                  {accounts && <td className="users-account">{u.has_password ? 'Set' : 'Not set'}{!self && <button className="btn btn--sm" type="button" onClick={() => makeLink(u.email, 'reset')}>Reset link<span className="visually-hidden"> for {u.display_name}</span></button>}</td>}
                  <td><label className="toggle"><input type="checkbox" checked={u.is_admin} disabled={self}
                    onChange={(e) => change(u, { p_is_admin: e.target.checked }, `${u.display_name} ${e.target.checked ? 'is now an admin' : 'is no longer an admin'}.`)} />
                    <span className="visually-hidden">Admin: {u.display_name}</span></label></td>
                  <td className="users-account">{u.disabled ? 'Disabled' : 'Active'}{!self && <button className="btn btn--sm" type="button"
                    onClick={() => (u.disabled || window.confirm(`Disable ${u.display_name}? They are signed out everywhere at once and cannot sign in until enabled again.`))
                      && change(u, { p_disabled: !u.disabled }, `${u.display_name} is ${u.disabled ? 'enabled' : 'disabled'}.`)}>{u.disabled ? 'Enable' : 'Disable'}<span className="visually-hidden"> {u.display_name}</span></button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {accounts && links.length > 0 && (
        <div className="open-links">
          <h4>Links not used yet</h4>
          <ul>
            {links.map((l) => (
              <li key={l.id} className="person">
                <span className="person-name">{l.purpose === 'invite' ? 'Invite' : 'Reset'} for {l.email}<small>until {new Date(l.expires_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small></span>
                <button className="btn btn--sm" type="button" onClick={async () => { try { await auth(`/admin/links/${l.id}`, { method: 'DELETE' }); loadLinks(); } catch (e) { setError(e.message); } }}>Cancel link<span className="visually-hidden"> for {l.email}</span></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
