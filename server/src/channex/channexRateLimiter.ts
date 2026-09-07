/**
 * SPEC-modulo-12A-otas-fundaciones-mapeo.md § 5 — generic sliding-window rate
 * limiter shared by every M12 entrega's calls to Channex (12A only reads;
 * 12B/12C push ARI and will schedule through the same instance). `now` and
 * `sleep` are injectable so tests can verify queuing behavior without real
 * timers (server/CLAUDE.md's test-determinism rule — no fixed real delays).
 */
export interface ChannexRateLimiterOptions {
  /** Max requests allowed inside any rolling `windowMs` window. */
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ChannexRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private timestamps: number[] = [];

  constructor(options: ChannexRateLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Runs `task` once a slot inside the window is free, waiting (queuing) otherwise. */
  async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    this.timestamps.push(this.now());
    return task();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);

      if (this.timestamps.length < this.maxRequests) {
        return;
      }

      const oldest = this.timestamps[0];
      const waitMs = oldest + this.windowMs - this.now();
      await this.sleep(Math.max(waitMs, 0));
    }
  }
}
