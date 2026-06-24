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

// stale hint (no id match) falls back to the name lookup
assert.equal(pickDevice(devices, { name: "Headphones (Razer)", hintDeviceId: 999 })?.id, 131);

// hint matches the same name → resolves via hint
assert.equal(
  pickDevice(devices, { name: "Speakers (Realtek)", hintDeviceId: 130 })?.id, 130
);

// hint maps to a DIFFERENT name and the name itself is gone → null (device considered gone)
assert.equal(pickDevice(devices, { name: "USB DAC", hintDeviceId: 131 }), null);

// id 0 is never usable
assert.equal(pickDevice([{ id: 0, name: "Ghost", isDefault: false, active: false }], { name: "Ghost" }), null);

// duplicate names: the hint disambiguates which physical device, not just the first match
const dupes: DeviceInfo[] = [
  { id: 130, name: "LG FULL HD", isDefault: false, active: false },
  { id: 132, name: "LG FULL HD", isDefault: false, active: false },
];
assert.equal(pickDevice(dupes, { name: "LG FULL HD", hintDeviceId: 132 })?.id, 132);
assert.equal(pickDevice(dupes, { name: "LG FULL HD" })?.id, 130); // no hint → first name match

console.log("audio-device: ALL ASSERTIONS PASSED");
