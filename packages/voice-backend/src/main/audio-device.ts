import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { AUDIO_CONFIG_FILE, DEFAULT_LEADIN_MS, LEADIN_MS_MIN, LEADIN_MS_MAX } from "@voice-mcp/shared";
import type { DevicePref, DeviceInfo, DeviceListResult, AudioConfig } from "@voice-mcp/shared";

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

/** Validate + clamp a lead-in value. Non-finite (NaN/Infinity/non-number) → default. 0 is valid. */
export function clampLeadIn(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_LEADIN_MS;
  return Math.min(LEADIN_MS_MAX, Math.max(LEADIN_MS_MIN, n));
}

/** Frames of silence for a lead-in. ceil so the user never gets LESS than requested.
 *  frameMs = FRAME_SIZE / SAMPLE_RATE = 480 / 24000 = 20ms. */
export function leadInFrameCount(ms: number, frameMs = 20): number {
  return Math.ceil(clampLeadIn(ms) / frameMs);
}

/** Normalize parsed JSON (incl. the legacy device-only shape) into an AudioConfig. */
export function normalizeConfig(parsed: unknown): AudioConfig {
  const p = (parsed && typeof parsed === "object") ? parsed as Record<string, any> : {};
  const src = (p.device && typeof p.device === "object") ? p.device : p; // legacy: device fields at top level
  const device: DevicePref | null = typeof src.name === "string"
    ? { name: src.name, hintDeviceId: typeof src.hintDeviceId === "number" ? src.hintDeviceId : undefined }
    : null;
  return { device, leadInMs: clampLeadIn(p.leadInMs) };
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
  // Prefer an exact id+name match: this disambiguates duplicate device names (e.g. two
  // identically-named monitors) when the id is still stable.
  if (pref.hintDeviceId && pref.hintDeviceId !== 0) {
    const byHint = devices.find((d) => d.id === pref.hintDeviceId && d.name === pref.name);
    if (byHint) return byHint;
  }
  // Fall back to name: the id drifted across replug/reboot but the name is stable.
  const byName = devices.find((d) => d.name === pref.name);
  if (byName && byName.id !== 0) return byName;
  return null;
}

export function loadConfig(): AudioConfig {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(AUDIO_CONFIG_FILE, "utf-8")));
  } catch {
    return { device: null, leadInMs: DEFAULT_LEADIN_MS }; // absent or corrupt
  }
}

export function saveConfig(cfg: AudioConfig): void {
  try {
    fs.mkdirSync(path.dirname(AUDIO_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(AUDIO_CONFIG_FILE, JSON.stringify({
      device: cfg.device && cfg.device.name !== "default" ? cfg.device : null,
      leadInMs: clampLeadIn(cfg.leadInMs),
    }));
  } catch (err) {
    console.error("voice-mcp-backend: failed to save audio config:", err);
  }
}

export function loadPref(): DevicePref | null {
  return loadConfig().device;
}

/** Update only the device; preserves the persisted leadInMs (read-modify-write). */
export function savePref(pref: DevicePref | null): void {
  saveConfig({ device: pref, leadInMs: loadConfig().leadInMs });
}

export function getLeadInMs(): number {
  return loadConfig().leadInMs; // already clamped by normalizeConfig
}

/** Update only the lead-in; preserves the persisted device (read-modify-write). */
export function setLeadInMs(ms: number): { ok: true; leadInMs: number } {
  const cfg = loadConfig();
  const leadInMs = clampLeadIn(ms);
  saveConfig({ device: cfg.device, leadInMs });
  invalidateDeviceCache();
  return { ok: true, leadInMs };
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

  const cfg = loadConfig();
  let result: DeviceListResult;
  if (isWasapiDisabled()) {
    result = { available: false, leadInAvailable: false, leadInMs: cfg.leadInMs,
      reason: "WASAPI disabled by VOICE_AUDIO_BACKEND=mci", active: "System default", devices: [] };
  } else if (!loadAudify()) {
    result = { available: false, leadInAvailable: false, leadInMs: cfg.leadInMs,
      reason: "audify native module unavailable", active: "System default", devices: [] };
  } else {
    const devices = enumerateDevices(cfg.device);
    if (devices.length === 0) {
      // audify loaded but enumeration yielded nothing (RtAudio init/getDevices threw,
      // already logged) — selection isn't actually usable, so report unavailable.
      result = { available: false, leadInAvailable: false, leadInMs: cfg.leadInMs,
        reason: "no output devices found", active: "System default", devices: [] };
    } else {
      result = { available: true, leadInAvailable: true, leadInMs: cfg.leadInMs,
        active: activeLabel(cfg.device), devices };
    }
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

/** Sync — used by createPlayer() to decide MCI vs WASAPI. null = use MCI. */
export function getConfiguredDevice(): DevicePref | null {
  if (isWasapiDisabled()) return null;
  const pref = loadPref();
  return pref && pref.name !== "default" ? pref : null;
}
