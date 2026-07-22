import type { ServerResponse } from "node:http";
import { eventBus } from './eventBus.js';

const sseConnections = new Set<ServerResponse>();

export function addSSEConnection(connection: ServerResponse) {
  sseConnections.add(connection);
}

export function removeSSEConnection(connection: ServerResponse) {
  sseConnections.delete(connection);
}

export function emitEvent(event: string, data: unknown) {
  eventBus.emit(event, data);
  eventBus.emit('sse', event, data);
}

export function emitSSEEvent(event: string, data: unknown) {
  emitEvent(event, data);

  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";

  for (const connection of sseConnections) {
    try {
      connection.write(payload);
    } catch {
      sseConnections.delete(connection);
    }
  }
}
