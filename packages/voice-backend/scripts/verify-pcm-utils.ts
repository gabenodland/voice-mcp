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
