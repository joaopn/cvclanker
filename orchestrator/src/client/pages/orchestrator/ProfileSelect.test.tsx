import { defaultProfileConfig, type Profile } from "@shared/types";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { ProfileSelect } from "./ProfileSelect";

// The real Radix DropdownMenu can't open in jsdom (no pointer-capture /
// ResizeObserver). Mock it to an always-rendered shell — this validates
// ProfileSelect's mapping (profiles -> checkbox items, tick -> onToggle,
// selection -> trigger label), not Radix behaviour, which is left to the
// browser smoke.
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
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: React.ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked ? "true" : "false"}
      onClick={() => onCheckedChange?.(!checked)}
    >
      {children}
    </button>
  ),
}));

function makeProfile(id: string, name: string): Profile {
  return {
    id,
    name,
    config: defaultProfileConfig(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const PROFILES = [
  makeProfile("a", "Berlin backend"),
  makeProfile("b", "EU ML"),
  makeProfile("c", "Remote data"),
];

describe("ProfileSelect", () => {
  it("renders an item per profile, ticked for the selected ones", () => {
    render(
      <ProfileSelect
        profiles={PROFILES}
        selectedProfileIds={["a", "c"]}
        onToggle={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("menuitemcheckbox", { name: "Berlin backend" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "EU ML" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Remote data" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("shows the profile name for one selection and a count for several", () => {
    const { rerender } = render(
      <ProfileSelect
        profiles={PROFILES}
        selectedProfileIds={["b"]}
        onToggle={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Active profiles/ }),
    ).toHaveTextContent("EU ML");

    rerender(
      <ProfileSelect
        profiles={PROFILES}
        selectedProfileIds={["a", "b"]}
        onToggle={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Active profiles/ }),
    ).toHaveTextContent("2 profiles");
  });

  it("reports a toggle with the profile id, both ticking and unticking", () => {
    const onToggle = vi.fn();
    render(
      <ProfileSelect
        profiles={PROFILES}
        selectedProfileIds={["a"]}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "EU ML" }));
    expect(onToggle).toHaveBeenCalledWith("b");

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Berlin backend" }),
    );
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("renders nothing when there are no profiles", () => {
    const { container } = render(
      <ProfileSelect
        profiles={[]}
        selectedProfileIds={[]}
        onToggle={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
