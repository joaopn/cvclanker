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

  it("still reads auth from the text when a status is present", () => {
    // Gemini reports a bad key as HTTP 400, not 401/403. Dropping the text
    // check for any status would push those users from "LLM API key not set"
    // to a raw provider string. Auth has no global side effect, so trusting
    // the text here is safe in a way the rate-limit patterns are not.
    expect(
      classifyLlmError({
        status: 400,
        message:
          "LLM API error: 400 - API key not valid. Please pass a valid API key.",
      }),
    ).toBe("auth");
  });

  it("ignores rate-limit text when the provider gave a status it doesn't recognise", () => {
    // A 4xx body can echo the request, which carries the job description. A
    // posting about API rate limiting must not read as a rate limit and stop
    // every LLM call in the process.
    const echoed =
      "LLM API error: 400 - invalid_request: prompt was 'Senior SRE — own API rate limiting, quota management and traffic shaping'";
    expect(classifyLlmError({ status: 400, message: echoed })).toBe("unknown");
    expect(classifyLlmError({ status: 500, message: "quota" })).toBe("unknown");
    // …but a real 429 is still a rate limit regardless of what it says.
    expect(classifyLlmError({ status: 429, message: echoed })).toBe(
      "rate_limited",
    );
    // The CLI providers report the same thing with no status, and must keep
    // being read from the text.
    expect(classifyLlmError({ message: echoed })).toBe("rate_limited");
  });

  it("falls back to unknown", () => {
    expect(classifyLlmError({})).toBe("unknown");
    expect(classifyLlmError({ status: 500, message: "boom" })).toBe("unknown");
    expect(classifyLlmError({ message: "No content in response" })).toBe(
      "unknown",
    );
  });
});
