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

  // TTS concurrency control — one at a time to avoid Edge TTS rate limits
  private static readonly MAX_CONCURRENT_TTS = 1;
  private activeTtsCount = 0;
  private ttsQueue: PlaybackItem[] = [];

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

    // Queue TTS generation with concurrency limit
    this.ttsQueue.push(item);
    this.processTtsQueue();
  }

  private processTtsQueue(): void {
    while (this.activeTtsCount < PlaybackQueue.MAX_CONCURRENT_TTS && this.ttsQueue.length > 0) {
      const item = this.ttsQueue.shift()!;
      this.activeTtsCount++;
      this.generateTTS(item).finally(() => {
        this.activeTtsCount--;
        this.processTtsQueue();
      });
    }
  }

  private static readonly MAX_TTS_RETRIES = 3;

  private async generateTTS(item: PlaybackItem, attempt = 0): Promise<void> {
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

      this.reorderBuffer.set(item.seq, item);
      this.flushReorderBuffer();
    } catch (err) {
      if (attempt < PlaybackQueue.MAX_TTS_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        console.error(`voice-mcp-backend: TTS error for seq ${item.seq} (attempt ${attempt + 1}/${PlaybackQueue.MAX_TTS_RETRIES}), retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        return this.generateTTS(item, attempt + 1);
      }
      console.error(`voice-mcp-backend: TTS failed for seq ${item.seq} after ${attempt + 1} attempts:`, err);
      item.status = "error";
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

  private processPlayQueueRunning = false;

  private async processPlayQueue(): Promise<void> {
    // Guard against concurrent entry — only one loop at a time
    if (this.processPlayQueueRunning || this.playQueue.length === 0) return;
    this.processPlayQueueRunning = true;
    this.isPlaying = true;

    try {
      while (this.playQueue.length > 0) {
        const item = this.playQueue.shift()!;

        if (this.muted) {
          item.status = "done";
          this.addToHistory(item);
          broadcastState();
          continue;
        }

        // Wait while paused
        while (this.isPaused) {
          await new Promise((r) => setTimeout(r, 100));
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
    } finally {
      this.isPlaying = false;
      this.processPlayQueueRunning = false;
    }
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

  private replayLock = false;

  replay(): void {
    if (this.muted || this.history.length === 0) return;
    const last = this.history[0];
    if (last.audioPath) this.playOneShot(last);
  }

  replayItem(itemId: string): boolean {
    if (this.muted) return false;
    const item = this.history.find((i) => i.id === itemId);
    if (!item?.audioPath) return false;
    this.playOneShot(item);
    return true;
  }

  private async playOneShot(item: PlaybackItem): Promise<void> {
    // Stop anything currently playing and prevent overlap
    stopAudio();
    if (this.replayLock) return;
    this.replayLock = true;

    try {
      setCurrentMeta(item.agent, item.text);
      broadcastState();
      await playAudio(item.audioPath!);
    } catch (err) {
      console.error("voice-mcp-backend: Replay error:", err);
    } finally {
      this.replayLock = false;
      clearCurrentMeta();
      broadcastState();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      stopAudio();
      clearCurrentMeta();
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  size(): number {
    return this.items.length + this.playQueue.length;
  }

  getState() {
    // Build a deduplicated timeline from all sources
    const seen = new Set<string>();
    const timeline: PlaybackItem[] = [];
    const addUnique = (item: PlaybackItem) => {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        timeline.push(item);
      }
    };

    for (const item of this.items) addUnique(item);
    for (const item of this.playQueue) addUnique(item);
    for (const item of this.history) addUnique(item);

    return {
      items: this.items,
      playQueue: this.playQueue,
      history: this.history,
      timeline,
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
