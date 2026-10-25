// How-to text for each training phase: short lines for the instruction
// panel, and a slightly fuller version spoken when the phase starts.
// Adult technique only; the scenarios don't cover children.

export type GuidePhase = 'back' | 'front' | 'review' | 'cough' | 'cpr';

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
      'Do not give back blows or abdominal thrusts',
      'Watch for a weak or silent cough, or trouble breathing',
    ],
    spoken: 'Effective cough. Encourage them to keep coughing, and do not give back blows or thrusts. Watch closely in case the cough gets weak.',
  },
  cpr: {
    steps: [
      'Call emergency services',
      'Place the heel of one hand on the centre of the chest',
      'Put your other hand on top and interlock your fingers',
      'Practise hand placement on the sternum sensor',
    ],
    spoken: 'Unresponsive. Call emergency services. Place the heel of one hand on the centre of the chest, with your other hand on top. Practise your hand placement on the sternum sensor.',
  },
};

// Spoken when the fifth good back blow moves the trainee on to thrusts.
export const BACK_TO_FRONT_CUE = `Five back blows done. ${PHASE_GUIDES.front.spoken}`;

export const GUIDE_CUES = [
  ...Object.values(PHASE_GUIDES).map(guide => guide.spoken),
  BACK_TO_FRONT_CUE,
];
