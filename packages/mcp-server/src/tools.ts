import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommand } from "../../shared/src/tcp-client.js";
import { registry } from "../../shared/src/index.js";
import { VOICE_POOL, SPEED_PRESETS, TONE_PRESETS } from "../../shared/src/voice-pool.js";
import { LOG_FILE, DATA_DIR } from "../../shared/src/constants.js";
import { appendLog } from "./logger.js";
import { ensureBackend } from "./launcher.js";
import type { TcpResponse, AgentsResponse, StatusResponse } from "../../shared/src/types.js";
import fs from "node:fs";

function errorText(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function okText(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

async function sendOrLaunch(command: Parameters<typeof sendCommand>[0]): Promise<TcpResponse | null> {
  let response = await sendCommand(command);
  if (response === null) {
    // Backend not running — try to launch it
    ensureBackend();
    // Wait briefly for backend to start, then retry
    await new Promise((r) => setTimeout(r, 2000));
    response = await sendCommand(command);
  }
  return response;
}

export function registerTools(server: McpServer) {
  // ── voice_speak ──────────────────────────────────────────────────────
  server.tool(
    "voice_speak",
    "Speak text aloud using text-to-speech. Each agent gets a unique persistent voice.",
    {
      text: z.string().describe("The text to speak aloud"),
      agent_name: z.string().optional().describe("Agent name for voice assignment (defaults to 'default')"),
      voice: z.string().optional().describe("Override voice (e.g., 'en-US-AriaNeural')"),
      rate: z.string().optional().describe("Speech rate (e.g., '+25%', 'fast', 'slow')"),
      pitch: z.string().optional().describe("Voice pitch (e.g., '+10Hz', 'high', 'low')"),
    },
    async ({ text, agent_name, voice, rate, pitch }) => {
      const agent = agent_name ?? "default";

      const response = await sendOrLaunch({
        cmd: "speak",
        text,
        agent,
        voice,
        rate,
        pitch,
      });

      if (!response) {
        return errorText(
          "Voice backend is not running. Start it with: npx voice-mcp-backend\n" +
          "Or it will auto-start on the next attempt."
        );
      }

      if (!response.ok) {
        return errorText(`Voice error: ${(response as any).error}`);
      }

      const result = `[${agent}] ${(response as any).label ?? ""}: ${text}`;
      appendLog("voice_speak", agent, text, rate, result);
      return okText(result);
    },
  );

  // ── voice_log ────────────────────────────────────────────────────────
  server.tool(
    "voice_log",
    "Read the voice activity log. Shows recent voice_speak calls with timestamps.",
    {
      lines: z.number().optional().describe("Number of recent log lines to return (default 20)"),
    },
    async ({ lines }) => {
      const count = lines ?? 20;
      try {
        const data = fs.readFileSync(LOG_FILE, "utf-8");
        const allLines = data.trim().split("\n").filter(Boolean);
        const recent = allLines.slice(-count);
        if (recent.length === 0) return okText("No voice activity logged yet.");

        const formatted = recent.map((line) => {
          try {
            const entry = JSON.parse(line);
            return `[${entry.ts}] ${entry.tool} | ${entry.agent_name} | ${entry.text}`;
          } catch {
            return line;
          }
        });
        return okText(formatted.join("\n"));
      } catch {
        return okText("No voice activity logged yet.");
      }
    },
  );

  // ── voice_register ───────────────────────────────────────────────────
  server.tool(
    "voice_register",
    "Register or update a voice assignment for an agent. Assigns a unique voice from the 54-voice pool.",
    {
      agent_name: z.string().describe("The agent name to register"),
      voice: z.string().optional().describe("Specific voice to assign (e.g., 'en-US-AriaNeural')"),
      rate: z.string().optional().describe("Speech rate (e.g., '+25%')"),
      pitch: z.string().optional().describe("Voice pitch (e.g., '+10Hz')"),
    },
    async ({ agent_name, voice, rate, pitch }) => {
      const assignment = registry.registerVoice(agent_name, voice, rate, pitch);

      // Also notify the backend if running
      await sendCommand({
        cmd: "register_agent",
        agent_name,
        voice: assignment.voice,
        rate: assignment.rate,
        pitch: assignment.pitch,
      });

      return okText(
        `Registered agent "${agent_name}" with voice ${assignment.label} ` +
        `(rate: ${assignment.rate}, pitch: ${assignment.pitch})`
      );
    },
  );

  // ── voice_agents ─────────────────────────────────────────────────────
  server.tool(
    "voice_agents",
    "List all registered voice agents and their voice assignments.",
    {},
    async () => {
      const agents = registry.getAllAgents();
      if (agents.length === 0) {
        return okText("No agents registered yet. Use voice_speak or voice_register to assign voices.");
      }

      const lines = agents.map(
        (a) => `${a.agent_name}: ${a.label} (rate: ${a.rate}, pitch: ${a.pitch}) — last used: ${a.last_used}`
      );

      return okText(
        `Registered agents (${agents.length}):\n` + lines.join("\n") +
        `\n\nAvailable voices: ${VOICE_POOL.length}\n` +
        `Speed presets: ${SPEED_PRESETS.join(", ")}\n` +
        `Tone presets: ${TONE_PRESETS.join(", ")}`
      );
    },
  );

  // ── voice_setup ──────────────────────────────────────────────────────
  server.tool(
    "voice_setup",
    "Get setup instructions and CLAUDE.md configuration for voice-mcp.",
    {},
    async () => {
      return okText(
`# Voice MCP Setup

## MCP Configuration
Add to your Claude Code settings:
\`\`\`json
{
  "mcpServers": {
    "voice": {
      "command": "npx",
      "args": ["-y", "voice-mcp"]
    }
  }
}
\`\`\`

## CLAUDE.md Voice Instructions
Add to your project CLAUDE.md:
\`\`\`
## Voice
You have voice capabilities via the voice MCP tools.
- Use voice_speak to read important output aloud
- Use voice_register at the start to set your agent name
- Each agent gets a unique persistent voice
- Use voice_agents to see all registered agents
\`\`\`

## Available Tools
- **voice_speak** — Speak text aloud (each agent gets a unique voice)
- **voice_log** — View recent voice activity
- **voice_register** — Register/update agent voice settings
- **voice_agents** — List all agents and their voices
- **voice_setup** — This help text
`
      );
    },
  );
}
