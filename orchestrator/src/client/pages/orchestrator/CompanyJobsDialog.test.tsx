import type { JobListItem } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const getJobs = vi.fn();

vi.mock("@client/api", () => ({
  getJobs: (...args: unknown[]) => getJobs(...args),
}));

// Stubbed so this file asserts what the DIALOG owns — that the menu is offered
// at all, and which company it is handed. The menu's own behaviour, including
// the profile list it fetches, is covered in BlacklistCompanyMenu.test.tsx.
vi.mock("./BlacklistCompanyMenu", () => ({
  BlacklistCompanyMenu: ({ employer }: { employer: string }) => (
    <div data-testid="blacklist-menu">{employer}</div>
  ),
}));

import { CompanyJobsDialog } from "./CompanyJobsDialog";

function jobItem(
  overrides: Partial<JobListItem> & { id: string },
): JobListItem {
  return {
    source: "linkedin",
    sourceLabel: "LinkedIn",
    title: "Senior Data Engineer",
    employer: "Acme Corp",
    jobUrl: `https://example.com/${overrides.id}`,
    applicationLink: null,
    datePosted: null,
    deadline: null,
    salary: null,
    location: null,
    status: "discovered",
    outcome: null,
    closedAt: null,
    suitabilityCategory: null,
    tailoringFailureReason: null,
    jobType: null,
    jobFunction: null,
    salaryMinAmount: null,
    salaryMaxAmount: null,
    salaryCurrency: null,
    repostedAt: null,
    repostCount: 0,
    discoveredAt: "2026-05-01T00:00:00.000Z",
    readyAt: null,
    appliedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as JobListItem;
}

const renderDialog = (jobs: JobListItem[], employer = "Acme Corp") => {
  getJobs.mockResolvedValue({ jobs });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CompanyJobsDialog
        employer={employer}
        onClose={vi.fn()}
        onSelectJob={vi.fn()}
      />
    </QueryClientProvider>,
  );
};

describe("CompanyJobsDialog", () => {
  it("labels each job with its fit classification", async () => {
    renderDialog([
      jobItem({
        id: "j1",
        title: "Staff Engineer",
        suitabilityCategory: "great_fit",
      }),
      jobItem({
        id: "j2",
        title: "Data Analyst",
        suitabilityCategory: "bad_fit",
      }),
    ]);

    expect(await screen.findByText("Great")).toBeInTheDocument();
    expect(screen.getByText("Bad")).toBeInTheDocument();
  });

  it("omits the classification for an unscored job", async () => {
    renderDialog([jobItem({ id: "j1", title: "Staff Engineer" })]);

    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    for (const label of ["Great", "Very good", "Good", "Bad"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("offers the dialog's own company for blacklisting", async () => {
    renderDialog(
      [jobItem({ id: "j1", title: "Staff Engineer" })],
      "  Acme Corp  ",
    );

    // Not just "a menu is rendered": it must be handed the company whose jobs
    // this dialog is showing, trimmed — the keyword is stored verbatim.
    // textContent, not toHaveTextContent: the latter normalizes whitespace, so
    // it would pass on the untrimmed name the keyword must never be stored as.
    const menu = await screen.findByTestId("blacklist-menu");
    expect(menu.textContent).toBe("Acme Corp");
  });

  it("offers no blacklist action for a blank company name", () => {
    getJobs.mockResolvedValue({ jobs: [] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CompanyJobsDialog
          employer="   "
          onClose={vi.fn()}
          onSelectJob={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("blacklist-menu")).not.toBeInTheDocument();
  });
});
