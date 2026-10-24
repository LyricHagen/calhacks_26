// On-screen debug log. Opens with ?debug=1 or the backtick key, renders nothing
// otherwise. Mounted in its own root so it keeps working if the app crashes.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { NAMESPACES, clearLines, copyText, diagnostics, getLines, log, onLog, type Namespace } from './debug';

const HEIGHT_KEY = 'debug-panel-height';

// Namespace colors for the panel's dark background (the console uses NS_COLOR).
const COLOR: Record<Namespace, string> = {
  serial: '#6fb6e8', parse: '#d6c26a', judge: '#f09a62', calib: '#a6d36a', session: '#b9a0ee',
  ui: '#6fd0d0', 'ui/session': '#8fc8e8', '3d': '#e89ac8', route: '#b0b0b0', error: '#ff8a80',
};

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    if (v >= 120) return v;
  } catch { /* storage blocked: use the default */ }
  return 280;
}

function saveHeight(h: number) {
  try { localStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* storage blocked */ }
}

// The panel lives outside the router, so it moves the app with a history entry
// and a popstate the router hears. A full page load would drop the session.
function openDiag(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  log.ui.info('Self-test opened from the debug panel', { from: location.pathname });
  history.pushState(null, '', e.currentTarget.href);
  dispatchEvent(new PopStateEvent('popstate'));
}

const CSS = `
.dbg { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; flex-direction: column;
  background: #14130f; color: #e6dfcf; border-top: 2px solid #c4a1f2; font: 14px/1.45 'Courier Prime', 'Courier New', ui-monospace, monospace; }
.dbg-grip { height: 8px; cursor: ns-resize; background: #2a2720; flex: none; touch-action: none; }
.dbg-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #3a362c; flex: none; }
.dbg-title { font-weight: bold; margin-right: 6px; }
.dbg-chip { font: inherit; padding: 1px 7px; border: 1px solid currentColor; background: transparent; cursor: pointer; border-radius: 0; }
.dbg-chip[aria-pressed='false'] { opacity: 0.35; text-decoration: line-through; }
.dbg-btn { font: inherit; padding: 2px 8px; text-decoration: none; background: #2a2720; color: #e6dfcf; border: 1px solid #6a6252; cursor: pointer; border-radius: 0; }
.dbg-copy { font: inherit; font-weight: bold; font-size: 14px; padding: 6px 14px; background: #c4a1f2; color: #14130f; border: 0; cursor: pointer; border-radius: 0; }
.dbg-note { color: #b9ab90; }
.dbg-spacer { flex: 1; }
.dbg-log { flex: 1; overflow: auto; padding: 4px 10px 10px; white-space: pre-wrap; word-break: break-word; }
.dbg-line { padding: 1px 0; }
.dbg-warn { background: #3a2c14; }
.dbg-error { background: #4a1a1a; font-weight: bold; }
.dbg-manual { width: 100%; height: 120px; font: inherit; background: #000; color: #e6dfcf; border: 1px solid #6a6252; }
`;

export function DebugPanel() {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('debug') === '1');
  const [height, setHeight] = useState(readHeight);
  const [hidden, setHidden] = useState<Set<Namespace>>(() => new Set());
  const [copyNote, setCopyNote] = useState('');
  const [manual, setManual] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (open) log.ui.info('Debug panel opened', { debug_param: new URLSearchParams(location.search).get('debug') ?? 'none', lines_in_buffer: getLines().length, buffer_size: 500 });
  }, [open]);

  // Backtick toggles the panel anywhere, except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '`' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      setOpen((o) => {
        if (o) log.ui.info('Debug panel closed with the backtick key');
        return !o;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Redraw at most every 100 ms while open.
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onLog(() => { timer ??= setTimeout(() => { timer = null; bump(); }, 100); });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [open]);

  // Follow the newest line unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  if (!open) return null;

  const lines = getLines().filter((l) => !hidden.has(l.ns));
  const counts = Object.fromEntries(NAMESPACES.map((ns) => [ns, 0])) as Record<Namespace, number>;
  for (const l of getLines()) counts[l.ns]++;

  const toggle = (ns: Namespace) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  });

  const onGrip = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.min(Math.round(innerHeight * 0.9), Math.max(120, startH + (startY - ev.clientY)));
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveHeight(h);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const copy = async () => {
    const text = diagnostics();
    if (await copyText(text, 'Diagnostics')) {
      setManual(null);
      setCopyNote(`Copied ${text.split('\n').length} lines (${text.length} characters).`);
    } else {
      setManual(text);
      setCopyNote('The browser blocked clipboard access. Select the text below and copy it by hand.');
    }
  };

  return (
    <div className="dbg" style={{ height }} role="log" aria-label="Debug log">
      <style>{CSS}</style>
      <div className="dbg-grip" onPointerDown={onGrip} title="Drag to resize" />
      <div className="dbg-bar">
        <span className="dbg-title">Debug log</span>
        {NAMESPACES.map((ns) => (
          <button key={ns} type="button" className="dbg-chip" style={{ color: COLOR[ns] }}
            aria-pressed={!hidden.has(ns)} onClick={() => toggle(ns)}>{ns} {counts[ns]}</button>
        ))}
        <span className="dbg-spacer" />
        <span className="dbg-note">{copyNote}</span>
        <a className="dbg-btn" href={`/diag${location.search}`} onClick={openDiag}>Self-test</a>
        <button type="button" className="dbg-btn" onClick={() => { clearLines(); log.ui.info('Debug log cleared by the user'); }}>Clear</button>
        <button type="button" className="dbg-btn" onClick={() => { log.ui.info('Debug panel closed with the Close button'); setOpen(false); }}>Close</button>
        <button type="button" className="dbg-copy" onClick={copy}>Copy diagnostics</button>
      </div>
      {manual != null && <textarea className="dbg-manual" readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
      <div className="dbg-log" ref={logRef} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}>
        {lines.map((l) => (
          <div key={l.seq} className={`dbg-line${l.level === 'warn' ? ' dbg-warn' : l.level === 'error' ? ' dbg-error' : ''}`}
            style={l.level === 'error' ? { color: COLOR.error } : undefined}>
            <span style={{ color: COLOR[l.ns] }}>{l.text.slice(0, l.text.indexOf(']') + 1)}</span>
            {l.text.slice(l.text.indexOf(']') + 1)}
          </div>
        ))}
      </div>
    </div>
  );
}
