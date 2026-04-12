import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { playbackQueue } from "./playback-queue.js";
import { getPlayerState } from "./audio-player.js";
import { registry, VOICE_POOL, SPEED_PRESETS, TONE_PRESETS } from "@voice-mcp/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectedClients = new Set<WebSocket>();

export function startWebUI(port: number) {
  const app = express();
  const httpServer = createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    connectedClients.add(ws);

    // Send initial state
    ws.send(JSON.stringify({
      type: "state",
      data: getFullState(),
    }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleWsMessage(msg);
      } catch {
        // Ignore bad messages
      }
    });

    ws.on("close", () => {
      connectedClients.delete(ws);
    });
  });

  // Serve static renderer files
  const rendererDir = path.resolve(__dirname, "../renderer");
  app.use(express.static(rendererDir));

  // API endpoint for voice data
  app.get("/api/voices", (_req, res) => {
    res.json({
      voices: VOICE_POOL,
      speedPresets: SPEED_PRESETS,
      tonePresets: TONE_PRESETS,
    });
  });

  app.get("/api/state", (_req, res) => {
    res.json(getFullState());
  });

  httpServer.listen(port, "127.0.0.1");
}

function getFullState() {
  const playerState = getPlayerState();
  const queueState = playbackQueue.getState();
  const agents = registry.getAllAgents();

  return {
    player: playerState,
    queue: {
      items: queueState.items,
      playQueue: queueState.playQueue,
      history: queueState.history,
      muted: queueState.muted,
      paused: queueState.paused,
      queueSize: queueState.queueSize,
    },
    agents,
  };
}

function handleWsMessage(msg: { action: string; [key: string]: any }) {
  switch (msg.action) {
    case "pause":
      playbackQueue.pause();
      break;
    case "resume":
      playbackQueue.resume();
      break;
    case "replay":
      playbackQueue.replay();
      break;
    case "mute":
      playbackQueue.setMuted(true);
      break;
    case "unmute":
      playbackQueue.setMuted(false);
      break;
    case "set_voice":
      if (msg.agent_name && msg.voice) {
        registry.setVoice(msg.agent_name, msg.voice);
      }
      break;
    case "set_param":
      if (msg.agent_name && msg.key && msg.value) {
        registry.setAgentParam(msg.agent_name, msg.key, msg.value);
      }
      break;
    case "purge_stale":
      registry.purgeStale();
      break;
  }
  broadcastState();
}

export function broadcastState() {
  const state = getFullState();
  const msg = JSON.stringify({ type: "state", data: state });
  for (const ws of connectedClients) {
    try {
      ws.send(msg);
    } catch {
      connectedClients.delete(ws);
    }
  }
}
