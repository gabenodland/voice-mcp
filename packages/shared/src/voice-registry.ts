import fs from "node:fs";
import path from "node:path";
import { ASSIGNMENTS_FILE, DATA_DIR, DEFAULT_RATE, DEFAULT_PITCH, STALE_DAYS } from "./constants.js";
import { VOICE_POOL } from "./voice-pool.js";
import type { VoiceAssignment, AgentInfo } from "./types.js";

type AssignmentsMap = Record<string, VoiceAssignment>;

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAssignments(): AssignmentsMap {
  try {
    const data = fs.readFileSync(ASSIGNMENTS_FILE, "utf-8");
    return JSON.parse(data) as AssignmentsMap;
  } catch {
    return {};
  }
}

function saveAssignments(assignments: AssignmentsMap): void {
  ensureDataDir();
  fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
}

function pickRandomVoice(assignments: AssignmentsMap): { name: string; label: string } {
  const usedVoices = new Set(Object.values(assignments).map((a) => a.voice));
  const available = VOICE_POOL.filter((v) => !usedVoices.has(v.name));
  const pool = available.length > 0 ? available : VOICE_POOL;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { name: pick.name, label: pick.label };
}

export function getVoice(agentName: string): VoiceAssignment {
  const assignments = loadAssignments();
  if (assignments[agentName]) {
    // Update last_used timestamp
    assignments[agentName].last_used = new Date().toISOString();
    saveAssignments(assignments);
    return assignments[agentName];
  }
  // Assign a new random voice
  const picked = pickRandomVoice(assignments);
  const assignment: VoiceAssignment = {
    voice: picked.name,
    label: picked.label,
    last_used: new Date().toISOString(),
    rate: DEFAULT_RATE,
    pitch: DEFAULT_PITCH,
  };
  assignments[agentName] = assignment;
  saveAssignments(assignments);
  return assignment;
}

export function setVoice(agentName: string, voiceName: string): VoiceAssignment | null {
  const voice = VOICE_POOL.find((v) => v.name === voiceName);
  if (!voice) return null;

  const assignments = loadAssignments();
  const existing = assignments[agentName];
  assignments[agentName] = {
    voice: voice.name,
    label: voice.label,
    last_used: new Date().toISOString(),
    rate: existing?.rate ?? DEFAULT_RATE,
    pitch: existing?.pitch ?? DEFAULT_PITCH,
  };
  saveAssignments(assignments);
  return assignments[agentName];
}

export function registerVoice(
  agentName: string,
  voiceName?: string,
  rate?: string,
  pitch?: string,
): VoiceAssignment {
  const assignments = loadAssignments();

  if (assignments[agentName]) {
    // Update existing
    if (voiceName) {
      const voice = VOICE_POOL.find((v) => v.name === voiceName);
      if (voice) {
        assignments[agentName].voice = voice.name;
        assignments[agentName].label = voice.label;
      }
    }
    if (rate) assignments[agentName].rate = rate;
    if (pitch) assignments[agentName].pitch = normalizePitch(pitch);
    assignments[agentName].last_used = new Date().toISOString();
    saveAssignments(assignments);
    return assignments[agentName];
  }

  // Create new
  const picked = voiceName
    ? VOICE_POOL.find((v) => v.name === voiceName) ?? pickRandomVoice(assignments)
    : pickRandomVoice(assignments);
  const voiceData = "name" in picked ? picked : { name: (picked as any).name, label: (picked as any).label };

  const assignment: VoiceAssignment = {
    voice: typeof voiceData.name === "string" ? voiceData.name : picked.name,
    label: typeof voiceData.label === "string" ? voiceData.label : picked.label,
    last_used: new Date().toISOString(),
    rate: rate ?? DEFAULT_RATE,
    pitch: normalizePitch(pitch ?? DEFAULT_PITCH),
  };
  assignments[agentName] = assignment;
  saveAssignments(assignments);
  return assignment;
}

export function setAgentParam(
  agentName: string,
  key: "rate" | "pitch",
  value: string,
): boolean {
  const assignments = loadAssignments();
  if (!assignments[agentName]) return false;
  assignments[agentName][key] = key === "pitch" ? normalizePitch(value) : value;
  saveAssignments(assignments);
  return true;
}

export function getAllAgents(): AgentInfo[] {
  const assignments = loadAssignments();
  return Object.entries(assignments).map(([name, a]) => ({
    agent_name: name,
    voice: a.voice,
    label: a.label,
    last_used: a.last_used,
    rate: a.rate,
    pitch: a.pitch,
  }));
}

export function purgeStale(): number {
  const assignments = loadAssignments();
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  let count = 0;
  for (const [name, a] of Object.entries(assignments)) {
    if (new Date(a.last_used).getTime() < cutoff) {
      delete assignments[name];
      count++;
    }
  }
  if (count > 0) saveAssignments(assignments);
  return count;
}

function normalizePitch(pitch: string): string {
  // Convert percentage to Hz if needed (e.g., "+10%" → "+10Hz")
  const match = pitch.match(/^([+-]?\d+)%$/);
  if (match) return `${match[1]}Hz`;
  return pitch;
}
