import type { CreateJobInput } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importJobsStep } from "./import-jobs";

const { createJobsMock } = vi.hoisted(() => ({ createJobsMock: vi.fn() }));

vi.mock("@server/repositories/jobs", () => ({
  createJobs: createJobsMock,
}));

const jobInput = (overrides: Partial<CreateJobInput>): CreateJobInput => ({
  source: "linkedin",
  title: "Engineer",
  employer: "Acme",
  jobUrl: "https://example.com/a",
  ...overrides,
});

const importedInputs = (): CreateJobInput[] =>
  createJobsMock.mock.calls.flatMap((call) => call[0] as CreateJobInput[]);

describe("importJobsStep", () => {
  beforeEach(() => {
    createJobsMock.mockReset();
    createJobsMock.mockResolvedValue({
      created: 1,
      skipped: 0,
      reposted: 0,
      rejected: 0,
    });
  });

  it("stamps the running profile onto every imported row, across sources", async () => {
    await importJobsStep({
      discoveredJobs: [
        jobInput({ source: "linkedin", jobUrl: "https://example.com/a" }),
        jobInput({ source: "indeed", jobUrl: "https://example.com/b" }),
        jobInput({ source: "linkedin", jobUrl: "https://example.com/c" }),
      ],
      profileId: "profile-1",
    });

    const inputs = importedInputs();
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input.profileId).toBe("profile-1");
    }
  });

  it("leaves rows unattributed when the run has no profile", async () => {
    await importJobsStep({
      discoveredJobs: [jobInput({})],
    });

    const [input] = importedInputs();
    expect(input.profileId).toBeUndefined();
  });

  it("does not mutate the caller's discovered-job objects", async () => {
    const discovered = jobInput({});
    await importJobsStep({
      discoveredJobs: [discovered],
      profileId: "profile-1",
    });

    expect(discovered.profileId).toBeUndefined();
    expect(importedInputs()[0]?.profileId).toBe("profile-1");
  });
});
