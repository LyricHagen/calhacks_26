// Spoken Q&A: listen for "Gemini, ..." (or a mic-button press), send the
// question plus the current training state to Gemini, and return a short
// answer for the caller to speak.

import { isSpeaking } from './speech';

// Chrome's recogniser sometimes hears "Gemini" as one of these.
const WAKE_WORD = /\b(?:hey\s+)?(gemini|jemini|geminy|jiminy|jemmy knee)\b[\s,.!?]*/i;
// After a bare "Gemini", how long to wait for the question.
const FOLLOW_UP_MS = 7000;
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
- If the question is unrelated to first aid or this trainer, say briefly that you can only help with the training.`;

export type AssistantContext = {
  scenario: string;
  step: string;
  instruction: string;
  progress: string;
  lastFeedback: string;
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
  onWake: () => void;
  onStatus: (status: ListenerStatus, detail?: string) => void;
};

// One recogniser at a time: Chrome won't run two. Wake mode listens
// continuously and restarts itself; listenOnce() takes over for a single
// utterance, then hands back to wake mode if it is enabled.
export class VoiceListener {
  private recognition: Recognition | null = null;
  private wakeEnabled = false;
  private oneShot = false;
  private awaitingUntil = 0;

  constructor(private callbacks: ListenerCallbacks) {}

  setWakeWord(enabled: boolean): void {
    this.wakeEnabled = enabled;

    if (enabled && !this.recognition) {
      this.start(false);
    } else if (!enabled && !this.oneShot) {
      this.stop();
    }
  }

  listenOnce(): void {
    this.oneShot = true;
    this.recognition?.abort();
    this.start(true);
  }

  dispose(): void {
    this.wakeEnabled = false;
    this.oneShot = false;
    this.stop();
  }

  private stop(): void {
    const current = this.recognition;
    this.recognition = null;
    current?.abort();
    this.callbacks.onStatus('off');
  }

  private start(oneShot: boolean): void {
    const Recognition = recognitionClass();

    if (!Recognition) {
      this.callbacks.onStatus('error', 'Speech recognition needs Chrome or Edge.');
      return;
    }

    const recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.continuous = !oneShot;
    recognition.interimResults = false;
    this.recognition = recognition;

    recognition.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];

        if (result.isFinal) {
          this.handleTranscript(result[0].transcript.trim(), oneShot);
        }
      }
    };

    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.wakeEnabled = false;
        this.oneShot = false;
        this.callbacks.onStatus('error', 'Microphone access was blocked.');
      }
      // 'no-speech' / 'aborted' / 'network' just end the session; onend restarts.
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) {
        return;
      }

      this.recognition = null;

      if (oneShot) {
        this.oneShot = false;
      }

      if (this.wakeEnabled) {
        // Chrome ends continuous sessions after silence; keep listening.
        this.start(false);
      } else {
        this.callbacks.onStatus('off');
      }
    };

    try {
      recognition.start();
      this.callbacks.onStatus(oneShot ? 'listening' : 'standby');
    } catch {
      this.recognition = null;
      this.callbacks.onStatus('error', 'Could not start the microphone.');
    }
  }

  private handleTranscript(transcript: string, oneShot: boolean): void {
    if (!transcript) {
      return;
    }

    if (oneShot) {
      this.callbacks.onQuestion(transcript);
      return;
    }

    // Ignore our own voice coming back through the mic.
    if (isSpeaking()) {
      return;
    }

    if (Date.now() < this.awaitingUntil) {
      this.awaitingUntil = 0;
      this.callbacks.onStatus('standby');
      this.callbacks.onQuestion(transcript);
      return;
    }

    const match = WAKE_WORD.exec(transcript);

    if (!match) {
      return;
    }

    const question = transcript.slice(match.index + match[0].length).trim();

    if (question.length > 2) {
      this.callbacks.onQuestion(question);
    } else {
      // Bare "Gemini": wait for the question in the next phrase.
      this.awaitingUntil = Date.now() + FOLLOW_UP_MS;
      this.callbacks.onWake();
      this.callbacks.onStatus('listening');
      setTimeout(() => {
        if (this.awaitingUntil && Date.now() >= this.awaitingUntil) {
          this.awaitingUntil = 0;
          if (this.recognition) this.callbacks.onStatus('standby');
        }
      }, FOLLOW_UP_MS + 50);
    }
  }
}
