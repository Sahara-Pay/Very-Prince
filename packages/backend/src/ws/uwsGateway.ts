import uWS from 'uwebsockets';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { appRouter } from '../trpc/router.js';
import {
  registerSubscription,
  unregisterSubscription,
  removeAllSubscriptions,
} from './subscriptionManager.js';

interface WsClientData {
  connectionId: string;
  subscriptions: Map<number, AbortController>;
}

interface JsonRpcRequest {
  id?: number;
  jsonrpc?: string;
  method?: string;
  params?: {
    path?: string;
    input?: unknown;
  };
}

const MAX_PAYLOAD_LENGTH = 1024 * 1024;
const IDLE_TIMEOUT_SEC = 120;

const procedures: Record<string, unknown> = appRouter._def.procedures as Record<string, unknown>;

function sendRaw(ws: uWS.WebSocket<WsClientData>, message: string): void {
  const backpressure = ws.send(message, false);
  if (backpressure > 0) {
    logger.warn({ backpressure }, 'WebSocket backpressure detected');
  }
}

function sendJson(
  ws: uWS.WebSocket<WsClientData>,
  id: number | null,
  result?: { type: string; data?: unknown },
  error?: { code: number; message: string; data?: unknown },
): void {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) {
    msg.error = error;
  } else {
    msg.result = result;
  }
  sendRaw(ws, JSON.stringify(msg));
}

function sendError(
  ws: uWS.WebSocket<WsClientData>,
  id: number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  sendJson(ws, id, undefined, { code, message, data });
}

function sendResult(
  ws: uWS.WebSocket<WsClientData>,
  id: number,
  result: { type: string; data?: unknown },
): void {
  sendJson(ws, id, result);
}

export function createUwsGateway(): uWS.TemplatedApp {
  const app = uWS.App();

  app.ws<WsClientData>('/*', {
    compression: uWS.SHARED_COMPRESSOR,
    maxPayloadLength: MAX_PAYLOAD_LENGTH,
    idleTimeout: IDLE_TIMEOUT_SEC,
    // uWebSockets.js per-message-deflate is enabled via compression: SHARED_COMPRESSOR

    open: (ws) => {
      ws.getUserData().connectionId = randomUUID();
      ws.getUserData().subscriptions = new Map();
      logger.info({ connectionId: ws.getUserData().connectionId }, 'WebSocket connection opened');
      sendRaw(ws, JSON.stringify({
        jsonrpc: '2.0',
        result: { type: 'connected', data: { connectionId: ws.getUserData().connectionId, timestamp: Date.now() } },
      }));
    },

    message: (ws, message, isBinary) => {
      if (isBinary) {
        logger.warn('Binary message received, expected JSON');
        return;
      }
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(Buffer.from(message).toString('utf8'));
      } catch {
        sendError(ws, 0, -32700, 'Parse error');
        return;
      }
      if (req.jsonrpc !== '2.0') {
        sendError(ws, req.id ?? 0, -32600, 'Invalid JSON-RPC 2.0 request');
        return;
      }
      handleMessage(ws, req).catch((err: unknown) => {
        logger.error({ err }, 'Error handling WebSocket message');
        sendError(ws, req.id ?? 0, -32603, 'Internal error');
      });
    },

    close: (ws, code, _message) => {
      const { connectionId, subscriptions } = ws.getUserData();
      for (const [, ac] of subscriptions) {
        ac.abort();
      }
      subscriptions.clear();
      removeAllSubscriptions(connectionId);
      logger.info({ connectionId, code }, 'WebSocket connection closed');
    },

    drain: (ws) => {
      logger.debug({ backpressure: ws?.getBufferedAmount() }, 'WebSocket drain event');
    },

    ping: () => {
      logger.debug('WebSocket ping received');
    },

    pong: () => {
      logger.debug('WebSocket pong received');
    },
  });

  return app;
}

async function handleMessage(
  ws: uWS.WebSocket<WsClientData>,
  req: JsonRpcRequest,
): Promise<void> {
  const { id } = req;
  if (id === undefined || id === null) {
    sendError(ws, null, -32600, 'Request must have an id');
    return;
  }

  if (req.method === 'subscription') {
    await handleSubscriptionStart(ws, id, req.params);
  } else if (req.method === 'subscription.stop') {
    handleSubscriptionStop(ws, id);
  } else {
    sendError(ws, id, -32601, `Method '${req.method}' not found`);
  }
}

async function handleSubscriptionStart(
  ws: uWS.WebSocket<WsClientData>,
  id: number,
  params?: { path?: string; input?: unknown },
): Promise<void> {
  const path = params?.path;
  if (!path || typeof path !== 'string') {
    sendError(ws, id, -32602, 'Invalid params: path is required');
    return;
  }

  // eslint-disable-next-line security/detect-object-injection
  const procedure = procedures[path] as
    | { _def: { subscription: boolean; resolver: (opts: { ctx: object; input: unknown; signal: AbortSignal }) => { subscribe: (observer: { next: (data: unknown) => void; error: (err: Error) => void; complete: () => void }) => { unsubscribe: () => void } } } }
    | undefined;

  if (!procedure) {
    sendError(ws, id, -32602, `Procedure '${path}' not found`);
    return;
  }

  const def = procedure._def;
  if (!def.subscription) {
    sendError(ws, id, -32602, `Procedure '${path}' is not a subscription`);
    return;
  }

  const ac = new AbortController();
  const { connectionId } = ws.getUserData();

  registerSubscription(connectionId, id, path, params?.input);

  try {
    const observable = def.resolver({
      ctx: {},
      input: params?.input,
      signal: ac.signal,
    });

    if (!observable || typeof observable.subscribe !== 'function') {
      throw new Error('Subscription procedure did not return an observable');
    }

    ws.getUserData().subscriptions.set(id, ac);

    sendResult(ws, id, { type: 'started' });

    const sub = observable.subscribe({
      next: (data: unknown) => {
        try {
          sendResult(ws, id, { type: 'data', data });
        } catch (err) {
          logger.error({ err, connectionId, path }, 'Error sending subscription data');
        }
      },
      error: (err: Error) => {
        sendError(ws, id, -32000, err.message ?? 'Subscription error', err);
        ws.getUserData().subscriptions.delete(id);
        unregisterSubscription(connectionId, id);
      },
      complete: () => {
        sendResult(ws, id, { type: 'stopped' });
        ws.getUserData().subscriptions.delete(id);
        unregisterSubscription(connectionId, id);
      },
    });

    ac.signal.addEventListener('abort', () => {
      sub.unsubscribe();
      ws.getUserData().subscriptions.delete(id);
      unregisterSubscription(connectionId, id);
    });
  } catch (err) {
    ws.getUserData().subscriptions.delete(id);
    unregisterSubscription(connectionId, id);
    sendError(ws, id, -32000, err instanceof Error ? err.message : 'Subscription failed', err);
  }
}

function handleSubscriptionStop(
  ws: uWS.WebSocket<WsClientData>,
  id: number,
): void {
  const ac = ws.getUserData().subscriptions.get(id);
  if (ac) {
    ac.abort();
    ws.getUserData().subscriptions.delete(id);
    unregisterSubscription(ws.getUserData().connectionId, id);
  }
  sendResult(ws, id, { type: 'stopped' });
}
