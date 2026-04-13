# voice-tts-mcp

Give your AI coding agents a voice. A text-to-speech MCP server with 55 unique neural voices, a real-time web dashboard, and per-agent voice persistence.

Works with any MCP-compatible tool: Claude Code, VS Code, Cursor, Windsurf, and more.

![npm](https://img.shields.io/npm/v/voice-tts-mcp) ![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![License](https://img.shields.io/badge/License-MIT-blue) ![MCP](https://img.shields.io/badge/MCP-Compatible-purple)

## What it does

- Each agent gets a **unique persistent voice** from a pool of 55 Edge TTS neural voices
- Messages **queue and play sequentially** — walk away from your screen and still know what's happening
- **Real-time web dashboard** shows playback timeline, agent settings, and controls
- Works on **Windows, macOS, and Linux** with zero external audio dependencies on Windows

## Quick Start

### VS Code / Cursor / Windsurf

Add to your project's `.vscode/mcp.json`:

**macOS / Linux:**
```json
{
  "servers": {
    "voice-tts-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "voice-tts-mcp"]
    }
  }
}
```

**Windows:**
```json
{
  "servers": {
    "voice-tts-mcp": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "npx", "-y", "voice-tts-mcp"]
    }
  }
}
```

> **Why `cmd /c` on Windows?** Node.js `child_process.spawn()` can't run `npx` directly on Windows because it's a `.cmd` script. Wrapping with `cmd /c` fixes this. This affects all MCP servers, not just this one.

### Claude Code

**macOS / Linux:**
```bash
claude mcp add voice-tts-mcp -s user -- npx -y voice-tts-mcp
```

**Windows:**
```bash
claude mcp add voice-tts-mcp -s user -- cmd /c npx -y voice-tts-mcp
```

### Alternative: Global install (any platform)

If you prefer a global install that works identically everywhere:

```bash
npm install -g voice-tts-mcp
```

Then configure your MCP client with:
```json
{
  "command": "voice-tts-mcp"
}
```

Or for Claude Code:
```bash
claude mcp add voice-tts-mcp -s user -- voice-tts-mcp
```

## Available Tools

| Tool | Description |
|------|-------------|
| `voice_speak` | Speak text aloud. Each agent gets a unique persistent voice. |
| `voice_test` | Preview an agent's voice with a test phrase. |
| `voice_ui` | Open the voice control panel in a standalone browser window. |
| `voice_mute` | Mute all voice output immediately. |
| `voice_unmute` | Unmute voice output. |
| `voice_register` | Register or update an agent's voice, speed, and pitch. |
| `voice_agents` | List all registered agents and their voice assignments. |
| `voice_log` | View recent voice activity log. |
| `voice_setup` | Get configuration instructions. |

## Voice Rule (optional)

Add this to your project's AI instructions file (CLAUDE.md, .cursorrules, etc.) to enable voice on every response:

```
**ALWAYS USE VOICE** — call the `voice_speak` MCP tool with every completion or question.
- `agent_name`: pick a name for yourself (e.g. "joe", "main") and reuse it every call.
- Use the SAME agent_name every call so your voice stays consistent.
- Subagents should each pick a distinct name (e.g. "explorer", "tester").
- NEVER use ALL CAPS in voice text — Edge TTS spells them out letter by letter.
- Messages queue up and play one after the next automatically.
```

## Web Dashboard

The voice backend serves a real-time dashboard at `http://localhost:52719`:

- **Now Playing** — shows the current message with agent name, voice, and full text
- **Timeline** — all messages with status indicators, auto-scrolling playback cursor
- **Playback controls** — pause, resume, play/replay via buttons or keyboard shortcuts
- **Agent settings** — slide-out panel to change voice, speed, and pitch per agent
- **Keyboard shortcuts** — Space (pause/resume), M (mute), R (replay last)

## Architecture

The npm package `voice-tts-mcp` is self-contained — it includes both the MCP server and the voice backend. No additional packages to install.

```
voice-tts-mcp (npm package)
  dist/
    index.js         # MCP server (stdio) — what your editor talks to
    backend-entry.js # Voice backend — TTS, audio, web dashboard
    renderer/        # Web UI static files
```

- **MCP Server** communicates with your editor via stdio
- **Voice Backend** auto-launches as a background process on first `voice_speak` call
- **TCP protocol** connects the MCP server to the backend on port 52718
- **WebSocket** provides real-time state updates to the web dashboard on port 52719

## Voice Pool

55 neural voices across 14 English locales plus multilingual accents:

- US (17), UK (5), Australia (3), Canada (2), Ireland (2), India (3)
- New Zealand (2), Hong Kong (2), Philippines (2), Singapore (2)
- Kenya (2), Nigeria (2), Tanzania (2), South Africa (2)
- Multilingual accents: German, French, Italian, Korean, Brazilian

## Platform Support

| Platform | Audio Backend | Dependencies |
|----------|--------------|--------------|
| Windows | WinMM (MCI) via koffi | None |
| macOS | afplay | None (built-in) |
| Linux | ffplay / mpv / paplay | One of: ffmpeg, mpv, or pulseaudio |

## Requirements

- Node.js 18+
- Internet connection (for Edge TTS)

## Building from source

```bash
git clone https://github.com/gabenodland/voice-mcp.git
cd voice-mcp
npm install
npm run build
```

## License

MIT
