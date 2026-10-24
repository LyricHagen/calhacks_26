import { LABELS, THRESHOLDS, checkSequence } from '../../shared/mockStream.js';
import type { FaultCode, Frame, SessionEvent } from '../../shared/mockStream.js';
import { f1, f2, isBlow, tag, timeOf, useWidth } from '../util';

// ---------------------------------------------------------------------------
// Zone map: the manikin, hips up with arms hanging just past the torso, seen
// from the front (thrust pads) and the back (back-blow pad). This flat drawing
// is the fallback for the 3D torso (Torso.tsx) when WebGL is unavailable.
// Solid orange is contact now; an orange outline is a fault recorded there.
// ---------------------------------------------------------------------------
type PadId = 'target' | 'high' | 'low' | 'side' | 'back';

// Silhouette in a 240 x 340 box, drawn as the left half and mirrored.
const mirror = (d: string) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${240 - Number(x)},${y}`);
const TORSO =
  'M110,58 L110,72 C94,76 74,78 64,90 L72,118 C74,160 78,190 82,215 C80,240 78,270 80,300 ' +
  'L160,300 C162,270 160,240 158,215 C162,190 166,160 168,118 L176,90 C166,78 146,76 130,72 L130,58 Z';
const ARM = 'M64,90 C52,94 46,104 46,118 L42,250 C40,280 40,305 44,322 C48,334 62,334 63,322 L66,250 L68,128 C68,110 68,98 64,90 Z';

const FRONT: { id: PadId; label: string; x: number; y: number; w: number; h: number; count?: boolean }[] = [
  { id: 'high', label: 'H', x: 102, y: 148, w: 36, h: 26, count: true },
  { id: 'target', label: 'T', x: 102, y: 180, w: 36, h: 34, count: true },
  { id: 'low', label: 'L', x: 102, y: 234, w: 36, h: 26, count: true },
  { id: 'side', label: 'S', x: 81, y: 180, w: 16, h: 34, count: true },
  { id: 'side', label: 'S', x: 143, y: 180, w: 16, h: 34 },
];
const BACK = [{ id: 'back' as PadId, label: 'B', x: 102, y: 106, w: 36, h: 48, count: true }];

export function ZoneMap({ zones, faults, counts }: {
  zones?: Partial<Record<PadId, number>>;
  faults?: Set<string>;
  counts?: Partial<Record<PadId, number>>;
}) {
  const view = (title: string, pads: typeof FRONT, front: boolean) => (
    <figure className="torso-view">
      <svg viewBox="0 0 240 340" role="img" aria-label={`Manikin, ${title.toLowerCase()} view`}>
        <ellipse cx={120} cy={32} rx={22} ry={27} className="body" />
        <path d={ARM} className="body" />
        <path d={mirror(ARM)} className="body" />
        <path d={TORSO} className="body" />
        {front
          ? <><path d="M120,140 L120,290" className="landmark" /><circle cx={120} cy={224} r={2.5} className="landmark" /></>
          : <><path d="M120,76 L120,295" className="landmark" /><path d="M104,96 C90,100 84,120 92,150 M136,96 C150,100 156,120 148,150" className="landmark" /></>}
        {pads.map((p, i) => {
          const lit = (zones?.[p.id] ?? 0) >= THRESHOLDS.zoneOff;
          return (
            <g key={i} className={['pad', lit ? 'is-lit' : '', faults?.has(p.id) ? 'is-fault' : ''].join(' ')}>
              <rect x={p.x} y={p.y} width={p.w} height={p.h} />
              <text x={p.x + 3} y={p.y + 9} className="pad-letter">{p.label}</text>
              {counts && p.count && <text x={p.x + p.w / 2} y={p.y + p.h - 5} textAnchor="middle" className="pad-count">{counts[p.id] ?? 0}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="label">{title}</figcaption>
    </figure>
  );
  return (
    <div className="torso">
      {view('Front', FRONT, true)}
      {view('Back', BACK, false)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5 and 5 tracker: one row per cycle, five back blows then five thrusts. Boxes only.
// ---------------------------------------------------------------------------
export function Tracker({ events }: { events: SessionEvent[] }) {
  const seq = checkSequence(events);
  const steps = events.filter((e) => e.type !== 'reference');
  const breaks = new Set(seq.breaks.map((b) => b.eventId));
  const cycles = Math.max(1, ...steps.map((e) => e.cycle));
  const cell = (c: number, type: 'backblow' | 'thrust', i: number) => {
    const e = steps.find((x) => x.cycle === c && x.type === type && x.index === i);
    const fault = e && !e.open && (e.faults.length > 0 || breaks.has(e.id));
    return <span key={type + i} className={`tk-cell ${e ? (fault ? 'is-fault' : 'is-done') : ''}`} />;
  };
  return (
    <div className="tracker" role="img" aria-label={`5 and 5 sequence, ${seq.held ? 'held' : 'broken'}`}>
      {Array.from({ length: cycles }, (_, k) => k + 1).map((c) => (
        <div key={c} className="tk-row">
          <span className="tk-cells">{[1, 2, 3, 4, 5].map((i) => cell(c, 'backblow', i))}</span>
          <span className="tk-cells">{[1, 2, 3, 4, 5].map((i) => cell(c, 'thrust', i))}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Latest entry: the thrust or back blow being judged, or the last one closed.
// ---------------------------------------------------------------------------
/** `placement` false drops the placement field when the torso view already shows it. */
export function LatestEntry({ e, frame, placement = true }: { e: SessionEvent | undefined; frame: Frame | null; placement?: boolean }) {
  const angle = frame?.angle ?? (e && !isBlow(e) ? e.angle : null);
  if (!e) return null;
  return (
    <div className="latest">
      <div className="latest-top">
        <span className="latest-tag">{tag(e)}</span>
        <span className="dim">{isBlow(e) ? 'Back blow' : 'Abdominal thrust'}, cycle {e.cycle} no. {e.index}, at {f1(timeOf(e))} s{e.open ? ', judging' : ''}</span>
      </div>
      <dl className="fields">
        {isBlow(e) ? (
          placement && <Field k="Placement" v={e.onTarget == null ? 'Reading' : LABELS.blow[`${e.onTarget}`]} fault={has(e, 'blow-off-target')} />
        ) : (
          <>
            {placement && <Field k="Placement" v={e.zone ? LABELS.zone[e.zone] : 'Reading'} fault={has(e, 'placement-high', 'placement-low', 'placement-side', 'placement-off')} />}
            <Field k="Strength" v={`${e.strength ? LABELS.strength[e.strength] : 'Reading'} (${f2(e.peak)})`} fault={has(e, 'weak', 'strong')} />
            <Field k="Release" v={e.released == null ? 'Still pressed' : LABELS.released[`${e.released}`]} fault={has(e, 'not-released')} />
            <Field k="Abruptness" v={e.abrupt == null ? 'Reading' : LABELS.abrupt[`${e.abrupt}`]} fault={has(e, 'not-abrupt')} />
          </>
        )}
        <Field k="Angle, ungraded" v={angle == null ? '--' : `${Math.round(angle)}°`} />
      </dl>
    </div>
  );
}

function Field({ k, v, fault }: { k: string; v: string; fault?: boolean }) {
  return <div className={fault ? 'fault' : ''}><dt className="label">{k}</dt><dd>{v}</dd></div>;
}

function has(e: SessionEvent, ...codes: FaultCode[]) {
  return !e.open && e.faults.some((f) => codes.includes(f));
}

// ---------------------------------------------------------------------------
// Event table: every entry as one row.
// ---------------------------------------------------------------------------
export function EventTable({ events, order }: { events: SessionEvent[]; order: 'asc' | 'desc' }) {
  const list = [...events].sort((a, b) => timeOf(a) - timeOf(b));
  if (order === 'desc') list.reverse();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{['Entry', 'Time', 'Placement', 'Strength vs reference', 'Release', 'Angle, ungraded', 'Faults'].map((h) => <th key={h} className="label">{h}</th>)}</tr>
        </thead>
        <tbody>
          {list.map((e) => (
            <tr key={e.id} id={`ev-${e.id}`} className={e.open ? 'dim' : ''}>
              <td className="mono">{tag(e)}</td>
              <td className="mono">{f1(timeOf(e))} s</td>
              {isBlow(e) ? (
                <>
                  <td>{e.onTarget == null ? 'Reading' : LABELS.blow[`${e.onTarget}`]}</td>
                  <td className="dim" colSpan={3}>Not judged for back blows</td>
                </>
              ) : (
                <>
                  <td>{e.zone ? LABELS.zone[e.zone] : 'Reading'}</td>
                  <td>{e.type === 'reference' ? 'Reference' : e.strength ? LABELS.strength[e.strength] : 'Reading'} <span className="mono dim">{f2(e.peak)}</span></td>
                  <td>{e.released == null ? 'Still pressed' : LABELS.released[`${e.released}`]}</td>
                  <td className="mono">{e.angle == null ? '--' : `${Math.round(e.angle)}°`}</td>
                </>
              )}
              <td className="fault">{e.open ? '' : e.faults.map((f) => LABELS.fault[f]).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fist force trace: the last 12 s of frames, with the reference and the release line.
// ---------------------------------------------------------------------------
const YMAX = 1.6;
const WINDOW = 12;

export function Trace({ frames, t }: { frames: Frame[]; t: number }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = 160;
  const m = { l: 36, r: 4, t: 8, b: 8 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const x1 = Math.max(t, WINDOW);
  const x0 = x1 - WINDOW;
  const X = (s: number) => m.l + ((s - x0) / WINDOW) * iw;
  const Y = (v: number) => m.t + ih - (Math.min(v, YMAX) / YMAX) * ih;
  const pts = frames.filter((f) => f.t >= x0).map((f) => `${X(f.t).toFixed(1)},${Y(f.fist).toFixed(1)}`).join(' ');
  return (
    <div ref={ref} className="trace">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fist force, last 12 seconds">
        <rect x={m.l} y={m.t} width={iw} height={ih} className="frame" />
        {[0, 1].map((v) => <text key={v} x={m.l - 6} y={Y(v) + 5} textAnchor="end" className="axis">{v.toFixed(1)}</text>)}
        <line x1={m.l} x2={m.l + iw} y1={Y(1)} y2={Y(1)} className="thr-ref" />
        <line x1={m.l} x2={m.l + iw} y1={Y(THRESHOLDS.thrustEnd)} y2={Y(THRESHOLDS.thrustEnd)} className="thr" />
        {pts && <polyline points={pts} className="wave" />}
      </svg>
    </div>
  );
}
