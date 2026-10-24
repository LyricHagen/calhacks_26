import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { THRESHOLDS } from '../../shared/mockStream.js';
import { Empty, ErrorBanner, Skel } from '../components/Common';
import { Torso } from '../components/Torso';
import { COUNTDOWN_MS, L, advanced, useWatchdog, variance } from '../advance';
import { SPREAD_LIMIT } from '../judge';
import { REST_FRAMES, REST_MOVE } from '../sources/trainer';
import { useAutoStart, useSnapshot, useStore } from '../stream';
import { QLink, f2, isRef, useCarry } from '../util';

// Stillness: fist variance over the last 3 s of rest, against the move the trainer allows.
const STILL_VAR = REST_MOVE ** 2;

type Stage = 'connecting' | 'rest' | 'reference' | 'done';

const HEAD: Record<Stage, string> = {
  connecting: 'Connecting',
  rest: 'Rest the fist',
  reference: 'Instructor thrusts',
  done: 'Reference set',
};

export function CalibratePage() {
  useAutoStart();
  const store = useStore();
  const snap = useSnapshot();
  const navigate = useNavigate();
  const carry = useCarry();
  const frame = snap.frame;
  const events = snap.events;
  const refs = events.filter(isRef);
  const closedRefs = refs.filter((r) => !r.open);
  const refsDone = closedRefs.length >= 3;
  const stage: Stage = !frame ? 'connecting' : frame.phase === 'rest' ? 'rest' : refsDone ? 'done' : 'reference';
  const live = snap.status === 'live';

  const restWindow = () => {
    const rest = store.frames.filter((f) => f.phase === 'rest').slice(-REST_FRAMES);
    return {
      window_frames: rest.length,
      window_needed: REST_FRAMES,
      window_s: rest.length ? `${rest[0].t.toFixed(1)}-${rest[rest.length - 1].t.toFixed(1)}` : 'none',
      fist_variance: variance(rest.map((f) => f.fist)),
      threshold_variance: STILL_VAR,
    };
  };

  // Countdown to /session once the third reference lands.
  const [deadline, setDeadline] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [now, setNow] = useState(Date.now());
  const prevStage = useRef<Stage | null>(null);
  const seenRefs = useRef<Set<string> | null>(null);

  useEffect(() => {
    const prev = prevStage.current;
    prevStage.current = stage;
    if (prev === stage) return;
    if (prev === 'rest' && stage !== 'rest') {
      const w = restWindow();
      const still = w.fist_variance <= STILL_VAR;
      advanced('/calibrate', 'stillness detected; rest step done, instructor thrusts next', { ...w, still, t: frame?.t });
      if (!still) L.warn('Trainer ended the rest, but the fist variance seen here is above the stillness threshold', w);
    }
    if (stage === 'done' && live && !cancelled) {
      const firstTime = prev === 'reference' || (prev === null && !events.some((e) => e.type !== 'reference'));
      if (firstTime) {
        const peaks = closedRefs.map((r) => r.peak);
        const spread = (Math.max(...peaks) - Math.min(...peaks)) / (peaks.reduce((a, b) => a + b, 0) / peaks.length);
        advanced('/calibrate', `third reference landed; /session in ${COUNTDOWN_MS / 1000} s`, {
          peaks, peak_variance: variance(peaks), spread, spread_limit: SPREAD_LIMIT, countdown_ms: COUNTDOWN_MS,
        });
        setDeadline(Date.now() + COUNTDOWN_MS);
      }
    }
  });

  // One line per reference thrust as it closes.
  useEffect(() => {
    if (!seenRefs.current) { seenRefs.current = new Set(closedRefs.map((r) => r.id)); return; }
    for (const r of closedRefs) {
      if (seenRefs.current.has(r.id)) continue;
      seenRefs.current.add(r.id);
      const peaks = closedRefs.map((x) => x.peak);
      L.info(`Reference thrust R${r.n} detected (${closedRefs.length} of 3)`, {
        window_s: `${r.tStart.toFixed(1)}-${r.tEnd != null ? r.tEnd.toFixed(1) : 'open'}`,
        peak: r.peak, start_threshold: THRESHOLDS.thrustStart, end_threshold: THRESHOLDS.thrustEnd,
        peak_variance: variance(peaks), spread_limit: SPREAD_LIMIT, released: r.released,
      });
    }
  }, [closedRefs]);

  useEffect(() => {
    if (deadline == null || cancelled) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) {
        clearInterval(id);
        advanced('/calibrate', 'countdown finished; going to /session', { countdown_ms: COUNTDOWN_MS, refs: closedRefs.length });
        navigate({ pathname: '/session', search: carry });
      }
    }, 100);
    return () => clearInterval(id);
  }, [deadline, cancelled, navigate, carry]);

  const cancel = () => {
    setCancelled(true);
    L.info('Auto-advance to /session cancelled by the user', { remaining_ms: deadline != null ? Math.max(0, deadline - Date.now()) : null });
  };

  const counting = deadline != null && !cancelled;
  const flowing = live && snap.playing;
  useWatchdog(flowing && stage === 'rest', 'rest', '/calibrate', 'stillness ends the rest step', () => ({
    ...restWindow(), fist_now: frame?.fist, phase: frame?.phase,
  }));
  useWatchdog(flowing && stage === 'reference', `ref-${closedRefs.length}`, '/calibrate', `reference thrust ${closedRefs.length + 1} of 3 lands`, () => ({
    refs_closed: closedRefs.length, ref_open: refs.some((r) => r.open), fist_now: frame?.fist,
    start_threshold: THRESHOLDS.thrustStart, end_threshold: THRESHOLDS.thrustEnd, phase: frame?.phase,
  }));
  useWatchdog(counting, 'countdown', '/calibrate', 'countdown reaches 0 and opens /session', () => ({
    remaining_ms: deadline != null ? deadline - Date.now() : null, cancelled,
  }));
  useWatchdog(snap.status === 'loading' || (live && !frame), 'connect', '/calibrate', 'first frame arrives from the trainer', () => ({
    status: snap.status, playing: snap.playing, link: snap.link?.state ?? 'none',
  }));

  const restDone = stage === 'reference' || stage === 'done';
  const left = deadline != null ? Math.max(1, Math.ceil((deadline - now) / 1000)) : 0;
  const zones = useMemo(() => frame?.zones, [frame]);

  if (snap.status === 'empty') {
    return <main className="page"><Empty>No trainer data. <QLink to="/">Connect</QLink>.</Empty></main>;
  }

  return (
    <main className="page">
      <ErrorBanner snap={snap} />
      <div className="stage">
        <section className="stage-torso">
          {stage === 'connecting' ? <Skel h={360} /> : (
            <Torso zones={zones} phase={frame?.phase} events={events} live={flowing} />
          )}
        </section>
        <section className="stage-side">
          <h1 className="step-now">{counting ? `Session in ${left}` : HEAD[stage]}</h1>
          <div className="cal-steps">
            <span className={`cal-box ${restDone ? 'is-done' : stage === 'rest' ? 'is-now' : ''}`}>Rest</span>
            {[1, 2, 3].map((i) => {
              const r = closedRefs.find((x) => x.index === i);
              const active = stage === 'reference' && i === closedRefs.length + 1;
              return <span key={i} className={`cal-box ${r ? 'is-done' : active ? 'is-now' : ''}`}>{r ? f2(r.peak) : i}</span>;
            })}
          </div>
          {stage === 'done' && (
            <div className="actions">
              {counting
                ? <button type="button" className="btn btn-quiet" onClick={cancel}>Cancel</button>
                : <QLink to="/session" className="btn btn-lg">Start session</QLink>}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
