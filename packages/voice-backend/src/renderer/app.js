// WebSocket connection to backend
let ws;
let voiceData = { voices: [], speedPresets: [], tonePresets: [] };
let state = { player: {}, queue: {}, agents: [], staleCount: 0 };
let lastAgentsJson = "";
let selectedItem = null; // clicked history item to show in now-playing
let lastPlayedItem = null; // most recently finished item — stays visible

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

async function loadVoiceData() {
  try {
    const res = await fetch("/api/voices");
    voiceData = await res.json();
  } catch {
    // Will retry on next render
  }
}

// ── State helpers ──────────────────────────────────────────────────────

function getPlayingItem() {
  const timeline = state.queue?.timeline || [];
  return timeline.find(i => i.status === "playing") || null;
}

function getQueuedItems() {
  const timeline = state.queue?.timeline || [];
  return timeline.filter(i => i.status === "generating" || i.status === "ready" || i.status === "queued");
}

function isAnythingActive() {
  return state.player?.state === "playing" || state.player?.state === "paused" || getPlayingItem() !== null;
}

// ── Rendering ──────────────────────────────────────────────────────────

function render() {
  renderHeader();
  renderNowPlaying();
  renderTimeline();
  renderAgents();
}

function renderHeader() {
  const dot = document.getElementById("status-dot");
  const badge = document.getElementById("status-badge");
  const queueBadge = document.getElementById("queue-badge");
  const muteBtn = document.getElementById("btn-mute");

  const isMuted = state.queue?.muted;
  const isPaused = state.queue?.paused;
  const playing = getPlayingItem();
  const isPlaying = playing !== null || state.player?.state === "playing";
  const queuedCount = getQueuedItems().length;

  document.body.classList.toggle("muted", !!isMuted);

  if (isMuted) {
    badge.textContent = "Muted";
    badge.className = "badge badge-muted";
    dot.className = "status-dot dot-yellow";
  } else if (isPaused) {
    badge.textContent = "Paused";
    badge.className = "badge badge-paused";
    dot.className = "status-dot dot-yellow";
  } else if (isPlaying) {
    badge.textContent = "Playing";
    badge.className = "badge badge-playing";
    dot.className = "status-dot dot-green";
  } else {
    badge.textContent = "Idle";
    badge.className = "badge badge-dim";
    dot.className = "status-dot dot-idle";
  }

  if (queuedCount > 0) {
    queueBadge.textContent = `${queuedCount} queued`;
    queueBadge.style.display = "";
  } else {
    queueBadge.style.display = "none";
  }

  muteBtn.textContent = isMuted ? "\u{1F507}" : "\u{1F50A}";
}

function getActiveItemId() {
  // Returns the id of whatever item should be "selected" in the timeline
  const playing = getPlayingItem();
  if (playing) return playing.id;
  if (selectedItem?.id) return selectedItem.id;
  if (lastPlayedItem?.id) return lastPlayedItem.id;
  return null;
}

function renderNowPlaying() {
  const agentEl = document.getElementById("now-agent");
  const textEl = document.getElementById("now-text");
  const timeEl = document.getElementById("now-time");
  const playBtn = document.getElementById("btn-play");
  const pauseBtn = document.getElementById("btn-pause");
  const resumeBtn = document.getElementById("btn-resume");
  const restartBtn = document.getElementById("btn-restart");
  const section = document.getElementById("now-playing");

  const isMuted = state.queue?.muted;
  const isPaused = state.queue?.paused || state.player?.state === "paused";
  const playing = getPlayingItem();

  const activeAgent = playing?.agent || state.player?.currentAgent;
  const activeText = playing?.text || state.player?.currentText;
  const isPlaying = activeAgent && activeText;

  // Track last played item so it stays visible after finishing
  if (isPlaying && playing) {
    lastPlayedItem = { agent: activeAgent, text: activeText, timestamp: new Date().toISOString(), id: playing.id };
    selectedItem = null;
  }

  // If we don't have an id on lastPlayedItem, try to find it from history
  if (lastPlayedItem && !lastPlayedItem.id) {
    const history = state.queue?.history || [];
    const match = history.find(i => i.agent === lastPlayedItem.agent && i.text === lastPlayedItem.text);
    if (match) lastPlayedItem.id = match.id;
  }

  // Priority: playing > selected > last played
  const showItem = isPlaying
    ? { agent: activeAgent, text: activeText, timestamp: null, id: playing?.id }
    : selectedItem || lastPlayedItem;

  if (showItem) {
    const agentInfo = (state.agents || []).find(a => a.agent_name === showItem.agent);
    const color = getAgentColor(showItem.agent);
    agentEl.innerHTML = `<span class="agent-dot" style="background:${color}"></span>${escapeHtml(showItem.agent)}${agentInfo ? ` \u2014 ${escapeHtml(agentInfo.label)}` : ""}`;
    textEl.textContent = `\u201C${showItem.text}\u201D`;
    textEl.className = "now-text now-text-active";

    if (isPlaying) {
      timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      section.classList.add("now-active");
      section.classList.remove("now-finished");
    } else {
      timeEl.textContent = showItem.timestamp ? timeAgo(showItem.timestamp) : "";
      section.classList.remove("now-active");
      section.classList.add("now-finished");
    }
  } else {
    agentEl.innerHTML = "\u2014";
    textEl.textContent = "No message playing";
    textEl.className = "now-text";
    timeEl.textContent = "";
    section.classList.remove("now-active");
    section.classList.remove("now-finished");
  }

  // Controls state machine:
  // Playing:         [Pause] [Restart]
  // Paused:          [Resume] [Restart]
  // Stopped+item:    [Play]
  // Nothing:         (hide all)
  const hasItem = showItem && showItem.id;

  if (isPlaying && !isPaused) {
    playBtn.style.display = "none";
    pauseBtn.style.display = "";
    resumeBtn.style.display = "none";
    restartBtn.style.display = "";
  } else if (isPaused) {
    playBtn.style.display = "none";
    pauseBtn.style.display = "none";
    resumeBtn.style.display = "";
    restartBtn.style.display = "";
  } else if (hasItem) {
    playBtn.style.display = "";
    pauseBtn.style.display = "none";
    resumeBtn.style.display = "none";
    restartBtn.style.display = "none";
  } else {
    playBtn.style.display = "none";
    pauseBtn.style.display = "none";
    resumeBtn.style.display = "none";
    restartBtn.style.display = "none";
  }
}

// ── Timeline: diff-based rendering ────────────────────────────────────
// Instead of replacing innerHTML every tick (which kills hover/scroll),
// we update individual elements in place and only add/remove as needed.

function buildTimelineOrder(timeline) {
  // Reverse sequence order — newest on top, playing cursor moves upward.
  const sorted = [...timeline];
  sorted.sort((a, b) => b.seq - a.seq);
  return sorted;
}

function getItemStatusInfo(item) {
  switch (item.status) {
    case "playing":
      return { cssClass: "timeline-playing", icon: "\u25B6", prefix: "\u25B6 " };
    case "generating":
    case "ready":
    case "queued":
      return { cssClass: "timeline-queued", icon: "\u23F3", prefix: "\u23F3 " };
    case "error":
      return { cssClass: "timeline-error", icon: "\u2716", prefix: "" };
    default:
      return { cssClass: "", icon: "", prefix: "" };
  }
}

function renderTimeline() {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  const timeline = state.queue?.timeline || [];

  if (timeline.length === 0) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";

  const ordered = buildTimelineOrder(timeline);
  const existingMap = new Map();

  // Index existing DOM elements by item id
  for (const el of list.children) {
    existingMap.set(el.dataset.itemId, el);
  }

  const newIds = new Set(ordered.map(i => i.id));

  // Remove elements no longer in the list
  for (const [id, el] of existingMap) {
    if (!newIds.has(id)) {
      el.remove();
    }
  }

  // Update or create elements in order
  let prevEl = null;
  for (const item of ordered) {
    let el = existingMap.get(item.id);
    const color = item.agentColor || getAgentColor(item.agent);
    const textPreview = item.text.length > 100 ? item.text.slice(0, 100) + "\u2026" : item.text;
    const info = getItemStatusInfo(item);
    const time = timeAgo(item.timestamp);

    if (!el) {
      // Create new element
      el = document.createElement("div");
      el.className = "history-item";
      el.dataset.itemId = item.id;
      el.title = "Click to view \u2022 Double-click to replay";
      el.innerHTML = `<span class="history-time"></span><span class="history-agent"><span class="agent-dot"></span><span class="agent-label"></span></span><span class="history-text"></span><span class="history-status"></span>`;
    }

    // Update classes — add selection highlight and auto-scroll
    const isSelected = item.id === getActiveItemId();
    const wasSelected = el.classList.contains("timeline-selected");
    el.className = "history-item"
      + (info.cssClass ? " " + info.cssClass : "")
      + (isSelected ? " timeline-selected" : "");

    if (isSelected && !wasSelected) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    // Update children
    const timeSpan = el.querySelector(".history-time");
    const agentDot = el.querySelector(".agent-dot");
    const agentLabel = el.querySelector(".agent-label");
    const agentSpan = el.querySelector(".history-agent");
    const textSpan = el.querySelector(".history-text");
    const statusSpan = el.querySelector(".history-status");

    if (timeSpan.textContent !== time) timeSpan.textContent = time;
    agentDot.style.background = color;
    agentSpan.style.color = color;
    if (agentLabel.textContent !== item.agent) agentLabel.textContent = item.agent;

    const fullText = info.prefix + textPreview;
    if (textSpan.textContent !== fullText) textSpan.textContent = fullText;
    if (statusSpan.textContent !== info.icon) statusSpan.textContent = info.icon;

    // Insert in correct position
    if (prevEl) {
      if (prevEl.nextSibling !== el) {
        prevEl.after(el);
      }
    } else {
      if (list.firstChild !== el) {
        list.prepend(el);
      }
    }

    prevEl = el;
  }
}

// ── Agents: only re-render when data actually changes ─────────────────

function renderAgents() {
  const list = document.getElementById("agents-list");
  const empty = document.getElementById("agents-empty");
  const purgeBtn = document.getElementById("btn-purge");
  const agents = state.agents || [];
  const staleCount = state.staleCount || 0;

  if (staleCount > 0) {
    purgeBtn.textContent = `Purge ${staleCount} stale`;
    purgeBtn.style.display = "";
  } else {
    purgeBtn.style.display = "none";
  }

  if (agents.length === 0) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";

  // Skip re-render if agents data hasn't changed
  const agentsJson = JSON.stringify(agents);
  if (agentsJson === lastAgentsJson) return;
  lastAgentsJson = agentsJson;

  const html = agents.map(agent => {
    const color = getAgentColor(agent.agent_name);
    const lastUsed = agent.last_used ? timeAgo(agent.last_used) : "never";
    return `<div class="agent-row" data-agent="${escapeHtml(agent.agent_name)}">
      <div class="agent-row-header">
        <div class="agent-info">
          <div class="agent-name">
            <span class="agent-dot" style="background:${color}"></span>
            ${escapeHtml(agent.agent_name)}
          </div>
          <div class="agent-last-used">${lastUsed}</div>
        </div>
        <button type="button" class="btn btn-small btn-test" data-action="test" title="Preview voice">Test</button>
      </div>
      <div class="agent-settings">
        <div class="agent-setting-group">
          <span class="agent-setting-label">Voice</span>
          <select class="agent-select" data-action="set_voice">
            ${voiceData.voices.map(v =>
              `<option value="${v.name}" ${v.name === agent.voice ? "selected" : ""}>${v.label}</option>`
            ).join("")}
          </select>
        </div>
        <div class="agent-setting-group">
          <span class="agent-setting-label">Speed</span>
          <select class="agent-select" data-action="set_rate">
            ${voiceData.speedPresets.map(s =>
              `<option value="${s}" ${s === agent.rate ? "selected" : ""}>${s}</option>`
            ).join("")}
          </select>
        </div>
        <div class="agent-setting-group">
          <span class="agent-setting-label">Pitch</span>
          <select class="agent-select" data-action="set_pitch">
            ${voiceData.tonePresets.map(t =>
              `<option value="${t}" ${t === agent.pitch ? "selected" : ""}>${t}</option>`
            ).join("")}
          </select>
        </div>
      </div>
    </div>`;
  }).join("");

  list.innerHTML = html;
}

// ── Actions (delegated — no inline handlers) ──────────────────────────

let lastReplayTime = 0;
function replayItem(itemId) {
  const now = Date.now();
  if (now - lastReplayTime < 500) return; // debounce rapid clicks
  lastReplayTime = now;
  send("replay_item", { item_id: itemId });
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

function timeAgo(iso) {
  if (!iso) return "";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;

  switch (e.code) {
    case "Space":
      e.preventDefault();
      if (state.queue?.paused || state.player?.state === "paused") {
        send("resume");
      } else if (isAnythingActive()) {
        send("pause");
      }
      break;
    case "KeyR":
      if (!state.queue?.muted) send("replay");
      break;
    case "KeyM":
      send(state.queue?.muted ? "unmute" : "mute");
      break;
  }
});

// ── Event Listeners ────────────────────────────────────────────────────

document.getElementById("btn-play").addEventListener("click", () => {
  if (state.queue?.muted) return; // No sound when muted
  const item = selectedItem || lastPlayedItem;
  if (item && item.id) replayItem(item.id);
});
document.getElementById("btn-pause").addEventListener("click", () => send("pause"));
document.getElementById("btn-resume").addEventListener("click", () => send("resume"));
document.getElementById("btn-restart").addEventListener("click", () => {
  if (state.queue?.muted) return; // No sound when muted
  const item = selectedItem || lastPlayedItem;
  if (item && item.id) replayItem(item.id);
});
document.getElementById("btn-mute").addEventListener("click", () => {
  send(state.queue?.muted ? "unmute" : "mute");
});
document.getElementById("btn-purge").addEventListener("click", () => send("purge_stale"));

// Agents drawer toggle
function toggleDrawer() {
  document.getElementById("agents-drawer").classList.toggle("open");
  document.getElementById("agents-overlay").classList.toggle("open");
}
document.getElementById("btn-agents").addEventListener("click", toggleDrawer);
document.getElementById("btn-close-drawer").addEventListener("click", toggleDrawer);
document.getElementById("agents-overlay").addEventListener("click", toggleDrawer);

// History: single-click shows full text, double-click replays audio
document.getElementById("history-list").addEventListener("click", (e) => {
  const el = e.target.closest(".history-item");
  if (el && el.dataset.itemId) {
    const timeline = state.queue?.timeline || [];
    const found = timeline.find(i => i.id === el.dataset.itemId);
    if (found) {
      selectedItem = { agent: found.agent, text: found.text, timestamp: found.timestamp, id: found.id };
      renderNowPlaying();
    }
  }
});

document.getElementById("history-list").addEventListener("dblclick", (e) => {
  if (state.queue?.muted) return; // No sound when muted
  const el = e.target.closest(".history-item");
  if (el && el.dataset.itemId) {
    replayItem(el.dataset.itemId);
  }
});

// Agents panel — delegated event handling (no inline handlers, prevents XSS)
document.getElementById("agents-list").addEventListener("change", (e) => {
  const select = e.target.closest("select[data-action]");
  if (!select) return;
  const row = select.closest(".agent-row");
  if (!row) return;
  const agentName = row.dataset.agent;
  const action = select.dataset.action;
  if (action === "set_voice") {
    send("set_voice", { agent_name: agentName, voice: select.value });
  } else if (action === "set_rate") {
    send("set_param", { agent_name: agentName, key: "rate", value: select.value });
  } else if (action === "set_pitch") {
    send("set_param", { agent_name: agentName, key: "pitch", value: select.value });
  }
});

document.getElementById("agents-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='test']");
  if (!btn) return;
  const row = btn.closest(".agent-row");
  if (!row) return;
  send("test_voice", { agent_name: row.dataset.agent });
});

// ── Init ───────────────────────────────────────────────────────────────

loadVoiceData();
connect();
