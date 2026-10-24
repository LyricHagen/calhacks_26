/** Nine FSR inputs. Array positions are LOGICAL positions, independent of GPIO numbers. */
export const ADC_MAX = 4095;
export const RAW_THRESHOLD = 650; // Demo-only change-from-baseline threshold, not a force threshold.
export const SENSOR_KEYS = [
  'front_target', 'front_high', 'front_low', 'front_left', 'front_right',
  'back_target', 'back_off_target', 'cpr_left', 'cpr_right',
] as const;
export const SENSOR_NAMES = [
  'Target abdomen', 'Too high', 'Too low', 'Left of target', 'Right of target',
  'Between shoulder blades', 'Off-target back', 'CPR left pad', 'CPR right pad',
] as const;
export type SensorId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type NineReadings = [number, number, number, number, number, number, number, number, number];
export type ActionType = 'front' | 'back' | 'cpr';
export type DetectedAction = { type: ActionType; sensor: SensorId; peak: number; time: number; bothCpr: boolean; durationMs: number };
export type NineFrame = { readings: NineReadings; peaks: NineReadings; deviceTimeMs: number | null };
export type NineMessage = { kind: 'hello'; hz: number; names: string[] } | { kind: 'frame'; frame: NineFrame };
export const EMPTY: NineReadings = [0, 0, 0, 0, 0, 0, 0, 0, 0];
export const emptyReadings = (): NineReadings => [...EMPTY] as NineReadings;
export const clampADC = (v: number): number => Number.isFinite(v) ? Math.max(0, Math.min(ADC_MAX, Math.round(v))) : 0;
function rawArray(a: unknown): a is NineReadings {
  return Array.isArray(a) && a.length === 9 && a.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ADC_MAX);
}
export class NineSensorProtocol {
  private wireToLogical: SensorId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  parseLine(line: string): NineMessage | null {
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const o = obj as Record<string, unknown>;
    if ('hello' in o) {
      if (o.hello !== 'chokesense-9fsr' || !Array.isArray(o.pads) || o.pads.length !== 9 || !o.pads.every((p) => typeof p === 'string')) return null;
      const order = o.pads.map((p) => (SENSOR_KEYS as readonly string[]).indexOf(p));
      if (order.some((i) => i < 0) || new Set(order).size !== 9) return null;
      this.wireToLogical = order as SensorId[];
      return { kind: 'hello', hz: typeof o.hz === 'number' && Number.isFinite(o.hz) ? o.hz : 0, names: [...o.pads] };
    }
    if (o.schema !== undefined && o.schema !== 'fsr9-v1') return null;
    const raw = o.fsr ?? o.fsrs ?? o.pads;
    if (!rawArray(raw)) return null;
    const peak = o.peak === undefined ? raw : o.peak;
    if (!rawArray(peak)) return null;
    const readings = emptyReadings(), peaks = emptyReadings();
    for (let wire = 0; wire < 9; wire++) {
      const logical = this.wireToLogical[wire];
      readings[logical] = raw[wire];
      peaks[logical] = Math.max(raw[wire], peak[wire]);
    }
    return { kind: 'frame', frame: {
      readings, peaks, deviceTimeMs: typeof o.t === 'number' && Number.isFinite(o.t) && o.t >= 0 ? o.t : null,
    } };
  }
}
export function parseNineFrame(line: string): NineReadings | null {
  const message = new NineSensorProtocol().parseLine(line);
  return message?.kind === 'frame' ? message.frame.readings : null;
}
type Group = { type: ActionType; ids: SensorId[] };
const GROUPS: Group[] = [
  { type: 'front', ids: [0, 1, 2, 3, 4] }, { type: 'back', ids: [5, 6] }, { type: 'cpr', ids: [7, 8] },
];
type DetectorState = { active: boolean; peak: number; best: SensorId; cprBoth: boolean; started: number; lastEnd: number };
const initialStates = (): DetectorState[] => GROUPS.map((g) => ({ active: false, peak: 0, best: g.ids[0], cprBoth: false, started: 0, lastEnd: -Infinity }));
/** Classifies physical CONTACT/RELEASE patterns; cannot determine medically effective force/depth. */
export class NineSensorDetector {
  private states = initialStates();
  reset() { this.states = initialStates(); }
  process(values: NineReadings, baseline: NineReadings, time: number, contactDelta = RAW_THRESHOLD, peaks: NineReadings = values): DetectedAction[] {
    const events: DetectedAction[] = [];
    const threshold = Math.max(1, contactDelta);
    const release = Math.max(30, threshold * 0.38);
    GROUPS.forEach((group, idx) => {
      const state = this.states[idx];
      const ranked = group.ids.map((id) => ({ id, peak: Math.max(0, peaks[id] - baseline[id]), live: Math.max(0, values[id] - baseline[id]) }));
      ranked.sort((a, b) => b.peak - a.peak);
      const strongest = ranked[0];
      const liveMax = Math.max(...ranked.map((r) => r.live));
      const bothCpr = group.type === 'cpr' && group.ids.every((id) => Math.max(0, values[id] - baseline[id]) >= threshold * 0.65);
      if (!state.active) {
        if (strongest.peak >= threshold && time - state.lastEnd >= 200) {
          state.active = true; state.peak = strongest.peak; state.best = strongest.id;
          state.cprBoth = bothCpr; state.started = time;
        }
        return;
      }
      if (strongest.peak > state.peak) { state.peak = strongest.peak; state.best = strongest.id; }
      if (bothCpr) state.cprBoth = true;
      if (liveMax <= release) {
        events.push({ type: group.type, sensor: state.best, peak: state.peak, time, bothCpr: state.cprBoth, durationMs: Math.max(0, time - state.started) });
        state.active = false; state.lastEnd = time; state.peak = 0; state.cprBoth = false;
      }
    });
    return events;
  }
}
