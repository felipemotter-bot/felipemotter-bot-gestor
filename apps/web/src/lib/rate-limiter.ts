/**
 * Simple in-memory sliding-window rate limiter.
 * Suitable for single-process Next.js servers.
 * State is lost on restart — acceptable for abuse protection.
 */

type Entry = { timestamps: number[] };

export class RateLimiter {
  private store = new Map<string, Entry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.maxRequests) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Evict stale entries to prevent unbounded memory growth.
   * Call periodically (e.g. every few minutes).
   */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
      }
    }
  }

  /** Visible for testing */
  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton for the import confirm endpoint
// Max 10 imports per 60 seconds per user
// ---------------------------------------------------------------------------

let importLimiter: RateLimiter | null = null;

export function getImportRateLimiter(): RateLimiter {
  if (!importLimiter) {
    importLimiter = new RateLimiter(10, 60_000);
    // Cleanup every 5 minutes
    if (typeof setInterval !== "undefined") {
      setInterval(() => importLimiter?.cleanup(), 5 * 60_000).unref?.();
    }
  }
  return importLimiter;
}
