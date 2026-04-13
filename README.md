# voice-mcp

Give your Claude Code agents a voice. A text-to-speech MCP server with 54 unique voices, a real-time web dashboard, and per-agent voice persistence.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![License](https://img.shields.io/badge/License-MIT-blue) ![MCP](https://img.shields.io/badge/MCP-Compatible-purple)

## What it does

- Each Claude Code agent gets a **unique persistent voice** from a pool of 54 Edge TTS neural voices
- Messages **queue and play sequentially** - walk away from your screen and still know what's happening
- **Real-time web dashboard** shows playback timeline, agent settings, and controls
- Works on **Windows, macOS, and Linux** with zero external audio dependencies on Windows

## Quick Start

### Option 1: Add to Claude Code (recommended)

Add to your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "voice-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/voice-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Or add globally via CLI:

```bash
claude mcp add voice-mcp -- node /path/to/voice-mcp/packages/mcp-server/dist/index.js
```

### Option 2: Build from source

```bash
git clone https://github.com/gabenodland/voice-mcp.git
cd voice-mcp
npm install
npm run build
```

Then configure Claude Code to use the built MCP server (see Option 1).

## Available Tools

| Tool | Description |
|------|-------------|
| `voice_speak` | Speak text aloud. Each agent gets a unique persistent voice. |
| `voice_test` | Preview an agent's voice with a test phrase. |
| `voice_ui` | Open the voice control panel in a standalone browser window. |
| `voice_register` | Register or update an agent's voice, speed, and pitch. |
| `voice_agents` | List all registered agents and their voice assignments. |
| `voice_log` | View recent voice activity log. |
| `voice_setup` | Get CLAUDE.md configuration instructions. |

## CLAUDE.md Configuration

Add this to your project's CLAUDE.md to enable voice on every response:

```
**ALWAYS USE VOICE** - call the `voice_speak` MCP tool with every completion or question.
- `agent_name`: pick a name for yourself (e.g. "joe", "main") and reuse it every call.
- Use the SAME agent_name every call so your voice stays consistent.
- Subagents should each pick a distinct name (e.g. "explorer", "tester").
- NEVER use ALL CAPS in voice text - Edge TTS spells them out letter by letter.
- Messages queue up and play one after the next automatically.
```

## Web Dashboard

The voice backend serves a real-time dashboard at `http://localhost:52719`:

- **Now Playing** - shows the current message with agent name, voice, and full text
- **Timeline** - all messages with status indicators, auto-scrolling playback cursor
- **Playback controls** - pause, resume, play/replay via buttons or keyboard shortcuts
- **Agent settings** - slide-out panel to change voice, speed, and pitch per agent
- **Keyboard shortcuts** - Space (pause/resume), M (mute), R (replay last)

## Architecture

```
voice-mcp/
  packages/
    shared/          # Types, constants, voice registry, TCP client
    mcp-server/      # MCP tools (voice_speak, voice_test, etc.)
    voice-backend/   # TCP server, TTS engine, audio player, web UI
```

- **MCP Server** communicates with Claude Code via stdio
- **Voice Backend** runs as a background process, handling TTS and audio playback
- **TCP protocol** connects the MCP server to the backend on port 52718
- **WebSocket** provides real-time state updates to the web dashboard

## Voice Pool

54 neural voices across 14 English locales plus multilingual accents:

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
