# Thrustworthy

A first-aid training station for adult choking response. A mannequin fitted with nine force-sensitive resistors (FSRs) streams readings over USB to a single-page React app. The app coaches the trainee through back blows, abdominal thrusts and CPR in real time. It gives placement, timing and sequence feedback, an estimated force in newtons, spoken cues, and a Gemini voice coach you can ask questions out loud.

No hardware is needed to try it: every sensor can be simulated from the UI.

## Quick start

Requires Node 22+.

```bash
npm ci
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge**. Web Serial and speech recognition only work in Chromium browsers.

To turn on the Gemini voice and Q&A, copy `.env.example` to `.env.local` and set `GEMINI_API_KEY`:

```bash
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts   # optional
GEMINI_CHAT_MODEL=gemini-3.1-flash-lite         # optional
```

The key is read only by the Vite dev/preview server, which proxies `/api/tts` and `/api/ask` to Gemini, so it never ends up in the bundle. Without a key the app still works and falls back to the browser's built-in speech synthesis.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 5173 |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run preview` | Serve the build (Gemini proxy included) |

## Features

**Practice** has three scenarios:

- **Severe choking**: 5 back blows on the centre-back target, then 5 abdominal thrusts, then a check-in before the next round. Contacts that are off target, out of order, too close together (under 1 s), too far apart (over 3 s) or too slow to build up are flagged and don't count.
- **Effective cough**: keep your hands off while the cough is still working. After 15 s with no contact the cough fails, and you're graded on holding back, how fast you start back blows, and whether you chose the right first action.
- **Unresponsive / CPR**: compressions on the sternum sensor, graded per 30-compression cycle on rate (100–120/min), full recoil, staying on target and not stopping.

The rest of the app:

- **Body diagram**: animated front and back views with a live placement heatmap and an airway illustration that reacts to each contact. Click any sensor on the diagram to simulate a hit.
- **Rhythm skill check**: a rhythm game where each note is a short back-blow or thrust contact, scored on timing and placement.
- **Voice coaching**: spoken step instructions and corrections. Say "Gemini, …" or press **Ask Gemini** to ask a question; the answer takes into account where you are in the training.
- **Calibrate**: capture a resting baseline, adjust contact sensitivity, and record spatial reference points for the placement model.
- **Sensor test**: live and peak readings for all nine channels in raw ADC and approximate newtons, plus a test button for each one.
- **Export results**: download the session as JSON (events, scores, calibration).

## Hardware

An ESP32-S3 (`esp32-s3-devkitc-1`) reads nine FSR 402 sensors. Each one is wired as a voltage divider: 3.3 V → FSR → ADC pin → 2.2 kΩ → GND.

| Index | Key | Location | GPIO |
|---|---|---|---|
| 0 | `front_target` | Abdomen target | 4 |
| 1 | `front_high` | Front, too high | 5 |
| 2 | `front_low` | Front, too low | 7 |
| 3 | `front_left` | Front left | 15 |
| 4 | `front_right` | Front right | 16 |
| 5 | `back_target` | Centre back, between shoulder blades | 9 |
| 6 | `back_left` | Back left (off target) | 3 |
| 7 | `back_right` | Back right (off target) | 8 |
| 8 | `cpr_sternum` | Sternum (CPR) | 18 |

Back left and right are from the point of view of someone facing the mannequin's back.

Things to watch for:

- GPIO3 is a strapping pin, so make sure its divider doesn't interfere with boot.
- GPIO15, 16 and 18 are ADC2 pins, which conflict with Wi-Fi. The firmware only uses USB serial, so this is fine as long as Wi-Fi stays off.
- Newton estimates use a power-law fit to the FSR 402 datasheet with the 2.2 kΩ divider. To correct them, measure each plate and set `PAD_SCALE` in `src/trainerLab/sensors.ts`.

### Firmware

`firmware/chokesense_s3_9fsr/main.cpp` samples every 5 ms. It sends a frame every 20 ms (50 Hz) and a `hello` message every 5 s. Messages are newline-delimited JSON at 115200 baud:

```json
{"hello":"chokesense-9fsr","hz":50,"pads":["front_target","front_high", ...]}
{"schema":"fsr9-v1","t":12000,"fsr":[0,0,0,0,0,1500,0,0,0],"peak":[0,0,0,0,0,2300,0,0,0]}
```

`peak` is the highest reading since the previous frame. The app uses the `hello` pad names to match channels to sensors, so the pin order can change as long as the names stay correct.

To build and flash with PlatformIO:

```bash
cd firmware/chokesense_s3_9fsr
pio run -e esp32-s3 -t upload
```

In the app, click **Connect sensor** and pick the board. Once it has been paired, it reconnects automatically when you plug it back in.

## Source map

| Path | Contents |
|---|---|
| `src/TrainerExperience.tsx` | Main page: scenarios, coaching logic, body diagram, calibration and test tools, Web Serial |
| `src/trainerLab/sensors.ts` | Serial protocol parser, contact/release detector, ADC → newton conversion |
| `src/trainerLab/spatialModel.ts` | Placement estimate and heatmap from the sensor readings |
| `src/trainerLab/grading.ts` | Cough and CPR scoring (pure functions) |
| `src/trainerLab/instructions.ts` | Step text and spoken cues for each phase |
| `src/trainerLab/speech.ts` | Gemini TTS with browser cache, Web Speech fallback |
| `src/trainerLab/assistant.ts` | "Gemini, …" wake word, speech recognition, Q&A |
| `src/minigames/` | Rhythm skill check game and its scoring engine |
| `vite.config.ts` | Dev/preview proxy that adds the Gemini key |
| `firmware/chokesense_s3_9fsr/` | ESP32-S3 firmware (PlatformIO) |

## Limitations

Thrustworthy measures where you made contact, when, and in what order, along with a rough per-pad force. It cannot tell whether a thrust would clear an airway, and it doesn't measure CPR compression depth. Cough and CPR scoring is still in beta and the thresholds are being tuned. It is an educational prototype, not a certification and not a replacement for hands-on training with an instructor.

Guidance follows the [AHA Adult Basic Life Support guidelines](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support).
