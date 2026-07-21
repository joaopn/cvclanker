// @vitest-environment node
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the subprocess + fs boundaries so runJobSpy's per-location loop can be
// driven deterministically without launching Python.
const spawnMock = vi.fn();
const readFileMock = vi.fn();
const unlinkMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: (...args: unknown[]) => readFileMock(...args),
  unlink: (...args: unknown[]) => unlinkMock(...args),
}));
vi.mock("node:fs", () => ({ existsSync: () => false }));

import { runJobSpy } from "../src/run";

// A fake child process with no stdio streams (so the runner skips readline);
// it emits `close` with the given exit code on the next microtask, after the
// runner has attached its close/error listeners.
function fakeChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: null;
    stderr: null;
  };
  child.stdout = null;
  child.stderr = null;
  queueMicrotask(() => child.emit("close", exitCode));
  return child;
}

const oneJobJson = JSON.stringify([
  {
    site: "linkedin",
    job_url: "https://example.com/job-1",
    title: "Engineer",
    company: "Acme",
  },
]);

describe("runJobSpy per-location resilience (B4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlinkMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue(oneJobJson);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an earlier location's jobs when a later location fails", async () => {
    // Location 1 exits 0 and yields a job; location 2 exits non-zero. The dead
    // location must NOT discard location 1's already-scraped jobs.
    let call = 0;
    spawnMock.mockImplementation(() => {
      call += 1;
      return fakeChild(call === 1 ? 0 : 1);
    });

    const result = await runJobSpy({
      searchTerms: ["engineer"],
      locations: ["Berlin", "Vienna"],
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      "https://example.com/job-1",
    ]);
  });

  it("reports failure only when every location fails", async () => {
    spawnMock.mockImplementation(() => fakeChild(1));

    const result = await runJobSpy({
      searchTerms: ["engineer"],
      locations: ["Berlin", "Vienna"],
    });

    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
  });
});
