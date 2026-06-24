import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommand } from "../../shared/src/tcp-client.js";
import { registry } from "../../shared/src/index.js";
import { VOICE_POOL, SPEED_PRESETS, TONE_PRESETS } from "../../shared/src/voice-pool.js";
import { LOG_FILE, DATA_DIR, DEFAULT_RATE, WEB_UI_PORT } from "../../shared/src/constants.js";
import { exec } from "node:child_process";
import { appendLog } from "./logger.js";
import { ensureBackend } from "./launcher.js";
import type { TcpResponse, AgentsResponse, StatusResponse, OkResponse, ErrorResponse, DevicesResponse } from "../../shared/src/types.js";
import fs from "node:fs";

function validateRate(rate: string): string {
  const match = rate.match(/^([+-]?\d{1,3})%$/);
  if (!match) return DEFAULT_RATE;
  const val = parseInt(match[1], 10);
  if (val < -50 || val > 200) return DEFAULT_RATE;
  return rate;
}

function validateVolume(volume: string): string {
  const match = volume.match(/^([+-]?\d{1,3})%$/);
  if (!match) return "+0%";
  const val = parseInt(match[1], 10);
  if (val < -50 || val > 50) return "+0%";
  return volume;
}

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
    "Speak text aloud using text-to-speech. Each agent gets a unique persistent voice. IMPORTANT: Never use ALL CAPS for emphasis — Edge TTS will spell out capitalized words letter by letter (e.g. 'NO' becomes 'N. O.'). Use normal casing only.",
    {
      text: z.string().describe("The text to speak aloud. Use normal casing — never ALL CAPS (Edge TTS spells them out letter by letter)"),
      agent_name: z.string().optional().describe("Agent name for voice assignment (defaults to 'default')"),
      voice: z.string().optional().describe("Override voice (e.g., 'en-US-AriaNeural')"),
      rate: z.string().optional().describe("Speech rate (e.g., '+25%', 'fast', 'slow')"),
      pitch: z.string().optional().describe("Voice pitch (e.g., '+10Hz', 'high', 'low')"),
      volume: z.string().optional().describe("Volume adjustment (e.g., '+50%', '-50%'). Range: -50% to +50%"),
    },
    async ({ text, agent_name, voice, rate, pitch, volume }) => {
      const agent = agent_name ?? "default";
      const validatedRate = rate ? validateRate(rate) : undefined;
      const validatedVolume = volume ? validateVolume(volume) : undefined;

      const response = await sendOrLaunch({
        cmd: "speak",
        text,
        agent,
        voice,
        rate: validatedRate,
        pitch,
        volume: validatedVolume,
        _rate_explicit: rate !== undefined,
        _pitch_explicit: pitch !== undefined,
      });

      if (!response) {
        return errorText(
          "Voice backend is not running. It will auto-start on the next voice_speak call.\n" +
          "If this persists, reinstall with: npm install -g voice-tts-mcp"
        );
      }

      if (!response.ok) {
        return errorText(`Voice error: ${(response as any).error}`);
      }

      const result = `[${agent}] ${(response as any).label ?? ""}: ${text}`;
      appendLog("voice_speak", agent, text, validatedRate, result);
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
      const count = Math.max(1, Math.min(lines ?? 20, 100));
      try {
        const data = fs.readFileSync(LOG_FILE, "utf-8");
        const allLines = data.trim().split("\n").filter(Boolean);
        const recent = allLines.slice(-count);
        if (recent.length === 0) return okText("No voice activity logged yet.");

        const formatted = recent.map((line) => {
          try {
            const entry = JSON.parse(line);
            const ts = entry.ts?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
            const text = entry.text?.length > 60 ? entry.text.slice(0, 60) + "..." : entry.text;
            return `[${ts}] ${entry.agent_name} | ${text}`;
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
    "Register or update a voice assignment for an agent. Assigns a unique voice from the 55-voice pool.",
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
    "Get setup instructions and configuration for voice-tts-mcp.",
    {},
    async () => {
      return okText(
`# Voice MCP Setup

## MCP Configuration
Add to your editor's MCP settings (e.g. .vscode/mcp.json):
\`\`\`json
{
  "servers": {
    "voice-tts-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "voice-tts-mcp"]
    }
  }
}
\`\`\`

## Voice Rule
Paste this into your project's AI instructions file (CLAUDE.md, .cursorrules, etc.):
\`\`\`
**ALWAYS USE VOICE** — MANDATORY: call the \`voice_speak\` MCP tool with every completion or question.
- \`agent_name\`: pick a name for yourself (e.g. "joe", "main", "narrator") and reuse it every call.
  Changing the name changes your voice. Subagents should each pick a distinct name (e.g. "explorer", "tester").
- CRITICAL: Use the SAME agent_name every call so your voice stays consistent.
- NEVER use ALL CAPS in voice text — Edge TTS spells them out letter by letter (e.g. "NO" → "N. O."). Use normal casing.
- Messages queue up and play one after the next automatically.
\`\`\`

## Available Tools
- **voice_speak** — Speak text aloud (each agent gets a unique voice)
- **voice_test** — Preview an agent's voice with a test phrase
- **voice_ui** — Open the voice control panel window
- **voice_log** — View recent voice activity
- **voice_register** — Register/update agent voice settings
- **voice_agents** — List all agents and their voices
- **voice_setup** — This help text
- **voice_devices** — List/select the audio output device (Windows)
`
      );
    },
  );

  // ── voice_test ───────────────────────────────────────────────────────
  server.tool(
    "voice_test",
    "Preview an agent's voice. Plays a test phrase so you can hear how the agent sounds with current settings.",
    {
      agent_name: z.string().describe("Agent name to test (must be already registered)"),
    },
    async ({ agent_name }) => {
      const response = await sendOrLaunch({
        cmd: "test_voice",
        agent_name,
      });

      if (!response) {
        return errorText(
          "Voice backend is not running. It will auto-start on the next voice_speak call.\n" +
          "If this persists, reinstall with: npm install -g voice-tts-mcp"
        );
      }

      if (!response.ok) {
        return errorText(`Voice error: ${(response as any).error}`);
      }

      return okText((response as any).message ?? `Testing voice for agent "${agent_name}"`);
    },
  );

  // ── voice_ui ─────────────────────────────────────────────────────────
  server.tool(
    "voice_ui",
    "Open the voice control panel in a browser window. Shows playback history, agent settings, and controls.",
    {},
    async () => {
      // Make sure backend is running first
      await sendOrLaunch({ cmd: "status" });

      const url = `http://localhost:${WEB_UI_PORT}`;
      try {
        if (process.platform === "win32") {
          exec(`start "" msedge --app="${url}" --window-size=650,700`, (err) => {
            if (err) {
              exec(`start "" chrome --app="${url}" --window-size=650,700`, (err2) => {
                if (err2) exec(`start "" "${url}"`);
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
        return errorText(`Could not open browser. Visit ${url} manually.`);
      }

      return okText(`Voice control panel opened at ${url}`);
    },
  );

  // ── voice_mute ───────────────────────────────────────────────────────
  server.tool(
    "voice_mute",
    "Mute all voice output. Stops current playback immediately and silences all queued messages.",
    {},
    async () => {
      const response = await sendOrLaunch({ cmd: "mute" });
      if (!response) return errorText("Voice backend is not running.");
      return okText("Voice muted. All audio output is silenced.");
    },
  );

  // ── voice_unmute ─────────────────────────────────────────────────────
  server.tool(
    "voice_unmute",
    "Unmute voice output. Resumes normal playback for new messages.",
    {},
    async () => {
      const response = await sendOrLaunch({ cmd: "unmute" });
      if (!response) return errorText("Voice backend is not running.");
      return okText("Voice unmuted. Audio output resumed.");
    },
  );

  // ── voice_devices ────────────────────────────────────────────────────
  server.tool(
    "voice_devices",
    "List available audio output devices (Windows), or select one. Call with no args to list; pass `select` (a device name, or 'default' for the system default) to choose where voice plays.",
    {
      select: z.string().optional().describe("Device name to use, or 'default' for the system default endpoint"),
    },
    async ({ select }) => {
      if (select !== undefined) {
        const r = (await sendOrLaunch({ cmd: "set_device", name: select })) as OkResponse | ErrorResponse | null;
        if (!r) return errorText("Voice backend is not running.");
        if (!r.ok) {
          // Spec: an unknown name returns the error PLUS the current device list.
          const listed = (await sendOrLaunch({ cmd: "list_devices" })) as DevicesResponse | ErrorResponse | null;
          const names = listed && listed.ok && listed.available
            ? "\n\nAvailable output devices:\n" +
              listed.devices.map((d) => `  ${d.name}${d.isDefault ? " (system default)" : ""}`).join("\n")
            : "";
          return errorText(`${r.error}${names}`);
        }
        return okText(r.message ?? `Output device set to ${select}`);
      }
      const r = (await sendOrLaunch({ cmd: "list_devices" })) as DevicesResponse | ErrorResponse | null;
      if (!r) return errorText("Voice backend is not running.");
      if (!r.ok) return errorText(r.error);
      if (!r.available) {
        return okText(`Output device selection unavailable: ${r.reason}\nActive: ${r.active}`);
      }
      const lines = r.devices.map(
        (d) => `${d.active ? "● " : "  "}${d.name}${d.isDefault ? " (system default)" : ""}`
      );
      return okText(
        `Active output: ${r.active}\n\nAvailable output devices:\n${lines.join("\n")}\n\n` +
        `Use voice_devices with select:"<name>" to choose, or select:"default" to reset.`
      );
    },
  );
}
