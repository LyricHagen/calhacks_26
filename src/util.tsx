import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link, useLocation, type LinkProps } from 'react-router-dom';
import type { BackBlowEvent, SessionEvent, ThrustEvent } from '../shared/mockStream.js';

/** Query string that carries ?state= and ?theme= onto every internal link. */
export function useCarry(): string {
  const q = new URLSearchParams(useLocation().search);
  const out = new URLSearchParams();
  for (const k of ['state', 'theme']) { const v = q.get(k); if (v) out.set(k, v); }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function QLink({ to, ...rest }: Omit<LinkProps, 'to'> & { to: string }) {
  const carry = useCarry();
  const [pathname, hash = ''] = to.split('#');
  return <Link to={{ pathname, search: carry, hash: hash ? `#${hash}` : '' }} {...rest} />;
}

/** ?theme= wins; without it, follow the system preference. */
export function useTheme(): 'light' | 'dark' {
  const q = new URLSearchParams(useLocation().search).get('theme');
  if (q === 'dark' || q === 'light') return q;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Container width in CSS pixels, for SVGs drawn at true size. */
export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.clientWidth)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export const f1 = (x: number | null | undefined) => (x == null ? '--' : x.toFixed(1));
export const f2 = (x: number | null | undefined) => (x == null ? '--' : x.toFixed(2));

export const isThrust = (e: SessionEvent): e is ThrustEvent => e.type === 'thrust';
export const isRef = (e: SessionEvent): e is ThrustEvent => e.type === 'reference';
export const isBlow = (e: SessionEvent): e is BackBlowEvent => e.type === 'backblow';
export const timeOf = (e: SessionEvent) => (isBlow(e) ? e.t : e.tStart);

/** Entry tag: T07, B12, R2. */
export function tag(e: { type: string; n: number }): string {
  if (e.type === 'reference') return `R${e.n}`;
  return `${e.type === 'thrust' ? 'T' : 'B'}${String(e.n).padStart(2, '0')}`;
}

export const PHASE: Record<string, string> = {
  rest: 'Rest',
  calibrating: 'Reference',
  backblows: 'Back blows',
  thrusts: 'Thrusts',
  complete: 'Complete',
};

/** Zones that carry a placement fault, for marking on the zone map. */
export function faultZones(events: SessionEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    if (e.open) continue;
    for (const f of e.faults) {
      if (f === 'placement-high') s.add('high');
      else if (f === 'placement-low') s.add('low');
      else if (f === 'placement-side') s.add('side');
      else if (f === 'blow-off-target') s.add('back');
    }
  }
  return s;
}
