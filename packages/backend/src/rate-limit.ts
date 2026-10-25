export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const hits = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  return {
    allow(key: string): boolean {
      const time = now();
      const recent = (hits.get(key) ?? []).filter((stamp) => time - stamp < options.windowMs);
      if (recent.length >= options.max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(time);
      hits.set(key, recent);
      return true;
    },
  };
}
