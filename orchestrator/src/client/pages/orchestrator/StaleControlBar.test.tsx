import * as api from "@client/api";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  sweepStaleJobs: vi.fn(),
  sweepLiveClosedJobs: vi.fn(),
}));

const toastSuccess = vi.fn();
vi.mock("@client/lib/toast", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

import { StaleControlBar } from "./StaleControlBar";

beforeEach(() => {
  toastSuccess.mockClear();
  vi.mocked(api.sweepStaleJobs).mockReset();
});

describe("StaleControlBar", () => {
  it("sweeps Live/Interviewing rows under the applied scope", async () => {
    vi.mocked(api.sweepStaleJobs).mockResolvedValue({
      moved: 3,
      breakdown: { applied: 2, in_progress: 1 },
    });
    const onSwept = vi.fn();
    render(
      <StaleControlBar
        thresholdDays={21}
        onThresholdChange={vi.fn()}
        onSwept={onSwept}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Applied" }));

    await waitFor(() => expect(onSwept).toHaveBeenCalledTimes(1));
    expect(api.sweepStaleJobs).toHaveBeenCalledWith(21, "applied");
    expect(toastSuccess).toHaveBeenCalledWith("3 jobs moved to Stale", {
      description: "2 from Live · 1 from Interviewing",
    });
  });
});
