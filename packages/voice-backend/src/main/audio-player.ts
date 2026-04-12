import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

type PlayerState = "stopped" | "playing" | "paused";

interface AudioPlayerBackend {
  play(filepath: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: PlayerState;
}

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
  currentPlayer = null;
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
    return new WindowsMCIPlayer();
  } else if (process.platform === "darwin") {
    return new MacAfplayPlayer();
  } else {
    return new LinuxPlayer();
  }
}

// ── Windows: winmm.dll MCI via koffi ──────────────────────────────────

class WindowsMCIPlayer implements AudioPlayerBackend {
  private _state: PlayerState = "stopped";
  private alias = `voice_${Date.now()}`;
  private mciSendString: ((cmd: string, ret: Buffer, retLen: number, hwnd: null) => number) | null = null;

  get state() { return this._state; }

  private async loadKoffi() {
    if (this.mciSendString) return;
    try {
      const koffi = (await import("koffi")).default;
      const winmm = koffi.load("winmm.dll");
      this.mciSendString = winmm.func(
        "uint32 __stdcall mciSendStringW(str16, str16, uint32, void*)"
      ) as any;
    } catch (err) {
      console.error("voice-mcp-backend: Failed to load koffi/winmm:", err);
      throw err;
    }
  }

  private mci(command: string): string {
    if (!this.mciSendString) throw new Error("MCI not initialized");
    const retBuf = Buffer.alloc(512);
    this.mciSendString(command, retBuf, 256, null);
    return retBuf.toString("utf16le").replace(/\0+$/, "");
  }

  async play(filepath: string): Promise<void> {
    await this.loadKoffi();
    const absPath = path.resolve(filepath).replace(/\\/g, "/");
    this.mci(`open "${absPath}" type mpegvideo alias ${this.alias}`);
    this.mci(`play ${this.alias}`);
    this._state = "playing";

    // Wait for playback to complete
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this._state === "stopped") {
          resolve();
          return;
        }
        if (this._state === "paused") {
          setTimeout(check, 200);
          return;
        }
        try {
          const mode = this.mci(`status ${this.alias} mode`);
          if (mode === "stopped" || mode === "") {
            this.cleanup();
            resolve();
          } else {
            setTimeout(check, 100);
          }
        } catch {
          this.cleanup();
          resolve();
        }
      };
      setTimeout(check, 100);
    });
  }

  pause(): void {
    if (this._state !== "playing") return;
    try { this.mci(`pause ${this.alias}`); } catch { /* ignore */ }
    this._state = "paused";
  }

  resume(): void {
    if (this._state !== "paused") return;
    try { this.mci(`resume ${this.alias}`); } catch { /* ignore */ }
    this._state = "playing";
  }

  stop(): void {
    this.cleanup();
  }

  private cleanup(): void {
    try { this.mci(`stop ${this.alias}`); } catch { /* ignore */ }
    try { this.mci(`close ${this.alias}`); } catch { /* ignore */ }
    this._state = "stopped";
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
