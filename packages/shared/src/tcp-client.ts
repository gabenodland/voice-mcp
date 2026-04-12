import net from "node:net";
import { VOICE_SERVER_PORT } from "./constants.js";
import type { TcpCommand, TcpResponse } from "./types.js";

const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB safety cap

export async function sendCommand(
  command: TcpCommand,
  timeout = 10000,
): Promise<TcpResponse | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    const chunks: Buffer[] = [];
    let totalSize = 0;

    socket.connect(VOICE_SERVER_PORT, "127.0.0.1", () => {
      socket.write(JSON.stringify(command));
      socket.end(); // signal end of request (equivalent to Python's sock.shutdown(SHUT_WR))
    });

    socket.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_RESPONSE_SIZE) {
        socket.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    socket.on("end", () => {
      try {
        const data = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(data) as TcpResponse);
      } catch {
        resolve(null);
      }
    });

    socket.on("error", () => {
      resolve(null);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}
