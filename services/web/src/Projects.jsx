import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Projects inside channels (069). A channel (or your personal space) can hold projects; each has its own chat,
// instructions for Weft and pinned items. Members see them; only owners of the space make and change them.
// The channel stays the only permission unit, so nothing here changes who can see what.

// The strip under a conversation's title: General (the channel's own chat) and one chip per open project.
export function ProjectStrip({ projects, active, onPick, owner, onCreate, rulesOpen, onToggleRules }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const open = projects.filter((p) => !p.archived_at);
  async function create(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setErr('');
    try { const p = await onCreate(n); setName(''); setAdding(false); onPick(p.id); }
    catch (x) { setErr(/duplicate|unique|409/i.test(x.message) ? 'A project with that name already exists here.' : x.message); }
  }
  return (
    <div className="project-strip">
      <div className="links-tags" role="group" aria-label="Chat in">
        <button type="button" className="link-tag" aria-pressed={!active} onClick={() => onPick(null)}>General</button>
        {open.map((p) => (
          <button key={p.id} type="button" className="link-tag" aria-pressed={active === p.id} onClick={() => onPick(p.id)}>{p.name}</button>
        ))}
        {owner && !adding && <button type="button" className="link-btn project-add" onClick={() => setAdding(true)}>+ Project</button>}
        <button type="button" className="link-btn project-rules-btn" aria-expanded={rulesOpen} onClick={onToggleRules}>
          {active ? 'Project settings' : 'Rules'}
        </button>
      </div>
      {adding && (
        <form className="pair project-new" onSubmit={create}>
          <label className="visually-hidden" htmlFor="project-name">Project name</label>
          <input id="project-name" value={name} maxLength={80} autoFocus placeholder="Project name"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }} />
          <button className="btn btn--primary btn--sm" type="submit" disabled={!name.trim()}>Make project</button>
          <button className="btn btn--sm" type="button" onClick={() => { setAdding(false); setErr(''); }}>Cancel</button>
        </form>
      )}
      {err && <p className="send-error" role="alert">{err}</p>}
    </div>
  );
}

// What Weft follows here, in one line ("Weft follows: #scouts rules · Scouting for Food").
export function following(space, rules, project) {
  const parts = [];
  if (rules?.instructions?.trim()) parts.push(space.kind === 'personal' ? 'your Personal rules' : `#${space.name} rules`);
  if (project?.instructions?.trim()) parts.push(project.name);
  return parts.length ? `Weft follows: ${parts.join(' · ')}` : null;
}

// Settings for the space's rules (General) or for one project. Owners edit; everyone else reads.
export function RulesPanel({ space, rules, project, owner, onChanged, onClose, onOpenItem, onArchived }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [agents, setAgents] = useState(true);
  const [pins, setPins] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // Fill the form when the panel opens or moves to another project or space; not after our own save reloads the
  // same project, so the "Saved" note stays and nothing typed is replaced.
  const which = `${space.id}|${project?.id || ''}`;
  useEffect(() => {
    setText((project ? project.instructions : rules?.instructions) || '');
    setName(project?.name || '');
    setAgents(rules ? rules.agents_may_read !== false : true);
    setMsg(''); setErr('');
  }, [which]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!project) { setPins([]); return; }
    api(`/project_pins?project_id=eq.${project.id}&select=id,item:items(id,title,kind)&order=position,created_at`)
      .then(setPins).catch(() => setPins([]));
  }, [project]);

  const where = space.kind === 'personal' ? 'your personal space' : `#${space.name}`;
  async function save(e) {
    e.preventDefault();
    setErr(''); setMsg('');
    try {
      if (project) {
        await api(`/projects?id=eq.${project.id}`, { method: 'PATCH', body: { name: name.trim() || project.name, instructions: text }, prefer: 'return=minimal' });
      } else {
        // The space's id never changes once set, so change the row if there is one, otherwise make it.
        const set = { instructions: text, ...(space.kind === 'channel' ? { agents_may_read: agents } : {}) };
        if (rules) await api(`/space_rules?space_id=eq.${space.id}`, { method: 'PATCH', body: set, prefer: 'return=minimal' });
        else await api('/space_rules', { method: 'POST', body: { space_id: space.id, ...set }, prefer: 'return=minimal' });
      }
      setMsg('Saved. Weft follows this from the next question.');
      onChanged();
    } catch (x) { setErr(`Not saved: ${x.message}`); }
  }
  async function archive(on) {
    setErr('');
    try {
      await api(`/projects?id=eq.${project.id}`, { method: 'PATCH', body: { archived_at: on ? new Date().toISOString() : null }, prefer: 'return=minimal' });
      onChanged(); if (on) onArchived();
    } catch (x) { setErr(x.message); }
  }
  async function remove() {
    if (!window.confirm(`Delete the project "${project.name}"? Its chat is deleted. Its documents and events stay in ${where}, with no project. Archive it instead to keep the chat.`)) return;
    try { await api(`/projects?id=eq.${project.id}`, { method: 'DELETE', prefer: 'return=minimal' }); onChanged(); onArchived(); }
    catch (x) { setErr(x.message); }
  }
  async function unpin(id) {
    try { await api(`/project_pins?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' }); setPins((p) => p.filter((x) => x.id !== id)); }
    catch (x) { setErr(x.message); }
  }

  return (
    <div className="project-panel">
      <form onSubmit={save} className="project-form">
        {project && owner && (
          <label className="project-field">
            <span>Project name</span>
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label className="project-field">
          <span>{project ? `Instructions for Weft in ${project.name}` : `Rules for Weft in ${where}`}</span>
          {owner
            ? <textarea rows={5} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={project ? 'For example: Pickup is Saturday at 9. Answer as the event organiser.' : 'For example: Keep answers short. Use the pack\'s own words for things.'} />
            : <span className="project-readonly">{text.trim() || 'None set.'}</span>}
        </label>
        <p className="docs-hint">
          {project
            ? 'Weft follows the application rules first, then the channel\'s rules, then these, then each person\'s own rules for how answers look.'
            : 'Projects in here add their own instructions on top of these. Earlier versions are kept.'}
          {!owner && ' Only owners can change them.'}
        </p>
        {!project && space.kind === 'channel' && (
          <label className="toggle">
            <input type="checkbox" checked={agents} disabled={!owner} onChange={(e) => setAgents(e.target.checked)} />
            Allow AI agents to read this channel
          </label>
        )}
        {!project && space.kind === 'channel' && (
          <p className="docs-hint">AI agents are people's own assistants, such as Claude, OpenClaw or Hermes, connected to Weft. Turned off, they cannot see anything here, and what members write here never reaches them.</p>
        )}
        {owner && (
          <span className="pair">
            <button className="btn btn--primary btn--sm" type="submit">Save</button>
            <button className="btn btn--sm" type="button" onClick={onClose}>Close</button>
          </span>
        )}
      </form>
      {project && (
        <div className="project-pins">
          <p className="tree-group">Pinned for Weft</p>
          {pins.length ? (
            <ul>{pins.map((p) => (
              <li key={p.id} className="pair">
                <button type="button" className="link-btn" onClick={() => onOpenItem(p.item.id)}>{p.item.title}</button>
                {owner && <button type="button" className="link-btn" onClick={() => unpin(p.id)} aria-label={`Unpin ${p.item.title}`}>Unpin</button>}
              </li>
            ))}</ul>
          ) : <p className="docs-hint">Nothing pinned yet. Open a document in this project and choose "Pin for Weft": Weft then always reads it when answering here.</p>}
        </div>
      )}
      {project && owner && (
        <p className="pair project-danger">
          {project.archived_at
            ? <button className="btn btn--sm" type="button" onClick={() => archive(false)}>Reopen project</button>
            : <button className="btn btn--sm" type="button" onClick={() => archive(true)}>Archive project</button>}
          <button className="btn btn--sm" type="button" onClick={remove}>Delete project</button>
        </p>
      )}
      {!owner && <button className="btn btn--sm" type="button" onClick={onClose}>Close</button>}
      {msg && <p className="slot-status" role="status">{msg}</p>}
      {err && <p className="send-error" role="alert">{err}</p>}
    </div>
  );
}

// Your own rules (069): how Weft's answers to you look. Only you read them, and they never change facts.
export function MyRules({ onClose }) {
  const ref = useRef(null);
  const [text, setText] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    ref.current?.showModal();
    api('/user_prefs?select=ai_instructions').then((r) => setText(r[0]?.ai_instructions || '')).catch((e) => { setText(''); setStatus(e.message); });
  }, []);
  async function save(e) {
    e.preventDefault(); setStatus('');
    try {
      await api('/user_prefs?on_conflict=user_id', { method: 'POST', body: { ai_instructions: text }, prefer: 'resolution=merge-duplicates,return=minimal' });
      setStatus('Saved. Weft uses them from your next question.');
    } catch (x) { setStatus(`Not saved: ${x.message}`); }
  }
  return (
    <dialog ref={ref} className="people" aria-labelledby="myrules-title" onClose={onClose}>
      <header className="people-head">
        <h2 id="myrules-title">Your rules for Weft</h2>
        <button className="icon-btn" type="button" aria-label="Close" onClick={() => ref.current.close()}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <p className="admin-lead">How you like Weft's answers: length, format, tone. They apply only when you ask, wherever you ask. They come after Weft's own rules and the channel's and project's instructions, and they never change facts. Only you can see them.</p>
      {text === null ? <div className="skeleton" aria-label="Loading"><span /><span /></div> : (
        <form className="project-form" onSubmit={save}>
          <label className="project-field">
            <span>Your rules</span>
            <textarea rows={6} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: Keep answers to two sentences. Use bullet points for lists." />
          </label>
          <span className="pair"><button className="btn btn--primary btn--sm" type="submit">Save</button></span>
        </form>
      )}
      {status && <p className="slot-status" role="status">{status}</p>}
    </dialog>
  );
}
