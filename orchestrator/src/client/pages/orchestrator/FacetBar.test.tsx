import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FacetBar } from "./FacetBar";

const handlers = () => ({
  onAddFacet: vi.fn(),
  onRemoveFacet: vi.fn(),
  onSetFacetValue: vi.fn(),
  onClearFacets: vi.fn(),
});

describe("FacetBar", () => {
  it("opens the add menu and adds the chosen facet by id", () => {
    const h = handlers();
    render(<FacetBar activeFacets={[]} {...h} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(
      screen.getByRole("menuitem", { name: "Company" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Title" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Location" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Company" }));
    expect(h.onAddFacet).toHaveBeenCalledWith("employer");
  });

  it("renders active facet chips, hides them from the add menu, and edits value", () => {
    const h = handlers();
    render(<FacetBar activeFacets={[{ id: "employer", value: "" }]} {...h} />);

    const input = screen.getByLabelText("Company filter");
    fireEvent.change(input, { target: { value: "acme" } });
    // Typing updates the field but must NOT filter yet.
    expect(input).toHaveValue("acme");
    expect(h.onSetFacetValue).not.toHaveBeenCalled();
    // Blur must not commit either — Enter is the only trigger.
    fireEvent.blur(input);
    expect(h.onSetFacetValue).not.toHaveBeenCalled();
    // Enter commits the value → triggers the filter.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(h.onSetFacetValue).toHaveBeenCalledWith("employer", "acme");

    // Already-active facet is not offered again.
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    expect(
      screen.queryByRole("menuitem", { name: "Company" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Title" })).toBeInTheDocument();
  });

  it("removes a facet and clears all", () => {
    const h = handlers();
    render(
      <FacetBar activeFacets={[{ id: "employer", value: "acme" }]} {...h} />,
    );

    fireEvent.click(screen.getByLabelText("Remove Company filter"));
    expect(h.onRemoveFacet).toHaveBeenCalledWith("employer");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(h.onClearFacets).toHaveBeenCalledTimes(1);
  });
});
