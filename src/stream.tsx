// One session per ?state=, shared by every route. The store holds one data
// source, pipes its raw frames through the judge, and buffers frames for the trace.
// The source is the recording (demo) until a trainer is connected over USB or a
// saved session is loaded. ?state=demo forces the recording whatever is connected.
// Every frame the judge reads is kept, so the run can be saved and replayed, and
// a run that ends (or is unplugged) is remembered in sessionFile.ts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getFrame, log, provideDiagnostics, setFrame } from './debug';
import { STATES, SPREAD_LIMIT, createJudge, summarize } from './judge';
import type { Frame, Judge, RawFrame, ReviewState, SessionEvent, Status, Summary } from './judge';
import { buildSessionFile, remember, type SessionFile } from './sessionFile';
import { createMockSource } from './sources/mock';
import { createReplaySource } from './sources/replay';
import { createSerialSource, requestTrainerPort, serialSupported, type SerialSource } from './sources/serial';
import type { DataSource, LinkInfo, SourceMeta, SourceStatus } from './sources/types';

export interface Snapshot {
  status: Status;
  playing: boolean;
  frame: Frame | null;
  events: SessionEvent[];
  t: number;
  duration: number;
  progress: number;
  error: { code: string; message: string } | null;
  meta: SourceMeta;
  /** The USB link, or null for the recording. */
  link: LinkInfo | null;
}

export interface Session {
  subscribe(fn: (snapshot: Snapshot) => void): () => void;
  start(): void;
  stop(): void;
  reset(): void;
  getSnapshot(): Snapshot;
  getSummary(): Summary;
}

interface Store {
  state: ReviewState;
  session: Session;
  frames: Frame[];
  /** Every frame the judge has read in this run, as the source delivered it. */
  raw: RawFrame[];
  /** The run so far as a saved-session file. */
  exportSession(): SessionFile;
  subscribe(fn: () => void): () => void;
  get(): Snapshot;
  dispose(): void;
}

const S = log.session;

export function makeStore(state: ReviewState, makeSource: (state: ReviewState) => DataSource = (s) => createMockSource({ state: s })): Store {
  const frames: Frame[] = [];
  const raw: RawFrame[] = [];
  let remembered = 0;      // raw.length when this run was last remembered
  const listeners = new Set<() => void>();
  const subscribers = new Set<(s: Snapshot) => void>();
  let source: DataSource;
  let judge: Judge;
  let status: SourceStatus;
  let lastFrame: Frame | null = null;
  let snap: Snapshot;
  let unwire: () => void = () => {};
  let priming = false;     // collect a burst of frames into one snapshot
  let dirty = false;       // frames arrived that no snapshot shows yet
  let disposed = false;

  function snapshot(): Snapshot {
    const hidden = status.state === 'empty' || status.state === 'loading';
    const frame = lastFrame && !hidden ? lastFrame : null;
    return {
      status: status.state,
      playing: status.playing,
      frame,
      events: hidden ? [] : judge.events(),
      t: frame ? frame.t : 0,
      duration: status.duration,
      progress: status.progress,
      error: status.error,
      meta: status.meta,
      link: status.link ?? null,
    };
  }

  function emit() {
    dirty = false;
    const s = snapshot();
    const f = s.frame;
    const last = frames[frames.length - 1];
    if (!f) frames.length = 0;
    else if (last && f.t < last.t) { frames.length = 0; frames.push(f); }
    else if (!last || f.t > last.t) frames.push(f);
    snap = s;
    subscribers.forEach((fn) => fn(s));
    listeners.forEach((l) => l());
  }

  // A status report publishes a snapshot at once (the mock sends one per tick).
  // Frames from a source that does not report status are published at the end of the turn.
  function frameArrived() {
    if (priming || disposed || dirty) return;
    dirty = true;
    queueMicrotask(() => { if (dirty && !disposed) emit(); });
  }

  function wire() {
    judge = createJudge();
    lastFrame = null;
    raw.length = 0;
    remembered = 0;
    setFrame(null);
    source = makeSource(state);
    S.info(`Session created for ?state=${state}`, { source: source.name, review_state: state });
    priming = true;
    const offFrame = source.onFrame((f) => {
      setFrame(judge.state().frames);
      raw.push(f);
      try {
        lastFrame = judge.push(f).frame;
      } catch (e) {
        log.judge.error('Judge threw while reading a frame; the frame was skipped', e, { t: f.t, fist: f.fist, pads: JSON.stringify(f.pads) });
      }
      frameArrived();
    });
    const offStatus = source.onStatus((s) => {
      const prev = status;
      status = s;
      if (!prev || prev.state !== s.state || prev.playing !== s.playing) {
        S.info(`Source status ${prev ? `${prev.state} -> ${s.state}` : `is ${s.state}`}`, {
          source: source.name, playing: s.playing, progress_pct: Math.round(s.progress * 100),
          error: s.error ? s.error.code : 'none', frame_count: judge.state().frames,
        });
      }
      if (!priming && !disposed) emit();
      // A finished run, or one cut off by an unplug, is kept beyond this store.
      const ended = s.state === 'summary' || (s.state === 'error' && s.link?.state === 'unplugged');
      if (ended && (!prev || prev.state !== s.state)) keep(s.state === 'summary' ? 'the run finished' : 'the trainer was unplugged');
    });
    unwire = () => { offFrame(); offStatus(); };
    // Review states deliver their frames now, so the first render is already right.
    if (state !== 'live') source.start();
    priming = false;
    emit();
  }

  wire();

  function exportSession(): SessionFile {
    return buildSessionFile({ name: source.name, meta: status.meta }, source.readings?.() ?? null, [...raw], judge.events());
  }

  /** Remembers this run, live review state only, once per new frame count. */
  function keep(why: string) {
    if (state !== 'live' || !raw.length || raw.length === remembered) return;
    remembered = raw.length;
    S.info(`Keeping this run: ${why}`, { frames: raw.length, source: source.name });
    remember(exportSession());
  }

  function diagnosticsInfo() {
    const c = judge.calibration();
    const j = judge.state();
    const sum = getSummary();
    const b = c.baseline;
    return {
      source: source.name,
      connection: `${status.state}${status.playing ? ', frames flowing' : ', no frames flowing'}${status.error ? `, error ${status.error.code}: ${status.error.message}` : ''} (progress ${Math.round(status.progress * 100)}%, ?state=${state})${status.link ? `, port ${status.link.port} ${status.link.state} at ${status.link.hz ?? '--'} Hz` : ''}`,
      calibration: [
        `baseline per pad: ${b ? `fist=${b.fist.toFixed(3)} target=${b.target.toFixed(3)} high=${b.high.toFixed(3)} low=${b.low.toFixed(3)} side=${b.side.toFixed(3)} back=${b.back.toFixed(3)} (mean of ${c.baselineFrames} rest frames)` : 'not set yet (rest phase has not ended)'}`,
        `reference peaks: ${c.refPeaks.length ? c.refPeaks.map((p, i) => `R${i + 1}=${p.toFixed(3)}`).join(' ') : 'none yet'} (expected 3)`,
        `reference mean: ${c.refMean != null ? c.refMean.toFixed(3) : 'none yet'}`,
        `spread: ${c.spread != null ? `${c.spread.toFixed(3)} (limit ${SPREAD_LIMIT}, ${c.spreadOk ? 'within' : 'OUTSIDE'} limit)` : 'none yet'}`,
        `reference time to peak: ${c.refTimeToPeakMs != null ? `${Math.round(c.refTimeToPeakMs)} ms` : 'none yet'}`,
      ],
      session: [
        `phase: ${snap.frame?.phase ?? j.phase ?? 'no frame yet'}`,
        `elapsed: ${snap.t.toFixed(1)} s of ${snap.duration.toFixed(1)} s`,
        `frames judged: ${j.frames}, current frame number #${getFrame() ?? '----'}`,
        `thrust count: ${sum.counts.thrusts}${j.open ? ` (open now: ${j.open})` : ''}`,
        `blow count: ${sum.counts.backBlows}`,
        `reference count: ${sum.counts.references}`,
        `cycle: ${snap.frame?.cycle ?? j.cycle} (completed ${sum.counts.cycles})`,
        `fault count: ${sum.faults.length}${sum.faults.length ? ` (${sum.faults.map((f) => `${f.eventId}:${f.code}`).join(' ')})` : ''}`,
        `5-and-5 sequence: ${sum.sequence.held ? 'held' : `broken at ${sum.sequence.breaks.map((x) => x.eventId).join(', ')}`}, next expected ${sum.sequence.expectedNext}`,
      ],
    };
  }

  function getSummary() {
    if (snap.status === 'empty' || snap.status === 'loading') return summarize([], { status: snap.status, t: 0 });
    return summarize(snap.events, { status: snap.status, t: snap.t });
  }

  const session: Session = {
    subscribe(fn) { subscribers.add(fn); fn(snap); return () => { subscribers.delete(fn); }; },
    start() {
      if (state === 'live' && snap.status === 'summary') {
        // A finished run starts over: fresh judge, empty trace.
        S.info('Start pressed after the run finished; judging again from the first frame', { previous_frames: judge.state().frames });
        judge = createJudge();
        lastFrame = null;
        raw.length = 0;
        remembered = 0;
        setFrame(null);
      }
      source.start();
    },
    stop() { source.stop(); },
    reset() {
      S.info('Session reset; a new source and judge replace the old ones', { source: source.name });
      source.stop();
      unwire();
      wire();
    },
    getSnapshot: () => snap,
    getSummary,
  };

  provideDiagnostics(diagnosticsInfo);

  return {
    state,
    session,
    frames,
    raw,
    exportSession,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => snap,
    dispose() {
      keep('the page switched to another source');
      disposed = true;
      unwire();
      source.stop();
      S.info('Session closed', { review_state: state, frames_judged: judge.state().frames });
    },
  };
}

const Ctx = createContext<Store | null>(null);

/** The trainer connection, for the Connect, Reconnect and demo controls. */
export interface Connection {
  /** This browser has Web Serial. */
  supported: boolean;
  /** The connected trainer, or null while the recording or a replay plays. */
  serial: SerialSource | null;
  /** The saved session being replayed, or null. */
  replay: { name: string } | null;
  /** ?state=demo: the recording plays whatever is connected. */
  demo: boolean;
  /** Call straight from a click: port chooser, open, then the trainer replaces the recording.
   *  Resolves false if the chooser was closed; rejects with a message to show. */
  connect(): Promise<boolean>;
  /** Call straight from a click. Keeps everything recorded so far. */
  reconnect(): void;
  /** Drop the trainer and go back to the recording. */
  runDemo(): void;
  /** Drop the trainer and play a saved session through the judge instead. */
  loadReplay(file: SessionFile, name: string, speed?: number): void;
}

const ConnCtx = createContext<Connection | null>(null);

export function StreamProvider({ children }: { children: ReactNode }) {
  const [search] = useSearchParams();
  const q = search.get('state');
  const demo = q === 'demo';
  const state = q && STATES.includes(q as ReviewState) ? q as ReviewState : 'live';
  const [serial, setSerial] = useState<SerialSource | null>(null);
  const [replay, setReplay] = useState<{ file: SessionFile; name: string; speed: number } | null>(null);
  const serialRef = useRef(serial);
  serialRef.current = serial;
  // The review states and ?state=demo always stage the recording; a trainer or a replay only feeds live.
  const live = state === 'live' && !demo ? serial : null;
  const rep = state === 'live' && !demo && !live ? replay : null;
  const store = useMemo(
    () => makeStore(state, live ? () => live : rep ? () => createReplaySource(rep.file, { speed: rep.speed, name: rep.name }) : undefined),
    [state, live, rep],
  );
  useEffect(() => () => store.dispose(), [store]);

  const connect = useCallback(async () => {
    let port: SerialPort;
    try {
      port = await requestTrainerPort(); // first, while the click still counts
    } catch (e) {
      if ((e as { cancelled?: boolean }).cancelled) return false;
      throw e;
    }
    const prev = serialRef.current;
    if (prev) await prev.close('a new connection was requested');
    const src = createSerialSource(port);
    try {
      await src.open();
    } catch (e) {
      setSerial(null);
      throw e;
    }
    setSerial(src);
    setReplay(null);
    return true;
  }, []);

  const conn = useMemo<Connection>(() => ({
    supported: serialSupported(),
    serial,
    replay: replay && { name: replay.name },
    demo,
    connect,
    reconnect: () => { void serialRef.current?.reconnect(); },
    runDemo: () => {
      if (serialRef.current) log.serial.info('Switching to the recording; the trainer port will close', { port: serialRef.current.portName });
      setSerial(null);
      setReplay(null);
    },
    loadReplay: (file, name, speed = 1) => {
      if (serialRef.current) log.serial.info('Switching to a saved session; the trainer port will close', { port: serialRef.current.portName });
      setSerial(null);
      setReplay({ file, name, speed });
    },
  }), [serial, replay, demo, connect]);

  return <ConnCtx.Provider value={conn}><Ctx.Provider value={store}>{children}</Ctx.Provider></ConnCtx.Provider>;
}

export function useConnection(): Connection {
  const c = useContext(ConnCtx);
  if (!c) throw new Error('StreamProvider missing');
  return c;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StreamProvider missing');
  return s;
}

export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useSummary(snap: Snapshot): Summary {
  return useMemo(
    () => summarize(snap.status === 'loading' || snap.status === 'empty' ? [] : snap.events, { status: snap.status, t: snap.t }),
    [snap],
  );
}

/** Start playback in live state, only from idle, so a finished run is not restarted. */
export function useAutoStart(enabled = true) {
  const store = useStore();
  useEffect(() => {
    if (enabled && store.state === 'live' && store.get().status === 'idle') store.session.start();
  }, [store, enabled]);
}
