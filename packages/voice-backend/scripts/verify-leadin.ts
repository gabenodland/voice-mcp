import assert from "node:assert/strict";
import {
  clampLeadIn,
  leadInFrameCount,
  normalizeConfig,
} from "../src/main/audio-device.js";

// ── clampLeadIn: validate + clamp; non-finite → default (200), 0 is valid ──
assert.equal(clampLeadIn(-1), 0);
assert.equal(clampLeadIn(0), 0);
assert.equal(clampLeadIn(200), 200);
assert.equal(clampLeadIn(1001), 1000);
assert.equal(clampLeadIn(NaN), 200);
assert.equal(clampLeadIn(Infinity), 200);
assert.equal(clampLeadIn(-Infinity), 200);
assert.equal(clampLeadIn("150" as unknown as number), 200); // non-number → default
assert.equal(clampLeadIn(undefined as unknown as number), 200);

// ── leadInFrameCount: ceil(clamp(ms)/20) — never give LESS than requested ──
assert.equal(leadInFrameCount(0), 0);
assert.equal(leadInFrameCount(1), 1);
assert.equal(leadInFrameCount(20), 1);
assert.equal(leadInFrameCount(21), 2);
assert.equal(leadInFrameCount(199), 10);
assert.equal(leadInFrameCount(200), 10);
assert.equal(leadInFrameCount(201), 11);
assert.equal(leadInFrameCount(1000), 50);

// ── normalizeConfig: legacy migration, round-trip, validation ──
assert.deepEqual(
  normalizeConfig({ name: "Speakers", hintDeviceId: 134 }),
  { device: { name: "Speakers", hintDeviceId: 134 }, leadInMs: 200 },
);
assert.deepEqual(
  normalizeConfig({ device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 }),
  { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 },
);
assert.equal(normalizeConfig({ device: { name: "X" } }).leadInMs, 200);
assert.equal(normalizeConfig({ device: null, leadInMs: 9999 }).leadInMs, 1000);
assert.equal(normalizeConfig({ device: null, leadInMs: "x" }).leadInMs, 200);
assert.equal(normalizeConfig({ leadInMs: 100 }).device, null);
assert.equal(normalizeConfig({ device: { hintDeviceId: 1 } }).device, null);
assert.equal(normalizeConfig(null).device, null);
assert.equal(normalizeConfig("garbage").device, null);

// ── read-modify-write: device update preserves leadIn, and vice-versa ──
{
  const cfg = { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 };
  const afterLead = { device: cfg.device, leadInMs: clampLeadIn(150) };
  assert.deepEqual(afterLead, { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 150 });
  const afterDevice = { device: null, leadInMs: cfg.leadInMs };
  assert.deepEqual(afterDevice, { device: null, leadInMs: 300 });
}

console.log("leadin: ALL ASSERTIONS PASSED");
