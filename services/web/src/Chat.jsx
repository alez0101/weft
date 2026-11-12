import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const ASSISTANT = 'weft';
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "@Name" segments rendered as mentions.
function Body({ text }) {
  const parts = text.split(/(@[A-Za-z][\w-]*)/g);
  return <p>{parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="mention">{p}</span> : p))}</p>;
}

export default function Chat({ me, spaces, members, unread, active, setActive, rail, setRail, notice, live }) {
  const [messages, setMessages] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const nameOf = useCallback((space) => {
    if (space.kind !== 'dm') return space.name;
    const other = members.find((m) => m.space_id === space.id && m.user?.id !== me.id);
    return other?.user?.display_name ?? 'Direct message';
  }, [members, me.id]);

  const channels = spaces.filter((s) => s.kind === 'channel');
  const dms = spaces.filter((s) => s.kind === 'dm');
  const current = spaces.find((s) => s.id === active);
  const count = (id) => unread.find((u) => u.space_id === id);

  const load = useCallback(async (spaceId) => {
    setState('loading');
    setError('');
    try {
      const rows = await api(`/messages?space_id=eq.${spaceId}&select=id,body,created_at,author_id,author:users(display_name,is_assistant)&order=created_at.asc&limit=200`);
      setMessages(rows);
      setState('ready');
      await api('/reads?on_conflict=space_id,user_id', {
        method: 'POST', body: { space_id: spaceId, last_read_at: new Date().toISOString() },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (e) { setError(e.message); setState('error'); }
  }, []);

  useEffect(() => { if (active && active !== ASSISTANT) load(active); }, [active, load]);

  // A live notice for the open conversation: fetch just that row (RLS decides) and append.
  useEffect(() => {
    if (!notice || notice.t !== 'messages' || notice.space !== active) return;
    if (notice.op === 'DELETE') { setMessages((m) => m.filter((x) => x.id !== notice.id)); return; }
    api(`/messages?id=eq.${notice.id}&select=id,body,created_at,author_id,author:users(display_name,is_assistant)`)
      .then((rows) => {
        if (!rows.length) return;
        setMessages((m) => (m.some((x) => x.id === rows[0].id) ? m.map((x) => (x.id === rows[0].id ? rows[0] : x)) : [...m, rows[0]]));
        api('/reads?on_conflict=space_id,user_id', {
          method: 'POST', body: { space_id: active, last_read_at: new Date().toISOString() },
          prefer: 'resolution=merge-duplicates,return=minimal',
        }).catch(() => {});
      }).catch(() => {});
  }, [notice, active]);

  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !current) return;
    setSending(true);
    try {
      await api('/messages', { method: 'POST', body: { space_id: current.id, body }, prefer: 'return=minimal' });
      setDraft(''); // the live notice brings the message back into the list
    } catch (err) { setError(`Not sent: ${err.message}`); }
    setSending(false);
  }

  const ConvoButton = ({ id, icon, label, meta }) => {
    const c = count(id);
    return (
      <button className={`convo${active === id ? ' is-active' : ''}`} aria-current={active === id ? 'true' : undefined}
        aria-label={label} title={label}
        onClick={() => { if (rail === 'collapsed') setRail('normal'); setActive(id); }}>
        {icon}
        <span className="convo-name">{label}</span>
        {meta && <span className="convo-meta">{meta}</span>}
        {c?.unread > 0 && active !== id && (
          <span className={`convo-count${c.mentions > 0 ? ' has-mention' : ''}`} aria-label={`${c.unread} unread${c.mentions ? ', mentions you' : ''}`}>
            {c.mentions > 0 ? '@' : c.unread}
          </span>
        )}
      </button>
    );
  };

  const title = active === ASSISTANT ? 'Weft' : current ? (current.kind === 'channel' ? `# ${current.name}` : nameOf(current)) : '';
  const sub = active === ASSISTANT ? 'The assistant arrives in Phase 3b.'
    : current?.kind === 'channel' ? `${members.filter((m) => m.space_id === current.id).length} members` : 'Direct message';

  return (
    <aside className="rail" aria-label="Chat">
      <nav className="convos" aria-label="Conversations">
        <div className="rail-head">
          <h2 className="rail-title">Chat</h2>
          <div className="rail-size" role="group" aria-label="Chat width">
            {rail !== 'collapsed' && <button className="icon-btn" type="button" aria-label="Collapse chat" title="Collapse chat" onClick={() => setRail('collapsed')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5 7.5 10l5 5" /></svg></button>}
            {rail === 'wide' && <button className="icon-btn" type="button" aria-label="Normal chat width" title="Normal width" onClick={() => setRail('normal')}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="1.5" /><path d="M8 4.5v11" /></svg></button>}
            {rail !== 'wide' && <button className="icon-btn" type="button" aria-label="Expand chat" title="Expand chat" onClick={() => setRail('wide')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5" /></svg></button>}
          </div>
        </div>
        <ul className="convo-list">
          <li><ConvoButton id={ASSISTANT} icon={<span className="who who--agent" aria-hidden="true">W</span>} label="Weft" meta="assistant" /></li>
        </ul>
        <p className="convo-group">Channels</p>
        <ul className="convo-list">
          {channels.map((s) => <li key={s.id}><ConvoButton id={s.id} icon={<span className="hash" aria-hidden="true" data-initial={s.name.charAt(0)}>#</span>} label={s.name} /></li>)}
          {!channels.length && <li className="convo-empty">No channels yet.</li>}
        </ul>
        <p className="convo-group">Direct messages</p>
        <ul className="convo-list">
          {dms.map((s) => <li key={s.id}><ConvoButton id={s.id} icon={<span className="who" aria-hidden="true">{nameOf(s).charAt(0)}</span>} label={nameOf(s)} /></li>)}
          {!dms.length && <li className="convo-empty">No direct messages.</li>}
        </ul>
      </nav>

      <section className="thread" aria-live="polite">
        <header className="thread-head">
          <h3>{title}</h3>
          <p className="thread-sub">{sub}{live !== 'live' && active !== ASSISTANT ? ' · reconnecting' : ''}</p>
        </header>
        {active === ASSISTANT ? (
          <div className="thread-empty"><p>The assistant answers here once Phase 3b is built: from what you can open, with sources you can click.</p></div>
        ) : state === 'loading' ? (
          <div className="skeleton skeleton--chat" aria-label="Loading messages"><span /><span /><span /></div>
        ) : state === 'error' ? (
          <div className="thread-empty" role="alert"><p>Messages could not load: {error}</p><button className="btn btn--sm" onClick={() => load(active)}>Try again</button></div>
        ) : (
          <ol className="messages" ref={listRef}>
            {messages.length === 0 && <li className="thread-empty"><p>No messages yet. Say hello.</p></li>}
            {messages.map((m) => {
              const mine = m.author_id === me.id;
              return (
                <li key={m.id} className={`msg${mine ? ' msg--me' : ''}${m.author?.is_assistant ? ' msg--agent' : ''}`}>
                  <p className="msg-who">{mine ? 'You' : m.author?.display_name} <time dateTime={m.created_at}>{time(m.created_at)}</time></p>
                  <Body text={m.body} />
                </li>
              );
            })}
          </ol>
        )}
        {error && state === 'ready' && <p className="send-error" role="alert">{error}</p>}
        <form className="composer" onSubmit={send}>
          <label className="visually-hidden" htmlFor="compose">Message</label>
          <input id="compose" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)}
            disabled={active === ASSISTANT || sending}
            placeholder={active === ASSISTANT ? 'The assistant arrives in Phase 3b' : `Message ${title}`} />
          <button className="btn btn--primary btn--sm" type="submit" disabled={active === ASSISTANT || sending || !draft.trim()}>Send</button>
        </form>
      </section>
    </aside>
  );
}
