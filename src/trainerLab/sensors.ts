export const ADC_MAX = 4095;
export const RAW_THRESHOLD = 650;

export const SENSOR_KEYS = [
  'front_target',
  'front_high',
  'front_low',
  'front_left',
  'front_right',
  'back_target',
  'back_left',
  'back_right',
  'cpr_sternum',
] as const;

export const SENSOR_NAMES = [
  'Target abdomen',
  'Too high',
  'Too low',
  'Front left',
  'Front right',
  'Centre back — between shoulder blades',
  'Back left — off target',
  'Back right — off target',
  'CPR — sternum',
] as const;

export type SensorId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type NineReadings = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type ActionType = 'front' | 'back' | 'cpr';

export type DetectedAction = {
  type: ActionType;
  sensor: SensorId;
  peak: number;
  time: number;
  durationMs: number;
  // Sharpness: time from 10% to 90% of this hit's own peak, and from the
  // start of the rise to release. Null if the trace was too short to tell.
  riseMs: number | null;
  contactMs: number | null;
  bothCpr: boolean;
  pattern: NineReadings;
};

export type NineFrame = {
  readings: NineReadings;
  peaks: NineReadings;
  deviceTimeMs: number | null;
};

export type NineMessage =
  | { kind: 'hello'; hz: number; names: string[] }
  | { kind: 'frame'; frame: NineFrame };

export const EMPTY: NineReadings = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export function emptyReadings(): NineReadings {
  return [...EMPTY] as NineReadings;
}

export function clampADC(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(ADC_MAX, Math.round(value)));
}

// Each pad is wired 3.3 V -> FSR -> ADC pin -> 2.2 kΩ -> GND, so
// V = 3.3 · 2.2 / (2.2 + R_fsr) and R_fsr = 2.2 · (4095 / adc - 1) kΩ.
const DIVIDER_KOHM = 2.2;

// Power-law fit to the FSR 402 datasheet curve (R ≈ 156 kΩ · F^-0.70, F in
// grams). Good from ~50 g to 10 kg; below ~20 g the FSR is effectively open.
const FIT_KOHM = 156;
const FIT_EXPONENT = 0.7;
const MIN_GRAMS = 20;
const MAX_GRAMS = 10000;

export function adcToKohm(adc: number): number {
  const value = clampADC(adc);
  if (value <= 0) {
    return Infinity;
  }

  return DIVIDER_KOHM * (ADC_MAX / value - 1);
}

// Approximate force on one pad, in grams. 0 when below the FSR's turn-on.
export function adcToGrams(adc: number): number {
  const kohm = adcToKohm(adc);
  if (!Number.isFinite(kohm)) {
    return 0;
  }

  const grams = kohm <= 0 ? MAX_GRAMS : (FIT_KOHM / kohm) ** (1 / FIT_EXPONENT);
  return grams < MIN_GRAMS ? 0 : Math.min(MAX_GRAMS, grams);
}

const STANDARD_GRAVITY = 9.80665;

export function gramsToNewtons(grams: number): number {
  return grams / 1000 * STANDARD_GRAVITY;
}

export function adcToNewtons(adc: number): number {
  return gramsToNewtons(adcToGrams(adc));
}

// Per-pad correction, in SensorId order: true N ÷ displayed N, measured by
// resting a known weight in the centre of each plate. Accounts for load the
// plate's mounting carries instead of the FSR, and part-to-part FSR spread.
export const PAD_SCALE: NineReadings = [1, 1, 1, 1, 1, 1, 1, 1, 1];

// True once the FSR is past the end of the datasheet curve, so the force
// shown is a lower bound.
export function isSaturated(adc: number): boolean {
  return adcToGrams(adc) >= MAX_GRAMS;
}

// Force applied to a pad's plate, in newtons: the FSR's force above what it
// carries at rest (plate weight, mounting preload), times the pad's scale.
export function padNewtons(id: SensorId, adc: number, baselineAdc: number): number {
  const applied = adcToNewtons(adc) - adcToNewtons(baselineAdc);
  return Math.max(0, applied) * PAD_SCALE[id];
}

export function formatForce(newtons: number, saturated = false): string {
  if (newtons <= 0) {
    return '0 N';
  }

  if (saturated) {
    return `${Math.round(newtons)}+ N`;
  }

  return newtons < 10 ? `${newtons.toFixed(1)} N` : `${Math.round(newtons)} N`;
}

function isRawArray(value: unknown): value is NineReadings {
  return (
    Array.isArray(value) &&
    value.length === 9 &&
    value.every(
      item =>
        typeof item === 'number' &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= ADC_MAX,
    )
  );
}

export class NineSensorProtocol {
  private wireToLogical: SensorId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  parseLine(line: string): NineMessage | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const data = parsed as Record<string, unknown>;

    if ('hello' in data) {
      if (
        data.hello !== 'chokesense-9fsr' ||
        !Array.isArray(data.pads) ||
        data.pads.length !== 9 ||
        !data.pads.every(pad => typeof pad === 'string')
      ) {
        return null;
      }

      const order = data.pads.map(pad =>
        (SENSOR_KEYS as readonly string[]).indexOf(pad),
      );

      if (order.some(index => index < 0) || new Set(order).size !== 9) {
        return null;
      }

      this.wireToLogical = order as SensorId[];

      return {
        kind: 'hello',
        hz:
          typeof data.hz === 'number' && Number.isFinite(data.hz)
            ? data.hz
            : 0,
        names: [...data.pads],
      };
    }

    if (data.schema !== undefined && data.schema !== 'fsr9-v1') {
      return null;
    }

    const raw = data.fsr ?? data.fsrs ?? data.pads;
    const peak = data.peak === undefined ? raw : data.peak;

    if (!isRawArray(raw) || !isRawArray(peak)) {
      return null;
    }

    const readings = emptyReadings();
    const peaks = emptyReadings();

    for (let wire = 0; wire < 9; wire++) {
      const logical = this.wireToLogical[wire];
      readings[logical] = raw[wire];
      peaks[logical] = Math.max(raw[wire], peak[wire]);
    }

    return {
      kind: 'frame',
      frame: {
        readings,
        peaks,
        deviceTimeMs:
          typeof data.t === 'number' &&
            Number.isFinite(data.t) &&
            data.t >= 0
            ? data.t
            : null,
      },
    };
  }
}

export function parseNineFrame(line: string): NineReadings | null {
  const message = new NineSensorProtocol().parseLine(line);
  return message?.kind === 'frame' ? message.frame.readings : null;
}

type Group = {
  type: ActionType;
  ids: SensorId[];
};

const GROUPS: Group[] = [
  { type: 'front', ids: [0, 1, 2, 3, 4] },
  { type: 'back', ids: [5, 6, 7] },
  { type: 'cpr', ids: [8] },
];

type DetectorState = {
  active: boolean;
  peak: number;
  best: SensorId;
  pattern: NineReadings;
  patternEnergy: number;
  started: number;
  lastEnd: number;
  // Recent strongest-sensor signal for this group, for timing the rise.
  trace: TracePoint[];
  startedTrace: number;
  // Peak of the last hit that was reported, and the gap before this one,
  // for spotting plate bounces.
  lastPeak: number;
  gapBefore: number;
};

type TracePoint = { t: number; v: number };

// Firmware sends a frame every 20 ms.
const FRAME_MS = 20;
// How much signal history to keep before a hit starts.
const TRACE_LEAD_MS = 1000;
// A plate rebounding after a hard hit registers as a small, sharp second
// hit. Drop a hit that starts this soon after the last one ended and peaks
// below this fraction of it.
const REBOUND_MS = 500;
const REBOUND_PEAK_FRACTION = 0.5;

// Wobble allowed while walking back down the rise, as a fraction of the
// peak, so sensor noise on a slow push doesn't cut the rise short.
const RISE_NOISE = 0.05;

// Time at which the signal rose through `level`, searching back from the
// peak no further than the trough. Interpolated between frames; long gaps
// (demo mode, dropped frames) count as one frame so they don't read as slow.
function crossing(trace: TracePoint[], peakIndex: number, troughIndex: number, level: number): number {
  let index = peakIndex;

  while (index > troughIndex && trace[index - 1].v >= level) {
    index -= 1;
  }

  const current = trace[index];
  const previous = index > troughIndex
    ? trace[index - 1]
    : { t: current.t - FRAME_MS, v: trace[troughIndex].v };
  const previousTime = current.t - previous.t > 3 * FRAME_MS ? current.t - FRAME_MS : previous.t;
  const fraction = (level - previous.v) / Math.max(1e-9, current.v - previous.v);

  return previousTime + Math.min(1, Math.max(0, fraction)) * (current.t - previousTime);
}

function sharpness(trace: TracePoint[]): { riseMs: number | null; contactMs: number | null } {
  if (!trace.length) {
    return { riseMs: null, contactMs: null };
  }

  let peakIndex = 0;

  trace.forEach((point, index) => {
    if (point.v > trace[peakIndex].v) {
      peakIndex = index;
    }
  });

  const peak = trace[peakIndex].v;

  // The rise starts at the low point just before the peak. Measuring from
  // there, not from zero, keeps plate preload, ringing after the previous
  // hit, or a missing baseline from stretching the rise backwards.
  let troughIndex = peakIndex;

  while (troughIndex > 0 && trace[troughIndex - 1].v <= trace[troughIndex].v + RISE_NOISE * peak) {
    troughIndex -= 1;
  }

  // Noise tolerance can walk onto a plateau; settle on its lowest point.
  for (let index = troughIndex; index < peakIndex; index++) {
    if (trace[index].v < trace[troughIndex].v) {
      troughIndex = index;
    }
  }

  const floor = trace[troughIndex].v;
  const span = peak - floor;

  if (span <= 0) {
    return { riseMs: null, contactMs: null };
  }

  const start = crossing(trace, peakIndex, troughIndex, floor + 0.1 * span);
  const riseMs = Math.round(crossing(trace, peakIndex, troughIndex, floor + 0.9 * span) - start);
  const contactMs = Math.round(trace[trace.length - 1].t - start);

  return { riseMs: Math.max(0, riseMs), contactMs: Math.max(0, contactMs) };
}

function initialStates(): DetectorState[] {
  return GROUPS.map(group => ({
    active: false,
    peak: 0,
    best: group.ids[0],
    pattern: emptyReadings(),
    patternEnergy: 0,
    started: 0,
    lastEnd: -Infinity,
    trace: [],
    startedTrace: 0,
    lastPeak: 0,
    gapBefore: Infinity,
  }));
}

export class NineSensorDetector {
  private states = initialStates();

  reset(): void {
    this.states = initialStates();
  }

  process(
    values: NineReadings,
    baseline: NineReadings,
    time: number,
    contactDelta = RAW_THRESHOLD,
    peaks: NineReadings = values,
    // ESP32 millis() for this frame. Preferred for timing: several frames
    // often arrive in one serial read, so arrival times bunch together.
    deviceTime: number | null = null,
  ): DetectedAction[] {
    const events: DetectedAction[] = [];
    const threshold = Math.max(1, contactDelta);
    const releaseThreshold = Math.max(30, threshold * 0.38);

    GROUPS.forEach((group, index) => {
      const state = this.states[index];

      const ranked = group.ids
        .map(id => ({
          id,
          peak: Math.max(0, peaks[id] - baseline[id]),
          live: Math.max(0, values[id] - baseline[id]),
        }))
        .sort((a, b) => b.peak - a.peak);

      const strongest = ranked[0];
      const liveMax = Math.max(...ranked.map(item => item.live));
      const traceTime = deviceTime ?? time;

      state.trace.push({ t: traceTime, v: strongest.peak });

      // Keep a short lead-in before the hit, and the whole hit while it lasts.
      const traceStart = (state.active ? state.startedTrace : traceTime) - TRACE_LEAD_MS;
      while (state.trace.length && state.trace[0].t < traceStart) {
        state.trace.shift();
      }
      const snapshot = emptyReadings();
      let snapshotEnergy = 0;

      for (const id of group.ids) {
        snapshot[id] = Math.max(values[id], peaks[id]);
        snapshotEnergy += Math.max(0, snapshot[id] - baseline[id]);
      }

      if (!state.active) {
        if (
          strongest.peak >= threshold &&
          time - state.lastEnd >= 200
        ) {
          state.active = true;
          state.peak = strongest.peak;
          state.best = strongest.id;
          state.pattern = snapshot;
          state.patternEnergy = snapshotEnergy;
          state.gapBefore = time - state.lastEnd;
          state.started = time;
          state.startedTrace = traceTime;
        }

        return;
      }

      if (snapshotEnergy > state.patternEnergy) {
        state.pattern = snapshot;
        state.patternEnergy = snapshotEnergy;
      }

      if (strongest.peak > state.peak) {
        state.peak = strongest.peak;
        state.best = strongest.id;
      }

      if (liveMax <= releaseThreshold) {
        const rebound = state.gapBefore < REBOUND_MS &&
          state.peak < state.lastPeak * REBOUND_PEAK_FRACTION;

        if (rebound) {
          // Not reported, and lastPeak stays the real hit's so a chain of
          // bounces is all dropped.
          console.debug(`[sensors] ignored ${group.type} rebound: peak ${state.peak} vs ${state.lastPeak}, ${Math.round(state.gapBefore)} ms after`);
          state.active = false;
          state.lastEnd = time;
          state.peak = 0;
          state.patternEnergy = 0;
          return;
        }

        events.push({
          type: group.type,
          sensor: group.ids.reduce((best, id) =>
            state.pattern[id] - baseline[id] > state.pattern[best] - baseline[best]
              ? id
              : best,
          group.ids[0]),
          peak: state.peak,
          time,
          durationMs: Math.max(0, time - state.started),
          ...sharpness(state.trace),
          bothCpr: false,
          pattern: [...state.pattern] as NineReadings,
        });

        state.active = false;
        state.lastEnd = time;
        state.lastPeak = state.peak;
        state.peak = 0;
        state.patternEnergy = 0;
      }
    });

    return events;
  }
}
