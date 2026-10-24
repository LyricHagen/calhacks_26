// Saved sessions: one JSON file with everything needed to replay a run through
// the same judge and pages as a live trainer. "Save session" on the summary
// writes one; "Load session" on the home page plays one back (sources/replay.ts).
// The last session that ended is also kept here, in memory and in this tab's
// sessionStorage, so leaving the summary or reloading does not lose it.

import { getLines, log } from './debug';
import { HZ, summarize, type RawFrame, type SessionEvent, type Summary } from './judge';
import type { Reading } from './sources/trainer';
import type { SourceMeta } from './sources/types';

export const FORMAT = 'chokesense-session';
export const VERSION = 1;
const STORE_KEY = 'chokesense-last-session';

export interface SessionFile {
  format: typeof FORMAT;
  version: number;
  savedAt: string;
  app: { url: string; userAgent: string };
  source: { name: string; meta: SourceMeta };
  hz: number;
  /** Device readings as they came off the USB link, before trainer.ts. Serial and serial replays only, else null.
   *  When present, a replay runs them through trainer.ts again, exactly as the live link does. */
  readings: Reading[] | null;
  /** Every frame exactly as the judge received it. Replayed directly when there are no readings. */
  frames: RawFrame[];
  /** The judge's events when the file was saved. */
  events: SessionEvent[];
  summary: Summary;
  /** The debug log ring buffer at save time, oldest first. */
  log: string[];
}

export function buildSessionFile(source: { name: string; meta: SourceMeta }, readings: Reading[] | null, frames: RawFrame[], events: SessionEvent[]): SessionFile {
  const t = frames.length ? frames[frames.length - 1].t : 0;
  return {
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    app: { url: typeof location !== 'undefined' ? location.href : '', userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '' },
    source,
    hz: source.meta.hz || HZ,
    readings: readings && readings.length ? readings : null,
    frames,
    events,
    summary: summarize(events, { status: 'summary', t }),
    log: getLines().map((l) => l.text),
  };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Reads a saved session. Throws an Error whose message is one sentence a page can show. */
export function parseSessionFile(text: string, fileName = 'the file'): SessionFile {
  let o: Partial<SessionFile>;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Error(`${fileName} is not JSON (${(e as Error).message}).`);
  }
  if (!o || typeof o !== 'object') throw new Error(`${fileName} is not a saved session.`);
  if (o.format !== FORMAT) throw new Error(`${fileName} is not a saved session: format is ${JSON.stringify(o.format ?? null)}, expected "${FORMAT}".`);
  if (o.version !== VERSION) throw new Error(`${fileName} is version ${String(o.version)}; this page reads version ${VERSION}.`);
  if (!Array.isArray(o.frames)) throw new Error(`${fileName} has no frames list.`);
  const readings = Array.isArray(o.readings) && o.readings.length ? o.readings : null;
  if (!readings && !o.frames.length) throw new Error(`${fileName} holds no frames and no readings, so there is nothing to replay.`);
  const bad = (readings ?? o.frames).findIndex((f) => !f || !isNum(f.t) || !isNum(f.fist) || !f.pads);
  if (bad >= 0) throw new Error(`${fileName}: ${readings ? 'reading' : 'frame'} ${bad} is missing t, fist or pads.`);
  const events = Array.isArray(o.events) ? o.events : [];
  const badEvent = events.findIndex((e) => !e || typeof e.id !== 'string' || typeof e.type !== 'string' || !Array.isArray(e.faults));
  if (badEvent >= 0) throw new Error(`${fileName}: saved entry ${badEvent} is missing its id, type or faults.`);
  return {
    format: FORMAT,
    version: VERSION,
    savedAt: String(o.savedAt ?? ''),
    app: o.app ?? { url: '', userAgent: '' },
    source: o.source ?? { name: 'unknown', meta: { name: 'unknown', hz: HZ, duration: 0, frameCount: o.frames.length, units: '' } },
    hz: isNum(o.hz) && o.hz > 0 ? o.hz : HZ,
    readings,
    frames: o.frames,
    events,
    summary: o.summary as Summary,
    log: Array.isArray(o.log) ? o.log : [],
  };
}

/** Starts a download of the file in the browser. */
export function downloadSessionFile(file: SessionFile) {
  const text = JSON.stringify(file);
  const stamp = file.savedAt.replace(/[:.]/g, '-').slice(0, 19);
  const name = `chokesense-session-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  log.session.info(`Session saved as ${name}`, {
    bytes: text.length, readings: file.readings?.length ?? 0, frames: file.frames.length, events: file.events.length,
    faults: file.summary.faults.length, log_lines: file.log.length,
  });
}

// ---------------------------------------------------------------------------
// The last session that ended, so the summary survives a new store or a reload.
// ---------------------------------------------------------------------------
let last: SessionFile | null = null;
const subs = new Set<() => void>();

try {
  const s = sessionStorage.getItem(STORE_KEY);
  if (s) {
    last = parseSessionFile(s, 'The stored session');
    log.session.info('Last session restored from this tab\'s storage', { saved_at: last.savedAt, frames: last.frames.length, events: last.events.length });
  }
} catch (e) {
  // No storage (private window, node), or a stale entry: start without one.
  if (typeof sessionStorage !== 'undefined') log.session.warn('Could not restore the last session from this tab\'s storage', { reason: String(e) });
}

export function remember(file: SessionFile) {
  last = file;
  subs.forEach((fn) => fn());
  log.session.info('Session kept in memory; the summary can show it after the page moves on', {
    source: file.source.name, frames: file.frames.length, events: file.events.length, t: file.summary.t,
  });
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(file));
  } catch (e) {
    log.session.warn('Session kept in memory only; this tab\'s storage refused it, so a reload will lose it', { reason: String(e), frames: file.frames.length });
  }
}

export function lastSession(): SessionFile | null { return last; }
export function onLastSession(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; }
