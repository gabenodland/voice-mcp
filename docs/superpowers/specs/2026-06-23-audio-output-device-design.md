# Configurable Audio Output Device (Windows) — Design Spec

- **Status:** Approved for implementation planning
- **Date:** 2026-06-23
- **Target version:** `voice-tts-mcp` 1.2.0 (from 1.1.2)
- **Scope:** Windows only
- **Companion analysis:** `docs/wasapi-migration-report.html` (MCI → WASAPI feasibility)

---

## 1. Summary

Voice MCP plays audio on Windows through the legacy **MCI** command layer
(`mciSendStringW` over koffi), which can only ever play to the **system default**
output endpoint. This feature lets a user choose *which* output device the voice
comes out of (headset, monitor, virtual cable, …).

We add a second Windows playback engine — an in-process **WASAPI** path via the
prebuilt [`audify`](https://www.npmjs.com/package/audify) native module (RtAudio
binding, shared mode) plus a WASM MP3 decoder
([`mpg123-decoder`](https://www.npmjs.com/package/mpg123-decoder)) — behind the
existing `AudioPlayerBackend` interface. **MCI remains the default**; the WASAPI
engine is used **only when the user has selected a specific (non‑default)
device**, and any failure in the WASAPI path falls back to MCI on the default
device so voice output never breaks.

Two configuration surfaces: a **device dropdown in the web dashboard** and a
**`voice_devices` MCP tool**. No environment-variable device configuration and no
per-`voice_speak` device argument in v1.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Platforms | **Windows only.** macOS (`afplay`) and Linux (`ffplay`/`mpv`/`paplay`) players are untouched. |
| 2 | Engine | In-process **WASAPI shared mode** via `audify` + `mpg123-decoder`, behind the existing `AudioPlayerBackend`. |
| 3 | Default behavior | **MCI stays the default.** WASAPI is used only when a specific device is selected. Any WASAPI failure → MCI on default device. |
| 4 | Config surface | **Dashboard dropdown** + **`voice_devices` MCP tool**. No env-var device config, no per-call arg. |
| 5 | Internal audio format | **Float32 PCM**, stream format `RTAUDIO_FLOAT32` (matches the decoder's native output — no conversion). |
| 6 | Channel handling | **Open a 2‑channel stream and duplicate mono → stereo** in interleaved layout. (RtAudio does not upmix; a 1‑channel WASAPI stream plays left‑only.) |
| 7 | Device persistence | Persist the device **name** as the durable selector; `hintDeviceId` is a best-effort hint only. |
| 8 | Stream control model | audify is **queued-write** (`write()` + `clearOutputQueue()`); there is no pull callback. |
| 9 | Operational kill-switch | `VOICE_AUDIO_BACKEND=mci` forces MCI everywhere (support/debug escape hatch, *not* device config). |

---

## 3. Non-goals (YAGNI for v1)

- macOS / Linux device selection.
- WASAPI **exclusive** mode (shared only — a non-realtime assistant should coexist with other apps).
- A per-`voice_speak` `device` argument.
- Environment-variable device *selection* (the `mci` kill-switch is the only env var, and it is not device config).
- Multi-device fan-out, ducking, loopback capture, named per-app volume tuning beyond the default "Voice MCP" session name.

---

## 4. Architecture & the seam

Everything above the `AudioPlayerBackend` interface is unchanged. The blast radius
ends at `createPlayer()` plus one new module and one new player class.

```
                         audio-device.ts  ← NEW
                         · enumerate (audify getDevices)
                         · load/save preference (audio_device.json)
                         · resolve saved NAME → current device id
                              │ reads configured device
playAudio(file) ─► createPlayer() ─┬─ device == "default"/unset ───────► WindowsMCIPlayer        (today's path)
   (per item)                      │
                                   ├─ specific device + audify loads ──► WindowsWasapiPlayer(id)  ← NEW
                                   │                                        (decode → 2ch float32 → write)
                                   └─ any WASAPI failure ──────────────► WindowsMCIPlayer (default) + warn
```

**Files**

| File | Change |
|------|--------|
| `packages/voice-backend/src/main/audio-device.ts` | **NEW** — enumeration, preference persistence, name→id resolution. |
| `packages/voice-backend/src/main/wasapi-player.ts` | **NEW** — `WindowsWasapiPlayer implements AudioPlayerBackend`. |
| `packages/voice-backend/src/main/audio-player.ts` | **EDIT** — `createPlayer()` Windows branch; thread the configured device in. |
| `packages/voice-backend/src/main/tcp-server.ts` | **EDIT** — handle `list_devices`, `set_device`, `test_device`. |
| `packages/voice-backend/src/main/web-ui.ts` | **EDIT** — device list in broadcast state; `set_device` / `test_device` WS actions. |
| `packages/voice-backend/src/renderer/app.js` (+ `index.html`, `styles.css`) | **EDIT** — device dropdown, active-device display, "Test" button. |
| `packages/shared/src/types.ts` | **EDIT** — new TCP command/response types; `activeDevice` in status/state. |
| `packages/shared/src/constants.ts` | **EDIT** — `DEVICE_PREF_FILE`, `DEFAULT_AUDIO_DEVICE`. |
| `packages/mcp-server/src/tools.ts` | **EDIT** — new `voice_devices` tool; also update the `voice_setup` `## Available Tools` help text to include it. |
| `packages/mcp-server/src/index.ts` + `package.json` | **EDIT** — version bump 1.1.2 → 1.2.0 (both, per the known gotcha). |
| `packages/mcp-server/package.json` | **EDIT** — `audify`, `mpg123-decoder` in `optionalDependencies`. |
| `packages/mcp-server/tsup.config.ts` | **EDIT** — mark both native deps `external`. |
| `CLAUDE.md` | **EDIT** — bump the "9 MCP tools" count to 10 (`voice_devices`). |

`playAudio()` already constructs a fresh player per item via `createPlayer()`, so
the active device is read at construction time and a device change takes effect on
the **next `playAudio()` call** (next queue item or next replay) with no special
plumbing. An already-playing item is not re-routed mid-utterance.

---

## 5. Component: `audio-device.ts`

Single owner of device state. Public surface:

```ts
interface DeviceInfo {
  id: number;         // current audify/RtAudio device id (opaque, instance-scoped — see §13)
  name: string;       // stable selector
  isDefault: boolean; // mapped from audify's numeric isDefaultOutput (0/1)
  active: boolean;    // matches the persisted selection
}

interface DeviceListResult {
  available: boolean;   // false when audify can't load or WASAPI is disabled
  reason?: string;      // why unavailable (e.g. "WASAPI disabled by VOICE_AUDIO_BACKEND=mci")
  active: string;       // "System default" or the selected device name
  devices: DeviceInfo[];// output endpoints (empty when unavailable)
}

function listDevices(): DeviceListResult;
function setDevice(nameOrDefault: string): { ok: boolean; error?: string; active: string };
function getConfiguredDevice(): { name: string; hintDeviceId?: number } | null; // null = system default → MCI
function resolveDeviceId(): number | null;  // current id for the saved name, or null if gone/default
```

**Enumeration** uses an audify `RtAudio(RtAudioApi.WINDOWS_WASAPI)` instance and
`getDevices()`, filtered to entries with `outputChannels > 0`. All device fields
(`id`, `name`, `outputChannels`, `isDefaultOutput`, `preferredSampleRate`) come from
the **same** `getDevices()[]` entry. `isDefaultOutput` is a number (0/1), normalized
to boolean. Treat **`id === 0` as invalid/absent** — never a usable `deviceId`.

**Persistence** — `~/.claude/voice/audio_device.json`:

```json
{ "name": "Headphones (Razer Kraken)", "hintDeviceId": 131 }
```

```ts
interface DevicePref { name: string; hintDeviceId?: number }  // hintDeviceId optional
```

- Absent file, or `{ "name": "default" }` ⇒ system default ⇒ **MCI** path.
- A corrupt / unparseable `audio_device.json` is treated as **no preference**
  (system default → MCI) and logged once — never a hard error.
- We persist the **name** because RtAudio 6 device ids are opaque, non-contiguous,
  instance-scoped handles that change on unplug/replug and across process restarts
  (see §13). `hintDeviceId` is a best-effort cache only.

**Resolution rule** (`resolveDeviceId`, run at player construction):
1. If no specific device is configured → return `null` (caller uses MCI).
2. Enumerate current devices. **Match by exact `name`** → return that device's
   current `id`.
3. If the name no longer resolves, **but** `hintDeviceId` still maps to a device
   whose name equals the saved name → use `hintDeviceId`. (In practice the hint is
   usually stale after a restart; name match is the normal path.)
4. Otherwise treat the device as **gone**: return `null` (caller falls back to MCI
   default) and log a warning. **Keep the saved preference** so the device works
   again when it returns.

When a device resolves, refresh `hintDeviceId` in the persisted file to the
current id.

**Same-instance invariant:** because RtAudio 6 device ids are instance-scoped (§13),
`WindowsWasapiPlayer` must **resolve the id and open the stream on the same
`RtAudio` instance** (resolve-then-open within one instance lifetime). The
short-lived instance that `listDevices()` uses for the dropdown / `voice_devices`
tool is independent — it only surfaces names (and display ids) for the UI, and the
selection persists by **name**, so its ids never need to match the player's instance.

---

## 6. Component: `WindowsWasapiPlayer` (the engine — highest risk)

`class WindowsWasapiPlayer implements AudioPlayerBackend` with the same
`play / pause / resume / stop / state` surface as `WindowsMCIPlayer`. As in the
existing interface, **only `play()` is `async` (`Promise<void>`); `pause()`,
`resume()`, and `stop()` are synchronous `void`** — the audify teardown calls they
use (`stop`, `clearOutputQueue`, `closeStream`) are all synchronous, so these methods
must not become async (callers like `stopAudio()` / `pauseAudio()` don't await).

### 6.1 Audio pipeline (per `play(filepath)`)

1. **Decode** the MP3 with `mpg123-decoder`. Edge TTS emits
   `audio-24khz-48kbitrate-mono-mp3` by default, so `decode()` returns
   `{ channelData: [Float32Array], samplesDecoded, sampleRate: 24000 }` — planar,
   **Float32 only** (the decoder never emits Int16). Decode the whole clip up front
   (a 10 s clip ≈ a few hundred KB of PCM — trivial for speech). **Decoding is
   whole-clip into an in-memory buffer; only the *writes* are chunked** — the decode
   buffer and the audify device queue are distinct (see §6.2).
2. **Mono → stereo, interleaved Float32.** Build `out` where
   `out[2*i] = out[2*i+1] = mono[i]`. **Required** — RtAudio does not duplicate mono
   to stereo; a 1‑channel WASAPI stream plays **left ear only**. (If the source is
   already multi-channel, interleave its channels directly.)
3. **Open the stream** via audify:
   - `outputParameters = { deviceId: <resolved id>, nChannels: 2, firstChannel: 0 }`
   - `inputParameters = null`
   - `format = RtAudioFormat.RTAUDIO_FLOAT32`
   - `sampleRate = 24000` (the decoded rate)
   - `frameSize` ≈ 480 frames (~20 ms @ 24 kHz) — provisional; tuned in the spike.
     (A *frame* = one sample across **all** channels, not a per-channel sample count.)
   - `streamName = "Voice MCP"` (the Windows volume-mixer session label)
   - `inputCallback = null`, `frameOutputCallback = <progress counter>` (see 6.2)
4. **`rt.start()`**, then feed PCM with the **queued-write** model below.

> **Sample-rate handling (spike item):** RtAudio's WASAPI backend performs its own
> sample-rate conversion to the device mix format, so passing `24000` is expected to
> work. The Phase-0 spike must confirm 24 kHz mono renders at correct pitch/speed on a
> 48 kHz endpoint. **Fallback:** if SR handling is unreliable, resample in JS to the
> device's `preferredSampleRate` (from `getDevices()`) before writing.

### 6.2 The queued-write model (verified — there is no pull callback)

audify is **queued-write**: `write(buffer)` enqueues PCM; the device callback pops
from the internal queue and **emits silence on underrun** (it never pulls from JS);
`frameOutputCallback` is a **notification only** ("a frame finished playing");
`clearOutputQueue()` empties the pending queue. Therefore:

- **Never enqueue the whole clip.** Slice the decoded interleaved buffer into
  ~`frameSize`-frame `Buffer`s and `write()` them as the queue drains (driven by
  `audibleFrames`) — **never a single `write()` of the full clip** (the easy wrong
  path, since `write()` enqueues whatever Buffer you hand it). Maintain a small
  **bounded look-ahead** (provisional `N ≈ 4` frames ≈ 80 ms; exact N tuned in the
  spike). A fully-queued clip would make pause/mute/stop laggy (they'd have to
  discard a large queue).
- **`frameOutputCallback` drives the "audible cursor":** increment an
  `audibleFrames` counter each time it fires. This counter — **frames actually
  output**, not frames `write()`-n — is the basis for both EOF detection and
  pause/resume position. (`streamTime` / `getStreamLatency()` may be used to
  cross-check; chosen mechanism finalized in the spike.)

### 6.3 The `AudioPlayerBackend` contract (binding — the queue depends on it)

**Natural EOF**
- Resolve `play()` **only after the final audible buffer has drained** — i.e. all
  PCM has been written *and* `audibleFrames` has reached the total frame count
  (allowing for stream latency). Then `stop()` + `closeStream()`.

**`stop()`**
- Immediately prevent further audible output as much as audify allows:
  `clearOutputQueue()` → `stop()` → `closeStream()`. (audify's `stop()` maps to
  RtAudio `stopStream()`, which *drains* remaining samples, so `clearOutputQueue()`
  must run first to discard the queue for an immediate stop.)
- **Guard every audify call with `isStreamOpen()` / `isStreamRunning()`.** A `stop()`
  before any stream was opened (the common case — `playAudio()` calls `stopAudio()`
  on the freshly-constructed next player before it ever plays) must be a true no-op;
  never `closeStream()` a stream that was never opened (audify throws).
- **Resolve the pending `play()` promise exactly once.** Idempotent: a second
  `stop()` is a no-op.
- Used by mute, replay/one-shot, and the start of every `playAudio()` — must be
  prompt and safe to call when not playing.

**`pause()`**
- Stop/close the active stream **without** resolving `play()`.
- **Preserve the *audible* cursor** (`audibleFrames`), not the last
  written/scheduled position — otherwise resume skips audio.
- `resume()` reopens the stream and continues writing from the audible cursor. The
  completion promise stays pending across pause (no callbacks fire while stopped).

**`state`** — mirrors `WindowsMCIPlayer`: `"stopped" | "playing" | "paused"`.

### 6.4 Resilience

- **Device unplugged mid-playback** surfaces as an audify error/error-callback.
  Catch it, end the current item gracefully (resolve `play()`), and let the queue
  continue. The next item re-resolves the device; if still gone → MCI default.
- All audify interaction is wrapped so that **any** throw degrades to MCI on the
  default device rather than crashing the backend.

---

## 7. Config & data flow

### 7.1 TCP commands (shared/types.ts → tcp-server.ts)

```ts
interface ListDevicesCommand { cmd: "list_devices"; }
interface SetDeviceCommand   { cmd: "set_device"; name: string; }  // name or "default"
interface TestDeviceCommand  { cmd: "test_device"; name: string; } // play a probe through a device
```

Responses add a `DevicesResponse` carrying `DeviceListResult` (§5). `handleStatus`
and `getFullState` gain an `activeDevice` field.

`dispatch()` stays **synchronous** (it returns `TcpResponse`, written immediately on
socket `end`): `list_devices` (enumerate) and `set_device` (persist + re-enumerate)
do no playback and return synchronously; **`test_device` is fire-and-forget** — it
kicks off the probe and returns `{ ok: true }` immediately **without** awaiting drain.
No handler awaits, so `dispatch()` need not become async (avoiding a refactor that
would ripple through every existing handler).

### 7.2 `voice_devices` MCP tool (mcp-server/tools.ts)

One tool, optional `select` arg:

| Call | Behavior |
|------|----------|
| `voice_devices()` | List output devices + the active selection (`list_devices`). |
| `voice_devices({ select: "default" })` | Persist system default → MCI path (`set_device`). |
| `voice_devices({ select: "Headphones (…)" })` | Persist the named device if it resolves. |
| `voice_devices({ select: "<unknown>" })` | Return an error **plus** the current device list. |

When WASAPI is unavailable (audify can't load, or `VOICE_AUDIO_BACKEND=mci`), the
tool returns:

```json
{ "available": false, "reason": "WASAPI disabled by VOICE_AUDIO_BACKEND=mci", "active": "System default", "devices": [] }
```

While unavailable, **`set_device` rejects** with `{ ok: false, error: <reason> }` — it
does **not** silently persist an inert selection — and the dashboard dropdown renders
**disabled/greyed** with the reason shown.

Uses the existing `sendOrLaunch` pattern (launches the backend if not running).
We split into a separate `voice_set_device` tool only later, if richer device
profiles / routing policies arrive.

### 7.3 Dashboard (web-ui.ts + renderer)

- `getFullState()` includes the `DeviceListResult` so the 250 ms broadcast keeps
  the UI live.
- New **device dropdown** in `app.js` (System default + each output endpoint);
  selecting sends WS `{ action: "set_device", name }`. The active device is shown,
  and the selection is persisted server-side.
- A **"Test"** button next to the dropdown sends `{ action: "test_device", name }`.

### 7.4 `test_device`

Plays a short (~300–500 ms) probe — a generated tone or a tiny fixed TTS sample —
through the target device **without touching the playback queue or its history**.
This is essential for sanity-checking messy Windows endpoints (Bluetooth, HDMI,
virtual cables) before committing a selection. Surfaced as the dashboard "Test"
button in v1 (not a separate MCP tool).

---

## 8. Error handling & fallback (the safety net)

| Failure | Behavior |
|---------|----------|
| audify can't load (missing prebuild / AV / unsupported box) | Enumeration returns `{ available:false, reason }`; dropdown shows only "System default"; all playback stays on MCI. |
| Saved device missing at play time (unplugged / renamed) | Resolve → `null`; play that item via **MCI default** + warn; **keep** the saved preference for when it returns. |
| Device unplugged mid-playback | Catch the stream error; end the item gracefully; continue the queue (re-resolve next item; still gone → MCI default). |
| Sample-rate / format mismatch | Spike-validated path; JS resample fallback (§6.1). On hard failure → MCI default + warn. |
| `VOICE_AUDIO_BACKEND=mci` | Force MCI everywhere; `voice_devices`/dashboard report WASAPI disabled. |

**Invariant:** a WASAPI/audify problem must never break `voice_speak`. Worst case is
"voice still works, you just lose device selection."

---

## 9. Packaging & build

The existing **koffi** dependency is the precedent: a native module in the
published package, loaded via `await import("koffi")`, auto-externalized by tsup,
resolved from the consumer's `node_modules` at runtime. audify + mpg123-decoder
follow the same path.

- **`packages/mcp-server/package.json`** — add to **`optionalDependencies`**:
  `audify` and `mpg123-decoder`. `optionalDependencies` means a host with no
  matching audify prebuild still installs successfully (the WASAPI path is then
  simply unavailable → MCI).
- **`tsup.config.ts`** — add `audify` and `mpg123-decoder` to `external` as
  **insurance**. esbuild already auto-externalizes bare imports it can't resolve —
  that's why `koffi` works today with no `external` entry at all — but an *optional*
  dep may be absent at build time, so listing them explicitly is belt-and-suspenders.
  Either way esbuild cannot inline a `.node` binary.
- **Load via dynamic `import()`** inside `wasapi-player.ts` / `audio-device.ts`,
  wrapped in try/catch — exactly like `WindowsMCIPlayer.loadKoffi()`. A load failure
  sets `available:false` and routes to MCI.
- **No `.node` copy into `dist/` and no `createRequire` banner needed.** Because
  audify is a *published* dependency of `voice-tts-mcp`, it resolves from the
  consumer's `node_modules` (same as koffi today), and Node's ESM loader imports the
  CJS addon directly. (Copy-into-`dist/` would only be required if we *vendored* the
  binary instead of depending on it — explicitly not chosen.)
- `mpg123-decoder` is WASM embedded in its own JS; external + dynamic import
  resolves it with no extra steps.

---

## 10. Versioning

Bump **1.1.2 → 1.2.0** (minor; additive feature) in **both** places, per the known
gotcha:
- `packages/mcp-server/src/index.ts` (the `McpServer` constructor).
- `packages/mcp-server/package.json`.

---

## 11. Testing & acceptance criteria

### 11.1 Phase-0 spike (de-risk before touching real code)

A standalone throwaway script must prove, on the target Windows machine:
1. audify loads and `getDevices()` lists output endpoints with stable ids + names.
2. Decode one real Edge-TTS MP3 → Float32 mono → interleaved stereo → play through a
   **non-default** device.
3. **Sample-rate:** 24 kHz mono renders at correct pitch/speed on a 48 kHz endpoint
   (or determine the JS-resample fallback is needed).
4. **Channels:** audio is **centered (both ears)**, not left-only.
5. Establish the exact completion/drain signal (`frameOutputCallback` count vs
   `streamTime`) and the look-ahead queue depth (`frameSize`, `N`).
6. **Pause/resume hard gate (§11.2)** — proven *in the spike*, with `play()`
   resolution instrumented by a one-shot guard that asserts on double-resolution and
   counts resolutions, so "exactly once" / "never early" are *checked*, not judged by
   ear.

### 11.2 Pause/resume — **Phase-0 hard acceptance criteria** (most failure-prone)

A **Phase-0 gate** — proven during the spike (§11.1), *not* deferred to Harden.
Instrument `play()` with a one-shot resolution guard so the once-only criteria are
**observable** (counted), not audible-only.

- Pause while speaking **stops audible output promptly**.
- Resume **continues the same phrase** without restarting the clip.
- Repeated pause/resume **never resolves `play()` early**.
- **Stop while paused resolves `play()` exactly once.**
- The next queue item **does not overlap** with the paused/stopped item.

### 11.3 Contract / integration (against the real queue)

- Mute stops the current item immediately and the queue advances.
- Replay / replay-item play through the selected device without overlap.
- Back-to-back items never overlap (`play()` resolves at true end only).
- Switching device in the dashboard takes effect on the next item.

### 11.4 Failure paths

- audify-absent → enumeration `available:false`, playback on MCI.
- Saved device missing → MCI default + warning, preference retained.
- Unplug mid-playback → graceful item end, queue continues.
- `VOICE_AUDIO_BACKEND=mci` → WASAPI fully disabled, reported in tool/dashboard.

### 11.5 Regression

- With no device selected, the MCI path is **byte-for-byte unchanged** (no decode,
  no audify load, no behavior change for existing users).
- macOS / Linux players untouched.

> No automated test runner is configured in this repo (per CLAUDE.md). These are
> spike scripts + manual/scripted verification flows, not a new test harness.

---

## 12. Phased delivery

Each phase is independently shippable; MCI is never removed.

| Phase | Deliverable |
|-------|-------------|
| **0 · Spike** | Prove the unknowns in isolation (§11.1), **including the pause/resume hard gate (§11.2)**; fix `frameSize` + look-ahead `N`. Throwaway code. |
| **1 · Engine** | `WindowsWasapiPlayer` honoring the full contract (§6.3), default-device only, gated behind a specific-device selection. MCI default unchanged. *Depends on the spike's `frameSize` + `N`.* |
| **2 · Packaging** | `optionalDependencies` + tsup `external` + dynamic-import load/fallback (§9). |
| **3 · Devices** | `audio-device.ts` enumeration + persistence + name resolution; `list_devices` / `set_device` TCP commands; `voice_devices` tool. |
| **4 · UX** | Dashboard dropdown, active-device display, `test_device` + "Test" button. |
| **5 · Harden** | Unplug / missing-device / SR-mismatch paths; the §11.3–11.5 acceptance pass (pause/resume already gated in Phase 0); version bump + release. |

---

## 13. Open risks the spike must close

1. **Sample-rate conversion fidelity** — does audify/RtAudio WASAPI resample 24 kHz
   mono cleanly to the device mix rate, or do we resample in JS? (§6.1)
2. **Completion semantics** — the precise `frameOutputCallback` / `streamTime`
   condition that means "fully drained" without truncating the tail or hanging.
3. **Look-ahead depth** — small enough for responsive pause/stop, large enough to
   avoid underrun silence.
4. **audify prebuilt availability** for the user's Node/arch (N-API should cover all
   recent Node majors with one binary).

> Pause/resume is **not** an open risk — it is a Phase-0 hard acceptance gate (§11.2).

---

## Appendix A — Verified technical facts

Confirmed via primary sources during design (audify source/types, RtAudio docs,
decoder READMEs, esbuild/npm docs). These are load-bearing for the design above.

1. **audify is queued-write, not pull-callback.** `write(pcm)` enqueues onto an
   internal `_outputData` queue; the device callback pops it or **memsets silence on
   underrun**; `frameOutputCallback` is a post-output notification (returns no data);
   `clearOutputQueue()` empties the queue. Methods present: `openStream`,
   `start`, `stop`, `write`, `clearOutputQueue`, `closeStream`, `isStreamOpen`,
   `isStreamRunning`, `getStreamLatency`, `getStreamSampleRate`, `getDevices`,
   `getDefaultOutputDevice`; properties `streamTime`, `outputVolume`.
   `openStream(out, in, format, sampleRate, frameSize, name, inputCallback,
   frameOutputCallback, flags?, errorCallback?)`. *(audify index.d.ts, TypeDoc,
   src/rt_audio.cpp.)*

2. **Device ids are stable RtAudio ids, not array indices** — pass `getDevices()[].id`
   / `getDefaultOutputDevice()` straight through as `deviceId`. *(audify
   rt_audio_converter.cpp; MIN_UNIQUE_DEVICE_ID = 129.)*

3. **But RtAudio 6 ids are opaque, non-contiguous, instance-scoped** and change on
   unplug/replug; id `0` is invalid. Stable only within one live instance while the
   device stays connected → **persist the name, re-resolve at use time.** audify
   bundles RtAudio 6.x. *(RtAudio.h `getDeviceIds()` docs; release.txt; probe.html.)*

4. **RtAudio does not upmix mono.** A 1-channel stream is left-only on WASAPI and
   CoreAudio. Open `nChannels=2` and copy mono into both channels; default layout is
   **interleaved** (L,R,L,R…); `RTAUDIO_NONINTERLEAVED` switches to planar. *(RtAudio
   FAQ; issue #243; RtAudio.h.)*

5. **mpg123-decoder returns Float32 planar only** — `{ channelData: Float32Array[],
   samplesDecoded, sampleRate }`; no Int16 path. **Edge TTS default =
   `audio-24khz-48kbitrate-mono-mp3`** (24 kHz, mono). So decode → `[Float32Array]`
   @ 24000; standardizing on `RTAUDIO_FLOAT32` avoids any format conversion. *(eshaz
   wasm-audio-decoders README; node-edge-tts src default.)*

6. **Native-addon packaging.** esbuild cannot inline a `.node` → mark external. The
   addon's owning package must be in the consumer's `node_modules` for `require()`/
   `import()` to resolve; since mcp-server re-bundles the *unpublished* backend
   source, the addon must instead be a **published dependency of `voice-tts-mcp`**
   (the koffi precedent) — then no `dist/` copy is needed. `optionalDependencies`
   makes install non-fatal when no prebuild matches the host. *(esbuild #1715/#external;
   tsup auto-externalizes deps; npm optionalDependencies docs; prebuildify/node-gyp-build.)*
