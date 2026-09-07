import { describe, expect, it } from "vitest";
import {
  employerKey,
  IN_FLIGHT_STATUSES,
  isInFlightStatus,
} from "./company-in-flight";

describe("IN_FLIGHT_STATUSES", () => {
  it("is exactly the Tailoring, Live and Interviewing statuses", () => {
    expect([...IN_FLIGHT_STATUSES]).toEqual([
      "processing",
      "ready",
      "applied",
      "in_progress",
    ]);
  });

  it("excludes the shelves and the concluded statuses", () => {
    for (const status of [
      "discovered",
      "backlog",
      "stale",
      "skipped",
      "closed",
    ] as const) {
      expect(isInFlightStatus(status)).toBe(false);
    }
  });

  it("agrees with its own list", () => {
    for (const status of IN_FLIGHT_STATUSES) {
      expect(isInFlightStatus(status)).toBe(true);
    }
  });
});

describe("employerKey", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(employerKey("  Acme Labs ")).toBe(employerKey("acme labs"));
  });

  it("does NOT fold a near-miss spelling into the same company", () => {
    // Exact by design: over-matching would hide a real second opening behind a
    // warning about an unrelated one.
    expect(employerKey("Acme")).not.toBe(employerKey("Acme Ltd"));
    expect(employerKey("Acme")).not.toBe(employerKey("Acme Inc."));
  });

  it("does not fold diacritics", () => {
    expect(employerKey("Nestlé")).not.toBe(employerKey("Nestle"));
  });

  it("yields an empty key for a missing or blank employer", () => {
    expect(employerKey("   ")).toBe("");
    expect(employerKey(null)).toBe("");
    expect(employerKey(undefined)).toBe("");
  });
});
