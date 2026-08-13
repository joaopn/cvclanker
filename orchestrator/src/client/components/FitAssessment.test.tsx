import { createJob } from "@shared/testing/factories.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FitAssessment } from "./FitAssessment";

describe("FitAssessment", () => {
  it("names the model that scored the job", () => {
    render(
      <FitAssessment
        job={createJob({
          suitabilityReason: "Strong overlap.",
          suitabilityModel: "gpt-5-mini",
          suitabilityEffort: null,
        })}
      />,
    );

    expect(screen.getByText("gpt-5-mini")).toBeInTheDocument();
  });

  it("appends the effort when the call ran with one", () => {
    render(
      <FitAssessment
        job={createJob({
          suitabilityReason: "Strong overlap.",
          suitabilityModel: "claude-sonnet-4-5",
          suitabilityEffort: "high",
        })}
      />,
    );

    expect(screen.getByText("claude-sonnet-4-5 (high)")).toBeInTheDocument();
  });

  it("shows nothing extra for a row scored before the model was recorded", () => {
    const { container } = render(
      <FitAssessment
        job={createJob({
          suitabilityReason: "Strong overlap.",
          suitabilityModel: null,
          // A stranded effort with no model must not render "(high)" alone.
          suitabilityEffort: "high",
        })}
      />,
    );

    expect(screen.getByText("Fit Assessment")).toBeInTheDocument();
    expect(container.textContent).not.toContain("high");
  });
});
