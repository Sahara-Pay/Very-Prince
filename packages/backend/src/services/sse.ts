import type { ServerResponse } from "node:http";

const sseConnections = new Set<ServerResponse>();

export function addSSEConnection(connection: ServerResponse) {
  sseConnections.add(connection);
}

export function removeSSEConnection(connection: ServerResponse) {
  sseConnections.delete(connection);
}

export function emitSSEEvent(event: string, data: unknown) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";

  for (const connection of sseConnections) {
    try {
      connection.write(payload);
    } catch {
      sseConnections.delete(connection);
    }
  }
}
