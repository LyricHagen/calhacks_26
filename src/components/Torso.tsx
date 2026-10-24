// The torso readout: the 3D model when WebGL works, the flat SVG pad drawing when
// it does not. The 3D code is its own chunk, so a browser without WebGL never
// downloads three.js.
import { Component, Suspense, lazy, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { SessionEvent } from '../../shared/mockStream.js';
import { hasWebGL, log } from '../debug';
import type { Pads, Phase } from '../judge';
import { ZoneMap } from './Parts';

const L = log['3d'];
const Scene = lazy(() => import('./Torso3D'));

export type PadId = keyof Pads;

export interface TorsoProps {
  /** Live pad readings, 0 to 1. */
  zones?: Partial<Pads>;
  /** Pads with a recorded fault. */
  faults?: Set<string>;
  /** Hit count per pad: summary mode. */
  counts?: Partial<Record<PadId, number>>;
  /** Faces the back during back blows, the front otherwise. */
  phase?: Phase;
  /** Every event so far; each newly closed thrust plays a pulse. */
  events?: SessionEvent[];
  /** Frames are flowing: keep the render loop running. */
  live?: boolean;
  /** Resting side when no phase drives the camera. */
  facing?: 'front' | 'back';
}

// Set once the 3D view fails, so pages can put back the text it replaced.
let failed = false;
const subs = new Set<() => void>();
function fail() { failed = true; subs.forEach((fn) => fn()); }

/** true while the 3D torso is the readout; pages drop text it already shows. */
export function useTorso3D(): boolean {
  return useSyncExternalStore((fn) => { subs.add(fn); return () => { subs.delete(fn); }; }, () => hasWebGL() && !failed);
}

class Boundary extends Component<{ children: ReactNode; fallback: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(err: unknown) {
    L.error('The 3D view crashed; showing the flat pad drawing instead', err);
    fail();
  }
  render() { return this.state.error ? this.props.fallback : this.props.children; }
}

export function Torso(props: TorsoProps) {
  const on = useTorso3D();
  useEffect(() => {
    if (!hasWebGL()) L.warn('WebGL is not available; showing the flat SVG pad drawing instead of the 3D torso', { fallback: 'svg' });
  }, []);
  const flat = <ZoneMap zones={props.zones} faults={props.faults} counts={props.counts} />;
  if (!on) return flat;
  return (
    <Boundary fallback={flat}>
      <Suspense fallback={<div className="torso3d" />}>
        <Scene {...props} onFail={fail} />
      </Suspense>
    </Boundary>
  );
}
