import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { Snapshot } from '../../shared/mockStream.js';
import { useConnection, useSnapshot } from '../stream';
import { QLink, f1, useCarry, useTheme } from '../util';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Connect', end: true },
  { to: '/calibrate', label: 'Calibrate' },
  { to: '/session', label: 'Session', end: true },
  { to: '/session/summary', label: 'Summary' },
  { to: '/method', label: 'Method' },
  { to: '/privacy', label: 'Privacy' },
];

function ThemeSwitch() {
  const { pathname, search, hash } = useLocation();
  const next = useTheme() === 'dark' ? 'light' : 'dark';
  const q = new URLSearchParams(search);
  q.set('theme', next);
  return <Link className="theme-switch label" to={{ pathname, search: `?${q}`, hash }}>{next} mode</Link>;
}

const LINK_WORD: Record<string, string> = {
  connecting: 'connecting', silent: 'no signal', garbled: 'bad data', unplugged: 'unplugged', closed: 'closed',
};

/** Live link state: port, measured rate, reconnect. "Demo" or "Replay" otherwise. */
function LinkStatus() {
  const snap = useSnapshot();
  const conn = useConnection();
  const link = snap.link;
  if (!link || !conn.serial) {
    const replay = snap.meta.name.startsWith('Replay');  // the store's actual source, see sources/replay.ts
    return <span className="conn label dim" title={snap.meta.name}>{replay ? 'Replay' : 'Demo'}</span>;
  }
  const on = link.state === 'streaming';
  return (
    <span className="conn">
      <span className={`conn-mark${on ? ' is-on' : ''}`} aria-hidden="true" />
      <span className="label" aria-live="polite">{link.port} {on ? (link.hz != null ? `${link.hz.toFixed(1)} Hz` : 'live') : LINK_WORD[link.state]}</span>
      <button type="button" className="conn-btn label" onClick={conn.reconnect}>Reconnect</button>
    </span>
  );
}

export function Header() {
  const carry = useCarry();
  return (
    <header className="header">
      <div className="header-top">
        <QLink to="/" className="wordmark">unnamed</QLink>
        <span className="label dim">Heimlich trainer</span>
        <LinkStatus />
        <ThemeSwitch />
      </div>
      <nav className="nav" aria-label="Pages">
        {NAV.map((n) => (
          <NavLink key={n.to} to={{ pathname: n.to, search: carry }} end={n.end} className="nav-link">{n.label}</NavLink>
        ))}
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <span>Training aid, not a medical device. Forces are compared to an instructor&rsquo;s reference, never to a target.</span>
      <span><QLink to="/method">Method</QLink> <QLink to="/privacy">Privacy</QLink></span>
    </footer>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children && <div className="lede">{children}</div>}
    </div>
  );
}

// Titles for the trainer's link problems; any other code shows as "Error <code>".
const ERROR_TITLE: Record<string, string> = {
  'lost-signal': 'Lost signal', 'unexpected-data': 'Unexpected data', unplugged: 'Unplugged',
  reconnecting: 'Reconnecting', 'reconnect-failed': 'Reconnect failed',
};
const RECONNECT = new Set(['lost-signal', 'unexpected-data', 'unplugged', 'reconnect-failed']);

export function ErrorBanner({ snap }: { snap: Snapshot }) {
  const conn = useConnection();
  if (snap.status !== 'error' || !snap.error) return null;
  const { code, message } = snap.error;
  return (
    <div className="banner banner-error" role="alert">
      <span className="label">{ERROR_TITLE[code] ?? `Error ${code}`}</span>
      <p>{message}{code === 'unexpected-data' ? '' : <> Data is frozen at <span className="mono">{f1(snap.t)} s</span>, the last frame received.</>}</p>
      {code === 'unexpected-data' && snap.link?.rawLine != null && <pre className="raw-line">{snap.link.rawLine}</pre>}
      {conn.serial && RECONNECT.has(code) && (
        <div className="actions"><button type="button" className="btn" onClick={conn.reconnect}>Reconnect</button></div>
      )}
    </div>
  );
}

export function Skel({ w = '100%', h = 12 }: { w?: string | number; h?: number }) {
  return <span className="skel" style={{ width: w, height: h }} />;
}

export function Lines({ n = 3 }: { n?: number }) {
  return <div aria-busy="true">{Array.from({ length: n }, (_, i) => <Skel key={i} w={i === n - 1 ? '60%' : '100%'} />)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
