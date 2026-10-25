import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/rate-limit.js";

describe("限流", () => {
  it("同一个 IP 在窗口内超过次数后被拒绝", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ windowMs: 100, max: 2, now: () => now });
    expect(limiter.allow("1.1.1.1")).toBe(true);
    expect(limiter.allow("1.1.1.1")).toBe(true);
    expect(limiter.allow("1.1.1.1")).toBe(false);
    expect(limiter.allow("2.2.2.2")).toBe(true);
    now = 1_200;
    expect(limiter.allow("1.1.1.1")).toBe(true);
  });
});
