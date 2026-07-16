import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./client";

const { redirectToSignIn } = vi.hoisted(() => ({
  redirectToSignIn: vi.fn(),
}));

vi.mock("@client/lib/auth-navigation", () => ({
  redirectToSignIn,
}));

function createJsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as Response;
}

function jwtLoginSuccess(token = "mock-jwt-token") {
  return createJsonResponse(200, {
    ok: true,
    data: { token, expiresIn: 86400 },
  });
}

describe("API client auth flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    redirectToSignIn.mockReset();
    api.__resetApiClientAuthForTests();
  });

  afterEach(() => {
    api.__resetApiClientAuthForTests();
  });

  it("redirects to sign-in on an unauthorized response without retrying", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      createJsonResponse(401, {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
        meta: { requestId: "req-1" },
      }),
    );

    await expect(api.runPipeline()).rejects.toThrow("Authentication required");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("stores a bearer token when signing in directly", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      jwtLoginSuccess("fresh-token"),
    );

    await expect(
      api.signInWithCredentials("admin", "secret"),
    ).resolves.toBeUndefined();
    expect(api.getCachedAuthHeader()).toBe("Bearer fresh-token");
  });

  it("redirects after logout and clears the cached token", async () => {
    api.__setAuthTokenForTests("logout-token");

    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      createJsonResponse(200, {
        ok: true,
        data: { message: "Logged out" },
        meta: { requestId: "req-1" },
      }),
    );

    await api.logout();

    expect(api.getCachedAuthHeader()).toBeUndefined();
    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("sends the full automatic run payload to the pipeline API", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce(
      createJsonResponse(200, {
        ok: true,
        data: { message: "ok" },
        meta: { requestId: "req-full" },
      }),
    );

    await expect(
      api.runPipeline({
        topN: 12,
        minSuitabilityCategory: "good_fit",
        maxJobsPerTerm: 30,
        searchTerms: ["backend engineer"],
        country: "united kingdom",
        cityLocations: ["London"],
        workplaceTypes: ["remote", "hybrid"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "flexible",
        sources: ["linkedin"],
      }),
    ).resolves.toEqual({ message: "ok" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/pipeline/run",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          topN: 12,
          minSuitabilityCategory: "good_fit",
          maxJobsPerTerm: 30,
          searchTerms: ["backend engineer"],
          country: "united kingdom",
          cityLocations: ["London"],
          workplaceTypes: ["remote", "hybrid"],
          searchScope: "selected_plus_remote_worldwide",
          matchStrictness: "flexible",
          sources: ["linkedin"],
        }),
      }),
    );
  });
});
