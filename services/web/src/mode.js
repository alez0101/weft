// Light / dark / system. "system" removes data-mode so the prefers-color-scheme block decides.
import { useEffect, useState } from 'react';

const KEY = 'weft-mode';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');
export const storedMode = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };

export function applyMode(mode) {
  try { if (mode === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch { /* private mode */ }
  if (mode === 'system') delete document.documentElement.dataset.mode;
  else document.documentElement.dataset.mode = mode;
  window.dispatchEvent(new Event('weft-mode'));
}

// The mode actually in effect ('light' or 'dark'), following both the switch and the device.
export function useEffectiveMode() {
  const read = () => { const m = storedMode(); return m === 'system' ? (media().matches ? 'dark' : 'light') : m; };
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const update = () => setMode(read());
    const mq = media();
    mq.addEventListener('change', update); window.addEventListener('weft-mode', update);
    return () => { mq.removeEventListener('change', update); window.removeEventListener('weft-mode', update); };
  }, []);
  return mode;
}
