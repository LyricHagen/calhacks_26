#include <Arduino.h>

const int FSR_PINS[9] = {
  4,
  5,
  7,
  15,
  16,
  9,
  8,
  18,
  17
};

const char* SENSOR_KEYS[9] = {
  "front_target",
  "front_high",
  "front_low",
  "front_left",
  "front_right",
  "back_target",
  "back_left",
  "back_right",
  "cpr_sternum"
};

constexpr int NUM_SENSORS = 9;
constexpr uint32_t SAMPLE_MS = 5;
constexpr uint32_t SEND_MS = 20;
constexpr uint32_t HELLO_MS = 5000;

int currentValues[NUM_SENSORS] = {0};
int peakValues[NUM_SENSORS] = {0};

uint32_t lastSample = 0;
uint32_t lastSend = 0;
uint32_t lastHello = 0;

void sendHello() {
  Serial.print("{\"hello\":\"chokesense-9fsr\",\"hz\":50,\"pads\":[");

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (i > 0) {
      Serial.print(',');
    }

    Serial.print('"');
    Serial.print(SENSOR_KEYS[i]);
    Serial.print('"');
  }

  Serial.println("]}");
}

void sampleSensors() {
  for (int i = 0; i < NUM_SENSORS; i++) {
    const int reading = analogRead(FSR_PINS[i]);

    currentValues[i] = reading;

    if (reading > peakValues[i]) {
      peakValues[i] = reading;
    }
  }
}

void sendFrame() {
  Serial.print("{\"schema\":\"fsr9-v1\",\"t\":");
  Serial.print(millis());
  Serial.print(",\"fsr\":[");

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (i > 0) {
      Serial.print(',');
    }

    Serial.print(currentValues[i]);
  }

  Serial.print("],\"peak\":[");

  for (int i = 0; i < NUM_SENSORS; i++) {
    if (i > 0) {
      Serial.print(',');
    }

    Serial.print(peakValues[i]);
    peakValues[i] = 0;
  }

  Serial.println("]}");
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);

  for (int i = 0; i < NUM_SENSORS; i++) {
    pinMode(FSR_PINS[i], INPUT);
  }

  sampleSensors();
  sendHello();

  lastSample = millis();
  lastSend = millis();
  lastHello = millis();
}

void loop() {
  const uint32_t now = millis();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    sampleSensors();
  }

  if (now - lastSend >= SEND_MS) {
    lastSend = now;
    sendFrame();
  }

  if (now - lastHello >= HELLO_MS) {
    lastHello = now;
    sendHello();
  }
}
