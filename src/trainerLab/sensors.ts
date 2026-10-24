export const ADC_MAX = 4095;
export const RAW_THRESHOLD = 650;

export const SENSOR_KEYS = [
  'front_target',
  'front_high',
  'front_low',
  'front_left',
  'front_right',
  'back_target',
  'back_left',
  'back_right',
  'cpr_sternum',
] as const;

export const SENSOR_NAMES = [
  'Target abdomen',
  'Too high',
  'Too low',
  'Front left',
  'Front right',
  'Centre back — between shoulder blades',
  'Back left — off target',
  'Back right — off target',
  'CPR — sternum',
] as const;

export type SensorId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type NineReadings = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type ActionType = 'front' | 'back' | 'cpr';

export type DetectedAction = {
  type: ActionType;
  sensor: SensorId;
  peak: number;
  time: number;
  durationMs: number;
  bothCpr: boolean;
  pattern: NineReadings;
};

export type NineFrame = {
  readings: NineReadings;
  peaks: NineReadings;
  deviceTimeMs: number | null;
};

export type NineMessage =
  | { kind: 'hello'; hz: number; names: string[] }
  | { kind: 'frame'; frame: NineFrame };

export const EMPTY: NineReadings = [0, 0, 0, 0, 0, 0, 0, 0, 0];

export function emptyReadings(): NineReadings {
  return [...EMPTY] as NineReadings;
}

export function clampADC(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(ADC_MAX, Math.round(value)));
}

function isRawArray(value: unknown): value is NineReadings {
  return (
    Array.isArray(value) &&
    value.length === 9 &&
    value.every(
      item =>
        typeof item === 'number' &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= ADC_MAX,
    )
  );
}

export class NineSensorProtocol {
  private wireToLogical: SensorId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  parseLine(line: string): NineMessage | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const data = parsed as Record<string, unknown>;

    if ('hello' in data) {
      if (
        data.hello !== 'chokesense-9fsr' ||
        !Array.isArray(data.pads) ||
        data.pads.length !== 9 ||
        !data.pads.every(pad => typeof pad === 'string')
      ) {
        return null;
      }

      const order = data.pads.map(pad =>
        (SENSOR_KEYS as readonly string[]).indexOf(pad),
      );

      if (order.some(index => index < 0) || new Set(order).size !== 9) {
        return null;
      }

      this.wireToLogical = order as SensorId[];

      return {
        kind: 'hello',
        hz:
          typeof data.hz === 'number' && Number.isFinite(data.hz)
            ? data.hz
            : 0,
        names: [...data.pads],
      };
    }

    if (data.schema !== undefined && data.schema !== 'fsr9-v1') {
      return null;
    }

    const raw = data.fsr ?? data.fsrs ?? data.pads;
    const peak = data.peak === undefined ? raw : data.peak;

    if (!isRawArray(raw) || !isRawArray(peak)) {
      return null;
    }

    const readings = emptyReadings();
    const peaks = emptyReadings();

    for (let wire = 0; wire < 9; wire++) {
      const logical = this.wireToLogical[wire];
      readings[logical] = raw[wire];
      peaks[logical] = Math.max(raw[wire], peak[wire]);
    }

    return {
      kind: 'frame',
      frame: {
        readings,
        peaks,
        deviceTimeMs:
          typeof data.t === 'number' &&
            Number.isFinite(data.t) &&
            data.t >= 0
            ? data.t
            : null,
      },
    };
  }
}

export function parseNineFrame(line: string): NineReadings | null {
  const message = new NineSensorProtocol().parseLine(line);
  return message?.kind === 'frame' ? message.frame.readings : null;
}

type Group = {
  type: ActionType;
  ids: SensorId[];
};

const GROUPS: Group[] = [
  { type: 'front', ids: [0, 1, 2, 3, 4] },
  { type: 'back', ids: [5, 6, 7] },
  { type: 'cpr', ids: [8] },
];

type DetectorState = {
  active: boolean;
  peak: number;
  best: SensorId;
  pattern: NineReadings;
  patternEnergy: number;
  started: number;
  lastEnd: number;
};

function initialStates(): DetectorState[] {
  return GROUPS.map(group => ({
    active: false,
    peak: 0,
    best: group.ids[0],
    pattern: emptyReadings(),
    patternEnergy: 0,
    started: 0,
    lastEnd: -Infinity,
  }));
}

export class NineSensorDetector {
  private states = initialStates();

  reset(): void {
    this.states = initialStates();
  }

  process(
    values: NineReadings,
    baseline: NineReadings,
    time: number,
    contactDelta = RAW_THRESHOLD,
    peaks: NineReadings = values,
  ): DetectedAction[] {
    const events: DetectedAction[] = [];
    const threshold = Math.max(1, contactDelta);
    const releaseThreshold = Math.max(30, threshold * 0.38);

    GROUPS.forEach((group, index) => {
      const state = this.states[index];

      const ranked = group.ids
        .map(id => ({
          id,
          peak: Math.max(0, peaks[id] - baseline[id]),
          live: Math.max(0, values[id] - baseline[id]),
        }))
        .sort((a, b) => b.peak - a.peak);

      const strongest = ranked[0];
      const liveMax = Math.max(...ranked.map(item => item.live));
      const snapshot = emptyReadings();
      let snapshotEnergy = 0;

      for (const id of group.ids) {
        snapshot[id] = Math.max(values[id], peaks[id]);
        snapshotEnergy += Math.max(0, snapshot[id] - baseline[id]);
      }

      if (!state.active) {
        if (
          strongest.peak >= threshold &&
          time - state.lastEnd >= 200
        ) {
          state.active = true;
          state.peak = strongest.peak;
          state.best = strongest.id;
          state.pattern = snapshot;
          state.patternEnergy = snapshotEnergy;
          state.started = time;
        }

        return;
      }

      if (snapshotEnergy > state.patternEnergy) {
        state.pattern = snapshot;
        state.patternEnergy = snapshotEnergy;
      }

      if (strongest.peak > state.peak) {
        state.peak = strongest.peak;
        state.best = strongest.id;
      }

      if (liveMax <= releaseThreshold) {
        events.push({
          type: group.type,
          sensor: group.ids.reduce((best, id) =>
            state.pattern[id] - baseline[id] > state.pattern[best] - baseline[best]
              ? id
              : best,
          group.ids[0]),
          peak: state.peak,
          time,
          durationMs: Math.max(0, time - state.started),
          bothCpr: false,
          pattern: [...state.pattern] as NineReadings,
        });

        state.active = false;
        state.lastEnd = time;
        state.peak = 0;
        state.patternEnergy = 0;
      }
    });

    return events;
  }
}
