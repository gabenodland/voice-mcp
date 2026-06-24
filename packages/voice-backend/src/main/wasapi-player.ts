import fs from "node:fs";
import { MPEGDecoder } from "mpg123-decoder";
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";
import type { DevicePref } from "@voice-mcp/shared";
import { WindowsMCIPlayer } from "./mci-player.js";
import { loadAudify, pickDevice, savePref, isWasapiDisabled, mapOutputDevices, WASAPI_API, getLeadInMs, leadInFrameCount } from "./audio-device.js";
import { monoToInterleavedStereo, interleaveChannels, sliceIntoFrames, generateSine } from "./pcm-utils.js";

const FORMAT_FLOAT32 = 0x10; // RtAudioFormat.RTAUDIO_FLOAT32
const FRAME_SIZE = 480;      // ~20ms @ 24kHz — spike-confirmed
const LOOKAHEAD_FRAMES = 4;  // bounded look-ahead — spike-confirmed
const SAMPLE_RATE = 24000;
const CHANNELS = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One zeroed stereo float32 frame, reused for the lead-in. READ-ONLY: it is only ever
// passed to rt.write() (same treatment as decoded frames in the pump), never mutated.
const SILENT_FRAME: Buffer = Buffer.alloc(FRAME_SIZE * CHANNELS * 4);

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
      const chosen = pickDevice(mapOutputDevices(rt), this.pref);
      if (!chosen) throw new Error(`device not found: ${this.pref.name}`);
      if (chosen.id !== this.pref.hintDeviceId) savePref({ name: chosen.name, hintDeviceId: chosen.id });

      const stereo = await decodeAsync(filepath);
      const lead = leadInFrameCount(getLeadInMs());
      this.frames = Array.from({ length: lead }, () => SILENT_FRAME)
        .concat(sliceIntoFrames(stereo, FRAME_SIZE, CHANNELS));
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
      // A native write/stream error must still settle play() — otherwise the
      // awaited play() never resolves and the playback queue deadlocks.
      console.error("voice-mcp-backend: WASAPI pump error:", err);
    } finally {
      this.settle();
    }
  }

  /** Idempotent: cleans up, resolves the pending play() exactly once. */
  private settle(): void {
    this.cleanupStream();
    this.frames = []; // free the decoded PCM; a fresh player is created per utterance
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
        // Spec order: discard the queue, stop, then close (stop drains, so clear first).
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
  const chosen = pickDevice(mapOutputDevices(rt), { name: deviceName });
  if (!chosen) return;

  const lead = leadInFrameCount(getLeadInMs());
  const frames = Array.from({ length: lead }, () => SILENT_FRAME)
    .concat(sliceIntoFrames(monoToInterleavedStereo(generateSine(440, 0.4, SAMPLE_RATE)), FRAME_SIZE, CHANNELS));
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
