// chokesense firmware 0.3.0 for the ESP32 DevKit V1.
// Streams raw sensor readings over USB serial as newline-delimited JSON at
// 10 Hz. The browser does all judging. Protocol: src/sources/protocol.md.
//
// Wiring, ADC1 pins only:
//   fist   GPIO36 (VP)    target GPIO39 (VN)    high GPIO34
//   low    GPIO35         side   GPIO32         back GPIO33
//   MPU-6050: SDA GPIO21, SCL GPIO22, 100 kHz, address 0x68 (AD0 to GND), VCC 3.3 V
// Each FSR is the top of a divider: 3.3 V, FSR, pin, 10 kOhm to GND. An
// unpressed pad reads near 0 and pressing raises it.
//
// Serial monitor: 115200 baud, line ending "Newline". Type hello, ping, zero
// or selftest.

#include <Arduino.h>
#include <Wire.h>
#include <math.h>

static const char *FW = "0.3.0";
static const uint32_t BAUD = 115200;
static const uint32_t FRAME_MS = 100;       // 10 Hz
static const uint32_t IMU_MS = 5;           // IMU polled between frames so a short back-blow spike is not missed
static const uint32_t IMU_RETRY_MS = 2000;  // try a missing IMU again this often
static const int ADC_SAMPLES = 4;           // each reading is the mean of this many quick reads

struct Channel { const char *name; uint8_t pin; };
static const Channel FIST = {"fist", 36};
static const Channel PADS[] = {{"target", 39}, {"high", 34}, {"low", 35}, {"side", 32}, {"back", 33}};
static const int NPADS = sizeof(PADS) / sizeof(PADS[0]);

static const int SDA_PIN = 21;
static const int SCL_PIN = 22;
static const uint8_t MPU_ADDR = 0x68;
static const float LSB_PER_G = 2048.0f;     // +-16 g range
static const float G = 9.80665f;

static bool imuOk = false;
static uint32_t imuRetryAt = 0;
static float accPeak[3];                    // sample furthest from 1 g since the last frame
static float accPeakDev = -1;               // < 0: no sample yet

static uint32_t tZero = 0;                  // millis() at boot or at the last "zero"
static uint32_t nextFrame = 0;
static uint32_t nextImu = 0;

static char cmd[40];
static uint8_t cmdLen = 0;
static bool cmdOverflow = false;

static const int SELFTEST_LINES = 10;
static int selftestLeft = 0;
static uint32_t selftestNext = 0;
static int stMin[1 + NPADS], stMax[1 + NPADS];

// ---- IMU -------------------------------------------------------------------
static bool imuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool imuRead(uint8_t reg, uint8_t *buf, int n) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, n) != n) return false;
  for (int i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

static bool imuInit() {
  uint8_t who = 0;
  if (!imuRead(0x75, &who, 1)) return false;   // WHO_AM_I; clones answer 0x70, 0x72 or 0x98, so any answer will do
  if (!imuWrite(0x6B, 0x00)) return false;     // PWR_MGMT_1: wake up
  if (!imuWrite(0x1C, 0x18)) return false;     // ACCEL_CONFIG: +-16 g, so back blows do not clip
  if (!imuWrite(0x1A, 0x01)) return false;     // CONFIG: 184 Hz low-pass, keeps short spikes
  return true;
}

static bool imuSample(float a[3]) {
  uint8_t b[6];
  if (!imuRead(0x3B, b, 6)) return false;
  for (int i = 0; i < 3; i++) a[i] = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]) / LSB_PER_G * G;
  return true;
}

static void imuPoll() {
  float a[3];
  if (!imuSample(a)) { imuOk = false; imuRetryAt = millis() + IMU_RETRY_MS; return; }
  float dev = fabsf(sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) - G);
  if (dev > accPeakDev) { accPeakDev = dev; accPeak[0] = a[0]; accPeak[1] = a[1]; accPeak[2] = a[2]; }
}

// ---- readings ----------------------------------------------------------------
static int readRaw(uint8_t pin) {
  uint32_t sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) sum += analogRead(pin);
  return (int)(sum / ADC_SAMPLES);
}

static float readNorm(uint8_t pin) { return readRaw(pin) / 4095.0f; }

static uint32_t now_t() { return millis() - tZero; }

static void sendHello() {
  Serial.print("{\"hello\":\"chokesense\",\"fw\":\"");
  Serial.print(FW);
  Serial.print("\",\"hz\":");
  Serial.print(1000 / FRAME_MS);
  Serial.print(",\"pads\":[");
  for (int i = 0; i < NPADS; i++) {
    if (i) Serial.print(',');
    Serial.print('"');
    Serial.print(PADS[i].name);
    Serial.print('"');
  }
  Serial.print("]}\n");
}

static void sendFrame() {
  char buf[200];
  int n = snprintf(buf, sizeof buf, "{\"t\":%lu,\"fist\":%.3f,\"pads\":[", (unsigned long)now_t(), readNorm(FIST.pin));
  for (int i = 0; i < NPADS; i++) n += snprintf(buf + n, sizeof buf - n, "%s%.3f", i ? "," : "", readNorm(PADS[i].pin));
  if (imuOk && accPeakDev >= 0) n += snprintf(buf + n, sizeof buf - n, "],\"acc\":[%.2f,%.2f,%.2f]}", accPeak[0], accPeak[1], accPeak[2]);
  else n += snprintf(buf + n, sizeof buf - n, "],\"acc\":null}");
  Serial.print(buf);
  Serial.print('\n');
  accPeakDev = -1;
}

// ---- self test ---------------------------------------------------------------
static void selftestStart() {
  selftestLeft = SELFTEST_LINES;
  selftestNext = millis();
  for (int i = 0; i <= NPADS; i++) { stMin[i] = 4095; stMax[i] = 0; }
  Serial.print("SELFTEST start: frames paused for 10 s. Raw ADC 0 to 4095, one line a second. Press each pad and the fist in turn.\n");
}

static void selftestStep() {
  int raw[1 + NPADS];
  raw[0] = readRaw(FIST.pin);
  for (int i = 0; i < NPADS; i++) raw[1 + i] = readRaw(PADS[i].pin);
  for (int i = 0; i <= NPADS; i++) { stMin[i] = min(stMin[i], raw[i]); stMax[i] = max(stMax[i], raw[i]); }

  char buf[220];
  int n = snprintf(buf, sizeof buf, "SELFTEST %d/%d %s=%d", SELFTEST_LINES - selftestLeft + 1, SELFTEST_LINES, FIST.name, raw[0]);
  for (int i = 0; i < NPADS; i++) n += snprintf(buf + n, sizeof buf - n, " %s=%d", PADS[i].name, raw[1 + i]);
  float a[3];
  if (imuOk && imuSample(a)) n += snprintf(buf + n, sizeof buf - n, " imu=ok ax=%.2f ay=%.2f az=%.2f m/s2", a[0], a[1], a[2]);
  else n += snprintf(buf + n, sizeof buf - n, " imu=NOT ANSWERING (check SDA 21, SCL 22, 3.3 V, GND)");
  Serial.print(buf);
  Serial.print('\n');

  if (--selftestLeft > 0) return;
  for (int i = 0; i <= NPADS; i++) {
    const char *name = i == 0 ? FIST.name : PADS[i - 1].name;
    const char *verdict = stMax[i] - stMin[i] >= 300 ? "responds"
      : stMin[i] > 3900 ? "STUCK HIGH: check the 10 kOhm resistor to GND"
      : "NO CHANGE: press it during the test, or check the FSR and its pin";
    snprintf(buf, sizeof buf, "SELFTEST %s min=%d max=%d %s", name, stMin[i], stMax[i], verdict);
    Serial.print(buf);
    Serial.print('\n');
  }
  Serial.print("SELFTEST done: frames resume.\n");
  nextFrame = millis();
}

// ---- commands ----------------------------------------------------------------
static void handleCommand(char *c) {
  for (char *p = c; *p; p++) *p = tolower(*p);
  uint32_t t = now_t();
  if (!strcmp(c, "hello")) sendHello();
  else if (!strcmp(c, "ping")) { Serial.printf("{\"pong\":%lu}\n", (unsigned long)t); }
  else if (!strcmp(c, "zero")) { tZero = millis(); Serial.printf("{\"zeroed\":%lu}\n", (unsigned long)t); }
  else if (!strcmp(c, "selftest")) selftestStart();
  else {
    for (char *p = c; *p; p++) if (*p == '"' || *p == '\\' || *p < 32) *p = '?';
    Serial.printf("{\"err\":\"unknown command\",\"cmd\":\"%s\"}\n", c);
  }
}

static void readCommands() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      cmd[cmdLen] = 0;
      // Trim surrounding spaces.
      char *s = cmd;
      while (*s == ' ') s++;
      for (int i = (int)strlen(s) - 1; i >= 0 && s[i] == ' '; i--) s[i] = 0;
      if (!cmdOverflow && *s) handleCommand(s);
      cmdLen = 0;
      cmdOverflow = false;
    } else if (cmdLen < sizeof(cmd) - 1) {
      cmd[cmdLen++] = ch;
    } else {
      cmdOverflow = true;
    }
  }
}

// ---- main --------------------------------------------------------------------
void setup() {
  Serial.begin(BAUD);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);   // full 0 to 3.3 V range
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);
  imuOk = imuInit();
  imuRetryAt = millis() + IMU_RETRY_MS;
  tZero = millis();
  sendHello();
  nextFrame = millis() + FRAME_MS;
}

void loop() {
  readCommands();
  uint32_t now = millis();

  if (imuOk && (int32_t)(now - nextImu) >= 0) {
    nextImu = now + IMU_MS;
    imuPoll();
  } else if (!imuOk && (int32_t)(now - imuRetryAt) >= 0) {
    imuOk = imuInit();
    imuRetryAt = now + IMU_RETRY_MS;
  }

  if (selftestLeft > 0) {
    if ((int32_t)(now - selftestNext) >= 0) { selftestNext += 1000; selftestStep(); }
    return;
  }

  if ((int32_t)(now - nextFrame) >= 0) {
    nextFrame += FRAME_MS;
    if ((int32_t)(now - nextFrame) >= (int32_t)FRAME_MS) nextFrame = now + FRAME_MS;  // fell behind: skip, do not burst
    sendFrame();
  }
}
