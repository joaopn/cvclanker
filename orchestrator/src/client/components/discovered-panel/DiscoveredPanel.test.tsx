import { createJob } from "@shared/testing/factories.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@client/hooks/queries/useJobMutations", () => ({
  useSkipJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@client/hooks/useRescoreJob", () => ({
  useRescoreJob: () => ({ isRescoring: false, rescoreJob: vi.fn() }),
}));
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({ renderMarkdownInJobDescriptions: false }),
}));

import { DiscoveredPanel } from "./DiscoveredPanel";

const noop = () => {};

describe("DiscoveredPanel failed-tailor state", () => {
  it("shows the retry state (reason + Retry) for a failed processing row, not the spinner", () => {
    render(
      <DiscoveredPanel
        job={createJob({
          id: "f",
          status: "processing",
          tailoringFailureReason: "LLM provider error",
        })}
        onJobUpdated={noop}
        onJobMoved={noop}
      />,
    );
    expect(
      screen.getByText("Last tailoring attempt failed"),
    ).toBeInTheDocument();
    expect(screen.getByText("LLM provider error")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /retry tailoring/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Processing job/i)).not.toBeInTheDocument();
  });

  it("shows the spinner for a clean (running) processing row", () => {
    render(
      <DiscoveredPanel
        job={createJob({ id: "r", status: "processing" })}
        onJobUpdated={noop}
        onJobMoved={noop}
      />,
    );
    expect(screen.getByText(/Processing job/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Last tailoring attempt failed"),
    ).not.toBeInTheDocument();
  });
});
