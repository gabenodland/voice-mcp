#!/usr/bin/env node

import { startTcpServer } from "./tcp-server.js";
import { startWebUI } from "./web-ui.js";
import { VOICE_SERVER_PORT, WEB_UI_PORT, HISTORY_DIR, DATA_DIR } from "@voice-mcp/shared";
import fs from "node:fs";
import path from "node:path";
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

// Redirect uncaught errors to log file
process.on("uncaughtException", (err) => {
  logError(`Uncaught exception: ${err.stack ?? err.message}`);
  console.error("voice-mcp-backend: Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason}`);
  console.error("voice-mcp-backend: Unhandled rejection:", reason);
});

// Single-instance guard: check if port is already in use
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

// Kill zombie process holding the port
function killPortHolder(port: number): void {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" });
      const match = output.match(/LISTENING\s+(\d+)/);
      if (match) {
        execSync(`taskkill /F /PID ${match[1]}`, { stdio: "ignore" });
        console.log(`voice-mcp-backend: Killed zombie process (PID ${match[1]}) on port ${port}`);
      }
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf-8" }).trim();
      if (output) {
        execSync(`kill -9 ${output}`, { stdio: "ignore" });
        console.log(`voice-mcp-backend: Killed zombie process (PID ${output}) on port ${port}`);
      }
    }
  } catch {
    // No process to kill, or kill failed — that's fine
  }
}

async function main() {
  // Ensure directories exist
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`voice-mcp-backend: Starting...`);

  // Single-instance check: if port is in use, try to kill zombie
  const inUse = await isPortInUse(VOICE_SERVER_PORT);
  if (inUse) {
    console.log(`voice-mcp-backend: Port ${VOICE_SERVER_PORT} in use, attempting zombie cleanup...`);
    killPortHolder(VOICE_SERVER_PORT);
    // Wait briefly for port to free up
    await new Promise((r) => setTimeout(r, 500));
  }

  startTcpServer(VOICE_SERVER_PORT);
  startWebUI(WEB_UI_PORT);

  console.log(`voice-mcp-backend: TCP server on port ${VOICE_SERVER_PORT}`);
  console.log(`voice-mcp-backend: Web UI at http://localhost:${WEB_UI_PORT}`);
  console.log(`voice-mcp-backend: Ready.`);
}

main().catch((err) => {
  logError(`Startup error: ${err.stack ?? err.message}`);
  console.error("voice-mcp-backend: Startup error:", err);
  process.exit(1);
});

// Keep process alive
process.on("SIGINT", () => {
  console.log("voice-mcp-backend: Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("voice-mcp-backend: Shutting down...");
  process.exit(0);
});
