// ChokeSense nine-FSR firmware for ESP32-S3 with Arduino framework.
// UART/USB: 115200, newline-delimited JSON; 12-bit ADC values (0..4095).
// Keep pin order aligned with SENSOR_KEYS. Change only pin numbers for your board.
// Wire each FSR: 3.3V -> FSR -> ADC pin -> 10k Ohm -> GND.
#include <Arduino.h>

const int FSR_PINS[9] = {1, 2, 4, 5, 6, 7, 8, 9, 10};
const char* SENSOR_KEYS[9] = {
  "front_target", "front_high", "front_low", "front_left", "front_right",
  "back_target", "back_off_target", "cpr_left", "cpr_right"
};
constexpr int NUM_SENSORS = 9;
constexpr uint32_t SAMPLE_MS = 5;
constexpr uint32_t SEND_MS = 20;
constexpr uint32_t HELLO_MS = 5000;
int currentValues[NUM_SENSORS] = {0};
int peakValues[NUM_SENSORS] = {0};
uint32_t lastSample = 0, lastSend = 0, lastHello = 0;

void sendHello() {
  Serial.print("{\"hello\":\"chokesense-9fsr\",\"hz\":50,\"pads\":[");
  for (int i = 0; i < NUM_SENSORS; i++) {
    if (i) Serial.print(',');
    Serial.print('"'); Serial.print(SENSOR_KEYS[i]); Serial.print('"');
  }
  Serial.println("]}");
}
void sampleSensors() {
  for (int i = 0; i < NUM_SENSORS; i++) {
    const int r = analogRead(FSR_PINS[i]);
    currentValues[i] = r;
    if (r > peakValues[i]) peakValues[i] = r;
  }
}
void sendFrame() {
  Serial.print("{\"schema\":\"fsr9-v1\",\"t\":"); Serial.print(millis());
  Serial.print(",\"fsr\":[");
  for (int i = 0; i < NUM_SENSORS; i++) { if (i) Serial.print(','); Serial.print(currentValues[i]); }
  Serial.print("],\"peak\":[");
  for (int i = 0; i < NUM_SENSORS; i++) { if (i) Serial.print(','); Serial.print(peakValues[i]); peakValues[i] = 0; }
  Serial.println("]}");
}
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (int i = 0; i < NUM_SENSORS; i++) pinMode(FSR_PINS[i], INPUT);
  sampleSensors();
  sendHello();
  lastSample = lastSend = lastHello = millis();
}
void loop() {
  const uint32_t now = millis();
  if ((uint32_t)(now - lastSample) >= SAMPLE_MS) { lastSample = now; sampleSensors(); }
  if ((uint32_t)(now - lastSend) >= SEND_MS) { lastSend = now; sendFrame(); }
  if ((uint32_t)(now - lastHello) >= HELLO_MS) { lastHello = now; sendHello(); }
}
