// /diag: a self-test for the demo floor, linked only from the debug panel.
// Each check states what it looked at, pass or fail, and the actual value, and
// the whole report copies as plain text.
import { useCallback, useEffect, useState } from 'react';
import { matchRoutes } from 'react-router-dom';
import recording from '../../shared/session.json';
import { PAGES, ROUTES } from '../App';
import { PageHead } from '../components/Common';
import { copyText, hasSerial, log, muted } from '../debug';
import { createJudge, summarize, type Frame } from '../judge';
import { createMockSource, toRaw } from '../sources/mock';

interface Result { ok: boolean; value: string }
interface Check { id: string; what: string; run: () => Promise<Result> }

const GLB_URL = `${import.meta.env.BASE_URL}torso.glb`;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i;
const KNOWN_FAULTS = ['placement-high', 'not-released', 'blow-off-target', 'weak'];
const MOCK_WINDOW_MS = 3000;
const yesNo = (b: boolean) => (b ? 'yes' : 'no');

function webgl(): Result {
  const c = document.createElement('canvas');
  const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
  if (!gl) return { ok: false, value: 'no WebGL 2 or WebGL 1 context could be created; the torso is drawn flat' };
  const v2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  // A browser on a software rasterizer refuses a context that asks to fail on a major performance caveat.
  const strict = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
  const software = SOFTWARE.test(renderer) || !strict;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  strict?.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    ok: !software,
    value: `${v2 ? 'WebGL 2' : 'WebGL 1'}, renderer "${renderer}"${strict ? '' : ', browser reports a major performance caveat'}${software ? ' (software rendering: the 3D torso will be slow)' : ''}`,
  };
}

async function glb(): Promise<Result> {
  const res = await fetch(GLB_URL, { cache: 'no-store' });
  const type = res.headers.get('content-type') ?? 'no content type';
  const buf = await res.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf.slice(0, 4)));
  const ok = res.ok && magic === 'glTF';
  const html = /html/.test(type);
  return {
    ok,
    value: `GET ${GLB_URL}: HTTP ${res.status}, ${type}, ${(buf.byteLength / 1024).toFixed(1)} KB, first bytes ${JSON.stringify(magic)}${
      ok ? ' (binary glTF)' : html ? '; the server answered with the app page, so the file is not deployed and the torso is built from primitives' : ''}`,
  };
}

function route(path: string, name: string): Check {
  return {
    id: `route${path}`,
    what: `Route ${path} resolves (${name})`,
    async run() {
      const m = matchRoutes(ROUTES, path);
      const client = m?.[m.length - 1].route.path ?? null;
      const res = await fetch(path, { cache: 'no-store', headers: { accept: 'text/html' } });
      const type = res.headers.get('content-type') ?? 'no content type';
      const page = res.ok && /id="root"/.test(await res.text());
      return {
        ok: page && client === path,
        value: `server: HTTP ${res.status}, ${type}, ${page ? 'the app page' : 'NOT the app page'}; client: ${client === path ? `matches the ${name} page` : `matches ${client ?? 'nothing'}`}`,
      };
    },
  };
}

function mockRate(): Promise<Result> {
  return new Promise((resolve) => {
    const src = createMockSource({ state: 'live' });
    const times: number[] = [];
    const finish = () => {
      clearTimeout(giveUp);
      off();
      src.stop();
      if (times.length < 2) { resolve({ ok: false, value: `${times.length} frames in ${MOCK_WINDOW_MS / 1000} s after connecting` }); return; }
      const span = (times[times.length - 1] - times[0]) / 1000;
      const hz = (times.length - 1) / span;
      resolve({
        ok: Math.abs(hz - 10) <= 0.5,
        value: `${times.length} frames in ${span.toFixed(2)} s = ${hz.toFixed(2)} Hz (expected 10 Hz)${document.hidden ? '; the tab was hidden, which slows timers' : ''}`,
      });
    };
    const off = src.onFrame(() => {
      times.push(performance.now());
      if (times.length === 1) setTimeout(finish, MOCK_WINDOW_MS);
    });
    const giveUp = setTimeout(() => {
      if (times.length) return;  // frames started late; finish() reports them
      off();
      src.stop();
      resolve({ ok: false, value: `no frame within ${MOCK_WINDOW_MS / 1000 + 2} s of start` });
    }, MOCK_WINDOW_MS + 2000);
    log.ui.info('Self-test: starting a private copy of the mock stream; its session lines below are not the real session');
    src.start();
  });
}

function judgeFaults(): Result {
  const s = muted(() => {
    const j = createJudge();
    for (const f of recording.frames as Frame[]) j.push(toRaw(f));
    return summarize(j.events(), { status: 'summary' });
  });
  const got = s.faults.map((f) => f.code);
  const ok = got.length === KNOWN_FAULTS.length && KNOWN_FAULTS.every((c) => got.includes(c as never));
  return {
    ok,
    value: `${got.length} faults: ${s.faults.map((f) => `${f.eventId} ${f.code}`).join(', ') || 'none'}; expected ${KNOWN_FAULTS.join(', ')}. Also ${s.counts.thrusts} thrusts, ${s.counts.backBlows} back blows, reference spread ${s.reference.spread}`,
  };
}

async function clipboard(): Promise<Result> {
  const api = typeof navigator.clipboard?.writeText === 'function';
  let state = 'not queryable in this browser';
  try { state = (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state; } catch { /* Firefox and Safari do not expose it */ }
  return {
    ok: api && isSecureContext && state !== 'denied',
    value: `navigator.clipboard.writeText ${api ? 'present' : 'missing'}; clipboard-write permission ${state}; secure context ${yesNo(isSecureContext)}`,
  };
}

// Built on first use: PAGES comes from App.tsx, which imports this page, so it is not ready at load time.
let checks: Check[] | null = null;
const allChecks = (): Check[] => (checks ??= [
  { id: 'serial', what: 'Web Serial API present', run: async () => ({ ok: hasSerial(), value: `navigator.serial ${hasSerial() ? 'present' : 'missing'}; secure context ${yesNo(isSecureContext)}` }) },
  { id: 'webgl', what: 'WebGL present and not software-rendered', run: async () => webgl() },
  { id: 'glb', what: 'torso.glb reachable', run: glb },
  ...PAGES.map((p) => route(p.path, p.name)),
  { id: 'mock', what: 'Mock stream produces frames at 10 Hz', run: mockRate },
  { id: 'judge', what: 'judge.ts finds the 4 known faults in session.json', run: async () => judgeFaults() },
  { id: 'clipboard', what: 'Clipboard write permitted', run: clipboard },
]);

type Results = Record<string, Result | undefined>;

function report(results: Results, at: Date): string {
  const CHECKS = allChecks();
  const done = CHECKS.filter((c) => results[c.id]);
  const passed = done.filter((c) => results[c.id]!.ok).length;
  return [
    '=== CHOKESENSE SELF-TEST ===',
    `time: ${at.toISOString()}`,
    `url: ${location.href}`,
    `user agent: ${navigator.userAgent}`,
    '',
    ...CHECKS.flatMap((c) => {
      const r = results[c.id];
      return [`${r ? (r.ok ? 'PASS' : 'FAIL') : 'WAIT'}  ${c.what}`, `      value: ${r ? r.value : 'still running'}`];
    }),
    '',
    `result: ${passed} of ${CHECKS.length} passed${done.length < CHECKS.length ? `, ${CHECKS.length - done.length} still running` : ''}`,
    '=== END SELF-TEST ===',
  ].join('\n');
}

export function DiagPage() {
  const CHECKS = allChecks();
  const [results, setResults] = useState<Results>({});
  const [at, setAt] = useState(() => new Date());
  const [note, setNote] = useState('');
  const [manual, setManual] = useState<string | null>(null);

  const runAll = useCallback(() => {
    setResults({});
    setAt(new Date());
    setNote('');
    log.ui.info('Self-test started', { checks: allChecks().length });
    for (const c of allChecks()) {
      c.run().catch((e: unknown): Result => ({ ok: false, value: `the check itself threw: ${e instanceof Error ? e.message : String(e)}` })).then((r) => {
        (r.ok ? log.ui.info : log.ui.warn)(`Self-test ${r.ok ? 'PASS' : 'FAIL'}: ${c.what}`, { value: r.value });
        setResults((prev) => ({ ...prev, [c.id]: r }));
      });
    }
  }, []);

  useEffect(runAll, [runAll]);

  const done = CHECKS.filter((c) => results[c.id]).length;
  const failed = CHECKS.filter((c) => results[c.id] && !results[c.id]!.ok).length;

  const copy = async () => {
    const text = report(results, at);
    if (await copyText(text, 'Self-test report')) { setManual(null); setNote(`Copied ${text.split('\n').length} lines.`); }
    else { setManual(text); setNote('The browser blocked the clipboard. Select the text below and copy it by hand.'); }
  };

  return (
    <main className="page">
      <PageHead title="Self-test">
        <p>{done < CHECKS.length ? `Running, ${done} of ${CHECKS.length} done.` : failed ? `${failed} of ${CHECKS.length} checks failed.` : `All ${CHECKS.length} checks passed.`}</p>
      </PageHead>
      <div className="actions">
        <button type="button" className="btn" onClick={copy} disabled={done < CHECKS.length}>Copy report</button>
        <button type="button" className="btn btn-quiet" onClick={runAll} disabled={done < CHECKS.length}>Run again</button>
        <span className="note" aria-live="polite">{note}</span>
      </div>
      {manual != null && <textarea className="manual-copy" readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
      <div className="table-wrap section">
        <table className="table">
          <thead><tr><th className="label">Check</th><th className="label">Result</th><th className="label">Actual value</th></tr></thead>
          <tbody>
            {CHECKS.map((c) => {
              const r = results[c.id];
              return (
                <tr key={c.id} className={r && !r.ok ? 'fault' : ''}>
                  <td>{c.what}</td>
                  <td className="mono">{r ? (r.ok ? 'PASS' : 'FAIL') : 'running'}</td>
                  <td className="mono diag-value">{r ? r.value : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
