import { useCallback, useEffect, useState } from 'react';
import { api, auth, authMode, connectLive, peekLink, signIn, signOut } from './api.js';
import Chat from './Chat.jsx';
import AdminPanel from './AdminPanel.jsx';
import Docs from './Docs.jsx';
import Calendar from './Calendar.jsx';
import Widgets from './Home.jsx';
import ModelKey from './ModelKey.jsx';
import SearchBox from './Search.jsx';
import { applyMode, storedMode } from './mode.js';

const APPS = [
  { id: 'documents', label: 'Documents', tint: '--p-thu', real: true, glyph: <><path d="M11 6h13l7 7v21H11z" /><path d="M24 6v7h7M16 20h10M16 25h10M16 30h6" /></> },
  { id: 'wiki', label: 'Wiki', tint: '--p-fri', real: true, glyph: <><path d="M8 9c4-2 8-2 12 1 4-3 8-3 12-1v23c-4-2-8-2-12 1-4-3-8-3-12-1z" /><path d="M20 10v23" /></> },
  { id: 'whiteboard', label: 'Whiteboard', tint: '--p-wed', real: true, glyph: <><rect x="6" y="8" width="28" height="20" rx="2" /><path d="M12 22c3-6 6 2 9-4s5 1 7-2M14 34l6-6 6 6" /></> },
  { id: 'sheets', label: 'Sheets', tint: '--p-tue', real: true, glyph: <><rect x="7" y="8" width="26" height="24" rx="2" /><path d="M7 16h26M7 24h26M16 8v24M25 8v24" /></> },
  { id: 'calendar', label: 'Calendar', tint: '--p-mon', real: true, glyph: <><rect x="7" y="9" width="26" height="24" rx="2" /><path d="M7 16h26M14 6v6M26 6v6M13 22h4M19 22h4M25 22h2M13 27h4" /></> },
  { id: 'tasks', label: 'Tasks', tint: '--p-sun', real: true, glyph: <><rect x="8" y="7" width="24" height="27" rx="2" /><path d="M13 15l2.5 2.5L20 13M23 15.5h4M13 23l2.5 2.5L20 21M23 23.5h4M14 30h12" /></> },
  { id: 'polls', label: 'Polls', tint: '--p-thu', real: true, glyph: <><path d="M8 33h24" /><rect x="10" y="19" width="5" height="14" rx="1" /><rect x="17.5" y="11" width="5" height="22" rx="1" /><rect x="25" y="15" width="5" height="18" rx="1" /><path d="M17 6.5l2.5 2.5L24 4.5" /></> },
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
    doc: h.get('doc') || null, page: h.get('page') || null, event: h.get('event') || null, board: h.get('board') || null, sheet: h.get('sheet') || null, list: h.get('list') || null, poll: h.get('poll') || null, file: h.get('file') || null,
  };
};

// The secret of an invite or reset link travels in the URL fragment (#link=...), which browsers never
// send to a server or in a Referer.
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
      try { onSignedIn(await signIn('password', f)); } catch (err) { setError(err.message); setBusy(false); }
    }}>
      <label htmlFor="signin-email">Email</label>
      <input id="signin-email" type="email" autoComplete="username" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <label htmlFor="signin-password">Password</label>
      <input id="signin-password" type="password" autoComplete="current-password" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
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
      try { const s = await signIn('link', { token, password: f.password, name: f.name }); leave(); onSignedIn(s); } catch (err) { setError(err.message); setBusy(false); }
    }}>
      <p>{invite ? 'Welcome to Weft. Choose a password for' : 'Choose a new password for'} <strong>{info.email}</strong>.</p>
      {invite && (<><label htmlFor="link-name">Your name, as others will see it</label>
        <input id="link-name" autoComplete="name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></>)}
      <label htmlFor="link-password">Password (at least 12 characters)</label>
      <input id="link-password" type="password" autoComplete="new-password" minLength={12} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
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
          {canPassword && <button className="btn btn--sm" type="button" onClick={onSignOut}>Sign out</button>}
        </div>
      )}
      {keyOpen && <ModelKey onClose={() => setKeyOpen(false)} />}
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
    if (!session) return; // leave the address alone until signed in (it may hold a #link)
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
    if (ui.poll) h.set('poll', ui.poll);
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
    if (!session) return undefined;
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
  const openItem = async (id) => {
    const r = await api(`/items?id=eq.${id}&select=kind`).catch(() => []);
    if (r[0]?.kind === 'wiki') openTab('wiki', { page: id }); else if (r[0]?.kind === 'whiteboard') openTab('whiteboard', { board: id }); else if (r[0]?.kind === 'table') openTab('sheets', { sheet: id }); else if (r[0]?.kind === 'tasklist') openTab('tasks', { list: id }); else if (r[0]?.kind === 'poll') openTab('polls', { poll: id }); else if (r[0]?.kind === 'file') openTab('files', { file: id }); else openTab('documents', { doc: id });
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
        notice={notice} live={live} onOpenItem={openItem} onOpenEvent={openEvent} jump={jump} />

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
              <Widgets me={me} spaces={spaces} unread={unread} notice={notice} onOpenItem={openItem} onOpenEvent={openEvent}
                onOpenConvo={(convo) => setUi((u) => ({ ...u, convo, rail: u.rail === 'collapsed' ? 'normal' : u.rail }))} />
            </div>
          ) : ui.active === 'settings' ? (isAdmin ? <AdminPanel me={me} info={mode} /> : null)
            : ui.active === 'documents' ? <Docs key="documents" kind="document" me={me} members={members} notice={notice} openId={ui.doc} setOpenId={(doc) => setUi((u) => ({ ...u, doc }))} />
            : ui.active === 'wiki' ? <Docs key="wiki" kind="wiki" me={me} members={members} notice={notice} openId={ui.page} setOpenId={(page) => setUi((u) => ({ ...u, page }))} />
            : ui.active === 'whiteboard' ? <Docs key="whiteboard" kind="whiteboard" me={me} members={members} notice={notice} openId={ui.board} setOpenId={(board) => setUi((u) => ({ ...u, board }))} />
            : ui.active === 'sheets' ? <Docs key="sheets" kind="table" me={me} members={members} notice={notice} openId={ui.sheet} setOpenId={(sheet) => setUi((u) => ({ ...u, sheet }))} />
            : ui.active === 'tasks' ? <Docs key="tasks" kind="tasklist" me={me} members={members} notice={notice} openId={ui.list} setOpenId={(list) => setUi((u) => ({ ...u, list }))} />
            : ui.active === 'polls' ? <Docs key="polls" kind="poll" me={me} members={members} notice={notice} openId={ui.poll} setOpenId={(poll) => setUi((u) => ({ ...u, poll }))} />
            : ui.active === 'files' ? <Docs key="files" kind="file" me={me} members={members} notice={notice} openId={ui.file} setOpenId={(file) => setUi((u) => ({ ...u, file }))} />
            : ui.active === 'calendar' ? <Calendar me={me} members={members} notice={notice} onOpenItem={openItem} focusId={ui.event} setFocusId={(event) => setUi((u) => ({ ...u, event }))} />
            : <AppPanel id={ui.active} />}
        </section>
      </main>
    </div>
  );
}
