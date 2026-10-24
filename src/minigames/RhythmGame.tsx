import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type MutableRefObject } from 'react';
import type { NineReadings } from '../trainerLab/sensors';
import {
  accuracy, createGame, expireNotes, FrontTapDetector, HIT_WINDOW_MS,
  FIRST_BEAT_MS, judgeTap, LANES, LEVELS, SONG_LENGTH_MS, TRAVEL_MS,
  type Difficulty, type Game,
} from './rhythmEngine';
import '../rhythm.css';

type FrameInput = (readings: NineReadings, receivedAtMs: number) => void;
type Props = {
  inputRef: MutableRefObject<FrameInput>;
  baseline: NineReadings;
  threshold: number;
  connected: boolean;
};

export function RhythmGame({ inputRef, baseline, threshold, connected }: Props) {
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [status, setStatus] = useState<'idle' | 'playing' | 'done'>('idle');
  const [game, setGame] = useState<Game>(() => createGame('normal'));
  const [elapsed, setElapsed] = useState(0);
  const [latencyMs, setLatencyMs] = useState(35);
  const [audioOn, setAudioOn] = useState(true);
  const [lastLane, setLastLane] = useState<number | null>(null);
  const [lastHitTime, setLastHitTime] = useState(-1);
  const gameRef = useRef(game);
  const runningRef = useRef(false);
  const startAtRef = useRef(0);
  const detectorRef = useRef(new FrontTapDetector());
  const audioRef = useRef<AudioContext | null>(null);
  const nextBeatRef = useRef(0);
  const latencyRef = useRef(latencyMs);
  const pressRef = useRef<(lane: number, atTime: number) => void>(() => {});

  latencyRef.current = latencyMs;

  function update(next: Game) {
    gameRef.current = next;
    setGame(next);
  }

  function tap(lane: number, receivedAtMs: number) {
    if (!runningRef.current) return;
    const tapTimeMs = receivedAtMs - startAtRef.current - latencyRef.current;
    update(judgeTap(gameRef.current, lane, tapTimeMs));
    setLastLane(lane);
    setLastHitTime(receivedAtMs);
  }
  pressRef.current = tap;

  useEffect(() => {
    inputRef.current = (values, atTime) => {
      if (!runningRef.current) return;
      const lane = detectorRef.current.process(values, baseline, threshold, atTime);
      if (lane !== null) pressRef.current(lane, atTime);
    };
    return () => { inputRef.current = () => {}; };
  }, [inputRef, baseline, threshold]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      const lane = LANES.findIndex(item => item.key === event.key.toLowerCase());
      if (lane < 0 || !runningRef.current) return;
      event.preventDefault();
      pressRef.current(lane, performance.now());
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  function playBeat(when: number, accent: boolean) {
    const context = audioRef.current;
    if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(accent ? 720 : 520, when);
    oscillator.frequency.exponentialRampToValueAtTime(accent ? 390 : 310, when + 0.055);
    volume.gain.setValueAtTime(0.0001, when);
    volume.gain.exponentialRampToValueAtTime(accent ? 0.19 : 0.11, when + 0.005);
    volume.gain.exponentialRampToValueAtTime(0.0001, when + 0.075);
    oscillator.connect(volume).connect(context.destination);
    oscillator.start(when);
    oscillator.stop(when + 0.09);
  }

  function start() {
    // Browser audio is unlocked only by a direct user gesture.
    void audioRef.current?.close();
    audioRef.current = null;
    if (audioOn) {
      try {
        const audio = new AudioContext();
        void audio.resume();
        audioRef.current = audio;
      } catch { /* Visual/keyboard mode still works without audio. */ }
    }
    const next = createGame(difficulty);
    update(next);
    detectorRef.current.reset();
    nextBeatRef.current = 0;
    startAtRef.current = performance.now();
    runningRef.current = true;
    setElapsed(0);
    setLastLane(null);
    setStatus('playing');
  }

  function finish() {
    runningRef.current = false;
    setStatus('done');
    void audioRef.current?.close();
    audioRef.current = null;
  }

  useEffect(() => {
    if (status !== 'playing') return;
    let raf = 0;
    const bpm = LEVELS[difficulty].bpm;
    const interval = 60000 / bpm;
    const finalTime = FIRST_BEAT_MS + SONG_LENGTH_MS + HIT_WINDOW_MS + 250;
    const tick = () => {
      if (!runningRef.current) return;
      const now = performance.now() - startAtRef.current;
      setElapsed(now);
      const expired = expireNotes(gameRef.current, now);
      if (expired !== gameRef.current) update(expired);
      while (FIRST_BEAT_MS + nextBeatRef.current * interval <= now + 110 &&
             FIRST_BEAT_MS + nextBeatRef.current * interval < FIRST_BEAT_MS + SONG_LENGTH_MS) {
        const at = FIRST_BEAT_MS + nextBeatRef.current * interval;
        const context = audioRef.current;
        if (context) playBeat(context.currentTime + Math.max(0, (at - now) / 1000), nextBeatRef.current % 4 === 0);
        nextBeatRef.current += 1;
      }
      if (now >= finalTime) { finish(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, difficulty]);

  useEffect(() => () => {
    runningRef.current = false;
    void audioRef.current?.close();
  }, []);

  const percent = Math.min(100, Math.max(0, (elapsed - FIRST_BEAT_MS) / SONG_LENGTH_MS * 100));
  const remaining = Math.max(0, Math.ceil((FIRST_BEAT_MS + SONG_LENGTH_MS - elapsed) / 1000));
  const finished = status === 'done';
  const display = status === 'idle' ? createGame(difficulty) : game;

  return <section className="pb-shell" aria-label="Pulse Beat rhythm game">
    <div className="pb-heading">
      <div>
        <span className="pb-eyebrow">THRUSTWORTHY ARCADE / PHYSICAL SENSOR GAME</span>
        <h2>Pulse <em>Beat.</em></h2>
        <p>Follow the falling notes. Tap the matching FSR gently when it crosses the line.</p>
      </div>
      <div className="pb-status">{connected ? '● LIVE ESP32' : '● KEYBOARD DEMO'}</div>
    </div>

    <div className="pb-controls">
      <label>DIFFICULTY
        <select value={difficulty} disabled={status === 'playing'} onChange={(event: ChangeEvent<HTMLSelectElement>) => { const next = event.target.value as Difficulty; setDifficulty(next); update(createGame(next)); setStatus('idle'); setElapsed(0); }}>
          {(['easy', 'normal', 'hard'] as Difficulty[]).map(level => <option key={level} value={level}>{LEVELS[level].label}</option>)}
        </select>
      </label>
      <label>USB LATENCY OFFSET <strong>{latencyMs} ms</strong>
        <input type="range" min="0" max="180" step="5" value={latencyMs} onChange={(event: ChangeEvent<HTMLInputElement>) => setLatencyMs(Number(event.target.value))} />
      </label>
      <label className="pb-audio"><input type="checkbox" checked={audioOn} disabled={status === 'playing'} onChange={(event: ChangeEvent<HTMLInputElement>) => setAudioOn(event.target.checked)} /> Beat audio</label>
      <button type="button" className="pb-start" onClick={start}>{status === 'playing' ? 'Restart song' : finished ? 'Play again' : 'Start game'} ↗</button>
    </div>

    <div className="pb-stats" aria-live="off">
      <div><span>SCORE</span><strong>{display.score.toLocaleString()}</strong></div>
      <div><span>COMBO</span><strong>{display.combo}<small>×</small></strong></div>
      <div><span>ACCURACY</span><strong>{accuracy(display)}<small>%</small></strong></div>
      <div><span>TIME LEFT</span><strong>{status === 'idle' ? '30' : remaining}<small>s</small></strong></div>
    </div>

    <div className="pb-board">
      <div className="pb-board-top"><span>5 SENSOR LANES</span><span>{status === 'playing' ? 'FOLLOW THE BEAT' : 'A S D F G / ON-SCREEN TAPS'}</span></div>
      <div className="pb-track" role="group" aria-label="Five vertical note lanes with a hit line near the bottom">
        {LANES.map((lane, index) => <div key={lane.key} className={`pb-lane ${lastLane === index && performance.now() - lastHitTime < 160 ? 'pb-lane-lit' : ''}`} style={{ '--lane-accent': lane.colour } as CSSProperties}>
          <span className="pb-lane-label">{lane.name}</span>
          {status !== 'idle' && game.notes.filter(note => note.lane === index && !note.judgement && note.timeMs - elapsed <= TRAVEL_MS && note.timeMs - elapsed >= -HIT_WINDOW_MS).map(note => {
            const top = 82 - (note.timeMs - elapsed) / TRAVEL_MS * 72;
            return <span key={note.id} className="pb-note" style={{ top: `${top}%` }} />;
          })}
          <span className="pb-hit-zone" />
          <button type="button" disabled={status !== 'playing'} className="pb-key" onClick={() => pressRef.current(index, performance.now())} aria-label={`Tap ${lane.label} sensor / key ${lane.key.toUpperCase()}`}>
            <kbd>{lane.key.toUpperCase()}</kbd><span>{lane.label}</span>
          </button>
        </div>)}
        <div className="pb-judgement" key={`${game.feedback}-${game.score}-${game.wrong}-${game.miss}`}>{status === 'playing' ? game.feedback : finished ? 'SONG COMPLETE' : 'PRESS START'}</div>
      </div>
      <div className="pb-progress"><span style={{ width: `${percent}%` }} /></div>
      <div className="pb-board-footer"><span>Gently tap the front sensors only · GPIO assignments unchanged</span><span>{display.notes.length} notes</span></div>
    </div>

    {finished && <div className="pb-result"><strong>Session complete</strong><span>{game.perfect} perfect · {game.good} good · {game.okay} okay · {game.wrong} wrong · {game.miss} missed · Best combo {game.bestCombo}</span></div>}
    <p className="pb-note-text">This arcade mode is separate from first-aid training. Front FSRs: A = left, S = high, D = centre, F = low, G = right. Calibrate your resting baseline first. If hits are late, increase the latency offset. Avoid forceful impacts.</p>
  </section>;
}
