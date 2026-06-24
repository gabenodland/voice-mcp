# Audio Lead-in Silence (Bluetooth cold-start fix) — Design

**Date:** 2026-06-24
**Branch:** `feat/audio-output-device` (folded into the audio-output-device work)
**Status:** Approved (design review incorporated)

## 1. Problem

When the user selects a Bluetooth output device, the first word of an utterance is
sometimes clipped. Cause: Bluetooth A2DP links go idle between utterances. When a new
clip starts, the first ~100–300 ms after `rt.start()` is spent re-establishing /
buffering the link, so the speaker renders silence (or drops frames) while we are
already writing real audio. The *"sometimes"* is diagnostic: a clip played shortly after
a previous one finds the link still warm (no clip); after an idle gap the link is cold
(clip). Wired/MCI output does not show it — there is no link to wake.

This affects only the **WASAPI path** (`wasapi-player.ts`), which is exactly the path
that runs when a specific non-default device is selected. We control that path
frame-by-frame, so we can pad it.

## 2. Approach

Prepend N milliseconds of **silence frames** to the WASAPI playback buffer. The link
wakes during the silence instead of during speech, so the first word survives. The
amount is a **user-tunable, persisted** setting exposed in the web dashboard. Default
200 ms. Range 0–1000 ms in 20 ms steps. Set to 0 to disable.

Trade-off (accepted): the lead-in is added before *every* utterance through a selected
device, wired included — RtAudio cannot reliably distinguish Bluetooth from wired. At
200 ms this is below the "laggy" perception threshold, only affects users who opted into
a specific device, and is dialable to 0. The MCI/system-default path is unaffected.

## 3. Data model & persistence

### Constants (`packages/shared/src/constants.ts`)
- `DEFAULT_LEADIN_MS = 200`
- `LEADIN_MS_MIN = 0`
- `LEADIN_MS_MAX = 1000`
- Rename `DEVICE_PREF_FILE` → `AUDIO_CONFIG_FILE`. **On-disk filename stays
  `audio_device.json`** so existing installs are not orphaned.

### Types (`packages/shared/src/types.ts`)
```ts
export interface AudioConfig {
  device: DevicePref | null;
  leadInMs: number;
}
```
- `DeviceListResult` gains:
  - `leadInMs: number` — the current configured value.
  - `leadInAvailable: boolean` — whether the WASAPI subsystem can apply a lead-in
    (true ⇔ `available`: not kill-switched and audify loaded). The renderer disables the
    control on `!leadInAvailable` — an **explicit capability flag**, never a display-name
    comparison.
- New command: `SetLeadInCommand { cmd: "set_leadin"; ms: number }`, added to the
  `TcpCommand` union. Response is `OkResponse` / `ErrorResponse`.

### Config layer (`packages/voice-backend/src/main/audio-device.ts`)
The persisted unit becomes `AudioConfig`. Two **pure** helpers carry the testable logic:

```ts
/** Validate + clamp a lead-in value. Non-finite (NaN/Infinity/non-number) → default. */
export function clampLeadIn(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_LEADIN_MS;
  return Math.min(LEADIN_MS_MAX, Math.max(LEADIN_MS_MIN, n));
}

/** Normalize parsed JSON (incl. legacy device-only shape) into an AudioConfig. */
export function normalizeConfig(parsed: unknown): AudioConfig {
  // legacy: { name, hintDeviceId }  →  { device: {...}, leadInMs: DEFAULT_LEADIN_MS }
  // current: { device, leadInMs }   →  used as-is, fields validated
  // invalid/missing device → null; invalid/missing leadInMs → clampLeadIn(default)
}
```

- `loadConfig()` / `saveConfig(cfg)` — primitives over `AUDIO_CONFIG_FILE`, via
  `normalizeConfig`.
- Existing device accessors become thin reads over `loadConfig().device`:
  `loadPref()` ≈ `loadConfig().device`; `savePref(pref)` does a **read-modify-write**
  that preserves `leadInMs`; `getConfiguredDevice` / `getActiveDeviceName` unchanged in
  behavior.
- New: `getLeadInMs(): number` (returns `clampLeadIn(loadConfig().leadInMs)`) and
  `setLeadInMs(ms)` (read-modify-write preserving `device`, clamp, persist,
  `invalidateDeviceCache()`).
- `listDevices()` includes `leadInMs` and `leadInAvailable` in every branch
  (disabled branches: `leadInAvailable: false`, `leadInMs:` the persisted/default value).

## 4. Playback (`packages/voice-backend/src/main/wasapi-player.ts`)

A pure helper computes the frame count (ceil so the user never gets *less* than asked):
```ts
export function leadInFrameCount(ms: number, frameMs = 20): number {
  return Math.ceil(clampLeadIn(ms) / frameMs); // frame = FRAME_SIZE/SAMPLE_RATE = 20ms
}
```
`play()`: after `sliceIntoFrames`, prepend `leadInFrameCount(getLeadInMs())` copies of a
single private `SILENT_FRAME = Buffer.alloc(FRAME_SIZE * CHANNELS * 4)`, then bump
`totalFrames`. The shared buffer is only ever passed read-only to `rt.write()` — the same
treatment the real decoded frames already receive in the pump — so no per-frame copy is
needed; the read-only invariant is documented at the declaration. Completion accounting
(`audibleFrames >= totalFrames`) and pause/resume (rewind to audible cursor) already
operate on the frame array, so they work unchanged.

`playProbe()` (the dashboard Test button) applies the same lead-in, so the test reflects
real playback behavior on the selected device.

## 5. Transport & UI

- **`tcp-server.ts`**: `handleSetLeadIn(ms)` → `setLeadInMs` + `broadcastState`; add
  `set_leadin` to the command dispatch (parity with `set_device`; enables headless
  testing).
- **`web-ui.ts`**: `getFullState` already ships `listDevices()` (now carrying `leadInMs` +
  `leadInAvailable`); add WS action `set_leadin` → `setLeadInMs` + broadcast.
- **renderer (`app.js` / `index.html` / `styles.css`)**: a numeric input labeled
  **"Lead-in (ms)"** beside the device picker.
  - `min=0 max=1000 step=20`, value from `state.audioDevices.leadInMs`.
  - On commit (blur/Enter), send `{ action: "set_leadin", ms }`.
  - **Disabled** only when `!state.audioDevices.leadInAvailable` (WASAPI subsystem
    unavailable). Otherwise **editable**, even on System default, so the user can
    preconfigure before selecting a Bluetooth device.
  - Helper text: *"Adds silent padding before playback to prevent Bluetooth devices from
    clipping the first word."* When no specific device is currently active
    (`!devices.some(d => d.active)`), append: *"Only applies when a specific WASAPI device
    is selected."*

## 6. Testing (`packages/voice-backend/scripts/verify-leadin.ts`, tsx + node:assert)

Pure helpers — no filesystem, no WASAPI — matching the existing `pickDevice` test style.

**`clampLeadIn`:** `-1→0`, `0→0`, `200→200`, `1001→1000`, `NaN→200`, `Infinity→200`,
non-number/string → `200`.

**`leadInFrameCount` (ceil / 20):** `0→0`, `1→1`, `20→1`, `21→2`, `199→10`, `200→10`,
`201→11`, `1000→50`.

**`normalizeConfig`:** legacy `{name,hintDeviceId}` migrates to
`{ device:{name,hintDeviceId}, leadInMs:200 }`; new full shape round-trips; missing
`leadInMs` → default; invalid `leadInMs` → clamped/default; invalid/missing `device` →
`null`.

**Read-modify-write invariants:** `savePref` preserves `leadInMs`; `setLeadInMs`
preserves `device`. (These touch the real config file — exercise via `normalizeConfig`
on constructed objects rather than disk writes, to keep the script hermetic.)

Re-check `verify-device-killswitch.ts` for the `DeviceListResult` shape change
(`leadInAvailable:false` + `leadInMs` present in disabled branches).

## 7. Scope

- Stays on `feat/audio-output-device` as its own commit(s).
- No MCP tool — dashboard-only control (per decision).
- No change to the MCI / system-default playback path.
