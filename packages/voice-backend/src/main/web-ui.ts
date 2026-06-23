import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { playbackQueue } from "./playback-queue.js";
import { getPlayerState, playAudio, setCurrentMeta, clearCurrentMeta } from "./audio-player.js";
import { synthesize } from "./tts-engine.js";
import { registry, VOICE_POOL, SPEED_PRESETS, TONE_PRESETS } from "@voice-mcp/shared";
import { listDevices, setDevice } from "./audio-device.js";
import { playProbe } from "./wasapi-player.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectedClients = new Set<WebSocket>();
let browserOpened = false;

export function openBrowserOnce(port: number): void {
  if (browserOpened) return;
  browserOpened = true;
  const url = `http://localhost:${port}`;
  try {
    if (process.platform === "win32") {
      // Try Edge/Chrome --app mode for a clean standalone window (no tabs/address bar)
      exec(`start "" msedge --app="${url}" --window-size=650,700`, (err) => {
        if (err) {
          exec(`start "" chrome --app="${url}" --window-size=650,700`, (err2) => {
            if (err2) {
              // Fall back to default browser
              exec(`start "" "${url}"`);
            }
          });
        }
      });
    } else if (process.platform === "darwin") {
      exec(`open -a "Google Chrome" --args --app="${url}" --window-size=650,700`, (err) => {
        if (err) exec(`open "${url}"`);
      });
    } else {
      exec(`google-chrome --app="${url}" --window-size=650,700 2>/dev/null || xdg-open "${url}"`);
    }
  } catch {
    // Best-effort
  }
}

export function startWebUI(port: number, rendererOverride?: string) {
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
  const rendererDir = rendererOverride ?? path.resolve(__dirname, "../renderer");
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

  // Periodic state broadcast — keeps UI in sync with playback state
  // like the Python version's 250ms _poll_state() loop
  setInterval(() => {
    if (connectedClients.size > 0) {
      broadcastState();
    }
  }, 250);
}

function getFullState() {
  const playerState = getPlayerState();
  const queueState = playbackQueue.getState();
  const agents = registry.getAllAgents();
  const staleCount = registry.countStale();

  return {
    player: playerState,
    queue: {
      items: queueState.items,
      playQueue: queueState.playQueue,
      history: queueState.history,
      timeline: queueState.timeline,
      muted: queueState.muted,
      paused: queueState.paused,
      queueSize: queueState.queueSize,
    },
    agents,
    staleCount,
    audioDevices: listDevices(),
  };
}

async function handleWsMessage(msg: { action: string; [key: string]: any }) {
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
    case "test_voice":
      if (msg.agent_name) {
        const agent = registry.getAllAgents().find((a: any) => a.agent_name === msg.agent_name);
        if (agent) {
          const testText = `I am ${msg.agent_name} using the voice ${agent.label}. This is how I sound with the current settings.`;
          try {
            const audioPath = await synthesize(testText, agent.voice, agent.rate, agent.pitch, "+0%");
            setCurrentMeta(msg.agent_name, testText);
            broadcastState();
            await playAudio(audioPath);
            clearCurrentMeta();
          } catch (err) {
            console.error("voice-mcp-backend: Test voice error:", err);
          }
        }
      }
      break;
    case "replay_item":
      if (msg.item_id) {
        playbackQueue.replayItem(msg.item_id);
      }
      break;
    case "set_device":
      if (typeof msg.name === "string") setDevice(msg.name);
      break;
    case "test_device":
      if (typeof msg.name === "string") void playProbe(msg.name).catch(() => {});
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
