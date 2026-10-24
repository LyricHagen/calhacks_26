// Serial source: reads the trainer over USB with the Web Serial API.
// Transport and parsing only. Lines in, validated readings out; the trainer
// model (trainer.ts) turns readings into the frames the judge reads. The wire
// format is in protocol.md.

import { hasSerial, log } from '../debug';
import { HZ, PADS, THRESHOLDS, type Pads, type RawFrame, type Status } from '../judge';
import { createTrainerModel, type Reading } from './trainer';
import type { DataSource, LinkInfo, SourceMeta, SourceStatus } from './types';

export const BAUD = 115200;
const MAX_LINE = 1024;        // characters without a newline before the buffer is handed over as one line
const SILENCE_MS = 1500;      // no valid frame this long: lost signal
const GARBLED_AFTER = 20;     // unreadable lines in a row: the device is sending something unexpected
const RAW_LINES_LOGGED = 3;
const FIELD_LINES = 5;        // full log lines per bad field before it is only counted once a second
const HELLO_RETRY_MS = 2000;
const HELLO_TRIES = 3;
const PING_MS = 5000;
const ACC_LIMIT = 160;        // m/s^2, a little past the IMU's 16 g range
const NONFATAL = new Set(['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError']);

const S = log.serial;
const P = log.parse;

const ERRORS: Record<string, string> = {
  'lost-signal': 'No data from the trainer for 1.5 s. Still listening; check the USB cable and that the board has power.',
  'unexpected-data': 'The device is sending something unexpected. Check that it runs the chokesense firmware at 115200 baud. Last line received:',
  unplugged: 'The trainer was unplugged. Everything recorded so far is kept. Plug it back in and press Reconnect.',
  reconnecting: 'Port open again; waiting for the first frame.',
  'reconnect-failed': 'Could not open the trainer. Plug it in, close any other program using the port, such as the Arduino serial monitor, then press Reconnect.',
};
const err = (code: string) => ({ code, message: ERRORS[code] });

const CHIPS: Record<number, string> = { 0x10c4: 'CP2102', 0x1a86: 'CH340', 0x0403: 'FTDI', 0x303a: 'ESP32 USB', 0x2341: 'Arduino' };
const hex = (n?: number) => (n == null ? 'none' : `0x${n.toString(16).padStart(4, '0')}`);

/** Short name for the header, from the USB bridge chip. */
export function portName(info: SerialPortInfo): string {
  const v = info.usbVendorId;
  if (v === 0x1a86 && info.usbProductId === 0x55d4) return 'CH9102';
  if (v == null) return 'Serial port';
  return CHIPS[v] ?? `USB ${hex(v)}`;
}

/** The browser can open USB serial ports (Chrome or Edge on desktop, on localhost or https). */
export const serialSupported = hasSerial;

const sameDevice = (a: SerialPortInfo, b: SerialPortInfo) =>
  a.usbVendorId != null && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;

/** An error a page can show as is. `cancelled` means the person closed the chooser. */
export class ConnectError extends Error {
  cancelled: boolean;
  constructor(message: string, cancelled = false) { super(message); this.cancelled = cancelled; }
}

/** Shows the browser's port chooser. Call it straight from a click; the browser refuses otherwise. */
export async function requestTrainerPort(): Promise<SerialPort> {
  if (!hasSerial()) throw new ConnectError('This browser cannot open USB serial ports. Use Chrome or Edge on a desktop computer.');
  S.info('Port requested: showing the browser port chooser', { filters: 'none, every serial port is listed' });
  let port: SerialPort;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'NotFoundError') {
      S.info('Port chooser closed without a port being chosen', { reason: (e as Error).message });
      throw new ConnectError('No port chosen.', true);
    }
    if (name === 'SecurityError') {
      S.error('The browser refused to show the port chooser', e, { needs: 'a click, on localhost or https' });
      throw new ConnectError('The browser blocked the port chooser. Open the page on localhost or https and click Connect again.');
    }
    S.error('Port request failed', e);
    throw new ConnectError(`Could not ask for a port: ${(e as Error)?.message ?? String(e)}`);
  }
  const info = port.getInfo();
  S.info(`Port granted: ${portName(info)}`, { usbVendorId: hex(info.usbVendorId), usbProductId: hex(info.usbProductId), chip: portName(info) });
  return port;
}

/** Splits decoded text into lines, keeping a partial line until the rest of it arrives. */
export function lineSplitter(max = MAX_LINE): TransformStream<string, string> {
  let buf = '';
  return new TransformStream<string, string>({
    transform(chunk, out) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        out.enqueue(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
      // No newline in sight (wrong baud rate, binary noise): hand it over so it fails to parse and is counted.
      if (buf.length > max) { out.enqueue(buf); buf = ''; }
    },
    flush(out) { if (buf) out.enqueue(buf); },
  });
}

export interface SerialSource extends DataSource {
  readonly portName: string;
  /** Opens the port without reading yet. Rejects with a ConnectError the page can show. */
  open(): Promise<void>;
  /** Stops reading and closes the port. */
  close(reason: string): Promise<void>;
  /** Opens the trainer again after an unplug, keeping everything recorded so far. Call from a click. */
  reconnect(): Promise<void>;
}

interface Second {
  start: number;
  frames: number;
  fistSum: number;
  fistMin: number;
  fistMax: number;
  padMax: Pads;
  dropped: number;
  failures: number;
  skipped: number;
  badFields: Record<string, number>;
}

const freshSecond = (start = performance.now()): Second => ({
  start, frames: 0, fistSum: 0, fistMin: Infinity, fistMax: -Infinity,
  padMax: { target: 0, high: 0, low: 0, side: 0, back: 0 }, dropped: 0, failures: 0, skipped: 0, badFields: {},
});
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const msg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function createSerialSource(initialPort: SerialPort): SerialSource {
  let port = initialPort;
  let info = port.getInfo();
  let name = portName(info);
  let model = createTrainerModel();
  const readings: Reading[] = [];   // everything handed to the model, for Save session
  const enc = new TextEncoder();

  const frameCbs = new Set<(f: RawFrame) => void>();
  const statusCbs = new Set<(s: SourceStatus) => void>();

  // Link
  let isOpen = false;
  let reading = false;
  let stopping = false;
  let loopDone: Promise<void> = Promise.resolve();
  let closing: Promise<void> = Promise.resolve();
  let writes: Promise<void> = Promise.resolve();
  let reader: ReadableStreamDefaultReader<string> | null = null;
  let link: LinkInfo['state'] = 'closed';
  let error: SourceStatus['error'] = null;
  let hz: number | null = null;
  let hzHist: number[] = [];
  let rawLine: string | null = null;
  let complete = false;
  let timers: ReturnType<typeof setInterval>[] = [];

  // Per connection
  let readStartedAt = 0;
  let lastFrameAt: number | null = null;
  let frames = 0;
  let parseFailures = 0;
  let badInARow = 0;
  let rawLogged = 0;
  let dropped = 0;
  let helloSeen = false;
  let helloTries = 0;
  let warnedNoHello = false;
  let pingSentAt: number | null = null;
  let lastRtt: number | null = null;
  let sec = freshSecond();
  const fieldCounts: Record<string, number> = {};

  // Whole session, kept across reconnects
  let delivered = 0;
  let padOrder: string[] = [...PADS];
  let declaredHz = HZ;
  let lastDevT: number | null = null;
  let devT0 = 0;
  let tBase = 0;
  let lastOutT: number | null = null;

  // ---- status ----------------------------------------------------------------
  function state(): Status {
    if (complete) return 'summary';
    if (link === 'unplugged') return 'error';
    if (!reading) return error ? 'error' : 'idle';
    if (link === 'streaming') return 'live';
    if (link === 'connecting') return delivered ? 'error' : 'loading';
    return 'error';
  }

  const meta = (): SourceMeta => ({ name: `USB trainer (${name})`, hz: declaredHz, duration: 0, frameCount: delivered, units: 'fraction of the instructor reference' });

  const current = (): SourceStatus => ({
    state: state(),
    playing: link === 'streaming' && !complete,
    progress: 0,
    duration: 0,
    error: complete ? null : error,
    meta: meta(),
    link: { port: name, state: link, hz, rawLine: link === 'garbled' ? rawLine : null },
  });

  function emit() { const s = current(); statusCbs.forEach((cb) => cb(s)); }

  function setLink(next: LinkInfo['state'], e: SourceStatus['error'] = null) {
    link = next;
    error = e;
    emit();
  }

  // ---- port --------------------------------------------------------------------
  async function open() {
    await closing;
    if (isOpen) return;
    S.info(`Opening ${name} at ${BAUD} baud`, { usbVendorId: hex(info.usbVendorId), usbProductId: hex(info.usbProductId) });
    try {
      await port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    } catch (e) {
      if ((e as Error)?.name !== 'InvalidStateError') {
        S.error('Could not open the port', e, { port: name, likely: 'another program has it open, or the board was unplugged' });
        throw new ConnectError('Could not open the port. Close the Arduino serial monitor or any other program using it, check the cable, then try again.');
      }
      S.warn('Port was already open; reading it as it is', { port: name });
    }
    isOpen = true;
    S.info('Port opened', { port: name, baud_rate: BAUD, data_bits: 8, parity: 'none', stop_bits: 1, flow_control: 'none' });
  }

  function close(reason: string): Promise<void> {
    closing = closing.then(async () => {
      if (!isOpen && !reading) return;
      const wasReading = reading;
      stopping = true;
      endReading();
      try { await reader?.cancel(reason); } catch { /* already closed */ }
      await loopDone;
      await writes;
      if (wasReading) logDisconnect(reason, false);
      try {
        await port.close();
        S.info('Port closed', { port: name, reason });
      } catch (e) {
        S.warn('Port did not close cleanly', { port: name, reason: msg(e) });
      }
      isOpen = false;
      stopping = false;
      setLink('closed');
    });
    return closing;
  }

  function send(cmd: string, quiet = false) {
    writes = writes.then(async () => {
      const w = port.writable?.getWriter();
      if (!w) return;
      try {
        await w.write(enc.encode(`${cmd}\n`));
        if (!quiet) S.info(`Sent "${cmd}" to the device`);
      } finally {
        w.releaseLock();
      }
    }).catch((e) => S.warn(`Could not send "${cmd}" to the device`, { reason: msg(e) }));
  }

  // ---- reading -------------------------------------------------------------------
  function beginReading() {
    if (reading) return;
    reading = true;
    stopping = false;
    readStartedAt = performance.now();
    lastFrameAt = null;
    frames = 0;
    parseFailures = 0;
    badInARow = 0;
    rawLogged = 0;
    dropped = 0;
    helloSeen = false;
    helloTries = 1;
    warnedNoHello = false;
    lastDevT = null;     // the device may have restarted: time is rebased on the next frame
    hz = null;
    hzHist = [];
    sec = freshSecond();
    setLink('connecting', delivered ? err('reconnecting') : null);
    loopDone = readLoop();
    timers = [setInterval(watchSilence, 250), setInterval(everySecond, 1000), setInterval(ping, PING_MS), setInterval(retryHello, HELLO_RETRY_MS)];
    send('hello');
  }

  function endReading() {
    reading = false;
    timers.forEach(clearInterval);
    timers = [];
  }

  async function readLoop() {
    S.info('Reader loop started', { port: name, baud_rate: BAUD, silence_limit_ms: SILENCE_MS, unexpected_after_lines: GARBLED_AFTER });
    let reason = 'the stream closed';
    while (port.readable && !stopping) {
      const decoder = new TextDecoderStream();
      const piped = port.readable.pipeTo(decoder.writable).then(() => null, (e: unknown) => e);
      const lines = decoder.readable.pipeThrough(lineSplitter()).getReader();
      reader = lines;
      let failure: unknown = null;
      try {
        for (;;) {
          const { value, done } = await lines.read();
          if (done) break;
          onLine(value);
        }
      } catch (e) {
        failure = e;
      } finally {
        lines.releaseLock();
        reader = null;
      }
      failure ??= await piped;
      if (stopping) return;
      const kind = (failure as Error | null)?.name;
      if (kind && NONFATAL.has(kind)) {
        S.warn(`Recoverable serial error (${kind}); reading on`, { reason: msg(failure) });
        continue;
      }
      reason = failure ? msg(failure) : 'the stream closed';
      break;
    }
    if (!stopping) lost(reason);
  }

  function lost(reason: string) {
    logDisconnect(reason, true);
    endReading();
    isOpen = false;
    port.close().catch((e) => S.info('Closing the port after the unplug reported an error, as expected once the device is gone', { reason: msg(e) }));
    setLink('unplugged', err('unplugged'));
  }

  function logDisconnect(reason: string, unexpected: boolean) {
    const fields = {
      reason, port: name, connected_for_s: Math.round((performance.now() - readStartedAt) / 100) / 10,
      frames_received: frames, parse_failures: parseFailures, dropped_frames: dropped, frames_judged_this_session: delivered,
    };
    if (unexpected) S.warn(`DISCONNECTED (${reason}); the session is frozen and nothing recorded is lost`, fields);
    else S.info(`Disconnected: ${reason}`, fields);
  }

  // ---- lines ---------------------------------------------------------------------
  function onLine(line: string) {
    if (!line.trim()) return;
    if (rawLogged < RAW_LINES_LOGGED) {
      rawLogged++;
      P.info(`RAW LINE ${rawLogged} of ${RAW_LINES_LOGGED}, before parsing: ${line}`, { chars: line.length });
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      parseFailures++;
      sec.failures++;
      P.warn('Line is not JSON; skipped', { raw: line, json_error: (e as Error).message, failures_in_a_row: badInARow + 1, failures_total: parseFailures });
      badLine(line);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      P.warn('Line is JSON but not an object; skipped', { raw: line });
      badLine(line);
      return;
    }
    const o = obj as Record<string, unknown>;
    if ('hello' in o) { badInARow = 0; onHello(o, line); return; }
    if ('pong' in o) { badInARow = 0; onPong(o); return; }
    if ('zeroed' in o) { badInARow = 0; P.info('Device clock zeroed', { t_before: o.zeroed }); return; }
    if ('err' in o) { badInARow = 0; P.warn('Device reported an error', { err: o.err, cmd: o.cmd, raw: line }); return; }
    if ('fist' in o || 'pads' in o || 't' in o) { onFrame(o, line); return; }
    P.warn('JSON object of a kind this page does not know; skipped', { raw: line, keys: Object.keys(o) });
    badLine(line);
  }

  function badLine(line: string) {
    badInARow++;
    rawLine = line;
    if (badInARow === GARBLED_AFTER) {
      P.warn(`DEVICE IS SENDING SOMETHING UNEXPECTED: ${GARBLED_AFTER} unreadable lines in a row`, {
        last_line: line, failures_total: parseFailures, check: 'baud rate 115200 and the chokesense firmware',
      });
      setLink('garbled', err('unexpected-data'));
    } else if (link === 'garbled') emit(); // show the newest offending line
  }

  function fieldIssue(field: string, value: unknown, expected: string, line: string) {
    const n = (fieldCounts[field] = (fieldCounts[field] ?? 0) + 1);
    sec.badFields[field] = (sec.badFields[field] ?? 0) + 1;
    if (n > FIELD_LINES) return;
    P.warn(`Field "${field}" is ${value === undefined ? 'missing' : 'out of range or the wrong type'}`, {
      field, value: value === undefined ? 'missing' : value, expected, raw: line,
      ...(n === FIELD_LINES ? { note: 'further problems with this field are only counted in the once-a-second line' } : {}),
    });
  }

  function onHello(o: Record<string, unknown>, line: string) {
    helloSeen = true;
    const pads = Array.isArray(o.pads) && o.pads.every((p) => typeof p === 'string') ? (o.pads as string[]) : null;
    P.info(`HELLO from the trainer: firmware ${String(o.fw)}, ${String(o.hz)} Hz`, { device: o.hello, fw: o.fw, declared_hz: o.hz, pads: pads ?? o.pads });
    if (o.hello !== 'chokesense') P.warn('Hello line names a different device; reading it anyway', { got: o.hello, expected: 'chokesense', raw: line });
    if (typeof o.hz !== 'number' || !(o.hz > 0 && o.hz <= 100)) fieldIssue('hz', o.hz, 'a number from 1 to 100', line);
    else {
      declaredHz = o.hz;
      if (o.hz !== HZ) P.warn(`Device declares ${o.hz} Hz but the judge's timing assumes ${HZ} Hz`, { declared_hz: o.hz, judge_hz: HZ });
    }
    if (!pads) { fieldIssue('pads', o.pads, 'a list of pad names', line); return; }
    const known = PADS as readonly string[];
    const missing = PADS.filter((p) => !pads.includes(p));
    const extra = pads.filter((p) => !known.includes(p));
    if (missing.length || extra.length) {
      P.warn('PAD NAMES DO NOT MATCH WHAT THE JUDGE EXPECTS. Missing pads read as 0 and extra pads are ignored', {
        device_pads: pads, judge_expects: [...PADS], missing: missing.length ? missing : 'none', unexpected: extra.length ? extra : 'none',
      });
    } else if (pads.join() !== PADS.join()) {
      P.info('Pad order differs from the judge; pads are matched by name', { device_pads: pads, judge_expects: [...PADS] });
    }
    padOrder = pads;
    emit();
  }

  function onPong(o: Record<string, unknown>) {
    if (pingSentAt == null) return;
    const first = lastRtt == null;
    lastRtt = Math.round(performance.now() - pingSentAt);
    pingSentAt = null;
    if (first) P.info('First pong from the device; later round trips are in the once-a-second line', { rtt_ms: lastRtt, device_t: o.pong });
  }

  function onFrame(o: Record<string, unknown>, line: string) {
    const interval = 1000 / declaredHz;
    const skip = () => { sec.skipped++; badLine(line); };

    if (typeof o.fist !== 'number' || !Number.isFinite(o.fist)) { fieldIssue('fist', o.fist, 'a number from 0 to 1', line); skip(); return; }
    let fist: number = o.fist;
    if (fist < 0 || fist > 1) { fieldIssue('fist', fist, '0 to 1', line); fist = clamp01(fist); }

    if (!Array.isArray(o.pads)) { fieldIssue('pads', o.pads, `a list of ${padOrder.length} numbers from 0 to 1`, line); skip(); return; }
    const raw = o.pads as unknown[];
    if (raw.length !== padOrder.length) fieldIssue('pads', `${raw.length} values`, `${padOrder.length} values, one per pad in the hello line`, line);
    const pads: Pads = { target: 0, high: 0, low: 0, side: 0, back: 0 };
    padOrder.forEach((pad, i) => {
      if (!(PADS as readonly string[]).includes(pad)) return;
      let v = raw[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) { fieldIssue(`pads.${pad}`, v, 'a number from 0 to 1', line); v = 0; }
      else if (v < 0 || v > 1) { fieldIssue(`pads.${pad}`, v, '0 to 1', line); v = clamp01(v); }
      pads[pad as keyof Pads] = v as number;
    });

    let acc: Reading['acc'] = null;
    const a = o.acc;
    if (a === null) fieldIssue('acc', null, 'three numbers in m/s^2; null means the IMU is not answering', line);
    else if (!Array.isArray(a) || a.length !== 3 || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) fieldIssue('acc', a, 'three numbers in m/s^2', line);
    else {
      acc = a as [number, number, number];
      if (acc.some((v) => Math.abs(v) > ACC_LIMIT)) fieldIssue('acc', acc, `each between -${ACC_LIMIT} and ${ACC_LIMIT} m/s^2`, line);
    }

    let devT: number;
    if (typeof o.t !== 'number' || !Number.isFinite(o.t) || o.t < 0) {
      fieldIssue('t', o.t, 'device milliseconds, 0 or more', line);
      devT = lastDevT == null ? 0 : lastDevT + interval;
    } else devT = o.t;

    // Continuous time in seconds, across device restarts and reconnects.
    if (lastDevT == null) {
      tBase = lastOutT == null ? 0 : lastOutT + interval / 1000;
      devT0 = devT;
    } else {
      const gap = devT - lastDevT;
      if (gap <= 0) {
        P.warn('Device time went backwards or stood still: the board restarted or was zeroed. Time continues from the last frame', { t_before: lastDevT, t_now: devT, raw: line });
        tBase = (lastOutT ?? 0) + interval / 1000;
        devT0 = devT;
      } else if (gap > 1.5 * interval) {
        const n = Math.round(gap / interval) - 1;
        dropped += n;
        sec.dropped += n;
      }
    }
    lastDevT = devT;
    const t = Math.round((tBase + (devT - devT0) / 1000) * 1000) / 1000;
    lastOutT = t;

    // A usable frame.
    const now = performance.now();
    const quietMs = Math.round(now - (lastFrameAt ?? readStartedAt));
    frames++;
    badInARow = 0;
    lastFrameAt = now;
    sec.frames++;
    sec.fistSum += fist;
    sec.fistMin = Math.min(sec.fistMin, fist);
    sec.fistMax = Math.max(sec.fistMax, fist);
    for (const k of PADS) sec.padMax[k] = Math.max(sec.padMax[k], pads[k]);
    if (!helloSeen && !warnedNoHello) {
      warnedNoHello = true;
      P.warn('Frames are arriving without a hello line; assuming the pad order the judge uses', { assumed_pads: padOrder });
    }
    if (link !== 'streaming') {
      if (link === 'silent' || link === 'garbled') S.info(`Signal back: valid frames again after ${quietMs} ms`, { was: link, quiet_ms: quietMs });
      else S.info('First valid frame received; streaming', { t_device_ms: devT, t_session_s: t, ms_after_reader_start: quietMs });
      setLink('streaming');
    }

    if (complete) return;
    const reading: Reading = { t, fist, pads, acc };
    readings.push(reading);
    for (const f of model.push(reading)) {
      delivered++;
      frameCbs.forEach((cb) => cb(f));
    }
    if (model.complete()) {
      complete = true;
      S.info('Session complete: the last thrust of the final cycle ended; later frames are read but not judged', { frames_judged: delivered, t });
      emit();
    }
  }

  // ---- timers ----------------------------------------------------------------------
  function watchSilence() {
    if (!reading || link === 'garbled' || link === 'silent') return;
    const since = performance.now() - (lastFrameAt ?? readStartedAt);
    if (since < SILENCE_MS) return;
    S.warn(`LOST SIGNAL: no valid frame for ${SILENCE_MS} ms; still reading the port`, {
      ms_since_last_frame: Math.round(since), last_frame_t: lastOutT ?? 'none', frames_this_connection: frames,
    });
    setLink('silent', err('lost-signal'));
    send('hello');
  }

  function everySecond() {
    if (!reading) return;
    const now = performance.now();
    const s = sec;
    sec = freshSecond(now);
    const measured = s.frames / ((now - s.start) / 1000);
    hzHist = [...hzHist, measured].slice(-3);
    hz = Math.round((hzHist.reduce((a, b) => a + b, 0) / hzHist.length) * 10) / 10;
    const base = model.baseline();
    const above = PADS.filter((k) => s.padMax[k] - (base ? base[k] : 0) > THRESHOLDS.zoneOff);
    S.info(`Last second: ${s.frames} frames, expected ${declaredHz}`, {
      frames: s.frames, expected: declaredHz, dropped: s.dropped, dropped_total: dropped,
      measured_hz: measured, hz_shown: hz,
      fist_mean: s.frames ? s.fistSum / s.frames : 'none',
      fist_min: s.frames ? s.fistMin : 'none',
      fist_max: s.frames ? s.fistMax : 'none',
      pads_above_baseline: !s.frames ? 'no frames' : above.length ? above : 'none',
      baseline: base ? 'rest baseline' : 'not set yet, compared with 0',
      parse_failures: s.failures,
      ...(s.skipped ? { frames_skipped: s.skipped } : {}),
      ...(Object.keys(s.badFields).length ? { bad_fields: s.badFields } : {}),
      ping_rtt_ms: lastRtt ?? 'none', link,
    });
    emit();
  }

  function ping() {
    if (!reading) return;
    pingSentAt = performance.now();
    send('ping', true);
  }

  function retryHello() {
    if (!reading || helloSeen || helloTries > HELLO_TRIES) return;
    if (helloTries === HELLO_TRIES) {
      helloTries++;
      P.warn(`No hello line after ${HELLO_TRIES} requests; reading frames with the judge's pad order`, { assumed_pads: padOrder, frames_so_far: frames });
      return;
    }
    helloTries++;
    S.info('No hello line yet; asking again', { attempt: helloTries, of: HELLO_TRIES });
    send('hello');
  }

  if (hasSerial()) {
    navigator.serial.addEventListener('disconnect', (e) => {
      if (e.target === port) S.warn('The browser reports the trainer port was unplugged', { port: name });
    });
    navigator.serial.addEventListener('connect', (e) => {
      if (link === 'unplugged') S.info('A serial port this page may use was plugged in; press Reconnect to resume', { port: portName((e.target as SerialPort).getInfo()) });
    });
  }

  return {
    name: 'serial',
    get portName() { return name; },
    onFrame(cb) { frameCbs.add(cb); return () => { frameCbs.delete(cb); }; },
    onStatus(cb) { statusCbs.add(cb); cb(current()); return () => { statusCbs.delete(cb); }; },
    readings: () => readings,
    open,
    close,
    start() {
      if (complete) {
        // The page judges again from scratch (stream.tsx), so the trainer starts over too.
        model = createTrainerModel();
        readings.length = 0;
        complete = false;
        S.info('New session on the same port: rest and calibration start over');
        emit();
      }
      if (reading) return;
      if (isOpen) { beginReading(); return; }
      open().then(beginReading, (e) => setLink('unplugged', { code: 'reconnect-failed', message: (e as Error).message }));
    },
    stop() { void close('stopped by the page'); },
    async reconnect() {
      S.info('Reconnect pressed', { port: name, link, frames_judged_so_far: delivered });
      let next: SerialPort | undefined;
      try {
        // Look up granted ports first; if the chooser is needed it still counts as part of the click.
        const ports = await navigator.serial.getPorts();
        next = ports.find((p) => p === port) ?? ports.find((p) => sameDevice(p.getInfo(), info));
        S.info(next ? 'Found the trainer among ports this page may use' : 'Trainer is not among ports this page may use; showing the chooser', {
          granted_ports: ports.length, match: next ? portName(next.getInfo()) : 'none',
        });
        next ??= await requestTrainerPort();
      } catch (e) {
        if (e instanceof ConnectError && e.cancelled) return;
        S.error('Reconnect could not find a port', e);
        setLink('unplugged', err('reconnect-failed'));
        return;
      }
      await close('reconnect pressed');
      port = next;
      info = port.getInfo();
      name = portName(info);
      try {
        await open();
      } catch {
        setLink('unplugged', err('reconnect-failed'));
        return;
      }
      beginReading();
    },
  };
}
