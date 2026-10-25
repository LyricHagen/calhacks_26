// How-to text for each training phase: short lines for the instruction
// panel, and a slightly fuller version spoken when the phase starts.
// Adult technique only; the scenarios don't cover children.

export type GuidePhase = 'back' | 'front' | 'review' | 'cough' | 'coughFailing' | 'cpr';

export type PhaseGuide = {
  steps: string[];
  spoken: string;
};

export const PHASE_GUIDES: Record<GuidePhase, PhaseGuide> = {
  back: {
    steps: [
      'Stand to the side, slightly behind them',
      'Put one arm across their chest and lean them forward at the waist',
      'With the heel of your hand, strike firmly between the shoulder blades',
      'Give 5 back blows',
    ],
    spoken: 'Back blows. Stand to the side and slightly behind them. Put one arm across their chest and lean them forward. Then strike firmly between the shoulder blades with the heel of your hand. Give five.',
  },
  front: {
    steps: [
      'Stand behind them and find the navel with two fingers',
      'Place the thumb side of your fist just above the navel',
      'Cover your fist with your other hand',
      'Pull inward and upward with a quick thrust',
      'Give 5 abdominal thrusts',
    ],
    spoken: 'Abdominal thrusts. Stand behind them and find the navel. Put the thumb side of your fist just above it, and cover it with your other hand. Pull in and up, quickly. Give five.',
  },
  review: {
    steps: [
      'Check: are they still choking and responsive?',
      'If so, repeat 5 back blows and 5 abdominal thrusts',
      'If they become unresponsive, call for help and start CPR',
    ],
    spoken: 'Round complete. If they are still choking and responsive, start again with five back blows. If they become unresponsive, call for help and start CPR.',
  },
  cough: {
    steps: [
      'Encourage them to keep coughing',
      'Keep your hands off: no back blows or abdominal thrusts',
      'Watch for a weak or silent cough, or trouble breathing',
    ],
    spoken: 'Effective cough. Encourage them to keep coughing, and do not give back blows or thrusts. Watch closely in case the cough gets weak.',
  },
  coughFailing: {
    steps: [
      'The cough has gone weak and silent; they cannot speak',
      'This is now severe choking: act straight away',
      'Lean them forward and give a back blow between the shoulder blades',
    ],
    spoken: 'The cough is failing. They can no longer cough or speak. Start back blows now.',
  },
  cpr: {
    steps: [
      'Call emergency services and send for an AED',
      'Heel of one hand on the centre of the chest, other hand on top',
      'Push hard and fast: 100 to 120 compressions a minute',
      'Let the chest come all the way back up after each push',
      'After 30, give 2 breaths if trained, then continue within 10 seconds',
    ],
    spoken: 'Unresponsive. Call emergency services. Put the heel of one hand on the centre of the chest, other hand on top. Push hard and fast, 100 to 120 a minute, and let the chest come all the way back up. Do 30, then continue.',
  },
};

// Spoken when the fifth good back blow moves the trainee on to thrusts.
export const BACK_TO_FRONT_CUE = `Five back blows done. ${PHASE_GUIDES.front.spoken}`;

// Spoken at the end of each 30-compression cycle.
export const CPR_CYCLE_CUE = 'Thirty. Give two breaths if trained, then continue compressions.';

export const GUIDE_CUES = [
  ...Object.values(PHASE_GUIDES).map(guide => guide.spoken),
  BACK_TO_FRONT_CUE,
  CPR_CYCLE_CUE,
];
