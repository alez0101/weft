import { useCallback, useEffect, useState } from 'react';
import { api, auth, authMode, connectLive, peekLink, signIn, signOut } from './api.js';
import Chat from './Chat.jsx';
import AdminPanel from './AdminPanel.jsx';
import Docs from './Docs.jsx';
import Calendar from './Calendar.jsx';
import Announcements from './Announcements.jsx';
import Rsvps from './Rsvps.jsx';
import Bookings from './Bookings.jsx';
import Shifts from './Shifts.jsx';
import TimeOff from './TimeOff.jsx';
import Profiles from './Profiles.jsx';
import Widgets from './Home.jsx';
import ModelKey from './ModelKey.jsx';
import Connect, { CONNECTING, ConnectedApps } from './Connect.jsx';
import SearchBox from './Search.jsx';
import { applyMode, storedMode } from './mode.js';

const APPS = [
  { id: 'documents', label: 'Documents', tint: '--p-thu', real: true, glyph: <><path d="M11 6h13l7 7v21H11z" /><path d="M24 6v7h7M16 20h10M16 25h10M16 30h6" /></> },
  { id: 'wiki', label: 'Wiki', tint: '--p-fri', real: true, glyph: <><path d="M8 9c4-2 8-2 12 1 4-3 8-3 12-1v23c-4-2-8-2-12 1-4-3-8-3-12-1z" /><path d="M20 10v23" /></> },
  { id: 'whiteboard', label: 'Whiteboard', tint: '--p-wed', real: true, glyph: <><rect x="6" y="8" width="28" height="20" rx="2" /><path d="M12 22c3-6 6 2 9-4s5 1 7-2M14 34l6-6 6 6" /></> },
  { id: 'sheets', label: 'Sheets', tint: '--p-tue', real: true, glyph: <><rect x="7" y="8" width="26" height="24" rx="2" /><path d="M7 16h26M7 24h26M16 8v24M25 8v24" /></> },
  { id: 'calendar', label: 'Calendar', tint: '--p-mon', real: true, glyph: <><rect x="7" y="9" width="26" height="24" rx="2" /><path d="M7 16h26M14 6v6M26 6v6M13 22h4M19 22h4M25 22h2M13 27h4" /></> },
  { id: 'rsvps', label: 'RSVPs', tint: '--p-sun', real: true, glyph: <><rect x="7" y="9" width="26" height="24" rx="2" /><path d="M7 16h26M14 6v6M26 6v6" /><path d="M14 24.5l3.5 3.5L26 20" /></> },
  { id: 'bookings', label: 'Bookings', tint: '--p-tue', real: true, glyph: <><circle cx="13.5" cy="20" r="6.5" /><circle cx="13.5" cy="20" r="2" /><path d="M20 20h14M29 20v5M33.5 20v4" /></> },
  { id: 'shifts', label: 'Shifts', tint: '--p-wed', real: true, glyph: <><rect x="6" y="9" width="28" height="24" rx="2" /><path d="M6 16h28M14 6v6M26 6v6" /><circle cx="13" cy="25" r="3.5" /><path d="M11.4 25l1.1 1.1 2.1-2.2" /><circle cx="20" cy="25" r="3.5" /><path d="M18.4 25l1.1 1.1 2.1-2.2" /><circle cx="27" cy="25" r="3.5" strokeDasharray="2.2 1.6" /></> },
  { id: 'tasks', label: 'Tasks', tint: '--p-sun', real: true, glyph: <><rect x="8" y="7" width="24" height="27" rx="2" /><path d="M13 15l2.5 2.5L20 13M23 15.5h4M13 23l2.5 2.5L20 21M23 23.5h4M14 30h12" /></> },
  { id: 'boards', label: 'Boards', tint: '--p-tue', real: true, glyph: <><rect x="6" y="8" width="28" height="25" rx="2" /><path d="M15.3 8v25M24.7 8v25" /><rect x="8.6" y="11.5" width="4.2" height="4" rx="1" /><rect x="8.6" y="18" width="4.2" height="4" rx="1" /><rect x="17.9" y="11.5" width="4.2" height="4" rx="1" /><rect x="27.2" y="11.5" width="4.2" height="4" rx="1" /><rect x="27.2" y="18" width="4.2" height="4" rx="1" /><rect x="27.2" y="24.5" width="4.2" height="4" rx="1" /></> },
  { id: 'polls', label: 'Polls', tint: '--p-thu', real: true, glyph: <><path d="M8 33h24" /><rect x="10" y="19" width="5" height="14" rx="1" /><rect x="17.5" y="11" width="5" height="22" rx="1" /><rect x="25" y="15" width="5" height="18" rx="1" /><path d="M17 6.5l2.5 2.5L24 4.5" /></> },
  { id: 'forms', label: 'Forms', tint: '--p-wed', real: true, glyph: <><rect x="8" y="6" width="24" height="28" rx="2" /><path d="M13 13h14M13 18h14" /><rect x="13" y="23" width="4" height="4" rx="1" /><path d="M20 25h7M13 31h9" /></> },
  { id: 'links', label: 'Links', tint: '--p-fri', real: true, glyph: <><path d="M17.5 22.5a6 6 0 0 0 8.5 0l5-5a6 6 0 0 0-8.5-8.5l-2.5 2.5" /><path d="M22.5 17.5a6 6 0 0 0-8.5 0l-5 5a6 6 0 0 0 8.5 8.5l2.5-2.5" /></> },
  { id: 'contacts', label: 'Contacts', tint: '--p-mon', real: true, glyph: <><rect x="8" y="6" width="23" height="28" rx="2" /><path d="M31 11h3M31 18h3M31 25h3" /><circle cx="19.5" cy="17" r="4.5" /><path d="M12.5 29c1-4 4-6 7-6s6 2 7 6" /></> },
  { id: 'profiles', label: 'Profiles', tint: '--p-thu', real: true, glyph: <><rect x="6" y="9" width="28" height="22" rx="2" /><circle cx="15" cy="18" r="3.5" /><path d="M9.5 27c1-3 3-4.5 5.5-4.5s4.5 1.5 5.5 4.5M23 17h7M23 21h7M23 25h4" /></> },
  { id: 'decisions', label: 'Decisions', tint: '--p-wed', real: true, glyph: <><path d="M20 6v28M12 34h16" /><path d="M9 11h22" /><path d="M9 11l-4 10a4 4 0 0 0 8 0zM31 11l-4 10a4 4 0 0 0 8 0z" /></> },
  { id: 'checklists', label: 'Checklists', tint: '--p-fri', real: true, glyph: <><rect x="9" y="6" width="22" height="28" rx="2" /><path d="M13 13l2 2 3.5-3.5M21 13h6M13 21l2 2 3.5-3.5M21 21h6M14 29h4M21 29h6" /></> },
  { id: 'expenses', label: 'Expenses', tint: '--p-sun', real: true, glyph: <><rect x="6" y="10" width="28" height="20" rx="2" /><circle cx="20" cy="20" r="4.5" /><path d="M6 15h4M30 25h4M11 30l-3 4M29 10l3-4" /></> },
  { id: 'timeoff', label: 'Time off', tint: '--p-fri', real: true, glyph: <><rect x="7" y="9" width="26" height="24" rx="2" /><path d="M7 16h26M14 6v6M26 6v6" /><circle cx="20" cy="24.5" r="3" /><path d="M20 18.5v1.5M20 29v1.5M14 24.5h1.5M24.5 24.5H26M15.8 20.3l1 1M23.2 27.7l1 1M15.8 28.7l1-1M23.2 21.3l1-1" /></> },
  { id: 'inventory', label: 'Inventory', tint: '--p-sat', real: true, glyph: <><path d="M6 14l14-7 14 7v18H6z" /><path d="M6 14h28M12 32V20h16v12M12 24h16M12 28h16" /></> },
  { id: 'goals', label: 'Goals', tint: '--p-thu', real: true, glyph: <><circle cx="20" cy="20" r="13" /><circle cx="20" cy="20" r="8" /><circle cx="20" cy="20" r="3" /><path d="M20 20l11-11M27 9h4v4" /></> },
  { id: 'retros', label: 'Retros', tint: '--p-sun', real: true, glyph: <><rect x="6" y="8" width="28" height="25" rx="2" /><path d="M15.3 8v25M24.7 8v25" /><path d="M8.5 14.5l1.5 1.5 3-3M18 14h4M27 14.5h5M27 19h4" /><path d="M17 21.5a3 3 0 1 1 4.5 2.6" /></> },
  { id: 'glossary', label: 'Glossary', tint: '--p-wed', real: true, glyph: <><path d="M10 6h20a2 2 0 0 1 2 2v26H12a2 2 0 0 1-2-2z" /><path d="M10 30a2 2 0 0 1 2-2h20" /><path d="M15 21l3.5-10 3.5 10M16.2 17.5h4.6" /><path d="M25 13h3M25 17h3M25 21h3" /></> },
  { id: 'qa', label: 'Q and A', tint: '--p-tue', real: true, glyph: <><path d="M6 8h20v13H15l-5 4v-4H6z" /><path d="M14 12.5a2.5 2.5 0 1 1 3 2.4c-.7.2-1 .7-1 1.3M16 18.5v.5" /><path d="M29 15h5v13h-4v4l-5-4h-7v-3" /></> },
  { id: 'meetings', label: 'Meetings', tint: '--p-sat', real: true, glyph: <><rect x="9" y="8" width="22" height="26" rx="2" /><path d="M15 5.5h10v5H15zM14 17h12M14 22h12M14 27h6" /><path d="M23 27.5l1.8 1.8L28 26" /></> },
  { id: 'announcements', label: 'Announcements', tint: '--p-mon', real: true, glyph: <><path d="M7 17v7l17 7V10z" /><path d="M24 15h3a5 5 0 0 1 0 10h-3M11 25.5l2 7.5h4l-1.8-6" /></> },
  { id: 'files', label: 'Files', tint: '--p-sat', real: true, glyph: <path d="M6 12h10l3 3h15v17H6z" /> },
  { id: 'settings', label: 'Settings', tint: '--p-fri', admin: true, glyph: <><circle cx="20" cy="20" r="5" /><path d="M20 7v5M20 28v5M7 20h5M28 20h5M10.8 10.8l3.5 3.5M25.7 25.7l3.5 3.5M10.8 29.2l3.5-3.5M25.7 14.3l3.5-3.5" /></> },
];
const APP = Object.fromEntries(APPS.map((a) => [a.id, a]));
const RAILS = ['collapsed', 'normal', 'wide'];
const TEST_ACCOUNTS = [
  ['alex.admin@example.com', 'Alex (test admin)'], ['olive.organizer@example.com', 'Olive Organizer'],
  ['vic.volunteer@example.com', 'Vic Volunteer'], ['pat.public@example.com', 'Pat Public'],
];

// ---------- URL state: tabs, active tab, conversation, chat width ----------
const readHash = () => {
  const h = new URLSearchParams(location.hash.slice(1));
  const tabs = (h.get('tabs') || '').split(',').filter((t) => APP[t]);
  const active = h.get('active');
  return {
    tabs, active: active === 'home' || tabs.includes(active) ? active : 'home',
    convo: h.get('convo') || 'weft', rail: RAILS.includes(h.get('chat')) ? h.get('chat') : 'normal',
    doc: h.get('doc') || null, page: h.get('page') || null, event: h.get('event') || null, board: h.get('board') || null, sheet: h.get('sheet') || null, list: h.get('list') || null, kanban: h.get('kanban') || null, poll: h.get('poll') || null, form: h.get('form') || null, links: h.get('links') || null, book: h.get('book') || null, log: h.get('log') || null, qa: h.get('qa') || null, checklist: h.get('checklist') || null, expenses: h.get('expenses') || null, inventory: h.get('inventory') || null, goals: h.get('goals') || null, retro: h.get('retro') || null, glossary: h.get('glossary') || null, meeting: h.get('meeting') || null, notices: h.get('notices') || null, booking: h.get('booking') || null, file: h.get('file') || null,
  };
};

// The secret of an invite or reset link travels in the URL fragment (#link=...), which browsers never
// send to a server or in a Referer.
// After a password is set or used, offer it to the browser's password manager (Chrome, Edge; others skip).
const remember = (email, password) => {
  try { if (window.PasswordCredential) navigator.credentials.store(new window.PasswordCredential({ id: email, password })).catch(() => {}); } catch { /* not supported */ }
};

// Read once, before anything rewrites the fragment.
const LINK = new URLSearchParams(location.hash.slice(1)).get('link');
const linkToken = () => LINK;

function PasswordForm({ onSignedIn }) {
  const [f, setF] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="signin-form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('');
      try { const s = await signIn('password', f); remember(f.email.trim(), f.password); onSignedIn(s); } catch (err) { setError(err.message); setBusy(false); }
    }}>
      <label htmlFor="signin-email">Email</label>
      <input id="signin-email" type="email" name="username" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <label htmlFor="signin-password">Password</label>
      <input id="signin-password" type="password" name="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p role="alert" className="signin-error">{error}</p>}
      <p className="signin-hint">No account, or forgot your password? Ask a Weft admin for a link.</p>
    </form>
  );
}

function LinkPage({ token, onSignedIn }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ name: '', password: '', again: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { peekLink(token).then((i) => { setInfo(i); setF((x) => ({ ...x, name: i.display_name || '' })); }).catch((e) => setError(e.message)); }, [token]);
  const leave = () => history.replaceState(null, '', location.pathname);
  if (error && !info) return <><p role="alert" className="signin-error">{error}</p><button className="btn" onClick={() => { leave(); location.reload(); }}>Go to sign-in</button></>;
  if (!info) return <p>Checking your link…</p>;
  const invite = info.purpose === 'invite';
  const mismatch = f.again && f.password !== f.again;
  return (
    <form className="signin-form" onSubmit={async (e) => {
      e.preventDefault(); if (mismatch) return; setBusy(true); setError('');
      try { const s = await signIn('link', { token, password: f.password, name: f.name }); remember(info.email, f.password); leave(); onSignedIn(s); } catch (err) { setError(err.message); setBusy(false); }
    }}>
      <p>{invite ? 'Welcome to Weft. Choose a password for' : 'Choose a new password for'} <strong>{info.email}</strong>.</p>
      {/* The email as a username field, so browsers and password managers save the password under it. */}
      <label htmlFor="link-email">Email</label>
      <input id="link-email" type="email" name="username" autoComplete="username" value={info.email} readOnly />
      {invite && (<><label htmlFor="link-name">Your name, as others will see it</label>
        <input id="link-name" autoComplete="name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></>)}
      <label htmlFor="link-password">Password (at least 12 characters)</label>
      <input id="link-password" type="password" name="new-password" autoComplete="new-password" minLength={12} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <label htmlFor="link-again">The same password again</label>
      <input id="link-again" type="password" autoComplete="new-password" required value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} aria-invalid={mismatch || undefined} />
      {mismatch && <p className="signin-hint" role="status">The two passwords are different.</p>}
      <button className="btn btn--primary" type="submit" disabled={busy || mismatch}>{busy ? 'Saving…' : invite ? 'Create my account' : 'Save and sign in'}</button>
      {error && <p role="alert" className="signin-error">{error}</p>}
    </form>
  );
}

function SignIn({ info, onSignedIn }) {
  const [error, setError] = useState('');
  const [step, setStep] = useState(info.mode === 'test' ? 'test' : linkToken() ? 'link' : 'resume');
  const go = useCallback(async (kind, arg) => {
    setError('');
    try { onSignedIn(await signIn(kind, arg)); } catch (e) { setError(e.message); }
  }, [onSignedIn]);
  // On opening Weft: an existing session first, then Cloudflare Access if it is on, then the form.
  useEffect(() => {
    if (step !== 'resume') return;
    (async () => {
      try { onSignedIn(await signIn('resume')); return; } catch { /* no session */ }
      if (info.methods.includes('cloudflare')) {
        try { onSignedIn(await signIn('cloudflare')); return; } catch (e) { if (!info.methods.includes('password')) { setError(e.message); setStep('none'); return; } }
      }
      setStep(info.methods.includes('password') ? 'password' : 'none');
    })();
  }, [step, info, onSignedIn]);

  return (
    <main className="signin">
      <h1>Weft</h1>
      {CONNECTING && <p>Sign in to connect an app to your Weft account.</p>}
      {step === 'test' && (
        <>
          <p>Test sign-in with the sample accounts. This page only answers on this machine.</p>
          <ul className="signin-list">
            {TEST_ACCOUNTS.map(([email, name]) => (
              <li key={email}><button className="btn" onClick={() => go('test', email)}>{name}</button></li>
            ))}
          </ul>
        </>
      )}
      {step === 'resume' && <p>Signing you in…</p>}
      {step === 'link' && <LinkPage token={linkToken()} onSignedIn={onSignedIn} />}
      {step === 'password' && <PasswordForm onSignedIn={onSignedIn} />}
      {error && <p role="alert" className="signin-error">{error} {step === 'none' && <button className="btn btn--sm" onClick={() => location.reload()}>Try again</button>}</p>}
    </main>
  );
}

function AccountMenu({ me, info, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(null); // null: closed
  const [status, setStatus] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const canPassword = info.mode !== 'test' && info.methods.includes('password');
  return (
    <div className="account">
      <button className="avatar" type="button" aria-label={`Signed in as ${me.display_name}`} title={me.display_name}
        aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>{me.display_name.charAt(0).toUpperCase()}</button>
      {open && (
        <div className="account-menu" role="group" aria-label="Your account">
          <p className="account-name">{me.display_name}</p>
          {canPassword && pw === null && <button className="btn btn--sm" type="button" onClick={() => { setPw({ current: '', next: '' }); setStatus(''); }}>Change password</button>}
          {pw !== null && (
            <form className="signin-form" onSubmit={async (e) => {
              e.preventDefault(); setStatus('');
              try { await auth('/password', { method: 'POST', body: pw }); setPw(null); setStatus('Password changed. Other browsers are signed out.'); }
              catch (err) { setStatus(err.message); }
            }}>
              <label htmlFor="pw-current">Current password</label>
              <input id="pw-current" type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
              <label htmlFor="pw-next">New password (at least 12 characters)</label>
              <input id="pw-next" type="password" autoComplete="new-password" minLength={12} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
              <span className="pair"><button className="btn btn--primary btn--sm" type="submit">Save</button><button className="btn btn--sm" type="button" onClick={() => setPw(null)}>Cancel</button></span>
            </form>
          )}
          {status && <p className="slot-status" role="status">{status}</p>}
          <button className="btn btn--sm" type="button" onClick={() => { setKeyOpen(true); setOpen(false); }}>Your model key</button>
          <button className="btn btn--sm" type="button" onClick={() => { setAppsOpen(true); setOpen(false); }}>Connected apps</button>
          {canPassword && <button className="btn btn--sm" type="button" onClick={onSignOut}>Sign out</button>}
        </div>
      )}
      {keyOpen && <ModelKey onClose={() => setKeyOpen(false)} />}
      {appsOpen && <ConnectedApps onClose={() => setAppsOpen(false)} />}
    </div>
  );
}

function AppPanel({ id }) {
  const a = APP[id];
  return (
    <div className="empty">
      <span className="tile" style={{ '--t': `var(${a.tint})` }}><svg viewBox="0 0 40 40" aria-hidden="true">{a.glyph}</svg></span>
      <h2>{a.label} arrives in {a.phase}</h2>
      <p>The tab, the shell and chat are real now. {a.label} will open here, saving to the same database, so the assistant can use it as context.</p>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState(null);
  const [session, setSession] = useState(null);
  const [fatal, setFatal] = useState('');
  const [ui, setUi] = useState(readHash);
  const [spaces, setSpaces] = useState([]);
  const [members, setMembers] = useState([]);
  const [unread, setUnread] = useState([]);
  const [notice, setNotice] = useState(null);
  const [live, setLive] = useState('connecting');
  const [isAdmin, setIsAdmin] = useState(null); // null until known
  const [theme, setModeState] = useState(storedMode);
  const [jump, setJump] = useState(null); // a message to scroll to, chosen in search

  useEffect(() => { authMode().then(setMode).catch((e) => setFatal(e.message)); }, []);

  useEffect(() => {
    if (!session || CONNECTING) return; // leave the address alone until signed in (it may hold a #link), and on the consent screen
    const h = new URLSearchParams();
    if (ui.tabs.length) h.set('tabs', ui.tabs.join(','));
    h.set('active', ui.active); h.set('convo', ui.convo);
    if (ui.rail !== 'normal') h.set('chat', ui.rail);
    if (ui.doc) h.set('doc', ui.doc);
    if (ui.page) h.set('page', ui.page);
    if (ui.event) h.set('event', ui.event);
    if (ui.board) h.set('board', ui.board);
    if (ui.sheet) h.set('sheet', ui.sheet);
    if (ui.list) h.set('list', ui.list);
    if (ui.kanban) h.set('kanban', ui.kanban);
    if (ui.poll) h.set('poll', ui.poll);
    if (ui.form) h.set('form', ui.form);
    if (ui.links) h.set('links', ui.links);
    if (ui.book) h.set('book', ui.book);
    if (ui.log) h.set('log', ui.log);
    if (ui.qa) h.set('qa', ui.qa);
    if (ui.checklist) h.set('checklist', ui.checklist);
    if (ui.expenses) h.set('expenses', ui.expenses);
    if (ui.inventory) h.set('inventory', ui.inventory);
    if (ui.goals) h.set('goals', ui.goals);
    if (ui.retro) h.set('retro', ui.retro);
    if (ui.glossary) h.set('glossary', ui.glossary);
    if (ui.meeting) h.set('meeting', ui.meeting);
    if (ui.notices) h.set('notices', ui.notices);
    if (ui.booking) h.set('booking', ui.booking);
    if (ui.file) h.set('file', ui.file);
    history.replaceState(null, '', `#${h}`);
  }, [ui, session]);

  const refreshSpaces = useCallback(async () => {
    const [s, m] = await Promise.all([
      api('/spaces?kind=in.(channel,dm,assistant)&select=id,kind,name,everyone,admins_only&order=name'),
      api('/members?select=space_id,role,user:users(id,display_name)'),
    ]);
    setSpaces(s); setMembers(m);
  }, []);
  const refreshUnread = useCallback(() => api('/unread').then(setUnread).catch(() => {}), []);

  useEffect(() => {
    if (!session || CONNECTING) return undefined;
    refreshSpaces().then(refreshUnread).catch((e) => setFatal(e.message));
    api(`/users?id=eq.${session.user.id}&select=is_admin`).then((r) => setIsAdmin(!!r[0]?.is_admin)).catch(() => {});
    return connectLive((n) => {
      setNotice(n);
      if (n.t === 'members') refreshSpaces().then(refreshUnread).catch(() => {});
      if (n.t === 'messages') refreshUnread();
    }, (s) => { if (s === 'disabled') setFatal('This account has been disabled. Ask a Weft admin if you think that is a mistake.'); else setLive(s); });
  }, [session, refreshSpaces, refreshUnread]);

  // A conversation that is no longer visible (left the space) falls back to the assistant.
  useEffect(() => {
    if (session && spaces.length && ui.convo !== 'weft' && !spaces.some((s) => s.id === ui.convo)) setUi((u) => ({ ...u, convo: 'weft' }));
    if (session && isAdmin === false && ui.tabs.includes('settings')) setUi((u) => ({ ...u, tabs: u.tabs.filter((t) => t !== 'settings'), active: u.active === 'settings' ? 'home' : u.active }));
  }, [spaces, session, ui.convo, ui.tabs, isAdmin]);

  const openTab = (id, extra = {}) => setUi((u) => ({ ...u, ...extra, tabs: u.tabs.includes(id) ? u.tabs : [...u.tabs, id], active: id }));
  // A weft://item link from chat: open it in Documents or Wiki. If we cannot see it, Documents shows "no access".
  const openEvent = (id) => openTab('calendar', { event: id });
  const openBooking = (id) => openTab('bookings', id ? { booking: id } : {});
  const openNotices = (spaceId) => openTab('announcements', spaceId ? { notices: spaceId } : {});
  const openItem = async (id) => {
    const r = await api(`/items?id=eq.${id}&select=kind`).catch(() => []);
    if (r[0]?.kind === 'wiki') openTab('wiki', { page: id }); else if (r[0]?.kind === 'whiteboard') openTab('whiteboard', { board: id }); else if (r[0]?.kind === 'table') openTab('sheets', { sheet: id }); else if (r[0]?.kind === 'tasklist') openTab('tasks', { list: id }); else if (r[0]?.kind === 'poll') openTab('polls', { poll: id }); else if (r[0]?.kind === 'form') openTab('forms', { form: id }); else if (r[0]?.kind === 'linklist') openTab('links', { links: id }); else if (r[0]?.kind === 'addressbook') openTab('contacts', { book: id }); else if (r[0]?.kind === 'decisionlog') openTab('decisions', { log: id }); else if (r[0]?.kind === 'qa') openTab('qa', { qa: id }); else if (r[0]?.kind === 'checklist') openTab('checklists', { checklist: id }); else if (r[0]?.kind === 'expenselist') openTab('expenses', { expenses: id }); else if (r[0]?.kind === 'inventory') openTab('inventory', { inventory: id }); else if (r[0]?.kind === 'goalset') openTab('goals', { goals: id }); else if (r[0]?.kind === 'retro') openTab('retros', { retro: id }); else if (r[0]?.kind === 'glossary') openTab('glossary', { glossary: id }); else if (r[0]?.kind === 'meeting') openTab('meetings', { meeting: id }); else if (r[0]?.kind === 'file') openTab('files', { file: id }); else openTab('documents', { doc: id });
  };
  const closeTab = (id) => setUi((u) => {
    const i = u.tabs.indexOf(id); const tabs = u.tabs.filter((t) => t !== id);
    return { ...u, tabs, active: u.active === id ? (tabs[i - 1] || tabs[i] || 'home') : u.active };
  });
  const onTabKey = (e) => {
    const ids = ['home', ...ui.tabs]; const i = ids.indexOf(ui.active);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      setUi((u) => ({ ...u, active: next })); e.preventDefault();
      requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    } else if (e.key === 'Delete' && ui.active !== 'home') closeTab(ui.active);
  };

  if (fatal) return <main className="signin"><h1>Weft</h1><p role="alert" className="signin-error">{fatal}</p></main>;
  if (!mode) return <main className="signin"><h1>Weft</h1><p>Loading…</p></main>;
  if (!session) return <SignIn info={mode} onSignedIn={setSession} />;
  if (CONNECTING) return <Connect me={session.user} />;

  const me = session.user;
  return (
    <div className="shell" data-rail={ui.rail === 'normal' ? undefined : ui.rail}>
      <header className="topbar">
        <a className="wordmark" href="#active=home" onClick={(e) => { e.preventDefault(); setUi((u) => ({ ...u, active: 'home' })); }}>Weft</a>
        <SearchBox onOpenItem={openItem} onOpenEvent={openEvent}
          onOpenChannel={(convo) => setUi((u) => ({ ...u, convo, rail: u.rail === 'collapsed' ? 'normal' : u.rail }))}
          onOpenMessage={(convo, id) => { setUi((u) => ({ ...u, convo, rail: u.rail === 'collapsed' ? 'normal' : u.rail })); setJump({ id, n: Date.now() }); }} />
        {mode.mode === 'test' && <span className="mock-note">Test sign-in</span>}
        <label className="visually-hidden" htmlFor="mode-switch">Appearance</label>
        <select id="mode-switch" className="mode-switch" value={theme} onChange={(e) => { applyMode(e.target.value); setModeState(e.target.value); }}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
        <AccountMenu me={me} info={mode} onSignOut={async () => { await signOut(); location.hash = ''; location.reload(); }} />
      </header>

      <Chat me={me} spaces={spaces} members={members} unread={unread} active={ui.convo} onSpacesChanged={refreshSpaces}
        setActive={(convo) => setUi((u) => ({ ...u, convo }))} rail={ui.rail} setRail={(rail) => setUi((u) => ({ ...u, rail }))}
        notice={notice} live={live} onOpenItem={openItem} onOpenEvent={openEvent} onOpenNotices={openNotices} jump={jump} />

      <main className="stage">
        <div className="tabs" role="tablist" aria-label="Open apps" onKeyDown={onTabKey}>
          <button className={`tab${ui.active === 'home' ? ' is-active' : ''}`} role="tab" id="tab-home" aria-selected={ui.active === 'home'}
            tabIndex={ui.active === 'home' ? 0 : -1} onClick={() => setUi((u) => ({ ...u, active: 'home' }))}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 9 10 3.5 16.5 9v7.5h-4.5v-4.5h-4v4.5H3.5z" /></svg>Home
          </button>
          {ui.tabs.map((id) => (
            <button key={id} className={`tab${ui.active === id ? ' is-active' : ''}`} role="tab" id={`tab-${id}`} aria-selected={ui.active === id}
              tabIndex={ui.active === id ? 0 : -1} onClick={() => setUi((u) => ({ ...u, active: id }))}>
              <span className="tab-dot" style={{ '--t': `var(${APP[id].tint})` }} aria-hidden="true" />{APP[id].label}
              <span className="tab-close" role="button" aria-label={`Close ${APP[id].label}`} onClick={(e) => { e.stopPropagation(); closeTab(id); }}>×</span>
            </button>
          ))}
        </div>

        <section className="panel" role="tabpanel" aria-labelledby={`tab-${ui.active}`}>
          {ui.active === 'home' ? (
            <div className="home">
              <h1 className="home-title">Open an app</h1>
              <ul className="apps">
                {APPS.filter((a) => !a.admin || isAdmin).map((a) => (
                  <li key={a.id}><a className="app" href={`#active=${a.id}`} onClick={(e) => { e.preventDefault(); openTab(a.id); }}>
                    <span className="tile" style={{ '--t': `var(${a.tint})` }}><svg viewBox="0 0 40 40" aria-hidden="true">{a.glyph}</svg></span>
                    <span className="app-name">{a.label}</span>
                  </a></li>
                ))}
              </ul>
              <Widgets me={me} spaces={spaces} unread={unread} notice={notice} onOpenItem={openItem} onOpenEvent={openEvent} onOpenNotices={openNotices} onOpenBooking={openBooking} onOpenShifts={() => openTab('shifts')} onOpenProfiles={() => openTab('profiles')} onOpenTimeOff={() => openTab('timeoff')}
                onOpenConvo={(convo) => setUi((u) => ({ ...u, convo, rail: u.rail === 'collapsed' ? 'normal' : u.rail }))} />
            </div>
          ) : ui.active === 'settings' ? (isAdmin ? <AdminPanel me={me} info={mode} /> : null)
            : ui.active === 'documents' ? <Docs key="documents" kind="document" me={me} members={members} notice={notice} openId={ui.doc} setOpenId={(doc) => setUi((u) => ({ ...u, doc }))} />
            : ui.active === 'wiki' ? <Docs key="wiki" kind="wiki" me={me} members={members} notice={notice} openId={ui.page} setOpenId={(page) => setUi((u) => ({ ...u, page }))} />
            : ui.active === 'whiteboard' ? <Docs key="whiteboard" kind="whiteboard" me={me} members={members} notice={notice} openId={ui.board} setOpenId={(board) => setUi((u) => ({ ...u, board }))} />
            : ui.active === 'sheets' ? <Docs key="sheets" kind="table" me={me} members={members} notice={notice} openId={ui.sheet} setOpenId={(sheet) => setUi((u) => ({ ...u, sheet }))} />
            : ui.active === 'tasks' ? <Docs key="tasks" kind="tasklist" me={me} members={members} notice={notice} openId={ui.list} setOpenId={(list) => setUi((u) => ({ ...u, list }))} onSwitch={(kanban) => openTab('boards', { kanban })} />
            : ui.active === 'boards' ? <Docs key="boards" kind="tasklist" view="board" me={me} members={members} notice={notice} openId={ui.kanban} setOpenId={(kanban) => setUi((u) => ({ ...u, kanban }))} onSwitch={(list) => openTab('tasks', { list })} />
            : ui.active === 'polls' ? <Docs key="polls" kind="poll" me={me} members={members} notice={notice} openId={ui.poll} setOpenId={(poll) => setUi((u) => ({ ...u, poll }))} />
            : ui.active === 'forms' ? <Docs key="forms" kind="form" me={me} members={members} notice={notice} openId={ui.form} setOpenId={(form) => setUi((u) => ({ ...u, form }))} />
            : ui.active === 'meetings' ? <Docs key="meetings" kind="meeting" me={me} members={members} notice={notice} onOpenEvent={openEvent} onOpenItem={openItem} openId={ui.meeting} setOpenId={(meeting) => setUi((u) => ({ ...u, meeting }))} />
            : ui.active === 'links' ? <Docs key="links" kind="linklist" me={me} members={members} notice={notice} openId={ui.links} setOpenId={(links) => setUi((u) => ({ ...u, links }))} />
            : ui.active === 'contacts' ? <Docs key="contacts" kind="addressbook" me={me} members={members} notice={notice} openId={ui.book} setOpenId={(book) => setUi((u) => ({ ...u, book }))} />
            : ui.active === 'decisions' ? <Docs key="decisions" kind="decisionlog" me={me} members={members} notice={notice} openId={ui.log} setOpenId={(log) => setUi((u) => ({ ...u, log }))} />
            : ui.active === 'checklists' ? <Docs key="checklists" kind="checklist" me={me} members={members} notice={notice} openId={ui.checklist} setOpenId={(checklist) => setUi((u) => ({ ...u, checklist }))} />
            : ui.active === 'expenses' ? <Docs key="expenses" kind="expenselist" me={me} members={members} notice={notice} openId={ui.expenses} setOpenId={(expenses) => setUi((u) => ({ ...u, expenses }))} />
            : ui.active === 'inventory' ? <Docs key="inventory" kind="inventory" me={me} members={members} notice={notice} openId={ui.inventory} setOpenId={(inventory) => setUi((u) => ({ ...u, inventory }))} />
            : ui.active === 'retros' ? <Docs key="retros" kind="retro" me={me} members={members} notice={notice} onOpenItem={openItem} openId={ui.retro} setOpenId={(retro) => setUi((u) => ({ ...u, retro }))} />
            : ui.active === 'glossary' ? <Docs key="glossary" kind="glossary" me={me} members={members} notice={notice} openId={ui.glossary} setOpenId={(glossary) => setUi((u) => ({ ...u, glossary }))} />
            : ui.active === 'goals' ? <Docs key="goals" kind="goalset" me={me} members={members} notice={notice} openId={ui.goals} setOpenId={(goals) => setUi((u) => ({ ...u, goals }))} />
            : ui.active === 'qa' ? <Docs key="qa" kind="qa" me={me} members={members} notice={notice} openId={ui.qa} setOpenId={(qa) => setUi((u) => ({ ...u, qa }))} />
            : ui.active === 'announcements' ? <Announcements me={me} spaces={spaces} members={members} notice={notice} openId={ui.notices} setOpenId={(notices) => setUi((u) => ({ ...u, notices }))} />
            : ui.active === 'files' ? <Docs key="files" kind="file" me={me} members={members} notice={notice} openId={ui.file} setOpenId={(file) => setUi((u) => ({ ...u, file }))} />
            : ui.active === 'bookings' ? <Bookings me={me} spaces={spaces} members={members} notice={notice} openId={ui.booking} setOpenId={(booking) => setUi((u) => ({ ...u, booking }))} />
            : ui.active === 'profiles' ? <Profiles me={me} spaces={spaces} members={members} notice={notice} />
            : ui.active === 'timeoff' ? <TimeOff me={me} spaces={spaces} members={members} notice={notice} />
            : ui.active === 'shifts' ? <Shifts me={me} spaces={spaces} members={members} notice={notice} />
            : ui.active === 'rsvps' ? <Rsvps me={me} notice={notice} onOpenEvent={openEvent} />
            : ui.active === 'calendar' ? <Calendar me={me} members={members} notice={notice} onOpenItem={openItem} onOpenBooking={openBooking} onOpenTimeOff={() => openTab('timeoff')} focusId={ui.event} setFocusId={(event) => setUi((u) => ({ ...u, event }))} />
            : <AppPanel id={ui.active} />}
        </section>
      </main>
    </div>
  );
}
