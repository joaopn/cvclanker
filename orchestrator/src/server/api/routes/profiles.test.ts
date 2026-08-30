// @vitest-environment node
import type { Server } from "node:http";
import type { Profile } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Search profiles API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function createProfile(
    name: string,
    blockedCompanyKeywords: string[] = [],
  ): Promise<Profile> {
    const res = await fetch(`${baseUrl}/api/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, config: { blockedCompanyKeywords } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    return body.data as Profile;
  }

  async function blockCompany(
    employer: string,
    profileIds: string[],
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/profiles/block-company`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employer, profileIds }),
    });
  }

  async function readKeywords(id: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/profiles`);
    const body = await res.json();
    const profile = (body.data.profiles as Profile[]).find(
      (entry) => entry.id === id,
    );
    if (!profile) throw new Error(`profile ${id} vanished`);
    return profile.config.blockedCompanyKeywords;
  }

  describe("POST /block-company", () => {
    it("adds the company to every named profile and leaves the rest alone", async () => {
      const berlin = await createProfile("Berlin");
      const vienna = await createProfile("Vienna", ["globex"]);
      const untouched = await createProfile("Untouched");

      const res = await blockCompany("Acme Corp", [berlin.id, vienna.id]);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.blocked).toEqual([
        { id: berlin.id, name: "Berlin" },
        { id: vienna.id, name: "Vienna" },
      ]);
      expect(body.data.alreadyBlocked).toEqual([]);
      expect(await readKeywords(berlin.id)).toEqual(["Acme Corp"]);
      // Appended, never replacing what the profile already blocked.
      expect(await readKeywords(vienna.id)).toEqual(["globex", "Acme Corp"]);
      expect(await readKeywords(untouched.id)).toEqual([]);
    });

    it("reports a profile that already blocks the company instead of duplicating it", async () => {
      const profile = await createProfile("Berlin", ["acme corp"]);

      const res = await blockCompany("Acme Corp", [profile.id]);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.blocked).toEqual([]);
      expect(body.data.alreadyBlocked).toEqual([
        { id: profile.id, name: "Berlin", keyword: "acme corp" },
      ]);
      expect(await readKeywords(profile.id)).toEqual(["acme corp"]);
    });

    it("keeps going past a profile that already blocks it", async () => {
      const already = await createProfile("Already", ["acme corp"]);
      const fresh = await createProfile("Fresh");

      const res = await blockCompany("Acme Corp", [already.id, fresh.id]);
      const body = await res.json();

      // The already-blocked profile is reported and SKIPPED, not treated as
      // the end of the request — every other ticked profile still gets it.
      expect(body.data.alreadyBlocked).toEqual([
        { id: already.id, name: "Already", keyword: "acme corp" },
      ]);
      expect(body.data.blocked).toEqual([{ id: fresh.id, name: "Fresh" }]);
      expect(await readKeywords(fresh.id)).toEqual(["Acme Corp"]);
      expect(await readKeywords(already.id)).toEqual(["acme corp"]);
    });

    it("names the broader keyword that already covers the company", async () => {
      const profile = await createProfile("Berlin", ["recruit"]);

      const res = await blockCompany("Global Recruitment Ltd", [profile.id]);
      const body = await res.json();

      expect(body.data.alreadyBlocked).toEqual([
        { id: profile.id, name: "Berlin", keyword: "recruit" },
      ]);
      expect(await readKeywords(profile.id)).toEqual(["recruit"]);
    });

    it("stores the company with its original casing", async () => {
      const profile = await createProfile("Berlin");

      // Trimming is proved by the request schema, not by this: it trims before
      // the service sees the value. The casing is what the service decides.
      await blockCompany("  ACME Corp  ", [profile.id]);

      expect(await readKeywords(profile.id)).toEqual(["ACME Corp"]);
    });

    it("counts a repeated profile id once", async () => {
      const profile = await createProfile("Berlin");

      const res = await blockCompany("Acme Corp", [profile.id, profile.id]);
      const body = await res.json();

      expect(body.data.blocked).toEqual([{ id: profile.id, name: "Berlin" }]);
      expect(await readKeywords(profile.id)).toEqual(["Acme Corp"]);
    });

    it("404s on an unknown profile and writes nothing at all", async () => {
      const profile = await createProfile("Berlin");

      const res = await blockCompany("Acme Corp", [profile.id, "nope"]);
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      // Validate-all-then-write: the good profile in the same request is
      // untouched, so the user retries one request instead of reasoning about
      // which half applied.
      expect(await readKeywords(profile.id)).toEqual([]);
    });

    it("409s rather than overflowing the keyword cap, and writes nothing", async () => {
      const full = await createProfile(
        "Full",
        Array.from({ length: 200 }, (_, index) => `blocked-${index}`),
      );
      const roomy = await createProfile("Roomy");

      const res = await blockCompany("Acme Corp", [roomy.id, full.id]);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error.message).toContain("Full");
      // A 201-entry array fails the stored-config schema, which falls back to
      // the field default — the whole blocked list would silently vanish.
      expect(await readKeywords(full.id)).toHaveLength(200);
      expect(await readKeywords(roomy.id)).toEqual([]);
    });

    it("still blocks on a full profile that already covers the company", async () => {
      const full = await createProfile("Full", [
        "acme",
        ...Array.from({ length: 199 }, (_, index) => `blocked-${index}`),
      ]);

      const res = await blockCompany("Acme Corp", [full.id]);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data.alreadyBlocked).toHaveLength(1);
    });

    it("400s on an empty employer or an empty profile list", async () => {
      const profile = await createProfile("Berlin");

      expect((await blockCompany("   ", [profile.id])).status).toBe(400);
      expect((await blockCompany("Acme Corp", [])).status).toBe(400);
    });
  });
});
