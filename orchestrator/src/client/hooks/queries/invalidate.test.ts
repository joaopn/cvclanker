import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidateJobData } from "./invalidate";

describe("invalidateJobData", () => {
  // A job write changes what the ctrl+K search would answer as much as what a
  // tab lists; a cached search left alone shows the row as it was until the
  // search is next asked for.
  it("invalidates the command bar's searches alongside the lists", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await invalidateJobData(client, "job-1");

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["jobs", "list"]);
    expect(keys).toContainEqual(["jobs", "search"]);
  });
});
