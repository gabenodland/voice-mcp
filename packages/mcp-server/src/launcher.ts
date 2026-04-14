import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let lastLaunchTime = 0;
const LAUNCH_COOLDOWN_MS = 10000;

/**
 * Fire-and-forget launch of the voice backend process.
 * Looks for the backend entry point in the same dist/ directory (npm package)
 * or in the monorepo sibling package (development).
 */
export function ensureBackend(): void {
  const now = Date.now();
  if (now - lastLaunchTime < LAUNCH_COOLDOWN_MS) return;
  lastLaunchTime = now;

  const backendEntry = resolveBackendPath();
  if (!backendEntry) {
    console.error("voice-tts-mcp: Could not find backend. Reinstall with: npm install -g voice-tts-mcp");
    return;
  }

  try {
    const child = spawn("node", [backendEntry], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.error(`voice-tts-mcp: Launched backend (pid ${child.pid})`);
  } catch (err) {
    console.error("voice-tts-mcp: Failed to launch backend:", err);
  }
}

function resolveBackendPath(): string | null {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));

    // 1. Same dist/ directory (npm package — backend bundled alongside MCP server)
    const sameDirPath = path.resolve(__dirname, "backend-entry.js");
    if (existsSync(sameDirPath)) return sameDirPath;

    // 2. Monorepo sibling package (development)
    const monorepoPath = path.resolve(__dirname, "../../voice-backend/dist/main/index.js");
    if (existsSync(monorepoPath)) return monorepoPath;

    // 3. Alternate monorepo layout
    const altPath = path.resolve(__dirname, "../../../packages/voice-backend/dist/main/index.js");
    if (existsSync(altPath)) return altPath;
  } catch {
    // Fall through
  }
  return null;
}
