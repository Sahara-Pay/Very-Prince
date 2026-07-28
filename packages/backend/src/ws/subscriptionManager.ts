export interface SubscriptionState {
  connectionId: string;
  subscriptionId: number;
  path: string;
  input: unknown;
  createdAt: number;
}

const clientSubscriptions = new Map<string, Map<number, SubscriptionState>>();

export function registerSubscription(
  connectionId: string,
  subscriptionId: number,
  path: string,
  input: unknown,
): SubscriptionState {
  if (!clientSubscriptions.has(connectionId)) {
    clientSubscriptions.set(connectionId, new Map());
  }
  const subs = clientSubscriptions.get(connectionId)!;
  const state: SubscriptionState = {
    connectionId,
    subscriptionId,
    path,
    input,
    createdAt: Date.now(),
  };
  subs.set(subscriptionId, state);
  return state;
}

export function unregisterSubscription(connectionId: string, subscriptionId: number): boolean {
  const subs = clientSubscriptions.get(connectionId);
  if (!subs) return false;
  const removed = subs.delete(subscriptionId);
  if (subs.size === 0) {
    clientSubscriptions.delete(connectionId);
  }
  return removed;
}

export function removeAllSubscriptions(connectionId: string): SubscriptionState[] {
  const subs = clientSubscriptions.get(connectionId);
  if (!subs) return [];
  clientSubscriptions.delete(connectionId);
  return Array.from(subs.values());
}

export function getSubscriptionsForClient(connectionId: string): SubscriptionState[] {
  const subs = clientSubscriptions.get(connectionId);
  if (!subs) return [];
  return Array.from(subs.values());
}

export function restoreSubscriptions(
  oldConnectionId: string,
  newConnectionId: string,
): SubscriptionState[] {
  const subs = clientSubscriptions.get(oldConnectionId);
  if (!subs) return [];
  clientSubscriptions.delete(oldConnectionId);
  clientSubscriptions.set(newConnectionId, subs);
  return Array.from(subs.values());
}
