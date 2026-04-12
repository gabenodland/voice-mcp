import path from "node:path";
import os from "node:os";

export const VOICE_SERVER_PORT = 52718;
export const WEB_UI_PORT = 52719;
export const DEFAULT_RATE = "+25%";
export const DEFAULT_VOICE = "en-US-AriaNeural";
export const DEFAULT_PITCH = "+0Hz";
export const DEFAULT_VOLUME = "+0%";
export const STALE_DAYS = 7;

export const DATA_DIR = path.join(os.homedir(), ".claude", "voice");
export const HISTORY_DIR = path.join(os.tmpdir(), "claude_voice_history");
export const LOG_FILE = path.join(DATA_DIR, "voice_log.jsonl");
export const ASSIGNMENTS_FILE = path.join(DATA_DIR, "voice_assignments.json");
