# Trainer serial protocol, v0.3

The ESP32 talks to the browser over its USB serial port. Both sides of this
file are implemented: the firmware in `firmware/chokesense/chokesense.ino`,
the browser in `src/sources/serial.ts` (transport and parsing) and
`src/sources/trainer.ts` (what the browser does with the readings).

## Link

- 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control.
- UTF-8 text, one JSON object per line, lines end with `\n`. The browser also
  accepts `\r\n` and ignores blank lines.
- More than 1024 characters without a newline are handed over as one line,
  which fails to parse and counts as garbage.

## Device to host

### Hello

Sent once on boot and again whenever the host sends `hello`:

```
{"hello":"chokesense","fw":"0.3.0","hz":10,"pads":["target","high","low","side","back"]}
```

| field | meaning |
|---|---|
| `hello` | always `"chokesense"` |
| `fw` | firmware version |
| `hz` | frames per second the device intends to send |
| `pads` | names of the pad readings, in the order they appear in every frame |

The browser maps pads by name, not by position, so the firmware may reorder
them. The browser expects exactly `target`, `high`, `low`, `side`, `back` and
warns if the set differs. A missing pad reads as 0.

### Frame

Sent at `hz`, 10 a second:

```
{"t":12345,"fist":0.73,"pads":[0.02,0.81,0.00,0.01,0.00],"acc":[0.11,-0.20,9.74]}
```

| field | type | range | meaning |
|---|---|---|---|
| `t` | integer | 0 or more | device milliseconds since boot (or since `zero`) |
| `fist` | number | 0 to 1 | glove FSR, `analogRead / 4095` |
| `pads` | array of numbers | 0 to 1 each | torso FSRs, `analogRead / 4095`, in hello order |
| `acc` | array of 3 numbers, or `null` | about -157 to 157 | wrist accelerometer x, y, z in m/s², `null` if the IMU does not answer |

All readings are raw. The device never subtracts a baseline, never scales to
the reference and never judges. `fist` and `pads` are the mean of 4 quick ADC
reads at send time. `acc` is the sample with the largest deviation from 1 g
among the IMU samples taken since the previous frame (the IMU is polled about
every 5 ms), so a short back-blow spike between two frames is not missed.

### Replies

| line | sent when |
|---|---|
| `{"pong":<t>}` | after `ping`; `t` as in a frame |
| `{"zeroed":<t>}` | after `zero`; `t` is the clock value just before it reset |
| `{"err":"unknown command","cmd":"<text>"}` | after any other command |

### Self test (for a serial monitor, not the browser)

`SELFTEST` pauses frames for 10 seconds and prints one plain-text line a
second with every channel's raw ADC value (0 to 4095) and the IMU reading,
then one verdict line per channel (responds, stuck high, or no change) and
resumes frames. These lines are not JSON. The browser counts them as parse
failures (18 lines, under the limit of 20) and its silence watch reports lost
signal while frames are paused.

## Host to device

Newline-terminated, case-insensitive, surrounding spaces ignored.

| command | effect |
|---|---|
| `hello` | device sends the hello line |
| `ping` | device sends `{"pong":<t>}` |
| `zero` | device restarts `t` at 0 and sends `{"zeroed":<t>}` |
| `selftest` | 10 second wiring check, see above |

The browser sends `hello` right after opening the port, again every 2 s until
a hello arrives (up to 3 times), and again when the signal is lost. It sends
`ping` every 5 s and logs the round trip.

## What the browser does with the readings

The judge (`src/judge.ts`) was written for a device that also reports its
phase, cycle, back blow counter and angle, with fist force already in units of
the instructor reference. This firmware sends raw readings only, so
`trainer.ts` plays that part on the host:

1. **Rest.** The first 3 s of steady readings (fist within 0.08 of its running
   mean) set the baseline of the fist and of each pad. Movement restarts the
   3 s. During rest the fist is sent to the judge as raw minus the running mean.
2. **Calibration.** Fist is raw minus baseline. The first push above
   `max(0.04, 5 × rest noise)` is held back until it ends, then delivered
   scaled so its peak is 1.00. The next two pushes are scaled by that first
   peak. After the third ends, the scale becomes the mean of the three raw
   peaks, so from then on 1.00 is the instructor's mean.
3. **Cycles.** 4 cycles of 5 back blows then 5 thrusts, then complete. A back
   blow is an accelerometer frame whose magnitude is more than 12 m/s² away
   from 1 g, with the fist below the thrust END threshold, at least 400 ms
   after the previous blow, counted only in the back-blow phase. With no IMU,
   a rise of the back pad above 0.3 is used instead. Thrusts are counted with
   the judge's own START, END and dead-time rules.
4. **Pads** are raw minus their rest baseline, never below 0.
5. **Angle** is the elevation of the IMU x axis (worn pointing along the
   forearm toward the fingers) from a smoothed gravity estimate, only while a
   thrust is in progress. Shown, never graded.
6. **Time.** Frame time is device `t` turned into seconds and made continuous
   across a device restart or a reconnect, so the judge always sees time
   moving forward.
