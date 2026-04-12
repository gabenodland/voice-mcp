#!/usr/bin/env node

import { startTcpServer } from "./tcp-server.js";
import { startWebUI } from "./web-ui.js";
import { VOICE_SERVER_PORT, WEB_UI_PORT, HISTORY_DIR } from "@voice-mcp/shared";
import fs from "node:fs";

// Ensure history dir exists
fs.mkdirSync(HISTORY_DIR, { recursive: true });

console.log(`voice-mcp-backend: Starting...`);

startTcpServer(VOICE_SERVER_PORT);
startWebUI(WEB_UI_PORT);

console.log(`voice-mcp-backend: TCP server on port ${VOICE_SERVER_PORT}`);
console.log(`voice-mcp-backend: Web UI at http://localhost:${WEB_UI_PORT}`);
console.log(`voice-mcp-backend: Ready.`);

// Keep process alive
process.on("SIGINT", () => {
  console.log("voice-mcp-backend: Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("voice-mcp-backend: Shutting down...");
  process.exit(0);
});
