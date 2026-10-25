import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ADC_MAX, EMPTY, formatForce, isSaturated, padNewtons, NineSensorDetector, NineSensorProtocol,
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
import { RhythmGame } from './minigames/RhythmGame';
import { preloadCues, speak, speakAnswer, speechSupported, stopSpeech } from './trainerLab/speech';
import {
  askGemini, listeningSupported, requestMicrophone, VoiceListener,
  type AssistantContext, type ListenerStatus,
} from './trainerLab/assistant';

type Mode = 'train' | 'calibrate' | 'test' | 'play';
type Scenario = 'severe' | 'cough' | 'unresponsive';
type View = 'front' | 'back';
type Tone = 'neutral' | 'success' | 'warning';
type Connection = 'demo' | 'connecting' | 'live' | 'error';
type Feedback = { tone: Tone; heading: string; detail: string; spoken?: string };
type Counts = { back: number; front: number; cpr: number; correct: number; errors: number; rounds: number };
type History = { time: string; label: string; verdict: string; good: boolean; peak: number; placementScore: number | null; riseMs: number | null; contactMs: number | null };

type SerialPort = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
};
type SerialNavigator = Navigator & { serial?: { requestPort: () => Promise<SerialPort> } };

const INITIAL_COUNTS: Counts = { back: 0, front: 0, cpr: 0, correct: 0, errors: 0, rounds: 0 };
// Start-to-start pacing window for back blows or abdominal thrusts. Training pace, not an AHA figure.
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 3000;
const noLastStart = (): Record<ActionType, number> => ({ back: -Infinity, front: -Infinity, cpr: -Infinity });
// Longest 10-90% rise that still counts as a sharp hit rather than a push.
// From mannequin tests with plates: normal thrusts rose in 175-211 ms, slow
// ones in 547-1272 ms. Normal back blows rose in 117-322 ms; the back cutoff
// is provisional until slow back pushes are measured.
const MAX_RISE_MS: Record<'back' | 'front', number> = { back: 500, front: 400 };
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
    <svg viewBox="0 0 40 40"><rect width="40" height="40" rx="10.4" fill="#007E79" />
      <path d="M12.4 20 20 12.4 27.6 20" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="20" cy="27.2" r="2.8" fill="#4CDBB8" /></svg></div>;
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

const SKIN = '#e9c1a5';
const SKIN_LINE = '#c4977f';
// Silhouettes traced from front/back upper-body reference art and scaled per view so the
// chest/abdomen (front) and shoulder blades (back) land under the fixed sensor pads.
// The front is squashed ~18% vertically so it doesn't read as stretched.
// The figure is cropped at the neck and faded at the waist.
const FIGURES: Record<View, { body: string; torso: string; details: string }> = {
  front: {
    body: 'M152.5 64.8C152.5 64.8,150.9 73.1,149.3 76.7C147.8 80.2,146.1 83.3,143.1 86.3C140 89.2,136.7 92,130.9 94.4C125.1 96.9,116.3 99.2,108.4 101.1C100.5 103,90.9 103.9,83.6 105.9C76.4 107.9,69.6 110.4,64.8 112.9C59.9 115.4,57.1 118.1,54.4 121.1C51.7 124,50.2 127.1,48.5 130.7C46.9 134.3,45.3 139.2,44.5 142.5C43.7 145.9,43.4 147,43.6 150.7C43.7 154.4,45.1 160.8,45.4 164.7C45.7 168.6,45.9 170.3,45.4 174C44.9 177.7,43.5 182.3,42.2 186.9C41 191.5,39.3 196.8,38.2 201.7C37.1 206.7,36 210.4,35.5 216.5C35 222.7,35.2 232.6,35 238.7C34.9 244.9,35.3 248.3,34.6 253.5C33.8 258.8,31.8 264.6,30.5 270.2C29.3 275.7,28.1 281,26.9 286.8C25.8 292.7,25 297.9,23.8 305.3C22.6 312.7,21.2 321.4,19.8 331.2C18.3 341.1,16.6 353.7,15.2 364.5C13.9 375.3,11.7 396,11.7 396C11.7 396,63.8 396.7,63.8 396.7C63.8 396.7,65.5 349.5,66.1 334.9C66.7 320.3,67 316.4,67.5 309C67.9 301.6,68.1 296.1,68.8 290.5C69.5 285,70.2 281,71.5 275.7C72.8 270.5,75 264.9,76.9 259.1C78.8 253.2,81 246.4,82.8 240.6C84.5 234.7,86.3 228.7,87.7 223.9C89.1 219.2,90.2 215,91.3 212.1C92.3 209.1,93 206.2,94 206.2C95 206.2,95.8 209.1,97.1 212.1C98.5 215,100.9 219.5,102.1 223.9C103.3 228.4,103.7 233.8,104.3 238.7C105 243.7,106.2 248,106.1 253.5C106.1 259.1,104.8 266.5,103.9 272C103 277.6,101.4 281.3,100.8 286.8C100.1 292.4,100.1 299.8,99.8 305.3C99.5 310.9,98.8 314.6,99 320.1C99.1 325.7,100 331.1,100.8 338.6C101.5 346.1,102.7 355.6,103.5 365.3C104.2 374.9,105.2 396.7,105.2 396.7C105.2 396.7,262.8 396.7,262.8 396.7C262.8 396.7,263.8 374.9,264.6 365.3C265.3 355.6,266.5 346.1,267.2 338.6C268 331.1,268.9 325.7,269.1 320.1C269.2 314.6,268.4 310.9,268.1 305.3C267.8 299.8,267.9 292.4,267.2 286.8C266.6 281.3,265 277.6,264.1 272C263.2 266.5,261.9 259.1,261.9 253.5C261.8 248,263 243.7,263.6 238.7C264.3 233.8,264.7 228.4,265.9 223.9C267.1 219.5,269.5 215,270.9 212.1C272.2 209.1,273 206.2,274 206.2C275 206.2,275.6 209.1,276.7 212.1C277.8 215,278.9 219.2,280.3 223.9C281.7 228.7,283.4 234.7,285.2 240.6C287.1 246.4,289.2 253.2,291.1 259.1C293 264.9,295.1 270.5,296.5 275.7C297.9 281,298.5 285,299.2 290.5C299.9 296.1,300.1 301.6,300.6 309C301 316.4,301.3 320.3,301.9 334.9C302.5 349.5,304.1 396.7,304.1 396.7C304.1 396.7,356.4 396,356.4 396C356.4 396,354.1 375.3,352.8 364.5C351.4 353.7,349.7 341.1,348.2 331.2C346.8 321.4,345.4 312.7,344.2 305.3C343 297.9,342.2 292.7,341.1 286.8C339.9 281,338.7 275.7,337.5 270.2C336.2 264.6,334.1 258.8,333.4 253.5C332.6 248.3,333.1 244.9,333 238.7C332.8 232.6,333 222.7,332.5 216.5C332 210.4,330.9 206.7,329.8 201.7C328.7 196.8,326.9 191.5,325.8 186.9C324.6 182.3,323.1 177.7,322.6 174C322.1 170.3,322.3 168.6,322.6 164.7C322.9 160.8,324.2 154.4,324.4 150.7C324.5 147,324.3 145.9,323.5 142.5C322.7 139.2,321.1 134.3,319.5 130.7C317.8 127.1,316.3 124,313.6 121.1C310.9 118.1,308.1 115.4,303.2 112.9C298.4 110.4,291.6 107.9,284.4 105.9C277.1 103.9,267.5 103,259.6 101.1C251.7 99.2,242.9 96.9,237.1 94.4C231.3 92,228 89.2,224.9 86.3C221.9 83.3,220.2 80.2,218.7 76.7C217.1 73.1,215.5 64.8,215.5 64.8C215.5 64.8,152.5 64.8,152.5 64.8Z',
    torso: 'M152.5 64.8C152.5 64.8,150.9 73.1,149.3 76.7C147.8 80.2,146.1 83.3,143.1 86.3C140 89.2,139.1 92,130.9 94.4C122.7 96.9,94 101.1,94 101.1C94 101.1,94 206.2,94 206.2C94 206.2,95.8 209.1,97.1 212.1C98.5 215,100.9 219.5,102.1 223.9C103.3 228.4,103.7 233.8,104.3 238.7C105 243.7,106.2 248,106.1 253.5C106.1 259.1,104.8 266.5,103.9 272C103 277.6,101.4 281.3,100.8 286.8C100.1 292.4,100.1 299.8,99.8 305.3C99.5 310.9,98.8 314.6,99 320.1C99.1 325.7,100 331.1,100.8 338.6C101.5 346.1,102.7 355.6,103.5 365.3C104.2 374.9,105.2 396.7,105.2 396.7C105.2 396.7,262.8 396.7,262.8 396.7C262.8 396.7,263.8 374.9,264.6 365.3C265.3 355.6,266.5 346.1,267.2 338.6C268 331.1,268.9 325.7,269.1 320.1C269.2 314.6,268.4 310.9,268.1 305.3C267.8 299.8,267.9 292.4,267.2 286.8C266.6 281.3,265 277.6,264.1 272C263.2 266.5,261.9 259.1,261.9 253.5C261.8 248,263 243.7,263.6 238.7C264.3 233.8,264.7 228.4,265.9 223.9C267.1 219.5,269.5 215,270.9 212.1C272.2 209.1,274 206.2,274 206.2C274 206.2,274 101.1,274 101.1C274 101.1,245.3 96.9,237.1 94.4C228.9 92,228 89.2,224.9 86.3C221.9 83.3,220.2 80.2,218.7 76.7C217.1 73.1,215.5 64.8,215.5 64.8C215.5 64.8,152.5 64.8,152.5 64.8Z',
    details: 'M179.1 101.8C179.1 101.8,165.6 101,155.7 101.1C145.8 101.2,119.6 102.6,119.6 102.6M188.9 101.8C188.9 101.8,202.4 101,212.3 101.1C222.2 101.2,248.4 102.6,248.4 102.6M103.9 201.7C103.9 201.7,119.3 211.1,128.7 213.6C138 216,151.5 217,160.2 216.5C168.8 216.1,180.8 211,180.8 211M264.1 201.7C264.1 201.7,248.7 211.1,239.3 213.6C230 216,216.5 217,207.8 216.5C199.2 216.1,187.2 211,187.2 211M184 164.7C184 164.7,184 216.5,184 216.5M184 222.1C184 222.1,184 320.1,184 320.1M146.7 253.5C146.7 253.5,159 256.5,164.7 256.5C170.3 256.5,180.8 253.5,180.8 253.5M221.3 253.5C221.3 253.5,209 256.5,203.3 256.5C197.7 256.5,187.2 253.5,187.2 253.5M152.1 280.2C152.1 280.2,162.1 282.5,166.9 282.4C171.7 282.3,180.8 279.4,180.8 279.4M215.9 280.2C215.9 280.2,205.9 282.5,201.1 282.4C196.3 282.3,187.2 279.4,187.2 279.4M91.8 112.2C91.8 112.2,84.8 130.1,83.6 138.8C82.4 147.6,83 157.2,84.5 164.7C86 172.2,92.6 184,92.6 184M276.2 112.2C276.2 112.2,283.2 130.1,284.4 138.8C285.6 147.6,284.9 157.2,283.4 164.7C281.9 172.2,275.4 184,275.4 184M114.2 202.5C114.2 202.5,117.2 200.6,118.8 200.6C120.2 200.6,123.2 202.5,123.2 202.5M253.8 202.5C253.8 202.5,250.8 200.6,249.2 200.6C247.8 200.6,244.8 202.5,244.8 202.5M124.2 224.7C124.2 224.7,129.7 243.8,132.2 253.5C134.8 263.3,137.2 273.9,139.4 283.1C141.7 292.4,143.1 301.7,145.8 309C148.4 316.3,155.7 326.8,155.7 326.8M243.8 224.7C243.8 224.7,238.3 243.8,235.8 253.5C233.2 263.3,230.8 273.9,228.6 283.1C226.3 292.4,224.9 301.7,222.2 309C219.6 316.3,212.3 326.8,212.3 326.8M144.8 229.1C144.8 229.1,157.8 232.1,163.8 232.1C169.8 232.1,180.8 229.1,180.8 229.1M223.2 229.1C223.2 229.1,210.2 232.1,204.2 232.1C198.2 232.1,187.2 229.1,187.2 229.1M154.8 306.1C154.8 306.1,164.8 308.3,169.2 308.3C173.5 308.3,180.8 306.1,180.8 306.1M213.2 306.1C213.2 306.1,203.2 308.3,198.8 308.3C194.5 308.3,187.2 306.1,187.2 306.1M104.3 229.1C104.3 229.1,114.2 235.8,114.2 235.8M263.6 229.1C263.6 229.1,253.8 235.8,253.8 235.8M105.7 244.6C105.7 244.6,116 250.6,116 250.6M262.3 244.6C262.3 244.6,251.9 250.6,251.9 250.6M184 289.8C184 289.8,182.7 292,182.7 293.1C182.7 294.2,184 296.4,184 296.4',
  },
  back: {
    body: 'M154.2 59.2C154.2 59.2,154.2 73,151 78C147.9 83,144.2 85.6,135.3 89C126.4 92.4,108.5 95.3,97.6 98.4C86.8 101.6,77 103.9,70.2 107.8C63.4 111.8,60.1 116.7,56.8 122C53.6 127.2,52.3 132.4,50.5 139.2C48.8 146.1,47.7 155.6,46.6 162.8C45.6 170,45.6 176.5,44.3 182.4C43 188.3,40.5 192.2,38.8 198.1C37.1 204,35.2 210.6,34.1 217.8C32.9 224.9,33 234.1,31.7 241.3C30.4 248.5,28.6 254.4,26.2 260.9C23.9 267.5,20.2 272.7,17.6 280.6C15 288.4,12.7 298.9,10.5 308C8.3 317.2,6.2 325.7,4.2 335.5C2.3 345.3,0.7 352.2,-1.3 366.9C-3.2 381.6,-7.5 423.4,-7.5 423.4C-7.5 423.4,30.1 425,30.1 425C30.1 425,32.5 401.4,34.8 390.4C37.2 379.5,41.1 368.2,44.3 359.1C47.4 349.9,50.9 343.4,53.7 335.5C56.4 327.6,59.1 319.1,60.8 312C62.5 304.8,62.3 298.9,63.9 292.3C65.5 285.8,67.7 279.2,70.2 272.7C72.7 266.2,76.5 259.6,78.8 253.1C81.2 246.5,82.6 238.9,84.3 233.5C86 228,87.6 220.8,89 220.1C90.5 219.5,91.2 224,92.9 229.5C94.6 235,97 245.2,99.2 253.1C101.4 260.9,104.7 269.4,106.3 276.6C107.9 283.8,109 289.7,108.6 296.2C108.2 302.8,105.2 308.7,103.9 315.9C102.6 323.1,102.1 332.2,100.8 339.4C99.5 346.6,97.4 350.5,96.1 359.1C94.8 367.6,93.7 379.5,92.9 390.4C92.2 401.4,91.4 425,91.4 425C91.4 425,276.6 425,276.6 425C276.6 425,275.8 401.4,275.1 390.4C274.3 379.5,273.2 367.6,271.9 359.1C270.6 350.5,268.5 346.6,267.2 339.4C265.9 332.2,265.4 323.1,264.1 315.9C262.8 308.7,259.8 302.8,259.4 296.2C259 289.7,260.1 283.8,261.7 276.6C263.3 269.4,266.6 260.9,268.8 253.1C271 245.2,273.4 235,275.1 229.5C276.8 224,277.5 219.5,279 220.1C280.4 220.8,282 228,283.7 233.5C285.4 238.9,286.8 246.5,289.2 253.1C291.5 259.6,295.3 266.2,297.8 272.7C300.3 279.2,302.5 285.8,304.1 292.3C305.7 298.9,305.5 304.8,307.2 312C308.9 319.1,311.6 327.6,314.3 335.5C317.1 343.4,320.6 349.9,323.7 359.1C326.9 368.2,330.8 379.5,333.1 390.4C335.5 401.4,337.9 425,337.9 425C337.9 425,375.5 423.4,375.5 423.4C375.5 423.4,371.2 381.6,369.3 366.9C367.3 352.2,365.7 345.3,363.8 335.5C361.8 325.7,359.7 317.2,357.5 308C355.3 298.9,353 288.4,350.4 280.6C347.8 272.7,344.1 267.5,341.8 260.9C339.4 254.4,337.6 248.5,336.3 241.3C335 234.1,335.1 224.9,333.9 217.8C332.8 210.6,330.9 204,329.2 198.1C327.5 192.2,325 188.3,323.7 182.4C322.4 176.5,322.4 170,321.4 162.8C320.3 155.6,319.2 146.1,317.5 139.2C315.7 132.4,314.4 127.2,311.2 122C307.9 116.7,304.6 111.8,297.8 107.8C291 103.9,281.2 101.6,270.4 98.4C259.5 95.3,241.6 92.4,232.7 89C223.8 85.6,220.1 83,217 78C213.8 73,213.8 59.2,213.8 59.2C213.8 59.2,154.2 59.2,154.2 59.2Z',
    torso: 'M154.2 59.2C154.2 59.2,154.2 73,151 78C147.9 83,144.2 85.6,135.3 89C126.4 92.4,105.4 95.3,97.6 98.4C89.9 101.6,89 107.8,89 107.8C89 107.8,89 220.1,89 220.1C89 220.1,91.2 224,92.9 229.5C94.6 235,97 245.2,99.2 253.1C101.4 260.9,104.7 269.4,106.3 276.6C107.9 283.8,109 289.7,108.6 296.2C108.2 302.8,105.2 308.7,103.9 315.9C102.6 323.1,102.1 332.2,100.8 339.4C99.5 346.6,97.4 350.5,96.1 359.1C94.8 367.6,93.7 379.5,92.9 390.4C92.2 401.4,91.4 425,91.4 425C91.4 425,276.6 425,276.6 425C276.6 425,275.8 401.4,275.1 390.4C274.3 379.5,273.2 367.6,271.9 359.1C270.6 350.5,268.5 346.6,267.2 339.4C265.9 332.2,265.4 323.1,264.1 315.9C262.8 308.7,259.8 302.8,259.4 296.2C259 289.7,260.1 283.8,261.7 276.6C263.3 269.4,266.6 260.9,268.8 253.1C271 245.2,273.4 235,275.1 229.5C276.8 224,279 220.1,279 220.1C279 220.1,279 107.8,279 107.8C279 107.8,278.1 101.6,270.4 98.4C262.6 95.3,241.6 92.4,232.7 89C223.8 85.6,220.1 83,217 78C213.8 73,213.8 59.2,213.8 59.2C213.8 59.2,154.2 59.2,154.2 59.2Z',
    details: 'M184 82.7C184 82.7,184 374.8,184 374.8M155.7 123.5C155.7 123.5,152.6 160.4,149.5 178.5C146.3 196.6,143.6 225.3,136.9 231.9C130.2 238.4,109.4 217.8,109.4 217.8M212.3 123.5C212.3 123.5,215.4 160.4,218.5 178.5C221.7 196.6,224.4 225.3,231.1 231.9C237.8 238.4,258.6 217.8,258.6 217.8M85.9 151C85.9 151,92.4 133.4,97.6 127.5C102.9 121.6,117.3 115.7,117.3 115.7M282.1 151C282.1 151,275.6 133.4,270.4 127.5C265.1 121.6,250.7 115.7,250.7 115.7',
  },
};

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
  const figure = FIGURES[view];
  const focusY = view === 'back' ? 190 : cpr ? 182 : 292;
  const activePosition = coords.find(item => item.id === active);
  const targetPosition = coords.find(item => item.id === target);
  return <div className="body-stage">
    <svg className={`body-illustration lvl-${severity} ${active !== null ? 'impact' : ''}`} viewBox="-32 0 432 428" role="img" aria-label={`Interactive ${view} view of training mannequin with force sensor locations`}>
      <defs>
        <filter id="bodyShadow"><feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#70472f" floodOpacity=".12" /></filter>
        <clipPath id="heatmapBodyClip"><path d={figure.torso} /></clipPath>
        <linearGradient id="figureFade" gradientUnits="userSpaceOnUse" x1="0" y1="352" x2="0" y2="390">
          <stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#000" />
        </linearGradient>
        <mask id="figureMask" maskUnits="userSpaceOnUse" x="-32" y="-80" width="432" height="560"><rect x="-32" y="-80" width="432" height="560" fill="url(#figureFade)" /></mask>
      </defs>
      <g className="figure-2d">
      <g mask="url(#figureMask)"><g filter="url(#bodyShadow)" fill={SKIN} stroke={SKIN_LINE} strokeWidth="1.4" strokeLinejoin="round">
        <path d={figure.body} />
        <path d={figure.details} fill="none" opacity=".4" />
      </g></g>

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

function SensorMeter({ id, value, baseline, threshold }: { id: SensorId; value: number; baseline: number; threshold: number }) {
  const corrected = Math.max(0, value - baseline);
  return <div className="meter" title={`${value} raw ADC (≈${formatForce(padNewtons(id, value, baseline), isSaturated(value))}), ${corrected} above baseline`}>
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
  const gameInputRef = useRef<(values: NineReadings, atMs: number) => void>(() => {});
  const simBusyRef = useRef(false);
  const simTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStart = useRef(noLastStart());
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
      const start = event.time - event.durationMs;
      const sinceLast = start - lastStart.current[event.type];
      lastStart.current[event.type] = start;
      const tooFast = event.type === expected && sinceLast < MIN_INTERVAL_MS;
      // The first hit of a set has no previous start (sinceLast is Infinity), so it is never slow.
      const tooSlow = event.type === expected && Number.isFinite(sinceLast) && sinceLast > MAX_INTERVAL_MS;
      const pushed = expected !== 'review' && event.type === expected &&
        event.riseMs !== null && event.riseMs > MAX_RISE_MS[expected];

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
      } else if (tooFast) {
        result = {
          tone: 'warning',
          heading: 'Too fast — not counted',
          detail: `That ${expected === 'back' ? 'back blow' : 'thrust'} came ${(sinceLast / 1000).toFixed(1)} s after the last one. Make each one separate and deliberate: pause, reset your position, then go again.`,
          spoken: 'Too fast. Pause between each one.',
        };
      } else if (pushed) {
        result = {
          tone: 'warning',
          heading: 'Too slow a push — not counted',
          detail: `That ${expected === 'back' ? 'back blow' : 'thrust'} took ${event.riseMs} ms to build up. ` +
            (expected === 'back'
              ? 'Strike quickly and sharply with the heel of your hand rather than pushing.'
              : 'Make each thrust a quick, sharp pull inward and upward rather than a slow squeeze.'),
          spoken: expected === 'back' ? 'Too slow. Make it a quick, sharp blow.' : 'Too slow. Make it a quick thrust.',
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

        if (tooSlow) {
          result = {
            tone: 'warning',
            heading: 'Counted — but keep the pace up',
            detail: `Good placement, but ${(sinceLast / 1000).toFixed(1)} s passed since the last one. In a real emergency, keep going without long pauses. ${result.detail}`,
            // The set-complete cues carry the next instructions, so keep those.
            spoken: current < 5 ? 'Counted. Keep the pace up.' : result.spoken,
          };
        }
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
      riseMs: event.riseMs,
      contactMs: event.contactMs,
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
    if (modeRef.current === 'play') gameInputRef.current(vals, performance.now());
    if (modeRef.current === 'train') {
      const events = detector.current.process(vals, baselineRef.current, performance.now(), thresholdRef.current, frame.peaks, frame.deviceTimeMs);
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
    lastStart.current = noLastStart();
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
    // A new round starts fresh: the gap since last round's final thrust isn't a slow blow.
    lastStart.current = noLastStart();
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
            INTERACTIVE TRAINING STATION</div>
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
          <button type="button" role="tab" aria-selected={mode === 'play'} className={mode === 'play' ? 'selected' : ''} onClick={() => { detector.current.reset(); stopSpeech(); setRecentPattern(null); setMode('play'); }}>♫ Pulse Beat</button>
        </div>
        <span className="mode-status">{connection === 'live' ? 'LIVE INPUT' : 'SIMULATION MODE'}</span>
      </div>

      {connection === 'error' && <div className="connection-error" role="alert">{connectionDetail}</div>}

      {mode === 'play' && <RhythmGame inputRef={gameInputRef} baseline={baseline} threshold={threshold} connected={connection === 'live'} />}

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
              {promptTag}</span>
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
              Smoothed contact estimate from nearby FSR readings; areas between sensors are inferred, not measured. Back left/right are from the back-facing view.</div>
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
                <span className={active !== null ? 'lit' : ''} />{active === null ? 'Waiting for pressure' : `${Math.max(0, readings[active] - baseline[active])} above baseline`}</div>
              {history[0]?.riseMs != null && <div className="sharpness-readout">
                Last hit: rise {history[0].riseMs} ms · contact {history[0].contactMs} ms</div>}</div>
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
          <h3>Live sensor values <span>0–4095 ADC · ≈ applied force</span></h3>
          <div className="raw-grid">{SENSOR_NAMES.map((name, i) => <div key={name} className="raw-item">
            <div>
              <span>{name}</span><b>{readings[i]} <small>≈{formatForce(padNewtons(i as SensorId, readings[i], baseline[i]), isSaturated(readings[i]))}</small></b></div><SensorMeter id={i as SensorId} value={readings[i]} baseline={baseline[i]} threshold={threshold} /></div>)}</div></section>}
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
                  <span>{readings[id]} live (≈{formatForce(padNewtons(id, readings[id], baseline[id]), isSaturated(readings[id]))}) · {peaks[id]} peak (≈{formatForce(padNewtons(id, peaks[id], baseline[id]), isSaturated(peaks[id]))})</span></div><SensorMeter id={id} value={readings[id]} baseline={baseline[id]} threshold={threshold} /></div>
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
