// @vitest-environment node
import type { PipelineProgressEvent } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orchestratorMock = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  requestPipelineCancel: vi.fn(),
}));

// Factory form: the real orchestrator opens SQLite through its repository
// imports at module load, and this suite only needs its two entry points.
vi.mock("./orchestrator", () => orchestratorMock);

import { resetRateLimitBudget } from "../services/llm/rate-limit-budget";
import { runProfileSequence } from "./profile-sequence";
import {
  getProgress,
  resetProgress,
  setActiveProfileRun,
  subscribeToProgress,
  updateProgress,
} from "./progress";
import {
  endProfileSequence,
  isProfileSequenceActive,
  requestProfileSequenceCancel,
  tryBeginProfileSequence,
} from "./sequence-state";

const ok = { success: true, jobsDiscovered: 0, jobsProcessed: 0 };
const notOk = {
  success: false,
  jobsDiscovered: 0,
  jobsProcessed: 0,
  error: "Pipeline is already running",
};

const entry = (id: string) => ({
  profile: { id, name: `Profile ${id}` },
  config: { searchTerms: [id] },
});

/** Every event the chain emits, in order. */
function recordEvents(): {
  events: PipelineProgressEvent[];
  stop: () => void;
} {
  const events: PipelineProgressEvent[] = [];
  const stop = subscribeToProgress((event) => {
    events.push({ ...event });
  });
  return { events, stop };
}

beforeEach(() => {
  orchestratorMock.runPipeline.mockReset().mockResolvedValue(ok);
  orchestratorMock.requestPipelineCancel.mockReset();
  endProfileSequence();
  setActiveProfileRun(null);
  resetProgress();
  resetRateLimitBudget(5);
  tryBeginProfileSequence();
});

afterEach(() => {
  endProfileSequence();
  setActiveProfileRun(null);
  resetProgress();
});

describe("runProfileSequence", () => {
  it("runs every profile in order, one at a time", async () => {
    const order: string[] = [];
    orchestratorMock.runPipeline.mockImplementation(
      async (config: { searchTerms: string[] }) => {
        order.push(`start:${config.searchTerms[0]}`);
        await Promise.resolve();
        order.push(`end:${config.searchTerms[0]}`);
        return ok;
      },
    );

    await runProfileSequence([entry("a"), entry("b"), entry("c")]);

    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  it("tags each profile's events and emits one untagged aggregate terminal", async () => {
    const { events, stop } = recordEvents();
    const replayStates: (PipelineProgressEvent["profileRun"] | undefined)[] =
      [];
    orchestratorMock.runPipeline.mockImplementation(async () => {
      // Stand in for a real run: it resets progress at entry, then emits.
      resetProgress();
      // The reset state is what a client re-subscribing mid-chain replays, so
      // it has to carry the tag too — otherwise that client sees a bare "idle"
      // and concludes no run is in progress.
      replayStates.push(getProgress().profileRun);
      updateProgress({ step: "crawling", message: "crawling" });
      return ok;
    });

    await runProfileSequence([entry("a"), entry("b")]);
    stop();

    expect(replayStates.map((state) => state?.index)).toEqual([1, 2]);

    const tagged = events.filter((event) => event.profileRun != null);
    expect(tagged.map((event) => event.profileRun?.index)).toEqual([1, 2]);
    expect(tagged[0]?.profileRun).toMatchObject({
      id: "a",
      name: "Profile a",
      index: 1,
      total: 2,
    });

    const terminal = events.at(-1);
    expect(terminal?.step).toBe("completed");
    expect(terminal?.profileRun ?? null).toBeNull();
    expect(terminal?.detail).toBe("2 of 2 profiles completed");
  });

  it("releases the sequence claim BEFORE emitting the aggregate", async () => {
    // Ordering is load-bearing: if the emit threw with the claim still held,
    // getPipelineStatus would report a run in progress forever — blocking User
    // Profile switches and 409ing every later run until a restart.
    let activeAtTerminal: boolean | null = null;
    const stop = subscribeToProgress((event) => {
      if (event.step === "completed") {
        activeAtTerminal = isProfileSequenceActive();
      }
    });

    await runProfileSequence([entry("a")]);
    stop();

    expect(activeAtTerminal).toBe(false);
    expect(isProfileSequenceActive()).toBe(false);
  });

  it("keeps going when a profile fails, and still reports completed", async () => {
    orchestratorMock.runPipeline
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(ok);

    await runProfileSequence([entry("a"), entry("b"), entry("c")]);

    expect(orchestratorMock.runPipeline).toHaveBeenCalledTimes(3);
    const terminal = getProgress();
    expect(terminal.step).toBe("completed");
    expect(terminal.detail).toBe("2 of 3 profiles completed, 1 failed");
  });

  it("counts a non-success RETURN as a failure, not just a throw", async () => {
    // The singleton guard reports "already running" as a value; a catch-only
    // guard would count that profile as a success.
    orchestratorMock.runPipeline.mockResolvedValue(notOk);

    await runProfileSequence([entry("a"), entry("b")]);

    const terminal = getProgress();
    expect(terminal.step).toBe("failed");
    expect(terminal.error).toBe("All 2 profiles failed");
  });

  it("stops the chain when a cancel lands between profiles", async () => {
    orchestratorMock.runPipeline.mockImplementation(async () => {
      requestProfileSequenceCancel();
      return ok;
    });

    await runProfileSequence([entry("a"), entry("b"), entry("c")]);

    expect(orchestratorMock.runPipeline).toHaveBeenCalledTimes(1);
    const terminal = getProgress();
    expect(terminal.step).toBe("cancelled");
    expect(terminal.detail).toBe("1 of 3 profiles completed, 2 not started");
  });

  it("reports a cancelled profile as stopped, not failed", async () => {
    // The cancelled run returns non-success; blaming it as "failed" would
    // report the user's own cancel as a fault. And with nothing left
    // unstarted, the "not started" clause must not appear at all.
    orchestratorMock.runPipeline
      .mockResolvedValueOnce(ok)
      .mockImplementationOnce(async () => {
        requestProfileSequenceCancel();
        return { ...notOk, error: "Cancelled by user request" };
      });

    await runProfileSequence([entry("a"), entry("b")]);

    const terminal = getProgress();
    expect(terminal.step).toBe("cancelled");
    expect(terminal.detail).toBe("1 of 2 profiles completed, 1 stopped");
  });

  it("reports completed when the rate limit stops a chain that already landed profiles", async () => {
    // `failed` gates the Swipe deck refetch and fires an error toast, so a
    // chain that imported two profiles' jobs before the wall must not use it.
    const { consumeRateLimitRetry } = await import(
      "../services/llm/rate-limit-budget"
    );
    orchestratorMock.runPipeline.mockImplementation(async () => {
      resetRateLimitBudget(0);
      consumeRateLimitRetry("You've hit your session limit");
      return ok;
    });

    await runProfileSequence([entry("a"), entry("b"), entry("c")]);

    expect(orchestratorMock.runPipeline).toHaveBeenCalledTimes(1);
    const terminal = getProgress();
    expect(terminal.step).toBe("completed");
    expect(terminal.message).toMatch(/rate limited/i);
  });

  it("reports failed when the rate limit stops a chain before anything landed", async () => {
    const { consumeRateLimitRetry } = await import(
      "../services/llm/rate-limit-budget"
    );
    orchestratorMock.runPipeline.mockImplementation(async () => {
      resetRateLimitBudget(0);
      consumeRateLimitRetry("You've hit your session limit");
      return notOk;
    });

    await runProfileSequence([entry("a"), entry("b")]);

    const terminal = getProgress();
    expect(terminal.step).toBe("failed");
  });

  it("re-asserts the cancel when it lands in the commit window", async () => {
    // A cancel arriving after the loop's check but before runPipeline started
    // would otherwise be wiped: runPipeline clears the orchestrator's cancel
    // flag at entry. The re-assert must land with no await in between.
    requestProfileSequenceCancel();
    endProfileSequence();
    tryBeginProfileSequence();

    orchestratorMock.runPipeline.mockImplementation(async () => {
      requestProfileSequenceCancel();
      return ok;
    });

    await runProfileSequence([entry("a"), entry("b")]);

    expect(orchestratorMock.requestPipelineCancel).toHaveBeenCalledTimes(1);
  });
});
