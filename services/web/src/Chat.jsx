import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, assistant } from './api.js';
import { ChannelPeople, NewChannel } from './People.jsx';
import { Pinned } from './Announcements.jsx';
import { ProjectStrip, RulesPanel, following } from './Projects.jsx';
import { MessageTaskForm, MessageTasks, useMessageTasks } from './MessageTask.jsx';

const ASSISTANT = 'weft'; // URL alias for the person's own assistant space
const SEL = 'id,body,created_at,author_id,meta,project_id,author:users(display_name,is_assistant)';
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "@Name" segments rendered as mentions; weft://item/<id> links rendered as an open button.
const ITEM = /weft:\/\/item\/([0-9a-f-]{36})/;
const EVENT = /weft:\/\/event\/([0-9a-f-]{36})/;
function Body({ text, onOpenItem, onOpenEvent }) {
  const parts = text.split(/(@[A-Za-z][\w-]*|weft:\/\/(?:item|event)\/[0-9a-f-]{36})/g);
  return <p>{parts.map((p, i) => {
    if (p.startsWith('@')) return <span key={i} className="mention">{p}</span>;
    const m = ITEM.exec(p);
    if (m) return <button key={i} type="button" className="source item-link" onClick={() => onOpenItem(m[1])}>Open it</button>;
    const ev = EVENT.exec(p);
    if (ev) return <button key={i} type="button" className="source item-link" onClick={() => onOpenEvent(ev[1])}>Open in Calendar</button>;
    return p;
  })}</p>;
}

export default function Chat({ me, spaces, personal = null, agents = [], agentSpaces = [], members, unread, active: activeRaw, setActive, rail, setRail, onFull, notice, live, onOpenItem, onOpenEvent, onOpenNotices, onOpenRecord, onSpacesChanged, jump }) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const assistantSpace = spaces.find((s) => s.kind === 'assistant');
  const active = activeRaw === ASSISTANT ? (assistantSpace?.id ?? ASSISTANT) : activeRaw;
  const [thinking, setThinking] = useState(false);
  // Agent questions in flight, by space: { [spaceId]: agent name }. Several at once, one per conversation.
  const [working, setWorking] = useState({});
  const [renaming, setRenaming] = useState(null);
  const [focus, setFocus] = useState(null);
  useEffect(() => { if (jump?.id) setFocus(jump.id); }, [jump]); // a message chosen in search
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
  const current = spaces.find((s) => s.id === active) ?? agentSpaces.find((s) => s.id === active) ?? (personal?.id === active ? personal : undefined);
  // Projects (069): channels and the personal space have General plus their projects, each with its own chat.
  const hasProjects = current?.kind === 'channel' || current?.kind === 'personal';
  const [projects, setProjects] = useState([]);
  const [rules, setRules] = useState(null);
  const [projBy, setProjBy] = useState({});          // the chosen project per space (null: General)
  const [rulesOpen, setRulesOpen] = useState(false);
  const [info, setInfo] = useState('');
  const pid = hasProjects && projects.some((p) => p.id === projBy[active]) ? projBy[active] : null;
  const project = projects.find((p) => p.id === pid) || null;
  const owner = current?.kind === 'personal' || members.some((m) => m.space_id === current?.id && m.user?.id === me.id && m.role === 'owner');
  const loadProjects = useCallback(async (spaceId) => {
    const [p, r] = await Promise.all([
      api(`/projects?space_id=eq.${spaceId}&select=id,name,instructions,archived_at&order=name`),
      api(`/space_rules?space_id=eq.${spaceId}&select=instructions,agents_may_read`),
    ]);
    setProjects(p); setRules(r[0] || null);
  }, []);
  useEffect(() => {
    setRulesOpen(false); setInfo('');
    if (hasProjects && active) loadProjects(active).catch(() => { setProjects([]); setRules(null); });
    else { setProjects([]); setRules(null); }
  }, [active, hasProjects, loadProjects]);
  useEffect(() => {
    if (hasProjects && notice && ['projects', 'space_rules'].includes(notice.t) && notice.space === active) loadProjects(active).catch(() => {});
  }, [notice, active, hasProjects, loadProjects]);
  // Task from a message (077): in channels and Personal, editors and owners make a task from any message.
  const taskSpace = ['channel', 'personal'].includes(current?.kind) ? current.id : null;
  const canEdit = current?.kind === 'personal' || members.some((m) => m.space_id === current?.id && m.user?.id === me.id && ['owner', 'editor'].includes(m.role));
  const { lists: taskLists, byMessage: tasksBy } = useMessageTasks(taskSpace, !!taskSpace, notice);
  const [taskFor, setTaskFor] = useState(null);       // the message whose Add a task form is open
  const [lastList, setLastList] = useState({});       // the list last used, per space
  useEffect(() => { setTaskFor(null); }, [active]);
  const spacePeople = members.filter((m) => m.space_id === current?.id && m.user).map((m) => m.user)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  const agentOf = (space) => agents.find((a) => a.id === space?.agent_id);
  const curAgent = current?.kind === 'agent' ? agentOf(current) : null;
  const busy = !!(current && working[current.id]);
  const count = (id) => unread.find((u) => u.space_id === id);

  const load = useCallback(async (spaceId, projectId = null) => {
    setState('loading');
    setError('');
    try {
      // The latest 200, oldest first (fetched newest first so a long conversation shows its end, not its start).
      const rows = (await api(`/messages?space_id=eq.${spaceId}&project_id=${projectId ? `eq.${projectId}` : 'is.null'}&select=${SEL}&order=created_at.desc&limit=200`)).reverse();
      setMessages(rows); setAround(false);
      setState('ready');
      await api('/reads?on_conflict=space_id,user_id', {
        method: 'POST', body: { space_id: spaceId, last_read_at: new Date().toISOString() },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (e) { setError(e.message); setState('error'); }
  }, []);

  useEffect(() => { if (active && active !== ASSISTANT) load(active, pid); }, [active, pid, load]);
  // Jumping to a message (from search or a citation): find where it lives first, as the person, then open that
  // conversation and the right project's chat (General or a project), and load the messages around it if it is
  // older than the latest ones loaded. Say so when it cannot be shown.
  const [target, setTarget] = useState(null);   // {id, space_id, project_id, created_at, widened: false | 'loading' | true}
  const [around, setAround] = useState(false);  // showing older messages around a target, not the latest
  useEffect(() => {
    if (!focus) return undefined;
    let gone = false;
    api(`/messages?id=eq.${focus}&select=id,space_id,project_id,created_at`).then(([m]) => {
      if (gone) return;
      setFocus(null);
      if (!m) { setInfo('That message is no longer here, or it was in a project that has been deleted.'); return; }
      setProjBy((p) => ({ ...p, [m.space_id]: m.project_id || null }));
      setTarget({ ...m, widened: false });
      if (m.space_id !== active) setActive(m.space_id);
    }).catch(() => { if (!gone) setFocus(null); });
    return () => { gone = true; };
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!target || target.widened === 'loading' || state !== 'ready' || active !== target.space_id || (pid ?? null) !== (target.project_id ?? null)) return;
    const el = document.getElementById(`msg-${target.id}`);
    if (el) {
      // Scroll only the message list (scrollIntoView would also scroll the page around it).
      const list = listRef.current;
      if (list) list.scrollTop += el.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - el.clientHeight) / 2;
      el.classList.add('is-focus'); setTimeout(() => el.classList.remove('is-focus'), 2400);
      setTarget(null); return;
    }
    if (!target.widened) {   // older than the latest loaded: load the stretch around it
      setTarget((t) => ({ ...t, widened: 'loading' }));   // look again only once the older messages are in
      const base = `/messages?space_id=eq.${target.space_id}&project_id=${target.project_id ? `eq.${target.project_id}` : 'is.null'}&select=${SEL}`;
      const at = encodeURIComponent(target.created_at);
      Promise.all([api(`${base}&created_at=lte.${at}&order=created_at.desc&limit=100`), api(`${base}&created_at=gt.${at}&order=created_at.asc&limit=100`)])
        .then(([before, after]) => { setMessages([...before.reverse(), ...after]); setAround(true); setTarget((t) => (t ? { ...t, widened: true } : t)); })
        .catch(() => { setInfo('That message could not be shown.'); setTarget(null); });
      return;
    }
    setInfo('That message could not be shown here.'); setTarget(null);
  }, [target, state, messages, active, pid]);

  // A live notice for the open conversation: fetch just that row (RLS decides) and append.
  useEffect(() => {
    if (!notice || notice.t !== 'messages' || notice.space !== active) return;
    if (notice.op === 'DELETE') { setMessages((m) => m.filter((x) => x.id !== notice.id)); return; }
    api(`/messages?id=eq.${notice.id}&select=${SEL}`)
      .then((rows) => {
        if (!rows.length || (rows[0].project_id ?? null) !== pid) return;   // another project's chat in this space
        setMessages((m) => (m.some((x) => x.id === rows[0].id) ? m.map((x) => (x.id === rows[0].id ? rows[0] : x)) : [...m, rows[0]]));
        api('/reads?on_conflict=space_id,user_id', {
          method: 'POST', body: { space_id: active, last_read_at: new Date().toISOString() },
          prefer: 'resolution=merge-duplicates,return=minimal',
        }).catch(() => {});
      }).catch(() => {});
  }, [notice, active, pid]);

  // An agent's reply landing in a space (open or not) ends that space's "working" line.
  useEffect(() => {
    if (!notice || notice.t !== 'messages' || notice.op !== 'INSERT' || !working[notice.space]) return;
    api(`/messages?id=eq.${notice.id}&select=author_id`).then((rows) => {
      if (rows[0] && agents.some((a) => a.id === rows[0].author_id)) setWorking((w) => { const n = { ...w }; delete n[notice.space]; return n; });
    }).catch(() => {});
  }, [notice, working, agents]);

  useEffect(() => { const el = listRef.current; if (el && !focus && !target && !around) el.scrollTop = el.scrollHeight; }, [messages, focus, target, around]);

  async function askAgent(messageId, spaceId, name) {
    setWorking((w) => ({ ...w, [spaceId]: name }));
    const stop = () => setWorking((w) => { const n = { ...w }; delete n[spaceId]; return n; });
    setTimeout(stop, 11 * 60 * 1000);   // the service gives up after 10 minutes and posts an error reply
    try { await assistant('/agents/ask', { method: 'POST', body: { message_id: messageId } }); }
    catch (err) { stop(); setError(`${name} couldn't answer: ${err.message}`); }
  }

  async function send(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !current) return;
    setSending(true); setError('');
    let sent;
    try {
      [sent] = await api('/messages', { method: 'POST', body: { space_id: current.id, body, ...(pid ? { project_id: pid } : {}) }, prefer: 'return=representation' });
      setDraft(''); // the live notice brings the message back into the list
    } catch (err) { setError(`Not sent: ${err.message}`); }
    setSending(false);
    if (sent && current.kind === 'agent' && curAgent) {
      if (current.name === 'New conversation' && messages.length === 0) {   // name it after its first message
        const name = body.replace(/\s+/g, ' ').slice(0, 60);
        api(`/spaces?id=eq.${current.id}`, { method: 'PATCH', body: { name }, prefer: 'return=minimal' }).then(onSpacesChanged).catch(() => {});
      }
      await askAgent(sent.id, current.id, curAgent.display_name);
      return;
    }
    const mentioned = current.kind === 'assistant' ? null : agents.find((a) => a.enabled && new RegExp(`@${a.handle}\\b`, 'i').test(body));
    if (sent && mentioned) {
      // 070: asked in a channel or direct message, a personal agent answers privately, in your Personal space.
      if (current.kind === 'personal') askAgent(sent.id, current.id, mentioned.display_name);
      else {
        setInfo(`${mentioned.display_name} will answer in your Personal space, where only you can see it. Move the answer here if you want to share it.`);
        assistant('/agents/ask', { method: 'POST', body: { message_id: sent.id } }).catch((err) => { setInfo(''); setError(`${mentioned.display_name} couldn't answer: ${err.message}`); });
      }
    }
    if (sent && (current.kind === 'assistant' || /@weft\b/i.test(body))) {
      setThinking(true);
      try { await assistant('/ask', { method: 'POST', body: { message_id: sent.id, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }); } catch (err) { setError(`Weft couldn't answer: ${err.message}`); }
      setThinking(false);
    }
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

  const title = current?.kind === 'assistant' || active === ASSISTANT ? 'Weft' : current ? (current.kind === 'channel' ? `# ${current.name}` : current.kind === 'agent' ? current.name : nameOf(current)) : '';
  const sub = current?.kind === 'assistant' ? 'Answers from everything you can open, with links to where each answer came from. In a channel, @Weft answers only from that channel.'
    : current?.kind === 'agent' ? `With ${curAgent?.display_name ?? 'your agent'}. Only you can see this conversation.`
    : current?.kind === 'channel' ? null
    : current?.kind === 'personal' ? 'Only you can see this. Your own agents answer here; move anything into a channel to share it.'
    : 'Direct message';

  async function newConversation(agent) {
    setError('');
    try {
      const id = await api('/rpc/create_agent_conversation', { method: 'POST', body: { p_agent: agent.id } });
      await onSpacesChanged(); setActive(id);
      if (rail === 'normal') setRail('wide');   // a conversation with an agent wants room
    } catch (err) { setError(`Could not start a conversation: ${err.message}`); }
  }
  async function renameConversation(e) {
    e.preventDefault();
    const name = renaming.trim();
    if (!name) return;
    try { await api(`/spaces?id=eq.${current.id}`, { method: 'PATCH', body: { name: name.slice(0, 80) }, prefer: 'return=minimal' }); setRenaming(null); await onSpacesChanged(); }
    catch (err) { setError(`Could not rename: ${err.message}`); }
  }
  async function deleteConversation() {
    if (!window.confirm(`Delete the conversation "${current.name}"? Its messages are removed from Weft.`)) return;
    try { await api(`/spaces?id=eq.${current.id}`, { method: 'DELETE', prefer: 'return=minimal' }); await onSpacesChanged(); setActive(ASSISTANT); }
    catch (err) { setError(`Could not delete: ${err.message}`); }
  }
  const memberCount = current?.kind === 'channel' ? members.filter((m) => m.space_id === current.id).length : 0;

  return (
    <aside className="rail" aria-label="Chat">
      <nav className="convos" aria-label="Conversations">
        <div className="rail-head">
          <h2 className="rail-title">Chat</h2>
          <div className="rail-size" role="group" aria-label="Chat width">
            {rail === 'full'
              ? <button className="icon-btn" type="button" aria-pressed="true" aria-label="Exit full screen chat" title="Exit full screen (Esc)" onClick={onFull}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3.5V8H3.5M12 3.5V8h4.5M8 16.5V12H3.5M12 16.5V12h4.5" /></svg></button>
              : <>
              {rail !== 'collapsed' && <button className="icon-btn" type="button" aria-label="Collapse chat" title="Collapse chat" onClick={() => setRail('collapsed')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 5 7.5 10l5 5" /></svg></button>}
              {rail === 'wide' && <button className="icon-btn" type="button" aria-label="Normal chat width" title="Normal width" onClick={() => setRail('normal')}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4.5" width="13" height="11" rx="1.5" /><path d="M8 4.5v11" /></svg></button>}
              {rail !== 'wide' && <button className="icon-btn" type="button" aria-label="Expand chat" title="Expand chat" onClick={() => setRail('wide')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5" /></svg></button>}
              {rail !== 'collapsed' && <button className="icon-btn" type="button" aria-pressed="false" aria-label="Full screen chat" title="Full screen chat" onClick={onFull}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8V3.5H8M16.5 8V3.5H12M3.5 12v4.5H8M16.5 12v4.5H12" /></svg></button>}
              </>}
          </div>
        </div>
        <ul className="convo-list">
          <li><ConvoButton id={assistantSpace?.id ?? ASSISTANT} icon={<span className="who who--agent" aria-hidden="true">W</span>} label="Weft" meta="assistant" /></li>
          {personal && <li><ConvoButton id={personal.id} icon={<span className="who" aria-hidden="true">{(me.display_name || 'P').charAt(0)}</span>} label="Personal" meta="only you" /></li>}
        </ul>
        {agents.map((a) => {
          const convos = agentSpaces.filter((s) => s.agent_id === a.id);
          return (
            <div key={a.id} className="agent-group">
              <div className="convo-group convo-group--action">
                <p>{a.display_name}{a.enabled ? '' : ' (turned off)'}</p>
                {rail !== 'collapsed' && a.enabled && <button className="icon-btn" type="button" aria-label={`New conversation with ${a.display_name}`} title="New conversation" onClick={() => newConversation(a)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg></button>}
              </div>
              <ul className="convo-list">
                {convos.map((s) => <li key={s.id}><ConvoButton id={s.id} icon={<span className="who who--agent" aria-hidden="true">{a.display_name.charAt(0)}</span>} label={s.name} meta={working[s.id] ? 'working' : undefined} /></li>)}
                {!convos.length && <li className="convo-empty">{a.enabled ? 'No conversations yet. Press + to start one.' : 'Turned off by an admin.'}</li>}
              </ul>
            </div>
          );
        })}
        <div className="convo-group convo-group--action">
          <p>Channels</p>
          {rail !== 'collapsed' && !creating && <button className="icon-btn" type="button" aria-label="New channel" title="New channel" onClick={() => setCreating(true)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg></button>}
        </div>
        {creating && <NewChannel onCancel={() => setCreating(false)} onCreated={async (id) => { await onSpacesChanged(); setCreating(false); setActive(id); setPeopleOpen(true); }} />}
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
          <p className="thread-sub">{current?.kind === 'agent' && renaming === null ? <>{sub} <button type="button" className="link-btn" onClick={() => setRenaming(current.name)}>Rename</button> · <button type="button" className="link-btn" onClick={deleteConversation}>Delete</button></> : sub ?? <button type="button" className="link-btn" onClick={() => setPeopleOpen(true)} aria-haspopup="dialog">{memberCount} {memberCount === 1 ? 'member' : 'members'}, see people</button>}{live !== 'live' && active !== ASSISTANT ? ' (reconnecting)' : ''}</p>
          {peopleOpen && current?.kind === 'channel' && <ChannelPeople key={current.id} me={me} space={current} onClose={() => { setPeopleOpen(false); onSpacesChanged().catch(() => {}); }}
            onGone={async () => { setPeopleOpen(false); await onSpacesChanged().catch(() => {}); setActive(ASSISTANT); }} />}
          {current?.kind === 'agent' && renaming !== null && (
            <form className="pair agent-rename" onSubmit={renameConversation}>
              <label className="visually-hidden" htmlFor="agent-rename">Conversation name</label>
              <input id="agent-rename" value={renaming} maxLength={80} autoFocus onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }} />
              <button className="btn btn--primary btn--sm" type="submit" disabled={!renaming.trim()}>Save</button>
              <button className="btn btn--sm" type="button" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          )}
          {hasProjects && (
            <ProjectStrip projects={projects} active={pid} owner={owner} rulesOpen={rulesOpen}
              onPick={(id) => { setProjBy((m) => ({ ...m, [active]: id })); setRulesOpen(false); }}
              onToggleRules={() => setRulesOpen((v) => !v)}
              onCreate={async (name) => {
                const [p] = await api('/projects', { method: 'POST', body: { space_id: current.id, name }, prefer: 'return=representation' });
                await loadProjects(current.id); return p;
              }} />
          )}
          {hasProjects && following(current, rules, project) && <p className="thread-sub project-following">{following(current, rules, project)}</p>}
          {hasProjects && rulesOpen && (
            <RulesPanel space={current} rules={rules} project={project} owner={owner} onOpenItem={onOpenItem}
              onChanged={() => loadProjects(current.id).catch(() => {})} onClose={() => setRulesOpen(false)}
              onArchived={() => { setProjBy((m) => ({ ...m, [active]: null })); setRulesOpen(false); }} />
          )}
          {around && (   // in the header: the panel is a grid of header, messages and message box
            <p className="thread-sub around-bar" role="status">Showing older messages.{' '}
              <button type="button" className="link-btn" onClick={() => load(active, pid)}>Back to the latest</button></p>
          )}
          {current?.kind === 'channel' && <Pinned spaceId={current.id} notice={notice} me={me} onOpenAll={() => onOpenNotices(current.id)} />}
        </header>
        {active === ASSISTANT ? (
          <div className="thread-empty"><p>Setting up your conversation with Weft…</p></div>
        ) : state === 'loading' ? (
          <div className="skeleton skeleton--chat" aria-label="Loading messages"><span /><span /><span /></div>
        ) : state === 'error' ? (
          <div className="thread-empty" role="alert"><p>Messages could not load: {error}</p><button className="btn btn--sm" onClick={() => load(active)}>Try again</button></div>
        ) : (
          <ol className="messages" ref={listRef}>
            {messages.length === 0 && <li className="thread-empty"><p>{current?.kind === 'assistant' ? 'Ask Weft about anything in your channels and messages.'
              : current?.kind === 'agent' ? `Ask ${curAgent?.display_name ?? 'your agent'} anything. Each conversation is its own thread, so you can keep different jobs apart.`
              : project ? `No messages in ${project.name} yet. Talk about the project here; @Weft answers with its instructions.`
              : current?.kind === 'personal' ? 'Notes to yourself, and answers from your own agents, land here.'
              : 'No messages yet. Say hello.'}</p></li>}
            {messages.map((m) => {
              const mine = m.author_id === me.id;
              return (
                <li key={m.id} id={`msg-${m.id}`} className={`msg${mine ? ' msg--me' : ''}${m.author?.is_assistant ? ' msg--agent' : ''}${m.meta?.agent ? ' msg--own-agent' : ''}${m.meta?.agent && m.meta.error ? ' msg--failed' : ''}`}>
                  <p className="msg-who">{mine ? 'You' : m.author?.display_name} <time dateTime={m.created_at}>{time(m.created_at)}</time></p>
                  <Body text={m.body} onOpenItem={onOpenItem} onOpenEvent={onOpenEvent} />
                  {m.meta?.citations?.length > 0 && (
                    <p className="sources">{m.meta.citations.map((c, i) => (c.type === 'web'
                      ? /^https?:\/\//.test(c.url || '') && <a key={c.url} className="source source-web" href={c.url} target="_blank" rel="noopener noreferrer nofollow" title={c.url}>[{i + 1}] {c.label} ↗</a>
                      : <button key={c.id} type="button" className="source" title={`Open ${c.label}`}
                        onClick={() => {
                          if (c.type === 'item') return onOpenItem(c.id);
                          if (c.type === 'event') return onOpenEvent(c.id);
                          if (c.type === 'record') return onOpenRecord?.(c);
                          setFocus(c.id);   // the jump finds its conversation and project
                        }}>
                        [{i + 1}] {c.label}
                      </button>
                    ))}</p>
                  )}
                  {m.meta?.proposals?.length > 0 && <Proposals list={m.meta.proposals} mine={m.meta.asker === me.id} members={members} asker={m.meta.asker} notice={notice} onOpenItem={onOpenItem} />}
                  {taskSpace && <MessageTasks tasks={tasksBy[m.id]} onOpenItem={onOpenItem} />}
                  {taskSpace && canEdit && taskFor !== m.id && (
                    <p className="msg-actions"><button type="button" className="link-btn msg-action" onClick={() => { setTaskFor(m.id); setInfo(''); }}>Make a task<span className="visually-hidden"> from this message</span></button></p>
                  )}
                  {taskSpace && canEdit && taskFor === m.id && (
                    <MessageTaskForm message={m} spaceId={taskSpace} lists={taskLists} people={spacePeople} me={me} lastList={lastList[taskSpace]}
                      onCancel={() => setTaskFor(null)}
                      onAdded={({ listId, listName, title: t }) => { setTaskFor(null); setLastList((l) => ({ ...l, [taskSpace]: listId })); setInfo(`Added "${t.length > 60 ? `${t.slice(0, 59)}…` : t}" to ${listName}.`); }} />
                  )}
                  {m.author?.is_assistant && m.meta && !m.meta.agent && (
                    <p className="served-by">{m.meta.served_by ? `Answered by ${m.meta.served_by.model}${m.meta.served_by.slot === 'personal' ? (m.meta.asker === me.id ? ' with your own key' : " with the asker's own key") : ''}` : 'No model answered'}{m.meta.fallback ? ` (fallback: ${m.meta.fallback})` : ''}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {thinking && <p className="thinking" role="status">Weft is looking through what you can see…</p>}
        {busy && <p className="thinking" role="status">{working[current.id]} is working on it. You can switch to another conversation in the meantime.</p>}
        {info && <p className="thinking" role="status">{info}</p>}
        {error && state === 'ready' && <p className="send-error" role="alert">{error}</p>}
        <form className="composer" onSubmit={send}>
          <label className="visually-hidden" htmlFor="compose">Message</label>
          <input id="compose" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)}
            disabled={active === ASSISTANT || sending || thinking || busy}
            placeholder={current?.kind === 'assistant' ? 'Ask Weft' : current?.kind === 'agent' ? `Message ${curAgent?.display_name ?? 'your agent'}`
              : `Message ${project ? `${title} › ${project.name}` : title}${current?.kind === 'channel' ? ` (@Weft${agents.some((a) => a.enabled) ? ` or @${agents.find((a) => a.enabled).handle}` : ''} to ask)` : ''}`} />
          <button className="btn btn--primary btn--sm" type="submit" disabled={active === ASSISTANT || sending || thinking || busy || !draft.trim()}>Send</button>
        </form>
      </section>
    </aside>
  );
}

// Actions Weft proposed. Only the person who asked can confirm; everyone else sees who decides.
const UNDOABLE = new Set(['change', 'create', 'create_item', 'edit_page', 'add_rows', 'add_tasks', 'edit_sheet']);
function Proposals({ list, mine, members, asker, notice, onOpenItem }) {
  const [status, setStatus] = useState({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const refresh = useCallback(() => {
    if (!mine) return;
    assistant(`/proposals?ids=${list.map((p) => p.id).join(',')}`).then((rows) => setStatus(Object.fromEntries(rows.map((r) => [r.id, r])))).catch(() => {});
  }, [list, mine]);
  useEffect(() => { refresh(); }, [refresh, notice]);
  const who = members.find((m) => m.user?.id === asker)?.user?.display_name ?? 'the person who asked';
  const act = async (id, action) => {
    setBusy(id); setErr('');
    try { await assistant(`/proposals/${id}/${action}`, { method: 'POST', body: {} }); } catch (e) { setErr(e.message); }
    setBusy(''); refresh();
  };
  return (
    <div className="proposals">
      {list.map((p) => {
        const s = status[p.id]?.status ?? 'pending';
        return (
          <div key={p.id} className={`proposal is-${s}`}>
            <p className="proposal-what">{p.summary}</p>
            {!mine ? <p className="proposal-state">Waiting for {who} to confirm.</p>
              : s === 'pending' ? (
                <span className="pair">
                  <button className="btn btn--primary btn--sm" disabled={busy === p.id} onClick={() => act(p.id, 'confirm')}>Confirm</button>
                  <button className="btn btn--sm" disabled={busy === p.id} onClick={() => act(p.id, 'dismiss')}>Dismiss</button>
                </span>
              ) : (
                <p className="proposal-state">
                  {s === 'done' ? (status[p.id]?.result || 'Done.') : s === 'dismissed' ? 'Dismissed.' : s === 'undone' ? 'Undone.' : (status[p.id]?.result || 'Failed.')}
                  {s === 'done' && status[p.id]?.item_id && onOpenItem && <button className="btn btn--sm proposal-open" onClick={() => onOpenItem(status[p.id].item_id)}>Open</button>}
                  {s === 'done' && UNDOABLE.has(p.kind) && <button className="btn btn--sm proposal-undo" disabled={busy === p.id} onClick={() => act(p.id, 'undo')}>Undo</button>}
                </p>
              )}
          </div>
        );
      })}
      {err && <p className="send-error" role="alert">{err}</p>}
    </div>
  );
}
