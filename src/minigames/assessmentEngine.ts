/**
 * Rhythm assessment is a coordination game, not a clinical force or timing standard.
 * Every note is one separate, brief contact; never require sustained force.
 */
import type { NineReadings } from '../trainerLab/sensors';

export type AssessmentRegion = 'back' | 'front';
export type ContactRegion = AssessmentRegion | 'cpr';
export type Verdict = 'perfect' | 'good' | 'okay' | 'wrong-area' | 'wrong-duration' | 'miss';
export type AssessmentNote = {
  id: number;
  region: AssessmentRegion;
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

export function newAssessment(): AssessmentState {
  const notes = Array.from({ length: 10 }, (_, id): AssessmentNote => ({
    id,
    region: id < 5 ? 'back' : 'front',
    atMs: ASSESSMENT_SETTINGS.firstNoteMs + id * ASSESSMENT_SETTINGS.noteGapMs + (id < 5 ? 0 : ASSESSMENT_SETTINGS.switchGapMs),
    targetDurationMs: id < 5 ? ASSESSMENT_SETTINGS.backTargetMs : ASSESSMENT_SETTINGS.frontTargetMs,
  }));
  return { notes, score: 0, combo: 0, maxCombo: 0, feedback: 'Ready to assess', feedbackDetail: 'Five back blows, then five abdominal thrusts.', feedbackId: 0 };
}

export function nextAssessmentRegion(state: AssessmentState): AssessmentRegion {
  return state.notes.find(note => !note.verdict)?.region ?? 'front';
}

export function assessmentAccuracy(state: AssessmentState): number {
  const judged = state.notes.filter(note => note.verdict);
  if (!judged.length) return 0;
  const points = { perfect: 1, good: .75, okay: .45, 'wrong-area': 0, 'wrong-duration': 0, miss: 0 };
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
    feedback: verdict === 'wrong-area' ? 'WRONG AREA' : verdict === 'wrong-duration' ? 'DURATION' : verdict.toUpperCase(),
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
    .filter(note => !note.verdict && Math.abs(note.atMs - contact.startedMs) <= ASSESSMENT_SETTINGS.hitWindowMs)
    .sort((a, b) => Math.abs(a.atMs - contact.startedMs) - Math.abs(b.atMs - contact.startedMs))[0];

  if (!closest) {
    return { ...state, combo: 0, feedback: 'OFF BEAT', feedbackDetail: 'Start the next contact when its bar reaches the line.', feedbackId: state.feedbackId + 1 };
  }
  if (contact.region !== closest.region || !placement || placement.uncertainty === 'broad' || placement.score < acceptanceScore) {
    return applyVerdict(state, closest.id, 'wrong-area', 'Contact did not match the target region or placement was uncertain.', contact);
  }
  const min = closest.region === 'back' ? ASSESSMENT_SETTINGS.backMinMs : ASSESSMENT_SETTINGS.frontMinMs;
  const max = closest.region === 'back' ? ASSESSMENT_SETTINGS.backMaxMs : ASSESSMENT_SETTINGS.frontMaxMs;
  if (contact.durationMs < min || contact.durationMs > max) {
    return applyVerdict(state, closest.id, 'wrong-duration', `Contact lasted ${Math.round(contact.durationMs)} ms; the game window is ${min}–${max} ms.`, contact);
  }
  const diff = Math.abs(closest.atMs - contact.startedMs);
  const verdict: Verdict = diff <= ASSESSMENT_SETTINGS.perfectMs ? 'perfect' : diff <= ASSESSMENT_SETTINGS.goodMs ? 'good' : 'okay';
  return applyVerdict(state, closest.id, verdict, `${Math.round(diff)} ms from the beat · ${Math.round(contact.durationMs)} ms contact · placement ${Math.round(placement.score)}/100.`, contact);
}

/** Don't expire the note currently being held: it is scored on release. */
export function expireAssessmentNotes(state: AssessmentState, elapsedMs: number, heldStartMs: number | null): AssessmentState {
  let result = state;
  for (const note of state.notes) {
    if (note.verdict || elapsedMs <= note.atMs + ASSESSMENT_SETTINGS.hitWindowMs) continue;
    if (heldStartMs !== null && Math.abs(note.atMs - heldStartMs) <= ASSESSMENT_SETTINGS.hitWindowMs) continue;
    result = applyVerdict(result, note.id, 'miss', `Missed ${note.region === 'back' ? 'back blow' : 'abdominal thrust'} ${note.id < 5 ? note.id + 1 : note.id - 4}.`);
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
    return { startedMs, endedMs, durationMs: Math.max(0, endedMs - startedMs), region, pattern };
  }
}
