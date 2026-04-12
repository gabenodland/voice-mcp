// WebSocket connection to backend
let ws;
let voiceData = { voices: [], speedPresets: [], tonePresets: [] };
let state = { player: {}, queue: {}, agents: [] };

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    console.log("Connected to voice backend");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state") {
      state = msg.data;
      render();
    }
  };

  ws.onclose = () => {
    console.log("Disconnected, reconnecting...");
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function send(action, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, ...data }));
  }
}

// Fetch voice data on load
async function loadVoiceData() {
  try {
    const res = await fetch("/api/voices");
    voiceData = await res.json();
  } catch {
    // Will retry on next render
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

function render() {
  renderHeader();
  renderNowPlaying();
  renderHistory();
  renderAgents();
}

function renderHeader() {
  const badge = document.getElementById("status-badge");
  const queueBadge = document.getElementById("queue-badge");
  const muteBtn = document.getElementById("btn-mute");

  const isMuted = state.queue?.muted;
  const isPaused = state.queue?.paused;
  const isPlaying = state.player?.state === "playing";

  document.body.classList.toggle("muted", !!isMuted);

  if (isMuted) {
    badge.textContent = "Muted";
    badge.className = "badge badge-muted";
  } else if (isPaused) {
    badge.textContent = "Paused";
    badge.className = "badge badge-paused";
  } else if (isPlaying) {
    badge.textContent = "Playing";
    badge.className = "badge badge-playing";
  } else {
    badge.textContent = "Idle";
    badge.className = "badge badge-dim";
  }

  queueBadge.textContent = `Queue: ${state.queue?.queueSize ?? 0}`;
  muteBtn.textContent = isMuted ? "🔇" : "🔊";
}

function renderNowPlaying() {
  const agentEl = document.getElementById("now-agent");
  const textEl = document.getElementById("now-text");
  const pauseBtn = document.getElementById("btn-pause");
  const resumeBtn = document.getElementById("btn-resume");

  const isPlaying = state.player?.state === "playing";
  const isPaused = state.player?.state === "paused";

  if (isPlaying || isPaused) {
    const agent = state.player.currentAgent || "Unknown";
    const agentInfo = (state.agents || []).find(a => a.agent_name === agent);
    const color = getAgentColor(agent);
    agentEl.innerHTML = `<span class="agent-dot" style="background:${color}"></span>${agent}${agentInfo ? ` — ${agentInfo.label}` : ""}`;
    textEl.textContent = state.player.currentText || "";
  } else {
    agentEl.innerHTML = "—";
    textEl.textContent = "No message playing";
  }

  pauseBtn.style.display = (isPlaying) ? "" : "none";
  resumeBtn.style.display = (isPaused) ? "" : "none";
}

function renderHistory() {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  const history = state.queue?.history || [];

  if (history.length === 0) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";

  const html = history.map(item => {
    const time = formatTime(item.timestamp);
    const statusIcon = item.status === "playing" ? "🔊"
      : item.status === "generating" ? "⏳"
      : item.status === "queued" ? "⏳"
      : item.status === "error" ? "❌"
      : "✓";
    const color = item.agentColor || getAgentColor(item.agent);

    return `<div class="history-item">
      <span class="history-time">${time}</span>
      <span class="history-agent" style="color:${color}">
        <span class="agent-dot" style="background:${color}"></span>${item.agent}
      </span>
      <span class="history-text">${escapeHtml(item.text)}</span>
      <span class="history-status">${statusIcon}</span>
    </div>`;
  }).join("");

  list.innerHTML = html;
}

function renderAgents() {
  const list = document.getElementById("agents-list");
  const empty = document.getElementById("agents-empty");
  const agents = state.agents || [];

  if (agents.length === 0) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";

  const html = agents.map(agent => {
    const color = getAgentColor(agent.agent_name);
    return `<div class="agent-row">
      <div class="agent-name">
        <span class="agent-dot" style="background:${color}"></span>
        ${escapeHtml(agent.agent_name)}
      </div>
      <div class="agent-voice">
        <select class="agent-select" onchange="changeVoice('${escapeAttr(agent.agent_name)}', this.value)">
          ${voiceData.voices.map(v =>
            `<option value="${v.name}" ${v.name === agent.voice ? "selected" : ""}>${v.label}</option>`
          ).join("")}
        </select>
      </div>
      <div class="agent-rate">
        <select class="agent-select" onchange="changeParam('${escapeAttr(agent.agent_name)}', 'rate', this.value)">
          ${voiceData.speedPresets.map(s =>
            `<option value="${s}" ${s === agent.rate ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </div>
      <div class="agent-pitch">
        <select class="agent-select" onchange="changeParam('${escapeAttr(agent.agent_name)}', 'pitch', this.value)">
          ${voiceData.tonePresets.map(t =>
            `<option value="${t}" ${t === agent.pitch ? "selected" : ""}>${t}</option>`
          ).join("")}
        </select>
      </div>
    </div>`;
  }).join("");

  list.innerHTML = html;
}

// ── Actions ────────────────────────────────────────────────────────────

function changeVoice(agentName, voice) {
  send("set_voice", { agent_name: agentName, voice });
}

function changeParam(agentName, key, value) {
  send("set_param", { agent_name: agentName, key, value });
}

// ── Utilities ──────────────────────────────────────────────────────────

const AGENT_COLORS = [
  "#89b4fa", "#a6e3a1", "#fab387", "#cba6f7", "#f9e2af", "#f38ba8",
  "#94e2d5", "#f5c2e7", "#74c7ec", "#eba0ac", "#89dceb", "#b4befe",
];

const agentColorMap = {};
let colorIdx = 0;

function getAgentColor(agent) {
  if (!agentColorMap[agent]) {
    agentColorMap[agent] = AGENT_COLORS[colorIdx % AGENT_COLORS.length];
    colorIdx++;
  }
  return agentColorMap[agent];
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ── Event Listeners ────────────────────────────────────────────────────

document.getElementById("btn-pause").addEventListener("click", () => send("pause"));
document.getElementById("btn-resume").addEventListener("click", () => send("resume"));
document.getElementById("btn-replay").addEventListener("click", () => send("replay"));
document.getElementById("btn-mute").addEventListener("click", () => {
  send(state.queue?.muted ? "unmute" : "mute");
});
document.getElementById("btn-purge").addEventListener("click", () => send("purge_stale"));

// Tabs
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`${tab.dataset.tab}-panel`).classList.add("active");
  });
});

// ── Init ───────────────────────────────────────────────────────────────

loadVoiceData();
connect();
