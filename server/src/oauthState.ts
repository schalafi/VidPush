const store = new Map<string, { userId: string; created: number }>();
const TTL_MS = 15 * 60 * 1000;

export function putOAuthState(state: string, userId: string): void {
  store.set(state, { userId, created: Date.now() });
}

export function takeOAuthState(state: string): string | undefined {
  const v = store.get(state);
  store.delete(state);
  if (!v) return undefined;
  if (Date.now() - v.created > TTL_MS) return undefined;
  return v.userId;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now - val.created > TTL_MS) store.delete(key);
  }
}, 60_000).unref?.();
