type CacheEntry<T> = { promise: Promise<T>; expiresAt: number };

const entries = new Map<string, CacheEntry<unknown>>();

export function getOrCreateCached<T>(key: string, loader: () => Promise<T>, ttlMs = 5_000): Promise<T> {
  const now = Date.now();
  const current = entries.get(key) as CacheEntry<T> | undefined;
  if (current && current.expiresAt > now) return current.promise;
  const promise = loader().catch((error) => {
    entries.delete(key);
    throw error;
  });
  entries.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}
export function invalidateCached(key?: string): void {
  if (key) entries.delete(key);
  else entries.clear();
}
