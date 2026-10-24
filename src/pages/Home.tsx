import { useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ErrorBanner } from '../components/Common';
import { advanced, useWatchdog } from '../advance';
import { hasWebGL, log } from '../debug';
import { lastSession, onLastSession, parseSessionFile } from '../sessionFile';
import { useConnection, useSnapshot } from '../stream';
import { QLink } from '../util';

/** ?speed= for a loaded session: 1 (real time) to 20. */
function replaySpeed(search: string): number {
  const v = Number(new URLSearchParams(search).get('speed'));
  return Number.isFinite(v) && v >= 1 ? Math.min(20, v) : 1;
}

/** Connect trainer, or the demo when this browser cannot open serial ports. Load session either way. */
function StartActions() {
  const conn = useConnection();
  const navigate = useNavigate();
  const { search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useWatchdog(busy, 'connect', '/', 'trainer port opens, then go to /calibrate', () => ({ busy, supported: conn.supported }));

  // A trainer or a saved session is live data, so ?state= is dropped; ?theme= carries over.
  const go = (keepState: boolean) => {
    const q = new URLSearchParams(search);
    const out = new URLSearchParams();
    for (const k of keepState ? ['state', 'theme'] : ['theme']) { const v = q.get(k); if (v) out.set(k, v); }
    navigate({ pathname: '/calibrate', search: out.toString() ? `?${out}` : '' });
  };

  const onConnect = () => {
    setProblem(null);
    setBusy(true);
    // conn.connect() opens the port chooser before its first await, so it still counts as this click.
    conn.connect().then(
      (ok) => {
        setBusy(false);
        if (!ok) return;
        advanced('/', 'trainer port opened; going to /calibrate', { to: '/calibrate' });
        go(false);
      },
      (e: Error) => { setBusy(false); setProblem(e.message); },
    );
  };

  const onDemo = () => { conn.runDemo(); go(true); };

  const onFile = async (ev: ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    ev.target.value = '';  // the same file can be picked again
    if (!f) return;
    setProblem(null);
    try {
      const file = parseSessionFile(await f.text(), f.name);
      const speed = replaySpeed(search);
      log.session.info(`Saved session loaded from ${f.name}; replaying it through the judge`, {
        bytes: f.size, readings: file.readings?.length ?? 0, frames: file.frames.length, saved_events: file.events.length,
        saved_at: file.savedAt || 'unknown', saved_from: file.source.name, speed,
      });
      conn.loadReplay(file, f.name, speed);
      advanced('/', 'saved session loaded; going to /calibrate', { to: '/calibrate', file: f.name });
      go(false);
    } catch (e) {
      log.session.warn('Could not load the chosen file as a saved session', { file: f.name, bytes: f.size, reason: (e as Error).message });
      setProblem((e as Error).message);
    }
  };

  const load = (
    <>
      <button type="button" className="btn-link" onClick={() => fileRef.current?.click()} disabled={busy}>Load session</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} />
    </>
  );

  return (
    <>
      {conn.supported ? (
        <div className="actions">
          <button type="button" className="btn btn-lg" onClick={onConnect} disabled={busy}>{busy ? 'Connecting' : 'Connect trainer'}</button>
          <button type="button" className="btn-link" onClick={onDemo} disabled={busy}>Run demo instead</button>
          {load}
        </div>
      ) : (
        <>
          <div className="actions">
            <button type="button" className="btn btn-lg" onClick={onDemo}>Run demo</button>
            {load}
          </div>
          <p className="note">Connecting a trainer needs Chrome or Edge on a desktop computer{window.isSecureContext ? '' : ', opened over https or from localhost'}.</p>
        </>
      )}
      {!hasWebGL() && <p className="note">This browser has no WebGL, so the torso is drawn flat.</p>}
      {problem && <p className="note fault" role="alert">{problem}</p>}
    </>
  );
}

function LastSession() {
  const last = useSyncExternalStore(onLastSession, lastSession);
  if (!last) return null;
  const at = last.savedAt ? new Date(last.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <p className="note">
      Last session{at && <>, ended <span className="mono">{at}</span></>}: <QLink to="/session/summary">summary</QLink>.
    </p>
  );
}

export function HomePage() {
  const snap = useSnapshot();
  return (
    <main className="page">
      <ErrorBanner snap={snap} />
      <section className="hero">
        <h1 className="hero-title">Heimlich trainer for practicing alone.</h1>
        <p className="lede">Measures every back blow and abdominal thrust against your instructor&rsquo;s.</p>
        <StartActions />
        <LastSession />
      </section>
    </main>
  );
}
