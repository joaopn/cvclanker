import * as api from "@client/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  getSchedules: vi.fn(async () => ({
    schedules: [],
    pausedReason: null,
    timeZone: "UTC",
  })),
  getProfiles: vi.fn(async () => ({ profiles: [], defaultProfileId: null })),
  getRunOptions: vi.fn(async () => ({ sources: [] })),
  updateSchedule: vi.fn(),
  createSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  resumeScheduling: vi.fn(),
}));

// The run banner opens an SSE subscription; this page only needs to render.
vi.mock("@client/lib/progress-stream", () => ({
  subscribeToPipelineProgress: vi.fn(() => () => {}),
}));

import { SchedulePage } from "./SchedulePage";

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/schedule"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<SchedulePage />, { wrapper });
};

describe("SchedulePage header", () => {
  it("renders the CV Clanker wordmark, like every other top-level page", () => {
    renderPage();

    // `PageHeader` renders `titleSlot` IN PLACE OF the title/subtitle block, so
    // a page that passes a titleSlot and omits `brand` silently loses the
    // wordmark and its header sits flush left against Swipe's and Manage's.
    // `title="CV Clanker"` does NOT cover it — that prop is inert here.
    expect(screen.getByText("CV Clanker")).toBeInTheDocument();
  });

  it("keeps the view toggle, with Schedule as the active segment", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Swipe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Schedule" }),
    ).toBeInTheDocument();
  });
});

describe("SchedulePage auto-skip default", () => {
  /**
   * A new schedule stores null ("follow Settings"), so the box can only show
   * what the run will do if the page hands the editor the setting. Radix
   * renders an undefined/false `checked` as unticked, so only a setting that
   * is ON pins it.
   */
  it("opens a new schedule's auto-skip box ticked when Settings sets a tier", async () => {
    vi.mocked(api.getRunOptions).mockResolvedValue({
      sources: [],
      autoSkipCategory: "good_fit",
    } as unknown as Awaited<ReturnType<typeof api.getRunOptions>>);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /New schedule/ }));

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Auto-skip bad matches" }),
      ).toBeChecked(),
    );
  });
});
