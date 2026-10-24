// Auto-advance logging for the connect, calibrate and session screens. Every
// advance logs the screen, the condition that fired and the values behind it.
// A watchdog warns when an expected advance has not fired within 10 s, naming
// the condition and the values at that moment, so a stuck screen can be read
// from the log alone.
import { useEffect, useRef } from 'react';
import { log, type Fields } from './debug';

export const L = log['ui/session'];
export const STUCK_MS = 10_000;
/** Calibrate opens /session this long after the third reference thrust. */
export const COUNTDOWN_MS = 2000;

export function advanced(screen: string, condition: string, values: Fields = {}) {
  L.info(`Auto-advance on ${screen}: ${condition}`, { screen, condition, ...values });
}

/** While `waiting` holds, warn every 10 s that `condition` has not fired. A new `key` restarts the clock. */
export function useWatchdog(waiting: boolean, key: string, screen: string, condition: string, values: () => Fields) {
  const read = useRef(values);
  read.current = values;
  useEffect(() => {
    if (!waiting) return;
    const since = Date.now();
    const id = setInterval(() => {
      L.warn(`Expected auto-advance on ${screen} has not fired: ${condition}`, {
        screen, condition, waited_s: Math.round((Date.now() - since) / 1000), ...read.current(),
      });
    }, STUCK_MS);
    return () => clearInterval(id);
  }, [waiting, key, screen, condition]);
}

export const variance = (xs: number[]) => {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};
