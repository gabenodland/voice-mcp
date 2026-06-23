# Spike findings — audio output device (Windows / audify / RtAudio WASAPI)

Run: `npx tsx packages/voice-backend/scripts/spike-wasapi.ts [device-name-substring]`
Validated on the dev machine, Node v25.2.1, audify 1.10.1, mpg123-decoder 1.0.3.

## Results — GATE PASSED

- **audify loaded:** YES — but **must be loaded via `require()` (CJS), NOT an ESM named import.**
  `import { RtAudio } from "audify"` throws `does not provide an export named 'RtAudio'`
  (audify is CommonJS; named exports aren't statically detectable from ESM). The real code
  already loads it via `createRequire` in `audio-device.ts`, so this only affected the spike.
- **Target device used:** `Headphone (Maschine MK3 WDM Audio)` id=134 (audible).
- **Decoded format:** `sampleRate=24000`, **`channels=2`**, `samples=112896`/channel.
  Edge's "mono" clip decodes as **2 channels** → the engine takes the `interleaveChannels`
  branch (already handled in `wasapi-player.ts`), not the mono-duplicate branch.
- **Centered (both ears):** YES.
- **Correct pitch/speed at 24 kHz on the device:** YES — **no JS resample needed.** RtAudio's
  WASAPI backend converts 24 kHz to the device mix rate transparently.
- **frameOutputCallback granularity:** fires per `write()` buffer — `audibleFrames` reached
  exactly `total` (236/236), so one callback per queued frame.
- **Final frameSize used:** 480 (provisional value confirmed).
- **Final look-ahead N used:** 4 (provisional value confirmed).
- **Completion signal that worked:** `audibleFrames >= total` (236/236). Reliable.
- **play resolved exactly once:** YES (`play resolved 1 time(s)`).
- **Pause/resume gate:** prompt stop YES, resumes same phrase YES, resolved exactly once YES.

## Deviations / watch-items for later tasks

1. **audify load = `require()`, never ESM named import.** (Spike fixed; real `audio-device.ts`
   already does this via `createRequire`.)
2. **Edge clips decode as `channels=2`** — `wasapi-player.ts` already routes ≥2 channels through
   `interleaveChannels`; the mono-duplicate path is only for a genuinely 1-channel source (e.g.
   the test-tone probe). No change needed.
3. **Duplicate device names:** this machine has two `LG FULL HD (... NVIDIA ...)` devices
   (id 130 & 132). `pickDevice` matches the first by name; `hintDeviceId` disambiguates within a
   live session. Acceptable known limitation (spec §13 / Appendix A item 3).
4. **Native handle keeps Node's event loop alive** after a clip ends — the spike needs
   `process.exit(0)` to terminate. The long-running backend is meant to stay alive, but **Task 8
   should confirm each play()'s `closeStream()` releases the per-stream native callback so handles
   don't accumulate over many utterances.**
