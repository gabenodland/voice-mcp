#!/usr/bin/env node

// Backend entry point — bundled into the npm package alongside the MCP server.
// This is what the MCP server's launcher spawns to run TTS + audio playback.

export { startTcpServer } from "../../voice-backend/src/main/tcp-server.js";
export { startWebUI } from "../../voice-backend/src/main/web-ui.js";

import { startTcpServer } from "../../voice-backend/src/main/tcp-server.js";
import { startWebUI } from "../../voice-backend/src/main/web-ui.js";
import { VOICE_SERVER_PORT, WEB_UI_PORT, HISTORY_DIR, DATA_DIR } from "../../shared/src/constants.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __bundled_dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(__bundled_dirname, "renderer");
import net from "node:net";
import { execSync } from "node:child_process";

const ERROR_LOG = path.join(DATA_DIR, "voice_backend_errors.log");

function logError(msg: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(ERROR_LOG, `[${ts}] ${msg}\n`);
  } catch { /* best-effort */ }
}

process.on("uncaughtException", (err) => {
  logError(`Uncaught exception: ${err.stack ?? err.message}`);
  console.error("voice-tts-backend: Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
  console.error("voice-tts-backend: Unhandled rejection:", reason);
});

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, "127.0.0.1");
  });
}

function killPortHolder(port: number): void {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" });
      const match = output.match(/LISTENING\s+(\d+)/);
      if (match) {
        execSync(`taskkill /F /PID ${match[1]}`, { stdio: "ignore" });
        console.log(`voice-tts-backend: Killed zombie process (PID ${match[1]}) on port ${port}`);
      }
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
      if (output) {
        execSync(`kill -9 ${output}`, { stdio: "ignore" });
        console.log(`voice-tts-backend: Killed zombie process (PID ${output}) on port ${port}`);
      }
    }
  } catch {
    // No process to kill
  }
}

async function main() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`voice-tts-backend: Starting...`);

  const inUse = await isPortInUse(VOICE_SERVER_PORT);
  if (inUse) {
    console.log(`voice-tts-backend: Port ${VOICE_SERVER_PORT} in use, attempting zombie cleanup...`);
    killPortHolder(VOICE_SERVER_PORT);
    await new Promise((r) => setTimeout(r, 500));
  }

  startTcpServer(VOICE_SERVER_PORT);
  startWebUI(WEB_UI_PORT, RENDERER_DIR);

  console.log(`voice-tts-backend: TCP server on port ${VOICE_SERVER_PORT}`);
  console.log(`voice-tts-backend: Web UI at http://localhost:${WEB_UI_PORT}`);
  console.log(`voice-tts-backend: Ready.`);
}

main().catch((err) => {
  logError(`Startup error: ${err.stack ?? err.message}`);
  console.error("voice-tts-backend: Startup error:", err);
  process.exit(1);
});

process.on("SIGINT", () => { console.log("voice-tts-backend: Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("voice-tts-backend: Shutting down..."); process.exit(0); });
