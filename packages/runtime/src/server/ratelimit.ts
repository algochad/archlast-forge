import type { RedisClient } from "bun";
import { answered } from "./bus";
import { log } from "./logger";

export type RateLimitResult = { allowed: boolean; retryAfter: number | null };

/** Fixed-window counter: at most `max` hits per `windowSec` per key. */
export interface RateLimiter {
  consume(key: string, rule: { window: number; max: number }): Promise<RateLimitResult>;
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = Date.now();

  async consume(key: string, { window, max }: { window: number; max: number }) {
    const now = Date.now();
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now;
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, (h = { count: 0, resetAt: now + window * 1000 }));
    h.count++;
    return h.count <= max ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: Math.ceil((h.resetAt - now) / 1000) };
  }
}

/**
 * Shared across servers. While Redis doesn't answer, each server counts on its own instead: an outage neither fails every call nor
 * lifts the limit.
 */
export class RedisRateLimiter implements RateLimiter {
  private local = new MemoryRateLimiter();
  private warnedAt = 0;

  constructor(
    private redis: RedisClient,
    private prefix: string,
    private timeoutMs = 1000,
  ) {}

  async consume(key: string, rule: { window: number; max: number }) {
    try {
      return await answered(this.shared(key, rule), this.timeoutMs);
    } catch (e) {
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        log("warn", "rate limits are counted per server until Redis answers again", { error: String(e) });
      }
      return this.local.consume(key, rule);
    }
  }

  private async shared(key: string, { window, max }: { window: number; max: number }) {
    const k = `${this.prefix}${key}`;
    const count = Number(await this.redis.send("INCR", [k]));
    if (count === 1) await this.redis.send("EXPIRE", [k, String(window)]);
    if (count <= max) return { allowed: true, retryAfter: null };
    const ttl = Number(await this.redis.send("TTL", [k]));
    return { allowed: false, retryAfter: ttl > 0 ? ttl : window };
  }
}
