// The contract every data source meets: the recorded mock today, the ESP32 over
// Web Serial later. A source only delivers raw frames and its connection
// status; judging happens in judge.ts, never here.

import type { RawFrame, Status } from '../judge';
import type { Reading } from './trainer';

export interface SourceMeta {
  name: string;
  hz: number;
  duration: number;
  frameCount: number;
  units: string;
}

/** A physical link to a trainer. Only the serial source has one. */
export interface LinkInfo {
  /** Short port name for the header, from the USB chip: "CP2102", "CH340". */
  port: string;
  /** connecting: open, no valid frame yet. streaming: frames arriving. silent: none for 1.5 s.
   *  garbled: 20 unreadable lines in a row. unplugged: the port went away. closed: stopped on purpose. */
  state: 'connecting' | 'streaming' | 'silent' | 'garbled' | 'unplugged' | 'closed';
  /** Frames per second actually received, null until measured. */
  hz: number | null;
  /** The last unreadable line, when state is garbled. */
  rawLine: string | null;
}

export interface SourceStatus {
  /** Same values the pages read as snapshot.status. */
  state: Status;
  /** Frames are flowing right now. */
  playing: boolean;
  /** 0 to 1 through a recording; 0 for a live device. */
  progress: number;
  /** Seconds of data the source expects to deliver; 0 when unknown. */
  duration: number;
  error: { code: string; message: string } | null;
  meta: SourceMeta;
  /** Present only for a source with a physical link. */
  link?: LinkInfo;
}

export interface DataSource {
  /** Short name for logs and diagnostics: "mock" or "serial". */
  readonly name: string;
  start(): void;
  stop(): void;
  /** Called once per raw frame, in order. Returns an unsubscribe function. */
  onFrame(cb: (frame: RawFrame) => void): () => void;
  /** Called with the current status right away, then on every change. Returns an unsubscribe function. */
  onStatus(cb: (status: SourceStatus) => void): () => void;
  /** Device readings fed to trainer.ts so far, for a saved session. Absent or null when the source has none (the demo). */
  readings?(): Reading[] | null;
}
