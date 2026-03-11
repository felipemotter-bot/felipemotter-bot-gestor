import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../rate-limiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within the limit", () => {
    const limiter = new RateLimiter(3, 60_000);

    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(true);
  });

  it("blocks requests exceeding the limit", () => {
    const limiter = new RateLimiter(2, 60_000);

    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(false);
  });

  it("allows requests after the window expires", () => {
    const limiter = new RateLimiter(1, 10_000);

    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-1")).toBe(false);

    // Advance past the window
    vi.advanceTimersByTime(10_001);

    expect(limiter.check("user-1")).toBe(true);
  });

  it("tracks different keys independently", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.check("user-1")).toBe(true);
    expect(limiter.check("user-2")).toBe(true);
    expect(limiter.check("user-1")).toBe(false);
    expect(limiter.check("user-2")).toBe(false);
  });

  it("uses sliding window (not fixed bucket)", () => {
    const limiter = new RateLimiter(2, 10_000);

    // T=0: first request
    expect(limiter.check("user-1")).toBe(true);

    // T=5s: second request
    vi.advanceTimersByTime(5_000);
    expect(limiter.check("user-1")).toBe(true);

    // T=5s: third request (blocked, both previous still in window)
    expect(limiter.check("user-1")).toBe(false);

    // T=10.001s: first request expired, one slot available
    vi.advanceTimersByTime(5_001);
    expect(limiter.check("user-1")).toBe(true);
  });

  describe("cleanup", () => {
    it("removes stale entries", () => {
      const limiter = new RateLimiter(5, 10_000);

      limiter.check("user-1");
      limiter.check("user-2");
      expect(limiter.size).toBe(2);

      vi.advanceTimersByTime(10_001);
      limiter.cleanup();

      expect(limiter.size).toBe(0);
    });

    it("keeps active entries", () => {
      const limiter = new RateLimiter(5, 10_000);

      limiter.check("user-1");
      vi.advanceTimersByTime(5_000);
      limiter.check("user-2");

      vi.advanceTimersByTime(5_001); // user-1 expired, user-2 still active
      limiter.cleanup();

      expect(limiter.size).toBe(1);
    });
  });
});
