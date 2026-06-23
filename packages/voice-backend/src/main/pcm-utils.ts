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
