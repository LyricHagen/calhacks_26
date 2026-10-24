// judge.ts: turns raw trainer frames into thrust, back blow and reference events.
// Pure: no timers, no DOM, no idea where frames come from. Push frames in order,
// read events, calibration and phase at any time. The only side effect is the
// debug log, which says why each event was created, rejected or faulted.
//
// All forces are fractions of the instructor reference peak (1.0 = reference).

import { log } from './debug';

export const HZ = 10;
export const STATES = ['loading', 'empty', 'live', 'summary', 'error'] as ReviewState[];

export const THRESHOLDS = {
  thrustStart: 0.45,     // a thrust starts when fist force rises above this
  thrustEnd: 0.15,       // and ends when it falls below this
  deadTimeMs: 300,       // no new thrust within this long of the last start
  zoneOff: 0.1,          // every torso zone below this during a thrust: off the torso
  weakBelow: 0.6,        // peak below: weaker than reference
  strongAbove: 1.3,      // peak above: much stronger than reference
  backOnTarget: 0.3,     // zones.back must pass this
  backWindowMs: 150,     // within this long of the wrist spike
  slowFactor: 2,         // time to peak above this multiple of the reference's: not abrupt
  slowFloorMs: 300,      // never call a thrust slow under this
};

export const TORSO_ZONES: TorsoZone[] = ['target', 'high', 'low', 'side'];
/** Pad names in the order the judge reads them; the serial source checks the device's hello against this. */
export const PADS = ['target', 'high', 'low', 'side', 'back'] as const;

// Plain-language labels. Wording compares to the reference; it never prescribes a force.
export const LABELS = {
  zone: { target: 'On target', high: 'Too high', low: 'Too low', side: 'To the side', off: 'Off the torso' } as Record<Zone, string>,
  strength: { weak: 'Weaker than reference', similar: 'Similar to reference', strong: 'Much stronger than reference' } as Record<Strength, string>,
  released: { true: 'Released fully', false: 'Release fully' } as Record<'true' | 'false', string>,
  abrupt: { true: 'Abrupt', false: 'Not abrupt' } as Record<'true' | 'false', string>,
  blow: { true: 'Back blow', false: 'Blow off target' } as Record<'true' | 'false', string>,
  fault: {
    'placement-high': 'Too high',
    'placement-low': 'Too low',
    'placement-side': 'To the side',
    'placement-off': 'Off the torso',
    weak: 'Weaker than reference',
    strong: 'Much stronger than reference',
    'not-released': 'Release fully',
    'not-abrupt': 'Not abrupt',
    'blow-off-target': 'Blow off target',
    'out-of-order': 'Out of order',
  } as Record<FaultCode, string>,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Phase = 'rest' | 'calibrating' | 'backblows' | 'thrusts' | 'complete';
export type TorsoZone = 'target' | 'high' | 'low' | 'side';
export type Zone = TorsoZone | 'off';
export type Strength = 'weak' | 'similar' | 'strong';
export type ReviewState = 'loading' | 'empty' | 'live' | 'summary' | 'error';
/** `idle` is live mode before start(); `loading` also covers the brief connect after start(). */
export type Status = 'idle' | ReviewState;
export type FaultCode =
  | 'placement-high' | 'placement-low' | 'placement-side' | 'placement-off'
  | 'weak' | 'strong' | 'not-released' | 'not-abrupt' | 'blow-off-target' | 'out-of-order';
export type Pads = { target: number; high: number; low: number; side: number; back: number };

/** What the device's firmware reports about its own 5-and-5 state machine. */
export interface DeviceState {
  phase: Phase;
  /** 0 before the first cycle, then 1 to 4. */
  cycle: number;
  /** Rises by one on each wrist IMU spike. */
  backBlowCount: number;
  thrustCount: number;
  /** Degrees above horizontal while the wrist is moving in a thrust, else null. */
  angle: number | null;
}

/** One reading as a data source delivers it. */
export interface RawFrame {
  t: number;
  fist: number;
  pads: Pads;
  /** Wrist accelerometer. null when the source has none (the recording does not). */
  acc: { x: number; y: number; z: number } | null;
  /** Firmware state; without it phase holds and back blows cannot be detected. */
  device?: DeviceState;
}

/** A judged frame, as the pages draw it. */
export interface Frame {
  t: number;
  phase: Phase;
  fist: number;
  zones: Pads;
  /** Degrees above horizontal while the wrist is moving in a thrust, else null. Shown, never graded. */
  angle: number | null;
  cycle: number;
  backBlowCount: number;
  thrustCount: number;
}

export interface ThrustEvent {
  id: string;
  /** `reference` is an instructor thrust during calibration. */
  type: 'thrust' | 'reference';
  n: number;
  cycle: number;
  /** 1 to 5 inside its cycle (1 to 3 for references). */
  index: number;
  tStart: number;
  tPeak: number;
  tEnd: number | null;
  peak: number;
  zonePeaks: Record<TorsoZone, number>;
  zone: Zone | null;
  strength: Strength | null;
  timeToPeakMs: number;
  abrupt: boolean | null;
  /** null while the thrust is still open. */
  released: boolean | null;
  angle: number | null;
  faults: FaultCode[];
  /** true while still being judged; fields may change until it closes. */
  open: boolean;
}

export interface BackBlowEvent {
  id: string;
  type: 'backblow';
  n: number;
  cycle: number;
  index: number;
  t: number;
  backPeak: number;
  onTarget: boolean | null;
  faults: FaultCode[];
  open: boolean;
}

export type SessionEvent = ThrustEvent | BackBlowEvent;

export interface Fault {
  eventId: string;
  type: 'thrust' | 'backblow';
  cycle: number;
  index: number;
  t: number;
  code: FaultCode;
  label: string;
}

export interface Sequence {
  held: boolean;
  cyclesCompleted: number;
  position: number;
  expectedNext: 'backblow' | 'thrust';
  breaks: { eventId: string; expected: string; got: string }[];
}

interface Stats { min: number | null; max: number | null; mean: number | null; sd: number | null }

export interface Summary {
  status: Status;
  t: number;
  counts: { thrusts: number; backBlows: number; references: number; cycles: number };
  zones: Record<Zone, number>;
  backBlows: { onTarget: number; offTarget: number };
  strength: Record<Strength, number>;
  released: { yes: number; no: number };
  reference: { peaks: number[]; mean: number | null; spread: number | null };
  peaks: Stats & { spreadVsReference: number | null; withinSimilarBand: number };
  angle: Stats & { graded: false };
  faults: Fault[];
  sequence: Sequence;
}

export interface Calibration {
  /** Mean of each reading over the rest phase; null until rest ends. */
  baseline: ({ fist: number } & Pads) | null;
  baselineFrames: number;
  refPeaks: number[];
  refMean: number | null;
  /** Largest minus smallest reference peak, over the mean. */
  spread: number | null;
  spreadOk: boolean | null;
  refTimeToPeakMs: number | null;
}

export interface PhaseTransition { from: Phase | null; to: Phase; t: number; trigger: string }

export interface JudgeStep {
  frame: Frame;
  transition: PhaseTransition | null;
  /** Ids of events that closed on this frame. */
  closed: string[];
}

export const SPREAD_LIMIT = 0.15;

const round = (x: number | null, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const EPS = 1e-6;
const ms = (s: number) => Math.round(s * 1000);

/** Entry tag as the pages print it: T07, B12, R2. */
const tagOf = (e: { type: string; n: number }) =>
  e.type === 'reference' ? `R${e.n}` : `${e.type === 'thrust' ? 'T' : 'B'}${String(e.n).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// Judge. Incremental: push frames in order, read events at any time.
// ---------------------------------------------------------------------------
export function createJudge({ calibration }: { calibration?: Partial<Calibration> } = {}) {
  const T = THRESHOLDS;
  const L = log.judge;
  const C = log.calib;
  const events: SessionEvent[] = [];
  let open: ThrustEvent | null = null;     // thrust or reference in progress
  let armed = true;                        // fist has fallen below the start threshold since the last start
  let lastStart = -Infinity;
  let prevBlowCount = 0;
  const pendingBlows: BackBlowEvent[] = []; // back blows still inside their +150 ms window
  const recent: Frame[] = [];              // frames inside the back-blow window
  let refTimeToPeakMs: number | null = calibration?.refTimeToPeakMs ?? null;
  const counters = { thrust: 0, blow: 0, reference: 0, byCycle: {} as Record<number, { thrust: number; backblow: number }> };

  // Bookkeeping for the log only; none of it changes a judgment.
  let frameNo = -1;
  let prev: Frame | null = null;
  let lastEnd = -Infinity;
  let lowSincePeak = Infinity;              // lowest fist since the open thrust's peak
  let below: { tStart: number; peak: number } | null = null; // a push that has not reached START yet
  let seqCount = 0;
  let warnedNoDevice = false;
  const rest = { n: 0, sum: { fist: 0, target: 0, high: 0, low: 0, side: 0, back: 0 } };
  const cal: Calibration = {
    baseline: calibration?.baseline ?? null,
    baselineFrames: calibration?.baselineFrames ?? 0,
    refPeaks: [...(calibration?.refPeaks ?? [])],
    refMean: calibration?.refMean ?? null,
    spread: calibration?.spread ?? null,
    spreadOk: calibration?.spreadOk ?? null,
    refTimeToPeakMs,
  };
  if (calibration) C.info('Judge started with a calibration supplied by the caller', { ...cal });

  const refBasis = () => cal.refMean ?? 1;
  const pct = (x: number) => Math.round((x / refBasis()) * 100);

  const cycleCount = (cycle: number, type: 'thrust' | 'backblow') => {
    const c = (counters.byCycle[cycle] ??= { thrust: 0, backblow: 0 });
    return ++c[type];
  };

  function finishThrust(e: ThrustEvent, released: boolean, t: number) {
    e.open = false;
    e.released = released;
    e.tEnd = released ? t : null;
    judge(e);
    logJudged(e);
  }

  function slowLimit() {
    return Math.max(T.slowFloorMs, (refTimeToPeakMs ?? 0) * T.slowFactor);
  }

  function judge(e: ThrustEvent) {
    const zp = e.zonePeaks;
    let zone: Zone = 'off';
    let best = T.zoneOff;
    for (const z of TORSO_ZONES) if (zp[z] >= best) { best = zp[z]; zone = z; }
    e.zone = zone;
    e.strength = e.peak < T.weakBelow ? 'weak' : e.peak > T.strongAbove ? 'strong' : 'similar';
    e.timeToPeakMs = Math.round((e.tPeak - e.tStart) * 1000);
    if (e.type === 'reference') { e.faults = []; return; }
    const slowAt = slowLimit();
    e.abrupt = e.timeToPeakMs <= slowAt;
    const f: FaultCode[] = [];
    if (zone !== 'target') f.push(`placement-${zone}` as FaultCode);
    if (e.strength !== 'similar') f.push(e.strength);
    if (e.released === false) f.push('not-released');
    if (!e.abrupt) f.push('not-abrupt');
    e.faults = f;
  }

  function startThrust(frame: Frame): ThrustEvent {
    const isRef = frame.phase === 'calibrating';
    const e: ThrustEvent = {
      id: '',
      type: isRef ? 'reference' : 'thrust',
      n: isRef ? ++counters.reference : ++counters.thrust,
      cycle: isRef ? 0 : frame.cycle,
      index: 0,
      tStart: frame.t,
      tPeak: frame.t,
      tEnd: null,
      peak: frame.fist,
      zonePeaks: Object.fromEntries(TORSO_ZONES.map((z) => [z, frame.zones[z]])) as Record<TorsoZone, number>,
      zone: null,
      strength: null,
      timeToPeakMs: 0,
      abrupt: null,
      released: null,
      angle: frame.angle,
      faults: [],
      open: true,
    };
    e.index = isRef ? e.n : cycleCount(frame.cycle, 'thrust');
    e.id = isRef ? `ref-${e.n}` : `thrust-${e.n}`;
    events.push(e);
    return e;
  }

  // ---- frame intake --------------------------------------------------------
  function toFrame(raw: RawFrame): Frame {
    const d = raw.device;
    if (!d && !warnedNoDevice) {
      warnedNoDevice = true;
      L.warn('Frame arrived without device state, so phase, cycle and back blows cannot be read from the trainer', {
        t: raw.t, phase_held_at: prev?.phase ?? 'rest', has_acc: raw.acc != null,
      });
    }
    if (!Number.isFinite(raw.fist)) L.warn('Fist reading is not a number; thrust thresholds cannot be compared on this frame', { t: raw.t, fist: String(raw.fist) });
    const p = raw.pads;
    return {
      t: raw.t,
      phase: d?.phase ?? prev?.phase ?? 'rest',
      fist: raw.fist,
      zones: { target: p.target, high: p.high, low: p.low, side: p.side, back: p.back },
      angle: d ? d.angle : null,
      cycle: d?.cycle ?? prev?.cycle ?? 0,
      backBlowCount: d?.backBlowCount ?? prevBlowCount,
      thrustCount: d?.thrustCount ?? counters.thrust,
    };
  }

  function trigger(from: Phase | null, frame: Frame): string {
    const to = frame.phase;
    if (from == null) return 'first frame received';
    if (from === 'rest' && to === 'calibrating') return 'device ended the baseline rest; instructor reference begins';
    if (from === 'calibrating' && to === 'backblows') return `device ended calibration and started cycle ${frame.cycle}`;
    if (from === 'backblows' && to === 'thrusts') return `device back blow counter reached ${frame.backBlowCount}, the fifth of cycle ${frame.cycle}`;
    if (from === 'thrusts' && to === 'backblows') return `fifth thrust of cycle ${frame.cycle - 1} ended; cycle ${frame.cycle} started`;
    if (to === 'complete') return `fifth thrust of the final cycle (${frame.cycle}) ended`;
    return 'device reported a phase change this judge has no rule for';
  }

  function trackPhase(frame: Frame): PhaseTransition | null {
    const from = prev?.phase ?? null;
    if (from === frame.phase) {
      if (prev && frame.cycle !== prev.cycle) L.info('Cycle number changed without a phase change', { t: frame.t, cycle_from: prev.cycle, cycle_to: frame.cycle, phase: frame.phase });
      return null;
    }
    const tr: PhaseTransition = { from, to: frame.phase, t: frame.t, trigger: trigger(from, frame) };
    log.session.info(`PHASE ${from ?? 'start'} -> ${frame.phase}: ${tr.trigger}`, {
      t: frame.t, cycle_from: prev?.cycle ?? null, cycle_to: frame.cycle,
      device_blows: frame.backBlowCount, device_thrusts: frame.thrustCount,
      judged_blows: counters.blow, judged_thrusts: counters.thrust, judged_refs: counters.reference,
    });
    if (from === 'backblows' && frame.phase === 'thrusts') {
      const got = counters.byCycle[frame.cycle]?.backblow ?? 0;
      if (got !== 5) L.warn(`Cycle ${frame.cycle} moved to thrusts after ${got} judged back blows, not 5`, { judged: got, expected: 5 });
    }
    if (from === 'thrusts' && (frame.phase === 'backblows' || frame.phase === 'complete')) {
      const c = frame.phase === 'complete' ? frame.cycle : frame.cycle - 1;
      const got = counters.byCycle[c]?.thrust ?? 0;
      if (got !== 5) L.warn(`Cycle ${c} ended after ${got} judged thrusts, not 5`, { judged: got, expected: 5 });
    }
    if (from === 'rest') finishBaseline();
    if (from === 'calibrating') logCalibrationSummary('Calibration phase ended');
    return tr;
  }

  // ---- calibration ---------------------------------------------------------
  function finishBaseline() {
    if (!rest.n) { C.warn('Rest phase ended with no frames, so no baseline was set', { rest_frames: 0 }); return; }
    const b = Object.fromEntries(Object.entries(rest.sum).map(([k, v]) => [k, v / rest.n])) as Calibration['baseline'] & object;
    cal.baseline = b;
    cal.baselineFrames = rest.n;
    C.info('BASELINE fist set from the rest phase; it must sit below the thrust END threshold or thrusts can never end', {
      value: b.fist, must_be_below: T.thrustEnd, within_limit: b.fist < T.thrustEnd, rest_frames: rest.n,
    });
    for (const k of PADS) {
      C.info(`BASELINE ${k} pad set from the rest phase; it must sit below the pad contact floor or the pad reads as hit while idle`, {
        value: b[k], must_be_below: T.zoneOff, within_limit: b[k] < T.zoneOff, rest_frames: rest.n,
      });
    }
  }

  function logCalibrationSummary(why: string) {
    C.info(`${why}: reference summary`, {
      peaks: cal.refPeaks, count: cal.refPeaks.length, expected_count: 3,
      mean: cal.refMean, spread: cal.spread, spread_limit: SPREAD_LIMIT, spread_within_limit: cal.spreadOk,
      ref_time_to_peak_ms: refTimeToPeakMs,
    });
    if (cal.refPeaks.length !== 3) C.warn(`Calibration has ${cal.refPeaks.length} reference thrusts, expected 3`, { count: cal.refPeaks.length, expected: 3 });
  }

  function updateReference() {
    const refs = events.filter((e): e is ThrustEvent => e.type === 'reference' && !e.open);
    if (refs.length) refTimeToPeakMs = refs.reduce((a, e) => a + e.timeToPeakMs, 0) / refs.length;
    const peaks = refs.map((e) => round(e.peak) as number);
    const mean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
    cal.refPeaks = peaks;
    cal.refMean = round(mean);
    cal.spread = round((Math.max(...peaks) - Math.min(...peaks)) / mean);
    cal.spreadOk = cal.spread != null && cal.spread <= SPREAD_LIMIT;
    cal.refTimeToPeakMs = refTimeToPeakMs;
    const last = refs[refs.length - 1];
    C.info(`REFERENCE PEAK ${tagOf(last)} recorded`, { peak: last.peak, time_to_peak_ms: last.timeToPeakMs, count: refs.length, expected_count: 3 });
    C.info('Reference updated: later thrusts are judged against these numbers', {
      peaks, mean: cal.refMean, spread: cal.spread, spread_limit: SPREAD_LIMIT, spread_within_limit: cal.spreadOk,
      ref_time_to_peak_ms: Math.round(refTimeToPeakMs ?? 0), slow_limit_ms: Math.round(slowLimit()),
    });
    if (refs.length > 3) C.warn(`More than 3 reference thrusts were recorded (${refs.length}); every one is averaged into the reference`, { count: refs.length, expected: 3 });
  }

  // ---- event logs ----------------------------------------------------------
  function logSequence(e: SessionEvent) {
    const pos = seqCount++ % 10;
    const expected = pos < 5 ? 'backblow' : 'thrust';
    const fields = { position: pos + 1, of: 10, expected, got: e.type, cycle: e.cycle };
    if (e.type !== expected) L.warn(`${tagOf(e)} OUT OF ORDER in the 5-and-5 sequence`, fields);
    else L.info(`${tagOf(e)} fits the 5-and-5 sequence`, { ...fields, next_expected: (pos + 1) % 10 < 5 ? 'backblow' : 'thrust' });
  }

  function logJudged(e: ThrustEvent) {
    const tg = tagOf(e);
    const isRef = e.type === 'reference';
    const zone = e.zone ?? 'off';
    const reading = zone === 'off' ? Math.max(...TORSO_ZONES.map((z) => e.zonePeaks[z])) : e.zonePeaks[zone];
    const parts = [LABELS.zone[zone], LABELS.strength[e.strength ?? 'similar'], LABELS.released[String(e.released) as 'true' | 'false']];
    if (!isRef) parts.push(LABELS.abrupt[String(e.abrupt) as 'true' | 'false']);
    L.info(`${tg} ${isRef ? 'REFERENCE' : 'THRUST'} judged: ${parts.join(', ')}`, {
      peak: e.peak, pct_of_ref: pct(e.peak), ref_mean: refBasis(),
      placement: zone, placement_reading: reading, pad_floor: T.zoneOff,
      pads: TORSO_ZONES.map((z) => `${z}:${e.zonePeaks[z].toFixed(3)}`).join(','),
      strength: e.strength, weak_below: T.weakBelow, strong_above: T.strongAbove,
      released: e.released, time_to_peak_ms: e.timeToPeakMs,
      ...(isRef ? {} : { abrupt: e.abrupt, slow_limit_ms: Math.round(slowLimit()) }),
      angle: e.angle, cycle: e.cycle, index: e.index, faults: e.faults,
    });
    for (const f of e.faults) logFault(e, f, reading);
  }

  function logFault(e: ThrustEvent, f: FaultCode, reading: number) {
    const tg = `${tagOf(e)} FAULT ${f} (${LABELS.fault[f]})`;
    if (f.startsWith('placement-')) {
      if (e.zone === 'off') L.warn(`${tg}: no torso pad reached the contact floor during the thrust`, { highest_pad_reading: reading, pad_floor: T.zoneOff });
      else L.warn(`${tg}: the highest pad was ${e.zone}, not target`, { [`${e.zone}_reading`]: reading, target_reading: e.zonePeaks.target, pad_floor: T.zoneOff });
    } else if (f === 'weak') L.warn(`${tg}: peak was below the weak line`, { peak: e.peak, weak_below: T.weakBelow, pct_of_ref: pct(e.peak) });
    else if (f === 'strong') L.warn(`${tg}: peak was above the much-stronger line`, { peak: e.peak, strong_above: T.strongAbove, pct_of_ref: pct(e.peak) });
    else if (f === 'not-released') L.warn(`${tg}: the next push started before the fist fell below END`, { lowest_after_peak: lowSincePeak, end: T.thrustEnd });
    else if (f === 'not-abrupt') L.warn(`${tg}: time to peak was longer than the slow limit`, { time_to_peak_ms: e.timeToPeakMs, slow_limit_ms: Math.round(slowLimit()), ref_time_to_peak_ms: refTimeToPeakMs, slow_factor: T.slowFactor, slow_floor_ms: T.slowFloorMs });
  }

  function logBlowJudged(e: BackBlowEvent) {
    const fields = { back_peak: e.backPeak, on_target_above: T.backOnTarget, on_target: e.onTarget, window_ms: T.backWindowMs, cycle: e.cycle, index: e.index, faults: e.faults };
    L.info(`${tagOf(e)} BACK BLOW judged: ${LABELS.blow[String(e.onTarget) as 'true' | 'false']}`, fields);
    if (!e.onTarget) L.warn(`${tagOf(e)} FAULT blow-off-target (${LABELS.fault['blow-off-target']}): back pad never passed the on-target line within the window after the wrist spike`, { back_peak: e.backPeak, on_target_above: T.backOnTarget, window_ms: T.backWindowMs });
  }

  // ---- main step -----------------------------------------------------------
  function push(raw: RawFrame): JudgeStep {
    frameNo++;
    const frame = toFrame(raw);
    const transition = trackPhase(frame);
    const closed: string[] = [];
    const x = frame.fist;
    const px = prev?.fist ?? null;
    const tracking = frame.phase !== 'rest';
    if (frame.phase === 'rest') {
      rest.n++;
      rest.sum.fist += x;
      for (const k of PADS) rest.sum[k] += frame.zones[k];
    }

    // Thrusts and reference thrusts. A new push is checked first so that a
    // thrust that was never released does not absorb the next one's peak.
    const sinceStartMs = (frame.t - lastStart) * 1000;
    const deadOk = sinceStartMs >= T.deadTimeMs - EPS;
    const startsNew = tracking && armed && x > T.thrustStart && deadOk;
    const crossedUp = px != null && px <= T.thrustStart && x > T.thrustStart;

    if (x > T.thrustStart && !startsNew) {
      if (!tracking && crossedUp) L.info('Fist rose above START during rest; thrusts are not tracked while the baseline is set', { fist: x, start: T.thrustStart, phase: frame.phase, frame: frameNo });
      else if (tracking && !armed && crossedUp) L.info('Fist rose above START but the previous push never fell below START, so it is the same push', { fist: x, start: T.thrustStart, frame: frameNo });
      else if (tracking && armed && !deadOk) L.warn('THRUST START rejected: inside the dead time after the previous start', { fist: x, start: T.thrustStart, ms_since_last_start: Math.round(sinceStartMs), dead_time_ms: T.deadTimeMs, frame: frameNo });
    }

    if (startsNew && open) {
      // Never fell below the end threshold before this new push: not released.
      const o = open;
      L.warn(`${tagOf(o)} NOT RELEASED: a new push crossed START before the fist fell below END`, {
        fist: x, start: T.thrustStart, lowest_after_peak: lowSincePeak, end: T.thrustEnd, peak: o.peak, frame: frameNo,
      });
      finishThrust(o, false, frame.t);
      closed.push(o.id);
      if (o.type === 'reference') updateReference();
      open = null;
    }
    if (open) {
      if (x > open.peak) { open.peak = x; open.tPeak = frame.t; lowSincePeak = x; if (frame.angle != null) open.angle = frame.angle; }
      else lowSincePeak = Math.min(lowSincePeak, x);
      if (open.angle == null && frame.angle != null) open.angle = frame.angle;
      for (const z of TORSO_ZONES) open.zonePeaks[z] = Math.max(open.zonePeaks[z], frame.zones[z]);
      if (x < T.thrustEnd) {
        const o = open;
        L.info(`${tagOf(o)} THRUST END: fist fell below the END threshold`, {
          fist: x, end: T.thrustEnd, direction: 'down', peak: o.peak, duration_ms: ms(frame.t - o.tStart), frame: frameNo,
        });
        lastEnd = frame.t;
        finishThrust(o, true, frame.t);
        closed.push(o.id);
        if (o.type === 'reference') updateReference();
        open = null;
      }
      if (x < T.thrustStart) {
        if (!armed && open) L.info(`${tagOf(open)} fist fell back below START; the next rise above START counts as a new push`, { fist: x, start: T.thrustStart, direction: 'down', frame: frameNo });
        armed = true;
      }
    }

    // A push that rises above END but never reaches START is not an event.
    if (tracking && !open && !startsNew) {
      if (x >= T.thrustEnd) {
        below ??= { tStart: frame.t, peak: x };
        below.peak = Math.max(below.peak, x);
      } else if (below) {
        L.info('Push rejected: fist rose above END but never reached START, so no thrust was counted', {
          peak: below.peak, start: T.thrustStart, end: T.thrustEnd, t_start: below.tStart, duration_ms: ms(frame.t - below.tStart),
        });
        below = null;
      }
    }

    if (startsNew) {
      below = null;
      open = startThrust(frame);
      armed = false;
      lowSincePeak = x;
      const isRef = open.type === 'reference';
      L.info(`${tagOf(open)} ${isRef ? 'REFERENCE' : 'THRUST'} START ${crossedUp ? 'crossed the start threshold' : 'fist was already above START when the dead time ran out'}`, {
        fist: x, start: T.thrustStart, ref: refBasis(), direction: 'up',
        deadtime_ok: deadOk, ms_since_last_start: Number.isFinite(sinceStartMs) ? Math.round(sinceStartMs) : 'none', dead_time_ms: T.deadTimeMs,
        ms_since_last_end: Number.isFinite(lastEnd) ? ms(frame.t - lastEnd) : 'none',
        phase: frame.phase, cycle: open.cycle, index: open.index, frame: frameNo,
      });
      if (!isRef) logSequence(open);
      lastStart = frame.t;
    }
    if (open) judge(open); // live provisional judgment for the in-progress card

    // Back blows: the wrist spike is the frame where the device's count rises.
    recent.push(frame);
    while (recent.length && frame.t - recent[0].t > T.backWindowMs / 1000 + EPS) recent.shift();
    if (frame.backBlowCount > prevBlowCount) {
      if (frame.backBlowCount - prevBlowCount > 1) L.warn('Device blow counter jumped by more than one in a single frame; each step becomes its own back blow', { from: prevBlowCount, to: frame.backBlowCount, frame: frameNo });
      for (let k = prevBlowCount; k < frame.backBlowCount; k++) {
        const e: BackBlowEvent = {
          id: `blow-${++counters.blow}`,
          type: 'backblow',
          n: counters.blow,
          cycle: frame.cycle,
          index: cycleCount(frame.cycle, 'backblow'),
          t: frame.t,
          backPeak: Math.max(...recent.map((f) => f.zones.back)),
          onTarget: null,
          faults: [],
          open: true,
        };
        events.push(e);
        pendingBlows.push(e);
        judgeBlow(e);
        L.info(`${tagOf(e)} BACK BLOW detected: device blow counter rose (wrist IMU spike)`, {
          counter_from: k, counter_to: k + 1, back_now: frame.zones.back, back_peak_so_far: e.backPeak,
          on_target_above: T.backOnTarget, window_ms: T.backWindowMs, cycle: e.cycle, index: e.index, frame: frameNo,
        });
        logSequence(e);
      }
      prevBlowCount = frame.backBlowCount;
    } else if (frame.backBlowCount < prevBlowCount) {
      L.warn('Device blow counter went down; the trainer may have restarted', { from: prevBlowCount, to: frame.backBlowCount, frame: frameNo });
    }
    for (const e of pendingBlows) {
      if (frame.t - e.t <= T.backWindowMs / 1000 + EPS) e.backPeak = Math.max(e.backPeak, frame.zones.back);
      judgeBlow(e);
      if (frame.t - e.t >= T.backWindowMs / 1000 - EPS) {
        e.open = false;
        closed.push(e.id);
        logBlowJudged(e);
      }
    }
    for (let i = pendingBlows.length - 1; i >= 0; i--) if (!pendingBlows[i].open) pendingBlows.splice(i, 1);

    prev = frame;
    return { frame, transition, closed };
  }

  function judgeBlow(e: BackBlowEvent) {
    e.onTarget = e.backPeak > T.backOnTarget;
    e.faults = e.onTarget ? [] : ['blow-off-target'];
  }

  return {
    push,
    // Rounded copies so consumers can hold them without seeing later mutation.
    events: (): SessionEvent[] => events.map((e) => {
      const c = { ...e } as SessionEvent;
      if ('peak' in c && c.peak != null) c.peak = round(c.peak) as number;
      if ('backPeak' in c && c.backPeak != null) c.backPeak = round(c.backPeak) as number;
      if ('zonePeaks' in c && c.zonePeaks) c.zonePeaks = Object.fromEntries(Object.entries(c.zonePeaks).map(([k, v]) => [k, round(v)])) as Record<TorsoZone, number>;
      c.faults = [...c.faults];
      return c;
    }),
    calibration: (): Calibration => ({ ...cal, refPeaks: [...cal.refPeaks], baseline: cal.baseline && { ...cal.baseline } }),
    /** Where the judge is now, for diagnostics. */
    state: () => ({
      frames: frameNo + 1,
      phase: prev?.phase ?? null,
      cycle: prev?.cycle ?? 0,
      thrusts: counters.thrust,
      blows: counters.blow,
      references: counters.reference,
      open: open ? tagOf(open) : null,
    }),
  };
}

export type Judge = ReturnType<typeof createJudge>;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const stats = (xs: number[]): Stats => {
  if (!xs.length) return { min: null, max: null, mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { min: round(Math.min(...xs)), max: round(Math.max(...xs)), mean: round(mean), sd: round(sd) };
};

export function checkSequence(events: SessionEvent[]): Sequence {
  // Expected: 5 back blows, then 5 thrusts, repeated.
  const seq = events.filter((e) => e.type === 'thrust' || e.type === 'backblow');
  const breaks: Sequence['breaks'] = [];
  seq.forEach((e, i) => {
    const expected = i % 10 < 5 ? 'backblow' : 'thrust';
    if (e.type !== expected) breaks.push({ eventId: e.id, expected, got: e.type });
  });
  return {
    held: breaks.length === 0,
    cyclesCompleted: breaks.length ? 0 : Math.floor(seq.length / 10),
    position: seq.length % 10,        // 0 to 9 inside the current cycle
    expectedNext: seq.length % 10 < 5 ? 'backblow' : 'thrust',
    breaks,
  };
}

export function summarize(events: SessionEvent[], { status = 'live', t = 0 }: { status?: Status; t?: number } = {}): Summary {
  const thrusts = events.filter((e): e is ThrustEvent => e.type === 'thrust');
  const blows = events.filter((e): e is BackBlowEvent => e.type === 'backblow');
  const refs = events.filter((e): e is ThrustEvent => e.type === 'reference');
  const zones = { target: 0, high: 0, low: 0, side: 0, off: 0 };
  const strength = { weak: 0, similar: 0, strong: 0 };
  for (const e of thrusts) {
    if (e.zone) zones[e.zone]++;
    if (e.strength) strength[e.strength]++;
  }
  const refPeaks = refs.map((e) => e.peak);
  const ref = stats(refPeaks);
  const peaks = thrusts.map((e) => e.peak);
  const angles = thrusts.map((e) => e.angle).filter((a): a is number => a != null);
  const sequence = checkSequence(events);

  const faults: Fault[] = [];
  const timeOf = (e: SessionEvent) => (e.type === 'backblow' ? e.t : e.tStart);
  for (const e of [...thrusts, ...blows].sort((a, b) => timeOf(a) - timeOf(b))) {
    for (const code of e.faults) {
      faults.push({
        eventId: e.id, type: e.type as Fault['type'], cycle: e.cycle, index: e.index,
        t: timeOf(e), code, label: LABELS.fault[code],
      });
    }
  }
  for (const b of sequence.breaks) {
    const e = events.find((x) => x.id === b.eventId)!;
    faults.push({ eventId: b.eventId, type: e.type as Fault['type'], cycle: e.cycle, index: e.index, t: timeOf(e), code: 'out-of-order', label: LABELS.fault['out-of-order'] });
  }

  return {
    status,
    t: round(t, 1) as number,
    counts: {
      thrusts: thrusts.length,
      backBlows: blows.length,
      references: refs.length,
      cycles: sequence.cyclesCompleted,
    },
    zones,
    backBlows: { onTarget: blows.filter((e) => e.onTarget).length, offTarget: blows.filter((e) => e.onTarget === false).length },
    strength,
    released: { yes: thrusts.filter((e) => e.released === true).length, no: thrusts.filter((e) => e.released === false).length },
    reference: {
      peaks: refPeaks,
      mean: ref.mean,
      // Max minus min as a fraction of the mean: the repeatability check wants about 0.15 or less.
      spread: ref.mean ? round(((ref.max as number) - (ref.min as number)) / ref.mean) : null,
    },
    peaks: {
      ...stats(peaks),
      // Mean absolute distance from the reference (1.0).
      spreadVsReference: peaks.length ? round(peaks.reduce((a, p) => a + Math.abs(p - 1), 0) / peaks.length) : null,
      withinSimilarBand: strength.similar,
    },
    angle: { ...stats(angles), graded: false },
    faults,
    sequence,
  };
}
