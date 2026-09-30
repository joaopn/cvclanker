import { defaultProfileConfig } from "@shared/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formFromConfig, ProfileConfigFields } from "./ProfileConfigFields";

function renderRunSection(searchTerms: string[], termJobBudget: string) {
  const form = {
    ...formFromConfig("P", { ...defaultProfileConfig(), searchTerms }),
    termJobBudget,
  };
  render(
    <ProfileConfigFields
      form={form}
      onChange={vi.fn()}
      extractors={[]}
      instances={[]}
      sections={["run"]}
    />,
  );
}

describe("ProfileConfigFields term job budgets", () => {
  it("shows each term's box the default that saving would use", () => {
    renderRunSection(["AI Engineer"], "3");
    // "3" is clamped to the actor's minimum on save, so that is what shows.
    expect(screen.getByLabelText("AI Engineer")).toHaveAttribute(
      "placeholder",
      "10",
    );
  });

  it("does not describe a term list the profile does not have yet", () => {
    renderRunSection([], "100");
    expect(
      screen.getByText(/Once the profile has search terms/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Give a term below/)).toBeNull();
  });
});
