import { spawn, type ChildProcess } from "node:child_process";
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";
import { WindowsMCIPlayer } from "./mci-player.js";
import { WindowsWasapiPlayer } from "./wasapi-player.js";
import { getConfiguredDevice } from "./audio-device.js";

// Global player state
let currentPlayer: AudioPlayerBackend | null = null;
let currentAgent: string | null = null;
let currentText: string | null = null;

export function getPlayerState() {
  return {
    state: currentPlayer?.state ?? "stopped",
    currentAgent,
    currentText,
  };
}

export function setCurrentMeta(agent: string, text: string) {
  currentAgent = agent;
  currentText = text;
}

export function clearCurrentMeta() {
  currentAgent = null;
  currentText = null;
}

export async function playAudio(filepath: string): Promise<void> {
  // Stop any currently playing audio
  stopAudio();

  const player = createPlayer();
  currentPlayer = player;
  await player.play(filepath);
  // Only clear if a newer utterance hasn't already replaced us. A WASAPI->MCI
  // fallback resolves play() late, after which currentPlayer may point at the
  // next utterance; nulling it then would break that utterance's controls.
  if (currentPlayer === player) currentPlayer = null;
}

export function pauseAudio(): void {
  currentPlayer?.pause();
}

export function resumeAudio(): void {
  currentPlayer?.resume();
}

export function stopAudio(): void {
  if (currentPlayer) {
    currentPlayer.stop();
    currentPlayer = null;
  }
}

function createPlayer(): AudioPlayerBackend {
  if (process.platform === "win32") {
    const pref = getConfiguredDevice(); // null = no specific device / kill-switch → MCI
    if (pref) return new WindowsWasapiPlayer(pref);
    return new WindowsMCIPlayer();
  } else if (process.platform === "darwin") {
    return new MacAfplayPlayer();
  } else {
    return new LinuxPlayer();
  }
}

// ── macOS: afplay ─────────────────────────────────────────────────────

class MacAfplayPlayer implements AudioPlayerBackend {
  private _state: PlayerState = "stopped";
  private proc: ChildProcess | null = null;

  get state() { return this._state; }

  play(filepath: string): Promise<void> {
    return new Promise((resolve) => {
      this.proc = spawn("afplay", [filepath]);
      this._state = "playing";

      this.proc.on("close", () => {
        this._state = "stopped";
        this.proc = null;
        resolve();
      });

      this.proc.on("error", () => {
        this._state = "stopped";
        this.proc = null;
        resolve();
      });
    });
  }

  pause(): void {
    if (this.proc?.pid && this._state === "playing") {
      process.kill(this.proc.pid, "SIGSTOP");
      this._state = "paused";
    }
  }

  resume(): void {
    if (this.proc?.pid && this._state === "paused") {
      process.kill(this.proc.pid, "SIGCONT");
      this._state = "playing";
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this._state = "stopped";
  }
}

// ── Linux: auto-detect ffplay/mpv/paplay ──────────────────────────────

class LinuxPlayer implements AudioPlayerBackend {
  private _state: PlayerState = "stopped";
  private proc: ChildProcess | null = null;

  get state() { return this._state; }

  private detectPlayer(): { cmd: string; args: (f: string) => string[] } | null {
    const players = [
      { cmd: "ffplay", args: (f: string) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] },
      { cmd: "mpv", args: (f: string) => ["--no-video", f] },
      { cmd: "paplay", args: (f: string) => [f] },
    ];

    for (const p of players) {
      try {
        const result = spawn("which", [p.cmd], { stdio: "pipe" });
        // Synchronous check is hard — just try the first one
        return p;
      } catch {
        continue;
      }
    }
    return players[0]; // Default to ffplay
  }

  play(filepath: string): Promise<void> {
    const player = this.detectPlayer();
    if (!player) {
      console.error("voice-mcp-backend: No audio player found (install ffplay, mpv, or paplay)");
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.proc = spawn(player.cmd, player.args(filepath), { stdio: "ignore" });
      this._state = "playing";

      this.proc.on("close", () => {
        this._state = "stopped";
        this.proc = null;
        resolve();
      });

      this.proc.on("error", () => {
        this._state = "stopped";
        this.proc = null;
        resolve();
      });
    });
  }

  pause(): void {
    if (this.proc?.pid && this._state === "playing") {
      process.kill(this.proc.pid, "SIGSTOP");
      this._state = "paused";
    }
  }

  resume(): void {
    if (this.proc?.pid && this._state === "paused") {
      process.kill(this.proc.pid, "SIGCONT");
      this._state = "playing";
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this._state = "stopped";
  }
}
