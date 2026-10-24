import {
  type NineReadings,
  type SensorId,
} from './sensors';

export type SpatialRegion = 'front' | 'back';

export type SpatialReference = {
  id: SensorId;
  x: number;
  y: number;
};

export type SpatialSamples = {
  front: Partial<Record<SensorId, number[]>>;
  back: Partial<Record<SensorId, number[]>>;
};

export type SpatialCell = {
  x: number;
  y: number;
  probability: number;
  density: number;
};

export type SpatialEstimate = {
  region: SpatialRegion;
  score: number;
  calibrated: boolean;
  estimate: { x: number; y: number };
  uncertainty: 'narrow' | 'moderate' | 'broad';
  correction: string;
  cells: SpatialCell[];
  cellSize: number;
};

export const SPATIAL_REFERENCES: Record<SpatialRegion, SpatialReference[]> = {
  front: [
    { id: 0, x: 184, y: 292 },
    { id: 1, x: 184, y: 244 },
    { id: 2, x: 184, y: 342 },
    { id: 3, x: 144, y: 295 },
    { id: 4, x: 224, y: 295 },
  ],
  back: [
    { id: 5, x: 184, y: 190 },
    { id: 6, x: 146, y: 238 },
    { id: 7, x: 222, y: 238 },
  ],
};

const REGIONS = {
  front: {
    minX: 119,
    maxX: 249,
    minY: 221,
    maxY: 360,
    sigma: 45,
    interpolationSigma: 21,
    targetX: 184,
    targetY: 292,
    targetRadiusX: 24,
    targetRadiusY: 29,
  },
  back: {
    minX: 122,
    maxX: 246,
    minY: 148,
    maxY: 281,
    sigma: 49,
    interpolationSigma: 26,
    targetX: 184,
    targetY: 190,
    targetRadiusX: 25,
    targetRadiusY: 29,
  },
};

const CELL_SIZE = 6;
const MODEL_NOISE = 0.12;

export function emptySpatialSamples(): SpatialSamples {
  return { front: {}, back: {} };
}

export function calibratedCount(
  region: SpatialRegion,
  samples: SpatialSamples,
): number {
  return SPATIAL_REFERENCES[region].filter(reference =>
    Array.isArray(samples[region][reference.id]),
  ).length;
}

export function hasSpatialCalibration(
  region: SpatialRegion,
  samples: SpatialSamples,
): boolean {
  return calibratedCount(region, samples) === SPATIAL_REFERENCES[region].length;
}

export function signalPattern(
  values: NineReadings,
  baseline: NineReadings,
  region: SpatialRegion,
): number[] {
  return SPATIAL_REFERENCES[region].map(({ id }) =>
    Math.max(0, values[id] - baseline[id]),
  );
}

export function simulatedContact(
  id: SensorId,
  baseline: NineReadings,
  amplitude = 2600,
): NineReadings {
  const result = [...baseline] as NineReadings;
  const region: SpatialRegion | null = id <= 4 ? 'front' : id <= 7 ? 'back' : null;

  if (region === null) {
    result[id] = Math.min(4095, baseline[id] + amplitude);
    return result;
  }

  const config = REGIONS[region];
  const position = SPATIAL_REFERENCES[region].find(reference => reference.id === id);

  if (!position) {
    return result;
  }

  for (const sensor of SPATIAL_REFERENCES[region]) {
    const distanceSquared =
      (sensor.x - position.x) ** 2 + (sensor.y - position.y) ** 2;
    const response = amplitude * Math.exp(
      -distanceSquared / (2 * config.sigma ** 2),
    );

    result[sensor.id] = Math.min(
      4095,
      Math.round(baseline[sensor.id] + response),
    );
  }

  return result;
}

function normalise(input: number[]): number[] {
  const norm = Math.hypot(...input);
  return norm > 1e-9 ? input.map(value => value / norm) : input.map(() => 0);
}

function prediction(
  x: number,
  y: number,
  region: SpatialRegion,
  samples: SpatialSamples,
): number[] {
  const references = SPATIAL_REFERENCES[region];
  const config = REGIONS[region];

  if (!hasSpatialCalibration(region, samples)) {
    return references.map(sensor => {
      const d2 = (sensor.x - x) ** 2 + (sensor.y - y) ** 2;
      return Math.exp(-d2 / (2 * config.sigma ** 2));
    });
  }

  const model = Array(references.length).fill(0) as number[];
  let weightSum = 0;

  for (const reference of references) {
    const sample = samples[region][reference.id];

    if (!sample || sample.length !== references.length) {
      continue;
    }

    const distanceSquared =
      (reference.x - x) ** 2 + (reference.y - y) ** 2;
    const weight = Math.exp(
      -distanceSquared / (2 * config.interpolationSigma ** 2),
    );
    const vector = normalise(sample);

    for (let index = 0; index < model.length; index++) {
      model[index] += weight * vector[index];
    }

    weightSum += weight;
  }

  if (weightSum === 0) {
    return references.map(() => 0);
  }

  const learned = normalise(model.map(value => value / weightSum));
  const geometric = normalise(references.map(sensor => {
    const distanceSquared = (sensor.x - x) ** 2 + (sensor.y - y) ** 2;
    return Math.exp(-distanceSquared / (2 * config.sigma ** 2));
  }));

  return geometric.map((value, index) =>
    0.72 * value + 0.28 * learned[index],
  );
}

function placementCorrection(
  region: SpatialRegion,
  x: number,
  y: number,
  uncertainty: SpatialEstimate['uncertainty'],
): string {
  if (uncertainty === 'broad') {
    return 'Placement is unclear from this contact. Reposition and try again.';
  }

  const config = REGIONS[region];
  const horizontal = x - config.targetX;
  const vertical = y - config.targetY;

  if (Math.abs(horizontal) <= 13 && Math.abs(vertical) <= 14) {
    return 'Estimated near the target area. Keep aiming at the highlighted region.';
  }

  if (Math.abs(horizontal) >= (region === 'back' ? 22 : 17)) {
    return horizontal < 0
      ? 'Contact appears left of target. Move towards the centre (right in this view).'
      : 'Contact appears right of target. Move towards the centre (left in this view).';
  }

  if (region === 'front') {
    return vertical < 0
      ? 'Contact appears too high. Move down towards the upper abdomen.'
      : 'Contact appears too low. Move up towards the upper abdomen.';
  }

  return vertical < 0
    ? 'Contact appears above the illustrated back target. Shift slightly downward.'
    : 'Contact appears below the illustrated back target. Shift upward between the shoulder blades.';
}

export function estimatePlacement(
  region: SpatialRegion,
  values: NineReadings,
  baseline: NineReadings,
  samples: SpatialSamples,
): SpatialEstimate | null {
  const observed = signalPattern(values, baseline, region);
  const signal = Math.hypot(...observed);

  if (signal < 1) {
    return null;
  }

  const z = normalise(observed);
  const config = REGIONS[region];
  const candidates: Array<{ x: number; y: number; error: number }> = [];
  let minError = Infinity;

  for (let y = config.minY; y <= config.maxY; y += CELL_SIZE) {
    for (let x = config.minX; x <= config.maxX; x += CELL_SIZE) {
      const k = prediction(x, y, region, samples);
      const kk = k.reduce((sum, value) => sum + value * value, 0);
      const kz = k.reduce((sum, value, index) => sum + value * z[index], 0);
      const amplitude = kk > 1e-12 ? Math.max(0, kz / kk) : 0;

      const residual = z.reduce(
        (sum, value, index) => sum + (value - amplitude * k[index]) ** 2,
        0,
      );

      const error = residual / (MODEL_NOISE ** 2);
      minError = Math.min(minError, error);
      candidates.push({ x, y, error });
    }
  }

  const sensorInfluenceSigma = 14;
  const fittedWeights = candidates.map(candidate =>
    Math.exp(-0.5 * (candidate.error - minError)),
  );
  const fittedTotal = fittedWeights.reduce((sum, weight) => sum + weight, 0);

  const kernelWeights = candidates.map(candidate =>
    SPATIAL_REFERENCES[region].reduce((sum, reference, index) => {
      const dx = candidate.x - reference.x;
      const dy = candidate.y - reference.y;
      const spatialInfluence = Math.exp(
        -(dx * dx + dy * dy) / (2 * sensorInfluenceSigma ** 2),
      );
      return sum + observed[index] * spatialInfluence;
    }, 0),
  );
  const kernelTotal = kernelWeights.reduce((sum, weight) => sum + weight, 0);
  const modelWeight = hasSpatialCalibration(region, samples) ? 0.20 : 0.15;

  const weights = candidates.map((_, index) =>
    (1 - modelWeight) * kernelWeights[index] / Math.max(1e-12, kernelTotal) +
    modelWeight * fittedWeights[index] / Math.max(1e-12, fittedTotal),
  );

  let mass = 0;
  let targetMass = 0;
  let weightedX = 0;
  let weightedY = 0;
  let squareMass = 0;
  let maxWeight = 0;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const weight = weights[index];
    mass += weight;
    squareMass += weight * weight;
    maxWeight = Math.max(weight, maxWeight);
    weightedX += candidate.x * weight;
    weightedY += candidate.y * weight;

    const dx = (candidate.x - config.targetX) / config.targetRadiusX;
    const dy = (candidate.y - config.targetY) / config.targetRadiusY;

    if (dx * dx + dy * dy <= 1) {
      targetMass += weight;
    }
  }

  if (mass <= 0) {
    return null;
  }

  const estimate = {
    x: weightedX / mass,
    y: weightedY / mass,
  };

  const effectiveCells = mass * mass / Math.max(1e-12, squareMass);
  const relativeSpread = effectiveCells / candidates.length;
  const uncertainty: SpatialEstimate['uncertainty'] =
    relativeSpread < 0.14 ? 'narrow' :
    relativeSpread < 0.35 ? 'moderate' : 'broad';

  return {
    region,
    calibrated: hasSpatialCalibration(region, samples),
    score: Math.max(0, Math.min(100, 100 * targetMass / mass)),
    estimate,
    uncertainty,
    correction: placementCorrection(region, estimate.x, estimate.y, uncertainty),
    cellSize: CELL_SIZE,
    cells: candidates.map((candidate, index) => ({
      x: candidate.x,
      y: candidate.y,
      density: weights[index] / mass,
      probability: weights[index] / Math.max(1e-12, maxWeight),
    })),
  };
}
