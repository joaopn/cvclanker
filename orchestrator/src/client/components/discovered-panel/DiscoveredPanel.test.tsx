import { composeTailoringFailure } from "@shared/tailoring-failure";
import { createJob } from "@shared/testing/factories.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
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

describe("failed-tailor detail disclosure", () => {
  const REASON = composeTailoringFailure(
    "Tailoring failed: The model returned the list of changes in an unexpected shape.",
    'Parsed value was a string.\npatchesJson (2554 chars) was:\n"[{...}]"',
  );

  const panel = (id: string, tailoringFailureReason: string) => (
    // StrictMode double-invokes render, which is where this component adjusts
    // its disclosure state — the reset must be idempotent under it.
    <StrictMode>
      <DiscoveredPanel
        job={createJob({ id, status: "processing", tailoringFailureReason })}
        onJobUpdated={noop}
        onJobMoved={noop}
      />
    </StrictMode>
  );

  it("shows the summary and hides the detail behind a disclosure", () => {
    render(panel("a", REASON));

    expect(
      screen.getByText(
        "Tailoring failed: The model returned the list of changes in an unexpected shape.",
      ),
    ).toBeInTheDocument();
    // The detail is what the user could not see before; it must not be
    // rendered until asked for.
    expect(screen.queryByText(/patchesJson/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/patchesJson \(2554 chars\)/)).toBeInTheDocument();
  });

  it("offers no disclosure for a reason that carries no detail", () => {
    render(panel("b", "Tailoring interrupted (server restart)"));

    expect(
      screen.getByText("Tailoring interrupted (server restart)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show details/i }),
    ).not.toBeInTheDocument();
  });

  it("collapses an expanded detail when a different job is shown", () => {
    const { rerender } = render(panel("a", REASON));
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    expect(screen.getByText(/patchesJson/)).toBeInTheDocument();

    // A fresh element: re-rendering an identical one makes React bail out and
    // the assertion would hold for the wrong reason.
    rerender(panel("second-job", REASON));

    expect(screen.queryByText(/patchesJson/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show details/i }),
    ).toBeInTheDocument();
  });
});
