import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import type { NineReadings } from '../trainerLab/sensors';
import { estimatePlacement, SPATIAL_SETTINGS, type SpatialSamples } from '../trainerLab/spatialModel';
import {
  ASSESSMENT_SETTINGS, AssessmentContactDetector, assessmentAccuracy, expireAssessmentNotes,
  isAssessmentDone, judgeAssessmentContact, newAssessment, nextAssessmentRegion, noteLabel, windowsFor,
  type AssessmentMode, type AssessmentNote, type AssessmentRegion, type AssessmentState, type ContactRegion,
} from './assessmentEngine';
import './assessment.css';

type ShatterEffect = {
  id: number;
  region: ContactRegion;
  leftPct: number;
  widthPct: number;
  createdAt: number;
};
const isSuccessful = (verdict: string | undefined) =>
  verdict === 'perfect' || verdict === 'good' || verdict === 'okay';
// Bars sit 14% in from the left at the hit line and cross 86% of the lane in travelMs.
const noteLeftPct = (note: AssessmentNote, atElapsed: number) =>
  14 + (note.atMs - atElapsed) * 86 / ASSESSMENT_SETTINGS.travelMs;
const noteWidthPct = (note: AssessmentNote) =>
  Math.max(17, note.targetDurationMs * 86 / ASSESSMENT_SETTINGS.travelMs);

type FrameInput = (readings: NineReadings, receivedAtMs: number) => void;
type Props = {
  inputRef: MutableRefObject<FrameInput>;
  baseline: NineReadings;
  threshold: number;
  spatialSamples: SpatialSamples;
  onRegionChange: (region: AssessmentRegion) => void;
  onActiveChange: (active: boolean) => void;
  enabled: boolean;
  /** Fixed for the component's lifetime; remount with a key to switch charts. */
  mode: AssessmentMode;
  onPlacementScore: (region: AssessmentRegion, score: number) => void;
  /** Collapsed shows only the heading row; the game stays mounted. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function AssessmentGame({ inputRef, baseline, threshold, spatialSamples, onRegionChange, onActiveChange, onPlacementScore, enabled, mode, collapsed, onToggleCollapsed }: Props) {
  const [status, setStatus] = useState<'ready' | 'running' | 'complete'>('ready');
  const [state, setState] = useState<AssessmentState>(() => newAssessment(mode));
  const [elapsed, setElapsed] = useState(0);
  const [heldMs, setHeldMs] = useState<number | null>(null);
  // Game time the current contact began, so its bar can light up on press.
  const [heldOnset, setHeldOnset] = useState<number | null>(null);
  const [shatters, setShatters] = useState<ShatterEffect[]>([]);
  const latencyMs = 35; // Internal serial compensation, not an in-game option.

  const stateRef = useRef(state);
  const startedAtRef = useRef(0);
  const runningRef = useRef(false);
  const detectorRef = useRef(new AssessmentContactDetector());
  const previousRegionRef = useRef<AssessmentRegion>('back');
  const regionCallbackRef = useRef(onRegionChange);
  const activeCallbackRef = useRef(onActiveChange);

  const audioRef = useRef<AudioContext | null>(null);
  const playedRef = useRef<Set<number>>(new Set());


  regionCallbackRef.current = onRegionChange;
  activeCallbackRef.current = onActiveChange;



  const update = useCallback((next: AssessmentState) => {
    if (next === stateRef.current) return;
    const previous = stateRef.current;
    // Freeze successful bars where they were scored. Their fragments animate
    // independently of the scrolling timeline and never move after the hit.
    const newHits = next.notes.filter(note =>
      isSuccessful(note.verdict) && !previous.notes[note.id]?.verdict,
    );
    if (newHits.length) {
      const createdAt = performance.now();
      const currentElapsed = createdAt - startedAtRef.current;
      setShatters(existing => [...existing, ...newHits.map(note => ({
        id: note.id,
        region: note.region,
        leftPct: noteLeftPct(note, currentElapsed),
        widthPct: noteWidthPct(note),
        createdAt,
      }))]);
    }
    stateRef.current = next;
    setState(next);
    const region = nextAssessmentRegion(next);
    if (region !== previousRegionRef.current) {
      previousRegionRef.current = region;
      regionCallbackRef.current(region);
    }
    if (isAssessmentDone(next)) {
      runningRef.current = false;
      activeCallbackRef.current(false);
    }
  }, []);

  function beep(frequency: number, volume = 0.09) {
    const ctx = audioRef.current;
    if (!ctx || ctx.state !== 'running') return;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * .7, ctx.currentTime + .075);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .12);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + .13);
  }

  // The ESP32 calls this same ref as the old game, from the existing Web Serial reader.
  useEffect(() => {
    inputRef.current = (values, atMs) => {
      if (!runningRef.current) return;
      const event = detectorRef.current.process(values, baseline, threshold, atMs);
      const heldStart = detectorRef.current.heldStart;
      setHeldMs(heldStart === null ? null : Math.max(0, atMs - heldStart));
      setHeldOnset(heldStart === null ? null : heldStart - startedAtRef.current - latencyMs);
      if (!event) return;
      const region = event.region;
      const spatial = region === 'front' || region === 'back'
        ? estimatePlacement(region, event.pattern, baseline, spatialSamples)
        : null;
      if (spatial && (region === 'back' || region === 'front')) onPlacementScore(region, Math.round(spatial.score));
      const gameEvent = {
        ...event,
        startedMs: event.startedMs - startedAtRef.current - latencyMs,
        endedMs: event.endedMs - startedAtRef.current - latencyMs,
      };
      const result = judgeAssessmentContact(stateRef.current, gameEvent, spatial, SPATIAL_SETTINGS.acceptanceScore);
      if (result !== stateRef.current) {
        update(result);
        const lastNote = result.notes.find(note => note.verdict && Math.abs(note.timingErrorMs ?? Infinity) <= ASSESSMENT_SETTINGS.hitWindowMs && Math.abs((note.atMs + (note.timingErrorMs ?? 0)) - gameEvent.startedMs) < 1);
        beep(lastNote && ['perfect', 'good', 'okay'].includes(lastNote.verdict ?? '') ? 800 : 230, .12);
      }
    };
    return () => { inputRef.current = () => {}; };
  }, [inputRef, baseline, threshold, spatialSamples, update, onPlacementScore]);

  useEffect(() => {
    if (status !== 'running') return;
    let request = 0;
    const tick = (now: number) => {
      const ms = now - startedAtRef.current;
      setElapsed(ms);
      const updated = expireAssessmentNotes(
        stateRef.current, ms - latencyMs,
        detectorRef.current.heldStart === null ? null : detectorRef.current.heldStart! - startedAtRef.current - latencyMs,
      );
      if (updated !== stateRef.current) update(updated);
      for (const note of stateRef.current.notes) {
        if (ms >= note.atMs && ms < note.atMs + 100 && !playedRef.current.has(note.id)) {
          playedRef.current.add(note.id);
          const accent = mode === 'cpr' ? note.id % 10 === 0 : note.id === 0 || note.id === 5;
          beep(accent ? 660 : 460, .045);
        }
      }
      if (isAssessmentDone(stateRef.current)) {
        runningRef.current = false;
        setStatus('complete');
        return;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [status, update, mode]);

  // Remove particles after their one-shot animation finishes.
  useEffect(() => {
    if (!shatters.length) return;
    const nextExpiry = Math.min(...shatters.map(effect => effect.createdAt + 800));
    const timeout = window.setTimeout(() => {
      setShatters(current => current.filter(effect => performance.now() < effect.createdAt + 800));
    }, Math.max(0, nextExpiry - performance.now()) + 12);
    return () => window.clearTimeout(timeout);
  }, [shatters]);

  useEffect(() => () => {
    activeCallbackRef.current(false);
    runningRef.current = false;
    detectorRef.current.reset();
    void audioRef.current?.close().catch(() => {});
  }, []);

  function start() {
    if (!enabled) return;
    detectorRef.current.reset();
    setHeldMs(null);
    setHeldOnset(null);
    setShatters([]);
    const fresh = newAssessment(mode);
    stateRef.current = fresh;
    setState(fresh);
    startedAtRef.current = performance.now();
    playedRef.current.clear();
    previousRegionRef.current = nextAssessmentRegion(fresh);
    regionCallbackRef.current(previousRegionRef.current);
    setElapsed(0);
    runningRef.current = true;
    activeCallbackRef.current(true);
    setStatus('running');
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      void audioRef.current.resume();
    } catch { /* Visuals and sensor scoring work without Web Audio. */ }
  }

  function stop() {
    activeCallbackRef.current(false);
    runningRef.current = false;
    detectorRef.current.reset();
    setHeldMs(null);
    setHeldOnset(null);
    setShatters([]);
    setStatus('ready');
    setElapsed(0);
    const fresh = newAssessment(mode);
    stateRef.current = fresh;
    setState(fresh);
    previousRegionRef.current = nextAssessmentRegion(fresh);
    regionCallbackRef.current(previousRegionRef.current);
  }

  useEffect(() => {
    if (!enabled && runningRef.current) {
      runningRef.current = false;
      detectorRef.current.reset();
      setStatus('ready');
      activeCallbackRef.current(false);
    }
  }, [enabled]);

  const pending = state.notes.find(note => !note.verdict);
  const region = pending?.region ?? 'front';
  const total = state.notes.length;
  const actionName = region === 'cpr' ? 'compression' : region === 'back' ? 'back blow' : 'abdominal thrust';
  const scorePct = assessmentAccuracy(state);
  const correct = state.notes.filter(note => ['perfect', 'good', 'okay'].includes(note.verdict ?? '')).length;
  const judged = state.notes.filter(note => note.verdict).length;
  const beatRemaining = pending ? (pending.atMs - elapsed) / 1000 : 0;
  const outcome = state.feedback.toLowerCase().replace(/\s+/g, '-');
  // Between the last back blow and the first thrust: time to change position.
  const firstThrust = state.notes.find(note => note.region === 'front');
  const switching = status === 'running' && !!firstThrust && !firstThrust.verdict &&
    state.notes.every(note => note.region === 'front' || note.verdict) &&
    firstThrust.atMs - elapsed > ASSESSMENT_SETTINGS.switchBannerLeadMs;

  // The pending bar nearest a contact in progress lights up until release.
  const heldNote = heldOnset === null ? undefined : state.notes
    .filter(note => !note.verdict && Math.abs(note.atMs - heldOnset) <= windowsFor(note.region).hitWindowMs)
    .sort((a, b) => Math.abs(a.atMs - heldOnset) - Math.abs(b.atMs - heldOnset))[0];
  const renderNote = (note: AssessmentNote) => {
    const left = noteLeftPct(note, elapsed);
    const width = noteWidthPct(note);
    return left < -35 || left > 120 ? null : <div key={note.id}
      className={`assessment-note ${note.region} ${note.verdict ? `judged ${note.verdict}` : ''} ${note.id === heldNote?.id ? 'held' : ''}`}
      style={{ '--note-x': `${left}%`, '--note-width': `${width}%` } as CSSProperties}>
      <b>{note.region === 'front' ? note.id - 4 : note.id + 1}</b>
      <span className="assessment-hold-strip" />
    </div>;
  };
  const lane = (laneRegion: ContactRegion, name: string) => <div className={`assessment-lane assessment-${laneRegion}-lane`}>
    <div className="assessment-lane-name">{name}</div>
    {state.notes.filter(note => note.region === laneRegion && !isSuccessful(note.verdict)).map(renderNote)}
  </div>;

  return <article className={`assessment-panel ${mode} ${collapsed ? 'collapsed' : ''}`} aria-label={mode === 'cpr' ? 'CPR compression rhythm assessment' : 'Heimlich rhythm assessment'}>
    <div className="assessment-heading">
      <div><h2>Rhythm skill check</h2><p>{mode === 'cpr' ? 'Match each chest compression to the moving bars.' : 'Match each back blow and abdominal thrust to the moving bars.'}</p></div>
      <span className="assessment-mode-tag">{mode === 'cpr' ? '30 COMPRESSIONS' : '5 BACK + 5 ABDOMEN'}</span>
      <button type="button" className="assessment-collapse" aria-expanded={!collapsed} onClick={onToggleCollapsed}>{collapsed ? 'Expand ▾' : 'Collapse ▴'}</button>
    </div>
    {!enabled && <p className="assessment-availability">The rhythm skill check covers severe choking and CPR. Select Severe choking or Unresponsive / CPR to begin.</p>}
    <div className="assessment-stats">
      <div><small>SCORE</small><strong>{state.score.toLocaleString()}</strong></div>
      <div><small>COMBO</small><strong>{state.combo}<span>×</span></strong></div>
      <div><small>ACCURACY</small><strong>{scorePct}<span>%</span></strong></div>
    </div>
    <div className="assessment-stage">
      <div className="assessment-stage-top">
        <span className="assessment-live-dot" />
        <span>{status === 'ready' ? 'READY TO BEGIN' : status === 'complete' ? 'SET COMPLETE' : region === 'cpr' ? 'CHEST COMPRESSIONS' : region === 'back' ? 'BACK BLOWS' : 'ABDOMINAL THRUSTS'}</span>
        <strong>{judged} / {total}</strong>
      </div>
      <div className="assessment-timeline" aria-label="Moving note bars for back blows and abdominal thrusts">
        <div className="assessment-hit-line"><span>HIT</span></div>
        {shatters.map(effect => <div key={effect.id} className={`assessment-shatter ${effect.region}`}
          aria-hidden="true"
          style={{ '--shatter-x': `${effect.leftPct}%`, '--shatter-width': `${effect.widthPct}%` } as CSSProperties}>
          <span className="assessment-shatter-flash" />
          {Array.from({ length: 16 }, (_, index) => <i key={index} style={{
            '--piece-x': `${(index % 4) * 25}%`,
            '--piece-y': `${Math.floor(index / 4) * 25}%`,
            '--vx': `${((index % 4) - 1.5) * 23}px`,
            '--vy': `${(Math.floor(index / 4) - 1.5) * 25}px`,
            '--rot': `${((index % 4) * 2 - 3) * 36}deg`,
            '--delay': `${(index % 4) * 14}ms`,
          } as CSSProperties} />)}
        </div>)}
        {mode === 'cpr' ? lane('cpr', 'CHEST') : <>{lane('back', 'BACK')}{lane('front', 'ABDOMEN')}</>}
        <div className="assessment-timeline-bottom"><span>CONTACT</span><span>↑ Start when bar meets HIT</span></div>
        {switching && firstThrust && <div className="assessment-switch" role="status" aria-live="polite">
          <strong>Moving to abdominal thrusts</strong>
          <span>Stand behind them, fist just above the navel · first thrust in {Math.ceil((firstThrust.atMs - elapsed) / 1000)} s</span>
        </div>}
      </div>
      <div className={`assessment-verdict ${outcome}`} key={state.feedbackId} role="status" aria-live="polite">
        <strong>{status === 'complete' ? 'FINISHED!' : state.feedback}</strong>
        <span>{status === 'running' && pending ? `${Math.max(0, beatRemaining).toFixed(1)} s until next ${actionName} · ${state.feedbackDetail}` : state.feedbackDetail}</span>
      </div>
    </div>
    <div className="assessment-pacing">
      <div className="assessment-progress-cells">{state.notes.map(note => <span key={note.id} className={note.verdict ? note.verdict : 'upcoming'} title={`${noteLabel(note)}: ${note.verdict ?? 'upcoming'}`} />)}</div>
      <div className="assessment-next-action"><span>NEXT ACTION</span><strong>{pending ? `${noteLabel(pending)} of ${pending.region === 'cpr' ? total : 5}` : 'Assessment complete'}</strong></div>
      <div className="assessment-contact-duration">
        <div><span>{heldMs === null ? 'Waiting for a pulse' : `Contact: ${Math.round(heldMs)} ms`}</span><strong>{pending ? `Game target: ${pending.targetDurationMs} ms` : 'Complete'}</strong></div>
        <div className="assessment-duration-track"><i style={{ width: `${pending && heldMs !== null ? Math.min(100, (heldMs / pending.targetDurationMs) * 100) : 0}%` }} /></div>
      </div>

    </div>
    {status === 'complete' && <div className="assessment-result">
      <strong>{correct} of {total} actions passed</strong>
      <span>Best combo: {state.maxCombo} · Placement and contact timing assessed from FSR readings; this does not measure clinical effectiveness.</span>
    </div>}
    <div className="assessment-controls">
      {status === 'running'
        ? <button type="button" className="button-outline" onClick={stop}>End test</button>
        : <button type="button" className="button-primary" onClick={start} disabled={!enabled}>{!enabled ? 'Not available in this scenario' : status === 'complete' ? 'Try again ↻' : 'Start assessment →'}</button>}
    </div>
  </article>;
}
