// Mock source: plays back shared/session.json at 10 Hz as raw frames.
// It also stages the design-review states from ?state=: loading and empty
// never deliver a frame, summary delivers the whole recording at once, and
// error delivers it up to 52.4 s and then reports a lost connection.

import recording from '../../shared/session.json';
import { log } from '../debug';
import { HZ, STATES, type Frame, type RawFrame, type ReviewState, type Status } from '../judge';
import type { DataSource, SourceMeta, SourceStatus } from './types';

const ERROR = {
  code: 'device-unreachable',
  message: 'Lost connection to the trainer. Check the USB cable.',
};
const ERROR_AT_SECONDS = 52.4;   // the error state freezes here, mid cycle 2, all four faults seen
const CONNECT_MS = 900;          // simulated connect time before live data

const P = log.parse;
const S = log.session;

/** A recorded frame as the device would send it: readings plus its own state. */
export function toRaw(f: Frame): RawFrame {
  return {
    t: f.t,
    fist: f.fist,
    pads: f.zones,
    acc: null,
    device: { phase: f.phase, cycle: f.cycle, backBlowCount: f.backBlowCount, thrustCount: f.thrustCount, angle: f.angle },
  };
}

let checked = false;
/** Checks the recording once per page load and logs anything malformed. */
function checkRecording(frames: Frame[], meta: SourceMeta) {
  if (checked) return;
  checked = true;
  const step = 1 / HZ;
  let malformed = 0;
  let gaps = 0;
  frames.forEach((f, i) => {
    const bad = [f.fist, ...Object.values(f.zones ?? {})].some((v) => typeof v !== 'number' || !Number.isFinite(v));
    if (bad || !f.zones || !f.phase) {
      malformed++;
      if (malformed <= 5) P.warn('Recorded frame is missing a reading or has a non-number value', { index: i, t: f.t, frame: JSON.stringify(f) });
    }
    if (i > 0 && Math.abs(f.t - frames[i - 1].t - step) > 1e-6) {
      gaps++;
      if (gaps <= 5) P.warn('Recorded frames are not evenly spaced', { index: i, t: f.t, gap_s: f.t - frames[i - 1].t, expected_gap_s: step });
    }
  });
  P.info(`Recording "${meta.name}" loaded and checked`, {
    frames: frames.length, expected_frames: meta.frameCount, hz: meta.hz, expected_hz: HZ, duration_s: meta.duration,
    malformed, timing_gaps: gaps, has_accelerometer: false,
  });
}

export function createMockSource({ state = 'live', speed = 1, frames = recording.frames as Frame[] }: {
  state?: ReviewState; speed?: number; frames?: Frame[];
} = {}): DataSource {
  if (!STATES.includes(state)) state = 'live';
  const meta = recording.meta as SourceMeta;
  const duration = frames.length / HZ;
  checkRecording(frames, meta);

  const frameCbs = new Set<(f: RawFrame) => void>();
  const statusCbs = new Set<(s: SourceStatus) => void>();
  let cursor = 0;            // frames delivered
  let carry = 0;             // fractional frames owed at speeds below 1
  let timer: ReturnType<typeof setInterval> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let status: Status = 'idle';
  let error: SourceStatus['error'] = null;
  let primed = false;        // review states deliver their frames once

  if (state === 'loading') status = 'loading';
  else if (state === 'empty') status = 'empty';

  const current = (): SourceStatus => ({ state: status, playing: timer != null, progress: cursor / frames.length, duration, error, meta });
  const emitStatus = () => { const s = current(); statusCbs.forEach((cb) => cb(s)); };
  const deliver = (n: number) => { while (cursor < n) { const f = toRaw(frames[cursor++]); frameCbs.forEach((cb) => cb(f)); } };

  function tick() {
    carry += speed;
    const n = Math.floor(carry);
    carry -= n;
    deliver(Math.min(frames.length, cursor + n));
    if (cursor >= frames.length) {
      status = 'summary';
      if (timer) clearInterval(timer);
      timer = null;
      S.info('Playback reached the end of the recording', { frames: cursor, expected_frames: frames.length, t: frames[cursor - 1]?.t ?? 0 });
    }
    emitStatus();
  }

  return {
    name: 'mock',
    onFrame(cb) { frameCbs.add(cb); return () => { frameCbs.delete(cb); }; },
    onStatus(cb) { statusCbs.add(cb); cb(current()); return () => { statusCbs.delete(cb); }; },
    start() {
      if (state !== 'live') {
        if (primed) return;
        primed = true;
        if (state === 'summary') {
          S.info('?state=summary: delivering the whole recording at once', { frames: frames.length });
          deliver(frames.length);
          status = 'summary';
        } else if (state === 'error') {
          const stopAt = Math.round(ERROR_AT_SECONDS * HZ);
          S.info('?state=error: delivering the recording up to the simulated disconnect', { frames: stopAt, of: frames.length, stop_at_s: ERROR_AT_SECONDS });
          deliver(stopAt);
          status = 'error';
          error = { ...ERROR };
          S.error('Trainer connection lost (simulated by ?state=error)', ERROR.message, { code: ERROR.code, last_frame_t: frames[stopAt - 1]?.t ?? 0 });
        } else {
          S.info(`?state=${state}: no frames will be delivered`, { status });
        }
        emitStatus();
        return;
      }
      if (timer || connectTimer) return;
      if (status === 'summary') { cursor = 0; carry = 0; S.info('Restarting playback from the first frame', { frames: frames.length }); }
      if (cursor === 0) {
        // Simulated connect to the trainer before the first frame arrives.
        status = 'loading';
        S.info('Connecting to the trainer (simulated delay)', { connect_ms: Math.round(CONNECT_MS / Math.max(1, speed)), hz: HZ, speed });
        emitStatus();
        connectTimer = setTimeout(() => {
          connectTimer = null;
          status = 'live';
          timer = setInterval(tick, 1000 / HZ);
          S.info('Connected; frames are flowing', { hz: HZ, interval_ms: 1000 / HZ });
          tick();
        }, CONNECT_MS / Math.max(1, speed));
        return;
      }
      status = 'live';
      timer = setInterval(tick, 1000 / HZ);
      S.info('Playback resumed', { from_frame: cursor, t: frames[cursor - 1]?.t ?? 0 });
      emitStatus();
    },
    stop() {
      if (connectTimer) { clearTimeout(connectTimer); S.info('Stopped while still connecting; no frames were delivered', { frames: cursor }); }
      connectTimer = null;
      if (timer) { clearInterval(timer); timer = null; S.info('Playback stopped', { at_frame: cursor, of: frames.length }); }
      if (status === 'loading' && state === 'live') status = cursor ? 'live' : 'idle';
      emitStatus();
    },
  };
}
