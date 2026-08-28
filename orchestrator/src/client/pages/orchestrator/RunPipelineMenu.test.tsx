import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { RunOptionSource, RunOptionsResponse } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunOptions = vi.fn();
vi.mock("@client/api", () => ({
  getRunOptions: (...args: unknown[]) => getRunOptions(...args),
}));

// Radix Popover cannot open in jsdom (no pointer capture). The shim renders
// inline but still routes the trigger through `onOpenChange`, because the
// options query is gated on the menu actually being open — a shim that ignored
// that would render an empty menu and assert nothing.
const popoverState = vi.hoisted(() => ({
  setOpen: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    popoverState.setOpen = onOpenChange;
    return <div>{children}</div>;
  },
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button" onClick={() => popoverState.setOpen?.(true)}>
      {children}
    </button>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { RunPipelineMenu } from "./RunPipelineMenu";

const source = (overrides: Partial<RunOptionSource>): RunOptionSource => ({
  key: "jobspy",
  kind: "extractor",
  label: "JobSpy",
  platforms: ["indeed", "linkedin"],
  incompatible: [],
  lastScrapedAt: null,
  capDays: null,
  windowSupport: "run_window",
  maxAgeBuckets: null,
  note: null,
  ...overrides,
});

const options = (
  overrides: Partial<RunOptionsResponse> = {},
): RunOptionsResponse => ({
  profileIds: ["p1"],
  sources: [source({})],
  capDays: null,
  defaultSinceLastRun: true,
  ...overrides,
});

const runButton = () => screen.getByRole("button", { name: /^Run$/ });

const renderMenu = async (
  data: RunOptionsResponse,
  onRun = vi.fn(),
  profileIds = ["p1"],
) => {
  getRunOptions.mockResolvedValue(data);
  renderWithQueryClient(
    <RunPipelineMenu selectedProfileIds={profileIds} onRun={onRun} />,
  );
  fireEvent.click(screen.getByText("Run pipeline"));
  await waitFor(() => expect(runButton()).toBeTruthy());
  return onRun;
};

describe("RunPipelineMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends no scoping when every source stays ticked", async () => {
    const onRun = await renderMenu(
      options({ sources: [source({}), source({ key: "hiringcafe" })] }),
    );

    fireEvent.click(runButton());
    // The mode rides along even when nothing is scoped: omitting it would fall
    // through to the Profile's own flag, making this button a no-op on any
    // Profile that has not ticked it.
    expect(onRun).toHaveBeenCalledWith({ scrapeSinceLastRun: true });
  });

  /**
   * The Profile's flag decides which button opens pressed, and its max job age
   * seeds the input — so an untouched menu reproduces what a plain Run would
   * have done.
   */
  it("opens on the explicit window when the Profile does not narrow", async () => {
    const onRun = await renderMenu(
      options({ defaultSinceLastRun: false, capDays: 14 }),
    );

    fireEvent.click(runButton());
    expect(onRun).toHaveBeenCalledWith({
      scrapeWindowDays: 14,
      scrapeSinceLastRun: false,
    });
  });

  it("expands a deselection into the remaining platforms", async () => {
    const onRun = await renderMenu(
      options({
        sources: [
          source({}),
          source({
            key: "hiringcafe",
            label: "Hiring Cafe",
            platforms: ["hiringcafe"],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByText("Hiring Cafe"));
    fireEvent.click(runButton());

    expect(onRun).toHaveBeenCalledWith({
      sources: ["indeed", "linkedin"],
      providerInstanceIds: [],
      scrapeSinceLastRun: true,
    });
  });

  it("sends an explicit window and switches the narrowing off", async () => {
    const onRun = await renderMenu(options());

    fireEvent.click(screen.getByRole("button", { name: "Last N days" }));
    fireEvent.click(runButton());

    expect(onRun).toHaveBeenCalledWith({
      scrapeWindowDays: 1,
      scrapeSinceLastRun: false,
    });
  });

  it("blocks the run when the window exceeds a selected source's cap", async () => {
    await renderMenu(
      options({ sources: [source({ capDays: 7 })], capDays: 7 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Last N days" }));
    fireEvent.change(screen.getByLabelText("Days to scrape"), {
      target: { value: "30" },
    });

    expect(screen.getByText(/only allows 7 days/)).toBeTruthy();
    expect(runButton().hasAttribute("disabled")).toBe(true);
  });

  /**
   * A round-UP costs money on a pay-per-result actor but loses no coverage, so
   * it must inform without refusing — the opposite of a clamp DOWN.
   */
  it("warns without blocking when an actor rounds the window up", async () => {
    await renderMenu(
      options({
        sources: [
          source({
            key: "apify:abc",
            kind: "provider_instance",
            label: "ACME",
            platforms: [],
            maxAgeBuckets: [1, 7, 30],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Last N days" }));
    fireEvent.change(screen.getByLabelText("Days to scrape"), {
      target: { value: "2" },
    });

    expect(screen.getByText(/rounds up to 7 days/)).toBeTruthy();
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("shows an unrunnable source disabled, with the reason", async () => {
    await renderMenu(
      options({
        sources: [
          source({
            key: "glassdoor",
            label: "Glassdoor",
            platforms: [],
            incompatible: [
              { platform: "glassdoor", reasons: ["needs at least one city"] },
            ],
          }),
        ],
      }),
    );

    expect(screen.getByText(/needs at least one city/)).toBeTruthy();
    // Nothing selectable is left, so there is nothing to run.
    expect(runButton().hasAttribute("disabled")).toBe(true);
  });

  it("says no ceiling is configured when the Profile has no max job age", async () => {
    await renderMenu(options({ capDays: null }));
    expect(screen.getByText("No ceiling configured")).toBeTruthy();
  });

  /**
   * The run route refuses `sources` alongside `profileIds`, so a chain must not
   * offer source buttons at all — sending them would 400 the run.
   */
  it("scopes sources on a chain, and says the choice hits every leg", async () => {
    getRunOptions.mockResolvedValue(
      options({
        profileIds: ["p1", "p2"],
        sources: [
          source({}),
          source({
            key: "hiringcafe",
            label: "Hiring Cafe",
            platforms: ["hiringcafe"],
          }),
        ],
      }),
    );
    const onRun = vi.fn();
    renderWithQueryClient(
      <RunPipelineMenu selectedProfileIds={["p1", "p2"]} onRun={onRun} />,
    );
    fireEvent.click(screen.getByText("Run pipeline"));

    await waitFor(() => expect(screen.getByText("Sources")).toBeTruthy());
    expect(screen.getByText(/2 profiles run one after another/)).toBeTruthy();

    fireEvent.click(screen.getByText("Hiring Cafe"));
    fireEvent.click(runButton());

    // The server narrows each leg's OWN pins by this list rather than replacing
    // them, which is what makes one list safe across profiles that pin
    // different sources.
    expect(onRun).toHaveBeenCalledWith({
      sources: ["indeed", "linkedin"],
      providerInstanceIds: [],
      scrapeSinceLastRun: true,
    });
  });

  it("asks for every selected profile's options", async () => {
    getRunOptions.mockResolvedValue(options({ profileIds: ["p1", "p2"] }));
    renderWithQueryClient(
      <RunPipelineMenu selectedProfileIds={["p1", "p2"]} onRun={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Run pipeline"));

    await waitFor(() => expect(runButton()).toBeTruthy());
    expect(getRunOptions).toHaveBeenCalledWith(["p1", "p2"]);
  });

  it("lists every board a fan-out source covers, one per line", async () => {
    await renderMenu(
      options({ sources: [source({ platforms: ["indeed", "linkedin"] })] }),
    );

    expect(screen.getByText("Indeed")).toBeTruthy();
    expect(screen.getByText("LinkedIn")).toBeTruthy();
  });

  it("does not repeat a single-board source under its own name", async () => {
    await renderMenu(
      options({
        sources: [
          source({
            key: "hiringcafe",
            label: "Hiring Cafe",
            platforms: ["hiringcafe"],
          }),
        ],
      }),
    );

    expect(screen.getAllByText(/Hiring Cafe/)).toHaveLength(1);
  });

  /**
   * The Profile's flag decides which button opens pressed, and its max job age
   * seeds the input — so an untouched menu reproduces what a plain Run would
   * have done.
   */
  it("opens on the explicit window when the Profile does not narrow", async () => {
    const onRun = await renderMenu(
      options({ defaultSinceLastRun: false, capDays: 14 }),
    );

    fireEvent.click(runButton());
    expect(onRun).toHaveBeenCalledWith({
      scrapeWindowDays: 14,
      scrapeSinceLastRun: false,
    });
  });
});
