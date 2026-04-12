import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let launchAttempted = false;

/**
 * Fire-and-forget launch of the voice backend process.
 * Non-blocking, best-effort. If it fails, the MCP tool returns a helpful error.
 * Only attempts once per MCP server session to avoid spamming.
 */
export function ensureBackend(): void {
  if (launchAttempted) return;
  launchAttempted = true;

  try {
    const backendEntry = resolveBackendPath();

    if (backendEntry) {
      const child = spawn("node", [backendEntry], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.error(`voice-mcp: Launched backend (pid ${child.pid})`);
    } else {
      // Try npx as fallback
      const child = spawn("npx", ["-y", "@voice-mcp/backend"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        shell: true,
      });
      child.unref();
      console.error("voice-mcp: Launched backend via npx");
    }
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
