// TCP command types (MCP server → Voice backend)
export interface SpeakCommand {
  cmd: "speak";
  text: string;
  agent: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
  _rate_explicit?: boolean;
  _pitch_explicit?: boolean;
  _seq?: number;
}

export interface StatusCommand {
  cmd: "status";
}

export interface AgentsCommand {
  cmd: "agents";
}

export interface RegisterAgentCommand {
  cmd: "register_agent";
  agent_name: string;
  voice?: string;
  rate?: string;
  pitch?: string;
}

export interface SetVoiceCommand {
  cmd: "set_voice";
  agent_name: string;
  voice: string;
}

export interface PauseCommand {
  cmd: "pause";
}

export interface ResumeCommand {
  cmd: "resume";
}

export interface ReplayCommand {
  cmd: "replay";
}

export interface MuteCommand {
  cmd: "mute";
}

export interface UnmuteCommand {
  cmd: "unmute";
}

export interface TestVoiceCommand {
  cmd: "test_voice";
  agent_name: string;
}

export interface ReplayItemCommand {
  cmd: "replay_item";
  item_id: string;
}

export interface ListDevicesCommand { cmd: "list_devices"; }
export interface SetDeviceCommand   { cmd: "set_device"; name: string; }   // name or "default"
export interface TestDeviceCommand  { cmd: "test_device"; name: string; }
export interface SetLeadInCommand   { cmd: "set_leadin"; ms: number; }

export type TcpCommand =
  | SpeakCommand
  | StatusCommand
  | AgentsCommand
  | RegisterAgentCommand
  | SetVoiceCommand
  | PauseCommand
  | ResumeCommand
  | ReplayCommand
  | MuteCommand
  | UnmuteCommand
  | TestVoiceCommand
  | ReplayItemCommand
  | ListDevicesCommand
  | SetDeviceCommand
  | TestDeviceCommand
  | SetLeadInCommand;

// TCP response types (Voice backend → MCP server)
export interface OkResponse {
  ok: true;
  message?: string;
}

export interface SpeakResponse {
  ok: true;
  voice: string;
  label: string;
}

export interface StatusResponse {
  ok: true;
  state: string;
  agent: string | null;
  text: string | null;
  muted: boolean;
  queue_size: number;
}

export interface AgentsResponse {
  ok: true;
  agents: AgentInfo[];
}

export interface DevicesResponse {
  ok: true;
  available: boolean;
  leadInAvailable: boolean;  // WASAPI subsystem can apply a lead-in (= available)
  leadInMs: number;          // current configured lead-in
  reason?: string;
  active: string;
  devices: DeviceInfo[];
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type TcpResponse =
  | OkResponse
  | SpeakResponse
  | StatusResponse
  | AgentsResponse
  | DevicesResponse
  | ErrorResponse;

// Data types
export interface AgentInfo {
  agent_name: string;
  voice: string;
  label: string;
  last_used: string;
  rate: string;
  pitch: string;
}

export interface VoiceEntry {
  name: string;
  gender: "Male" | "Female";
  locale: string;
  label: string;
}

export interface VoiceAssignment {
  voice: string;
  label: string;
  last_used: string;
  rate: string;
  pitch: string;
}

// Playback queue item
export interface PlaybackItem {
  id: string;
  text: string;
  agent: string;
  voice: string;
  label: string;
  rate: string;
  pitch: string;
  volume: string;
  seq: number;
  audioPath?: string;
  status: "queued" | "generating" | "ready" | "playing" | "done" | "error";
  timestamp: string;
  agentColor: string;
}

// ── Audio output device types ──────────────────────────────────────────
export interface DevicePref {
  name: string;          // stable selector; "default" or absent = system default → MCI
  hintDeviceId?: number; // best-effort cache of the RtAudio id; revalidated against name
}

export interface AudioConfig {
  device: DevicePref | null;
  leadInMs: number;
}

export interface DeviceInfo {
  id: number;        // current audify/RtAudio device id (opaque, instance-scoped; 0 = invalid)
  name: string;      // stable selector
  isDefault: boolean;
  active: boolean;   // matches the persisted selection
}

export interface DeviceListResult {
  available: boolean;     // false when audify can't load or WASAPI is disabled
  leadInAvailable: boolean;
  leadInMs: number;
  reason?: string;        // why unavailable
  active: string;         // "System default" or the selected device name
  devices: DeviceInfo[];  // output endpoints (empty when unavailable)
}
