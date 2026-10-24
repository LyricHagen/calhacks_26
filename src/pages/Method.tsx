import { LABELS, THRESHOLDS as T } from '../../shared/mockStream.js';
import { COUNTDOWN_MS } from '../advance';
import { HZ, SPREAD_LIMIT } from '../judge';
import { REST_FRAMES, REST_MOVE } from '../sources/trainer';
import { QLink } from '../util';
import { DocPage, type Sec } from './Doc';

const n2 = (x: number) => x.toFixed(2);

const SECS: Sec[] = [
  {
    id: 'sensing', title: 'Sensing',
    body: <p>A force sensor in the glove reads how hard the fist pushes. A motion unit on the wrist reads the angle of travel and the spike of a back blow. Five pads on the torso report where the fist lands: target, too high, too low, side, and one on the back between the shoulder blades. An ESP32 controller reads them all and sends the raw readings over a USB cable ten times a second. This page, in Chrome or Edge on a computer, does all the judging.</p>,
  },
  {
    id: 'calibration', title: 'Calibration',
    body: (
      <>
        <p>The trainee rests the fist on the target pad without pushing, which sets zero. Then the instructor gives three thrusts. From here on every force is a fraction of their peaks: 1.00 means as hard as the instructor. Nothing is reported in newtons.</p>
        <p>The rest step ends on its own once the fist has held still for {REST_FRAMES / HZ} s, moving less than {REST_MOVE.toFixed(2)} from its running average. Each instructor thrust is counted as it is released, and the session opens {COUNTDOWN_MS / 1000} s after the third. The spread of the three is the largest peak minus the smallest, over their mean; {SPREAD_LIMIT.toFixed(2)} or less means the instructor was consistent.</p>
      </>
    ),
  },
  {
    id: 'rules', title: 'How each thrust is judged',
    body: (
      <ul>
        <li>A thrust starts above {n2(T.thrustStart)} of the reference and ends below {n2(T.thrustEnd)}. If it never drops below {n2(T.thrustEnd)} before the next push, it reads &ldquo;{LABELS.fault['not-released']}&rdquo;.</li>
        <li>The torso pad that read highest names the placement. If every pad stayed below {n2(T.zoneOff)}, it reads &ldquo;{LABELS.zone.off}&rdquo;.</li>
        <li>A peak below {n2(T.weakBelow)} reads &ldquo;{LABELS.strength.weak}&rdquo;, above {n2(T.strongAbove)} reads &ldquo;{LABELS.strength.strong}&rdquo;, anything between reads &ldquo;{LABELS.strength.similar}&rdquo;.</li>
        <li>A thrust that takes more than {T.slowFactor} times the instructor&rsquo;s time to peak reads &ldquo;{LABELS.abrupt.false}&rdquo;.</li>
        <li>A back blow needs the back pad above {n2(T.backOnTarget)} within {T.backWindowMs} ms, or it reads &ldquo;{LABELS.blow.false}&rdquo;.</li>
        <li>The sequence is five back blows, then five thrusts, repeated (AHA 2025 adult). Anything out of turn reads &ldquo;{LABELS.fault['out-of-order']}&rdquo;.</li>
      </ul>
    ),
  },
  {
    id: 'screen', title: 'Reading the session screen',
    body: (
      <ul>
        <li>On the torso, solid orange is contact right now. An orange outline marks a pad where a fault was recorded.</li>
        <li>The large readouts are the phase, the count in the current set of five, and the judgement of the last closed thrust or back blow.</li>
        <li>The sequence boxes run five back blows then five thrusts, one row per cycle. A filled box is done; an orange outline is a fault or out of order.</li>
        <li>On the force chart the solid line is the reference, 1.00, and the dashed line is the release line, {n2(T.thrustEnd)}.</li>
        <li>Details holds the full entry list, with angle (ungraded), abruptness and release for each thrust.</li>
      </ul>
    ),
  },
  {
    id: 'angle', title: 'Angle, shown and never graded',
    body: <p>The wrist unit reports the angle of travel at the peak of each thrust. There is no agreed number for it, so the angle is shown with no band or verdict.</p>,
  },
  {
    id: 'limits', title: 'Limits',
    body: (
      <ul>
        <li>A manikin torso is not a person.</li>
        <li>The reference is only as good as the instructor&rsquo;s three thrusts that day.</li>
        <li>Sampling at ten times a second can under-read a very short spike.</li>
        <li>Taped pads can shift. Recalibrate after moving the torso.</li>
      </ul>
    ),
  },
  {
    id: 'no-target', title: 'Why there is no force target',
    body: <p>For chest compressions, guidance gives a depth and a rate. For abdominal thrusts it describes a technique only: fist above the navel and below the ribs, quick inward and upward thrusts. Published force measurements come from small studies and vary widely. No guideline body has set a threshold, so this trainer compares you with a person instead of inventing one.</p>,
  },
  {
    id: 'honesty', title: 'The honesty line',
    body: <p className="honesty">No published guideline sets a force or depth for abdominal thrusts. unnamed coaches technique and consistency against an instructor&rsquo;s reference and never calls a force correct. It is a training aid, not a medical device.</p>,
  },
];

export function MethodPage() {
  return (
    <DocPage
      title="Method"
      lede={<p>How the trainer senses, calibrates and judges each push, with the numbers it uses. Read with the <QLink to="/session">session</QLink>.</p>}
      secs={SECS}
    />
  );
}
