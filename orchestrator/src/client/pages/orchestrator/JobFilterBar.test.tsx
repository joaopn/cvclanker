import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JOB_FILTER_CHIP_TYPES } from "./constants";
import { JobFilterBar } from "./JobFilterBar";

const baseProps = () => ({
  availableTypes: [...JOB_FILTER_CHIP_TYPES],
  enabledTypes: ["fit" as const],
  onToggleType: vi.fn(),
  fitFilter: [],
  onFitFilterChange: vi.fn(),
  profiles: [
    { id: "p1", name: "Backend Vienna" },
    { id: "p2", name: "Data Berlin" },
  ],
  profileFilter: [],
  onToggleProfile: vi.fn(),
  titles: ["data engineer", "platform engineer"],
  titleFilter: [],
  onToggleTitle: vi.fn(),
});

describe("JobFilterBar", () => {
  it("offers a tickbox per available family and shows only the fit row by default", () => {
    render(<JobFilterBar {...baseProps()} />);

    expect(screen.getByLabelText("Fit")).toBeChecked();
    expect(screen.getByLabelText("Profile")).not.toBeChecked();
    expect(screen.getByLabelText("Job title")).not.toBeChecked();

    expect(
      screen.getByRole("group", { name: "Fit filters" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Search profile filters" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Job title filters" }),
    ).not.toBeInTheDocument();
  });

  it("reports a tickbox toggle", () => {
    const props = baseProps();
    render(<JobFilterBar {...props} />);

    fireEvent.click(screen.getByLabelText("Profile"));
    expect(props.onToggleType).toHaveBeenCalledWith("profile");
  });

  it("keeps the fit chips behaving as before", () => {
    const props = baseProps();
    render(<JobFilterBar {...props} fitFilter={["good_fit"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Great fit" }));
    // Canonical order, not click order.
    expect(props.onFitFilterChange).toHaveBeenCalledWith([
      "great_fit",
      "good_fit",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Good fit" }));
    expect(props.onFitFilterChange).toHaveBeenLastCalledWith([]);
  });

  it("offers an Unattributed badge beside the real profiles", () => {
    const props = baseProps();
    render(<JobFilterBar {...props} enabledTypes={["profile"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Unattributed" }));
    expect(props.onToggleProfile).toHaveBeenCalledWith("__unattributed__");
  });

  it("renders one badge per profile and reports the id", () => {
    const props = baseProps();
    render(
      <JobFilterBar
        {...props}
        enabledTypes={["profile"]}
        profileFilter={["p2"]}
      />,
    );

    expect(
      screen.queryByRole("group", { name: "Fit filters" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data Berlin" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Backend Vienna" }));
    expect(props.onToggleProfile).toHaveBeenCalledWith("p1");
  });

  it("renders one badge per job title and reports the term", () => {
    const props = baseProps();
    render(<JobFilterBar {...props} enabledTypes={["title"]} />);

    fireEvent.click(screen.getByRole("button", { name: "data engineer" }));
    expect(props.onToggleTitle).toHaveBeenCalledWith("data engineer");
  });

  it("explains an empty family instead of rendering a blank row", () => {
    render(
      <JobFilterBar
        {...baseProps()}
        enabledTypes={["profile", "title"]}
        profiles={[]}
        titles={[]}
      />,
    );

    expect(screen.getByText("No search profiles yet.")).toBeInTheDocument();
    expect(
      screen.getByText("No search terms in any Search Profile yet."),
    ).toBeInTheDocument();
  });

  it("hides a family the tab does not offer, even when it is enabled", () => {
    render(
      <JobFilterBar
        {...baseProps()}
        availableTypes={["profile", "title"]}
        enabledTypes={["fit", "profile"]}
      />,
    );

    expect(screen.queryByLabelText("Fit")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Fit filters" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Search profile filters" }),
    ).toBeInTheDocument();
  });

  it("renders the facet bar slot on the tickbox row", () => {
    render(
      <JobFilterBar {...baseProps()} facetBar={<div>FACET_BAR_SLOT</div>} />,
    );

    expect(screen.getByText("FACET_BAR_SLOT")).toBeInTheDocument();
  });
});
