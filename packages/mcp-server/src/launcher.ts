import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let lastLaunchTime = 0;
const LAUNCH_COOLDOWN_MS = 10000; // Don't retry more than once per 10 seconds

/**
 * Fire-and-forget launch of the voice backend process.
 * Non-blocking, best-effort. If it fails, the MCP tool returns a helpful error.
 * Retries are allowed after a cooldown period (handles backend crashes mid-session).
 */
export function ensureBackend(): void {
  const now = Date.now();
  if (now - lastLaunchTime < LAUNCH_COOLDOWN_MS) return;
  lastLaunchTime = now;

  const backendEntry = resolveBackendPath();
  if (!backendEntry) {
    console.error("voice-mcp: Could not find backend entry point. Build the backend with: npm run build");
    return;
  }

  try {
    const child = spawn("node", [backendEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.error(`voice-mcp: Launched backend (pid ${child.pid})`);
  } catch (err) {
    console.error("voice-mcp: Failed to launch backend:", err);
  }
}

function resolveBackendPath(): string | null {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // When running from the monorepo, the backend is a sibling package
    const monorepoPath = path.resolve(__dirname, "../../voice-backend/dist/main/index.js");
    if (existsSync(monorepoPath)) return monorepoPath;

    // Also check relative to mcp-server dist (when built with tsup into flat dist)
    const altPath = path.resolve(__dirname, "../../../packages/voice-backend/dist/main/index.js");
    if (existsSync(altPath)) return altPath;
  } catch {
    // Fall through
  }
  return null;
}
