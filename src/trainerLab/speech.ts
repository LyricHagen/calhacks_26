// Short spoken cues so trainees don't have to read the screen mid-practice.
// Gemini TTS voices each cue once; the audio is cached in the browser so
// playback is instant. Until a cue is cached (or if Gemini is unavailable),
// the browser's built-in speech synthesis says it instead.

import { GUIDE_CUES } from './instructions';

const CACHE_NAME = 'thrustworthy-gemini-tts-v1';
const VOICE_NAME = 'Kore';
const STYLE_PROMPT = 'Say in a calm, clear, encouraging first-aid coach voice:';
// Spoken answers aren't cached, so cap how long we wait for Gemini audio.
const ANSWER_TTS_TIMEOUT_MS = 5000;

// Fixed cues fetched up front. Anything not listed is fetched the first time it is spoken.
export const PRELOAD_CUES = [
  'Voice coaching on.',
  ...GUIDE_CUES,
  'Good. one.', 'Good. two.', 'Good. three.', 'Good. four.',
  'Too high. Move down.',
  'Too low. Move up.',
  'Off centre. Move to the middle.',
  'Too high. Shift down.',
  'Too low. Move up between the shoulder blades.',
  'Almost there.',
  'Unclear. Reposition.',
  'Unclear. Try again.',
  'Back blows first.',
  'Too fast. Pause between each one.',
  'Too slow. Make it a quick, sharp blow.',
  'Too slow. Make it a quick thrust.',
  'Counted. Keep the pace up.',
  'Switch to abdominal thrusts.',
  'Round complete. Reassess.',
  'Stop. Encourage them to keep coughing.',
  'Move to the centre of the chest.',
];

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// ---------- Browser fallback ----------

let preferredVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) {
    return preferredVoice;
  }

  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter(voice => voice.lang.toLowerCase().startsWith('en'));

  preferredVoice =
    english.find(voice => voice.localService && voice.default) ??
    english.find(voice => voice.localService) ??
    english[0] ??
    null;

  return preferredVoice;
}

if (speechSupported()) {
  // Voices load asynchronously in Chrome; re-pick once they arrive.
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    preferredVoice = null;
  });
}

let activeUtterance: SpeechSynthesisUtterance | null = null;

function speakWithBrowser(text: string): void {
  if (!speechSupported()) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();

  if (voice) {
    utterance.voice = voice;
  }

  utterance.rate = 1.1;
  // Track our own utterance: speechSynthesis.speaking can stay true after cancel().
  activeUtterance = utterance;
  const done = () => {
    if (activeUtterance === utterance) {
      activeUtterance = null;
    }
  };
  utterance.onend = done;
  utterance.onerror = done;
  window.speechSynthesis.speak(utterance);
}

// ---------- Gemini TTS ----------

type GeminiResponse = {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
};

const decoded = new Map<string, AudioBuffer>();
const pending = new Map<string, Promise<AudioBuffer | null>>();
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
// Bumped by every speak/stop so a slow answer can't talk over newer feedback.
let speechToken = 0;
// Set after an auth/config failure so we stop hammering the proxy.
let geminiDisabled = false;

function context(): AudioContext {
  audioContext ??= new AudioContext();
  return audioContext;
}

function cacheKey(text: string): string {
  return `/tts-cache/${VOICE_NAME}/${encodeURIComponent(text)}`;
}

async function readCache(text: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey(text));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function writeCache(text: string, audio: { data: string; mimeType: string }): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey(text), new Response(JSON.stringify(audio)));
  } catch {
    // Cache Storage unavailable (private window etc.): audio still lives in memory.
  }
}

async function requestGemini(text: string): Promise<{ data: string; mimeType: string } | null> {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${STYLE_PROMPT} ${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
      },
    }),
  });

  if (!response.ok) {
    // 400/401/403/404 mean a missing key or wrong model: no point retrying.
    if (response.status !== 429 && response.status < 500) {
      geminiDisabled = true;
      console.warn(`Gemini TTS disabled (HTTP ${response.status}); using browser voice.`, await response.text());
    }
    return null;
  }

  const body = await response.json() as GeminiResponse;
  const inline = body.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;

  return inline?.data
    ? { data: inline.data, mimeType: inline.mimeType ?? 'audio/L16;rate=24000' }
    : null;
}

// Gemini returns raw 16-bit little-endian mono PCM, usually at 24 kHz.
function pcmToBuffer(base64: string, mimeType: string): AudioBuffer {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const buffer = context().createBuffer(1, samples.length, rate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < samples.length; index++) {
    channel[index] = samples[index] / 32768;
  }

  return buffer;
}

function loadCue(text: string): Promise<AudioBuffer | null> {
  const ready = decoded.get(text);

  if (ready) {
    return Promise.resolve(ready);
  }

  const inFlight = pending.get(text);

  if (inFlight) {
    return inFlight;
  }

  const job = (async () => {
    try {
      let audio = await readCache(text);

      if (!audio && !geminiDisabled) {
        audio = await requestGemini(text);

        if (audio) {
          await writeCache(text, audio);
        }
      }

      if (!audio) {
        return null;
      }

      const buffer = pcmToBuffer(audio.data, audio.mimeType);
      decoded.set(text, buffer);
      return buffer;
    } catch (error) {
      console.warn('Gemini TTS request failed; using browser voice.', error);
      return null;
    } finally {
      pending.delete(text);
    }
  })();

  pending.set(text, job);
  return job;
}

// Fetch the fixed cues one at a time so preview-tier rate limits aren't hit all at once.
export async function preloadCues(cues: readonly string[] = PRELOAD_CUES): Promise<void> {
  for (const cue of cues) {
    if (geminiDisabled) {
      return;
    }

    await loadCue(cue);
  }
}

function playBuffer(buffer: AudioBuffer): void {
  const ctx = context();
  void ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (currentSource === source) {
      currentSource = null;
    }
  };
  source.start();
  currentSource = source;
}

// Each new cue interrupts the previous one: during rapid back blows the
// latest feedback is the only one that still matters.
export function speak(text: string): void {
  if (!text) {
    return;
  }

  stopSpeech();

  const buffer = decoded.get(text);

  if (!buffer) {
    // Never make the trainee wait on the network: say it now, fetch for next time.
    speakWithBrowser(text);
    void loadCue(text);
    return;
  }

  playBuffer(buffer);
}

// One-off text (assistant answers): wait briefly for Gemini audio, else use the browser voice.
export async function speakAnswer(text: string): Promise<void> {
  if (!text) {
    return;
  }

  stopSpeech();
  const token = speechToken;
  let audio: { data: string; mimeType: string } | null = null;

  if (!geminiDisabled) {
    try {
      audio = await Promise.race([
        requestGemini(text),
        new Promise<null>(resolve => setTimeout(() => resolve(null), ANSWER_TTS_TIMEOUT_MS)),
      ]);
    } catch (error) {
      console.warn('Gemini TTS request failed; using browser voice.', error);
    }
  }

  if (token !== speechToken) {
    return;
  }

  if (audio) {
    playBuffer(pcmToBuffer(audio.data, audio.mimeType));
  } else {
    speakWithBrowser(text);
  }
}

export function isSpeaking(): boolean {
  return currentSource !== null || activeUtterance !== null;
}

// Short beep acknowledging the wake word; not a word, so the mic won't transcribe it.
export function chime(): void {
  const ctx = context();
  void ctx.resume();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.18);
}

export function stopSpeech(): void {
  speechToken += 1;
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  activeUtterance = null;

  if (speechSupported()) {
    window.speechSynthesis.cancel();
  }
}
