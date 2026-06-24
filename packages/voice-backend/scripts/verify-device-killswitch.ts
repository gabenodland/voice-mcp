// Regression: kill-switch / WASAPI-unavailable PATH PARITY.
//
// The #1 AI-introduced regression is "fix one path, forget the parallel path."
// Here the parallel paths are MCI (default) vs WASAPI (device selected), gated by
// VOICE_AUDIO_BACKEND=mci. Three INDEPENDENT functions must each short-circuit to
// the same "System default / MCI" shape when WASAPI is disabled. A change that
// updates one (say setDevice) but not the others (listDevices, getConfiguredDevice)
// would let the dashboard offer devices the player can never use.
//
// Hermetic by construction: with the kill-switch ON, every disabled branch returns
// BEFORE reading or writing the user's real pref file (~/.claude/voice/audio_device.json),
// so this test never enumerates hardware and never mutates the user's preference.
import assert from "node:assert/strict";
import {
  listDevices,
  setDevice,
  getConfiguredDevice,
  isWasapiDisabled,
  invalidateDeviceCache,
} from "../src/main/audio-device.js";

// ── Kill-switch ON: every WASAPI entry point must report the MCI/default shape ──
process.env.VOICE_AUDIO_BACKEND = "mci";
invalidateDeviceCache();

// listDevices: unavailable, empty list, default active, a reason given
{
  const r = listDevices();
  assert.equal(r.available, false, "listDevices.available must be false under kill-switch");
  assert.deepEqual(r.devices, [], "no devices may be offered when WASAPI is disabled");
  assert.equal(r.active, "System default", "active must read 'System default'");
  assert.ok(r.reason && /mci/i.test(r.reason), "a reason mentioning mci must be present");
}

// SHAPE-PARITY INVARIANT: available:false ⇒ devices:[] AND active:"System default".
// (The dashboard and createPlayer both rely on this pairing never drifting.)
{
  const r = listDevices();
  if (!r.available) {
    assert.deepEqual(r.devices, [], "available:false must always carry an empty device list");
    assert.equal(r.active, "System default", "available:false must always be System default");
  }
}

// setDevice: refuses BOTH a named device and "default" — guard is before any file write
{
  const named = setDevice("Speakers (Realtek)");
  assert.equal(named.ok, false, "setDevice(name) must fail under kill-switch");
  assert.equal(named.active, "System default");

  const def = setDevice("default");
  assert.equal(def.ok, false, "even setDevice('default') reports disabled (guard precedes default branch)");
  assert.equal(def.active, "System default");
}

// getConfiguredDevice: null ⇒ createPlayer() falls back to MCI
assert.equal(getConfiguredDevice(), null, "getConfiguredDevice must be null so createPlayer uses MCI");

// ── isWasapiDisabled(): env parsing (read live, case-insensitive exact 'mci') ──
process.env.VOICE_AUDIO_BACKEND = "mci";
assert.equal(isWasapiDisabled(), true, "'mci' enables the kill-switch");
process.env.VOICE_AUDIO_BACKEND = "MCI";
assert.equal(isWasapiDisabled(), true, "'MCI' is matched case-insensitively");
process.env.VOICE_AUDIO_BACKEND = "wasapi";
assert.equal(isWasapiDisabled(), false, "any other value leaves WASAPI enabled");
delete process.env.VOICE_AUDIO_BACKEND;
assert.equal(isWasapiDisabled(), false, "unset ⇒ WASAPI enabled (default)");

console.log("device-killswitch: ALL ASSERTIONS PASSED");
