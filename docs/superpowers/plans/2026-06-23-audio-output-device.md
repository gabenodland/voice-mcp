# Configurable Audio Output Device (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Windows user choose which audio output device Voice MCP speaks through, via a dashboard dropdown and a `voice_devices` MCP tool, with MCI as the always-safe default.

**Architecture:** Add a second Windows playback engine — in-process WASAPI via the prebuilt `audify` native module (RtAudio binding, shared mode) + the `mpg123-decoder` WASM decoder — behind the existing `AudioPlayerBackend` interface. MCI stays the default; WASAPI is used only when a specific device is selected, and any WASAPI failure transparently falls back to MCI. A new `audio-device.ts` owns enumeration/persistence/resolution; a new `wasapi-player.ts` is the engine.

**Tech Stack:** TypeScript, Node ESM, npm workspaces, tsup/esbuild bundling, `audify` (RtAudio/WASAPI), `mpg123-decoder` (WASM), `koffi` (existing MCI), `node-edge-tts`, Express + `ws` dashboard.

**Source of truth:** `docs/superpowers/specs/2026-06-23-audio-output-device-design.md`.

### Testing model (read first)

This repo has **no test runner** and CLAUDE.md says *don't invent `npm test`*. Verification in this plan uses three honest mechanisms:

1. **Pure-logic units** (`pcm-utils.ts`, `audio-device.ts` matching/persistence) → standalone assertion scripts under `packages/voice-backend/scripts/` run with `npx tsx` + `node:assert/strict`. These give real red→green. `tsx` is already a devDependency.
2. **Audio/hardware behavior** (enumeration, playback, pause/resume audibility, sample-rate) → the Phase‑0 **spike** script (Task 2) + manual observation, with `play()` resolution instrumented so once-only criteria are *counted*, not judged by ear.
3. **Build/integration** → `npm run build:shared`, `npm run build`, and running the backend with `npm run dev:backend`.

`.js` import specifiers resolve to `.ts` sources under `tsx`/the existing build (the codebase uses NodeNext-style `.js` specifiers everywhere).

---

## Task 1: Branch + native dependencies + packaging wiring

**Files:**
- Modify: `packages/mcp-server/package.json`
- Modify: `packages/voice-backend/package.json`
- Modify: `packages/mcp-server/tsup.config.ts`

- [ ] **Step 1: Create the feature branch**

We are on `master`, which already has unrelated uncommitted work (a voice-pool cleanup, a version bump, lockfile churn). Branch so feature commits are isolated; that pre-existing work rides along in the working tree but is never staged by this plan's commits (each commit stages explicit paths only).

```bash
git checkout -b feat/audio-output-device
```

- [ ] **Step 2: Install the native + decoder dependencies**

`audify` ships prebuilt N-API binaries; `mpg123-decoder` is WASM. Install into **both** workspaces that reference them — `mcp-server` ships them, and `voice-backend` statically `import`s `mpg123-decoder` (so its strict `tsc` build needs the dep declared, not just hoisted).

```bash
npm install audify mpg123-decoder --workspace packages/mcp-server --workspace packages/voice-backend --save-optional
```

Expected: both land under `optionalDependencies` in `packages/mcp-server/package.json` **and** `packages/voice-backend/package.json`, and `node_modules/audify/` contains a `prebuilds/` (or `build/Release/*.node`) directory.

- [ ] **Step 3: Verify audify loads on this machine**

```bash
node -e "const {RtAudio,RtAudioApi}=require('audify'); const rt=new RtAudio(RtAudioApi.WINDOWS_WASAPI); console.log('devices:', rt.getDevices().filter(d=>d.outputChannels>0).map(d=>d.name));"
```

Expected: prints an array of output device names. If it throws `Cannot find module`/load error, stop — the rest of the WASAPI path can't be built/tested here (the shipped product still degrades to MCI, but local dev needs this working).

- [ ] **Step 4: Confirm `optionalDependencies` in package.json**

Both `packages/mcp-server/package.json` and `packages/voice-backend/package.json` must contain (use whatever npm resolves — at time of writing audify 1.10.1, mpg123-decoder 1.0.3):

```json
  "optionalDependencies": {
    "audify": "^1.10.1",
    "mpg123-decoder": "^1.0.3"
  }
```

- [ ] **Step 5: Mark both native deps `external` in tsup**

esbuild cannot inline a `.node` binary. `koffi` works today purely by auto-externalization, but optional deps may be absent at build time, so list them explicitly as insurance.

Replace `packages/mcp-server/tsup.config.ts` with:

```ts
import { defineConfig } from "tsup";
import path from "path";

export default defineConfig({
  entry: ["src/index.ts", "src/backend-entry.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  external: ["audify", "mpg123-decoder", "koffi"],
  esbuildOptions(options) {
    options.alias = {
      "@voice-mcp/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    };
  },
});
```

- [ ] **Step 6: Verify the build still succeeds**

Run: `npm run build`
Expected: completes with no "No loader is configured for .node" error; `packages/mcp-server/dist/` contains `index.js`, `backend-entry.js`, `renderer/`.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/package.json packages/voice-backend/package.json packages/mcp-server/tsup.config.ts package-lock.json
git commit -m "build: add audify + mpg123-decoder as optional deps, mark external"
```

---

## Task 2: Phase-0 spike (throwaway — proves the unknowns)

**Files:**
- Create: `packages/voice-backend/scripts/spike-wasapi.ts`
- Create: `docs/superpowers/plans/SPIKE-FINDINGS.md`

This is **throwaway** code whose only job is to de-risk the engine and record concrete numbers (`frameSize`, look-ahead `N`, the completion signal) plus pass the pause/resume hard gate **before** any real engine code is written. The spike synthesizes its own MP3 via `node-edge-tts` (already a dependency).

- [ ] **Step 1: Write the spike script**

```ts
// packages/voice-backend/scripts/spike-wasapi.ts
// Throwaway. Run: npx tsx packages/voice-backend/scripts/spike-wasapi.ts
import { MPEGDecoder } from "mpg123-decoder";
import { EdgeTTS } from "node-edge-tts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// audify is CommonJS; named exports are not detectable from ESM — load via require().
const require = createRequire(import.meta.url);
const { RtAudio, RtAudioApi, RtAudioFormat } = require("audify");

const FRAME_SIZE = 480;       // ~20ms @ 24kHz — confirm/adjust
const LOOKAHEAD = 4;          // bounded look-ahead in frames — confirm/adjust
const SR = 24000;
const CH = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function monoToStereo(mono: Float32Array): Float32Array {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) { out[2 * i] = mono[i]; out[2 * i + 1] = mono[i]; }
  return out;
}
function sliceFrames(inter: Float32Array): Buffer[] {
  const per = FRAME_SIZE * CH, frames: Buffer[] = [];
  for (let o = 0; o < inter.length; o += per) {
    const s = inter.subarray(o, Math.min(o + per, inter.length));
    if (s.length === per) frames.push(Buffer.from(s.buffer, s.byteOffset, s.byteLength));
    else { const p = new Float32Array(per); p.set(s); frames.push(Buffer.from(p.buffer)); }
  }
  return frames;
}

async function main() {
  const rt = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
  const devices = rt.getDevices().filter((d) => d.outputChannels > 0);
  console.log("OUTPUT DEVICES:");
  devices.forEach((d) => console.log(`  id=${d.id} default=${d.isDefaultOutput} "${d.name}"`));

  // Pick the device named on the command line (substring), else first non-default, else default.
  const want = (process.argv[2] ?? "").toLowerCase();
  const target = (want ? devices.find((d) => d.name.toLowerCase().includes(want)) : undefined)
    ?? devices.find((d) => !d.isDefaultOutput) ?? devices[0];
  console.log(`\nTARGET: id=${target.id} "${target.name}"\n`);

  // Synthesize a test clip.
  const mp3 = path.join(os.tmpdir(), "voice_spike.mp3");
  await new EdgeTTS({ voice: "en-US-AriaNeural", rate: "+0%", pitch: "+0Hz" })
    .ttsPromise("Testing one two three. The quick brown fox.", mp3);

  const decoder = new MPEGDecoder();
  await decoder.ready;
  const { channelData, sampleRate } = decoder.decode(new Uint8Array(fs.readFileSync(mp3)));
  decoder.free();
  console.log(`decoded: sampleRate=${sampleRate} channels=${channelData.length} samples=${channelData[0].length}`);

  const stereo = monoToStereo(channelData[0]);
  const frames = sliceFrames(stereo);
  const total = frames.length;

  let audible = 0, resolveCount = 0;
  rt.openStream(
    { deviceId: target.id, nChannels: CH, firstChannel: 0 },
    null,
    RtAudioFormat.RTAUDIO_FLOAT32,
    SR,
    FRAME_SIZE,
    "Voice MCP",
    null,
    () => { audible++; },
  );
  rt.start();

  let writeCursor = 0, paused = false, stopped = false;
  const done = new Promise<void>((resolve) => {
    (async () => {
      // Programmatic pause/resume to exercise the hard gate.
      setTimeout(() => { console.log("[pause]"); rt.clearOutputQueue(); rt.stop(); writeCursor = audible; paused = true; }, 800);
      setTimeout(() => { console.log("[resume]"); rt.start(); paused = false; }, 1800);

      while (!stopped) {
        if (paused) { await sleep(20); continue; }
        while (!paused && writeCursor < total && (writeCursor - audible) < LOOKAHEAD) {
          rt.write(frames[writeCursor]); writeCursor++;
        }
        if (writeCursor >= total && audible >= total) break;
        await sleep(10);
      }
      resolveCount++;
      try { rt.clearOutputQueue(); rt.closeStream(); } catch {}
      resolve();
    })();
  });

  await done;
  console.log(`\nRESULT: audibleFrames=${audible}/${total} play resolved ${resolveCount} time(s)`);
  console.log("LISTEN: did it (1) play centered in BOTH ears, (2) at correct pitch/speed, (3) pause then resume mid-phrase without skipping?");
  process.exit(0); // audify's native callback keeps the event loop alive; force a clean exit
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the spike and observe**

Run: `npx tsx packages/voice-backend/scripts/spike-wasapi.ts`
Expected: device list prints; audio plays through the target device; you hear a brief pause ~0.8s in, then resume; final line reports `play resolved 1 time(s)` and `audibleFrames` reaching total.

- [ ] **Step 3: Record findings**

Create `docs/superpowers/plans/SPIKE-FINDINGS.md` and fill in real observations:

```markdown
# Spike findings — audio output device

- audify loaded: YES/NO
- Centered (both ears): YES/NO  (if NO, mono→stereo duplication is wrong)
- Correct pitch/speed at 24kHz on this endpoint: YES/NO  (if NO → JS resample to device preferredSampleRate)
- frameOutputCallback granularity: fires once per write() buffer? YES/NO
- Final frameSize used: <e.g. 480>
- Final look-ahead N used: <e.g. 4>
- Completion signal that worked: audibleFrames >= total / streamTime / other
- Pause/resume gate: prompt stop YES/NO, resumes same phrase YES/NO, resolved exactly once YES/NO
- Any deviations from the provisional constants: <notes>
```

If the spike forced different `frameSize`/`N`/completion mechanics, **use those values** in Task 8 wherever the provisional `FRAME_SIZE = 480` / `LOOKAHEAD_FRAMES = 4` appear.

- [ ] **Step 4: Commit the findings (script is throwaway but kept for reference)**

```bash
git add packages/voice-backend/scripts/spike-wasapi.ts docs/superpowers/plans/SPIKE-FINDINGS.md
git commit -m "spike: prove WASAPI device playback + pause/resume gate, record findings"
```

---

## Task 3: Constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add the device constants**

Append to `packages/shared/src/constants.ts`:

```ts
export const DEFAULT_AUDIO_DEVICE = "default"; // "default" = system default endpoint → MCI
export const DEVICE_PREF_FILE = path.join(DATA_DIR, "audio_device.json");
```

(`path` and `DATA_DIR` are already imported/defined in this file.)

- [ ] **Step 2: Rebuild shared so consumers see the new exports**

Run: `npm run build:shared`
Expected: completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat: add audio device constants (DEFAULT_AUDIO_DEVICE, DEVICE_PREF_FILE)"
```

---

## Task 4: Shared types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add device data types**

Append to `packages/shared/src/types.ts`:

```ts
// ── Audio output device types ──────────────────────────────────────────
export interface DevicePref {
  name: string;          // stable selector; "default" or absent = system default → MCI
  hintDeviceId?: number; // best-effort cache of the RtAudio id; revalidated against name
}

export interface DeviceInfo {
  id: number;        // current audify/RtAudio device id (opaque, instance-scoped; 0 = invalid)
  name: string;      // stable selector
  isDefault: boolean;
  active: boolean;   // matches the persisted selection
}

export interface DeviceListResult {
  available: boolean;     // false when audify can't load or WASAPI is disabled
  reason?: string;        // why unavailable
  active: string;         // "System default" or the selected device name
  devices: DeviceInfo[];  // output endpoints (empty when unavailable)
}
```

- [ ] **Step 2: Add the TCP command types and extend the union**

In the same file, add the three command interfaces near the other `*Command` interfaces:

```ts
export interface ListDevicesCommand { cmd: "list_devices"; }
export interface SetDeviceCommand   { cmd: "set_device"; name: string; }   // name or "default"
export interface TestDeviceCommand  { cmd: "test_device"; name: string; }
```

Extend the `TcpCommand` union to include them:

```ts
export type TcpCommand =
  | SpeakCommand
  | StatusCommand
  | AgentsCommand
  | RegisterAgentCommand
  | SetVoiceCommand
  | PauseCommand
  | ResumeCommand
  | ReplayCommand
  | MuteCommand
  | UnmuteCommand
  | TestVoiceCommand
  | ReplayItemCommand
  | ListDevicesCommand
  | SetDeviceCommand
  | TestDeviceCommand;
```

- [ ] **Step 3: Add the devices response and extend the response union + status**

```ts
export interface DevicesResponse {
  ok: true;
  available: boolean;
  reason?: string;
  active: string;
  devices: DeviceInfo[];
}
```

Add `DevicesResponse` to the `TcpResponse` union, and add an optional `activeDevice` field to `StatusResponse`:

```ts
export interface StatusResponse {
  ok: true;
  state: string;
  agent: string | null;
  text: string | null;
  muted: boolean;
  queue_size: number;
  activeDevice?: string;   // "System default" or device name
}
```

```ts
export type TcpResponse =
  | OkResponse
  | SpeakResponse
  | StatusResponse
  | AgentsResponse
  | DevicesResponse
  | ErrorResponse;
```

- [ ] **Step 4: Rebuild shared**

Run: `npm run build:shared`
Expected: completes with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add device TCP commands, DeviceInfo/DevicePref/DeviceListResult types"
```

---

## Task 5: Pure PCM helpers (`pcm-utils.ts`) — TDD

**Files:**
- Create: `packages/voice-backend/src/main/pcm-utils.ts`
- Test: `packages/voice-backend/scripts/verify-pcm-utils.ts`

These are pure, hardware-free functions, so they get real assertion-based red→green.

- [ ] **Step 1: Write the failing test**

```ts
// packages/voice-backend/scripts/verify-pcm-utils.ts
import assert from "node:assert/strict";
import {
  monoToInterleavedStereo,
  interleaveChannels,
  sliceIntoFrames,
  generateSine,
} from "../src/main/pcm-utils.js";

// mono → interleaved stereo duplicates each sample
{
  const out = monoToInterleavedStereo(Float32Array.from([0.1, -0.2, 0.3]));
  assert.deepEqual(Array.from(out), [0.1, 0.1, -0.2, -0.2, 0.3, 0.3].map((n) => Math.fround(n)));
}

// interleaveChannels(L,R) → L0,R0,L1,R1
{
  const out = interleaveChannels([Float32Array.from([1, 2]), Float32Array.from([3, 4])]);
  assert.deepEqual(Array.from(out), [1, 3, 2, 4]);
}

// sliceIntoFrames: stereo (2ch), frameSize 2 → each chunk = 2 frames = 4 samples; last chunk zero-padded
{
  const inter = Float32Array.from([1, 1, 2, 2, 3, 3]); // 3 frames of stereo
  const chunks = sliceIntoFrames(inter, 2, 2);
  assert.equal(chunks.length, 2);                 // 3 frames / 2 per chunk = 2 chunks
  assert.equal(chunks[0].byteLength, 2 * 2 * 4);  // frameSize*channels*Float32
  assert.equal(chunks[1].byteLength, 2 * 2 * 4);  // padded to full frame buffer
  const tail = new Float32Array(chunks[1].buffer, chunks[1].byteOffset, 4);
  assert.deepEqual(Array.from(tail), [3, 3, 0, 0]); // last real frame then silence pad
}

// generateSine: correct length, in [-1,1], starts at 0
{
  const t = generateSine(440, 0.01, 24000); // 10ms
  assert.equal(t.length, 240);
  assert.ok(t.every((v) => v >= -1 && v <= 1));
  assert.equal(t[0], 0);
}

console.log("pcm-utils: ALL ASSERTIONS PASSED");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx packages/voice-backend/scripts/verify-pcm-utils.ts`
Expected: FAIL — cannot resolve `../src/main/pcm-utils.js` (module not created yet).

- [ ] **Step 3: Write the implementation**

```ts
// packages/voice-backend/src/main/pcm-utils.ts

/** Duplicate a mono Float32 buffer into interleaved stereo (L=R). */
export function monoToInterleavedStereo(mono: Float32Array): Float32Array {
  const out = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[2 * i] = mono[i];
    out[2 * i + 1] = mono[i];
  }
  return out;
}

/** Interleave planar per-channel Float32 buffers into one interleaved buffer. */
export function interleaveChannels(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const frames = channels[0].length;
  const ch = channels.length;
  const out = new Float32Array(frames * ch);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) out[i * ch + c] = channels[c][i];
  }
  return out;
}

/**
 * Slice an interleaved buffer into fixed `frameSize`-frame Buffers (frameSize =
 * frames across all channels). The final partial frame is zero-padded to a full
 * buffer so audify always receives uniform frame-sized writes.
 */
export function sliceIntoFrames(interleaved: Float32Array, frameSize: number, channels: number): Buffer[] {
  const per = frameSize * channels;
  const chunks: Buffer[] = [];
  for (let off = 0; off < interleaved.length; off += per) {
    const end = Math.min(off + per, interleaved.length);
    const slice = interleaved.subarray(off, end);
    if (slice.length === per) {
      chunks.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
    } else {
      const padded = new Float32Array(per);
      padded.set(slice);
      chunks.push(Buffer.from(padded.buffer));
    }
  }
  return chunks;
}

/** Generate a mono sine tone (Float32, starts at 0) for the device-test probe. */
export function generateSine(freq: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.25 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx packages/voice-backend/scripts/verify-pcm-utils.ts`
Expected: PASS — prints `pcm-utils: ALL ASSERTIONS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/voice-backend/src/main/pcm-utils.ts packages/voice-backend/scripts/verify-pcm-utils.ts
git commit -m "feat: pure PCM helpers (mono->stereo, interleave, frame slicing, sine)"
```

---
## Task 6: Refactor — extract `player-types.ts` and `mci-player.ts`

**Files:**
- Create: `packages/voice-backend/src/main/player-types.ts`
- Create: `packages/voice-backend/src/main/mci-player.ts`
- Modify: `packages/voice-backend/src/main/audio-player.ts`

The WASAPI engine needs to import `WindowsMCIPlayer` (for transparent fallback) and the `AudioPlayerBackend` interface. Extract them to avoid a circular import (`audio-player → wasapi-player → mci-player`, with `audio-player` also importing `mci-player`). This is a pure move — **no behavior change**.

- [ ] **Step 1: Create `player-types.ts`**

```ts
// packages/voice-backend/src/main/player-types.ts
export type PlayerState = "stopped" | "playing" | "paused";

export interface AudioPlayerBackend {
  play(filepath: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: PlayerState;
}
```

- [ ] **Step 2: Create `mci-player.ts`**

Move the entire `WindowsMCIPlayer` class verbatim out of `audio-player.ts` into this file, adding the imports and an `export`:

```ts
// packages/voice-backend/src/main/mci-player.ts
import path from "node:path";
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";

// ── Windows: winmm.dll MCI via koffi ──────────────────────────────────
export class WindowsMCIPlayer implements AudioPlayerBackend {
  private _state: PlayerState = "stopped";
  private alias = `voice_${Date.now()}`;
  private mciSendString: ((cmd: string, ret: Buffer, retLen: number, hwnd: null) => number) | null = null;

  get state() { return this._state; }

  private async loadKoffi() {
    if (this.mciSendString) return;
    try {
      const koffi = (await import("koffi")).default;
      const winmm = koffi.load("winmm.dll");
      this.mciSendString = winmm.func(
        "uint32 __stdcall mciSendStringW(str16, str16, uint32, void*)"
      ) as any;
    } catch (err) {
      console.error("voice-mcp-backend: Failed to load koffi/winmm:", err);
      throw err;
    }
  }

  private mci(command: string): string {
    if (!this.mciSendString) throw new Error("MCI not initialized");
    const retBuf = Buffer.alloc(512);
    this.mciSendString(command, retBuf, 256, null);
    return retBuf.toString("utf16le").replace(/\0+$/, "");
  }

  async play(filepath: string): Promise<void> {
    await this.loadKoffi();
    const absPath = path.resolve(filepath).replace(/\\/g, "/");
    this.mci(`open "${absPath}" type mpegvideo alias ${this.alias}`);
    this.mci(`play ${this.alias}`);
    this._state = "playing";

    return new Promise<void>((resolve) => {
      const check = () => {
        if (this._state === "stopped") { resolve(); return; }
        if (this._state === "paused") { setTimeout(check, 200); return; }
        try {
          const mode = this.mci(`status ${this.alias} mode`);
          if (mode === "stopped" || mode === "") { this.cleanup(); resolve(); }
          else { setTimeout(check, 100); }
        } catch { this.cleanup(); resolve(); }
      };
      setTimeout(check, 100);
    });
  }

  pause(): void {
    if (this._state !== "playing") return;
    try { this.mci(`pause ${this.alias}`); } catch { /* ignore */ }
    this._state = "paused";
  }

  resume(): void {
    if (this._state !== "paused") return;
    try { this.mci(`resume ${this.alias}`); } catch { /* ignore */ }
    this._state = "playing";
  }

  stop(): void { this.cleanup(); }

  private cleanup(): void {
    try { this.mci(`stop ${this.alias}`); } catch { /* ignore */ }
    try { this.mci(`close ${this.alias}`); } catch { /* ignore */ }
    this._state = "stopped";
  }
}
```

- [ ] **Step 3: Update `audio-player.ts` to import the moved pieces**

In `audio-player.ts`: delete the local `PlayerState` type, the local `AudioPlayerBackend` interface, and the entire `WindowsMCIPlayer` class. Add at the top:

```ts
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";
import { WindowsMCIPlayer } from "./mci-player.js";
```

Leave `createPlayer()`, `MacAfplayPlayer`, `LinuxPlayer`, and the module-level player-state functions unchanged for now. `createPlayer()` still reads:

```ts
function createPlayer(): AudioPlayerBackend {
  if (process.platform === "win32") {
    return new WindowsMCIPlayer();
  } else if (process.platform === "darwin") {
    return new MacAfplayPlayer();
  } else {
    return new LinuxPlayer();
  }
}
```

- [ ] **Step 4: Verify the build and a smoke playback**

Run: `npm run build`
Expected: succeeds.

Run (Windows, with no device preference set): `npm run dev:backend` then trigger a `voice_speak` (or run the existing flow) and confirm audio still plays via MCI exactly as before. Stop the backend when done.

- [ ] **Step 5: Commit**

```bash
git add packages/voice-backend/src/main/player-types.ts packages/voice-backend/src/main/mci-player.ts packages/voice-backend/src/main/audio-player.ts
git commit -m "refactor: extract AudioPlayerBackend interface and WindowsMCIPlayer"
```

---

## Task 7: `audio-device.ts` — enumeration, persistence, resolution — TDD for pure parts

**Files:**
- Create: `packages/voice-backend/src/main/audio-device.ts`
- Test: `packages/voice-backend/scripts/verify-audio-device.ts`

audify is loaded **synchronously** via `createRequire` so `listDevices()`/`setDevice()` are sync — this keeps the backend's `dispatch()` synchronous (Task 10). The pure `pickDevice` and persistence functions are unit-tested; enumeration is exercised by the spike + manual runs.

> **Intentional deviation from spec §9:** §9 describes loading the native module via dynamic `import()` "like `loadKoffi()`". Here we use a synchronous `createRequire(import.meta.url)` + `require("audify")` instead, specifically so `listDevices()`/`setDevice()`/`getConfiguredDevice()` stay synchronous and `dispatch()` doesn't have to become async. The bundled output is ESM with a working `import.meta.url` (proven by `backend-entry.ts`), so no tsup banner is needed.

- [ ] **Step 1: Write the failing test (pure logic only)**

```ts
// packages/voice-backend/scripts/verify-audio-device.ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx packages/voice-backend/scripts/verify-audio-device.ts`
Expected: FAIL — cannot resolve `../src/main/audio-device.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/voice-backend/src/main/audio-device.ts
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

const WASAPI_API = 7; // RtAudioApi.WINDOWS_WASAPI fallback if the enum isn't a runtime value

export function isWasapiDisabled(): boolean {
  return (process.env.VOICE_AUDIO_BACKEND ?? "").toLowerCase() === "mci";
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

/** Enumerate output devices on a fresh RtAudio instance. Returns [] if unavailable. */
export function enumerateDevices(): DeviceInfo[] {
  const mod = loadAudify();
  if (!mod) return [];
  try {
    const api = mod.RtAudioApi?.WINDOWS_WASAPI ?? WASAPI_API;
    const rt = new mod.RtAudio(api);
    const pref = loadPref();
    return rt.getDevices()
      .filter((d: any) => d.outputChannels > 0)
      .map((d: any): DeviceInfo => ({
        id: d.id,
        name: d.name,
        isDefault: !!d.isDefaultOutput,
        active: !!pref && pref.name === d.name,
      }));
  } catch (err) {
    console.error("voice-mcp-backend: device enumeration failed:", err);
    return [];
  }
}

// Cache enumeration so the 250ms dashboard broadcast (Task 11) and per-status
// calls (Task 10) don't re-instantiate native RtAudio 4x/second. Invalidated on
// setDevice(); short TTL otherwise.
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
    const devices = enumerateDevices();
    const pref = loadPref();
    const active = pref?.name && pref.name !== "default" ? pref.name : "System default";
    result = { available: true, active, devices };
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx packages/voice-backend/scripts/verify-audio-device.ts`
Expected: PASS — prints `audio-device: ALL ASSERTIONS PASSED`.

- [ ] **Step 5: Manually verify enumeration end-to-end**

Run: `npx tsx -e "import('./packages/voice-backend/src/main/audio-device.js').then(m=>console.log(JSON.stringify(m.listDevices(),null,2)))"`
Expected: `available: true` and a populated `devices` array on a machine where audify loaded (Task 1 Step 3).

- [ ] **Step 6: Commit**

```bash
git add packages/voice-backend/src/main/audio-device.ts packages/voice-backend/scripts/verify-audio-device.ts
git commit -m "feat: audio-device enumeration, persistence, and name resolution"
```

---

## Task 8: `wasapi-player.ts` — the engine + device-test probe

**Files:**
- Create: `packages/voice-backend/src/main/wasapi-player.ts`

> Use the **spike-confirmed** `FRAME_SIZE`, `LOOKAHEAD_FRAMES`, and completion signal from `docs/superpowers/plans/SPIKE-FINDINGS.md`. The values below are the provisional defaults; replace them if the spike found otherwise. If the spike found 24 kHz did **not** play at correct pitch, add a JS resample step to the device `preferredSampleRate` before `sliceIntoFrames` (note it here and in SPIKE-FINDINGS).
>
> Note: `resume()` restarts the still-open stream via `rt.start()` (pause did `clearOutputQueue()` + `stop()` but kept the stream open) — it is not a full close/reopen. This is the spike-validated reading of spec §6.3's "reopen" and avoids a needless device round-trip.

- [ ] **Step 1: Write the engine**

```ts
// packages/voice-backend/src/main/wasapi-player.ts
import fs from "node:fs";
import { MPEGDecoder } from "mpg123-decoder";
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";
import type { DevicePref } from "@voice-mcp/shared";
import { WindowsMCIPlayer } from "./mci-player.js";
import { loadAudify, pickDevice, savePref, isWasapiDisabled } from "./audio-device.js";
import { monoToInterleavedStereo, interleaveChannels, sliceIntoFrames, generateSine } from "./pcm-utils.js";

const WASAPI_API = 7;        // RtAudioApi.WINDOWS_WASAPI
const FORMAT_FLOAT32 = 0x10; // RtAudioFormat.RTAUDIO_FLOAT32
const FRAME_SIZE = 480;      // ~20ms @ 24kHz — confirm via spike
const LOOKAHEAD_FRAMES = 4;  // bounded look-ahead — confirm via spike
const SAMPLE_RATE = 24000;
const CHANNELS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeToInterleavedStereo(filepath: string): Float32Array {
  const decoder = new MPEGDecoder();
  // decoder.ready is a promise; we resolve it synchronously-enough by blocking the
  // caller (play() is async). See openAndPlay below — we await ready there.
  throw new Error("use decodeAsync"); // placeholder guard; real path is async (below)
}

async function decodeAsync(filepath: string): Promise<Float32Array> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const { channelData } = decoder.decode(new Uint8Array(fs.readFileSync(filepath)));
  decoder.free();
  return channelData.length >= 2 ? interleaveChannels(channelData) : monoToInterleavedStereo(channelData[0]);
}

export class WindowsWasapiPlayer implements AudioPlayerBackend {
  private _state: PlayerState = "stopped";
  private rt: any = null;
  private fallback: AudioPlayerBackend | null = null;
  private frames: Buffer[] = [];
  private totalFrames = 0;
  private audibleFrames = 0;
  private writeCursor = 0;
  private stopped = false;
  private paused = false;
  private resolvePlay: (() => void) | null = null;

  constructor(private pref: DevicePref) {}

  get state(): PlayerState {
    return this.fallback ? this.fallback.state : this._state;
  }

  async play(filepath: string): Promise<void> {
    try {
      const mod = loadAudify();
      if (!mod) throw new Error("audify unavailable");

      // Resolve the device on the SAME instance we will openStream on.
      const rt = new mod.RtAudio(mod.RtAudioApi?.WINDOWS_WASAPI ?? WASAPI_API);
      const devices = rt.getDevices()
        .filter((d: any) => d.outputChannels > 0)
        .map((d: any) => ({ id: d.id, name: d.name, isDefault: !!d.isDefaultOutput, active: false }));
      const chosen = pickDevice(devices, this.pref);
      if (!chosen) throw new Error(`device not found: ${this.pref.name}`);
      if (chosen.id !== this.pref.hintDeviceId) savePref({ name: chosen.name, hintDeviceId: chosen.id });

      const stereo = await decodeAsync(filepath);
      this.frames = sliceIntoFrames(stereo, FRAME_SIZE, CHANNELS);
      this.totalFrames = this.frames.length;
      this.audibleFrames = 0;
      this.writeCursor = 0;
      this.stopped = false;
      this.paused = false;

      this.rt = rt;
      rt.openStream(
        { deviceId: chosen.id, nChannels: CHANNELS, firstChannel: 0 },
        null,
        mod.RtAudioFormat?.RTAUDIO_FLOAT32 ?? FORMAT_FLOAT32,
        SAMPLE_RATE,
        FRAME_SIZE,
        "Voice MCP",
        null,
        () => { this.audibleFrames++; },
      );
      rt.start();
      this._state = "playing";

      await new Promise<void>((resolve) => {
        this.resolvePlay = resolve;
        void this.pump();
      });
    } catch (err) {
      console.error("voice-mcp-backend: WASAPI play failed, falling back to MCI:", err);
      this.cleanupStream();
      this.fallback = new WindowsMCIPlayer();
      await this.fallback.play(filepath);
    }
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopped) {
        if (this.paused) { await sleep(20); continue; }
        while (!this.paused && !this.stopped && this.rt
               && this.writeCursor < this.totalFrames
               && (this.writeCursor - this.audibleFrames) < LOOKAHEAD_FRAMES) {
          this.rt.write(this.frames[this.writeCursor]);
          this.writeCursor++;
        }
        if (this.writeCursor >= this.totalFrames && this.audibleFrames >= this.totalFrames) break;
        await sleep(10);
      }
    } catch (err) {
      // A native write/stream error must still settle play(), or the awaited
      // play() never resolves and the playback queue deadlocks.
      console.error("voice-mcp-backend: WASAPI pump error:", err);
    } finally {
      this.settle();
    }
  }

  /** Idempotent: cleans up, resolves the pending play() exactly once. */
  private settle(): void {
    this.cleanupStream();
    this._state = "stopped";
    const r = this.resolvePlay;
    this.resolvePlay = null;
    if (r) r();
  }

  pause(): void {
    if (this.fallback) { this.fallback.pause(); return; }
    if (this._state !== "playing" || !this.rt) return;
    try { this.rt.clearOutputQueue(); this.rt.stop(); } catch { /* ignore */ }
    this.writeCursor = this.audibleFrames; // rewind to the AUDIBLE cursor
    this.paused = true;
    this._state = "paused";
  }

  resume(): void {
    if (this.fallback) { this.fallback.resume(); return; }
    if (this._state !== "paused" || !this.rt) return;
    try { this.rt.start(); } catch { /* ignore */ }
    this.paused = false;
    this._state = "playing";
  }

  stop(): void {
    if (this.fallback) { this.fallback.stop(); return; }
    this.stopped = true;
    this.settle();
  }

  private cleanupStream(): void {
    if (!this.rt) return;
    try {
      if (typeof this.rt.isStreamOpen === "function" ? this.rt.isStreamOpen() : true) {
        // Spec §6.3 order: discard the queue, stop, then close (stop() drains, so
        // clearOutputQueue() must precede it for immediate silence on stop/mute).
        this.rt.clearOutputQueue();
        this.rt.stop();
        this.rt.closeStream();
      }
    } catch { /* ignore */ }
    this.rt = null;
  }
}

/**
 * Device-test probe: play a short tone through a device WITHOUT touching the
 * queue/history. Independent transient stream; fire-and-forget from the caller.
 */
export async function playProbe(deviceName: string): Promise<void> {
  if (isWasapiDisabled()) return; // honor the kill-switch on every path, not just the UI
  const mod = loadAudify();
  if (!mod) return;
  const rt = new mod.RtAudio(mod.RtAudioApi?.WINDOWS_WASAPI ?? WASAPI_API);
  const devices = rt.getDevices()
    .filter((d: any) => d.outputChannels > 0)
    .map((d: any) => ({ id: d.id, name: d.name, isDefault: !!d.isDefaultOutput, active: false }));
  const chosen = pickDevice(devices, { name: deviceName });
  if (!chosen) return;

  const frames = sliceIntoFrames(monoToInterleavedStereo(generateSine(440, 0.4, SAMPLE_RATE)), FRAME_SIZE, CHANNELS);
  let audible = 0;
  rt.openStream(
    { deviceId: chosen.id, nChannels: CHANNELS, firstChannel: 0 },
    null,
    mod.RtAudioFormat?.RTAUDIO_FLOAT32 ?? FORMAT_FLOAT32,
    SAMPLE_RATE,
    FRAME_SIZE,
    "Voice MCP",
    null,
    () => { audible++; },
  );
  rt.start();
  for (const f of frames) rt.write(f);
  const deadline = Date.now() + 3000;
  while (audible < frames.length && Date.now() < deadline) await sleep(10);
  try { rt.clearOutputQueue(); rt.stop(); rt.closeStream(); } catch { /* ignore */ }
}
```

- [ ] **Step 2: Remove the placeholder guard**

Delete the unused `decodeToInterleavedStereo` function entirely (it exists only to make the danger explicit during writing — the real path is `decodeAsync`). The file must not contain a `throw new Error("use decodeAsync")`.

- [ ] **Step 3: Verify it builds**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/voice-backend/src/main/wasapi-player.ts
git commit -m "feat: WindowsWasapiPlayer engine (queued-write, pause/resume, MCI fallback) + device probe"
```

---

## Task 9: Wire the engine into `createPlayer()`

**Files:**
- Modify: `packages/voice-backend/src/main/audio-player.ts`

- [ ] **Step 1: Update imports and the factory**

Add imports near the top of `audio-player.ts`:

```ts
import { WindowsWasapiPlayer } from "./wasapi-player.js";
import { getConfiguredDevice } from "./audio-device.js";
```

Replace `createPlayer()` with:

```ts
function createPlayer(): AudioPlayerBackend {
  if (process.platform === "win32") {
    const pref = getConfiguredDevice(); // null = no specific device / kill-switch → MCI
    if (pref) return new WindowsWasapiPlayer(pref);
    return new WindowsMCIPlayer();
  } else if (process.platform === "darwin") {
    return new MacAfplayPlayer();
  } else {
    return new LinuxPlayer();
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Manual smoke — default path unchanged**

With no `audio_device.json` present (delete `~/.claude/voice/audio_device.json` if any), run `npm run dev:backend` and trigger speech. Expected: plays via MCI, identical to before (no audify load).

- [ ] **Step 4: Manual smoke — WASAPI path**

Create `~/.claude/voice/audio_device.json` = `{"name":"<a real device name from Task 7 Step 5>"}`, restart the backend, trigger speech. Expected: audio plays through that device, centered. Pause/resume/mute behave (this is re-verified formally in Task 15).

- [ ] **Step 5: Commit**

```bash
git add packages/voice-backend/src/main/audio-player.ts
git commit -m "feat: route Windows playback to WASAPI when a device is selected"
```

---
## Task 10: TCP server handlers (`list_devices`, `set_device`, `test_device`)

**Files:**
- Modify: `packages/voice-backend/src/main/tcp-server.ts`

`dispatch()` stays **synchronous**. `test_device` is **fire-and-forget** (kick off the probe, return immediately).

- [ ] **Step 1: Add imports**

At the top of `tcp-server.ts`, extend the type import and add the device imports:

```ts
import type { ListDevicesCommand, SetDeviceCommand, TestDeviceCommand } from "@voice-mcp/shared";
import { listDevices, setDevice } from "./audio-device.js";
import { playProbe } from "./wasapi-player.js";
```

(Merge the named type imports into the existing `@voice-mcp/shared` import line rather than duplicating it.)

- [ ] **Step 2: Add the three cases to `dispatch()`**

In the `switch (command.cmd)` block, before `default:`:

```ts
    case "list_devices":
      return handleListDevices();
    case "set_device":
      return handleSetDevice(command as SetDeviceCommand);
    case "test_device":
      return handleTestDevice(command as TestDeviceCommand);
```

- [ ] **Step 3: Add the handler functions**

```ts
function handleListDevices(): TcpResponse {
  const r = listDevices();
  return { ok: true, available: r.available, reason: r.reason, active: r.active, devices: r.devices };
}

function handleSetDevice(cmd: SetDeviceCommand): TcpResponse {
  const r = setDevice(cmd.name);
  if (!r.ok) return { ok: false, error: r.error ?? "Failed to set device" };
  broadcastState(); // only on success — setDevice already invalidated the device cache
  return { ok: true, message: `Output device set to ${r.active}` };
}

function handleTestDevice(cmd: TestDeviceCommand): TcpResponse {
  // Fire-and-forget: do NOT await drain, so dispatch() stays synchronous.
  void playProbe(cmd.name).catch((err) => console.error("voice-mcp-backend: test_device error:", err));
  return { ok: true, message: `Testing device: ${cmd.name}` };
}
```

- [ ] **Step 4: Surface the active device in `handleStatus()`**

In the existing `handleStatus()`, add `activeDevice` to the returned object:

```ts
  return {
    ok: true,
    state: state.state,
    agent: state.currentAgent,
    text: state.currentText,
    muted: playbackQueue.isMuted(),
    queue_size: playbackQueue.size(),
    activeDevice: listDevices().active,
  };
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: succeeds (the `TcpCommand`/`TcpResponse` unions from Task 4 make these cases type-check).

- [ ] **Step 6: Manual round-trip**

Start the backend (`npm run dev:backend`), then from another shell:

```bash
node -e "const net=require('net');const s=net.connect(52718,'127.0.0.1',()=>{s.write(JSON.stringify({cmd:'list_devices'}));s.end()});let b='';s.on('data',d=>b+=d);s.on('end',()=>console.log(b))"
```

Expected: JSON with `ok:true`, `available:true`, and a `devices` array.

- [ ] **Step 7: Commit**

```bash
git add packages/voice-backend/src/main/tcp-server.ts
git commit -m "feat: TCP handlers for list_devices, set_device, test_device"
```

---

## Task 11: Dashboard state + WebSocket actions

**Files:**
- Modify: `packages/voice-backend/src/main/web-ui.ts`

- [ ] **Step 1: Add imports**

Extend the existing imports in `web-ui.ts`:

```ts
import { listDevices, setDevice } from "./audio-device.js";
import { playProbe } from "./wasapi-player.js";
```

- [ ] **Step 2: Include the device list in broadcast state**

In `getFullState()`, add a field to the returned object:

```ts
    audioDevices: listDevices(),
```

`getFullState()` runs on the 250 ms broadcast interval, but `listDevices()` is cached with a short TTL (Task 7), so this re-enumerates native devices at most once every few seconds, not 4×/second.

- [ ] **Step 3: Handle the new WS actions**

In `handleWsMessage()`'s `switch (msg.action)`, add:

```ts
    case "set_device":
      if (typeof msg.name === "string") setDevice(msg.name);
      break;
    case "test_device":
      if (typeof msg.name === "string") void playProbe(msg.name).catch(() => {});
      break;
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/voice-backend/src/main/web-ui.ts
git commit -m "feat: expose audio devices in dashboard state + set/test WS actions"
```

---

## Task 12: Dashboard device picker (renderer)

**Files:**
- Modify: `packages/voice-backend/src/renderer/index.html`
- Modify: `packages/voice-backend/src/renderer/app.js`
- Modify: `packages/voice-backend/src/renderer/styles.css`

The picker lives at the top of the Agents drawer (the existing settings surface).

- [ ] **Step 1: Add the picker markup**

In `index.html`, inside `<aside id="agents-drawer">`, immediately after the `<div class="drawer-header">…</div>` block and before `<div id="agents-list">`, insert:

```html
    <div class="device-section">
      <label class="device-label" for="device-select">Output device</label>
      <div class="device-row">
        <select id="device-select" class="agent-select"></select>
        <button id="btn-test-device" type="button" class="btn btn-small">Test</button>
      </div>
      <div id="device-reason" class="device-reason" style="display:none"></div>
    </div>
```

- [ ] **Step 2: Render the picker from state**

In `app.js`, add a `renderDevicePicker()` call inside `render()` (after `renderAgents();`), then add the function:

```js
function renderDevicePicker() {
  const select = document.getElementById("device-select");
  const testBtn = document.getElementById("btn-test-device");
  const reason = document.getElementById("device-reason");
  const data = state.audioDevices;
  if (!select || !data) return;

  if (!data.available) {
    select.innerHTML = `<option>System default</option>`;
    select.disabled = true;
    testBtn.disabled = true;
    reason.textContent = data.reason || "Device selection unavailable";
    reason.style.display = "";
    return;
  }

  select.disabled = false;
  testBtn.disabled = false;
  reason.style.display = "none";

  const activeName = data.active; // "System default" or a device name
  const options = [`<option value="default"${activeName === "System default" ? " selected" : ""}>System default</option>`]
    .concat(data.devices.map(d =>
      `<option value="${escapeHtml(d.name)}"${d.name === activeName ? " selected" : ""}>${escapeHtml(d.name)}${d.isDefault ? " (system default)" : ""}</option>`
    ));
  const joined = options.join("");
  if (select.dataset.rendered !== joined) {  // avoid clobbering an open dropdown every tick
    select.innerHTML = joined;
    select.dataset.rendered = joined;
  }
}
```

- [ ] **Step 3: Wire the events**

In `app.js`, in the event-listener section near the bottom, add:

```js
document.getElementById("device-select").addEventListener("change", (e) => {
  send("set_device", { name: e.target.value });
});
document.getElementById("btn-test-device").addEventListener("click", () => {
  const v = document.getElementById("device-select").value;
  if (v && v !== "default") send("test_device", { name: v });
});
```

- [ ] **Step 4: Style it**

Append to `styles.css`:

```css
.device-section { padding: 12px 16px; border-bottom: 1px solid var(--surface1); }
.device-label { display: block; font-size: 12px; opacity: 0.7; margin-bottom: 6px; }
.device-row { display: flex; gap: 8px; align-items: center; }
.device-row .agent-select { flex: 1; }
.device-reason { margin-top: 6px; font-size: 11px; opacity: 0.6; }
```

(`--surface1` is the Catppuccin token `.drawer-header` already uses for its divider — confirm it exists in `styles.css` and substitute the literal color if the token differs.)

- [ ] **Step 5: Rebuild and verify in the browser**

Run: `npm run build` then `npm run dev:backend`, open the dashboard (`http://localhost:52719`), open the ⚙️ drawer.
Expected: the "Output device" dropdown lists System default + your devices; selecting one persists it (survives a refresh); "Test" plays a short tone through the selected device; if you set `VOICE_AUDIO_BACKEND=mci`, the dropdown is disabled and shows the reason.

- [ ] **Step 6: Commit**

```bash
git add packages/voice-backend/src/renderer/index.html packages/voice-backend/src/renderer/app.js packages/voice-backend/src/renderer/styles.css
git commit -m "feat: dashboard output-device picker with Test button and disabled state"
```

---

## Task 13: `voice_devices` MCP tool + setup help text

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`

- [ ] **Step 1: Register the tool**

In `registerTools()` (e.g. after `voice_unmute`), add:

```ts
  // ── voice_devices ────────────────────────────────────────────────────
  server.tool(
    "voice_devices",
    "List available audio output devices (Windows), or select one. Call with no args to list; pass `select` (a device name, or 'default' for the system default) to choose where voice plays.",
    {
      select: z.string().optional().describe("Device name to use, or 'default' for the system default endpoint"),
    },
    async ({ select }) => {
      if (select !== undefined) {
        const r = await sendOrLaunch({ cmd: "set_device", name: select });
        if (!r) return errorText("Voice backend is not running.");
        if (!r.ok) {
          // Spec §7.2: an unknown name returns the error PLUS the current device list.
          const listed = await sendOrLaunch({ cmd: "list_devices" });
          const names = listed && (listed as any).available
            ? "\n\nAvailable output devices:\n" +
              (listed as any).devices.map((d: any) => `  ${d.name}${d.isDefault ? " (system default)" : ""}`).join("\n")
            : "";
          return errorText(`${(r as any).error}${names}`);
        }
        return okText((r as any).message ?? `Output device set to ${select}`);
      }
      const r = await sendOrLaunch({ cmd: "list_devices" });
      if (!r) return errorText("Voice backend is not running.");
      const res = r as any;
      if (!res.available) {
        return okText(`Output device selection unavailable: ${res.reason}\nActive: ${res.active}`);
      }
      const lines = res.devices.map(
        (d: any) => `${d.active ? "● " : "  "}${d.name}${d.isDefault ? " (system default)" : ""}`
      );
      return okText(
        `Active output: ${res.active}\n\nAvailable output devices:\n${lines.join("\n")}\n\n` +
        `Use voice_devices with select:"<name>" to choose, or select:"default" to reset.`
      );
    },
  );
```

- [ ] **Step 2: Update the `voice_setup` help text**

In the `voice_setup` tool's `## Available Tools` list, add a line:

```ts
- **voice_devices** — List/select the audio output device (Windows)
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual check via the running MCP server**

With the backend running, exercise the tool from your editor's MCP client (or via the dev flow): `voice_devices` lists devices; `voice_devices({select:"<name>"})` sets it; a subsequent `voice_speak` plays through it; `voice_devices({select:"default"})` resets to MCI.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools.ts
git commit -m "feat: voice_devices MCP tool to list/select the output device"
```

---

## Task 14: Version bump + CLAUDE.md tool count

**Files:**
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/mcp-server/package.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Bump the server version (both locations — the known gotcha)**

In `packages/mcp-server/src/index.ts`, set the `McpServer` ctor `version` to `"1.2.0"`.
In `packages/mcp-server/package.json`, set `"version": "1.2.0"`.

- [ ] **Step 2: Update the tool count in CLAUDE.md**

In `CLAUDE.md`, change `packages/mcp-server/src/tools.ts — all 9 MCP tool definitions.` to `all 10 MCP tool definitions.` and update the version-in-sync note from `1.1.2` to `1.2.0`.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/index.ts packages/mcp-server/package.json CLAUDE.md
git commit -m "chore: bump voice-tts-mcp to 1.2.0, update tool count"
```

---

## Task 15: Acceptance pass (spec §11.3–11.5)

**Files:** none (verification only). Run on Windows with audify working.

- [ ] **Step 1: Contract / integration (§11.3)** — with a non-default device selected:
  - Queue several `voice_speak` calls → they play one after another through the device with **no overlap**.
  - Pause then resume mid-utterance → continues the same phrase, no skip/restart.
  - Mute → current item stops immediately and the queue advances; unmute resumes new items.
  - Replay / replay-item from the dashboard → plays through the selected device.
  - Switch device in the dashboard → takes effect on the **next** item (not the in-flight one).

- [ ] **Step 2: Failure paths (§11.4):**
  - Temporarily rename the selected device's `audio_device.json` `name` to a bogus value → next item falls back to MCI default + a warning is logged; the file is retained.
  - Unplug the selected device mid-playback (or disable it) → the current item ends gracefully and the queue continues.
  - Set `VOICE_AUDIO_BACKEND=mci` and restart → `voice_devices` and the dashboard report WASAPI disabled; all playback is MCI.

- [ ] **Step 3: Regression (§11.5):**
  - Remove `audio_device.json` entirely → playback is byte-for-byte the old MCI path (no audify load, no decode).
  - Confirm macOS/Linux code paths are untouched (no edits to `MacAfplayPlayer`/`LinuxPlayer`).

- [ ] **Step 4: Re-confirm the Phase-0 pause/resume gate (§11.2)** holds in the integrated build, using the dashboard pause/resume while watching the backend console for exactly-once `play()` resolution (the engine resolves via `settle()` only once).

- [ ] **Step 5: Final commit (if any doc/notes updated) and branch summary**

```bash
git add -A docs/superpowers
git commit -m "docs: record acceptance results for audio output device" || echo "nothing to commit"
git log --oneline feat/audio-output-device ^master
```

Expected: the feature's commits listed; the working tree's pre-existing unrelated changes remain unstaged.

---

## Self-Review (completed during authoring)

- **Spec coverage:** §2 decisions → Tasks 1,7,8,9; §4 seam/files → Tasks 6,9 + file table; §5 audio-device (DevicePref, id===0, corrupt-file, resolve-then-open) → Task 7 + Task 8 (resolve on same instance); §6 engine (queued-write, mono→stereo, Float32, sync void contract, stop guards, pause audible-cursor) → Tasks 5,8; §7 TCP/tool/dashboard/test_device → Tasks 10,11,12,13; §8 fallback matrix → Tasks 8 (transparent MCI fallback), 7 (unavailable/disabled), 15; §9 packaging → Task 1; §10 version → Task 14; §11 testing incl. Phase-0 gate → Tasks 2,5,7,15; §12 phases → task ordering. No uncovered requirement found.
- **Placeholder scan:** the only literal placeholder is the deliberately-deleted `decodeToInterleavedStereo` guard (Task 8 Step 2 removes it). Provisional `FRAME_SIZE`/`LOOKAHEAD_FRAMES` are real defaults validated/replaced by the Task 2 spike — not TBDs.
- **Type consistency:** `DeviceInfo`/`DevicePref`/`DeviceListResult` (Task 4) are used identically in Tasks 7,8,10,11; `pickDevice`/`loadAudify`/`savePref`/`getConfiguredDevice`/`listDevices`/`setDevice`/`playProbe` signatures match across producer (Task 7/8) and consumers (Tasks 8,9,10,11); `settle()` is the single resolve path; TCP command/response names match the union extended in Task 4.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-audio-output-device.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Note: Tasks 2, 8, 9, 12, 15 require a real Windows audio device + working audify, so those steps need you (or this machine) in the loop for the listen/observe checks.

2. **Inline Execution** — I execute tasks in this session using executing-plans, with checkpoints for the manual audio-verification steps.

**Which approach?**


