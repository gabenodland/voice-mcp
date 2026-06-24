import path from "node:path";
import type { AudioPlayerBackend, PlayerState } from "./player-types.js";

// ── Windows: winmm.dll MCI via koffi ──────────────────────────────────
export class WindowsMCIPlayer implements AudioPlayerBackend {
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
