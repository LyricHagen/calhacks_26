# Start here — ChokeSense one-page demo

## 1. Run it in a browser

In VS Code, open the extracted folder containing `package.json`. From its terminal:

```bash
npm ci
npm run dev
```

Open http://localhost:5173/ in Chrome. **No ESP32, PlatformIO or backend is required for Demo mode.**

If you have a previously running Vite server, stop it with Ctrl+C before launching this one.

## 2. Give the judges a 60-second demonstration

1. Select **Severe choking** (it is the default).
2. The highlighted point is **between the shoulder blades**. Click **Simulate correct contact**; see the live location feedback, counter, pulse and short movement. Repeat five times to reveal the next instruction.
3. On the next step, the mannequin highlights the **upper-abdominal target**. Click **Try incorrect contact** and show the correction; then click **Simulate correct contact**.
4. Click **Calibrate** to show resting baseline capture and sensitivity adjustment.
5. Click **Sensor test** and show nine separate channels. Each *Test* button produces a synthetic ADC contact.
6. Return to Guided training and show **Export results** (local JSON).

## 3. Connect ESP32-S3 later

The current firmware is `firmware/chokesense_s3_9fsr/main.cpp`. Map the nine `FSR_PINS` according to physical wiring, compile/upload with Arduino framework for ESP32-S3 and connect through a supported desktop browser's Web Serial button. Calibration needs all sensors untouched. The sensor JSON schema remains `fsr9-v1`.

Do not have the Arduino Serial Monitor open at the same time as the browser connection. See `README.md` for the complete details.

## 4. What changed

Removed all legacy pages, debug overlay, 3D assets and old navigation from the app. One React/TypeScript screen contains *Guided training*, *Calibrate*, and *Sensor test* modes. Kept the original five-pad firmware for reference only.

The user interface re-renders whenever React state is updated by simulated clicks or by incoming ESP32 sensor frames. SVG and CSS animate the mannequin and airway illustration.

## 5. Safety / accuracy

This is a proof-of-concept teaching tool, not a medical device. FSR pressure is raw ADC data, not calibrated physical force. Training targets and the AHA-based five-and-five sequence are instructional; measured contact is not proof of good clinical technique or obstruction clearance.
