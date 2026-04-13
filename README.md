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

### Install

```bash
npm install -g voice-tts-mcp
```

### VS Code / Cursor / Windsurf

Add to your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "voice-tts-mcp": {
      "type": "stdio",
      "command": "voice-tts-mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add voice-tts-mcp -s user -- voice-tts-mcp
```

### Any MCP client

The server runs over stdio. Point your MCP client at:

```
voice-tts-mcp
```

Restart your editor and ask the AI to "say hello using voice_speak".

### Build from source

```bash
git clone https://github.com/gabenodland/voice-mcp.git
cd voice-mcp
npm install
npm run build
```

Then point your MCP client at the built entry:

```bash
node /path/to/voice-mcp/packages/mcp-server/dist/index.js
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

```
voice-mcp/
  packages/
    shared/          # Types, constants, voice registry, TCP client
    mcp-server/      # MCP tools (published to npm as voice-tts-mcp)
    voice-backend/   # TCP server, TTS engine, audio player, web UI
```

- **MCP Server** communicates with your editor via stdio
- **Voice Backend** runs as a background process, handling TTS and audio playback
- **TCP protocol** connects the MCP server to the backend on port 52718
- **WebSocket** provides real-time state updates to the web dashboard

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

## License

MIT
