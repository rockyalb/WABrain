/**
 * Pluggable rate limiting. The default is an in-memory token bucket, which is
 * correct for a single API instance; a shared store can implement
 * `RateLimiter` for multi-instance deployments.
 */
export interface RateLimitPolicy {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  take(key: string, cost?: number): RateLimitResult | Promise<RateLimitResult>;
}

export type RateLimiterFactory = (name: string, policy: RateLimitPolicy) => RateLimiter;

export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private lastSweep = Date.now();

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    this.sweep(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.policy.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.policy.capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.policy.refillPerSecond);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((cost - bucket.tokens) / this.policy.refillPerSecond) };
  }

  /** Drops full buckets so memory stays bounded. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      const tokens = bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.policy.refillPerSecond;
      if (tokens >= this.policy.capacity) this.buckets.delete(key);
    }
  }
}

export const inMemoryRateLimiters: RateLimiterFactory = (_name, policy) => new TokenBucketLimiter(policy);

export const RATE_LIMITS = {
  login: { capacity: 5, refillPerSecond: 1 / 20 },
  pairing: { capacity: 10, refillPerSecond: 1 / 10 },
  webhook: { capacity: 300, refillPerSecond: 20 },
  device: { capacity: 120, refillPerSecond: 10 },
  deviceIp: { capacity: 300, refillPerSecond: 20 },
  setup: { capacity: 60, refillPerSecond: 2 },
  health: { capacity: 30, refillPerSecond: 1 },
} satisfies Record<string, RateLimitPolicy>;
