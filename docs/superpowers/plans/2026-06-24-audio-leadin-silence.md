# Audio Lead-in Silence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-tunable, persisted "lead-in silence" that prepends N ms of silence before WASAPI (selected-device) playback, so Bluetooth A2DP link wake-up no longer clips the first word.

**Architecture:** The persisted audio config generalizes from a bare `DevicePref` to `AudioConfig { device, leadInMs }` (same file path). `audio-device.ts` owns all config + pure lead-in math (`clampLeadIn`, `leadInFrameCount`, `normalizeConfig`). `wasapi-player.ts` prepends `leadInFrameCount(getLeadInMs())` silent frames in `play()` and `playProbe()`. The value is set from the dashboard via a new `set_leadin` WS action / TCP command and surfaced in dashboard state as `leadInMs` + an explicit `leadInAvailable` capability flag.

**Tech Stack:** TypeScript, npm workspaces, audify (RtAudio/WASAPI), tsx test scripts + `node:assert/strict`. Windows-only path. No test runner — tests are standalone `npx tsx` scripts.

**Spec:** `docs/superpowers/specs/2026-06-24-audio-leadin-silence-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/shared/src/constants.ts` | lead-in defaults + config file path | modify |
| `packages/shared/src/types.ts` | `AudioConfig`, `DeviceListResult`/`DevicesResponse` fields, `SetLeadInCommand` | modify |
| `packages/voice-backend/src/main/audio-device.ts` | config persistence + pure lead-in helpers + `get/setLeadInMs` | modify |
| `packages/voice-backend/src/main/wasapi-player.ts` | prepend silent frames in `play()`/`playProbe()` | modify |
| `packages/voice-backend/src/main/tcp-server.ts` | `handleSetLeadIn` + dispatch + list passthrough | modify |
| `packages/voice-backend/src/main/web-ui.ts` | `set_leadin` WS action | modify |
| `packages/voice-backend/src/renderer/{index.html,app.js,styles.css}` | lead-in input + render + handler | modify |
| `packages/voice-backend/scripts/verify-leadin.ts` | pure-helper unit tests | create |
| `packages/voice-backend/scripts/verify-device-killswitch.ts` | update for new `DeviceListResult` shape | modify |

**Deviation from spec (intentional):** `leadInFrameCount` lives in `audio-device.ts` (next to `clampLeadIn`), not `wasapi-player.ts`. This lets `verify-leadin.ts` import only `audio-device.ts` (no `mpg123-decoder`/audify pull), keeping the test hermetic.

---

## Task 0: Stabilize the base (commit pending cleanup)

The `/simplify` cleanup and the kill-switch regression test are uncommitted and touch files this feature edits. Land them first so lead-in work starts clean. **Do NOT stage `packages/shared/src/voice-pool.ts`, `CLAUDE.md`, `.claude/skills/`, or `docs/wasapi-migration-report.html`.**

**Files:** (already modified in working tree) `tools.ts`, `constants.ts`, `audio-device.ts`, `tcp-server.ts`, `wasapi-player.ts`; (untracked) `verify-device-killswitch.ts`.

- [ ] **Step 1: Verify the cleanup is green**

Run:
```bash
cd /d/_dev/voice-mcp && npm run build:shared \
  && npx tsc --noEmit -p packages/voice-backend/tsconfig.json \
  && (cd packages/voice-backend && for f in scripts/verify-*.ts; do npx tsx "$f" || exit 1; done)
```
Expected: backend typecheck clean; `pcm-utils`, `audio-device`, `device-killswitch` all print `ALL ASSERTIONS PASSED`.

- [ ] **Step 2: Commit the /simplify cleanup (explicit files only)**

```bash
git add packages/mcp-server/src/tools.ts packages/shared/src/constants.ts \
  packages/voice-backend/src/main/audio-device.ts \
  packages/voice-backend/src/main/tcp-server.ts \
  packages/voice-backend/src/main/wasapi-player.ts
git commit -m "refactor: dedup device enumeration, type voice_devices, trim redundant I/O

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit the kill-switch regression test**

```bash
git add packages/voice-backend/scripts/verify-device-killswitch.ts
git commit -m "test: regression guard for WASAPI kill-switch path parity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Confirm clean base**

Run: `git status --short`
Expected: only the unrelated leftovers remain (`M packages/shared/src/voice-pool.ts`, `?? .claude/skills/`, `?? CLAUDE.md`, `?? docs/wasapi-migration-report.html`). No staged changes.

---

## Task 1: Constants — lead-in defaults + config file rename

The rename touches both files that reference the symbol, in one commit, so every commit compiles.

**Files:**
- Modify: `packages/shared/src/constants.ts:17`
- Modify: `packages/voice-backend/src/main/audio-device.ts` (symbol rename only)

- [ ] **Step 1: Confirm `DEVICE_PREF_FILE` has a single importer**

Run: `grep -rn "DEVICE_PREF_FILE" packages --include=*.ts | grep -v node_modules | grep -v "\.d\.ts"`
Expected: two lines only — the declaration in `constants.ts` and the import in `audio-device.ts`. (If more appear, rename those imports too in this task.)

- [ ] **Step 2: Replace the constant line**

In `packages/shared/src/constants.ts`, replace:
```ts
export const DEVICE_PREF_FILE = path.join(DATA_DIR, "audio_device.json");
```
with:
```ts
// Audio output config (device selection + Bluetooth lead-in). On-disk name kept as
// audio_device.json so existing installs migrate in place.
export const AUDIO_CONFIG_FILE = path.join(DATA_DIR, "audio_device.json");
export const DEFAULT_LEADIN_MS = 200; // silence prepended to WASAPI playback (Bluetooth cold-start)
export const LEADIN_MS_MIN = 0;
export const LEADIN_MS_MAX = 1000;
```

- [ ] **Step 3: Rename the symbol in `audio-device.ts` (no logic change)**

In `packages/voice-backend/src/main/audio-device.ts`, replace every occurrence of `DEVICE_PREF_FILE` with `AUDIO_CONFIG_FILE` (the import on line 4 and the three uses in `loadPref`/`savePref`). This is a pure symbol rename — `loadPref`/`savePref` are rewritten in Task 3.

- [ ] **Step 4: Build shared + typecheck backend**

Run: `cd /d/_dev/voice-mcp && npm run build:shared && npx tsc --noEmit -p packages/voice-backend/tsconfig.json`
Expected: both clean, no output. (Adding the unused `DEFAULT_LEADIN_MS`/`LEADIN_MS_*` exports is fine — nothing imports them yet.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/voice-backend/src/main/audio-device.ts
git commit -m "feat: add lead-in constants; rename DEVICE_PREF_FILE to AUDIO_CONFIG_FILE

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Shared types — AudioConfig, list fields, set_leadin command

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add `SetLeadInCommand` and extend the command union**

After the `TestDeviceCommand` line (`export interface TestDeviceCommand ...`), add:
```ts
export interface SetLeadInCommand  { cmd: "set_leadin"; ms: number; }
```
Then add `| SetLeadInCommand` to the `TcpCommand` union (after `| TestDeviceCommand`).

- [ ] **Step 2: Extend `DevicesResponse` with the new fields**

In `DevicesResponse`, add the two fields:
```ts
export interface DevicesResponse {
  ok: true;
  available: boolean;
  leadInAvailable: boolean;  // WASAPI subsystem can apply a lead-in (= available)
  leadInMs: number;          // current configured lead-in
  reason?: string;
  active: string;
  devices: DeviceInfo[];
}
```

- [ ] **Step 3: Add `AudioConfig` and extend `DeviceListResult`**

In the "Audio output device types" block, after `DevicePref`, add:
```ts
export interface AudioConfig {
  device: DevicePref | null;
  leadInMs: number;
}
```
Then extend `DeviceListResult` to match `DevicesResponse`:
```ts
export interface DeviceListResult {
  available: boolean;
  leadInAvailable: boolean;
  leadInMs: number;
  reason?: string;
  active: string;
  devices: DeviceInfo[];
}
```

- [ ] **Step 4: Build shared**

Run: `cd /d/_dev/voice-mcp && npm run build:shared`
Expected: tsc completes, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: AudioConfig type, leadIn fields on device list, set_leadin command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Config layer + pure lead-in helpers (TDD)

**Files:**
- Modify: `packages/voice-backend/src/main/audio-device.ts`
- Create: `packages/voice-backend/scripts/verify-leadin.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/voice-backend/scripts/verify-leadin.ts`:
```ts
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
// legacy device-only shape → device + default leadIn
assert.deepEqual(
  normalizeConfig({ name: "Speakers", hintDeviceId: 134 }),
  { device: { name: "Speakers", hintDeviceId: 134 }, leadInMs: 200 },
);
// new full shape survives round-trip
assert.deepEqual(
  normalizeConfig({ device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 }),
  { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 },
);
// missing leadInMs → default
assert.equal(normalizeConfig({ device: { name: "X" } }).leadInMs, 200);
// invalid leadInMs → clamped/default
assert.equal(normalizeConfig({ device: null, leadInMs: 9999 }).leadInMs, 1000);
assert.equal(normalizeConfig({ device: null, leadInMs: "x" }).leadInMs, 200);
// invalid / missing device → null
assert.equal(normalizeConfig({ leadInMs: 100 }).device, null);
assert.equal(normalizeConfig({ device: { hintDeviceId: 1 } }).device, null); // no name
assert.equal(normalizeConfig(null).device, null);
assert.equal(normalizeConfig("garbage").device, null);

console.log("leadin: ALL ASSERTIONS PASSED");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /d/_dev/voice-mcp/packages/voice-backend && npx tsx scripts/verify-leadin.ts`
Expected: FAIL — `clampLeadIn`/`leadInFrameCount`/`normalizeConfig` are not exported yet (import error or `is not a function`).

- [ ] **Step 3: Extend the import in `audio-device.ts`**

The value import currently reads `import { AUDIO_CONFIG_FILE } from "@voice-mcp/shared";` (renamed in Task 1). Replace the two import lines:
```ts
import { AUDIO_CONFIG_FILE } from "@voice-mcp/shared";
import type { DevicePref, DeviceInfo, DeviceListResult } from "@voice-mcp/shared";
```
with:
```ts
import { AUDIO_CONFIG_FILE, DEFAULT_LEADIN_MS, LEADIN_MS_MIN, LEADIN_MS_MAX } from "@voice-mcp/shared";
import type { DevicePref, DeviceInfo, DeviceListResult, AudioConfig } from "@voice-mcp/shared";
```

- [ ] **Step 4: Add the pure helpers**

Immediately after the `activeLabel` function (around line 31), add:
```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /d/_dev/voice-mcp/packages/voice-backend && npx tsx scripts/verify-leadin.ts`
Expected: `leadin: ALL ASSERTIONS PASSED`

- [ ] **Step 6: Replace the persistence + accessors**

Replace `loadPref` and `savePref` (current lines ~59–82) with the config layer:
```ts
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
```
Note: `setLeadInMs` references `invalidateDeviceCache`, which is declared later in the file — fine, it's a hoisted `function`.

- [ ] **Step 7: Add read-modify-write assertions to the test**

Append to `verify-leadin.ts`, before the final `console.log`:
```ts
// ── read-modify-write: device update preserves leadIn, and vice-versa ──
// (exercised on constructed configs via saveConfig's shape, without disk writes)
{
  const cfg = { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 300 };
  // simulate setLeadInMs keeping device:
  const afterLead = { device: cfg.device, leadInMs: clampLeadIn(150) };
  assert.deepEqual(afterLead, { device: { name: "BT", hintDeviceId: 7 }, leadInMs: 150 });
  // simulate savePref keeping leadIn:
  const afterDevice = { device: null, leadInMs: cfg.leadInMs };
  assert.deepEqual(afterDevice, { device: null, leadInMs: 300 });
}
```

- [ ] **Step 8: Run the test again**

Run: `cd /d/_dev/voice-mcp/packages/voice-backend && npx tsx scripts/verify-leadin.ts`
Expected: `leadin: ALL ASSERTIONS PASSED`

- [ ] **Step 9: Commit**

```bash
git add packages/voice-backend/src/main/audio-device.ts packages/voice-backend/scripts/verify-leadin.ts
git commit -m "feat: AudioConfig persistence + pure lead-in helpers (clamp, frameCount, normalize)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Surface leadIn in listDevices + update kill-switch test

**Files:**
- Modify: `packages/voice-backend/src/main/audio-device.ts` (`listDevices`)
- Modify: `packages/voice-backend/scripts/verify-device-killswitch.ts`

- [ ] **Step 1: Rewrite `listDevices` to read config once and include the new fields**

Replace the body of `listDevices` (the branch block) with:
```ts
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
    result = { available: true, leadInAvailable: true, leadInMs: cfg.leadInMs,
      active: activeLabel(cfg.device), devices: enumerateDevices(cfg.device) };
  }
  cachedList = result;
  cachedAt = now;
  return result;
}
```

- [ ] **Step 2: Add lead-in assertions to the kill-switch test**

In `verify-device-killswitch.ts`, inside the first `listDevices()` block (after the existing `reason` assertion), add:
```ts
  assert.equal(r.leadInAvailable, false, "leadInAvailable must be false under kill-switch");
  assert.equal(typeof r.leadInMs, "number", "leadInMs must always be a number");
```
And in the SHAPE-PARITY block, after the `available:false` assertions, add:
```ts
    assert.equal(r.leadInAvailable, false, "available:false ⇒ leadInAvailable:false");
```

- [ ] **Step 3: Typecheck + run both device tests**

Run:
```bash
cd /d/_dev/voice-mcp && npm run build:shared \
  && npx tsc --noEmit -p packages/voice-backend/tsconfig.json \
  && (cd packages/voice-backend && npx tsx scripts/verify-device-killswitch.ts && npx tsx scripts/verify-audio-device.ts && npx tsx scripts/verify-leadin.ts)
```
Expected: backend typecheck clean; all three print `ALL ASSERTIONS PASSED`.

- [ ] **Step 4: Commit**

```bash
git add packages/voice-backend/src/main/audio-device.ts packages/voice-backend/scripts/verify-device-killswitch.ts
git commit -m "feat: expose leadInMs + leadInAvailable in device list state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Prepend lead-in silence in the WASAPI player

**Files:**
- Modify: `packages/voice-backend/src/main/wasapi-player.ts`

- [ ] **Step 1: Import the helpers and declare the silent frame**

In the import from `./audio-device.js`, add `getLeadInMs` and `leadInFrameCount`:
```ts
import { loadAudify, pickDevice, savePref, isWasapiDisabled, mapOutputDevices, WASAPI_API, getLeadInMs, leadInFrameCount } from "./audio-device.js";
```
After the constant block (after `const sleep = ...`), add:
```ts
// One zeroed stereo float32 frame, reused for the lead-in. READ-ONLY: it is only ever
// passed to rt.write() (same treatment as decoded frames in the pump), never mutated.
const SILENT_FRAME = Buffer.alloc(FRAME_SIZE * CHANNELS * 4);
```

- [ ] **Step 2: Prepend lead-in frames in `play()`**

Replace:
```ts
      const stereo = await decodeAsync(filepath);
      this.frames = sliceIntoFrames(stereo, FRAME_SIZE, CHANNELS);
      this.totalFrames = this.frames.length;
```
with:
```ts
      const stereo = await decodeAsync(filepath);
      const lead = leadInFrameCount(getLeadInMs());
      this.frames = Array.from({ length: lead }, () => SILENT_FRAME)
        .concat(sliceIntoFrames(stereo, FRAME_SIZE, CHANNELS));
      this.totalFrames = this.frames.length;
```

- [ ] **Step 3: Prepend lead-in frames in `playProbe()`**

Replace:
```ts
  const frames = sliceIntoFrames(monoToInterleavedStereo(generateSine(440, 0.4, SAMPLE_RATE)), FRAME_SIZE, CHANNELS);
```
with:
```ts
  const lead = leadInFrameCount(getLeadInMs());
  const frames = Array.from({ length: lead }, () => SILENT_FRAME)
    .concat(sliceIntoFrames(monoToInterleavedStereo(generateSine(440, 0.4, SAMPLE_RATE)), FRAME_SIZE, CHANNELS));
```

- [ ] **Step 4: Typecheck**

Run: `cd /d/_dev/voice-mcp && npx tsc --noEmit -p packages/voice-backend/tsconfig.json`
Expected: clean, no output.

- [ ] **Step 5: Commit**

```bash
git add packages/voice-backend/src/main/wasapi-player.ts
git commit -m "feat: prepend tunable lead-in silence to WASAPI playback and test probe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: TCP — set_leadin handler + list passthrough

**Files:**
- Modify: `packages/voice-backend/src/main/tcp-server.ts`

- [ ] **Step 1: Import the new symbols**

Update the audio-device import and the shared-types import:
```ts
import { listDevices, setDevice, getActiveDeviceName, setLeadInMs } from "./audio-device.js";
```
Add `SetLeadInCommand` to the `@voice-mcp/shared` type import (wherever `SetDeviceCommand` is imported).

- [ ] **Step 2: Add the dispatch case**

After the `case "test_device":` block in the command switch, add:
```ts
    case "set_leadin":
      return handleSetLeadIn(command as SetLeadInCommand);
```

- [ ] **Step 3: Pass the new fields through `handleListDevices`**

Replace `handleListDevices` with:
```ts
function handleListDevices(): TcpResponse {
  const r = listDevices();
  return { ok: true, available: r.available, leadInAvailable: r.leadInAvailable,
    leadInMs: r.leadInMs, reason: r.reason, active: r.active, devices: r.devices };
}
```

- [ ] **Step 4: Add the `handleSetLeadIn` function**

After `handleTestDevice`, add:
```ts
function handleSetLeadIn(cmd: SetLeadInCommand): TcpResponse {
  const r = setLeadInMs(cmd.ms);
  broadcastState();
  return { ok: true, message: `Lead-in set to ${r.leadInMs} ms` };
}
```

- [ ] **Step 5: Typecheck**

Run: `cd /d/_dev/voice-mcp && npx tsc --noEmit -p packages/voice-backend/tsconfig.json`
Expected: clean, no output.

- [ ] **Step 6: Commit**

```bash
git add packages/voice-backend/src/main/tcp-server.ts
git commit -m "feat: TCP set_leadin handler + leadIn fields in list_devices response

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: WebSocket — set_leadin action

**Files:**
- Modify: `packages/voice-backend/src/main/web-ui.ts`

- [ ] **Step 1: Import `setLeadInMs`**

Update the audio-device import:
```ts
import { listDevices, setDevice, setLeadInMs } from "./audio-device.js";
```

- [ ] **Step 2: Add the WS action**

In `handleWsMessage`, after the `case "test_device":` block (before the closing `}` and the trailing `broadcastState()`), add:
```ts
    case "set_leadin":
      if (typeof msg.ms === "number") setLeadInMs(msg.ms);
      break;
```
(`broadcastState()` already runs at the end of `handleWsMessage`, so the dashboard refreshes.)

- [ ] **Step 3: Typecheck**

Run: `cd /d/_dev/voice-mcp && npx tsc --noEmit -p packages/voice-backend/tsconfig.json`
Expected: clean, no output.

- [ ] **Step 4: Commit**

```bash
git add packages/voice-backend/src/main/web-ui.ts
git commit -m "feat: set_leadin WebSocket action for the dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Dashboard renderer — lead-in input

**Files:**
- Modify: `packages/voice-backend/src/renderer/index.html:56-61`
- Modify: `packages/voice-backend/src/renderer/app.js`
- Modify: `packages/voice-backend/src/renderer/styles.css`

- [ ] **Step 1: Add the markup**

In `index.html`, immediately after the device-reason div (line 61, `<div id="device-reason" ...></div>`), add:
```html
      <div class="device-leadin">
        <label class="device-label" for="leadin-input">Lead-in (ms)</label>
        <input id="leadin-input" type="number" min="0" max="1000" step="20" class="agent-select" />
      </div>
      <div id="leadin-help" class="device-reason"></div>
```

- [ ] **Step 2: Add the `renderLeadIn` function**

In `app.js`, immediately after the `renderDevicePicker` function (after its closing `}` near line 440), add:
```js
function renderLeadIn() {
  const input = document.getElementById("leadin-input");
  const help = document.getElementById("leadin-help");
  const data = state.audioDevices;
  if (!input || !data) return;

  input.disabled = !data.leadInAvailable;
  if (document.activeElement !== input) input.value = data.leadInMs; // don't clobber while typing

  if (!data.leadInAvailable) {
    help.textContent = data.reason || "Lead-in unavailable";
    return;
  }
  const deviceSelected = (data.devices || []).some(d => d.active);
  help.textContent =
    "Adds silent padding before playback to prevent Bluetooth devices from clipping the first word."
    + (deviceSelected ? "" : " Only applies when a specific WASAPI device is selected.");
}
```

- [ ] **Step 3: Call it from the render loop**

In `app.js`, find the `renderDevicePicker();` call (line ~73) and add `renderLeadIn();` right after it:
```js
  renderDevicePicker();
  renderLeadIn();
```

- [ ] **Step 4: Wire the change handler**

In `app.js`, after the `btn-test-device` click listener (lines ~595-598), add:
```js
document.getElementById("leadin-input").addEventListener("change", (e) => {
  const ms = Number(e.target.value);
  if (Number.isFinite(ms)) send("set_leadin", { ms });
});
```

- [ ] **Step 5: Add minimal styling**

In `styles.css`, append:
```css
.device-leadin { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.device-leadin .agent-select { width: 90px; }
```

- [ ] **Step 6: Commit**

```bash
git add packages/voice-backend/src/renderer/index.html packages/voice-backend/src/renderer/app.js packages/voice-backend/src/renderer/styles.css
git commit -m "feat: dashboard lead-in (ms) control with capability-gated disabled state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full build, headless verification, final wiring check

**Files:** none (verification + bundle)

- [ ] **Step 1: Full build (shared + published bundle)**

Run: `cd /d/_dev/voice-mcp && npm run build:shared && npm run build:mcp`
Expected: both succeed; tsup prints `Build success`.

- [ ] **Step 2: Run the whole regression suite**

Run: `cd /d/_dev/voice-mcp/packages/voice-backend && for f in scripts/verify-pcm-utils.ts scripts/verify-audio-device.ts scripts/verify-device-killswitch.ts scripts/verify-leadin.ts; do npx tsx "$f" || break; done`
Expected: all four print `ALL ASSERTIONS PASSED`.

- [ ] **Step 3: Headless TCP round-trip for set_leadin**

Start the backend in the background: `cd /d/_dev/voice-mcp && npm run dev:backend` (wait for `Ready.`). Then run:
```bash
node -e "const n=require('net');const s=n.connect(52718,'127.0.0.1',()=>s.write(JSON.stringify({cmd:'set_leadin',ms:160})+'\n'));s.on('data',d=>{console.log('set:',d.toString().trim());s.write(JSON.stringify({cmd:'list_devices'})+'\n');s.once('data',d2=>{const r=JSON.parse(d2.toString());console.log('leadInMs:',r.leadInMs,'leadInAvailable:',r.leadInAvailable);s.end();});});"
```
Expected: `set:` shows `{"ok":true,"message":"Lead-in set to 160 ms"}`; the list shows `leadInMs: 160`. Then verify clamping: repeat with `ms:99999` → `leadInMs: 1000`; with `ms:-5` → `leadInMs: 0`. Reset to default with `ms:200`.

- [ ] **Step 4: Confirm persistence**

Run: `cat ~/.claude/voice/audio_device.json`
Expected: JSON of shape `{"device":...,"leadInMs":200}` (device may be null). Stop the background backend.

- [ ] **Step 5: Update CLAUDE.md gotcha (local only — do NOT commit)**

Append a note to the WASAPI gotcha in `CLAUDE.md` that selected-device playback prepends a tunable lead-in silence (`leadInMs`, default 200 ms, dashboard-set, persisted in `audio_device.json`) to avoid Bluetooth cold-start clipping. CLAUDE.md is untracked — leave it unstaged.

- [ ] **Step 6: Final state check**

Run: `git status --short && git log --oneline -10`
Expected: feature commits present (Tasks 1-8); working tree holds only the known unrelated leftovers (`voice-pool.ts`, `CLAUDE.md`, `.claude/skills/`, `docs/wasapi-migration-report.html`).

---

## Manual hardware acceptance (user-in-loop, after Task 9)

Not a code task — performed with real Bluetooth hardware:

1. `npm run dev:backend`; open `http://localhost:52719`.
2. Select a Bluetooth output device; confirm the **Lead-in (ms)** input is enabled and shows `200`.
3. Let the BT link idle a few seconds, then trigger a `voice_speak` → the first word is **not** clipped.
4. Set lead-in to `0`, idle, speak again → confirm the first-word clip returns (proves the lead-in is what fixes it).
5. Set lead-in to `400`; confirm a longer silent pad and clean first word.
6. Switch output to **System default** → the input greys/disables only if WASAPI is unavailable; otherwise stays editable with the "only applies when a specific WASAPI device is selected" hint.
7. Restart the backend → the lead-in value persists.
8. Click **Test** on the selected device → the tone is preceded by the lead-in (no clipped tone onset).
