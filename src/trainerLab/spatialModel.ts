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
    targetRadiusX: 30,
    targetRadiusY: 35,
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
    targetRadiusX: 30,
    targetRadiusY: 36,
  },
};

const CELL_SIZE = 6;
const MODEL_NOISE = 0.12;

export const SPATIAL_SETTINGS = {
  noiseFloorAdc: 35,
  relativeNoiseFloor: 0.06,
  signalExponent: 0.85,
  frontKernelWidth: 21,
  backKernelWidth: 23,
  pairDistanceLimit: 85,
  pairMinimumResponse: 0.12,
  borderlineScore: 35,
  acceptanceScore: 54,
} as const;

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

  const knownReference = references.find(reference =>
    Math.hypot(reference.x - x, reference.y - y) <= CELL_SIZE / 2,
  );
  const knownSample = knownReference
    ? samples[region][knownReference.id]
    : null;

  if (knownSample?.length === references.length) {
    return normalise(knownSample);
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
    0.30 * value + 0.70 * learned[index],
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
  const maximum = Math.max(...observed);

  if (maximum < 1) {
    return null;
  }

  const noiseFloor = Math.max(
    SPATIAL_SETTINGS.noiseFloorAdc,
    maximum * SPATIAL_SETTINGS.relativeNoiseFloor,
  );
  const cleaned = observed.map(value => Math.max(0, value - noiseFloor));
  const cleanedMax = Math.max(...cleaned);

  if (cleanedMax < 1) {
    return null;
  }

  const responses = cleaned.map(value =>
    Math.pow(value / cleanedMax, SPATIAL_SETTINGS.signalExponent),
  );
  const responseTotal = responses.reduce((sum, value) => sum + value, 0);
  const responseSquares = responses.reduce(
    (sum, value) => sum + value * value,
    0,
  );
  const effectiveSensors = responseTotal * responseTotal /
    Math.max(1e-12, responseSquares);

  const references = SPATIAL_REFERENCES[region];
  const config = REGIONS[region];
  const centre = {
    x: references.reduce(
      (sum, reference, index) => sum + responses[index] * reference.x,
      0,
    ) / responseTotal,
    y: references.reduce(
      (sum, reference, index) => sum + responses[index] * reference.y,
      0,
    ) / responseTotal,
  };

  const candidates: Array<{ x: number; y: number; error: number }> = [];
  const z = normalise(cleaned);
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

      candidates.push({ x, y, error });
      minError = Math.min(minError, error);
    }
  }

  const sigma = (region === 'front'
    ? SPATIAL_SETTINGS.frontKernelWidth
    : SPATIAL_SETTINGS.backKernelWidth) +
    (effectiveSensors < 1.3 ? 2.5 : 0);
  const fusedSigma = sigma * 0.93;
  const gaussian = (
    x: number,
    y: number,
    cx: number,
    cy: number,
    width: number,
  ) => Math.exp(
    -((x - cx) ** 2 + (y - cy) ** 2) / (2 * width ** 2),
  );

  const pairs: Array<{ x: number; y: number; strength: number }> = [];

  for (let i = 0; i < references.length; i++) {
    for (let j = i + 1; j < references.length; j++) {
      const first = references[i];
      const second = references[j];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const strength = Math.min(responses[i], responses[j]);

      if (
        distance > SPATIAL_SETTINGS.pairDistanceLimit ||
        strength < SPATIAL_SETTINGS.pairMinimumResponse
      ) {
        continue;
      }

      const pairTotal = responses[i] + responses[j];

      pairs.push({
        x: (first.x * responses[i] + second.x * responses[j]) / pairTotal,
        y: (first.y * responses[i] + second.y * responses[j]) / pairTotal,
        strength,
      });
    }
  }

  const sensorField = candidates.map(candidate =>
    references.reduce(
      (sum, reference, index) => sum + responses[index] * gaussian(
        candidate.x,
        candidate.y,
        reference.x,
        reference.y,
        sigma,
      ),
      0,
    ),
  );

  const fusedField = candidates.map(candidate =>
    gaussian(
      candidate.x,
      candidate.y,
      centre.x,
      centre.y,
      fusedSigma,
    ),
  );

  const overlapField = candidates.map(candidate =>
    pairs.reduce(
      (sum, pair) => sum + pair.strength * gaussian(
        candidate.x,
        candidate.y,
        pair.x,
        pair.y,
        fusedSigma,
      ),
      0,
    ),
  );

  const fittedField = candidates.map(candidate =>
    Math.exp(-0.5 * (candidate.error - minError)),
  );

  function normalisedField(field: number[]): number[] {
    const total = field.reduce((sum, value) => sum + value, 0);

    return field.map(value => value / Math.max(1e-12, total));
  }

  const sensorDensity = normalisedField(sensorField);
  const fusedDensity = normalisedField(fusedField);
  const overlapDensity = normalisedField(overlapField);
  const fittedDensity = normalisedField(fittedField);

  const calibrated = hasSpatialCalibration(region, samples);
  const referenceResponses = calibrated
    ? references.map(reference => normalise(samples[region][reference.id] ?? []))
    : [];
  const referenceErrors = referenceResponses.map(reference =>
    z.reduce(
      (sum, value, index) => sum + (value - reference[index]) ** 2,
      0,
    ),
  );
  const referenceBestError = Math.min(Infinity, ...referenceErrors);
  const referenceConfidence = calibrated
    ? Math.exp(-referenceBestError / (2 * 0.20 ** 2))
    : 0;
  const referenceField = calibrated
    ? candidates.map(candidate => references.reduce((sum, reference, index) =>
      sum + Math.exp(
        -(referenceErrors[index] - referenceBestError) / (2 * 0.20 ** 2),
      ) * gaussian(
        candidate.x,
        candidate.y,
        reference.x,
        reference.y,
        sigma * 0.75,
      ),
    0))
    : candidates.map(() => 0);
  const referenceDensity = normalisedField(referenceField);

  const modelAgreement = Math.exp(-0.5 * minError);
  const modelWeight = 0.05 + (calibrated ? 0.10 : 0.30) * modelAgreement;
  const referenceWeight = 0.30 * referenceConfidence;
  const overlapWeight = pairs.length ? 0.12 : 0;
  const sensorWeight = 0.38;
  const fusedWeight = 1 - modelWeight - referenceWeight - overlapWeight - sensorWeight;

  const weights = candidates.map((_, index) =>
    sensorWeight * sensorDensity[index] +
    fusedWeight * fusedDensity[index] +
    overlapWeight * overlapDensity[index] +
    modelWeight * fittedDensity[index] +
    referenceWeight * referenceDensity[index],
  );

  let mass = 0;
  let targetMass = 0;
  let weightedX = 0;
  let weightedY = 0;
  let maxWeight = 0;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const weight = weights[index];

    mass += weight;
    maxWeight = Math.max(maxWeight, weight);
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
  const score = Math.max(0, Math.min(100, 100 * targetMass / mass));
  const targetResponse = responses[0];
  const inconsistentCentre = effectiveSensors >= 1.7 &&
    targetResponse < 0.15 &&
    Math.abs(estimate.x - config.targetX) < config.targetRadiusX &&
    Math.abs(estimate.y - config.targetY) < config.targetRadiusY;

  const uncertainty: SpatialEstimate['uncertainty'] =
    inconsistentCentre || (score >= SPATIAL_SETTINGS.borderlineScore &&
      score < SPATIAL_SETTINGS.acceptanceScore)
      ? 'broad'
      : 'moderate';

  return {
    region,
    calibrated,
    score,
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
