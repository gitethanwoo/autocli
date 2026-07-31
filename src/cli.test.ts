import { describe, expect, it } from "vitest";
import { parseTime } from "./cli.js";

const NOW = 1_753_995_600_000; // 2025-07-31T21:00:00Z

describe("parseTime", () => {
  it("parses durations relative to now", () => {
    expect(parseTime("30m", NOW)).toBe(NOW - 30 * 60_000);
    expect(parseTime("24h", NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseTime("7d", NOW)).toBe(NOW - 7 * 86_400_000);
    expect(parseTime("2w", NOW)).toBe(NOW - 2 * 604_800_000);
    expect(parseTime("45s", NOW)).toBe(NOW - 45_000);
  });

  it("passes through epoch milliseconds", () => {
    expect(parseTime("1753995600000", NOW)).toBe(1_753_995_600_000);
  });

  it("parses ISO dates", () => {
    expect(parseTime("2025-07-01", NOW)).toBe(Date.parse("2025-07-01"));
    expect(parseTime("2025-07-01T12:30:00Z", NOW)).toBe(Date.parse("2025-07-01T12:30:00Z"));
  });
});
