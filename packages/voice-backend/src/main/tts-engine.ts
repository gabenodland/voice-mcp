import { EdgeTTS } from "node-edge-tts";
import path from "node:path";
import crypto from "node:crypto";
import { HISTORY_DIR } from "@voice-mcp/shared";
import fs from "node:fs";

// Ensure history dir exists
fs.mkdirSync(HISTORY_DIR, { recursive: true });

export async function synthesize(
  text: string,
  voice: string,
  rate: string,
  pitch: string,
  volume: string,
): Promise<string> {
  const tts = new EdgeTTS({
    voice,
    rate,
    pitch,
    volume,
  });

  const filename = `voice_${crypto.randomBytes(8).toString("hex")}.mp3`;
  const outputPath = path.join(HISTORY_DIR, filename);
  await tts.ttsPromise(text, outputPath);
  return outputPath;
}

/**
 * Clean up old MP3 files from the history directory.
 * Removes files older than maxAgeMs (default 1 hour).
 */
export function cleanupOldFiles(maxAgeMs = 3600000): void {
  try {
    const files = fs.readdirSync(HISTORY_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith(".mp3")) continue;
      const filePath = path.join(HISTORY_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore individual file errors
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Run cleanup every 30 minutes
setInterval(() => cleanupOldFiles(), 30 * 60 * 1000);
