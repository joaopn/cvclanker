import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type {
  StatsApplications,
  StatsCompanies,
  StatsDiscovery,
  StatsOverview,
} from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  getProfiles: vi.fn(),
  getStatsOverview: vi.fn(),
  getStatsDiscovery: vi.fn(),
  getStatsApplications: vi.fn(),
  getStatsCompanies: vi.fn(),
  getActiveUserProfile: vi.fn().mockResolvedValue({ name: "Default" }),
}));

import {
  getProfiles,
  getStatsApplications,
  getStatsCompanies,
  getStatsDiscovery,
  getStatsOverview,
} from "@client/api";
import { StatsPage } from "./StatsPage";

// Shaped like a real payload: `applied` EXCEEDS `tailored`, because applying
// does not stamp `ready_at`. A fixture with applied=0 hides the tile captions
// entirely, which is how a ratio that can read "400% of tailored" survived
// review once already.
const overview: StatsOverview = {
  found: 582,
  scored: 532,
  unscored: 50,
  goodFit: 176,
  tailored: 3,
  applied: 12,
  funnel: [
    {
      key: "found",
      label: "Found",
      count: 582,
      basis: "permanent",
      nested: false,
    },
    {
      key: "scored",
      label: "Scored",
      count: 532,
      basis: "current",
      nested: true,
    },
    {
      key: "good_fit",
      label: "Good fit or better",
      count: 176,
      basis: "current",
      nested: true,
    },
    {
      key: "tailored",
      label: "Tailored",
      count: 3,
      basis: "permanent",
      nested: false,
    },
    {
      key: "applied",
      label: "Applied",
      count: 12,
      basis: "permanent",
      nested: false,
    },
  ],
  calibration: [
    {
      category: "great_fit",
      skipped: 1,
      applied: 0,
      tailored: 0,
      closed: 0,
      inInbox: 0,
      total: 1,
    },
    {
      category: "very_good_fit",
      skipped: 21,
      applied: 0,
      tailored: 2,
      closed: 0,
      inInbox: 3,
      total: 26,
    },
    {
      category: "good_fit",
      skipped: 92,
      applied: 0,
      tailored: 0,
      closed: 7,
      inInbox: 50,
      total: 149,
    },
    {
      category: "bad_fit",
      skipped: 152,
      applied: 12,
      tailored: 1,
      closed: 8,
      inInbox: 183,
      total: 356,
    },
    {
      category: "unscored",
      skipped: 1,
      applied: 0,
      tailored: 0,
      closed: 0,
      inInbox: 49,
      total: 50,
    },
  ],
  activity: [
    { date: "2026-08-09", count: 124 },
    { date: "2026-08-17", count: 25 },
    { date: "2026-08-22", count: 227 },
  ],
};

const discovery: StatsDiscovery = {
  sources: [
    {
      source: "linkedin",
      label: "LinkedIn",
      jobs: 136,
      scored: 128,
      goodFit: 52,
    },
    {
      source: "apify:abc",
      label: "Paid actor",
      jobs: 25,
      scored: 25,
      goodFit: 0,
    },
    // Nothing scored: the fit rate must render as a dash, not a zero.
    {
      source: "himalayas",
      label: "Himalayas",
      jobs: 8,
      scored: 0,
      goodFit: 0,
    },
  ],
  profiles: [
    {
      profileId: null,
      name: "Unattributed",
      jobs: 233,
      scored: 200,
      goodFit: 117,
    },
  ],
  termAttributionAvailable: false,
  perRunYieldAvailable: false,
};

const applications: StatsApplications = {
  applied: 0,
  heardBack: 0,
  rejected: 0,
  advanced: 0,
  ghostedRecorded: 0,
  ghostedDerived: 0,
  stillWaiting: 0,
  closedOther: 0,
  movedOn: 0,
  medianReplyDays: null,
  replyTimeBuckets: [],
  replyTimeSampleSize: 0,
  outstanding: [],
  outstandingTotal: 0,
};

const companies: StatsCompanies = {
  companies: [
    {
      key: "acme",
      employer: "Acme",
      jobs: 21,
      scored: 20,
      goodFit: 8,
      applied: 3,
    },
    // Never scored: hit rate must read as absent, not as a measured zero.
    {
      key: "quiet ltd",
      employer: "Quiet Ltd",
      jobs: 4,
      scored: 0,
      goodFit: 0,
      applied: 0,
    },
  ],
  companiesTotal: 42,
  repostedJobs: 2,
  liveClosedJobs: 6,
  liveStatusChecked: 36,
  totalJobs: 582,
};

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={["/stats"]}>
      <Routes>
        <Route path="/stats" element={<StatsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("StatsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [],
      defaultProfileId: null,
    } as Awaited<ReturnType<typeof getProfiles>>);
    vi.mocked(getStatsOverview).mockResolvedValue(overview);
    vi.mocked(getStatsDiscovery).mockResolvedValue(discovery);
    vi.mocked(getStatsApplications).mockResolvedValue(applications);
    vi.mocked(getStatsCompanies).mockResolvedValue(companies);
  });

  it("shows the overview headline figures", async () => {
    renderPage();
    await screen.findByText("Jobs found");
    expect(screen.getAllByText("582").length).toBeGreaterThan(0);
    expect(screen.getAllByText("176").length).toBeGreaterThan(0);
    expect(screen.getByText(/50 jobs not scored yet/)).toBeInTheDocument();
  });

  it("never states a share of a total that does not contain it", async () => {
    // `applied` (12) exceeds `tailored` (3) on the ordinary apply-without-
    // tailoring path, so any caption phrased as a share of Tailored or of Good
    // fits would read as an impossible percentage.
    renderPage();
    await screen.findByText("Jobs found");

    expect(screen.queryByText(/of tailored/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/of good fits/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/400%/)).not.toBeInTheDocument();
  });

  it("shows the whole calibration crosstab in the order the server sends", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    for (const label of [
      "Great fit",
      "Very good fit",
      "Good fit",
      "Bad fit",
      "Unscored",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("fetches only the visible tab", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    expect(getStatsOverview).toHaveBeenCalledTimes(1);
    expect(getStatsDiscovery).not.toHaveBeenCalled();
    expect(getStatsApplications).not.toHaveBeenCalled();
    expect(getStatsCompanies).not.toHaveBeenCalled();
  });

  it("loads a tab's data when it is opened", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Discovery" }));

    expect(await screen.findByText("LinkedIn")).toBeInTheDocument();
    expect(getStatsDiscovery).toHaveBeenCalledTimes(1);
  });

  it("refetches with the range the user picked", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.click(screen.getByRole("button", { name: "30d" }));

    await waitFor(() => {
      expect(vi.mocked(getStatsOverview).mock.calls.at(-1)?.[0]).toEqual({
        days: 30,
        profileId: null,
      });
    });
  });

  it("sends no day filter for the all-time range", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => {
      expect(vi.mocked(getStatsOverview).mock.calls.at(-1)?.[0]).toEqual({
        days: null,
        profileId: null,
      });
    });
  });

  it("explains why search-term statistics are absent instead of showing an empty table", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Discovery" }));

    expect(
      await screen.findByText(
        /No job records which of a profile's search terms/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/counters live in memory/)).toBeInTheDocument();
  });

  it("shows a dash, not a zero, for a board with nothing scored", async () => {
    renderPage();
    await screen.findByText("Jobs found");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Discovery" }));

    await screen.findByText("Himalayas");
    const row = screen.getByText("Himalayas").closest("tr");
    expect(row).not.toBeNull();
    // "0.0%" would read as a measured verdict about the board.
    expect(row?.textContent).toContain("—");
    expect(row?.textContent).not.toContain("0.0%");
  });

  it("renders the companies tab with its own denominators and cut disclosed", async () => {
    renderPage();
    await screen.findByText("Jobs found");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Companies" }));

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    // 8 good of 20 SCORED, not of 21 postings.
    expect(screen.getByText("40%")).toBeInTheDocument();
    const quiet = screen.getByText("Quiet Ltd").closest("tr");
    expect(quiet?.textContent).toContain("—");
    // The 25-row cut has to say how much it cut.
    expect(screen.getByText(/of 42 by good fit/)).toBeInTheDocument();
  });

  it("tells the user an empty applications tab is empty, not broken", async () => {
    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Applications" }));

    expect(
      await screen.findByText(/No applications recorded in this range/),
    ).toBeInTheDocument();
  });

  it("surfaces a failed panel rather than rendering zeros", async () => {
    vi.mocked(getStatsOverview).mockRejectedValue(new Error("Boom"));
    renderPage();
    expect(await screen.findByText("Boom")).toBeInTheDocument();
  });

  it("renders no profile filter when there are no profiles", async () => {
    renderPage();
    await screen.findByText("Jobs found");
    expect(
      screen.queryByRole("button", { name: "All profiles" }),
    ).not.toBeInTheDocument();
  });

  it("offers a profile filter only when profiles exist", async () => {
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [{ id: "p1", name: "Remote" }],
      defaultProfileId: "p1",
    } as unknown as Awaited<ReturnType<typeof getProfiles>>);

    renderPage();
    await screen.findByText("Jobs found");

    fireEvent.click(await screen.findByRole("button", { name: "Remote" }));

    await waitFor(() => {
      expect(vi.mocked(getStatsOverview).mock.calls.at(-1)?.[0]).toEqual({
        days: 90,
        profileId: "p1",
      });
    });
  });
});
