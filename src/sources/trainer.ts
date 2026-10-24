// Host-side stand-in for the trainer's state machine. The firmware sends raw
// readings only (see protocol.md); the judge was written for a device that also
// reports phase, cycle, back blow count and angle, with fist force in units of
// the instructor reference. This model supplies all of that from the raw
// readings, so judge.ts and the pages work unchanged. It sets baselines and the
// reference scale and moves through the phases; it never judges an event.

import { log } from '../debug';
import { PADS, THRESHOLDS, type DeviceState, type Pads, type Phase, type RawFrame } from '../judge';

/** Cycles of 5 back blows and 5 thrusts before the session is complete (the recording has 4). */
export const CYCLES = 4;

export const REST_FRAMES = 30;     // 3 s at 10 Hz of steady readings set the baseline
export const REST_MOVE = 0.08;     // raw fist this far from the running mean restarts the rest
const PUSH_FLOOR = 0.04;    // raw rise above baseline that starts the first reference push
const NOISE_MULT = 5;       // ... or this many rest standard deviations, whichever is larger
const MIN_REF_RAW = 0.08;   // a first push peaking below this raw rise is noise, not a reference
const HOLD_MAX_S = 3;       // longest the first reference is held back before it is released anyway
const G = 9.81;             // m/s^2
const BLOW_SPIKE = 12;      // m/s^2 away from 1 g counts as a wrist spike
const BLOW_GAP_S = 0.4;     // shortest time between two back blows
const GRAVITY_ALPHA = 0.2;  // smoothing of the gravity estimate used for the angle

/** One validated reading from the device, time already in continuous seconds. */
export interface Reading {
  t: number;
  fist: number;
  pads: Pads;
  acc: [number, number, number] | null;
}

type Baseline = { fist: number } & Pads;

const zeroPads = (): Pads => ({ target: 0, high: 0, low: 0, side: 0, back: 0 });
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function createTrainerModel() {
  const T = THRESHOLDS;
  const C = log.calib;
  const L = log.serial;

  let phase: Phase = 'rest';
  let cycle = 0;
  let blowsTotal = 0;
  let thrustsTotal = 0;
  let pending: (() => void) | null = null;  // phase change decided on the previous frame
  let completeSent = false;

  // Rest
  let restN = 0;
  let restSum = { fist: 0, ...zeroPads() };
  let restSq = 0;
  let restarts = 0;
  let base: Baseline | null = null;
  let noise = 0;

  // Reference scale: raw rise above baseline that equals 1.00
  let scale: number | null = null;
  const refRaw: number[] = [];
  let held: { readings: Reading[]; peak: number; t0: number } | null = null;

  // Push tracking in delivered units, the same rules the judge uses
  let open = false;
  let armed = true;
  let lastStart = -Infinity;
  let peakRaw = 0;
  let inPhase = 0;          // blows or thrusts counted in the current phase

  // Back blows and angle
  let lastBlow = -Infinity;
  let prevBack = 0;
  let gravity: [number, number, number] | null = null;
  let warnedNoImu = false;

  function schedule(fn: () => void) { pending = fn; }

  function device(angle: number | null): DeviceState {
    return { phase, cycle, backBlowCount: blowsTotal, thrustCount: thrustsTotal, angle };
  }

  function padsAbove(p: Pads, b: Pads): Pads {
    const out = zeroPads();
    for (const k of PADS) out[k] = r3(Math.max(0, p[k] - b[k]));
    return out;
  }

  // ---- rest ----------------------------------------------------------------
  function rest(r: Reading): RawFrame {
    if (restN > 0 && Math.abs(r.fist - restSum.fist / restN) > REST_MOVE) {
      restarts++;
      // Only worth a line when real progress was lost; a hand settling would flood the log.
      if (restN >= 5) C.info('Rest restarted: the fist moved, so the 3 s of steady readings start over', {
        fist: r.fist, running_mean: restSum.fist / restN, allowed_move: REST_MOVE, steady_frames_lost: restN, needed: REST_FRAMES,
      });
      restN = 0;
      restSum = { fist: 0, ...zeroPads() };
      restSq = 0;
    }
    restN++;
    restSum.fist += r.fist;
    restSq += r.fist * r.fist;
    for (const k of PADS) restSum[k] += r.pads[k];
    const mean = Object.fromEntries(Object.entries(restSum).map(([k, v]) => [k, v / restN])) as Baseline;

    if (restN >= REST_FRAMES) {
      base = mean;
      noise = Math.sqrt(Math.max(0, restSq / restN - mean.fist ** 2));
      C.info('Raw baseline set from 3 s of steady rest; everything after is measured as a rise above it', {
        fist_raw: mean.fist, fist_noise_sd: noise, push_starts_above: Math.max(PUSH_FLOOR, NOISE_MULT * noise),
        target: mean.target, high: mean.high, low: mean.low, side: mean.side, back: mean.back,
        rest_frames: restN, restarts,
      });
      schedule(() => { phase = 'calibrating'; });
    }
    return { t: r.t, fist: r3(Math.max(0, r.fist - mean.fist)), pads: padsAbove(r.pads, mean), acc: toAcc(r.acc), device: device(null) };
  }

  // ---- first reference: held back until its peak is known --------------------
  function firstReference(r: Reading, d: number, pads: Pads): RawFrame[] {
    const startAt = Math.max(PUSH_FLOOR, NOISE_MULT * noise);
    if (!held) {
      if (d <= startAt) return [{ t: r.t, fist: 0, pads, acc: toAcc(r.acc), device: device(null) }];
      held = { readings: [], peak: 0, t0: r.t };
      C.info('First reference push started; holding its frames until it ends so its peak can set the scale', { rise: d, starts_above: startAt });
    }
    held.readings.push(r);
    held.peak = Math.max(held.peak, d);
    const ended = d < T.thrustEnd * held.peak;
    const tooLong = r.t - held.t0 >= HOLD_MAX_S;
    if (!ended && !tooLong) return [];

    const h = held;
    held = null;
    if (h.peak < MIN_REF_RAW) {
      C.info('First push was too small to be a reference; still waiting for the instructor', { peak_rise: h.peak, needed: MIN_REF_RAW, frames: h.readings.length });
      return h.readings.map((x) => ({ t: x.t, fist: 0, pads: padsAbove(x.pads, base!), acc: toAcc(x.acc), device: device(null) }));
    }
    if (tooLong) C.warn('First reference was held for 3 s without a release; releasing it now, scaled by its peak so far', { peak_rise: h.peak, held_s: r.t - h.t0 });
    scale = h.peak;
    C.info('Provisional scale set from the first reference peak: R1 reads 1.00, R2 and R3 are read against it', {
      raw_peak_rise: h.peak, frames_released: h.readings.length,
    });
    return h.readings.map((x) => frame(x));
  }

  // ---- every frame after rest ------------------------------------------------
  function frame(r: Reading): RawFrame {
    const d = Math.max(0, r.fist - base!.fist);
    const x = d / scale!;
    const pads = padsAbove(r.pads, base!);

    // Pushes, by the judge's START, END and dead-time rules.
    const deadOk = (r.t - lastStart) * 1000 >= T.deadTimeMs - 1e-6;
    const startsNew = armed && x > T.thrustStart && deadOk;
    if (startsNew && open) pushEnded(false, r.t);
    if (open) {
      peakRaw = Math.max(peakRaw, d);
      if (x < T.thrustEnd) pushEnded(true, r.t);
      if (x < T.thrustStart) armed = true;
    }
    if (startsNew) { open = true; armed = false; lastStart = r.t; peakRaw = d; }

    // Angle: elevation of the IMU x axis while a push is in progress. Shown, never graded.
    let angle: number | null = null;
    if (open && gravity) {
      const m = Math.hypot(...gravity);
      if (m > 1) angle = Math.round((Math.asin(Math.max(-1, Math.min(1, gravity[0] / m))) * 180) / Math.PI);
    }

    if (phase === 'backblows') detectBlow(r, x, pads);
    prevBack = pads.back;
    return { t: r.t, fist: r3(x), pads, acc: toAcc(r.acc), device: device(angle) };
  }

  function pushEnded(released: boolean, t: number) {
    open = false;
    if (phase === 'calibrating') {
      refRaw.push(peakRaw);
      if (refRaw.length === 3) {
        scale = refRaw.reduce((a, b) => a + b, 0) / 3;
        C.info('Reference scale set: from now on 1.00 is the mean of the three instructor peaks', {
          raw_peaks: refRaw.map(r3), raw_mean: scale, released, t,
        });
        schedule(() => { phase = 'backblows'; cycle = 1; inPhase = 0; });
      }
    } else if (phase === 'thrusts') {
      thrustsTotal++;
      if (++inPhase === 5) {
        schedule(() => {
          inPhase = 0;
          if (cycle < CYCLES) { cycle++; phase = 'backblows'; } else phase = 'complete';
        });
      }
    }
  }

  function detectBlow(r: Reading, x: number, pads: Pads) {
    let why: Record<string, unknown>;
    if (r.acc) {
      const dev = Math.abs(Math.hypot(...r.acc) - G);
      if (dev <= BLOW_SPIKE) return;
      why = { acc_off_1g: dev, spike_above: BLOW_SPIKE };
    } else {
      if (!warnedNoImu) {
        warnedNoImu = true;
        L.warn('No accelerometer reading, so back blows are counted from the back pad rising above the on-target line; a blow that misses the pad cannot be seen', { back_pad_line: T.backOnTarget });
      }
      if (!(pads.back > T.backOnTarget && prevBack <= T.backOnTarget)) return;
      why = { back_pad: pads.back, back_pad_line: T.backOnTarget };
    }
    const gap = r.t - lastBlow;
    if (x >= T.thrustEnd) { L.info('Wrist spike ignored: the fist is pressed, so it is a push, not a back blow', { ...why, fist: r3(x), end: T.thrustEnd }); return; }
    if (gap < BLOW_GAP_S) { L.info('Wrist spike ignored: too soon after the previous back blow', { ...why, gap_ms: Math.round(gap * 1000), min_gap_ms: BLOW_GAP_S * 1000 }); return; }
    lastBlow = r.t;
    blowsTotal++;
    inPhase++;
    L.info(`Back blow ${inPhase} of 5 in cycle ${cycle}: wrist spike counted`, { ...why, counter: blowsTotal, t: r.t });
    if (inPhase === 5) schedule(() => { phase = 'thrusts'; inPhase = 0; });
  }

  function toAcc(a: Reading['acc']): RawFrame['acc'] {
    return a ? { x: a[0], y: a[1], z: a[2] } : null;
  }

  return {
    /** Takes one reading, returns the frames to hand to the judge now (none while the first reference is held). */
    push(r: Reading): RawFrame[] {
      if (pending) { const p = pending; pending = null; p(); }
      if (r.acc) gravity = gravity ? gravity.map((g, i) => g + GRAVITY_ALPHA * (r.acc![i] - g)) as [number, number, number] : [...r.acc];
      if (phase === 'complete') {
        if (completeSent) return [];
        completeSent = true;
      }
      if (phase === 'rest' || !base) return [rest(r)];
      if (scale == null) return firstReference(r, Math.max(0, r.fist - base.fist), padsAbove(r.pads, base));
      return [frame(r)];
    },
    phase: () => phase,
    complete: () => phase === 'complete' && completeSent,
    /** Raw rest baseline, null until rest ends. */
    baseline: (): Baseline | null => (base ? { ...base } : null),
    scale: () => scale,
  };
}

export type TrainerModel = ReturnType<typeof createTrainerModel>;
