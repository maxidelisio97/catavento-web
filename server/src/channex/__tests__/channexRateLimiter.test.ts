import { describe, expect, it } from 'vitest';
import { ChannexRateLimiter } from '../channexRateLimiter.js';

/**
 * Fake clock/sleep instead of real timers (server/CLAUDE.md's
 * test-determinism rule): `sleep` advances the fake clock by the amount it
 * was asked to wait, so the limiter's own logic — not a real setTimeout — is
 * what's under test.
 */
function buildFakeClock() {
  let currentTime = 0;
  const sleepCalls: number[] = [];

  return {
    now: () => currentTime,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      currentTime += ms;
    },
    sleepCalls,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

describe('ChannexRateLimiter', () => {
  it('runs requests immediately while under the limit, without waiting', async () => {
    const clock = buildFakeClock();
    const limiter = new ChannexRateLimiter({ maxRequests: 2, windowMs: 1000, now: clock.now, sleep: clock.sleep });

    const order: number[] = [];
    await limiter.schedule(async () => order.push(1));
    await limiter.schedule(async () => order.push(2));

    expect(order).toEqual([1, 2]);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('queues a request over the limit instead of firing it immediately', async () => {
    const clock = buildFakeClock();
    const limiter = new ChannexRateLimiter({ maxRequests: 2, windowMs: 1000, now: clock.now, sleep: clock.sleep });

    const order: number[] = [];
    await limiter.schedule(async () => order.push(1));
    await limiter.schedule(async () => order.push(2));

    // Third call is over the limit within the same window — it must wait
    // (queue) for the oldest timestamp to fall out of the window, not run
    // immediately alongside the first two.
    await limiter.schedule(async () => order.push(3));

    expect(order).toEqual([1, 2, 3]);
    expect(clock.sleepCalls.length).toBeGreaterThan(0);
    expect(clock.sleepCalls[0]).toBeGreaterThan(0);
  });

  it('proves the queuing is real: removing the limit check would let all requests run without any wait', async () => {
    // Same scenario as above, but with a limit high enough that nothing
    // should ever queue — the contrast is what proves the previous test's
    // wait was caused by the limit, not some incidental delay.
    const clock = buildFakeClock();
    const limiter = new ChannexRateLimiter({ maxRequests: 10, windowMs: 1000, now: clock.now, sleep: clock.sleep });

    const order: number[] = [];
    await limiter.schedule(async () => order.push(1));
    await limiter.schedule(async () => order.push(2));
    await limiter.schedule(async () => order.push(3));

    expect(order).toEqual([1, 2, 3]);
    expect(clock.sleepCalls).toHaveLength(0);
  });

  it('allows a new request once the window has rolled past the oldest one', async () => {
    const clock = buildFakeClock();
    const limiter = new ChannexRateLimiter({ maxRequests: 1, windowMs: 1000, now: clock.now, sleep: clock.sleep });

    const order: number[] = [];
    await limiter.schedule(async () => order.push(1));
    clock.advance(1000); // window fully elapsed
    await limiter.schedule(async () => order.push(2));

    expect(order).toEqual([1, 2]);
    expect(clock.sleepCalls).toHaveLength(0);
  });
});
