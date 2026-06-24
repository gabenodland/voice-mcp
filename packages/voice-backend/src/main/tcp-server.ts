import net from "node:net";
import { registry, type TcpCommand, type TcpResponse, type SpeakCommand, type RegisterAgentCommand, type SetVoiceCommand, type TestVoiceCommand, type ReplayItemCommand, type ListDevicesCommand, type SetDeviceCommand, type TestDeviceCommand, type SetLeadInCommand } from "@voice-mcp/shared";
import { listDevices, setDevice, setLeadInMs } from "./audio-device.js";
import { playProbe } from "./wasapi-player.js";
import { playbackQueue } from "./playback-queue.js";
import { getPlayerState } from "./audio-player.js";
import { broadcastState, openBrowserOnce } from "./web-ui.js";
import { WEB_UI_PORT } from "@voice-mcp/shared";

let seqCounter = 0;

function dispatch(command: TcpCommand): TcpResponse {
  switch (command.cmd) {
    case "speak":
      return handleSpeak(command);
    case "status":
      return handleStatus();
    case "agents":
      return handleAgents();
    case "register_agent":
      return handleRegisterAgent(command);
    case "set_voice":
      return handleSetVoice(command);
    case "pause":
      playbackQueue.pause();
      broadcastState();
      return { ok: true, message: "Paused" };
    case "resume":
      playbackQueue.resume();
      broadcastState();
      return { ok: true, message: "Resumed" };
    case "replay":
      playbackQueue.replay();
      broadcastState();
      return { ok: true, message: "Replaying" };
    case "mute":
      playbackQueue.setMuted(true);
      broadcastState();
      return { ok: true, message: "Muted" };
    case "unmute":
      playbackQueue.setMuted(false);
      broadcastState();
      return { ok: true, message: "Unmuted" };
    case "test_voice":
      return handleTestVoice(command as TestVoiceCommand);
    case "replay_item":
      return handleReplayItem(command as ReplayItemCommand);
    case "list_devices":
      return handleListDevices();
    case "set_device":
      return handleSetDevice(command as SetDeviceCommand);
    case "test_device":
      return handleTestDevice(command as TestDeviceCommand);
    case "set_leadin":
      return handleSetLeadIn(command as SetLeadInCommand);
    default:
      return { ok: false, error: `Unknown command: ${(command as any).cmd}` };
  }
}

function handleSpeak(cmd: SpeakCommand): TcpResponse {
  openBrowserOnce(WEB_UI_PORT);

  const assignment = registry.getVoice(cmd.agent);
  const voice = cmd.voice ?? assignment.voice;
  const label = assignment.label;

  // Use explicit caller values when provided; otherwise fall back to per-agent settings
  const rate = cmd._rate_explicit ? (cmd.rate ?? assignment.rate) : assignment.rate;
  const pitch = cmd._pitch_explicit ? (cmd.pitch ?? assignment.pitch) : assignment.pitch;

  const seq = ++seqCounter;
  const text = cmd.text.replace(/\\(.)/g, "$1"); // Strip single-char backslash escapes

  playbackQueue.enqueue({
    text,
    agent: cmd.agent,
    voice,
    label,
    rate,
    pitch,
    volume: cmd.volume ?? "+0%",
    seq,
  });

  broadcastState();
  return { ok: true, voice, label };
}

function handleStatus(): TcpResponse {
  const state = getPlayerState();
  return {
    ok: true,
    state: state.state,
    agent: state.currentAgent,
    text: state.currentText,
    muted: playbackQueue.isMuted(),
    queue_size: playbackQueue.size(),
  };
}

function handleAgents(): TcpResponse {
  const agents = registry.getAllAgents();
  return { ok: true, agents };
}

function handleRegisterAgent(cmd: RegisterAgentCommand): TcpResponse {
  registry.registerVoice(cmd.agent_name, cmd.voice, cmd.rate, cmd.pitch);
  broadcastState();
  return { ok: true, message: `Agent "${cmd.agent_name}" registered` };
}

function handleSetVoice(cmd: SetVoiceCommand): TcpResponse {
  const result = registry.setVoice(cmd.agent_name, cmd.voice);
  if (!result) return { ok: false, error: `Voice "${cmd.voice}" not found` };
  broadcastState();
  return { ok: true, message: `Voice set to ${result.label}` };
}

function handleTestVoice(cmd: TestVoiceCommand): TcpResponse {
  const agents = registry.getAllAgents();
  const agent = agents.find((a) => a.agent_name === cmd.agent_name);
  if (!agent) {
    return { ok: false, error: `Agent "${cmd.agent_name}" not found. Register it first with voice_register.` };
  }

  const testText = `I am ${cmd.agent_name} using the voice ${agent.label}. This is how I sound with the current settings.`;
  const seq = ++seqCounter;

  playbackQueue.enqueue({
    text: testText,
    agent: cmd.agent_name,
    voice: agent.voice,
    label: agent.label,
    rate: agent.rate,
    pitch: agent.pitch,
    volume: "+0%",
    seq,
  });

  broadcastState();
  return { ok: true, message: `Testing voice for "${cmd.agent_name}": ${agent.label} (rate: ${agent.rate}, pitch: ${agent.pitch})` };
}

function handleReplayItem(cmd: ReplayItemCommand): TcpResponse {
  const found = playbackQueue.replayItem(cmd.item_id);
  if (!found) return { ok: false, error: "Item not found or has no audio" };
  broadcastState();
  return { ok: true, message: "Replaying item" };
}

function handleListDevices(): TcpResponse {
  const r = listDevices();
  return { ok: true, available: r.available, leadInAvailable: r.leadInAvailable,
    leadInMs: r.leadInMs, reason: r.reason, active: r.active, devices: r.devices };
}

function handleSetDevice(cmd: SetDeviceCommand): TcpResponse {
  const r = setDevice(cmd.name);
  if (!r.ok) return { ok: false, error: r.error ?? "Failed to set device" };
  broadcastState(); // only on success — setDevice already invalidated the device cache
  return { ok: true, message: `Output device set to ${r.active}` };
}

function handleTestDevice(cmd: TestDeviceCommand): TcpResponse {
  // Fire-and-forget: do NOT await drain, so dispatch() stays synchronous.
  void playProbe(cmd.name).catch((err) => console.error("voice-mcp-backend: test_device error:", err));
  return { ok: true, message: `Testing device: ${cmd.name}` };
}

function handleSetLeadIn(cmd: SetLeadInCommand): TcpResponse {
  const r = setLeadInMs(cmd.ms);
  broadcastState();
  return { ok: true, message: `Lead-in set to ${r.leadInMs} ms` };
}

const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB safety cap

export function startTcpServer(port: number): net.Server {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    socket.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_REQUEST_SIZE) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });

    socket.on("end", () => {
      try {
        const data = Buffer.concat(chunks).toString("utf-8");
        const command = JSON.parse(data) as TcpCommand;
        const response = dispatch(command);
        socket.write(JSON.stringify(response));
      } catch (err) {
        const errResponse: TcpResponse = {
          ok: false,
          error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        };
        socket.write(JSON.stringify(errResponse));
      }
      socket.end();
    });

    socket.on("error", (err) => {
      console.error("voice-mcp-backend: TCP socket error:", err.message);
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`voice-mcp-backend: Port ${port} already in use. Another instance may be running.`);
      process.exit(1);
    }
    console.error("voice-mcp-backend: TCP server error:", err);
  });

  server.listen(port, "127.0.0.1");
  return server;
}
