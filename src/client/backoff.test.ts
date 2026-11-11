import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap at the top of the jitter range", () => {
    const max = () => 0.999999;
    expect([0, 1, 2, 3, 10].map((n) => backoffDelay(n, max))).toEqual([500, 1000, 2000, 4000, 15000]);
  });

  it("never waits less than 100 ms, even with zero jitter", () => {
    expect(backoffDelay(0, () => 0)).toBe(100);
  });

  it("spreads retries across the range instead of one instant", () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelay(5)));
    expect(delays.size).toBeGreaterThan(40);
  });
});
