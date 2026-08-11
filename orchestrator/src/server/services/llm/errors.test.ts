// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyLlmError } from "./errors";

describe("classifyLlmError", () => {
  it("reads a 429 status as rate limited", () => {
    expect(classifyLlmError({ status: 429 })).toBe("rate_limited");
  });

  it("reads the CLI providers' session-limit text, which carries no status", () => {
    // Verbatim from the bug report: the claude_code CLI surfaces this as plain
    // text, and misreading it as an auth problem is what triggered keyword
    // scoring in the first place.
    expect(
      classifyLlmError({
        message:
          "You've hit your session limit · resets 2:10am (UTC) (HTTP 429)",
      }),
    ).toBe("rate_limited");
    expect(classifyLlmError({ message: "Rate limit exceeded" })).toBe(
      "rate_limited",
    );
    expect(classifyLlmError({ message: "quota exceeded for this month" })).toBe(
      "rate_limited",
    );
  });

  it("prefers rate-limited over auth when the text mentions both", () => {
    // Provider bodies routinely name the key or account while reporting a
    // limit; calling that an auth failure is the original bug.
    expect(
      classifyLlmError({
        message: "Your API key has hit its usage limit for this session",
      }),
    ).toBe("rate_limited");
  });

  it("reads 401/403 and key text as auth", () => {
    expect(classifyLlmError({ status: 401 })).toBe("auth");
    expect(classifyLlmError({ status: 403 })).toBe("auth");
    expect(classifyLlmError({ message: "LLM API key not configured" })).toBe(
      "auth",
    );
  });

  it("falls back to unknown", () => {
    expect(classifyLlmError({})).toBe("unknown");
    expect(classifyLlmError({ status: 500, message: "boom" })).toBe("unknown");
    expect(classifyLlmError({ message: "No content in response" })).toBe(
      "unknown",
    );
  });
});
