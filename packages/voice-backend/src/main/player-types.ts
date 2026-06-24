export type PlayerState = "stopped" | "playing" | "paused";

export interface AudioPlayerBackend {
  play(filepath: string): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: PlayerState;
}
