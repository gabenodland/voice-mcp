import assert from "node:assert/strict";
import { pickDevice } from "../src/main/audio-device.js";
import type { DeviceInfo } from "@voice-mcp/shared";

const devices: DeviceInfo[] = [
  { id: 130, name: "Speakers (Realtek)", isDefault: true, active: false },
  { id: 131, name: "Headphones (Razer)", isDefault: false, active: false },
];

// null pref / "default" → null (use MCI)
assert.equal(pickDevice(devices, null), null);
assert.equal(pickDevice(devices, { name: "default" }), null);

// exact name match wins, regardless of stale hint
assert.equal(pickDevice(devices, { name: "Headphones (Razer)", hintDeviceId: 999 })?.id, 131);

// name gone but hint still maps to the same name → use hint
assert.equal(
  pickDevice(devices, { name: "Speakers (Realtek)", hintDeviceId: 130 })?.id, 130
);

// name gone and hint maps to a DIFFERENT name → null (device considered gone)
assert.equal(pickDevice(devices, { name: "USB DAC", hintDeviceId: 131 }), null);

// id 0 is never usable
assert.equal(pickDevice([{ id: 0, name: "Ghost", isDefault: false, active: false }], { name: "Ghost" }), null);

console.log("audio-device: ALL ASSERTIONS PASSED");
