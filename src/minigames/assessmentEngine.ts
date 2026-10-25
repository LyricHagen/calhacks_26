/**
 * Rhythm assessment is a coordination game, not a clinical force or timing standard.
 * Every note is one separate, brief contact; never require sustained force.
 */
import type { NineReadings } from '../trainerLab/sensors';
import { CPR_SETTINGS } from '../trainerLab/grading';

export type AssessmentRegion = 'back' | 'front';
export type ContactRegion = AssessmentRegion | 'cpr';
export type AssessmentMode = 'choking' | 'cpr';
export type Verdict = 'perfect' | 'good' | 'okay' | 'wrong-area' | 'wrong-duration' | 'too-light' | 'miss';
export type AssessmentNote = {
  id: number;
  region: ContactRegion;
  atMs: number;
  targetDurationMs: number;
  verdict?: Verdict;
  timingErrorMs?: number;
  contactDurationMs?: number;
};
export type AssessmentState = {
  notes: AssessmentNote[];
  score: number;
  combo: number;
  maxCombo: number;
  feedback: string;
  feedbackDetail: string;
  feedbackId: number;
};
export type AssessedContact = {
  startedMs: number;
  endedMs: number;
  durationMs: number;
  region: ContactRegion;
  pattern: NineReadings;
  // Strongest reading above rest in the contacted region, at its peak frame.
  peak: number;
};
export type PlacementCheck = { score: number; uncertainty: 'narrow' | 'moderate' | 'broad' } | null;

// Intentionally configurable game parameters, not recommended medical intervals.
export const ASSESSMENT_SETTINGS = {
  firstNoteMs: 2800,
  noteGapMs: 1450,
  hitWindowMs: 300,
  perfectMs: 85,
  goodMs: 175,
  backTargetMs: 260,
  frontTargetMs: 330,
  backMinMs: 120,
  backMaxMs: 460,
  frontMinMs: 150,
  frontMaxMs: 550,
  releaseDebounceMs: 55,
  minimumTapGapMs: 140,
  travelMs: 1800,
  // Extra pause before the first thrust, on top of noteGapMs, so the trainee
  // can move from the back to the front of the mannequin.
  switchGapMs: 4000,
  // Hide the "moving to thrusts" banner this long before the first thrust,
  // so its bar is visible as it approaches the hit line.
  switchBannerLeadMs: 1300,
} as const;

// CPR chart: one chest lane at 110 a minute. Notes are 545 ms apart, so the
// hit window is narrower than the choking game's to keep neighbours distinct.
export const CPR_ASSESSMENT_SETTINGS = {
  compressions: 30,
  noteGapMs: 545,
  targetMs: 250,
  minMs: 80,
  maxMs: 450,
  hitWindowMs: 200,
  perfectMs: 60,
  goodMs: 120,
} as const;

export function windowsFor(region: ContactRegion) {
  if (region === 'cpr') return CPR_ASSESSMENT_SETTINGS;
  const { hitWindowMs, perfectMs, goodMs } = ASSESSMENT_SETTINGS;
  return region === 'back'
    ? { hitWindowMs, perfectMs, goodMs, minMs: ASSESSMENT_SETTINGS.backMinMs, maxMs: ASSESSMENT_SETTINGS.backMaxMs }
    : { hitWindowMs, perfectMs, goodMs, minMs: ASSESSMENT_SETTINGS.frontMinMs, maxMs: ASSESSMENT_SETTINGS.frontMaxMs };
}

export function noteLabel(note: AssessmentNote): string {
  if (note.region === 'cpr') return `Compression ${note.id + 1}`;
  return note.region === 'back' ? `Back blow ${note.id + 1}` : `Abdominal thrust ${note.id - 4}`;
}

export function newAssessment(mode: AssessmentMode = 'choking'): AssessmentState {
  if (mode === 'cpr') {
    const notes = Array.from({ length: CPR_ASSESSMENT_SETTINGS.compressions }, (_, id): AssessmentNote => ({
      id,
      region: 'cpr',
      atMs: ASSESSMENT_SETTINGS.firstNoteMs + id * CPR_ASSESSMENT_SETTINGS.noteGapMs,
      targetDurationMs: CPR_ASSESSMENT_SETTINGS.targetMs,
    }));
    return { notes, score: 0, combo: 0, maxCombo: 0, feedback: 'Ready to assess', feedbackDetail: 'Thirty chest compressions at 110 a minute.', feedbackId: 0 };
  }
  const notes = Array.from({ length: 10 }, (_, id): AssessmentNote => ({
    id,
    region: id < 5 ? 'back' : 'front',
    atMs: ASSESSMENT_SETTINGS.firstNoteMs + id * ASSESSMENT_SETTINGS.noteGapMs + (id < 5 ? 0 : ASSESSMENT_SETTINGS.switchGapMs),
    targetDurationMs: id < 5 ? ASSESSMENT_SETTINGS.backTargetMs : ASSESSMENT_SETTINGS.frontTargetMs,
  }));
  return { notes, score: 0, combo: 0, maxCombo: 0, feedback: 'Ready to assess', feedbackDetail: 'Five back blows, then five abdominal thrusts.', feedbackId: 0 };
}

/** The mannequin side to show; CPR compressions are on the front. */
export function nextAssessmentRegion(state: AssessmentState): AssessmentRegion {
  const region = state.notes.find(note => !note.verdict)?.region ?? 'front';
  return region === 'cpr' ? 'front' : region;
}

export function assessmentAccuracy(state: AssessmentState): number {
  const judged = state.notes.filter(note => note.verdict);
  if (!judged.length) return 0;
  const points = { perfect: 1, good: .75, okay: .45, 'wrong-area': 0, 'wrong-duration': 0, 'too-light': 0, miss: 0 };
  return Math.round(judged.reduce((sum, note) => sum + points[note.verdict!], 0) * 100 / judged.length);
}

export function isAssessmentDone(state: AssessmentState): boolean {
  return state.notes.every(note => note.verdict !== undefined);
}

export function applyVerdict(state: AssessmentState, id: number, verdict: Verdict, detail: string, contact?: AssessedContact): AssessmentState {
  if (state.notes[id]?.verdict) return state;
  const success = verdict === 'perfect' || verdict === 'good' || verdict === 'okay';
  const combo = success ? state.combo + 1 : 0;
  const base = verdict === 'perfect' ? 300 : verdict === 'good' ? 180 : verdict === 'okay' ? 90 : 0;
  const score = state.score + Math.round(base * (1 + Math.min(1, state.combo * 0.1)));
  const note = state.notes[id];
  return {
    ...state,
    notes: state.notes.map(n => n.id === id ? {
      ...n, verdict,
      timingErrorMs: contact ? contact.startedMs - note.atMs : undefined,
      contactDurationMs: contact?.durationMs,
    } : n),
    score,
    combo,
    maxCombo: Math.max(state.maxCombo, combo),
    feedback: verdict === 'wrong-area' ? 'WRONG AREA' : verdict === 'wrong-duration' ? 'DURATION' : verdict === 'too-light' ? 'TOO LIGHT' : verdict.toUpperCase(),
    feedbackDetail: detail,
    feedbackId: state.feedbackId + 1,
  };
}

/** Match at onset, not release. Spatial placement is evaluated on the coherent peak frame. */
export function judgeAssessmentContact(
  state: AssessmentState,
  contact: AssessedContact,
  placement: PlacementCheck,
  acceptanceScore: number,
): AssessmentState {
  const closest = state.notes
    .filter(note => !note.verdict && Math.abs(note.atMs - contact.startedMs) <= windowsFor(note.region).hitWindowMs)
    .sort((a, b) => Math.abs(a.atMs - contact.startedMs) - Math.abs(b.atMs - contact.startedMs))[0];

  if (!closest) {
    return { ...state, combo: 0, feedback: 'OFF BEAT', feedbackDetail: 'Start the next contact when its bar reaches the line.', feedbackId: state.feedbackId + 1 };
  }
  // The sternum has one sensor, so a CPR contact only needs to land on it.
  const placed = closest.region === 'cpr'
    ? contact.region === 'cpr'
    : contact.region === closest.region && !!placement && placement.uncertainty !== 'broad' && placement.score >= acceptanceScore;
  if (!placed) {
    return applyVerdict(state, closest.id, 'wrong-area', 'Contact did not match the target region or placement was uncertain.', contact);
  }
  // Same bar as Practice: a light touch on the sternum isn't a compression.
  if (closest.region === 'cpr' && contact.peak < CPR_SETTINGS.minPeakAdc) {
    return applyVerdict(state, closest.id, 'too-light', `Peaked ${Math.round(contact.peak)} above rest; a compression needs ${CPR_SETTINGS.minPeakAdc}. Push harder.`, contact);
  }
  const { minMs: min, maxMs: max, perfectMs, goodMs } = windowsFor(closest.region);
  if (contact.durationMs < min || contact.durationMs > max) {
    return applyVerdict(state, closest.id, 'wrong-duration', `Contact lasted ${Math.round(contact.durationMs)} ms; the game window is ${min}–${max} ms.`, contact);
  }
  const diff = Math.abs(closest.atMs - contact.startedMs);
  const verdict: Verdict = diff <= perfectMs ? 'perfect' : diff <= goodMs ? 'good' : 'okay';
  const where = placement ? ` · placement ${Math.round(placement.score)}/100` : '';
  return applyVerdict(state, closest.id, verdict, `${Math.round(diff)} ms from the beat · ${Math.round(contact.durationMs)} ms contact${where}.`, contact);
}

/** Don't expire the note currently being held: it is scored on release. */
export function expireAssessmentNotes(state: AssessmentState, elapsedMs: number, heldStartMs: number | null): AssessmentState {
  let result = state;
  for (const note of state.notes) {
    const { hitWindowMs } = windowsFor(note.region);
    if (note.verdict || elapsedMs <= note.atMs + hitWindowMs) continue;
    if (heldStartMs !== null && Math.abs(note.atMs - heldStartMs) <= hitWindowMs) continue;
    result = applyVerdict(result, note.id, 'miss', `Missed ${noteLabel(note).toLowerCase()}.`);
  }
  return result;
}

/** One whole-body contact, even when several FSRs respond to the same hand. */
export class AssessmentContactDetector {
  private started: number | null = null;
  private releaseStart: number | null = null;
  private nextAllowed = -Infinity;
  private strongestEnergy = -1;
  private bestPattern: NineReadings | null = null;

  reset(): void {
    this.started = null;
    this.releaseStart = null;
    this.nextAllowed = -Infinity;
    this.strongestEnergy = -1;
    this.bestPattern = null;
  }

  get heldStart(): number | null { return this.started; }

  process(readings: NineReadings, baseline: NineReadings, threshold: number, nowMs: number): AssessedContact | null {
    const corrected = readings.map((value, i) => Math.max(0, value - baseline[i]));
    const max = Math.max(...corrected);
    if (this.started === null) {
      if (nowMs < this.nextAllowed || max < threshold) return null;
      this.started = nowMs;
      this.strongestEnergy = -1;
    }
    const energy = corrected.reduce((sum, value) => sum + value * value, 0);
    if (energy > this.strongestEnergy) {
      this.strongestEnergy = energy;
      this.bestPattern = [...readings] as NineReadings;
    }
    if (max > Math.max(80, threshold * 0.35)) {
      this.releaseStart = null;
      return null;
    }
    if (this.releaseStart === null) this.releaseStart = nowMs;
    if (nowMs - this.releaseStart < ASSESSMENT_SETTINGS.releaseDebounceMs) return null;
    const endedMs = this.releaseStart;
    const startedMs = this.started;
    const pattern = this.bestPattern ?? readings;
    this.started = null;
    this.releaseStart = null;
    this.bestPattern = null;
    this.strongestEnergy = -1;
    this.nextAllowed = nowMs + ASSESSMENT_SETTINGS.minimumTapGapMs;
    const relative = pattern.map((value, i) => Math.max(0, value - baseline[i]));
    const front = Math.max(...relative.slice(0, 5));
    const back = Math.max(...relative.slice(5, 8));
    const cpr = relative[8];
    const region: ContactRegion = cpr > Math.max(front, back) ? 'cpr' : back > front ? 'back' : 'front';
    const peak = region === 'cpr' ? cpr : region === 'back' ? back : front;
    return { startedMs, endedMs, durationMs: Math.max(0, endedMs - startedMs), region, pattern, peak };
  }
}
