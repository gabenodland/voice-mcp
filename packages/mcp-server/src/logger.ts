import fs from "node:fs";
import path from "node:path";
import { LOG_FILE, DATA_DIR } from "../../shared/src/constants.js";

export function appendLog(
  tool: string,
  agentName: string,
  text: string,
  rate?: string,
  result?: string,
): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      tool,
      agent_name: agentName,
      rate: rate ?? "",
      text,
      result: result ?? "",
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Logging should never crash the MCP server
  }
}
