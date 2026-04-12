import net from "node:net";
import { registry, type TcpCommand, type TcpResponse, type SpeakCommand, type RegisterAgentCommand, type SetVoiceCommand } from "@voice-mcp/shared";
import { playbackQueue } from "./playback-queue.js";
import { getPlayerState } from "./audio-player.js";
import { broadcastState } from "./web-ui.js";

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
    default:
      return { ok: false, error: `Unknown command: ${(command as any).cmd}` };
  }
}

function handleSpeak(cmd: SpeakCommand): TcpResponse {
  const assignment = registry.getVoice(cmd.agent);
  const voice = cmd.voice ?? assignment.voice;
  const rate = cmd.rate ?? (cmd._rate_explicit ? cmd.rate : assignment.rate);
  const pitch = cmd.pitch ?? (cmd._pitch_explicit ? cmd.pitch : assignment.pitch);
  const label = assignment.label;

  const seq = ++seqCounter;
  const text = cmd.text.replace(/\\(.)/g, "$1"); // Strip single-char backslash escapes

  playbackQueue.enqueue({
    text,
    agent: cmd.agent,
    voice,
    label,
    rate: rate ?? assignment.rate,
    pitch: pitch ?? assignment.pitch,
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

export function startTcpServer(port: number): net.Server {
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];

    socket.on("data", (chunk: Buffer) => {
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
