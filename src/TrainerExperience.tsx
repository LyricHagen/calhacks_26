import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ADC_MAX, EMPTY, NineSensorDetector, NineSensorProtocol,
  SENSOR_NAMES, type ActionType, type DetectedAction, type NineFrame, type NineReadings,
  type SensorId,
} from './trainerLab/sensors';
import {
  calibratedCount,
  emptySpatialSamples,
  estimatePlacement,
  hasSpatialCalibration,
  signalPattern,
  simulatedContact,
  SPATIAL_REFERENCES,
  SPATIAL_SETTINGS,
  type SpatialEstimate,
  type SpatialRegion,
  type SpatialSamples,
} from './trainerLab/spatialModel';
import { BACK_TO_FRONT_CUE, PHASE_GUIDES } from './trainerLab/instructions';
import { preloadCues, speak, speakAnswer, speechSupported, stopSpeech } from './trainerLab/speech';
import {
  askGemini, listeningSupported, requestMicrophone, VoiceListener,
  type AssistantContext, type ListenerStatus,
} from './trainerLab/assistant';

type Mode = 'train' | 'calibrate' | 'test';
type Scenario = 'severe' | 'cough' | 'unresponsive';
type View = 'front' | 'back';
type Tone = 'neutral' | 'success' | 'warning';
type Connection = 'demo' | 'connecting' | 'live' | 'error';
type Feedback = { tone: Tone; heading: string; detail: string; spoken?: string };
type Counts = { back: number; front: number; cpr: number; correct: number; errors: number; rounds: number };
type History = { time: string; label: string; verdict: string; good: boolean; peak: number; placementScore: number | null };

type SerialPort = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
};
type SerialNavigator = Navigator & { serial?: { requestPort: () => Promise<SerialPort> } };

const INITIAL_COUNTS: Counts = { back: 0, front: 0, cpr: 0, correct: 0, errors: 0, rounds: 0 };
const SENSOR_GROUPS = [
  { name: 'ABDOMEN', ids: [0, 1, 2, 3, 4] },
  { name: 'BACK', ids: [5, 6, 7] },
  { name: 'CHEST', ids: [8] },
] as const;
const FRONT_COORDS: { id: SensorId; x: number; y: number }[] = [
  { id: 0, x: 184, y: 292 }, { id: 1, x: 184, y: 244 },
  { id: 2, x: 184, y: 342 }, { id: 3, x: 144, y: 295 },
  { id: 4, x: 224, y: 295 }, { id: 8, x: 184, y: 182 },
];
const BACK_COORDS: { id: SensorId; x: number; y: number }[] = [
  { id: 5, x: 184, y: 190 }, { id: 6, x: 146, y: 238 },
  { id: 7, x: 222, y: 238 },
];
const startFeedback: Feedback = {
  tone: 'neutral', heading: 'Ready when you are',
  detail: 'Follow the instruction, then use the mannequin or a connected sensor. We will assess contact location and sequence as you practise.',
};
const empty = (): NineReadings => [...EMPTY] as NineReadings;
const VOICE_KEY = 'thrustworthy-voice';
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];
const WAKE_KEY = 'thrustworthy-wake-word';
function loadVoicePreference(): boolean {
  try { return localStorage.getItem(VOICE_KEY) !== 'off'; } catch { return true; }
}
function loadWakePreference(): boolean {
  // On unless the user has switched it off: it's the only hands-free way to ask.
  try { return localStorage.getItem(WAKE_KEY) !== 'off'; } catch { return true; }
}
const prettyTime = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Logo() {
  return <div className="brandmark" aria-hidden="true">
    <svg viewBox="0 0 40 40"><rect x="1" y="1" width="38" height="38" rx="12" fill="#007E79" />
      <path d="M9 20h6l3-8 5 17 4-9h4" stroke="#fff" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg></div>;
}
function Check({ size = 17 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12 4 4L19 6" /></svg>;
}
function Refresh() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M20 11a8 8 0 1 0-2 6" />
    <path d="M20 4v7h-7" /></svg>;
}
function Speaker({ on }: { on: boolean }) {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9v6h4l5 4V5L8 9H4Z" />{on ? <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /> : <path d="m16 9 5 6m0-6-5 6" />}</svg>;
}
function Mic() {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
}
function Usb() {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M12 3v15m0-15-3 3m3-3 3 3M12 18 7 13m5 5 5-5M7 13v-2m10 2v-2" /><circle cx="7" cy="9" r="1" /><rect x="16" y="8" width="3" height="3" /></svg>;
}

function Face({ severity }: { severity: 1 | 2 | 3 }) {
  return <g fill="none" stroke="#9c6a5c" strokeLinecap="round">
    <path d={severity === 3 ? 'M168 57q7 4 13 0M190 57q7 4 13 0' : 'M168 57q7-4 13 0M190 57q7-4 13 0'} strokeWidth="1.7" />
    {severity < 3 && <path d={severity === 2 ? 'M166 50l14-5M188 45l14 5' : 'M166 49l14-3M188 46l14 3'} strokeWidth="1.6" />}
    <path d="M185 59v15l-4 2" strokeWidth="1.4" />
    <path d={severity === 1 ? 'M176 89q8-3 16 0' : severity === 2 ? 'M175 90q9-6 18 0' : 'M178 88h12'} strokeWidth={severity === 2 ? 1.5 : 1.3} />
  </g>;
}

function BodyDiagram({
  view, active, target, onSensor, cpr, flash, wrong, heatmap, severity,
}: {
  view: View; active: SensorId | null; target: SensorId | null;
  onSensor: (id: SensorId) => void; cpr: boolean; flash: number; wrong: boolean;
  heatmap: SpatialEstimate | null;
  // 1 effective cough, 2 severe choking, 3 unresponsive; the figure's distress escalates with it.
  severity: 1 | 2 | 3;
}) {
  const coords = view === 'front' ? FRONT_COORDS : BACK_COORDS;
  const focusY = view === 'back' ? 190 : cpr ? 182 : 292;
  const activePosition = coords.find(item => item.id === active);
  const targetPosition = coords.find(item => item.id === target);
  return <div className="body-stage">
    <svg className={`body-illustration lvl-${severity} ${active !== null ? 'impact' : ''}`} viewBox="0 0 368 420" role="img" aria-label={`Interactive ${view} view of training mannequin with force sensor locations`}>
      <defs>
        <linearGradient id="skin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f4cfb2" /><stop offset=".42" stopColor="#d9a787" /><stop offset="1" stopColor="#bc816a" />
        </linearGradient>
        <linearGradient id="chest" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#bc856c" /><stop offset=".22" stopColor="#f1c9aa" /><stop offset=".5" stopColor="#e7b99b" /><stop offset=".78" stopColor="#efc5a7" /><stop offset="1" stopColor="#b57d64" />
        </linearGradient>
        <linearGradient id="arms" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#cb9379" /><stop offset=".5" stopColor="#e9baa0" /><stop offset="1" stopColor="#bd846f" /></linearGradient>
        <filter id="bodyShadow"><feDropShadow dx="0" dy="12" stdDeviation="10" floodColor="#70472f" floodOpacity=".16" /></filter>
      </defs>
      <ellipse cx="184" cy="396" rx="115" ry="12" fill="#bcc9bd" opacity=".22" />
      <g className="figure-2d">
      <g filter="url(#bodyShadow)">

        <path className="shoulders-2d" d="M126 109 C99 116 73 135 65 176 L45 280 Q41 304 58 310 Q74 314 83 290 L113 200 118 298 250 298 255 201 286 289 Q297 313 313 308 Q327 302 321 277 L304 176 C296 136 268 116 243 109Z" fill="url(#arms)" stroke="#a77968" strokeWidth="1.3" />

        <path d="M157 92 157 119 Q183 137 211 119 L211 92Z" fill="url(#skin)" />

        <g className="head-2d">
          <ellipse cx="150" cy="60" rx="10" ry="16" fill="#d6a080" /><ellipse cx="217" cy="60" rx="10" ry="16" fill="#cb9579" />
          <path d="M148 36 Q153 11 184 11 Q215 10 223 38 L216 80 Q207 105 184 109 Q160 102 151 81Z" fill="url(#skin)" stroke="#ad806f" strokeWidth="1.2" />
          <path d="M150 42 Q151 10 181 9 Q219 7 221 39 Q201 23 180 23 Q159 25 150 42Z" fill="#293f3e" />
          {view === 'front' && <Face severity={severity} />}
        </g>

        <path d="M126 115 C139 128 159 137 184 137 Q225 138 243 115 C260 135 270 163 265 210 Q254 257 253 292 L245 368 Q184 385 121 368 L114 293 Q109 254 102 212 C96 167 105 136 126 115Z" fill="url(#chest)" stroke="#b8856f" strokeWidth="1.3" />
        {view === 'front' ? <g fill="none" stroke="#a97667" strokeWidth="1.5" opacity=".56">
          <path d="M130 147 Q155 137 184 149 Q213 137 239 147" />
          <path d="M114 170 Q146 158 174 172M194 172 Q222 158 254 170" />
          <path d="M114 187 Q147 181 173 190M194 190 Q222 181 253 187" />
          <path d="M117 206 Q145 202 173 208M195 208 Q225 202 251 206" />
          <path d="M118 229 Q149 220 174 228M194 228 Q221 220 252 229" />
          <path d="M184 145V218" strokeWidth="2" opacity=".55" />
          <path d="M183 251q3 6 0 11" strokeWidth="3" />
          <path d="M121 306Q183 317 247 306" opacity=".3" />
        </g> : <g fill="none" stroke="#a4715f" opacity=".55">
          <path d="M181 140 Q184 211 183 323" strokeWidth="2.4" />
          <path d="M178 146 Q144 139 127 156 Q116 181 132 204 Q154 218 175 199" strokeWidth="2" />
          <path d="M190 146 Q224 139 240 156 Q251 181 235 204 Q213 218 192 199" strokeWidth="2" />
          <path d="M128 250 Q154 263 178 249M189 249Q215 263 241 250" strokeWidth="1.4" />
          <path d="M181 224v70" strokeDasharray="3 7" strokeWidth="1.5" />
        </g>}

        <path d="M121 364 Q182 380 246 364 L248 381 Q186 394 119 381Z" fill="#718780" opacity=".65" />
      </g>

      <clipPath id="heatmapBodyClip">
        <path d="M126 115 C139 128 159 137 184 137 Q225 138 243 115 C260 135 270 163 265 210 Q254 257 253 292 L245 368 Q184 385 121 368 L114 293 Q109 254 102 212 C96 167 105 136 126 115Z" />
      </clipPath>
      {heatmap && <g clipPath="url(#heatmapBodyClip)" className="spatial-heatmap">
        {heatmap.cells.filter(cell => cell.probability > 0.05).map(cell => (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x - heatmap.cellSize / 2}
            y={cell.y - heatmap.cellSize / 2}
            width={heatmap.cellSize + 0.6}
            height={heatmap.cellSize + 0.6}
            fill={cell.probability > 0.66 ? '#ef7544' : cell.probability > 0.30 ? '#e6b64d' : '#12a991'}
            opacity={Math.min(0.85, Math.pow(cell.probability, 0.7) * 0.78)}
          />
        ))}
        <circle
          cx={heatmap.estimate.x}
          cy={heatmap.estimate.y}
          r="4"
          className="estimate-centre"
        />
      </g>}
      {coords.map(({ id, x, y }) => {
        const isTarget = id === target || (cpr && id === 8);
        const isActive = id === active;
        return <g key={id} className="svg-pad" onClick={() => onSensor(id)}>
          <title>{SENSOR_NAMES[id]} — click to simulate contact</title>
          {isTarget && <circle cx={x} cy={y} r="29" fill="none" stroke="#04877b" strokeDasharray="5 7" strokeWidth="2.5" className="target-orbit" />}
          <circle cx={x} cy={y} r={isActive ? 24 : isTarget ? 20 : 14} className={`body-pad ${isActive ? (wrong ? 'is-wrong' : 'is-active') : ''} ${isTarget ? 'is-target' : ''}`} />
          <circle cx={x} cy={y} r="6" fill={isActive || isTarget ? '#fff' : '#c2b0a2'} opacity=".9" />
        </g>;
      })}
      {target !== null && coords.some(c => c.id === target) && <g className="target-label">
        <rect x="252" y={focusY - 22} width="104" height="34" rx="16" fill="#e5f7ef" stroke="#a1dbc7" />
        <text x="304" y={focusY - 1} fill="#08786b" fontWeight="700" fontSize="12" textAnchor="middle">TARGET AREA</text>
        <path d={`M252 ${focusY - 5} H233`} stroke="#08786b" strokeWidth="1.5" strokeDasharray="3 4" />
      </g>}
      {wrong && activePosition && targetPosition && activePosition.id !== targetPosition.id && (
        <g className="correction-guide" aria-hidden="true">
          <path
            d={`M${activePosition.x} ${activePosition.y} L${targetPosition.x} ${targetPosition.y}`}
            fill="none"
            stroke="#df655c"
            strokeWidth="3"
            strokeDasharray="6 5"
          />
          <circle cx={targetPosition.x} cy={targetPosition.y} r="5" fill="#007e79" />
        </g>
      )}
      {active !== null && coords.some(c => c.id === active) && <circle key={flash} cx={coords.find(c => c.id === active)!.x} cy={coords.find(c => c.id === active)!.y} r="39" className="contact-ripple" fill="none" stroke={wrong ? '#df655c' : '#0eab93'} strokeWidth="3" />}
      </g>
    </svg>
    <span className="anatomy-credit">Illustrative anatomy · sensor positions schematic</span>
  </div>;
}

function Airway({ scenario }: { scenario: Scenario }) {
  return <div className="airway-mini" aria-label={scenario === 'cough' ? 'Airflow illustrated through a patent airway' : 'Illustrated airway narrowing with obstruction'} role="img">
    <svg viewBox="0 0 210 128" aria-hidden="true">
      <defs><linearGradient id="headShading" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f2d0b5" /><stop offset="1" stopColor="#d3a18a" /></linearGradient></defs>
      <path d="M66 10 C30 12 23 43 32 62 L25 76 Q40 84 54 83 L62 117H122V61 Q120 17 75 10Z" fill="url(#headShading)" stroke="#c4957b" strokeWidth="1.4" />
      <path d="M29 68L70 68 Q86 69 89 92V119" stroke="#c77e79" strokeWidth="16" fill="none" strokeLinecap="round" />
      <path d="M29 68L70 68 Q86 69 89 92V119" stroke="#64363b" strokeWidth="7" fill="none" strokeLinecap="round" />
      {scenario === 'cough' ? <path d="M33 68L72 68Q89 70 89 94V115" className="air-stream" /> : <><circle cx="87" cy="90" r="10" fill="#db8853" stroke="#b76539" strokeWidth="1.6" />
        <path d="M114 90h40" stroke="#b76539" strokeWidth="1.6" strokeDasharray="3 4" /><text x="158" y="94" textAnchor="middle" fontSize="10" fill="#9c5636">blocked</text></>}
      <text x="150" y="29" textAnchor="middle" fontSize="10" fontWeight="700" fill="#42685d">AIRWAY</text>
      <text x="150" y="44" textAnchor="middle" fontSize="10" fill="#71867d">illustration</text>
    </svg>
  </div>;
}

function SensorMeter({ value, baseline, threshold }: { value: number; baseline: number; threshold: number }) {
  const corrected = Math.max(0, value - baseline);
  return <div className="meter" title={`${value} raw ADC, ${corrected} above baseline`}>
    <span style={{ width: `${Math.min(100, corrected / ADC_MAX * 100)}%` }} className={corrected >= threshold ? 'meter-fill active' : 'meter-fill'} />
    <span className="meter-line" style={{ left: `${threshold / ADC_MAX * 100}%` }} />
  </div>;
}

export function TrainerExperience() {
  const [mode, setMode] = useState<Mode>('train');
  const [scenario, setScenario] = useState<Scenario>('severe');
  const [counts, setCounts] = useState<Counts>({ ...INITIAL_COUNTS });
  const [readings, setReadings] = useState<NineReadings>(empty);
  const [peaks, setPeaks] = useState<NineReadings>(empty);
  const [baseline, setBaseline] = useState<NineReadings>(empty);
  const [threshold, setThreshold] = useState(650);
  const [history, setHistory] = useState<History[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(startFeedback);
  const [connection, setConnection] = useState<Connection>('demo');
  const [connectionDetail, setConnectionDetail] = useState('');
  const [viewOverride, setViewOverride] = useState<View | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [flash, setFlash] = useState(0);
  const [recentContact, setRecentContact] = useState<{ sensor: SensorId; correct: boolean } | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [testTouched, setTestTouched] = useState<SensorId[]>([]);
  const [framesReceived, setFramesReceived] = useState(0);
  const [simBusy, setSimBusy] = useState(false);
  const [spatialSamples, setSpatialSamples] = useState<SpatialSamples>(emptySpatialSamples);
  const [calibrationMessage, setCalibrationMessage] = useState('Capture reference patterns at the marked positions.');
  const [recentPattern, setRecentPattern] = useState<{ region: SpatialRegion; values: NineReadings } | null>(null);
  const [lastPlacement, setLastPlacement] = useState<SpatialEstimate | null>(null);
  const [voiceOn, setVoiceOn] = useState(() => speechSupported() && loadVoicePreference());
  const [wakeOn, setWakeOn] = useState(() => listeningSupported() && loadWakePreference());
  const [listenStatus, setListenStatus] = useState<ListenerStatus>('off');
  const [listenDetail, setListenDetail] = useState('');
  const [heard, setHeard] = useState('');
  const [thinking, setThinking] = useState(false);
  const [exchange, setExchange] = useState<{ question: string; answer: string } | null>(null);

  const detector = useRef(new NineSensorDetector());
  const protocol = useRef(new NineSensorProtocol());
  const serialPort = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const readingWindow = useRef<NineReadings[]>([]);
  const latestValues = useRef<NineReadings>(empty());
  const scenarioRef = useRef(scenario);
  const modeRef = useRef(mode);
  const countsRef = useRef(counts);
  const baselineRef = useRef(baseline);
  const thresholdRef = useRef(threshold);
  const processFrameRef = useRef<(f: NineFrame) => void>(() => { });
  const simBusyRef = useRef(false);
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spatialSamplesRef = useRef(spatialSamples);
  const mounted = useRef(true);
  const voiceRef = useRef(voiceOn);
  const listener = useRef<VoiceListener | null>(null);
  const assistantContext = useRef<AssistantContext | null>(null);
  const handleQuestionRef = useRef<(question: string) => void>(() => { });

  scenarioRef.current = scenario;
  modeRef.current = mode;
  countsRef.current = counts;
  baselineRef.current = baseline;
  thresholdRef.current = threshold;
  spatialSamplesRef.current = spatialSamples;
  voiceRef.current = voiceOn;
  const phase = scenario === 'severe' ? (counts.back < 5 ? 'back' : counts.front < 5 ? 'front' : 'review') : scenario === 'unresponsive' ? 'cpr' : 'cough';
  const recommended: SensorId | null = phase === 'back' ? 5 : phase === 'front' ? 0 : phase === 'cpr' ? 8 : null;
  const defaultView: View = phase === 'back' ? 'back' : 'front';
  const view = viewOverride ?? defaultView;
  const active = readings.reduce<{ value: number; id: SensorId | null }>((top, value, i) => {
    const delta = Math.max(0, value - baseline[i]);
    return delta > top.value && delta >= threshold ? { value: delta, id: i as SensorId } : top;
  }, { value: 0, id: null }).id;
  const liveSensor = active !== null ? SENSOR_NAMES[active] : 'No pressure detected';

  function say(text: string | undefined) {
    // Stay quiet while a question is being asked, or the mic hears our cue instead.
    if (voiceRef.current && text && !listener.current?.isCapturing) speak(text);
  }

  function toggleVoice() {
    const next = !voiceOn;
    voiceRef.current = next;
    setVoiceOn(next);
    try { localStorage.setItem(VOICE_KEY, next ? 'on' : 'off'); } catch {}
    if (next) { speak('Voice coaching on.'); void preloadCues(); }
    else stopSpeech();
  }

  async function handleQuestion(question: string) {
    const state = assistantContext.current;
    if (!state) return;
    stopSpeech();
    setThinking(true);
    setExchange({ question, answer: '' });
    try {
      const answer = await askGemini(question, state);
      if (!mounted.current) return;
      setExchange({ question, answer });
      void speakAnswer(answer);
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : 'Could not reach Gemini.';
      setExchange({ question, answer: `Sorry, I couldn't answer that. (${message})` });
      speak("Sorry, I couldn't answer that.");
    } finally {
      if (mounted.current) setThinking(false);
    }
  }
  handleQuestionRef.current = question => { void handleQuestion(question); };

  function toggleWake() {
    const next = !wakeOn;
    setWakeOn(next);
    try { localStorage.setItem(WAKE_KEY, next ? 'on' : 'off'); } catch {}
    listener.current?.setWakeWord(next);
  }

  function evaluate(event: DetectedAction) {
    const scenarioNow = scenarioRef.current;
    const nextCounts = { ...countsRef.current };
    let result: Feedback;
    let good = false;
    let placement: SpatialEstimate | null = null;
    let ambiguous = false;

    if (event.type === 'front' || event.type === 'back') {
      placement = estimatePlacement(
        event.type,
        event.pattern,
        baselineRef.current,
        spatialSamplesRef.current,
      );
      setRecentPattern({ region: event.type, values: event.pattern });
    }

    setLastPlacement(placement);

    if (scenarioNow === 'cough') {
      result = {
        tone: 'warning',
        heading: 'Pause physical intervention',
        detail: 'Encourage an effective cough and monitor. Back blows and abdominal thrusts are for severe obstruction.',
        spoken: 'Stop. Encourage them to keep coughing.',
      };
    } else if (scenarioNow === 'unresponsive') {
      good = event.type === 'cpr' && event.sensor === 8;

      if (good) {
        nextCounts.cpr += 1;
      }

      result = good
        ? {
            tone: 'success',
            heading: 'Sternum contact recorded',
            detail: 'Hand placement contact detected. This does not measure CPR compression depth or effectiveness.',
            // Compressions come at 100-120 per minute, so only call out every tenth.
            spoken: nextCounts.cpr % 10 === 0 ? `${nextCounts.cpr}.` : undefined,
          }
        : {
            tone: 'warning',
            heading: 'Move to the sternum',
            detail: 'Use the single central sternum sensor for this CPR placement scenario.',
            spoken: 'Move to the centre of the chest.',
          };
    } else {
      const expected: SpatialRegion | 'review' =
        nextCounts.back < 5 ? 'back' : nextCounts.front < 5 ? 'front' : 'review';

      if (expected === 'review') {
        result = {
          tone: 'neutral',
          heading: 'Practice round complete',
          detail: 'Reassess the scenario. A completed training sequence does not establish that the airway has cleared.',
          spoken: 'Round complete. Reassess.',
        };
      } else if (event.type !== expected) {
        result = {
          tone: 'warning',
          heading: 'Wrong action for this step',
          detail: expected === 'back'
            ? 'Practise a back blow between the shoulder blades before abdominal thrusts.'
            : 'Practise an abdominal thrust above the navel and below the breastbone.',
          spoken: expected === 'back' ? 'Back blows first.' : 'Switch to abdominal thrusts.',
        };
      } else if (!placement) {
        ambiguous = true;
        result = {
          tone: 'neutral',
          heading: 'Contact unclear — try again',
          detail: 'Not enough sensor response to estimate placement reliably. Reposition and repeat.',
          spoken: 'Unclear. Try again.',
        };
      } else if (placement.uncertainty === 'broad') {
        ambiguous = true;
        result = {
          tone: 'neutral',
          heading: 'Placement uncertain',
          detail: `${placement.correction} Spatial calibration can improve the model.`,
          spoken: placement.spokenCorrection,
        };
      } else if (placement.score >= SPATIAL_SETTINGS.acceptanceScore) {
        good = true;

        if (expected === 'back') {
          nextCounts.back += 1;
        } else {
          nextCounts.front += 1;
        }

        const current = expected === 'back' ? nextCounts.back : nextCounts.front;

        result = {
          tone: 'success',
          heading: 'Estimated placement on target',
          detail: `${current} of 5 ${expected === 'back' ? 'back contacts' : 'abdominal contacts'} recorded. ` +
            `Approximate placement score: ${Math.round(placement.score)}/100. ` +
            (current === 5 && expected === 'back'
              ? 'Now move to the abdomen for the next part of the practice sequence.'
              : 'Follow the next highlighted action.'),
          spoken: current < 5
            ? `Good. ${COUNT_WORDS[current]}.`
            : expected === 'back'
              ? BACK_TO_FRONT_CUE
              : PHASE_GUIDES.review.spoken,
        };
      } else if (placement.score >= SPATIAL_SETTINGS.borderlineScore) {
        ambiguous = true;
        result = {
          tone: 'neutral',
          heading: 'Close or uncertain — repeat contact',
          detail: `${placement.correction} Approximate placement score: ${Math.round(placement.score)}/100.`,
          spoken: `Close. ${placement.spokenCorrection}`,
        };
      } else {
        result = {
          tone: 'warning',
          heading: 'Adjust placement and retry',
          detail: `${placement.correction} Approximate placement score: ${Math.round(placement.score)}/100.`,
          spoken: placement.spokenCorrection,
        };
      }
    }

    if (good) {
      nextCounts.correct += 1;
    } else if (!ambiguous) {
      nextCounts.errors += 1;
    }

    countsRef.current = nextCounts;
    setCounts(nextCounts);
    setFeedback(result);
    say(result.spoken);
    setHistory(previous => [{
      time: prettyTime(),
      label: event.type === 'cpr' ? SENSOR_NAMES[event.sensor] : `${event.type} pressure pattern`,
      verdict: result.heading,
      good,
      peak: event.peak,
      placementScore: placement ? Math.round(placement.score) : null,
    }, ...previous].slice(0, 12));

    setFlash(value => value + 1);
    setRecentContact({ sensor: event.sensor, correct: good });

    if (contactTimer.current) {
      clearTimeout(contactTimer.current);
    }

    contactTimer.current = setTimeout(() => {
      setRecentContact(null);
      setRecentPattern(null);
      setLastPlacement(null);
      contactTimer.current = null;
    }, 1300);

    if (good && scenarioNow === 'severe' && nextCounts.back === 5 && nextCounts.front === 0) {
      setViewOverride(null);
    }
  }

  const processFrame = useCallback((frame: NineFrame) => {
    if (!mounted.current) return;
    const vals = frame.readings;
    latestValues.current = vals;
    setReadings(vals);
    setPeaks(frame.peaks);
    setFramesReceived(p => p + 1);
    readingWindow.current.push(vals);
    if (readingWindow.current.length > 75) readingWindow.current.shift();
    if (modeRef.current === 'train') {
      const events = detector.current.process(vals, baselineRef.current, performance.now(), thresholdRef.current, frame.peaks);
      for (const event of events) evaluate(event);
    }

    const touched = vals.map((value, i) => ({ value: Math.max(value, frame.peaks[i]) - baselineRef.current[i], id: i as SensorId })).filter(x => x.value >= thresholdRef.current).map(x => x.id);
    if (touched.length) setTestTouched(prev => Array.from(new Set([...prev, ...touched])) as SensorId[]);
  }, []);
  processFrameRef.current = processFrame;

  function resetSession(next: Scenario = scenario) {
    if (simTimer.current) clearTimeout(simTimer.current);
    simBusyRef.current = false; setSimBusy(false);
    detector.current.reset();
    countsRef.current = { ...INITIAL_COUNTS };
    setCounts({ ...INITIAL_COUNTS });
    setHistory([]);
    setRecentContact(null);
    setRecentPattern(null);
    setLastPlacement(null);

    if (contactTimer.current) {
      clearTimeout(contactTimer.current);
      contactTimer.current = null;
    }
    setReadings(empty());
    setPeaks(empty());
    latestValues.current = empty();
    setScenario(next);
    scenarioRef.current = next;
    setViewOverride(null);
    say(PHASE_GUIDES[next === 'cough' ? 'cough' : next === 'unresponsive' ? 'cpr' : 'back'].spoken);
    setFeedback(next === 'cough' ? { tone: 'neutral', heading: 'A strong cough is a good sign', detail: 'Encourage the person to keep coughing. Watch for a change to weak or absent cough, inability to speak, or worsening responsiveness.' } : next === 'unresponsive' ? { tone: 'neutral', heading: 'Begin CPR practice', detail: 'Activate emergency response, start CPR with compressions and follow a certified adult BLS protocol. Only remove a visible object; never perform a blind finger sweep.' } : startFeedback);
  }

  function simulate(ids: SensorId[]) {
    if (connection === 'live' || simBusyRef.current) return;
    simBusyRef.current = true; setSimBusy(true);
    const pressed = ids.length === 1
      ? simulatedContact(ids[0], baselineRef.current, 2800)
      : empty();

    if (ids.length !== 1) {
      ids.forEach(id => {
        pressed[id] = Math.min(ADC_MAX, baselineRef.current[id] + 2800);
      });
    }
    processFrameRef.current({ readings: pressed, peaks: pressed, deviceTimeMs: null });
    simTimer.current = setTimeout(() => {
      const resting = [...baselineRef.current] as NineReadings;
      processFrameRef.current({ readings: resting, peaks: resting, deviceTimeMs: null });

      simTimer.current = setTimeout(() => {
        simBusyRef.current = false;
        setSimBusy(false);
        simTimer.current = null;
      }, 210);
    }, 240);
  }

  async function connect() {
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) {
      setConnection('error'); setConnectionDetail('Web Serial requires Chrome or Edge on desktop, with HTTPS or localhost. Use Demo without a board.'); return;
    }
    if (connection === 'live' || connection === 'connecting') return;
    setConnection('connecting'); setConnectionDetail('Choose the ESP32-S3 USB serial device.');
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      serialPort.current = port;
      protocol.current = new NineSensorProtocol();
      setConnection('live'); setConnectionDetail('Connected. Waiting for fsr9-v1 frames.');
      const reader = port.readable?.getReader();
      if (!reader) throw new Error('Serial port opened without a readable stream.');
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let lineBuffer = '';
      try {
        while (mounted.current) {
          const { value, done } = await reader.read();
          if (done) break;
          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() ?? '';
          if (lineBuffer.length > 4096) lineBuffer = '';
          for (const line of lines) {
            const message = protocol.current.parseLine(line);
            if (message?.kind === 'frame') {
              processFrameRef.current(message.frame);
              setConnectionDetail('Receiving nine-sensor data over USB.');
            }
            if (message?.kind === 'hello') setConnectionDetail('ChokeSense-9FSR identified · 50 Hz frames.');
          }
        }
      } finally {
        try { reader.releaseLock(); } catch {}
        if (readerRef.current === reader) readerRef.current = null;
        try { await port.close(); } catch {}
        if (serialPort.current === port) serialPort.current = null;
        if (mounted.current) setConnection('demo');
      }
    } catch (err) {
      if (!mounted.current) return;
      setConnection(serialPort.current ? 'live' : 'error');
      setConnectionDetail(err instanceof Error ? err.message : 'Could not connect to ESP32.');
    }
  }

  async function disconnect() {
    try { await readerRef.current?.cancel(); } catch {}
    setConnection('demo');
    setConnectionDetail('Disconnected. Demo mode is available.');
  }

  useEffect(() => {
    mounted.current = true;
    if (voiceRef.current) void preloadCues();
    if (listeningSupported()) {
      listener.current = new VoiceListener({
        onQuestion: question => handleQuestionRef.current(question),
        onHeard: text => { if (mounted.current) setHeard(text); },
        onStatus: (status, detail) => {
          if (!mounted.current) return;
          setListenStatus(status);
          setListenDetail(detail ?? '');
          if (status === 'error') setWakeOn(false);
        },
      });
      void requestMicrophone().then(granted => {
        if (!mounted.current) return;
        if (!granted) {
          setListenStatus('error');
          setListenDetail('Microphone access is off. Allow it from the icon in the address bar to ask questions.');
          return;
        }
        if (loadWakePreference()) listener.current?.setWakeWord(true);
      });
    }
    return () => {
      mounted.current = false;
      listener.current?.dispose();
      if (simTimer.current) clearTimeout(simTimer.current);
      if (contactTimer.current) clearTimeout(contactTimer.current);
      stopSpeech();
      void readerRef.current?.cancel().catch(() => { });
    };
  }, []);

  function calibrateRest() {
    const samples = readingWindow.current.slice(-50);
    const reference = samples.length ? samples : [latestValues.current];
    const newBaseline = empty();
    for (let i = 0; i < 9; i++) newBaseline[i] = Math.round([...reference.map(row => row[i])].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(reference.length / 2))).reduce((sum, n) => sum + n, 0) / Math.max(1, Math.ceil(reference.length / 2)));
    baselineRef.current = newBaseline;
    setBaseline(newBaseline);
    detector.current.reset();
    spatialSamplesRef.current = emptySpatialSamples();
    setSpatialSamples(spatialSamplesRef.current);
    setCalibrated(true);
    setFeedback({ tone: 'success', heading: 'Resting baseline captured', detail: 'Nine-channel baseline saved for this session. Validate each sensor individually in Sensor Test and adjust sensitivity as necessary.' });
  }

  function captureSpatialReference(region: SpatialRegion, id: SensorId) {
    const reference = connection === 'live'
      ? (() => {
          const window = readingWindow.current.slice(-15);
          const values = empty();

          for (let index = 0; index < 9; index++) {
            values[index] = Math.max(
              baselineRef.current[index],
              ...window.map(row => row[index]),
            );
          }

          return values;
        })()
      : simulatedContact(id, baselineRef.current);

    const pattern = signalPattern(reference, baselineRef.current, region);

    if (Math.max(...pattern) < thresholdRef.current) {
      setCalibrationMessage('No clear contact recorded. Hold pressure at the labelled location and try again.');
      return;
    }

    const updated: SpatialSamples = {
      ...spatialSamplesRef.current,
      [region]: {
        ...spatialSamplesRef.current[region],
        [id]: pattern,
      },
    };

    spatialSamplesRef.current = updated;
    setSpatialSamples(updated);
    setCalibrationMessage(
      `${SENSOR_NAMES[id]} saved. ${hasSpatialCalibration(region, updated)
        ? 'Spatial calibration is ready for this region.'
        : 'Capture the remaining labelled locations to complete calibration.'}`,
    );
  }

  function nextRound() {
    const next = { ...countsRef.current, back: 0, front: 0, rounds: countsRef.current.rounds + 1 };
    countsRef.current = next; setCounts(next);
    detector.current.reset(); setViewOverride(null);
    say(PHASE_GUIDES.back.spoken);
    setFeedback({ tone: 'neutral', heading: 'Next round ready', detail: 'Resume with back blows if the person remains responsive and the airway remains obstructed. The simulator cannot verify clinical effectiveness.' });
  }

  function downloadSummary() {
    const data = {
      product: 'Thrustworthy', exportedAt: new Date().toISOString(),
      scenario, connection, counts, thresholdADCAboveBaseline: threshold,
      baseline, events: history,
      spatialCalibration: {
        frontReferences: calibratedCount('front', spatialSamples),
        backReferences: calibratedCount('back', spatialSamples),
      },
      note: 'Training demonstration. FSR signals do not measure clinical force, CPR depth, or obstruction clearance.',
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'thrustworthy-session.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  let instruction = '', guide = '', promptTag = '';
  if (phase === 'back') { promptTag = `BACK BLOWS · ${counts.back + 1} OF 5`; instruction = 'Deliver a back blow'; guide = 'Target: between the shoulder blades'; }
  if (phase === 'front') { promptTag = `ABDOMINAL THRUSTS · ${counts.front + 1} OF 5`; instruction = 'Practise abdominal thrust placement'; guide = 'Target: upper abdomen, above the navel'; }
  if (phase === 'review') { promptTag = 'ONE ROUND COMPLETE'; instruction = 'Reassess and continue as needed'; guide = 'Practice round recorded — not airway clearance'; }
  if (phase === 'cough') { promptTag = 'EFFECTIVE COUGH'; instruction = 'Encourage them to keep coughing'; guide = 'No sensor contact needed in this scenario'; }
  if (phase === 'cpr') { promptTag = `CPR CONTACTS · ${counts.cpr} RECORDED`; instruction = 'Begin CPR practice'; guide = 'Target: centre of chest over the sternum'; }

  const howTo = PHASE_GUIDES[phase];
  assistantContext.current = {
    scenario: scenario === 'severe' ? 'Adult severe choking (responsive)' : scenario === 'cough' ? 'Adult mild obstruction with an effective cough' : 'Unresponsive adult, CPR placement practice',
    step: promptTag,
    instruction: `${instruction}. Steps: ${howTo.steps.join('; ')}. ${guide}.`,
    progress: scenario === 'severe'
      ? `Round ${counts.rounds + 1}: ${counts.back}/5 back blows, ${counts.front}/5 abdominal thrusts. ${counts.correct} on target, ${counts.errors} needing correction.`
      : scenario === 'unresponsive' ? `${counts.cpr} sternum contacts recorded.` : 'No physical intervention in this scenario.',
    lastFeedback: `${feedback.heading}. ${feedback.detail}`,
    // Peak ADC is left out on purpose: it isn't force, and Gemini would read it as such.
    recentHits: [...history].reverse().map((hit, index) => {
      const action = hit.label.startsWith('back') ? 'Back blow' : hit.label.startsWith('front') ? 'Abdominal thrust' : hit.label;
      const score = hit.placementScore === null ? '' : `, placement score ${hit.placementScore}/100`;
      return `${index + 1}. ${hit.time} ${action}: ${hit.verdict} (${hit.good ? 'counted' : 'not counted'}${score})`;
    }),
  };
  const listenText = thinking
    ? 'Thinking…'
    : listenStatus === 'listening'
      ? heard ? `Hearing: “${heard}”` : 'Listening… ask your question.'
      : listenStatus === 'standby'
        ? 'Say “Gemini, …” followed by your question.'
        : listenStatus === 'error'
          ? listenDetail
          : 'Tap the mic and ask a question, or turn on the wake word.';

  const heatmapRegion: SpatialRegion = view;
  const hasLiveRegionSignal = SPATIAL_REFERENCES[heatmapRegion].some(
    ({ id }) => readings[id] - baseline[id] >= Math.max(40, threshold * 0.2),
  );
  const heatmapInput = hasLiveRegionSignal
    ? readings
    : recentPattern?.region === heatmapRegion
      ? recentPattern.values
      : null;

  const spatialHeatmap = useMemo(
    () => heatmapInput
      ? estimatePlacement(heatmapRegion, heatmapInput, baseline, spatialSamples)
      : null,
    [heatmapRegion, heatmapInput, baseline, spatialSamples],
  );

  const visiblePlacement = spatialHeatmap ?? lastPlacement;

  const phaseRegion: SpatialRegion | null =
    phase === 'front' || phase === 'back' ? phase : null;
  const activeRegion: SpatialRegion | 'cpr' | null = active === null
    ? null
    : active <= 4 ? 'front' : active <= 7 ? 'back' : 'cpr';
  const livePhaseEstimate = phaseRegion && activeRegion === phaseRegion
    ? estimatePlacement(phaseRegion, readings, baseline, spatialSamples)
    : null;
  const liveAmbiguous = phaseRegion !== null &&
    activeRegion === phaseRegion && livePhaseEstimate?.uncertainty === 'broad';
  const activeWrong = active !== null && (
    scenario === 'cough' ||
    (phaseRegion !== null && (activeRegion !== phaseRegion || (livePhaseEstimate?.score ?? 0) < SPATIAL_SETTINGS.borderlineScore)) ||
    (phase === 'cpr' && active !== 8)
  );
  const activeHint = active !== null
    ? scenario === 'cough'
      ? 'An effective cough does not require physical intervention.'
      : phaseRegion && activeRegion === phaseRegion && livePhaseEstimate
        ? `${Math.round(livePhaseEstimate.score)}/100 approximate placement score. ${livePhaseEstimate.correction} Release to record or retry.`
        : activeWrong
          ? 'Wrong region for this step. Follow the highlighted target.'
          : 'Contact detected. Release to register the action.'
    : null;

  const diagramSensor = active ?? recentContact?.sensor ?? null;
  const diagramWrong = active !== null ? activeWrong : recentContact ? !recentContact.correct : false;

  return <div className="site-shell">
    <header className="topbar">
      <div className="brand"><Logo />
        <div>
          <strong>Thrustworthy</strong>
          <span>Hands-on first-aid learning</span></div></div>
      <div className="top-actions">
        {speechSupported() && <button type="button" className="connect-button" onClick={toggleVoice} aria-pressed={voiceOn} title="Speak feedback aloud"><Speaker on={voiceOn} />{voiceOn ? 'Voice on' : 'Voice off'}</button>}
        <span className={`connection-pill ${connection}`}><i />{connection === 'live' ? 'ESP32 connected' : connection === 'connecting' ? 'Connecting…' : connection === 'error' ? 'Connection issue' : 'Demo ready'}</span>
        <button type="button" className="connect-button" onClick={connection === 'live' ? () => { void disconnect(); } : () => { void connect(); }} disabled={connection === 'connecting'}><Usb />{connection === 'live' ? 'Disconnect' : 'Connect sensor'}</button>
      </div>
    </header>
    <main className="container">
      <div className="page-intro">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-dot" /> INTERACTIVE TRAINING STATION</div>
          <h1>Learn by doing. <span>Improve as you go.</span></h1>
          <p>Follow one clear instruction, practise on the mannequin, and receive instant placement feedback.</p></div>
        <div className="intro-note">
          <span>✳</span>
          <div>
            <strong>Powered by 9 pressure sensors</strong>
            <small>5 abdomen · 3 back · 1 chest</small></div></div>
      </div>
      <div className="modebar" aria-label="Trainer modes">
        <div className="mode-tabs" role="tablist" aria-label="Training tools">
          <button type="button" role="tab" aria-selected={mode === 'train'} className={mode === 'train' ? 'selected' : ''} onClick={() => { detector.current.reset(); setRecentPattern(null); setMode('train'); }}>Guided training</button>
          <button type="button" role="tab" aria-selected={mode === 'calibrate'} className={mode === 'calibrate' ? 'selected' : ''} onClick={() => { detector.current.reset(); setRecentPattern(null); setMode('calibrate'); }}>Calibrate</button>
          <button type="button" role="tab" aria-selected={mode === 'test'} className={mode === 'test' ? 'selected' : ''} onClick={() => { detector.current.reset(); setRecentPattern(null); setMode('test'); }}>Sensor test</button>
        </div>
        <span className="mode-status">{connection === 'live' ? 'LIVE INPUT' : 'SIMULATION MODE'}</span>
      </div>

      {connection === 'error' && <div className="connection-error" role="alert">{connectionDetail}</div>}

      {mode === 'train' && <>
        <div className="scenario-bar">
          <span className="field-label">SCENARIO</span>
          <div className="scenario-buttons">
            <button type="button" className={scenario === 'severe' ? 'selected' : ''} onClick={() => resetSession('severe')}>Severe choking</button>
            <button type="button" className={scenario === 'cough' ? 'selected' : ''} onClick={() => resetSession('cough')}>Effective cough</button>
            <button type="button" className={scenario === 'unresponsive' ? 'selected' : ''} onClick={() => resetSession('unresponsive')}>Unresponsive / CPR</button>
          </div>
          <button type="button" className="quiet-button reset" onClick={() => resetSession()}><Refresh /> Reset</button>
        </div>
        <section className="practice-grid">
          <article className="instruction-panel">
            <div className="instruction-top">
              <span className="instruction-step">YOUR NEXT ACTION</span>
              <span className="round-label">{scenario === 'severe' ? `ROUND ${counts.rounds + 1}` : 'PRACTICE'}</span></div>
            <span className="step-tag">
              <span className="step-tag-dot" />{promptTag}</span>
            <h2>{instruction}</h2>
            <ol className="step-list">
              {howTo.steps.map(step => <li key={step}>{step}</li>)}
            </ol>
            <button type="button" className="quiet-button hear-again" disabled={listenStatus === 'listening'} onClick={() => speak(howTo.spoken)}>
              <Speaker on /> Hear again</button>
            <div className="guide-callout">
              <span className="target-symbol">⌖</span>
              <div>
                <span>WHERE TO AIM</span>
                <strong>{guide}</strong></div></div>
            {scenario === 'severe' && <div className="sequence-panel">
              <div className="sequence-label">YOUR PROGRESS</div>
              <div className="sequence-item">
                <span>Back blows</span>
                <span>{counts.back}/5</span></div>
              <div className="progress-track">
                <span style={{ width: `${counts.back * 20}%` }} /></div>
              <div className="sequence-item">
                <span>Abdominal thrusts</span>
                <span>{counts.front}/5</span></div>
              <div className="progress-track">
                <span style={{ width: `${counts.front * 20}%` }} /></div></div>}
            {scenario === 'unresponsive' && <div className="sequence-panel">
              <div className="sequence-item">
                <span>Sternum contacts</span>
                <strong>{counts.cpr}</strong></div>
              <p className="tiny-note">We track placement contact, not compression depth or quality.</p></div>}
            {phase === 'review' && <button type="button" className="button-primary fill" onClick={nextRound}>Start another practice round →</button>}
            {scenario === 'cough' && <button type="button" className="button-primary fill" onClick={() => resetSession('severe')}>Cough becomes ineffective →</button>}
          </article>
          <article className="visual-panel">
            <div className="visual-head">
              <div>
                <div className="small-label">MANNEQUIN</div>
                <strong>Practice placement</strong></div>
              <div className="view-switch">
                <button type="button" className={view === 'back' ? 'on' : ''} onClick={() => setViewOverride('back')}>Back</button>
                <button type="button" className={view === 'front' ? 'on' : ''} onClick={() => setViewOverride('front')}>Front</button></div></div>
            <BodyDiagram view={view} active={diagramSensor} target={recommended} wrong={diagramWrong} cpr={phase === 'cpr'} onSensor={id => simulate([id])} flash={flash} heatmap={spatialHeatmap}
              severity={scenario === 'cough' ? 1 : scenario === 'severe' ? 2 : 3} />
            <div className="mannequin-guide">
              <span className="legend-dot" /> Smoothed contact estimate from nearby FSR readings; areas between sensors are inferred, not measured. Back left/right are from the back-facing view.</div>
          </article>
          <article className="coach-panel">
            <div className="coach-title">
              <div className="coach-badge">✦</div>
              <div>
                <div className="small-label">YOUR LIVE COACH</div>
                <strong>Instant feedback</strong></div></div>
            <div role="status" aria-live="polite" className={`feedback-box ${activeHint ? (liveAmbiguous ? 'neutral' : activeWrong ? 'warning' : 'success') : feedback.tone}`}>
              <div className="feedback-icon">{activeHint ? liveAmbiguous ? '?' : activeWrong ? '!' : '✓' : feedback.tone === 'success' ? '✓' : feedback.tone === 'warning' ? '!' : '◎'}
              </div>
              <div>
                <strong>{activeHint ? liveAmbiguous ? 'Placement uncertain' : activeWrong ? 'Adjust your placement' : 'Contact detected' : feedback.heading}</strong>
                <p>{activeHint ?? feedback.detail}</p></div>
            </div>
            {listeningSupported() && <div className="assistant-box">
              <div className="assistant-head">
                <span className="small-label">ASK GEMINI</span>
                <label className="assistant-toggle">
                  <input type="checkbox" checked={wakeOn} onChange={toggleWake} /> Listen for “Gemini”</label></div>
              <button type="button" className={`button-outline small assistant-mic ${listenStatus === 'listening' ? 'on' : ''}`} disabled={thinking} onClick={() => listener.current?.ask()}>
                <Mic />{listenStatus === 'listening' ? 'Listening… tap to send' : 'Ask a question'}</button>
              <p className="assistant-status" role="status">{listenText}</p>
              {exchange && <div className="assistant-exchange">
                <p className="assistant-q">“{exchange.question}”</p>
                {exchange.answer && <p className="assistant-a">{exchange.answer}</p>}</div>}
            </div>}
            {visiblePlacement && scenario === 'severe' && <div className="spatial-score">
              <div className="spatial-score-head">
                <span>Approximate target placement score</span>
                <strong>{Math.round(visiblePlacement.score)}/100</strong>
              </div>
              <div className="spatial-track"><span style={{ width: `${visiblePlacement.score}%` }} /></div>
              <div className="spatial-score-note">
                {visiblePlacement.calibrated ? 'Spatial references calibrated' : 'Uncalibrated preview model'}
                {' · '}
                {visiblePlacement.uncertainty === 'broad' ? 'Placement uncertain' : 'Approximate localisation'}
              </div>
              <p>{visiblePlacement.correction}</p>
              <small>Sparse-sensor estimate only; not a measured force, exact position, or clinically validated probability.</small>
            </div>}
            <div className="live-readout">
              <span className="readout-label">LIVE SENSOR</span>
              <strong>{liveSensor}</strong>
              <div className="live-pulse">
                <span className={active !== null ? 'lit' : ''} />{active === null ? 'Waiting for pressure' : `${Math.max(0, readings[active] - baseline[active])} above baseline`}</div></div>
            <div className="coach-divider" />
            <div className="result-stat">
              <div>
                <strong>{counts.correct}</strong>
                <span>Target contacts</span></div>
              <div>
                <strong>{counts.errors}</strong>
                <span>Needs correction</span></div></div>
            <div className="airway-row"><Airway scenario={scenario} />
              <p><b>Airway concept</b>
                <span>{scenario === 'cough' ? 'A strong cough can move air and may clear the obstruction.' : 'Illustration only. Sensor signals cannot detect airway clearance.'}</span></p></div>
          </article>
        </section>
        <section className="action-strip">
          <div className="action-strip-copy">
            <span className="action-strip-icon">◉</span>
            <div>
              <strong>Try it now</strong>
              <span>{connection === 'live' ? 'Use your physical mannequin.' : 'No hardware? Simulate a sensor contact to test the feedback.'}</span></div></div>
          <div className="action-strip-controls">
            {connection !== 'live' && <>
              <button type="button" className="button-primary" disabled={simBusy || recommended === null} onClick={() => recommended !== null && simulate([recommended])}>Simulate correct contact <span>↗</span></button>
              <button type="button" className="button-outline" disabled={simBusy} onClick={() => simulate(phase === 'back' ? [6] : phase === 'front' ? [1] : phase === 'cpr' ? [0] : [0])}>Try incorrect contact</button>
            </>}
            <button type="button" className="text-button" onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>{advanced ? 'Hide' : 'Show'} raw readings <span>{advanced ? '↑' : '↓'}</span></button>
          </div>
        </section>
        {advanced && <section className="raw-panel">
          <h3>Live sensor values <span>0–4095 ADC</span></h3>
          <div className="raw-grid">{SENSOR_NAMES.map((name, i) => <div key={name} className="raw-item">
            <div>
              <span>{name}</span><b>{readings[i]}</b></div><SensorMeter value={readings[i]} baseline={baseline[i]} threshold={threshold} /></div>)}</div></section>}
        <section className="summary-bar">
          <div>
            <span className="section-kicker">SESSION SNAPSHOT</span>
            <strong>{history.length ? `${history.length} recent contacts` : 'Your progress will appear here'}</strong>
            <span>{history.length ? history[0].verdict : 'Use the highlighted target to start your first practice.'}</span></div>
          <div className="summary-controls">
            <button type="button" className="button-outline small" onClick={downloadSummary}>Export results ↓</button>
            <button type="button" className="button-outline small" onClick={() => { detector.current.reset(); setRecentPattern(null); setMode('test'); }}>Check sensors →</button></div></section>
      </>}

      {mode === 'calibrate' && <section className="tool-layout">
        <div className="tool-intro">
          <span className="step-tag">SETUP / CALIBRATION</span>
          <h2>Make every reading meaningful.</h2>
          <p>FSRs can have a resting offset. Capture a baseline while all sensors are untouched, then adjust the ADC change required to register contact.</p>
          <div className="cal-step">
            <span>01</span>
            <p>
              <strong>Release all sensors</strong><br />Keep the mannequin completely untouched while capturing baseline.</p></div>
          <div className="cal-step">
            <span>02</span>
            <p>
              <strong>Capture resting readings</strong><br />Uses the latest available samples; data remains in the browser.</p></div>
          <button type="button" className="button-primary fill" onClick={calibrateRest}><Check /> Capture resting baseline</button>
          <div className={`cal-status ${calibrated ? 'done' : ''}`}>{calibrated ? '✓ Baseline captured — now test each sensor.' : '○ Baseline not captured this session'}</div></div>
        <div className="tool-workspace">
          <div className="workspace-head">
            <h3>Sensitivity</h3>
            <span>Training threshold, not a force measurement</span></div>
          <div className="threshold-value">
            <strong>{threshold}</strong>
            <span>ADC above baseline</span></div>
          <input className="threshold-slider" type="range" min="150" max="1600" step="25" value={threshold} onChange={(e: { target: { value: string } }) => { const val = Number(e.target.value); thresholdRef.current = val; setThreshold(val); detector.current.reset(); }} aria-label="Contact threshold" />
          <div className="threshold-ends">
            <span>More sensitive</span>
            <span>Less sensitive</span></div>
          <div className="workspace-head compact">
            <h3>Resting values</h3>
            <span>Raw ADC per sensor</span></div>
          <div className="baseline-grid">{SENSOR_NAMES.map((name, i) => <div key={name}>
            <span>{name}</span>
            <strong>{baseline[i]}</strong></div>)}
          </div>
          <div className="spatial-calibration">
            <div className="workspace-head compact">
              <h3>Spatial reference calibration</h3>
              <span>Improves the multi-sensor placement model</span>
            </div>
            <p className="tiny-note">For each labelled location, apply pressure there and click Capture while holding it. In Demo mode, buttons generate clearly labelled synthetic references. Calibrate each position on the actual mannequin before trusting physical feedback.</p>
            {(['back', 'front'] as const).map(region => (
              <div key={region} className="spatial-cal-group">
                <div className="spatial-cal-group-header">
                  <strong>{region === 'back' ? 'Back placement' : 'Abdominal placement'}</strong>
                  <span>{calibratedCount(region, spatialSamples)}/{SPATIAL_REFERENCES[region].length} references</span>
                </div>
                {SPATIAL_REFERENCES[region].map(reference => (
                  <div key={reference.id} className="spatial-cal-row">
                    <span>{SENSOR_NAMES[reference.id]}</span>
                    <button type="button" className="button-outline small" onClick={() => captureSpatialReference(region, reference.id)}>
                      {spatialSamples[region][reference.id] ? 'Recapture' : connection === 'live' ? 'Capture' : 'Simulate'}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            <div className="cal-status" role="status">{calibrationMessage}</div>
            <button type="button" className="button-outline small" onClick={() => {
              const cleared = emptySpatialSamples();
              spatialSamplesRef.current = cleared;
              setSpatialSamples(cleared);
              setCalibrationMessage('Spatial references cleared.');
            }}>Clear spatial references</button>
          </div>
          <div className="tip-line">ⓘ Repeat calibration after repositioning the hardware or changing resistor wiring. Calibrate medical technique separately with an instructor.</div></div></section>}

      {mode === 'test' && <section className="tool-layout">
        <div className="tool-intro">
          <span className="step-tag">HARDWARE / DIAGNOSTICS</span>
          <h2>Test all nine sensors in one place.</h2>
          <p>Press each pad on the mannequin. The corresponding row should respond immediately. Use the test buttons to simulate channels without an ESP32.</p>
          <div className="test-progress">
            <strong>{testTouched.length}<span>/9</span></strong>
            <p>Sensors triggered</p>
            <div className="progress-track">
              <span style={{ width: `${testTouched.length / 9 * 100}%` }} /></div></div>
          <button type="button" className="button-outline" onClick={() => setTestTouched([])}>Reset test results</button>
          <p className="tiny-note">This checks electronic response and logical mapping. It does not validate physical force, technique or CPR compression depth.</p></div>
        <div className="tool-workspace">
          <div className="workspace-head">
            <h3>Live sensor monitor</h3>
            <span>Trigger a sensor to mark it tested</span></div>
          <div className="sensor-table">{SENSOR_GROUPS.map(group => <div key={group.name}>
            <div className="sensor-group-label">{group.name}</div>{group.ids.map(id => <div className="sensor-table-row" key={id}>
              <span className={`sensor-tick ${testTouched.includes(id) ? 'hit' : ''}`}>{testTouched.includes(id) ? <Check size={13} /> : '·'}</span>
              <div className="sensor-row-main">
                <div>
                  <strong>{SENSOR_NAMES[id]}</strong>
                  <span>{readings[id]} live · {peaks[id]} peak</span></div><SensorMeter value={readings[id]} baseline={baseline[id]} threshold={threshold} /></div>
              <button type="button" disabled={simBusy || connection === 'live'} className="mini-test-btn" onClick={() => simulate([id])}>Test</button></div>)}</div>)}
          </div>
          <div className="tip-line">{connection === 'live' ? 'Reading live ESP32 input.' : 'Demo mode: test buttons generate synthetic ADC press-and-release frames.'} {framesReceived} frames processed. {connectionDetail}</div></div></section>}

      <footer className="footer">
        <div>
          <span className="footer-logo">✳</span> Thrustworthy <span className="footer-sep">·</span> Demo training prototype</div>
        <p>Adult scenarios based on AHA 2025 guidance. Not medical certification, not for use during an emergency. FSRs detect contact, not clinically effective force or compression depth.</p><a href="https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support" target="_blank" rel="noreferrer">Training reference ↗</a></footer>
    </main>
  </div>;
}
