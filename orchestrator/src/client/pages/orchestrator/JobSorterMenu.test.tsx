import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { JobSorterMenu } from "./JobSorterMenu";

// The real Radix DropdownMenu can't open in jsdom (no pointer-capture /
// ResizeObserver) — same shell mock as ProfileSelect.test.tsx. This pins the
// mapping (three radio options, checked state, change callback, active
// trigger), not Radix behaviour.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  // The radio items are rendered here from the group's children so the
  // checked state comes from the group's `value`, as Radix does it.
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactElement<{
      value: string;
      children: React.ReactNode;
    }>[];
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <fieldset>
      {children.map((child) => (
        <button
          key={child.props.value}
          type="button"
          role="menuitemradio"
          aria-checked={child.props.value === value ? "true" : "false"}
          onClick={() => onValueChange(child.props.value)}
        >
          {child.props.children}
        </button>
      ))}
    </fieldset>
  ),
  DropdownMenuRadioItem: () => null,
}));

describe("JobSorterMenu", () => {
  it("offers the three sorter options with the current one checked", () => {
    render(<JobSorterMenu sorter="posted" onSorterChange={vi.fn()} />);

    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "None",
      "Posted / found",
      "Fewer applicants",
    ]);
    expect(
      screen.getByRole("menuitemradio", { name: "Posted / found" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "None" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reports the picked option", () => {
    const onSorterChange = vi.fn();
    render(<JobSorterMenu sorter="none" onSorterChange={onSorterChange} />);

    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Fewer applicants" }),
    );
    expect(onSorterChange).toHaveBeenCalledWith("applicants");
  });

  it("marks the trigger active only while a sorter is set", () => {
    const { rerender } = render(
      <JobSorterMenu sorter="none" onSorterChange={vi.fn()} />,
    );
    const trigger = () => screen.getByRole("button", { name: "Sort jobs" });
    expect(trigger()).toHaveAttribute("data-active", "false");
    expect(trigger()).toHaveAttribute("title", "Sort jobs");

    rerender(<JobSorterMenu sorter="applicants" onSorterChange={vi.fn()} />);
    expect(trigger()).toHaveAttribute("data-active", "true");
    expect(trigger()).toHaveAttribute("title", "Sorted by Fewer applicants");
  });
});
