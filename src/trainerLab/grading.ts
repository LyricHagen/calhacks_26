// Scoring for the effective-cough and unresponsive/CPR scenarios. Pure
// functions over timings the trainer records, so they can be checked
// without a browser. Like the rest of the trainer, these grade contact,
// timing and sequence only: never force, compression depth or whether the
// airway cleared.

export type Grade = 'Excellent' | 'Good' | 'Needs work';

export type ScenarioResult = {
  score: number;
  grade: Grade;
  // Scored parts, in display order.
  parts: { label: string; value: string; good: boolean }[];
  notes: string[];
};

function grade(score: number): Grade {
  return score >= 85 ? 'Excellent' : score >= 65 ? 'Good' : 'Needs work';
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// ---------- Effective cough ----------

export const COUGH_SETTINGS = {
  // Hands-off time needed before the scripted cough failure. Restarts on contact.
  observeMs: 15000,
  // Time from the cough failing to the first back blow. Training targets, not AHA figures.
  quickResponseMs: 5000,
  slowResponseMs: 15000,
  // Points lost per contact while the cough was still effective.
  interventionPenalty: 15,
  // Points lost per wrong first action (thrusts or CPR before back blows).
  wrongActionPenalty: 8,
} as const;

export type CoughAttempt = {
  // Contacts made while the cough was effective.
  interventions: number;
  // Thrusts or chest contacts after the cough failed, before the first good back blow.
  wrongActions: number;
  // From the cough failing to the first accepted back blow.
  responseMs: number;
};

export function gradeCough({ interventions, wrongActions, responseMs }: CoughAttempt): ScenarioResult {
  const { quickResponseMs, slowResponseMs } = COUGH_SETTINGS;
  const restraint = Math.max(0, 50 - interventions * COUGH_SETTINGS.interventionPenalty);
  const response = 35 * (1 - clamp01((responseMs - quickResponseMs) / (slowResponseMs - quickResponseMs)));
  const action = Math.max(0, 15 - wrongActions * COUGH_SETTINGS.wrongActionPenalty);
  const score = Math.round(restraint + response + action);
  const seconds = (responseMs / 1000).toFixed(1);
  const notes: string[] = [];

  if (interventions) {
    notes.push(`You touched the mannequin ${interventions} time${interventions === 1 ? '' : 's'} while the cough was still effective. A strong cough is the best way to clear the airway: encourage it and watch.`);
  }
  if (responseMs > quickResponseMs) {
    notes.push(`Back blows started ${seconds} s after the cough failed. Once they can't cough, speak or breathe, act straight away.`);
  }
  if (wrongActions) {
    notes.push('Start with back blows. Abdominal thrusts come after 5 back blows, and CPR only if they become unresponsive.');
  }
  if (!notes.length) {
    notes.push('You held back while the cough worked and started back blows as soon as it failed.');
  }

  return {
    score,
    grade: grade(score),
    parts: [
      { label: 'Hands off while coughing', value: interventions ? `${interventions} contact${interventions === 1 ? '' : 's'}` : 'Yes', good: interventions === 0 },
      { label: 'Response to failing cough', value: `${seconds} s`, good: responseMs <= quickResponseMs },
      { label: 'Correct first action', value: wrongActions ? `${wrongActions} wrong` : 'Back blow', good: wrongActions === 0 },
    ],
    notes,
  };
}

// ---------- CPR compressions ----------

export const CPR_SETTINGS = {
  // AHA adult compression rate, per minute.
  minRate: 100,
  maxRate: 120,
  // Compressions per cycle before the pause for two breaths (30:2).
  cycleLength: 30,
  // A gap this long inside a cycle is an interruption, not a slow compression.
  pauseMs: 2000,
  // AHA: keep pauses in compressions, including for breaths, under 10 s.
  maxBreakMs: 10000,
  // Full recoil: between compressions the sternum signal must fall to this
  // fraction of the previous compression's peak (above baseline). Must sit
  // well under the detector's release level (~250 ADC at the default
  // threshold) or partial leaning passes. Provisional until leaning is
  // measured on the mannequin.
  recoilFraction: 0.05,
  // Pressure held above the release level this long means they are leaning
  // and compressions have stopped registering.
  leanMs: 1500,
  // Intervals used for the live rate.
  rateWindow: 5,
  // A press only counts as a compression if the sternum peaks at least this
  // far above rest (ADC, ≈ 9 N on the FSR 402 curve). The contact threshold
  // alone (~0.4 N) lets a light touch count. Real compressions are far beyond
  // the FSR's range; this only separates a firm push from a tap.
  minPeakAdc: 2600,
} as const;

export type CprCompression = {
  // Start of the previous compression to the start of this one. Null for
  // the first compression in a cycle or after an interruption.
  intervalMs: number | null;
  // Did the chest come back up before this compression? Null when unknown
  // (first in a cycle).
  recoilOk: boolean | null;
};

export function compressionRate(intervalMs: number): number {
  return 60000 / intervalMs;
}

export function rateInRange(rate: number): boolean {
  return rate >= CPR_SETTINGS.minRate && rate <= CPR_SETTINGS.maxRate;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median rate over the last few intervals; median so one stray beat doesn't swing it.
export function liveRate(compressions: CprCompression[]): number | null {
  const intervals = compressions
    .map(item => item.intervalMs)
    .filter((ms): ms is number => ms !== null)
    .slice(-CPR_SETTINGS.rateWindow);

  return intervals.length >= 2 ? compressionRate(median(intervals)) : null;
}

export type CprCycle = {
  compressions: CprCompression[];
  // Contacts off the sternum during this cycle.
  offTarget: number;
  // Interruptions longer than pauseMs inside the cycle.
  pauses: number;
  // Hands-off time between the previous cycle and this one; null for the first.
  breakMs: number | null;
};

export function gradeCprCycle({ compressions, offTarget, pauses, breakMs }: CprCycle): ScenarioResult {
  const intervals = compressions
    .map(item => item.intervalMs)
    .filter((ms): ms is number => ms !== null);
  const rates = intervals.map(compressionRate);
  const inRate = rates.filter(rateInRange).length;
  const recoilKnown = compressions.filter(item => item.recoilOk !== null);
  const recoilGood = recoilKnown.filter(item => item.recoilOk).length;
  const rateFraction = rates.length ? inRate / rates.length : 0;
  const recoilFraction = recoilKnown.length ? recoilGood / recoilKnown.length : 1;
  const placementFraction = compressions.length / Math.max(1, compressions.length + offTarget);
  const longBreak = breakMs !== null && breakMs > CPR_SETTINGS.maxBreakMs;
  const continuity = clamp01(1 - pauses * 0.5 - (longBreak ? 0.5 : 0));
  const score = Math.round(50 * rateFraction + 25 * recoilFraction + 15 * placementFraction + 10 * continuity);
  const rate = rates.length ? compressionRate(median(intervals)) : null;
  const notes: string[] = [];

  if (rate !== null && rate < CPR_SETTINGS.minRate) {
    notes.push(`Typical rate was ${Math.round(rate)} per minute. Push faster: aim for 100 to 120.`);
  } else if (rate !== null && rate > CPR_SETTINGS.maxRate) {
    notes.push(`Typical rate was ${Math.round(rate)} per minute. Slow down a little: aim for 100 to 120.`);
  } else if (rates.length && rateFraction < 0.8) {
    notes.push('Your average was on target, but the rhythm drifted. Keep a steady beat.');
  }
  if (recoilFraction < 0.8) {
    notes.push('Let the chest come all the way back up between compressions. Leaning stops the heart refilling.');
  }
  if (offTarget) {
    notes.push(`${offTarget} contact${offTarget === 1 ? '' : 's'} missed the sternum. Keep the heel of your hand on the centre of the chest.`);
  }
  if (pauses) {
    notes.push(`Compressions stopped ${pauses} time${pauses === 1 ? '' : 's'} mid-cycle. Keep going without breaks until the 30 are done.`);
  }
  if (longBreak) {
    notes.push(`The pause before this cycle was ${Math.round(breakMs / 1000)} s. Keep breaks for breaths under 10 seconds.`);
  }
  if (!notes.length) {
    notes.push('Steady rate, full recoil and on target. Keep it up.');
  }

  return {
    score,
    grade: grade(score),
    parts: [
      { label: 'Rate 100–120/min', value: rate === null ? '—' : `${Math.round(rate)}/min · ${Math.round(rateFraction * 100)}% in range`, good: rateFraction >= 0.8 },
      { label: 'Full recoil', value: `${Math.round(recoilFraction * 100)}%`, good: recoilFraction >= 0.8 },
      { label: 'On the sternum', value: `${Math.round(placementFraction * 100)}%`, good: offTarget === 0 },
      { label: 'No interruptions', value: pauses || longBreak ? `${pauses + (longBreak ? 1 : 0)} pause${pauses + (longBreak ? 1 : 0) === 1 ? '' : 's'}` : 'Yes', good: !pauses && !longBreak },
    ],
    notes,
  };
}
