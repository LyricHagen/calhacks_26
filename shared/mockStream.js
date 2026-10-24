// Compatibility re-export so existing imports keep working.
// Judging (thresholds, labels, events, summary) now lives in src/judge.ts and
// playback of session.json in src/sources/mock.ts. Import from those directly
// in new code.
export { HZ, STATES, THRESHOLDS, TORSO_ZONES, LABELS, checkSequence, summarize } from '../src/judge.ts';
