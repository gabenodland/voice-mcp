import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DEVICE_PREF_FILE } from "@voice-mcp/shared";
import type { DevicePref, DeviceInfo, DeviceListResult } from "@voice-mcp/shared";

const require = createRequire(import.meta.url);

// audify loaded synchronously; undefined = not tried, null = failed/unavailable.
let audifyMod: any;
export function loadAudify(): any {
  if (audifyMod !== undefined) return audifyMod;
  try {
    audifyMod = require("audify");
  } catch (err) {
    console.error("voice-mcp-backend: audify unavailable, WASAPI disabled:", err);
    audifyMod = null;
  }
  return audifyMod;
}

export const WASAPI_API = 7; // RtAudioApi.WINDOWS_WASAPI fallback if the enum isn't a runtime value

export function isWasapiDisabled(): boolean {
  return (process.env.VOICE_AUDIO_BACKEND ?? "").toLowerCase() === "mci";
}

/** The active-device label derived from a saved preference. Single source of truth. */
function activeLabel(pref: DevicePref | null): string {
  return pref?.name && pref.name !== "default" ? pref.name : "System default";
}

/** Map a live RtAudio instance's output endpoints to DeviceInfo. Shared by
 *  enumeration and the WASAPI player, which must enumerate on the SAME instance
 *  it opens a stream on (RtAudio ids are opaque and instance-scoped). */
export function mapOutputDevices(rt: any, pref: DevicePref | null = null): DeviceInfo[] {
  return rt.getDevices()
    .filter((d: any) => d.outputChannels > 0)
    .map((d: any): DeviceInfo => ({
      id: d.id,
      name: d.name,
      isDefault: !!d.isDefaultOutput,
      active: !!pref && pref.name === d.name,
    }));
}

/** Pure: choose a device from an enumerated list given a saved preference. */
export function pickDevice(devices: DeviceInfo[], pref: DevicePref | null): DeviceInfo | null {
  if (!pref || pref.name === "default") return null;
  const byName = devices.find((d) => d.name === pref.name);
  if (byName && byName.id !== 0) return byName;
  if (pref.hintDeviceId && pref.hintDeviceId !== 0) {
    const byHint = devices.find((d) => d.id === pref.hintDeviceId && d.name === pref.name);
    if (byHint) return byHint;
  }
  return null;
}

export function loadPref(): DevicePref | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICE_PREF_FILE, "utf-8"));
    if (parsed && typeof parsed.name === "string") {
      return { name: parsed.name, hintDeviceId: typeof parsed.hintDeviceId === "number" ? parsed.hintDeviceId : undefined };
    }
    return null;
  } catch {
    return null; // absent or corrupt → no preference
  }
}

export function savePref(pref: DevicePref | null): void {
  try {
    if (!pref || pref.name === "default") {
      if (fs.existsSync(DEVICE_PREF_FILE)) fs.unlinkSync(DEVICE_PREF_FILE);
      return;
    }
    fs.mkdirSync(path.dirname(DEVICE_PREF_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_PREF_FILE, JSON.stringify(pref));
  } catch (err) {
    console.error("voice-mcp-backend: failed to save device pref:", err);
  }
}

/** Enumerate output devices on a fresh RtAudio instance. Returns [] if unavailable.
 *  Pass `pref` to avoid a redundant pref-file read when the caller already has it. */
export function enumerateDevices(pref: DevicePref | null = loadPref()): DeviceInfo[] {
  const mod = loadAudify();
  if (!mod) return [];
  try {
    const rt = new mod.RtAudio(mod.RtAudioApi?.WINDOWS_WASAPI ?? WASAPI_API);
    return mapOutputDevices(rt, pref);
  } catch (err) {
    console.error("voice-mcp-backend: device enumeration failed:", err);
    return [];
  }
}

// Cache enumeration so the 250ms dashboard broadcast and per-status calls don't
// re-instantiate native RtAudio 4x/second. Invalidated on setDevice(); short TTL otherwise.
let cachedList: DeviceListResult | null = null;
let cachedAt = 0;
const LIST_TTL_MS = 3000;

export function invalidateDeviceCache(): void {
  cachedList = null;
}

export function listDevices(): DeviceListResult {
  const now = Date.now();
  if (cachedList && now - cachedAt < LIST_TTL_MS) return cachedList;

  let result: DeviceListResult;
  if (isWasapiDisabled()) {
    result = { available: false, reason: "WASAPI disabled by VOICE_AUDIO_BACKEND=mci", active: "System default", devices: [] };
  } else if (!loadAudify()) {
    result = { available: false, reason: "audify native module unavailable", active: "System default", devices: [] };
  } else {
    const pref = loadPref();
    result = { available: true, active: activeLabel(pref), devices: enumerateDevices(pref) };
  }
  cachedList = result;
  cachedAt = now;
  return result;
}

export function setDevice(nameOrDefault: string): { ok: boolean; error?: string; active: string } {
  if (isWasapiDisabled()) {
    return { ok: false, error: "WASAPI disabled by VOICE_AUDIO_BACKEND=mci", active: "System default" };
  }
  if (nameOrDefault === "default") {
    savePref(null);
    invalidateDeviceCache();
    return { ok: true, active: "System default" };
  }
  const match = enumerateDevices().find((d) => d.name === nameOrDefault);
  if (!match) {
    return { ok: false, error: `Device not found: ${nameOrDefault}`, active: loadPref()?.name ?? "System default" };
  }
  savePref({ name: match.name, hintDeviceId: match.id });
  invalidateDeviceCache();
  return { ok: true, active: match.name };
}

/** Active-device label for status, without a native device enumeration.
 *  Mirrors listDevices().active (System default when WASAPI is disabled/unavailable). */
export function getActiveDeviceName(): string {
  if (isWasapiDisabled() || !loadAudify()) return "System default";
  return activeLabel(loadPref());
}

/** Sync — used by createPlayer() to decide MCI vs WASAPI. null = use MCI. */
export function getConfiguredDevice(): DevicePref | null {
  if (isWasapiDisabled()) return null;
  const pref = loadPref();
  return pref && pref.name !== "default" ? pref : null;
}
