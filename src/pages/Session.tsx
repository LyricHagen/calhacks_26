import { useEffect, useMemo, useRef } from 'react';
import { LABELS, checkSequence } from '../../shared/mockStream.js';
import type { SessionEvent } from '../../shared/mockStream.js';
import { Empty, ErrorBanner, Skel } from '../components/Common';
import { EventTable, LatestEntry, Trace, Tracker } from '../components/Parts';
import { Torso, useTorso3D } from '../components/Torso';
import { advanced, useWatchdog } from '../advance';
import { useAutoStart, useSnapshot, useStore } from '../stream';
import { PHASE, QLink, faultZones, isBlow, timeOf } from '../util';

/** The latest judgement as one short phrase, and whether it is a fault. */
function verdict(e: SessionEvent | undefined, breaks: Set<string>): [string, boolean] {
  if (!e) return ['--', false];
  const f = e.faults[0];
  if (f) return [LABELS.fault[f], true];
  if (breaks.has(e.id)) return [LABELS.fault['out-of-order'], true];
  if (isBlow(e)) return [LABELS.zone.target, false];
  return [LABELS.strength.similar, false];
}

export function SessionPage() {
  useAutoStart();
  const store = useStore();
  const snap = useSnapshot();
  const loading = snap.status === 'loading' || snap.status === 'idle';
  const frame = snap.frame;
  const events = snap.events;
  const steps = useMemo(() => events.filter((e) => e.type !== 'reference').sort((a, b) => timeOf(a) - timeOf(b)), [events]);
  const latest = steps[steps.length - 1];
  const judged = useMemo(() => steps.filter((e) => !e.open).pop(), [steps]);
  const breaks = useMemo(() => new Set(checkSequence(events).breaks.map((b) => b.eventId)), [events]);
  const faults = useMemo(() => faultZones(events), [events]);
  const in3d = useTorso3D();

  const phase = frame?.phase;
  const cycle = frame?.cycle ?? 0;
  const kind = phase === 'backblows' ? 'backblow' : phase === 'thrusts' ? 'thrust' : null;
  const inPhase = kind ? steps.filter((e) => e.type === kind && e.cycle === cycle).length : 0;
  const count = kind ? `${inPhase}/5`
    : phase === 'calibrating' ? `${events.filter((e) => e.type === 'reference').length}/3` : '--';
  const [said, fault] = verdict(judged, breaks);

  // Phase advances are driven by the trainer; log each one with the count that triggered it.
  const prev = useRef<{ phase: string; cycle: number; n: number } | null>(null);
  useEffect(() => {
    if (!phase) return;
    const p = prev.current;
    prev.current = { phase, cycle, n: inPhase };
    if (!p || p.phase === phase) return;
    advanced('/session', `phase ${p.phase} -> ${phase}`, { from: p.phase, to: phase, cycle_before: p.cycle, cycle_now: cycle, counted_before: p.n, needed: 5, t: frame?.t });
  }, [phase, cycle, inPhase, frame?.t]);

  useWatchdog(snap.status === 'live' && kind != null && inPhase >= 5, `${phase}-${cycle}`, '/session',
    `5 ${kind === 'thrust' ? 'thrusts' : 'back blows'} counted, so the phase should move on`, () => ({
      phase, cycle, counted: inPhase, needed: 5, t: frame?.t, open: latest?.open ?? false,
    }));

  if (snap.status === 'empty') {
    return <main className="page"><Empty>No trainer data. <QLink to="/">Connect</QLink>.</Empty></main>;
  }

  return (
    <main className="page">
      <ErrorBanner snap={snap} />
      <div className="stage">
        <section className="stage-torso">
          {loading ? <Skel h={360} /> : (
            <Torso zones={frame?.zones} faults={faults} phase={phase} events={events} live={snap.status === 'live' && snap.playing} />
          )}
        </section>
        <section className="stage-side">
          <div className="big-phase">{loading ? <Skel w="70%" h={48} /> : phase ? PHASE[phase] : '--'}</div>
          <div className="big-count mono">{loading ? <Skel w="40%" h={80} /> : count}</div>
          <div className={`big-say${fault ? ' fault' : ''}`} aria-live="polite">{loading ? <Skel w="80%" h={36} /> : said}</div>
          {!loading && <Tracker events={events} />}
          {snap.status === 'summary' && (
            <div className="actions"><QLink to="/session/summary" className="btn btn-lg">Summary</QLink></div>
          )}
          {snap.status === 'error' && steps.length > 0 && (
            <div className="actions"><QLink to="/session/summary" className="btn btn-quiet">Summary so far</QLink></div>
          )}
        </section>
      </div>

      {store.frames.length > 1 && (
        <section className="section">
          <Trace frames={store.frames} t={snap.t} />
        </section>
      )}

      <details className="details section">
        <summary>Details</summary>
        <LatestEntry e={latest} frame={frame} placement={!in3d} />
        {events.length > 0 && <EventTable events={events} order="desc" />}
      </details>
    </main>
  );
}
