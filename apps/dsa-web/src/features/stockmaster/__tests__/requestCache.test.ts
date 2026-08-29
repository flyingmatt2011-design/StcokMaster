import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateCached, invalidateCached } from '../requestCache';

describe('requestCache', () => {
  beforeEach(() => { invalidateCached(); vi.restoreAllMocks(); });

  it('shares in-flight requests and evicts rejected promises', async () => {
    let resolve!: (value: string) => void;
    const loader = vi.fn(() => new Promise<string>((next) => { resolve = next; }));
    const first = getOrCreateCached('quote:600519', loader);
    const second = getOrCreateCached('quote:600519', loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    resolve('ok');
    await expect(first).resolves.toBe('ok');
  });

  it('allows explicit invalidation', async () => {
    const loader = vi.fn().mockResolvedValue('ok');
    await getOrCreateCached('quote:600519', loader);
    invalidateCached('quote:600519');
    await getOrCreateCached('quote:600519', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
