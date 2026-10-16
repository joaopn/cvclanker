import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  emptyDraft,
  type ScheduleDraft,
  ScheduleEditorDialog,
} from "./ScheduleEditorDialog";

const renderDialog = (
  draft: ScheduleDraft,
  autoSkipSetting: "good_fit" | null,
) => {
  const onChange = vi.fn();
  render(
    <ScheduleEditorDialog
      open
      draft={draft}
      timeZone="UTC"
      profiles={[]}
      runOptionSources={[]}
      autoSkipSetting={autoSkipSetting}
      saving={false}
      onChange={onChange}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const box = screen.getByRole("checkbox", { name: "Auto-skip bad matches" });
  return { box, onChange };
};

describe("ScheduleEditorDialog auto-skip", () => {
  it("shows the setting while the schedule follows it, and pins false on untick", () => {
    const { box, onChange } = renderDialog(emptyDraft(), "good_fit");

    expect(box).toBeChecked();
    expect(screen.getByText(/Good fit or lower go straight/)).toBeTruthy();

    fireEvent.click(box);
    expect(onChange.mock.calls.at(-1)?.[0].autoSkipBadMatches).toBe(false);
  });

  it("pins true when ticked with Settings off", () => {
    const { box, onChange } = renderDialog(emptyDraft(), null);

    expect(box).not.toBeChecked();
    expect(screen.queryByText(/go straight to Skipped/)).toBeNull();

    fireEvent.click(box);
    expect(onChange.mock.calls.at(-1)?.[0].autoSkipBadMatches).toBe(true);
  });

  it("honours an explicit choice over the setting", () => {
    const { box } = renderDialog(
      { ...emptyDraft(), autoSkipBadMatches: false },
      "good_fit",
    );

    expect(box).not.toBeChecked();
  });
});
