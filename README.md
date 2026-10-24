# ChokeSense — guided mannequin trainer

A single-page React + TypeScript training prototype for adult choking-response practice, with five abdominal FSRs, three back FSRs, and one sternum FSR. No server or API key is required for the simulated demo.

## Run the app

```bash
npm ci
npm run dev
```

Open http://localhost:5173 in Chrome or Edge. Use **Guided training** for the interactive practice flow, **Calibrate** to capture resting readings, and **Sensor test** to check individual channels.

## Final physical sensor and GPIO mapping

| Serial index | Name | ESP32-S3 GPIO |
|---|---|---|
| 0 | Front abdomen target | 4 |
| 1 | Front high | 5 |
| 2 | Front low | 7 |
| 3 | Front left | 15 |
| 4 | Front right | 16 |
| 5 | Centre back (target) | 9 |
| 6 | Back left (off-target) | 3 |
| 7 | Back right (off-target) | 8 |
| 8 | Sternum (CPR) | 18 |

**Back left/right are defined from the point of view of a person facing the mannequin's back.** The back-view diagram places sensor 6 to the left and sensor 7 to the right of the central target.

## Hardware and protocol

Current firmware: `firmware/chokesense_s3_9fsr/main.cpp`.

It streams newline-delimited JSON at 115200 baud in the format:

```json
{"schema":"fsr9-v1","t":12000,"fsr":[0,0,0,0,0,1500,0,0,0],"peak":[0,0,0,0,0,2300,0,0,0]}
```

Every connection also receives periodic `hello` messages declaring logical sensor names. The frontend matches physical channels to logical names from those messages. On every sensor, use a 3.3 V-safe voltage-divider circuit, and verify that pressure makes the expected ADC value increase.

To compile with PlatformIO, from this project root:

```bash
cd firmware/chokesense_s3_9fsr
platformio run -e esp32-s3
platformio run -e esp32-s3 --target upload
```

Your ESP32-S3 board must expose the chosen GPIOs. GPIO3 is a boot strapping pin, so ensure the voltage divider does not interfere with reset or boot. GPIO15, GPIO16 and GPIO18 are ADC2 pins, which may conflict with Wi-Fi operation on ESP32-S3. The project uses USB Serial and does not require Wi-Fi. The firmware has not been flashed or tested on your particular board.

## Guided demo

1. Select **Severe choking**.
2. Follow the highlighted back target. Use **Simulate correct contact** five times.
3. The trainer advances to the abdominal target for five contacts.
4. Try off-target sensors to see directional corrections. Off-target actions do not advance progress.
5. Select **Effective cough** to see the observe-and-encourage scenario; select **Unresponsive / CPR** for the lower-priority sternum placement exercise.
6. Use **Calibrate** and **Sensor test** for hardware setup.

The animation and feedback classify approximate sensor contact, sequence and location only. They cannot determine adequate physical force, effective obstruction clearance, or CPR depth. This is an educational prototype, not medical certification or a substitute for professional training.

## Source map

- `src/TrainerExperience.tsx`: single-page React experience, coaching and animated SVG diagram
- `src/trainerLab/sensors.ts`: named-channel parser and contact/release detector
- `src/styles.css`: layout and animation styles
- `firmware/chokesense_s3_9fsr/main.cpp`: nine-FSR ESP32-S3 firmware

Guidance reference: [2025 AHA Adult Basic Life Support](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support).
