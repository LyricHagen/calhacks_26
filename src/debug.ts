// Debug logger shared by the whole app. Every line reads:
//   [HH:MM:SS.mmm #FRAME ns] human sentence  key=value key=value
// The sentence says what happened; the fields give the raw value and what it was
// compared against. Lines go to a 500-line ring buffer and to the console.
// The on-screen panel (DebugPanel.tsx) reads the buffer and builds the
// "Copy diagnostics" block from the providers registered here.

export const NAMESPACES = ['serial', 'parse', 'judge', 'calib', 'session', 'ui', 'ui/session', '3d', 'route', 'error'] as const;
export type Namespace = (typeof NAMESPACES)[number];
export type Level = 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

export interface LogLine {
  seq: number;
  time: number;
  frame: number | null;
  ns: Namespace;
  level: Level;
  text: string;
}

export interface CapturedError {
  time: number;
  ns: Namespace;
  message: string;
  stack: string;
  context: string[];
}

const RING = 500;
const CONTEXT = 20;

// Console colors per namespace, readable on light and dark devtools.
export const NS_COLOR: Record<Namespace, string> = {
  serial: '#2f7fb5',
  parse: '#7a6a2a',
  judge: '#b0532a',
  calib: '#5b7f2a',
  session: '#6a4fa0',
  ui: '#3a8a8a',
  'ui/session': '#2f6f8f',
  '3d': '#a04f7f',
  route: '#707070',
  error: '#c0262d',
};

const lines: LogLine[] = [];
const listeners = new Set<() => void>();
let seq = 0;
let frame: number | null = null;
let lastError: CapturedError | null = null;
let muteDepth = 0;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** One value as it appears after `key=`. Numbers keep 3 decimals, text with spaces is quoted. */
export function fmt(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'none';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return /\s/.test(v) || v === '' ? JSON.stringify(v) : v;
  if (Array.isArray(v)) return `[${v.map(fmt).join(',')}]`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function render(time: number, f: number | null, ns: Namespace, msg: string, fields?: Fields): string {
  const fr = f == null ? '#----' : `#${pad(f, 4)}`;
  const kv = fields ? Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ') : '';
  return `[${clock(time)} ${fr} ${ns}] ${msg}${kv ? `  ${kv}` : ''}`;
}

function write(ns: Namespace, level: Level, msg: string, fields?: Fields): LogLine {
  const time = Date.now();
  const line: LogLine = { seq: ++seq, time, frame, ns, level, text: render(time, frame, ns, msg, fields) };
  if (muteDepth > 0) return line;
  lines.push(line);
  if (lines.length > RING) lines.splice(0, lines.length - RING);
  const style = `color:${NS_COLOR[ns]}${level === 'info' ? '' : ';font-weight:bold'}`;
  // eslint-disable-next-line no-console
  console.log(`%c${line.text}`, style);
  listeners.forEach((fn) => fn());
  return line;
}

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  /** Logs the line, then keeps the stack and the 20 lines before it as the "last error". */
  error(msg: string, err?: unknown, fields?: Fields): void;
}

export function logger(ns: Namespace): Logger {
  return {
    info: (msg, fields) => { write(ns, 'info', msg, fields); },
    warn: (msg, fields) => { write(ns, 'warn', `WARNING ${msg}`, fields); },
    error(msg, err, fields) {
      const e = err instanceof Error ? err : null;
      const detail = e ? e.message : err == null ? '' : String(err);
      const context = lines.slice(-CONTEXT).map((l) => l.text);
      const line = write(ns, 'error', `ERROR ${msg}`, { ...fields, ...(detail ? { reason: detail } : {}) });
      const stack = e?.stack ?? new Error(msg).stack ?? '(no stack available)';
      lastError = { time: line.time, ns, message: detail ? `${msg}: ${detail}` : msg, stack, context };
      // eslint-disable-next-line no-console
      console.error(lastError.message, '\n', stack);
      listeners.forEach((fn) => fn());
    },
  };
}

/** One logger per namespace: `log.judge.info(...)`. */
export const log = Object.fromEntries(NAMESPACES.map((ns) => [ns, logger(ns)])) as Record<Namespace, Logger>;

/** Frame number shown as #FRAME on every later line. null before any frame arrives. */
export function setFrame(n: number | null) { frame = n; }
export function getFrame() { return frame; }

/** Runs `fn` with logging off, for self-tests that replay a whole session synchronously. */
export function muted<T>(fn: () => T): T {
  muteDepth++;
  try { return fn(); } finally { muteDepth--; }
}

export function getLines(): readonly LogLine[] { return lines; }
export function getLastError(): CapturedError | null { return lastError; }
export function clearLines() { lines.length = 0; listeners.forEach((fn) => fn()); }
export function onLog(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

// ---------------------------------------------------------------------------
// Diagnostics. Modules register a provider that describes their own state, so
// the copy block can be built without the panel knowing about the app.
// ---------------------------------------------------------------------------
export interface DiagnosticsInfo {
  source: string;
  connection: string;
  calibration: string[];
  session: string[];
}

let provider: (() => DiagnosticsInfo) | null = null;
export function provideDiagnostics(fn: () => DiagnosticsInfo) { provider = fn; }

export function hasSerial(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

let webgl: boolean | null = null;
export function hasWebGL(): boolean {
  if (webgl != null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Logs what this browser can do, once at startup. */
export function logEnvironment() {
  log.serial.info(`Web Serial API is ${hasSerial() ? 'available' : 'NOT available'}; it is needed to read the trainer over USB`, {
    available: hasSerial(), needed_for: 'USB trainer connection', works_in: 'Chrome, Edge, Opera on desktop',
  });
  log['3d'].info(`WebGL is ${hasWebGL() ? 'available' : 'NOT available'}; it is needed for 3D views`, { available: hasWebGL() });
  log.ui.info('Page loaded', { url: location.href, viewport: `${innerWidth}x${innerHeight}`, debug_param: new URLSearchParams(location.search).get('debug') ?? 'none' });
}

export function diagnostics(): string {
  let info: DiagnosticsInfo;
  try {
    info = provider ? provider() : { source: 'none registered', connection: 'unknown', calibration: ['not available'], session: ['not available'] };
  } catch (e) {
    info = { source: 'unknown', connection: 'unknown', calibration: [`could not read: ${String(e)}`], session: [`could not read: ${String(e)}`] };
  }
  const now = new Date();
  const out = [
    '=== CHOKESENSE DIAGNOSTICS ===',
    `time: ${now.toISOString()} (local ${now.toString()})`,
    `url: ${location.href}`,
    `user agent: ${navigator.userAgent}`,
    `browser serial support (Web Serial API): ${hasSerial() ? 'yes' : 'no'}`,
    `webgl support: ${hasWebGL() ? 'yes' : 'no'}`,
    `data source: ${info.source}`,
    `connection state: ${info.connection}`,
    '',
    'calibration:',
    ...info.calibration.map((s) => `  ${s}`),
    '',
    'session:',
    ...info.session.map((s) => `  ${s}`),
    '',
    'last error:',
  ];
  if (!lastError) out.push('  none');
  else {
    out.push(
      `  at: ${clock(lastError.time)} in namespace ${lastError.ns}`,
      `  message: ${lastError.message}`,
      '  stack:',
      ...lastError.stack.split('\n').map((s) => `    ${s.trim()}`),
      `  the ${lastError.context.length} log lines before it:`,
      ...lastError.context.map((s) => `    ${s}`),
    );
  }
  const tail = lines.slice(-200);
  out.push('', `--- last ${tail.length} log lines (oldest first) ---`, ...tail.map((l) => l.text), '=== END DIAGNOSTICS ===');
  return out.join('\n');
}

/** Writes text to the clipboard. Resolves false when the browser refuses, so the caller can show it for copying by hand. */
export async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    log.ui.info(`${what} copied to the clipboard`, { lines: text.split('\n').length, characters: text.length });
    return true;
  } catch (err) {
    log.ui.error(`${what} could not be written to the clipboard`, err, { characters: text.length, secure_context: isSecureContext });
    return false;
  }
}

// Uncaught errors from anywhere in the page land in the error namespace.
if (typeof window !== 'undefined') {
  window.addEventListener('error', (ev) => {
    log.error.error(`Uncaught error in the page at ${ev.filename || 'unknown file'}:${ev.lineno}:${ev.colno}`, ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    log.error.error('A promise was rejected and nothing handled it', ev.reason);
  });
}
