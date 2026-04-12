import { synthesize } from "./tts-engine.js";
import { playAudio, stopAudio, pauseAudio, resumeAudio, setCurrentMeta, clearCurrentMeta } from "./audio-player.js";
import { agentColor, type PlaybackItem } from "@voice-mcp/shared";
import crypto from "node:crypto";
import { broadcastState } from "./web-ui.js";

interface EnqueueParams {
  text: string;
  agent: string;
  voice: string;
  label: string;
  rate: string;
  pitch: string;
  volume: string;
  seq: number;
}

class PlaybackQueue {
  private items: PlaybackItem[] = [];
  private history: PlaybackItem[] = [];
  private reorderBuffer = new Map<number, PlaybackItem>();
  private nextPlaySeq = 1;
  private isPlaying = false;
  private isPaused = false;
  private muted = false;
  private agentIndexMap = new Map<string, number>();
  private agentCounter = 0;

  enqueue(params: EnqueueParams): void {
    const agentIdx = this.getAgentIndex(params.agent);
    const item: PlaybackItem = {
      id: crypto.randomUUID(),
      text: params.text,
      agent: params.agent,
      voice: params.voice,
      label: params.label,
      rate: params.rate,
      pitch: params.pitch,
      volume: params.volume,
      seq: params.seq,
      status: "generating",
      timestamp: new Date().toISOString(),
      agentColor: agentColor(agentIdx),
    };

    this.items.push(item);
    broadcastState();

    // Start TTS generation (non-blocking)
    this.generateTTS(item);
  }

  private async generateTTS(item: PlaybackItem): Promise<void> {
    try {
      const audioPath = await synthesize(
        item.text,
        item.voice,
        item.rate,
        item.pitch,
        item.volume,
      );
      item.audioPath = audioPath;
      item.status = "ready";

      // Place in reorder buffer
      this.reorderBuffer.set(item.seq, item);
      this.flushReorderBuffer();
    } catch (err) {
      console.error(`voice-mcp-backend: TTS error for seq ${item.seq}:`, err);
      item.status = "error";
      // Skip this item in the sequence
      this.reorderBuffer.set(item.seq, item);
      this.flushReorderBuffer();
    }
  }

  private flushReorderBuffer(): void {
    // Flush consecutive ready items from the reorder buffer
    while (this.reorderBuffer.has(this.nextPlaySeq)) {
      const item = this.reorderBuffer.get(this.nextPlaySeq)!;
      this.reorderBuffer.delete(this.nextPlaySeq);
      this.nextPlaySeq++;

      if (item.status === "ready") {
        this.playQueue.push(item);
      } else {
        // Error items go straight to history
        this.addToHistory(item);
      }
    }

    this.processPlayQueue();
  }

  private playQueue: PlaybackItem[] = [];

  private async processPlayQueue(): Promise<void> {
    if (this.isPlaying || this.playQueue.length === 0) return;

    this.isPlaying = true;

    while (this.playQueue.length > 0) {
      const item = this.playQueue.shift()!;

      if (this.muted) {
        item.status = "done";
        this.addToHistory(item);
        broadcastState();
        continue;
      }

      item.status = "playing";
      setCurrentMeta(item.agent, item.text);
      broadcastState();

      if (item.audioPath) {
        try {
          await playAudio(item.audioPath);
        } catch (err) {
          console.error(`voice-mcp-backend: Playback error:`, err);
        }
      }

      item.status = "done";
      clearCurrentMeta();
      this.addToHistory(item);
      broadcastState();
    }

    this.isPlaying = false;
  }

  private addToHistory(item: PlaybackItem): void {
    this.history.unshift(item);
    // Keep last 100 items
    if (this.history.length > 100) {
      this.history.length = 100;
    }
    // Remove from active items
    const idx = this.items.indexOf(item);
    if (idx !== -1) this.items.splice(idx, 1);
  }

  pause(): void {
    this.isPaused = true;
    pauseAudio();
  }

  resume(): void {
    this.isPaused = false;
    resumeAudio();
  }

  replay(): void {
    if (this.history.length === 0) return;
    const last = this.history[0];
    if (last.audioPath) {
      stopAudio();
      setCurrentMeta(last.agent, last.text);
      broadcastState();
      playAudio(last.audioPath).then(() => {
        clearCurrentMeta();
        broadcastState();
      });
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) stopAudio();
  }

  isMuted(): boolean {
    return this.muted;
  }

  size(): number {
    return this.items.length + this.playQueue.length;
  }

  getState() {
    return {
      items: this.items,
      playQueue: this.playQueue,
      history: this.history,
      muted: this.muted,
      paused: this.isPaused,
      queueSize: this.size(),
    };
  }

  private getAgentIndex(agent: string): number {
    if (!this.agentIndexMap.has(agent)) {
      this.agentIndexMap.set(agent, this.agentCounter++);
    }
    return this.agentIndexMap.get(agent)!;
  }
}

export const playbackQueue = new PlaybackQueue();
