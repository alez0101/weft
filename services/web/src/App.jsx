import { useCallback, useEffect, useState } from 'react';
import { api, authMode, connectLive, signIn } from './api.js';
import Chat from './Chat.jsx';
import AdminPanel from './AdminPanel.jsx';
import Docs from './Docs.jsx';
import Calendar from './Calendar.jsx';
import { applyMode, storedMode } from './mode.js';

const APPS = [
  { id: 'documents', label: 'Documents', tint: '--p-thu', real: true, glyph: <><path d="M11 6h13l7 7v21H11z" /><path d="M24 6v7h7M16 20h10M16 25h10M16 30h6" /></> },
  { id: 'wiki', label: 'Wiki', tint: '--p-fri', real: true, glyph: <><path d="M8 9c4-2 8-2 12 1 4-3 8-3 12-1v23c-4-2-8-2-12 1-4-3-8-3-12-1z" /><path d="M20 10v23" /></> },
  { id: 'whiteboard', label: 'Whiteboard', tint: '--p-wed', phase: 'version 1.5', glyph: <><rect x="6" y="8" width="28" height="20" rx="2" /><path d="M12 22c3-6 6 2 9-4s5 1 7-2M14 34l6-6 6 6" /></> },
  { id: 'sheets', label: 'Sheets', tint: '--p-tue', phase: 'version 1.5', glyph: <><rect x="7" y="8" width="26" height="24" rx="2" /><path d="M7 16h26M7 24h26M16 8v24M25 8v24" /></> },
  { id: 'calendar', label: 'Calendar', tint: '--p-mon', real: true, glyph: <><rect x="7" y="9" width="26" height="24" rx="2" /><path d="M7 16h26M14 6v6M26 6v6M13 22h4M19 22h4M25 22h2M13 27h4" /></> },
  { id: 'files', label: 'Files', tint: '--p-sat', phase: 'a later version', glyph: <path d="M6 12h10l3 3h15v17H6z" /> },
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
    doc: h.get('doc') || null, page: h.get('page') || null, event: h.get('event') || null,
  };
};

function SignIn({ mode, onSignedIn }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(mode === 'access');
  const go = useCallback(async (email) => {
    setBusy(true); setError('');
    try { onSignedIn(await signIn(mode, email)); } catch (e) { setError(e.message); setBusy(false); }
  }, [mode, onSignedIn]);
  useEffect(() => { if (mode === 'access') go(); }, [mode, go]);

  return (
    <main className="signin">
      <h1>Weft</h1>
      {mode === 'test' ? (
        <>
          <p>Test sign-in. This page only answers on the Weft server itself; the public address uses Cloudflare Access.</p>
          <ul className="signin-list">
            {TEST_ACCOUNTS.map(([email, name]) => (
              <li key={email}><button className="btn" disabled={busy} onClick={() => go(email)}>{name}</button></li>
            ))}
          </ul>
        </>
      ) : busy ? <p>Signing you in…</p> : null}
      {error && <p role="alert" className="signin-error">{error} {mode === 'access' && <button className="btn btn--sm" onClick={() => location.reload()}>Try again</button>}</p>}
    </main>
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

  useEffect(() => { authMode().then(setMode).catch((e) => setFatal(e.message)); }, []);

  useEffect(() => {
    const h = new URLSearchParams();
    if (ui.tabs.length) h.set('tabs', ui.tabs.join(','));
    h.set('active', ui.active); h.set('convo', ui.convo);
    if (ui.rail !== 'normal') h.set('chat', ui.rail);
    if (ui.doc) h.set('doc', ui.doc);
    if (ui.page) h.set('page', ui.page);
    if (ui.event) h.set('event', ui.event);
    history.replaceState(null, '', `#${h}`);
  }, [ui]);

  const refreshSpaces = useCallback(async () => {
    const [s, m] = await Promise.all([
      api('/spaces?kind=in.(channel,dm,assistant)&select=id,kind,name&order=name'),
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
    }, setLive);
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
    if (r[0]?.kind === 'wiki') openTab('wiki', { page: id }); else openTab('documents', { doc: id });
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
  if (!session) return <SignIn mode={mode} onSignedIn={setSession} />;

  const me = session.user;
  return (
    <div className="shell" data-rail={ui.rail === 'normal' ? undefined : ui.rail}>
      <header className="topbar">
        <a className="wordmark" href="#active=home" onClick={(e) => { e.preventDefault(); setUi((u) => ({ ...u, active: 'home' })); }}>Weft</a>
        <label className="search">
          <span className="visually-hidden">Search</span>
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></svg>
          <input type="search" placeholder="Search arrives with the assistant" disabled />
        </label>
        <span className="mock-note">{mode === 'test' ? 'Test sign-in, sample data' : 'Sample data'}</span>
        <label className="visually-hidden" htmlFor="mode-switch">Appearance</label>
        <select id="mode-switch" className="mode-switch" value={theme} onChange={(e) => { applyMode(e.target.value); setModeState(e.target.value); }}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
        <button className="avatar" type="button" aria-label={`Signed in as ${me.display_name}`} title={me.display_name}>{me.display_name.charAt(0).toUpperCase()}</button>
      </header>

      <Chat me={me} spaces={spaces} members={members} unread={unread} active={ui.convo}
        setActive={(convo) => setUi((u) => ({ ...u, convo }))} rail={ui.rail} setRail={(rail) => setUi((u) => ({ ...u, rail }))}
        notice={notice} live={live} onOpenItem={openItem} onOpenEvent={openEvent} />

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
            </div>
          ) : ui.active === 'settings' ? (isAdmin ? <AdminPanel /> : null)
            : ui.active === 'documents' ? <Docs key="documents" kind="document" me={me} members={members} notice={notice} openId={ui.doc} setOpenId={(doc) => setUi((u) => ({ ...u, doc }))} />
            : ui.active === 'wiki' ? <Docs key="wiki" kind="wiki" me={me} members={members} notice={notice} openId={ui.page} setOpenId={(page) => setUi((u) => ({ ...u, page }))} />
            : ui.active === 'calendar' ? <Calendar me={me} members={members} notice={notice} focusId={ui.event} setFocusId={(event) => setUi((u) => ({ ...u, event }))} />
            : <AppPanel id={ui.active} />}
        </section>
      </main>
    </div>
  );
}
