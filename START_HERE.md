# Start ChokeSense

1. Open this folder in VS Code.
2. Run `npm ci` followed by `npm run dev`.
3. Open http://localhost:5173.
4. On the Guided training screen, select Severe choking and simulate the highlighted back-blow target.
5. After five correct back contacts, the prompt advances to the abdominal target.
6. Use off-target sensors to verify the correction messages. Calibration and Sensor test are on the same page.

No hardware or backend is needed for the demo. Connect a flashed ESP32-S3 using Chrome/Edge and the Connect sensor button when ready.

Mapping: GPIO4 abdomen target; GPIO5 high; GPIO7 low; GPIO15 front left; GPIO16 front right; GPIO9 back centre; GPIO3 back left; GPIO8 back right; GPIO18 sternum. Back left means left when looking directly at the mannequin's back.

For firmware build instructions and hardware constraints see `README.md`.
