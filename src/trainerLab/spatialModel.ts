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
  spokenCorrection: string;
  /** True only when the centre target sensor is the strongest (after gains). */
  centreDominant: boolean;
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
    targetRadiusX: 36,
    targetRadiusY: 38,
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
    targetRadiusX: 36,
    targetRadiusY: 44,
  },
};

const CELL_SIZE = 6;
const MODEL_NOISE = 0.12;

export const SPATIAL_SETTINGS = {
  noiseFloorAdc: 35,
  // Ignore any sensor reading below this fraction of the strongest one.
  // FSRs under a shared plate/shell pick up bleed from neighbouring hits;
  // 0.30 drops that crosstalk so it can't drag the estimate sideways.
  relativeNoiseFloor: 0.30,
  // >1 lets the strongest sensor dominate the position estimate.
  signalExponent: 1.6,
  // Off-centre sensors are scaled down before locating the hit, so a
  // centre hit with some side bleed still reads as centre. 1 = no bias.
  sideSensorGain: 0.75,
  // Bias term: pulls the estimate (and score) towards the target centre.
  // Scaled by how strongly the centre sensor fired, so a hit that is
  // clearly on a side sensor is not dragged back. 0 = off, 0.5 = strong.
  centerBias: 0.3,
  frontKernelWidth: 21,
  backKernelWidth: 23,
  pairDistanceLimit: 85,
  pairMinimumResponse: 0.12,
  borderlineScore: 45,
  acceptanceScore: 54,
} as const;

// Per-sensor trust, applied before locating a hit (1 = normal).
// Sensor 3 (front left-centre) sits where the rescuer's wrist lands during
// a thrust, so it reads high even when the fist is on target. Its reading
// is scaled down so the wrist can't drag the estimate left. If the wrist
// lands on the other side on your mannequin, move this entry to sensor 4.
// Sensors not listed use sideSensorGain (or 1 for each region's centre).
export const SENSOR_GAIN: Partial<Record<SensorId, number>> = {
  3: 0.5,
};

export function sensorGain(id: SensorId): number {
  return SENSOR_GAIN[id] ??
    (id === 0 || id === 5 || id === 8 ? 1 : SPATIAL_SETTINGS.sideSensorGain);
}

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
  // Each reading is scaled by sensorGain (applied here so calibration and
  // live hits match).
  return SPATIAL_REFERENCES[region].map(({ id }) =>
    Math.max(0, values[id] - baseline[id]) * sensorGain(id),
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
): { text: string; spoken: string } {
  if (uncertainty === 'broad') {
    return {
      text: 'Placement is unclear from this contact. Reposition and try again.',
      spoken: 'Unclear. Reposition.',
    };
  }

  const config = REGIONS[region];
  const horizontal = x - config.targetX;
  const vertical = y - config.targetY;

  if (Math.abs(horizontal) <= 20 && Math.abs(vertical) <= 18) {
    return {
      text: 'Estimated near the target area. Keep aiming at the highlighted region.',
      spoken: 'Almost there.',
    };
  }

  // Spoken cues say "centre" rather than left/right: the rescuer stands
  // behind the mannequin for thrusts, so screen left/right would be mirrored.
  // Correct along whichever axis is further off (relative to the target
  // size), so a small vertical wobble never produces "too low".
  const offX = Math.abs(horizontal) / config.targetRadiusX;
  const offY = Math.abs(vertical) / config.targetRadiusY;
  if (offX >= offY) {
    return horizontal < 0
      ? {
          text: 'Contact appears left of target. Move towards the centre (right in this view).',
          spoken: 'Off centre. Move to the middle.',
        }
      : {
          text: 'Contact appears right of target. Move towards the centre (left in this view).',
          spoken: 'Off centre. Move to the middle.',
        };
  }

  if (region === 'front') {
    return vertical < 0
      ? {
          text: 'Contact appears too high. Move down towards the upper abdomen.',
          spoken: 'Too high. Move down.',
        }
      : {
          text: 'Contact appears too low. Move up towards the upper abdomen.',
          spoken: 'Too low. Move up.',
        };
  }

  return vertical < 0
    ? {
        text: 'Contact appears above the illustrated back target. Shift slightly downward.',
        spoken: 'Too high. Shift down.',
      }
    : {
        text: 'Contact appears below the illustrated back target. Shift upward between the shoulder blades.',
        spoken: 'Too low. Move up between the shoulder blades.',
      };
}

export function estimatePlacement(
  region: SpatialRegion,
  values: NineReadings,
  baseline: NineReadings,
  samples: SpatialSamples,
): SpatialEstimate | null {
  const observed = signalPattern(values, baseline, region);
  const maximum = Math.max(...observed);
  // Verdict gate: a contact can only count as good if the centre target
  // sensor (index 0) is the strongest reading after gains. Gains only
  // change how much each sensor pulls the estimate; they never let a
  // side sensor produce a "good" verdict.
  const centreDominant =
    observed.every((value, index) => index === 0 || value < observed[0]);
  // The sensor that "won": the centre if it is strictly strongest,
  // otherwise the strongest side sensor (a tie goes to the side).
  const dominantIndex = centreDominant
    ? 0
    : observed.reduce(
      (best, value, index) =>
        index !== 0 && value > observed[best] ? index : best,
      1,
    );

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

  const centerPriorDensity = normalisedField(candidates.map(candidate =>
    // Width is half the target zone, so ~86% of the bias sits inside it.
    Math.exp(-2 * (
      ((candidate.x - config.targetX) / config.targetRadiusX) ** 2 +
      ((candidate.y - config.targetY) / config.targetRadiusY) ** 2
    )),
  ));
  // responses[0] is the centre sensor's strength relative to the strongest (0–1).
  // No pull towards the centre unless the centre sensor actually won.
  const centerWeight = centreDominant
    ? SPATIAL_SETTINGS.centerBias * responses[0]
    : 0;

  const weights = candidates.map((_, index) =>
    (1 - centerWeight) * (
      sensorWeight * sensorDensity[index] +
      fusedWeight * fusedDensity[index] +
      overlapWeight * overlapDensity[index] +
      modelWeight * fittedDensity[index] +
      referenceWeight * referenceDensity[index]
    ) +
    centerWeight * centerPriorDensity[index],
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
  const rawScore = Math.max(0, Math.min(100, 100 * targetMass / mass));
  // If a side sensor won, cap the score below the uncertain band so the
  // contact is always reported as needing correction.
  const score = centreDominant
    ? rawScore
    : Math.min(rawScore, SPATIAL_SETTINGS.borderlineScore - 1);
  const targetResponse = responses[0];
  const inconsistentCentre = effectiveSensors >= 1.7 &&
    targetResponse < 0.15 &&
    Math.abs(estimate.x - config.targetX) < config.targetRadiusX &&
    Math.abs(estimate.y - config.targetY) < config.targetRadiusY;

  const uncertainty: SpatialEstimate['uncertainty'] = centreDominant && (
    inconsistentCentre || (score >= SPATIAL_SETTINGS.borderlineScore &&
      score < SPATIAL_SETTINGS.acceptanceScore))
      ? 'broad'
      : 'moderate';

  // When a side sensor won, steer the correction from that sensor's
  // position so the advice matches the verdict.
  const dominant = references[dominantIndex];
  const correction = centreDominant
    ? placementCorrection(region, estimate.x, estimate.y, uncertainty)
    : placementCorrection(region, dominant.x, dominant.y, uncertainty);

  return {
    region,
    calibrated,
    score,
    estimate,
    uncertainty,
    correction: correction.text,
    spokenCorrection: correction.spoken,
    centreDominant,
    cellSize: CELL_SIZE,
    cells: candidates.map((candidate, index) => ({
      x: candidate.x,
      y: candidate.y,
      density: weights[index] / mass,
      probability: weights[index] / Math.max(1e-12, maxWeight),
    })),
  };
}