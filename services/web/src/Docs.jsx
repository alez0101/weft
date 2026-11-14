// Documents and Wiki: one component, two kinds. The list comes from the API (row-level security
// decides what appears); the editor is BlockNote co-edited live through the collab server, which
// decides read-only vs read-write per person.
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { useCreateBlockNote } from '@blocknote/react';
import { withCollaboration } from '@blocknote/core/yjs'; // Yjs 13 binding, matching Hocuspocus
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { api, currentToken, uploadFile } from './api.js';
import FileView from './Files.jsx';
import { useEffectiveMode } from './mode.js';
import Board from './Board.jsx';
import Table from './Table.jsx';
import TaskList from './TaskList.jsx';
import Kanban from './Kanban.jsx';
import Poll from './Poll.jsx';
import LinkList from './LinkList.jsx';
import Meeting from './Meeting.jsx';
import Form from './Form.jsx';

// Cursor colours come from the theme tokens (deeper tints so the name tags stay readable).
const CURSOR_TOKENS = ['--color-accent-deep', '--color-accent', '--color-ink-2', '--color-muted'];
const colorFor = (id) => {
  const token = CURSOR_TOKENS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % CURSOR_TOKENS.length];
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || 'currentColor';
};
const spaceLabel = (s) => (s.kind === 'personal' ? 'Personal' : s.kind === 'channel' ? `#${s.name}` : s.name);

function Editor({ item, me, onStatus }) {
  const [state] = useState(() => {
    const doc = new Y.Doc();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
    const provider = new HocuspocusProvider({ url, name: item.id, document: doc, token: () => currentToken() });
    return { doc, provider };
  });
  const [scope, setScope] = useState(null);
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    const { provider } = state;
    const onSynced = () => setSynced(true);
    provider.on('synced', onSynced);
    if (provider.isSynced) setSynced(true);
    const onAuth = ({ scope: s }) => { setScope(s); onStatus(s === 'read-write' ? 'Editing live' : 'View only: you can read this but not change it'); };
    const onFail = () => onStatus('You no longer have access to this document.');
    const onStatusChange = ({ status }) => { if (status === 'disconnected') onStatus('Reconnecting…'); };
    provider.on('authenticated', onAuth); provider.on('authenticationFailed', onFail); provider.on('status', onStatusChange);
    return () => { provider.off('synced', onSynced); provider.off('authenticated', onAuth); provider.off('authenticationFailed', onFail); provider.off('status', onStatusChange); provider.destroy(); state.doc.destroy(); };
  }, [state, onStatus]);

  // The editor is created only after the first sync, so it binds to the server's blocks instead of
  // inventing its own starting block (see the collab server's onLoadDocument).
  if (!synced) return <div className="skeleton" aria-label="Opening the document"><span /><span /><span /></div>;
  return <SyncedEditor state={state} me={me} editable={scope === 'read-write'} />;
}

function SyncedEditor({ state, me, editable }) {
  const appearance = useEffectiveMode();
  // BlockNote 0.57: collaboration is opted into with withCollaboration(); a bare `collaboration`
  // option is silently ignored and the editor runs on a private, unsynced document.
  const editor = useCreateBlockNote(withCollaboration({
    collaboration: {
      provider: state.provider,
      fragment: state.doc.getXmlFragment('document-store'),
      user: { id: me.id, name: me.display_name, color: colorFor(me.id) },
    },
  }), [state]);
  return <BlockNoteView editor={editor} editable={editable} theme={appearance} />;
}

export default function Docs({ kind, view, me, members, openId, setOpenId, notice, onSwitch, onOpenEvent, onOpenItem }) {
  const [spaces, setSpaces] = useState([]);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [title, setTitle] = useState('');
  const [newSpace, setNewSpace] = useState('');
  const [shareTo, setShareTo] = useState('');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [uploading, setUploading] = useState('');
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        api('/spaces?kind=in.(channel,personal)&select=id,kind,name&order=kind.desc,name'),
        api(`/items?kind=eq.${kind}&select=id,title,space_id,parent_id,updated_at,managed&order=${kind === 'meeting' ? 'created_at.desc' : 'title'}`),
      ]);
      setSpaces(s); setItems(i); setError('');
    } catch (e) { setError(e.message); }
  }, [kind]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (notice?.t === 'items') load(); }, [notice, load]);
  // A page republished from the repo reopens with a fresh copy (never merged into the old one).
  const [fresh, setFresh] = useState(0);
  useEffect(() => { if (notice?.t === 'doc_reset' && notice.id === openId) { setFresh((n) => n + 1); load(); } }, [notice, openId, load]);

  const myRole = (spaceId) => members.find((m) => m.space_id === spaceId && m.user?.id === me.id)?.role
    ?? (spaces.find((s) => s.id === spaceId)?.kind === 'personal' ? 'owner' : null);
  const canEditIn = (spaceId) => ['owner', 'editor'].includes(myRole(spaceId));
  const current = items?.find((i) => i.id === openId);
  const currentSpace = spaces.find((s) => s.id === current?.space_id);

  // An id we cannot see: either it does not exist or it is in a space we are not in.
  useEffect(() => {
    setMissing(false);
    if (!openId || !items || current) return;
    api(`/items?id=eq.${openId}&select=id`).then((r) => setMissing(r.length === 0)).catch(() => setMissing(true));
  }, [openId, items, current]);
  useEffect(() => { setTitle(current?.title ?? ''); setStatus(''); setNote(''); }, [current?.id, current?.title]);

  const editable = spaces.filter((s) => canEditIn(s.id));
  useEffect(() => { if (!newSpace && editable.length) setNewSpace((editable.find((s) => s.kind === 'personal') || editable[0]).id); }, [editable, newSpace]);
  const channels = spaces.filter((s) => s.kind === 'channel');

  async function create() {
    try {
      const parent = kind === 'wiki' && current && current.space_id === newSpace ? current.id : null;
      const [row] = await api('/items', { method: 'POST', body: { space_id: newSpace, kind, title: kind === 'wiki' ? 'New page' : kind === 'whiteboard' ? 'Untitled whiteboard' : kind === 'table' ? 'Untitled table' : kind === 'tasklist' ? 'New task list' : kind === 'poll' ? 'New poll' : kind === 'form' ? 'New form' : kind === 'linklist' ? 'Useful links' : kind === 'meeting' ? `Meeting ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'Untitled document', parent_id: parent }, prefer: 'return=representation' });
      if (kind === 'poll') await api('/poll_choices', { method: 'POST', body: [{ poll_id: row.id, label: 'Yes', position: 0 }, { poll_id: row.id, label: 'No', position: 1 }], prefer: 'return=minimal' });
      if (kind === 'form') await api('/form_questions', { method: 'POST', body: { form_id: row.id, label: 'Your name', kind: 'short', required: true, position: 0 }, prefer: 'return=minimal' });
      if (kind === 'table') await api('/table_columns', { method: 'POST', body: { table_id: row.id, name: 'Name', type: 'text', position: 0 }, prefer: 'return=minimal' });
      await load(); setOpenId(row.id);
    } catch (e) { setError(`Could not create: ${e.message}`); }
  }
  async function upload(fileList) {
    const files = [...(fileList || [])];
    if (!files.length || !newSpace) return;
    setError(''); let last = null;
    for (const [n, f] of files.entries()) {
      setUploading(`Uploading ${f.name}${files.length > 1 ? ` (${n + 1} of ${files.length})` : ''}…`);
      try { last = await uploadFile(newSpace, f); } catch (e) { setError(`${f.name}: ${e.message}`); }
    }
    setUploading(''); await load(); if (last) setOpenId(last.id);
  }
  async function saveTitle() {
    if (!current || title.trim() === current.title || !title.trim()) return;
    try { await api(`/items?id=eq.${current.id}`, { method: 'PATCH', body: { title: title.trim() }, prefer: 'return=minimal' }); load(); } catch (e) { setError(`Could not rename: ${e.message}`); }
  }
  async function moveTo(spaceId) {
    const target = spaces.find((s) => s.id === spaceId);
    if (!current || !target) return;
    try {
      await api(`/items?id=eq.${current.id}`, { method: 'PATCH', body: { space_id: spaceId, parent_id: null }, prefer: 'return=minimal' });
      setNote(`Moved to ${spaceLabel(target)}. Only people in ${spaceLabel(target)} can open it now.`); load();
    } catch (e) { setError(`Could not move: ${e.message}`); }
  }
  async function remove() {
    if (!current || !window.confirm(`Delete "${current.title}"? Everyone in ${spaceLabel(currentSpace)} will lose it.${kind === 'wiki' ? ' Its sub-pages move to the top level.' : ''}`)) return;
    try { await api(`/items?id=eq.${current.id}`, { method: 'DELETE', prefer: 'return=minimal' }); setOpenId(null); load(); }
    catch (e) { setError(`Could not delete: ${e.message}`); }
  }
  async function share() {
    const ch = channels.find((c) => c.id === shareTo);
    if (!ch || !current) return;
    try {
      await api('/messages', { method: 'POST', body: { space_id: ch.id, body: `Shared "${current.title}": weft://item/${current.id}` }, prefer: 'return=minimal' });
      setNote(ch.id === current.space_id ? `Shared in #${ch.name}.` : `Shared in #${ch.name}. Only people who are also in ${spaceLabel(currentSpace)} can open it.`);
    } catch (e) { setError(`Could not share: ${e.message}`); }
  }

  // Group by space; for the wiki, nest pages under their parent.
  const groups = useMemo(() => spaces.map((s) => ({ s, rows: (items || []).filter((i) => i.space_id === s.id) })).filter((g) => g.rows.length), [spaces, items]);
  const renderRows = (rows, parent = null, depth = 0) => rows
    .filter((r) => (kind === 'wiki' ? (r.parent_id ?? null) === parent || (depth === 0 && r.parent_id && !rows.some((x) => x.id === r.parent_id)) : true))
    .map((r) => (
      <li key={r.id}>
        <button className={`doc-link${r.id === openId ? ' is-active' : ''}`} style={{ paddingLeft: `calc(var(--space-xs) + ${depth} * var(--space-md))` }}
          aria-current={r.id === openId ? 'page' : undefined} onClick={() => setOpenId(r.id)}>{r.title}</button>
        {kind === 'wiki' && <ul>{renderRows(rows.filter((x) => x.parent_id === r.id), r.id, depth + 1)}</ul>}
      </li>
    ));
  const noun = kind === 'wiki' ? 'page' : kind === 'whiteboard' ? 'whiteboard' : kind === 'table' ? 'table' : kind === 'tasklist' ? 'task list' : kind === 'poll' ? 'poll' : kind === 'form' ? 'form' : kind === 'linklist' ? 'link list' : kind === 'meeting' ? 'meeting' : kind === 'file' ? 'file' : 'document';

  return (
    <div className="docs">
      <nav className={`docs-list${dragging ? ' is-dropping' : ''}`} aria-label={kind === 'wiki' ? 'Wiki pages' : kind === 'whiteboard' ? 'Whiteboards' : kind === 'table' ? 'Tables' : kind === 'tasklist' ? 'Task lists' : kind === 'poll' ? 'Polls' : kind === 'form' ? 'Forms' : kind === 'linklist' ? 'Link lists' : kind === 'meeting' ? 'Meetings' : kind === 'file' ? 'Files' : 'Documents'}
        onDragOver={kind === 'file' ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
        onDragLeave={kind === 'file' ? () => setDragging(false) : undefined}
        onDrop={kind === 'file' ? (e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); } : undefined}>
        <div className="docs-new">
          <label className="visually-hidden" htmlFor={`new-${kind}`}>Space for the new {noun}</label>
          <select id={`new-${kind}`} value={newSpace} onChange={(e) => setNewSpace(e.target.value)} disabled={!editable.length}>
            {editable.map((s) => <option key={s.id} value={s.id}>{spaceLabel(s)}</option>)}
          </select>
          {kind === 'file' ? (
            <label className={`btn btn--primary btn--sm file-pick${!newSpace || uploading ? ' is-disabled' : ''}`}>
              Upload files
              <input className="visually-hidden" type="file" multiple disabled={!newSpace || !!uploading} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            </label>
          ) : <button className="btn btn--primary btn--sm" onClick={create} disabled={!newSpace}>New {noun}</button>}
        </div>
        {kind === 'file' && <p className="docs-hint">{uploading || 'Or drop files here. PDFs, Word documents and text files become searchable, and Weft can answer from them.'}</p>}
        {error && <p className="send-error" role="alert">{error}</p>}
        {!items ? <div className="skeleton" aria-label="Loading"><span /><span /><span /></div>
          : !groups.length ? <p className="convo-empty">No {noun}s yet. {kind === 'file' ? 'Upload the first one above.' : 'Make the first one above.'}</p>
          : groups.map(({ s, rows }) => (
            <div key={s.id} className="docs-group">
              <p className="tree-group">{spaceLabel(s)}</p>
              <ul>{renderRows(rows)}</ul>
            </div>
          ))}
      </nav>

      <section className="docs-main">
        {current ? (
          <>
            <header className="docs-head">
              <label className="visually-hidden" htmlFor={`title-${kind}`}>Title</label>
              <input id={`title-${kind}`} className="docs-title" value={title} readOnly={!canEditIn(current.space_id) || current.managed}
                onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
              <p className="docs-meta"><span>{spaceLabel(currentSpace || {})}</span>{status && <span className="docs-status">{status}</span>}</p>
              <div className="docs-share">
                <label className="visually-hidden" htmlFor={`share-${kind}`}>Share to channel</label>
                <select id={`share-${kind}`} value={shareTo} onChange={(e) => setShareTo(e.target.value)}>
                  <option value="">Share to a channel…</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
                <button className="btn btn--sm" onClick={share} disabled={!shareTo}>Share</button>
                {onSwitch && <button className="btn btn--sm" type="button" onClick={() => onSwitch(current.id)}>{view === 'board' ? 'See as a list' : 'See as a board'}</button>}
                {canEditIn(current.space_id) && !current.managed && (<>
                  <label className="visually-hidden" htmlFor={`move-${kind}`}>Move to space</label>
                  <select id={`move-${kind}`} value="" onChange={(e) => { if (e.target.value) moveTo(e.target.value); }}>
                    <option value="">Move to…</option>
                    {editable.filter((s) => s.id !== current.space_id).map((s) => <option key={s.id} value={s.id}>{spaceLabel(s)}</option>)}
                  </select>
                  <button className="btn btn--sm" onClick={remove}>Delete</button>
                </>)}
              </div>
              {note && <p className="slot-status" role="status">{note}</p>}
              {current.managed && <p className="docs-managed">This page is kept in the Weft repo and updates when it is published, so it cannot be edited here. You can add your own pages under it.</p>}
            </header>
            {kind === 'file' ? <div className="docs-file"><FileView key={current.id} item={current} /></div>
              : kind === 'form'
              ? <div className="docs-form"><Form key={current.id} item={current} me={me} members={members} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'linklist'
              ? <div className="docs-links"><LinkList key={current.id} item={current} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'meeting'
              ? <div className="docs-meeting"><Meeting key={current.id} item={current} me={me} members={members} editable={canEditIn(current.space_id)} notice={notice} onOpenEvent={onOpenEvent} onOpenItem={onOpenItem} /></div>
              : kind === 'poll'
              ? <div className="docs-poll"><Poll key={current.id} item={current} me={me} members={members} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'tasklist' && view === 'board'
              ? <div className="docs-kanban"><Kanban key={current.id} item={current} me={me} members={members} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'tasklist'
              ? <div className="docs-tasks"><TaskList key={current.id} item={current} me={me} members={members} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'table'
              ? <div className="docs-table"><Table key={current.id} item={current} editable={canEditIn(current.space_id)} notice={notice} /></div>
              : kind === 'whiteboard'
              ? <div className="docs-board"><Board key={current.id} item={current} onStatus={setStatus} /></div>
              : <div className="docs-editor"><Editor key={`${current.id}-${fresh}`} item={current} me={me} onStatus={setStatus} /></div>}
          </>
        ) : missing ? (
          <div className="empty"><h2>You don't have access to this {noun}</h2><p>It belongs to a space you're not in, or it was deleted. Ask someone in that space to add you.</p></div>
        ) : (
          <div className="empty"><h2>{kind === 'wiki' ? 'Pick a page' : kind === 'whiteboard' ? 'Pick a whiteboard' : kind === 'table' ? 'Pick a table' : kind === 'tasklist' ? (view === 'board' ? 'Pick a task list to see it as a board' : 'Pick a task list') : kind === 'poll' ? 'Pick a poll' : kind === 'form' ? 'Pick a form' : kind === 'linklist' ? 'Pick a link list' : kind === 'meeting' ? 'Pick a meeting' : kind === 'file' ? 'Pick a file' : 'Pick a document'}</h2><p>Everything here is saved in Weft, and the assistant can answer from it for anyone who can open it.</p></div>
        )}
      </section>
    </div>
  );
}
