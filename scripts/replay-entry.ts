// Bundled and run by scripts/replay.mjs. Replays a saved session through the
// same trainer model and judge the app uses, prints the judge's log, then a
// summary, and checks the replay against what the file saved.
import { readFileSync } from 'node:fs';
import recording from '../shared/session.json';
import { SPREAD_LIMIT, createJudge, summarize, type Frame, type RawFrame } from '../src/judge';
import { parseSessionFile, type SessionFile } from '../src/sessionFile';
import { toRaw } from '../src/sources/mock';
import { createTrainerModel } from '../src/sources/trainer';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const grepAt = args.indexOf('--grep');
const grep = grepAt >= 0 ? args[grepAt + 1] : null;
const path = args.find((a, i) => !a.startsWith('--') && (grepAt < 0 || i !== grepAt + 1)) ?? null;

// The app logs every line with console.log('%c...', css). Filter here, not in the app.
const print = console.log;
console.log = (...xs: unknown[]) => {
  const line = String(xs[0]).replace(/^%c/, '');
  if (quiet && !/WARNING|ERROR/.test(line)) return;
  if (grep && !line.includes(grep)) return;
  print(line);
};
console.error = () => {};  // the logger repeats errors with a stack; the line above already printed

let file: SessionFile | null = null;
let frames: RawFrame[];
let via = 'saved frames, straight to the judge';
if (path) {
  file = parseSessionFile(readFileSync(path, 'utf8'), path);
  if (file.readings) {
    const model = createTrainerModel();
    frames = [];
    for (const r of file.readings) {
      if (model.complete()) break;
      frames.push(...model.push(r));
    }
    via = `${file.readings.length} device readings through trainer.ts, then the judge`;
  } else frames = file.frames;
} else {
  frames = (recording.frames as Frame[]).map(toRaw);
  via = 'shared/session.json, the demo recording';
}

const judge = createJudge();
for (const f of frames) judge.push(f);
const events = judge.events();
const last = frames[frames.length - 1];
const s = summarize(events, { status: 'summary', t: last ? last.t : 0 });

const tag = (id: string) => {
  const e = events.find((x) => x.id === id);
  return e ? (e.type === 'thrust' ? `T${String(e.n).padStart(2, '0')}` : e.type === 'backblow' ? `B${String(e.n).padStart(2, '0')}` : `R${e.n}`) : id;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const out = [
  '',
  `=== REPLAY ${path ?? 'demo recording'} ===`,
  `replayed: ${via}`,
  file ? `saved: ${file.savedAt || 'unknown time'} from ${file.source.meta?.name ?? file.source.name}` : null,
  `frames judged: ${frames.length}, last t ${last ? last.t.toFixed(1) : '--'} s`,
  `counts: ${s.counts.thrusts} thrusts, ${s.counts.backBlows} back blows, ${s.counts.references} references, ${s.counts.cycles} cycles complete`,
  `reference: peaks ${JSON.stringify(s.reference.peaks)}, spread ${s.reference.spread} (limit ${SPREAD_LIMIT}, ${s.reference.spread != null && s.reference.spread <= SPREAD_LIMIT ? 'within' : 'OUTSIDE'})`,
  `released: ${s.released.yes} yes, ${s.released.no} no`,
  `back blows: ${s.backBlows.onTarget} on target, ${s.backBlows.offTarget} off target`,
  `sequence: ${s.sequence.held ? 'held' : `broken at ${s.sequence.breaks.map((b) => `${tag(b.eventId)} (expected ${b.expected}, got ${b.got})`).join(', ')}`}`,
  `faults (${s.faults.length}): ${s.faults.map((f) => `${tag(f.eventId)} ${f.code}`).join(', ') || 'none'}`,
];
if (file) {
  out.push(`events match the saved file: ${same(events, file.events) ? 'yes' : `NO (saved ${file.events.length}, replayed ${events.length})`}`);
  if (file.readings) out.push(`frames match the saved file: ${same(frames, file.frames) ? 'yes' : `NO (saved ${file.frames.length}, replayed ${frames.length})`}`);
}
out.push('=== END REPLAY ===');
print(out.filter((x) => x != null).join('\n'));
