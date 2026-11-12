// A whiteboard: Excalidraw, co-edited live through the collab server.
// Binding: a Yjs map "elements" holds one entry per Excalidraw element id. Local changes write every
// element whose version went up; remote changes are merged into the scene keeping, per element, the
// higher version (Excalidraw's own rule). Viewers get view mode; the server ignores their writes anyway.
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { currentToken } from './api.js';
import { useEffectiveMode } from './mode.js';

const byIndex = (a, b) => (String(a.index ?? '') < String(b.index ?? '') ? -1 : String(a.index ?? '') > String(b.index ?? '') ? 1 : 0);

export default function Board({ item, onStatus }) {
  const appearance = useEffectiveMode();
  const [state] = useState(() => {
    const doc = new Y.Doc();
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`;
    return { doc, map: doc.getMap('elements'), provider: new HocuspocusProvider({ url, name: item.id, document: doc, token: () => currentToken() }) };
  });
  const [scope, setScope] = useState(null);
  const [synced, setSynced] = useState(false);
  const api = useRef(null);

  useEffect(() => {
    const { provider, map, doc } = state;
    const onAuth = ({ scope: s }) => { setScope(s); onStatus(s === 'read-write' ? 'Drawing live' : 'View only: you can look but not change it'); };
    const onFail = () => onStatus('You no longer have access to this whiteboard.');
    const onSynced = () => setSynced(true);
    provider.on('authenticated', onAuth); provider.on('authenticationFailed', onFail); provider.on('synced', onSynced);
    if (provider.isSynced) setSynced(true);
    // Remote changes: merge into the scene, keeping the higher version of each element.
    const onRemote = (_e, tr) => {
      if (tr.origin === 'local' || !api.current) return;
      const scene = new Map(api.current.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
      for (const [id, el] of map.entries()) { const cur = scene.get(id); if (!cur || cur.version < el.version) scene.set(id, el); }
      api.current.updateScene({ elements: [...scene.values()].sort(byIndex) });
    };
    map.observe(onRemote);
    return () => { map.unobserve(onRemote); provider.off('authenticated', onAuth); provider.off('authenticationFailed', onFail); provider.off('synced', onSynced); provider.destroy(); doc.destroy(); };
  }, [state, onStatus]);

  // Local changes: write elements whose version went up.
  const onChange = (elements) => {
    if (scope !== 'read-write') return;
    const changed = elements.filter((el) => { const cur = state.map.get(el.id); return !cur || cur.version < el.version; });
    if (changed.length) state.doc.transact(() => { for (const el of changed) state.map.set(el.id, { ...el }); }, 'local');
  };

  if (!synced) return <div className="skeleton" aria-label="Opening the whiteboard"><span /><span /><span /></div>;
  return (
    <div className="board">
      <Excalidraw
        excalidrawAPI={(a) => { api.current = a; }}
        initialData={{ elements: [...state.map.values()].sort(byIndex), appState: { viewBackgroundColor: 'transparent' } }}
        onChange={onChange}
        viewModeEnabled={scope !== 'read-write'}
        theme={appearance}
        isCollaborating
        UIOptions={{ tools: { image: false }, canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
      />
    </div>
  );
}
