// Replay source: plays a saved session (sessionFile.ts) at its own rate, as if
// the trainer were sending it. A file with device readings runs them through
// trainer.ts again, exactly as the serial source does; a file without them (the
// demo) hands its saved frames straight to the judge. Either way the store,
// judge and pages cannot tell it from a live device.

import { log } from '../debug';
import type { RawFrame, Status } from '../judge';
import type { SessionFile } from '../sessionFile';
import { createTrainerModel, type Reading } from './trainer';
import type { DataSource, SourceMeta, SourceStatus } from './types';

const S = log.session;

export function createReplaySource(file: SessionFile, { speed = 1, name = 'saved session' }: { speed?: number; name?: string } = {}): DataSource {
  const items: (Reading | RawFrame)[] = file.readings ?? file.frames;
  const viaModel = file.readings != null;
  const hz = file.hz;
  const meta: SourceMeta = {
    name: `Replay of ${name}`, hz, duration: items.length / hz, frameCount: items.length,
    units: 'fraction of the instructor reference',
  };

  const frameCbs = new Set<(f: RawFrame) => void>();
  const statusCbs = new Set<(s: SourceStatus) => void>();
  let model = createTrainerModel();
  let cursor = 0;
  let carry = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let status: Status = 'idle';
  const readings: Reading[] = [];

  const current = (): SourceStatus => ({ state: status, playing: timer != null, progress: cursor / items.length, duration: meta.duration, error: null, meta });
  const emitStatus = () => { const s = current(); statusCbs.forEach((cb) => cb(s)); };

  function finish(why: string) {
    status = 'summary';
    if (timer) clearInterval(timer);
    timer = null;
    S.info(`Replay finished: ${why}`, { delivered: cursor, of: items.length, via_trainer_model: viaModel });
  }

  function deliverOne() {
    const item = items[cursor++];
    if (!viaModel) { const f = item as RawFrame; frameCbs.forEach((cb) => cb(f)); return; }
    const r = item as Reading;
    readings.push(r);
    for (const f of model.push(r)) frameCbs.forEach((cb) => cb(f));
  }

  function tick() {
    carry += speed;
    let n = Math.floor(carry);
    carry -= n;
    while (n-- > 0 && cursor < items.length && status !== 'summary') {
      deliverOne();
      if (viaModel && model.complete()) finish('the trainer model reached the end of the final cycle');
    }
    if (status !== 'summary' && cursor >= items.length) finish('end of the file');
    emitStatus();
  }

  return {
    name: 'replay',
    onFrame(cb) { frameCbs.add(cb); return () => { frameCbs.delete(cb); }; },
    onStatus(cb) { statusCbs.add(cb); cb(current()); return () => { statusCbs.delete(cb); }; },
    readings: () => (viaModel ? readings : null),
    start() {
      if (timer) return;
      if (status === 'summary') {
        cursor = 0; carry = 0; readings.length = 0; model = createTrainerModel();
        S.info('Replay restarting from the first frame', { items: items.length });
      }
      status = 'live';
      timer = setInterval(tick, 1000 / hz);
      S.info(cursor ? 'Replay resumed' : `Replay started: ${name}`, {
        from: cursor, items: items.length, hz, speed, via_trainer_model: viaModel, saved_at: file.savedAt || 'unknown', saved_from: file.source.name,
      });
      emitStatus();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; S.info('Replay paused', { at: cursor, of: items.length }); }
      if (status === 'live') status = cursor ? 'live' : 'idle';
      emitStatus();
    },
  };
}
