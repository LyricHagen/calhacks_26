# ChokeSense — One-Page Guided Trainer

A lightweight, offline-capable browser demo of a sensor-guided adult choking-response training experience.

## Start

```bash
npm ci
npm run dev
```

Open **http://localhost:5173**. There is only one page. No login, API key, or backend is required.

## Product flow

- **Guided training:** Choose *Severe choking*, *Effective cough*, or *Unresponsive / CPR*. Follow the main instruction, watch the target zone on the mannequin, and trigger a real or simulated sensor contact. Get immediate, specific placement feedback. The progress counter advances only when the designated sensor contact completes.
- **Calibrate:** Leave all sensors untouched, capture the resting ADC baseline, and adjust the contact threshold. Baseline/threshold are used by the same detector as the real device.
- **Sensor test:** Check nine raw 12-bit ADC channels independently; watch bar meters and mark sensor channels tested. Use **Test** buttons in Demo mode.
- **Export results:** Download the training event summary as local JSON. No results are uploaded.

## ESP32-S3

Firmware is in `firmware/chokesense_s3_9fsr/main.cpp`. It emits newline-delimited JSON at 115200 baud:

```json
{"schema":"fsr9-v1","t":1234,"fsr":[120,0,0,0,0,0,0,0,0],"peak":[210,0,0,0,0,0,0,0,0]}
```

The firmware periodically announces logical sensor order with a `hello` frame. The TypeScript parser in `src/trainerLab/sensors.ts` maps incoming names to the correct UI channels.

1. Set `FSR_PINS` according to your board's actual wiring (example: ADC1 GPIO1, GPIO2, GPIO4–10). Connect every FSR through its own voltage divider, with a **3.3 V** ADC input limit.
2. Build using PlatformIO with `firmware/chokesense_s3_9fsr/platformio.ini` or configure an equivalent ESP32-S3 Arduino environment.
3. Open the frontend in **Chrome/Edge over localhost or HTTPS**, click **Connect sensor**, then choose the serial port.
4. In **Calibrate**, release all pads, wait for idle frames, and capture the resting baseline. Use **Sensor test** to check all nine wired channels.
5. Run a scenario in **Guided training**. One recorded event is a contact **followed by release**, not a guarantee of correct force or timing.

Serial port access works in compatible desktop browsers; Chrome's USB port picker is triggered directly by the user click. Do not open the Arduino serial monitor simultaneously.

## Design details

**React + TypeScript** dynamically re-render the screen when `useState` changes. `NineSensorProtocol` parses sensor packets, `NineSensorDetector` identifies contact/release events, and the React trainer state machine compares those events to the current step. The mannequin is SVG and its target highlights, sensor pulses, and posture movement are animated via CSS; no 3D engine or animation library is required.

**No Gemini or SpacetimeDB is currently integrated.** Immediate coaching is deterministic and works with no internet. An LLM could be added later for a non-clinical session recap, not for time-sensitive emergency decisions.

## Important limitations

FSR raw values (0–4095) are **not calibrated newtons** and cannot verify clinical thrust effectiveness or CPR compression depth. An animated airway illustrates the selected scenario, but **never declares the obstruction cleared** from sensor data. The simulated five-and-five round is for guided placement practice, not evidence of clinical competence. Some adult first-aid variations apply (e.g. pregnancy or inability to encircle the abdomen); this demo does not support those scenarios. This is a learning prototype, not a substitute for formal training.

2025 American Heart Association adult BLS reference: https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support

## Folder structure

```
src/
  App.tsx                 one-page app root
  TrainerExperience.tsx   guide, illustrations, modes, live serial, feedback
  trainerLab/sensors.ts   nine-FSR protocol and contact detector
  styles.css             responsive interface and animations
firmware/
  chokesense_s3_9fsr/    current nine-FSR ESP32-S3 firmware
  chokesense/             original five-pad firmware retained for reference
```
