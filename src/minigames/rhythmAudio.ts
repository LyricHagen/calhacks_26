import type { Verdict } from './assessmentEngine';

/**
 * Sound for the rhythm game. Beats are scheduled on the audio clock up front,
 * so the metronome stays exact even when animation frames stall. Every sound
 * fades in and out (no clicks) and runs through a limiter so overlaps don't clip.
 */

// Pentatonic steps for successive hits, so a combo climbs pleasantly.
const COMBO_STEPS = [0, 2, 4, 7, 9, 12, 14, 16];
const semitones = (base: number, steps: number) => base * 2 ** (steps / 12);

export class RhythmAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  // Scheduled beats go through their own bus so a stop can silence them at once.
  private beats: GainNode | null = null;

  /** Must be called from a user gesture. Resolves once sound can play. */
  async begin(): Promise<boolean> {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.ratio.value = 12;
        this.master = this.ctx.createGain();
        this.master.gain.value = .8;
        this.master.connect(limiter).connect(this.ctx.destination);
      }
      await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false; // Visuals and sensor scoring work without Web Audio.
    }
  }

  /** Schedule metronome ticks at game times (ms) for a run that began at performance time `startedAt`. */
  scheduleBeats(beats: { atMs: number; accent: boolean }[], startedAt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.cancelBeats();
    this.beats = ctx.createGain();
    this.beats.connect(this.master);
    // Map game time onto the audio clock, and play early by the output latency
    // so each tick is heard as its bar reaches the line.
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const origin = ctx.currentTime - (performance.now() - startedAt) / 1000 - latency;
    for (const beat of beats) {
      const at = origin + beat.atMs / 1000;
      if (at > ctx.currentTime) this.tick(at, beat.accent, this.beats);
    }
  }

  cancelBeats(): void {
    this.beats?.disconnect();
    this.beats = null;
  }

  /** A bright two-note chime that climbs with the combo. */
  hit(verdict: Verdict, combo: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const root = semitones(587.33, COMBO_STEPS[Math.min(combo, COMBO_STEPS.length) - 1] ?? 0);
    const level = verdict === 'perfect' ? .22 : verdict === 'good' ? .17 : .12;
    this.voice('sine', root, t, .004, .32, level);
    this.voice('sine', root * 1.5, t + .035, .004, .28, level * .7);
    if (verdict === 'perfect') this.voice('triangle', root * 2, t + .07, .004, .2, level * .35);
  }

  /** A soft, low thud: clearly "no", without being harsh. */
  miss(quiet = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + .16);
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    this.envelope(gain, t, .006, .2, quiet ? .1 : .18);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + .25);
  }

  close(): void {
    this.cancelBeats();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  // Short woodblock-style click: a high ping plus a lower body.
  private tick(at: number, accent: boolean, out: AudioNode): void {
    const level = accent ? .16 : .1;
    this.voice('sine', accent ? 1760 : 1320, at, .001, .05, level, out);
    this.voice('triangle', accent ? 880 : 660, at, .001, .035, level * .5, out);
  }

  private voice(type: OscillatorType, frequency: number, at: number, attack: number, decay: number, level: number, out: AudioNode = this.master!): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    this.envelope(gain, at, attack, decay, level);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + attack + decay + .02);
  }

  private envelope(gain: GainNode, at: number, attack: number, decay: number, level: number): void {
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.linearRampToValueAtTime(level, at + attack);
    gain.gain.exponentialRampToValueAtTime(.0001, at + attack + decay);
  }
}
