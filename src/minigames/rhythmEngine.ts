import type { NineReadings, SensorId } from '../trainerLab/sensors';

// Physical FSR indices, NOT GPIO pins. The firmware/channel mapping is unchanged.
export const LANES = [
  { name: 'LEFT', label: 'Left', sensor: 3 as SensorId, key: 'a', colour: '#af9df6' },
  { name: 'HIGH', label: 'Upper', sensor: 1 as SensorId, key: 's', colour: '#88cbec' },
  { name: 'CENTRE', label: 'Centre', sensor: 0 as SensorId, key: 'd', colour: '#65d6b2' },
  { name: 'LOW', label: 'Lower', sensor: 2 as SensorId, key: 'f', colour: '#f4ca77' },
  { name: 'RIGHT', label: 'Right', sensor: 4 as SensorId, key: 'g', colour: '#f0a0ab' },
] as const;

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Judgement = 'perfect' | 'good' | 'okay' | 'wrong' | 'miss';
export type Note = { id: number; lane: number; timeMs: number; judgement?: Judgement };
export type Game = {
  notes: Note[];
  score: number;
  combo: number;
  bestCombo: number;
  perfect: number;
  good: number;
  okay: number;
  wrong: number;
  miss: number;
  feedback: string;
};

export const FIRST_BEAT_MS = 2000;
export const SONG_LENGTH_MS = 30000;
export const HIT_WINDOW_MS = 220;
export const TRAVEL_MS = 1650;

export const LEVELS: Record<Difficulty, { bpm: number; lanes: number[]; label: string }> = {
  easy: { bpm: 78, lanes: [0, 2, 4], label: 'Three lanes · 78 BPM' },
  normal: { bpm: 105, lanes: [0, 1, 2, 3, 4], label: 'Five lanes · 105 BPM' },
  hard: { bpm: 138, lanes: [0, 1, 2, 3, 4], label: 'Five lanes · 138 BPM' },
};

export function createGame(difficulty: Difficulty): Game {
  const { bpm, lanes } = LEVELS[difficulty];
  const beatMs = 60000 / bpm;
  const notes: Note[] = [];
  for (let beat = 0; beat * beatMs < SONG_LENGTH_MS; beat++) {
    if (difficulty === 'easy' && beat % 2 === 1) continue;
    if (difficulty === 'normal' && beat % 4 === 3) continue;
    // Repeatable patterns, so a player's performance is comparable between attempts.
    const lane = beat % 4 === 0 ? 2 : lanes[(beat * 7 + Math.floor(beat / 4)) % lanes.length];
    notes.push({ id: beat, lane, timeMs: FIRST_BEAT_MS + beat * beatMs });
  }
  return {
    notes, score: 0, combo: 0, bestCombo: 0, perfect: 0,
    good: 0, okay: 0, wrong: 0, miss: 0, feedback: 'Ready?',
  };
}

function applyJudgement(game: Game, noteId: number, judgement: Judgement): Game {
  const combo = judgement === 'wrong' || judgement === 'miss' ? 0 : game.combo + 1;
  const points = judgement === 'perfect' ? 300 : judgement === 'good' ? 160 : judgement === 'okay' ? 80 : 0;
  return {
    ...game,
    notes: game.notes.map(note => note.id === noteId ? { ...note, judgement } : note),
    score: game.score + Math.round(points * (1 + Math.floor(game.combo / 8) * 0.15)),
    combo, bestCombo: Math.max(game.bestCombo, combo),
    [judgement]: game[judgement] + 1,
    feedback: judgement.toUpperCase(),
  };
}

export function judgeTap(game: Game, lane: number, elapsedMs: number): Game {
  const nearby = game.notes
    .filter(note => !note.judgement && Math.abs(note.timeMs - elapsedMs) <= HIT_WINDOW_MS)
    .sort((a, b) => Math.abs(a.timeMs - elapsedMs) - Math.abs(b.timeMs - elapsedMs));
  const matching = nearby.find(note => note.lane === lane);
  if (matching) {
    const difference = Math.abs(matching.timeMs - elapsedMs);
    const verdict: Judgement = difference <= 75 ? 'perfect' : difference <= 145 ? 'good' : 'okay';
    return applyJudgement(game, matching.id, verdict);
  }
  if (nearby.length) return applyJudgement(game, nearby[0].id, 'wrong');
  return { ...game, wrong: game.wrong + 1, combo: 0, feedback: 'OFF BEAT' };
}

export function expireNotes(game: Game, elapsedMs: number): Game {
  const due = game.notes.filter(note => !note.judgement && note.timeMs + HIT_WINDOW_MS < elapsedMs);
  if (!due.length) return game;
  const dueIds = new Set(due.map(note => note.id));
  return {
    ...game,
    notes: game.notes.map(note => dueIds.has(note.id) ? { ...note, judgement: 'miss' } : note),
    combo: 0, miss: game.miss + due.length, feedback: 'MISS',
  };
}

export function accuracy(game: Game): number {
  const attempted = game.perfect + game.good + game.okay + game.wrong + game.miss;
  if (!attempted) return 100;
  return Math.round((game.perfect + game.good * 0.7 + game.okay * 0.35) * 100 / attempted);
}

/** One event per physical press, even when the same fist touches neighbouring FSRs. */
export class FrontTapDetector {
  private latched = false;
  private lowSince = -1;
  private lastTap = -Infinity;

  reset() {
    this.latched = false;
    this.lowSince = -1;
    this.lastTap = -Infinity;
  }

  process(readings: NineReadings, baseline: NineReadings, threshold: number, nowMs: number): number | null {
    const signals = LANES.map(lane => Math.max(0, readings[lane.sensor] - baseline[lane.sensor]));
    const strongest = Math.max(...signals);
    const pressThreshold = Math.max(200, threshold * 0.75);
    const releaseThreshold = pressThreshold * 0.45;

    if (this.latched) {
      if (strongest <= releaseThreshold) {
        if (this.lowSince < 0) this.lowSince = nowMs;
        if (nowMs - this.lowSince >= 50) this.latched = false;
      } else {
        this.lowSince = -1;
      }
      return null;
    }

    if (strongest < pressThreshold || nowMs - this.lastTap < 135) return null;
    this.latched = true;
    this.lowSince = -1;
    this.lastTap = nowMs;
    // Relative multi-FSR strengths choose the lane; no claimed sub-sensor precision.
    return signals.indexOf(strongest);
  }
}
