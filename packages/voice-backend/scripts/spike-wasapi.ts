// packages/voice-backend/scripts/spike-wasapi.ts
// Throwaway. Run: npx tsx packages/voice-backend/scripts/spike-wasapi.ts
import { MPEGDecoder } from "mpg123-decoder";
import { EdgeTTS } from "node-edge-tts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// audify is CommonJS; its named exports are not statically detectable from ESM,
// so load it via require() (mirrors how audio-device.ts loads it in the real code).
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

  // Pick the device named on the command line (case-insensitive substring match),
  // else the first NON-default device, else the default.
  const want = (process.argv[2] ?? "").toLowerCase();
  const target = (want ? devices.find((d) => d.name.toLowerCase().includes(want)) : undefined)
    ?? devices.find((d) => !d.isDefaultOutput)
    ?? devices[0];
  console.log(`\nTARGET: id=${target.id} "${target.name}"${want ? ` (matched "${process.argv[2]}")` : ""}\n`);

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
