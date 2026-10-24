import { useMemo, useSyncExternalStore } from 'react';
import { LABELS, summarize } from '../../shared/mockStream.js';
import { Empty, ErrorBanner, Lines, PageHead, Skel } from '../components/Common';
import { EventTable } from '../components/Parts';
import { Torso } from '../components/Torso';
import { downloadSessionFile, lastSession, onLastSession } from '../sessionFile';
import { useAutoStart, useSnapshot, useStore } from '../stream';
import { QLink, f1, f2, faultZones } from '../util';

export function SummaryPage() {
  const store = useStore();
  const snap = useSnapshot();
  const last = useSyncExternalStore(onLastSession, lastSession);
  // Nothing has started since the last run ended (a new source, or a reload): show that run.
  const fromMemory = store.state === 'live' && snap.status === 'idle' && last != null ? last : null;
  useAutoStart(!fromMemory);
  const status = fromMemory ? 'summary' : snap.status;
  const events = fromMemory ? fromMemory.events : snap.events;
  const t = fromMemory ? fromMemory.summary.t : snap.t;
  const sum = useMemo(() => summarize(status === 'loading' || status === 'empty' ? [] : events, { status, t }), [events, status, t]);
  const loading = status === 'loading' || status === 'idle';
  const faults = useMemo(() => faultZones(events), [events]);
  const canSave = fromMemory != null || store.raw.length > 0;
  const save = () => downloadSessionFile(fromMemory ?? store.exportSession());
  const endedAt = fromMemory?.savedAt ? new Date(fromMemory.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const counts: [string, string | number, boolean?][] = [
    ['Thrusts', sum.counts.thrusts],
    ['Back blows', sum.counts.backBlows],
    ['Cycles', sum.counts.cycles],
    ['Faults', sum.faults.length, sum.faults.length > 0],
  ];
  const rows: [string, string | number, boolean?][] = [
    [LABELS.strength.similar, `${sum.peaks.withinSimilarBand} of ${sum.counts.thrusts}`],
    [LABELS.strength.weak, sum.strength.weak, sum.strength.weak > 0],
    [LABELS.strength.strong, sum.strength.strong, sum.strength.strong > 0],
    ['Not released', sum.released.no, sum.released.no > 0],
    [LABELS.blow.false, sum.backBlows.offTarget, sum.backBlows.offTarget > 0],
    ['Reference spread', f2(sum.reference.spread)],
    ['Angle range, ungraded', sum.angle.min != null ? `${Math.round(sum.angle.min)}° to ${Math.round(sum.angle.max ?? 0)}°` : '--'],
  ];

  return (
    <main className="page">
      <PageHead title="Summary" />
      {!fromMemory && <ErrorBanner snap={snap} />}
      {status === 'live' && <div className="banner"><p>Still recording at <span className="mono">{f1(snap.t)} s</span>.</p></div>}
      {fromMemory && <div className="banner"><p>The last session{endedAt && <>, ended <span className="mono">{endedAt}</span></>}, from {fromMemory.source.meta.name}.</p></div>}
      {canSave && (
        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={save}>Save session</button>
          <span className="note">One JSON file with every frame and entry. Load it from the Connect page to replay it.</span>
        </div>
      )}

      {loading ? <><Skel h={60} /><Lines n={8} /></> : status === 'empty' ? (
        <Empty>No session recorded. <QLink to="/">Connect</QLink>.</Empty>
      ) : (
        <>
          <dl className="readouts">
            {counts.map(([k, v, f]) => <div key={k} className={f ? 'fault' : ''}><dt className="label">{k}</dt><dd className="big">{v}</dd></div>)}
          </dl>

          <div className="grid">
            <section>
              <h2 className="h-small">Hits per pad</h2>
              <Torso faults={faults} counts={{ target: sum.zones.target, high: sum.zones.high, low: sum.zones.low, side: sum.zones.side, back: sum.backBlows.onTarget }} />
              <p className="note">Off the torso: <span className="mono">{sum.zones.off}</span></p>
            </section>
            <section>
              <h2 className="h-small">Against the reference</h2>
              <table className="table">
                <tbody>{rows.map(([k, v, f]) => <tr key={k} className={f ? 'fault' : ''}><th className="label">{k}</th><td className="mono">{v}</td></tr>)}</tbody>
              </table>
              <h2 className="h-small">5 and 5 sequence</h2>
              <p className={sum.sequence.held ? '' : 'fault'}>
                {sum.sequence.held ? `Held, ${sum.sequence.cyclesCompleted} cycles complete.` : `Broken, ${sum.sequence.breaks.length} out of order.`}
              </p>
            </section>
          </div>

          <section className="section">
            <h2 className="h-small">Faults</h2>
            {sum.faults.length ? (
              <ol className="faults">
                {sum.faults.map((f) => (
                  <li key={`${f.eventId}-${f.code}`}>
                    <span className="fault">{f.label}</span>
                    <a href={`#ev-${f.eventId}`}>{f.type === 'thrust' ? 'Thrust' : 'Back blow'} {f.index}, cycle {f.cycle}</a>
                    <span className="mono dim">{f1(f.t)} s</span>
                  </li>
                ))}
              </ol>
            ) : <Empty>No faults recorded.</Empty>}
          </section>

          <section className="section">
            <h2 className="h-small">All entries</h2>
            <EventTable events={events} order="asc" />
          </section>
        </>
      )}
    </main>
  );
}
