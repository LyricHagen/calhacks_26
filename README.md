# the_frontend

The web app for the unnamed Heimlich trainer. It is a simplified version of `v5-fieldkit` from `unnamed-frontends`. It shows a trainee, live, how each back blow and abdominal thrust compares with an instructor's reference.

It reads a real trainer (an ESP32) over a USB cable with Web Serial. Without one it plays recorded sample data as a demo, or replays a session saved earlier. See [Connecting a trainer](#connecting-a-trainer), [Demo, save and replay](#demo-save-and-replay) and [Where the data comes from](#where-the-data-comes-from).

## Running it

```
cd the_frontend
npm install      # first time only
npm run dev      # or npm start
```

Open http://localhost:5173 in Chrome or Edge. Code changes show up in the browser right away. Stop the server with Ctrl+C.

`npm run build` type-checks the code and writes a production build to `dist/`. `npm run preview` serves that build at http://localhost:4173.

## Deploy

A static single-page app. On Vercel, import the repository with the root directory set to `the_frontend` (or wherever this folder sits). `vercel.json` sets the rest:

| Setting | Value |
|---|---|
| Framework | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node | 22 or later (`engines` in `package.json`) |

`vercel.json` also rewrites every path to `/index.html`. The app has real per-page URLs (`/calibrate`, `/session/summary`, ...) but only one HTML file, so without the rewrite a refresh or a direct link to any page but `/` would get a 404. Real files such as `/assets/*.js` and `/torso.glb` are served first; the rewrite only catches paths with no file behind them.

From the command line: `vercel login` once, then `vercel` for a preview URL or `vercel --prod` for production.

**What ends up in `dist/`.** `shared/session.json` and the rest of `shared/` are imported by the code, so they are bundled into the JavaScript. Everything in `public/` is copied as is, so `public/torso.glb` is served at `/torso.glb`. **There is no `public/torso.glb` in the repository yet.** Until one is added, the 3D view builds its torso from primitives, and the `/diag` self-test reports the glb as failing (the server answers `/torso.glb` with the app page).

**Web Serial needs a secure context.** The Vercel URLs are HTTPS, so Connect works there in Chrome or Edge on a desktop. Locally, `http://localhost` and `http://127.0.0.1` count as secure, so `npm run dev` and `npm run preview` work too. A LAN address over plain http (`http://192.168.1.20:5173`, for testing from another laptop) does not: `navigator.serial` is missing and the home page offers the demo instead. Use the deployed URL there, or start Chrome with `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.20:5173`. Safari and Firefox have no Web Serial at all.

## The flow: Connect, Calibrate, Session

Every page is a real URL with the same header: the wordmark, the connection indicator, the page links and a light/dark switch. The indicator shows the port name and measured rate with a **Reconnect** button when a trainer is connected, and "Demo" or "Replay" otherwise. Every page also has a footer with the line "Training aid, not a medical device."

### 1. `/` Connect
A headline, one sentence, then:
- **With Web Serial:** a large **Connect trainer** button, then **Run demo instead** and **Load session** links. When the port opens, the page goes straight to `/calibrate`.
- **Without Web Serial** (Safari, Firefox, a phone, or plain http): **Run demo** is the large button, with **Load session** beside it and one sentence naming Chrome or Edge on a desktop. There is never a dead Connect button.
- Without WebGL, one more sentence says the torso is drawn flat.
- If a session ended earlier in this tab, a line links to its summary.

### 2. `/calibrate` Calibration
One screen that moves forward without any clicks. The torso is on the left. On the right is the current step and four boxes: Rest, then 1, 2 and 3 for the instructor's thrusts.
1. **Rest the fist.** The step ends once the fist holds still. The trainer detects this, not the page.
2. **Instructor thrusts.** Each box fills with that thrust's peak as it lands.
3. After the third thrust, **Session in 2** counts down, then opens `/session`. **Cancel** stops the countdown and shows **Start session** instead. The countdown only starts while live data is flowing; review states show **Start session**.

### 3. `/session` Live session
- **Torso:** the 3D model, at least half the viewport tall (flat drawing without WebGL). Solid color is contact now, an outline is a recorded fault, a pulse marks a thrust landing. The camera faces the back during back blows.
- **Three large readouts:** the phase, the count in the current set (`3/5`), and the latest judgement as one phrase from `LABELS` (accent color for a fault).
- **5 and 5 sequence:** boxes only, one row per cycle.
- **Fist force:** the last 12 s, with a solid line at the reference (1.00) and a dashed one at the release line.
- **Details** (collapsed): the latest entry with strength, release, abruptness and angle (ungraded), and the full entries table.

When the run is complete, a **Summary** button appears. If the trainer is unplugged mid-session, a **Summary so far** button appears next to the error banner.

### `/session/summary` Summary
- **Save session** downloads the whole run as one JSON file (see below).
- Big counts: thrusts, back blows, cycles and faults.
- **Hits per pad:** the same 3D mannequin, each zone shaded darker for more hits, with its count written large on the zone. A Front / Back switch picks the side it rests on. Fault outlines stay.
- **Against the reference:** how many thrusts were similar, weaker or much stronger, how many were not released, back blows off target, the reference spread, and the angle range (ungraded).
- **5 and 5 sequence:** held or broken.
- **Faults:** every fault, each linking down to its row in the entries table.
- **All entries:** the full table, oldest first.

If opened while a session is still running, a banner says the figures are still growing. If nothing has started since the last session ended (the page switched source, or the tab was reloaded), it shows that last session with a banner saying when it ended.

### Other pages
- `/method`: the rules the trainer uses, with the real threshold numbers pulled from the judge.
- `/privacy`: what is measured, that data stays on this computer, nothing is uploaded, and how long a session is kept.
- `/diag`: the self-test. It is not in the header; open it from the debug panel. See [Debug log and self-test](#debug-log-and-self-test).

## URL options

These query parameters are carried along on every internal link, except `?speed=`.

| Parameter | Values | Effect |
|---|---|---|
| `?state=` | `live` (default), `demo`, `loading`, `empty`, `summary`, `error` | `demo` plays the recording even with a trainer connected or a session loaded: the one-key fallback. The others are design-review states: `loading` shows grey placeholder blocks, `empty` the "no trainer data" message, `summary` a finished session, `error` data frozen partway with an error banner. |
| `?theme=` | `light`, `dark` | Forces a color theme. Without it, the page follows the computer's setting. The header switch flips it. |
| `?debug=1` | | Opens the debug log. |
| `?speed=` | `1` to `20` | On the Connect page: how fast **Load session** replays, in multiples of real time. |

Example: http://localhost:5173/session/summary?state=summary&theme=dark

## Demo, save and replay

Three ways to show the app without a working trainer, all going through the same judge and the same pages as a real device:

- **Run demo** (or `?state=demo` on any address) plays `shared/session.json`: 95 s of rest, calibration and four cycles, with four faults (a high thrust, an unreleased thrust, an off-target back blow and a weak thrust).
- **Save session** on the summary downloads `chokesense-session-<time>.json`. It holds every frame the judge read, the device readings behind them for a USB session (before `trainer.ts`), the judged entries, the summary and the debug log at that moment. It also works on a session cut off by an unplug.
- **Load session** on the Connect page plays such a file back at 10 frames a second, from `/calibrate` onward, exactly as if the trainer were sending it. A USB session's readings run through `trainer.ts` again, so the replay exercises the same code as the live link. Add `?speed=8` to the Connect address to replay faster.

This is the backup if the hardware dies on stage: keep a saved good run on the laptop and load it. It is also how to report a bad run: save it and send the file.

The same replay runs without a browser:

```
npm run replay -- chokesense-session-2026-10-20T19-02-11.json            # whole judge log, then a summary
npm run replay -- chokesense-session-2026-10-20T19-02-11.json --quiet    # warnings and errors only, then the summary
npm run replay -- chokesense-session-2026-10-20T19-02-11.json --grep judge
npm run replay                                                           # the demo recording
```

The summary block ends with `events match the saved file: yes` when the judge today reads the run exactly as it did when the file was saved.

**Kept in this tab.** A session that ends, or is cut off by an unplug, is also kept in memory and in this tab's `sessionStorage`. Going to another page, connecting again, starting the demo or reloading does not lose its summary. Closing the tab does.

## Serial protocol

The full wire format, both directions, is in `src/sources/protocol.md`. In short:

- **Link:** 115200 baud, 8N1, no flow control. UTF-8, one JSON object per line, `\n` endings.
- **Hello**, sent on boot and on request: `{"hello":"chokesense","fw":"0.3.0","hz":10,"pads":["target","high","low","side","back"]}`. Pads are matched by name.
- **Frame**, 10 a second: `{"t":12345,"fist":0.73,"pads":[0.02,0.81,0.00,0.01,0.00],"acc":[0.11,-0.20,9.74]}`. `t` is device milliseconds; `fist` and `pads` are raw ADC fractions 0 to 1; `acc` is the wrist accelerometer in m/s², or `null` if the IMU does not answer.
- **Commands** from the browser: `hello`, `ping` (answered `{"pong":t}`, sent every 5 s), `zero` (restarts `t`), and `selftest` (a 10 s wiring check for a serial monitor).

The device sends raw readings only. `src/sources/trainer.ts` does the rest on the computer: the rest baseline, the reference scale, the phases, back blow detection from the accelerometer, the angle, and time that stays continuous across a board reset or a reconnect.

## Connecting a trainer

1. Flash `firmware/chokesense/chokesense.ino` to an ESP32 DevKit V1 (Arduino IDE, board "ESP32 Dev Module"). The pin map is at the top of the file.
2. Plug the board into this computer and close the Arduino serial monitor: only one program can hold the port.
3. Open the app in Chrome or Edge on a desktop, on the deployed HTTPS address or at http://localhost:5173, and press **Connect trainer**. Pick the port (CP2102, CH340 or similar). The app goes straight to calibration.
4. Rest the fist on the target pad for 3 s, then the instructor gives three thrusts. The session follows: 4 cycles of 5 back blows then 5 thrusts.

### If nothing appears

Open the Arduino serial monitor at **115200 baud**, line ending **Newline** (close the browser tab first, or press Reconnect later).

1. **Press the board's EN button.** The first line must be exactly `{"hello":"chokesense","fw":"0.3.0","hz":10,"pads":["target","high","low","side","back"]}`. Nothing at all: wrong port, a charge-only USB cable, or the sketch did not upload. Garbled characters: the monitor is not at 115200.
2. **Frames.** Ten lines a second like `{"t":12345,"fist":0.02,"pads":[...],"acc":[0.11,-0.20,9.74]}`, with `t` rising by about 100 each line. If they stop after the hello, the board is resetting: look for a reboot message.
3. **`acc`** should read about 9.8 in total when still. `"acc":null` means the MPU-6050 is not answering: check SDA 21, SCL 22, 3.3 V and GND.
4. **Type `selftest`.** For 10 s it prints every channel's raw value (0 to 4095) once a second; press each pad and the fist in turn and watch its number rise. At the end each channel reads "responds", "STUCK HIGH" (missing 10 kOhm resistor to GND) or "NO CHANGE" (FSR or pin not connected).
5. **Type `ping`.** It must answer `{"pong":...}`. If it does not, the board is not reading commands; check the line ending is Newline.

If all five pass, close the monitor and connect from the browser with the debug log open (`?debug=1`). The `serial` and `parse` lines show the port, the first three raw lines, the hello, every unreadable line, and once a second the frame rate and readings.

## When things go wrong

- **Unplugged mid-session.** The page freezes on the last frame with a banner: "The trainer was unplugged. Everything recorded so far is kept." Plug it back in and press **Reconnect** (in the banner or the header). Judging carries on where it stopped, with time continuing from the last frame. The summary works from what was collected, before or after reconnecting.
- **No data for 1.5 s.** "Lost signal"; the page keeps listening and asks the board for a hello.
- **20 unreadable lines in a row.** "Unexpected data", with the last line shown.
- **A page crashes.** The header stays. In place of the page: one sentence naming the page and the error, a **Copy diagnostics** button, and a link back to Connect. Other pages still work. If something outside the pages fails, the whole app is replaced by the same message, never a blank screen.

## Debug log and self-test

Add `?debug=1` to any address, or press the backtick key (`` ` ``) on any page, to open the debug log at the bottom of the screen. Every line says what happened and the numbers behind it, for example:

```
[14:32:07.512 #0432 judge] T07 THRUST START crossed the start threshold  fist=0.520 start=0.450 ...
```

The time, the frame number and the area (`serial`, `parse`, `judge`, `calib`, `session`, `ui`, `ui/session`, `3d`, `route`, `error`) come first. Click an area to hide or show it. Drag the top edge to resize. **Copy diagnostics** copies a self-contained report (browser, data source, calibration, session counts, last error, last 200 lines) to paste into a bug report. The same lines also go to the browser console.

**Self-test** in the panel opens `/diag` without reloading, so the session is not lost. It runs these checks and prints, for each, what was checked, PASS or FAIL, and the actual value:

| Check | Passes when |
|---|---|
| Web Serial API present | `navigator.serial` exists |
| WebGL present and not software-rendered | a WebGL context opens, the renderer is not SwiftShader, llvmpipe or similar, and the browser reports no major performance caveat |
| torso.glb reachable | `GET /torso.glb` returns 200 and the body starts with the binary glTF magic `glTF` |
| Route `/`, `/calibrate`, `/session`, `/session/summary`, `/method`, `/privacy`, `/diag` resolves | the server returns the app page for that path (this is the Vercel rewrite at work), and the router matches it to its page, not "Page not found" |
| Mock stream produces frames at 10 Hz | a private copy of the demo stream delivers 9.5 to 10.5 frames a second over 3 s |
| judge.ts finds the 4 known faults in session.json | the judge reads the recording and finds exactly placement-high, not-released, blow-off-target and weak |
| Clipboard write permitted | `navigator.clipboard.writeText` exists, the page is a secure context, and `clipboard-write` is not denied |

**Copy report** copies the whole report as plain text.

## Acceptance tests

Run each with the debug log open (`?debug=1`). Afterwards press **Save session** on the summary and run `npm run replay -- <file> --quiet` to read the same verdicts offline.

| Test | How | Passes when the log shows |
|---|---|---|
| Thrust count exact | One full session: 4 cycles of 5 thrusts. | Four `PHASE thrusts -> backblows` / `thrusts -> complete` lines and no `Cycle N ended after X judged thrusts, not 5` warning. The summary says Thrusts 20. |
| Release detection flags leans | In one thrust set, between two thrusts, ease off to about a third of the reference instead of letting go. | `Tnn NOT RELEASED: a new push crossed START before the fist fell below END` with `lowest_after_peak` between `end=0.150` and `start=0.450`, then `Tnn FAULT not-released`. Every other thrust ends with `THRUST END`. |
| Back blows counted | One full session, 5 back blows per set. | `serial` lines `Back blow k of 5 in cycle c: wrist spike counted` for every blow, matching `Bnn BACK BLOW detected` from the judge, and no `moved to thrusts after X judged back blows, not 5` warning. The summary says Back blows 20. |
| Sequence tracker | During cycle 2's back blows, after the second blow, give one thrust, then finish the set. | `Tnn OUT OF ORDER in the 5-and-5 sequence  position=3 of=10 expected=backblow got=thrust cycle=2`. See the note under this table. |
| Reference spread within 15% | Calibrate with three steady instructor thrusts. | `calib` line `Reference updated: later thrusts are judged against these numbers` after R3 with `spread` at or below `0.150` and `spread_within_limit=true`. |
| 10 minutes, no freeze, reconnect | Stay connected for 10 minutes, with a full session in the middle. Partway through a set, pull the USB cable for about 10 s, plug it back in and press Reconnect. | A `serial` line `Last second: 10 frames, expected 10` every second throughout, with `dropped=0`. On the unplug, `DISCONNECTED (...); the session is frozen and nothing recorded is lost`, then `Keeping this run: the trainer was unplugged`. After Reconnect: `Reconnect pressed`, `Found the trainer among ports this page may use`, `Port opened`, `First valid frame received; streaming` with `t_session_s` just after the last frame before the unplug. The counts carry on from where they stopped. |

Note on the sequence test: `checkSequence` in `judge.ts` checks each entry against its position counted from the start (`i % 10`). One extra thrust shifts every later position, so every later cycle is also marked out of order and "cycles complete" reads 0. The first warning above is correct; the ones after it are knock-on effects.

## Where the data comes from

Data flows through three pieces:

- **A data source** (`src/sources/`) delivers raw frames: fist force, the five pad readings, the wrist accelerometer, and the device's state (phase, cycle, back blow counter, angle). There are three:
  - `mock.ts` plays back `shared/session.json` at 10 frames a second and stages the `?state=` review states. The recording has no accelerometer data. This is the demo, and the default until a trainer is connected.
  - `serial.ts` reads the ESP32 over USB with the Web Serial API. The firmware sends raw readings only, so `trainer.ts` plays the device's part on the computer. It also keeps every reading for **Save session**.
  - `replay.ts` plays a saved session file, through `trainer.ts` when the file has device readings.
- **The judge** (`src/judge.ts`) turns raw frames into thrust, back blow and reference events with placement, strength, release, abruptness and faults, plus phase changes and calibration. It knows nothing about where frames come from. All thresholds and all wording, such as "Weaker than reference", live here.
- **The stream** (`src/stream.tsx`) holds one source, feeds its frames to the judge, keeps every frame for saving, remembers a run that ends, and gives the pages the same snapshot they have always read.

The pages show whatever the judge flags and do not hard-code the recording's faults.

`shared/mockStream.js` is now only a re-export of the judge's constants so older imports keep working.

## Files

```
the_frontend/
  vercel.json              Vercel build settings and the rewrite to index.html
  vite.config.ts           static SPA at the site root
  firmware/chokesense/chokesense.ino   ESP32 DevKit V1 firmware for the serial protocol
  index.html               sets the theme before the page draws, to avoid a flash
  public/                  copied into dist/ as is; torso.glb goes here (not added yet)
  shared/                  the recording, plus a re-export kept for older imports
  scripts/
    replay.mjs             npm run replay: a saved session through the judge, no browser
    replay-entry.ts        what replay.mjs runs
  src/
    main.tsx               starts the app inside a last-resort crash boundary, mounts the debug panel
    App.tsx                route table, each page in its own crash boundary; theme and scroll handling
    stream.tsx             one shared session for all pages: source in, judge, snapshot out
    judge.ts               thresholds, wording, event judging, calibration, summary
    sessionFile.ts         saved-session format, download, and the last session kept in this tab
    sources/
      types.ts             the DataSource contract every source meets
      mock.ts              plays the recording at 10 Hz and stages ?state=
      serial.ts            reads the ESP32 over USB (Web Serial): lines, parsing, link state
      trainer.ts           the device's state machine, run on the computer: baseline, scale, phases
      replay.ts            plays a saved session as if the trainer were sending it
      protocol.md          the serial wire format, both directions
      webserial.d.ts       types for the Web Serial API
    debug.ts               the logger, ring buffer and diagnostics report
    DebugPanel.tsx         the on-screen log (?debug=1 or backtick), with the Self-test link
    advance.ts             auto-advance logging and the stuck-screen watchdog
    util.tsx               links that keep ?state and ?theme, theme, formatting helpers
    styles.css             all styles; colors are variables at the top, light and dark
    components/
      Boundary.tsx         crash boundary and the Copy diagnostics button it shows
      Common.tsx           header, footer, page title, error banner, loading placeholders
      Torso.tsx            picks the 3D torso or the flat drawing (no WebGL, or a crash)
      Torso3D.tsx          the 3D torso: model loading, zones, camera, render loop, 3d logs
      Parts.tsx            flat mannequin pad drawing (the fallback), sequence tracker,
                           latest entry, entries table, force chart
    pages/
      Home.tsx  Calibrate.tsx  Session.tsx  Summary.tsx
      Diag.tsx             /diag self-test
      Doc.tsx              shared layout for Method and Privacy (table of contents)
      Method.tsx  Privacy.tsx
```

## The 3D torso

`Torso3D.tsx` is loaded as its own chunk, only when WebGL works. It tries `/torso.glb` (from `public/torso.glb`; glTF, +y up, facing +z; any size, it is rescaled). If the file is missing or fails to load, it builds a torso from primitives: a capsule body and two cylinder arms. The debug log says which.

- Meshes named `zone_target`, `zone_high`, `zone_low`, `zone_left`, `zone_right` or `zone_back` in the glb are used as zones. Any zone without one gets a patch projected onto the torso surface (the torso is the mesh named `torso`, `body`, `chest` or `trunk`, else every mesh).
- All materials are replaced with flat-shaded neutral ones read from the CSS color variables, re-read when the theme changes. No textures, shadows, environment maps, tone mapping or bloom.
- The render loop draws at most 30 times a second, only while frames are flowing or something is moving (camera, pulse, drag), and stops while the tab is hidden.

Its `3d` log lines cover the model path and load time, the WebGL renderer (and whether it is software), each zone's registration, each pad contact with its force and frame number, each pulse, camera turns, fps with draw calls and triangles every 5 s while drawing, loop pauses, and context lost or restored.

## Design rules it follows

From the project brief: hand-written CSS with color variables, two fonts (Libre Franklin and Courier Prime), one accent color used only for live contact and faults, square corners, no gradients, shadows, icons or emojis, and no em or en dashes in page text. Forces are never called correct, and the angle is always shown as ungraded.
