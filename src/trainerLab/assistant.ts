// Spoken Q&A: listen for "Gemini, ..." (or a mic-button press), send the
// question plus the current training state to Gemini, and return a short
// answer for the caller to speak.

import { chime, stopSpeech } from './speech';

// Chrome's recogniser sometimes hears "Gemini" as one of these. Only
// matches at the start of a phrase, so bystanders saying "the Gemini booth"
// don't trigger it.
const WAKE_WORD = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(gemini|jemini|geminy|jiminy|jemmy knee)\b[\s,.!?]*/i;
// How long a mic press (or bare "Gemini") waits for the question to start.
const START_TIMEOUT_MS = 8000;
// Once they're talking, this much silence means the question is finished.
const END_OF_QUESTION_MS = 1800;
// Hard stop once they've started talking, in case noise never lets it go quiet.
const MAX_QUESTION_MS = 15000;
// Pause between Chrome ending a session and starting the next one.
const RESTART_DELAY_MS = 250;
// More restarts than this within the window means recognition is failing, not idling.
const MAX_RESTARTS = 6;
const RESTART_WINDOW_MS = 10000;
const MAX_HISTORY_TURNS = 3;
const ASK_TIMEOUT_MS = 12000;

const SYSTEM_PROMPT = `You are the voice coach inside Thrustworthy, a first-aid training station.
A trainee is practising on a mannequin fitted with pressure sensors: back blows and abdominal thrusts for adult severe choking, and CPR hand placement on the sternum.
Your answer is read aloud while their hands are busy, so:
- Reply in one or two short spoken sentences. No lists, markdown, or emoji.
- Follow current AHA / Red Cross adult guidance. Never invent techniques.
- The sensors only detect contact location and timing. They cannot measure force, compression depth, or whether an airway cleared, so never claim they do.
- Do not contradict the sensor feedback in the state below; explain it instead.
- This is training only. If someone describes a real emergency, tell them to call emergency services now.
- If the question is unrelated to first aid or this trainer, say briefly that you can only help with the training.
- Never say the word "Gemini": it is the wake word, and saying it would trigger the microphone.`;

export type AssistantContext = {
  scenario: string;
  step: string;
  instruction: string;
  progress: string;
  lastFeedback: string;
  // One line per recent contact, oldest first.
  recentHits: string[];
};

type Turn = { role: 'user' | 'model'; text: string };
type GeminiTextResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string };
};

const history: Turn[] = [];

export async function askGemini(question: string, state: AssistantContext): Promise<string> {
  const stateText = [
    `Scenario: ${state.scenario}`,
    `Current step: ${state.step}`,
    `On-screen instruction: ${state.instruction}`,
    `Progress: ${state.progress}`,
    `Latest sensor feedback: ${state.lastFeedback}`,
    `Recent contacts (oldest first):\n${state.recentHits.length ? state.recentHits.join('\n') : 'None yet.'}`,
  ].join('\n');

  const contents = [
    ...history.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user', parts: [{ text: `[Trainer state]\n${stateText}\n\n[Question]\n${question}` }] },
  ];

  let response: Response;

  try {
    response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Overloaded models can stall for over a minute; give up quickly instead.
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        // Answers are short and latency matters more than deliberation.
        generationConfig: { temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
  } catch {
    throw new Error('Gemini took too long to respond.');
  }

  const body = await response.json().catch(() => ({})) as GeminiTextResponse;

  if (!response.ok) {
    throw new Error(body.error?.message ?? `Gemini request failed (HTTP ${response.status})`);
  }

  const answer = body.candidates?.[0]?.content?.parts
    ?.map(part => part.text ?? '')
    .join('')
    .trim();

  if (!answer) {
    throw new Error('Gemini returned an empty answer.');
  }

  history.push({ role: 'user', text: question }, { role: 'model', text: answer });
  history.splice(0, Math.max(0, history.length - MAX_HISTORY_TURNS * 2));

  return answer;
}

// ---------- Microphone ----------

// Ask for mic access up front. Speech recognition can only show the
// permission prompt after a click, but getUserMedia can prompt on load.
export async function requestMicrophone(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch {
    return false;
  }
}

// ---------- Speech recognition ----------

type RecognitionResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };

  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function listeningSupported(): boolean {
  return recognitionClass() !== null;
}

export type ListenerStatus = 'off' | 'standby' | 'listening' | 'error';

type ListenerCallbacks = {
  onQuestion: (question: string) => void;
  onStatus: (status: ListenerStatus, detail?: string) => void;
  // Live transcript while a question is being captured ('' when cleared).
  onHeard?: (text: string) => void;
};

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow it from the icon in the address bar.',
  'service-not-allowed': 'Microphone access is blocked. Allow it from the icon in the address bar.',
  'audio-capture': 'No microphone found. Check that one is connected and selected.',
  network: 'Speech recognition needs internet: Chrome sends the audio to Google to transcribe it.',
};

// Wraps Chrome's recogniser with the parts it gets wrong:
// - It decides a question is over at the first pause, so we always run it in
//   continuous mode and decide the end ourselves from a silence timer.
// - Sessions end on their own (silence, ~60 s, network blips), so we restart
//   them, but only after the previous one has fully ended: starting a new
//   one while the old is shutting down silently fails.
// - A restart loop means it is broken, so we stop and say why.
export class VoiceListener {
  private recognition: Recognition | null = null;
  private stopping = false;
  private wakeEnabled = false;
  private capturing = false;
  private question = '';
  private partial = '';
  private error = '';
  private restarts: number[] = [];
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private callbacks: ListenerCallbacks) {}

  // True while waiting for or hearing a question; callers should stay quiet.
  get isCapturing(): boolean {
    return this.capturing;
  }

  setWakeWord(enabled: boolean): void {
    this.wakeEnabled = enabled;
    this.error = '';

    if (enabled) {
      this.ensureRunning();
    } else if (!this.capturing) {
      this.stopRecognition();
    }

    this.emitStatus();
  }

  // Mic button: start a question, or send it early if one is in progress.
  ask(): void {
    if (this.capturing) {
      this.finishQuestion();
    } else {
      this.openQuestion('');
    }
  }

  dispose(): void {
    this.wakeEnabled = false;
    this.closeQuestion();
    this.stopRecognition();
  }

  private openQuestion(initial: string): void {
    // Silence the app so the mic hears the question, not our own voice.
    stopSpeech();
    chime();
    this.error = '';
    this.capturing = true;
    this.question = initial;
    this.partial = '';
    this.callbacks.onHeard?.(initial);
    this.ensureRunning();
    this.emitStatus();

    if (initial) {
      this.heardSpeech();
    } else {
      this.startTimer = setTimeout(() => this.finishQuestion(), START_TIMEOUT_MS);
    }
  }

  // Something new was heard: restart the end-of-question countdown.
  private heardSpeech(): void {
    this.clearTimer('startTimer');

    if (!this.capTimer) {
      this.capTimer = setTimeout(() => this.finishQuestion(), MAX_QUESTION_MS);
    }

    this.clearTimer('silenceTimer');
    this.silenceTimer = setTimeout(() => this.finishQuestion(), END_OF_QUESTION_MS);
  }

  private finishQuestion(): void {
    if (!this.capturing) {
      return;
    }

    // Chrome may never finalise the last phrase, so include the latest partial text.
    const question = `${this.question} ${this.partial}`.trim();
    console.debug('[voice] question finished:', question || '(nothing heard)');
    this.closeQuestion();

    if (!this.wakeEnabled) {
      this.stopRecognition();
    }

    this.emitStatus();

    if (question.length > 2) {
      this.callbacks.onQuestion(question);
    }
  }

  private closeQuestion(): void {
    this.capturing = false;
    this.question = '';
    this.partial = '';
    this.clearTimer('startTimer');
    this.clearTimer('silenceTimer');
    this.clearTimer('capTimer');
    this.callbacks.onHeard?.('');
  }

  private clearTimer(name: 'startTimer' | 'silenceTimer' | 'capTimer' | 'restartTimer'): void {
    const timer = this[name];

    if (timer) {
      clearTimeout(timer);
    }

    this[name] = null;
  }

  private get wanted(): boolean {
    return this.wakeEnabled || this.capturing;
  }

  private emitStatus(): void {
    if (this.error) {
      this.callbacks.onStatus('error', this.error);
    } else if (this.capturing) {
      this.callbacks.onStatus('listening');
    } else if (this.wakeEnabled) {
      this.callbacks.onStatus('standby');
    } else {
      this.callbacks.onStatus('off');
    }
  }

  private fail(message: string): void {
    console.debug('[voice] giving up:', message);
    this.error = message;
    this.wakeEnabled = false;
    this.closeQuestion();
    this.stopRecognition();
    this.emitStatus();
  }

  private stopRecognition(): void {
    this.clearTimer('restartTimer');

    if (this.recognition && !this.stopping) {
      this.stopping = true;
      this.recognition.abort();
    }
  }

  private ensureRunning(): void {
    // Already running, or a restart is queued. If it is shutting down,
    // onend will see that we still want it and start a fresh one.
    if (this.recognition || this.restartTimer) {
      return;
    }

    const Recognition = recognitionClass();

    if (!Recognition) {
      this.fail('Speech recognition needs Chrome or Edge.');
      return;
    }

    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    // Partial results tell us the trainee is still mid-sentence.
    recognition.interimResults = true;

    recognition.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        this.handleResult(result[0].transcript.trim(), result.isFinal);
      }
    };

    recognition.onerror = event => {
      console.debug('[voice] recognition error:', event.error);
      const message = ERROR_MESSAGES[event.error];

      if (message && event.error !== 'network') {
        this.fail(message);
      } else if (event.error === 'network') {
        // Often a blip; only give up if it keeps happening (see restart loop check).
        this.error = '';
      }
      // 'no-speech' / 'aborted' just end the session; onend decides what next.
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) {
        return;
      }

      this.recognition = null;
      this.stopping = false;

      if (this.wanted) {
        this.scheduleRestart();
      }
    };

    try {
      recognition.start();
      this.recognition = recognition;
      console.debug('[voice] recognition started');
    } catch (error) {
      console.debug('[voice] could not start recognition:', error);
      this.fail('Could not start the microphone.');
    }
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restarts = this.restarts.filter(time => now - time < RESTART_WINDOW_MS);
    this.restarts.push(now);

    if (this.restarts.length > MAX_RESTARTS) {
      this.restarts = [];
      this.fail(ERROR_MESSAGES.network);
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;

      if (this.wanted) {
        this.ensureRunning();
      }
    }, RESTART_DELAY_MS);
  }

  private handleResult(transcript: string, isFinal: boolean): void {
    if (!transcript) {
      return;
    }

    if (this.capturing) {
      console.debug(`[voice] heard (${isFinal ? 'final' : 'partial'}):`, transcript);

      if (isFinal) {
        this.question = `${this.question} ${transcript}`.trim();
        this.partial = '';
      } else if (transcript === this.partial) {
        // Unchanged partials are usually background noise; don't let them
        // hold the question open.
        return;
      } else {
        this.partial = transcript;
      }

      this.callbacks.onHeard?.(`${this.question} ${this.partial}`.trim());
      this.heardSpeech();
      return;
    }

    // Wake word: only complete phrases, only when enabled. No spoken cue
    // contains "Gemini", so a match is the trainee even while the app is
    // talking; openQuestion() cuts our speech off.
    if (!isFinal || !this.wakeEnabled) {
      return;
    }

    const match = WAKE_WORD.exec(transcript);

    if (match) {
      console.debug('[voice] wake word:', transcript);
      this.openQuestion(transcript.slice(match.index + match[0].length).trim());
    }
  }
}
