import type { JobListItem } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("hides skipped jobs once the tickbox is ticked", async () => {
    renderDialog([
      jobItem({ id: "j1", title: "Staff Engineer" }),
      jobItem({ id: "j2", title: "Retired Listing", status: "skipped" }),
    ]);

    expect(await screen.findByText("Retired Listing")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /hide skipped/i }));

    expect(screen.queryByText("Retired Listing")).not.toBeInTheDocument();
    expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
  });

  // Gating this control on "there is something to hide" hid it from most of the
  // companies reachable from the Inbox, and it was reported as missing. It
  // renders wherever there are jobs now; the COUNT is what disappears.
  it("offers the tickbox even when this company has nothing skipped", async () => {
    renderDialog([jobItem({ id: "j1", title: "Staff Engineer" })]);

    expect(await screen.findByText("Staff Engineer")).toBeInTheDocument();
    // No count, because there is nothing to hide — "(0)" would read as a figure
    // about the list rather than as the absence of one. Exact-name match, so a
    // regression to "Hide skipped (0)" fails here.
    const tickbox = screen.getByRole("checkbox", { name: "Hide skipped" });

    // Ticking is a no-op rather than a control that empties the dialog. (Both
    // assertions restate the filter test from the other side; the pin for the
    // filter itself is the "hides skipped jobs" case.)
    fireEvent.click(tickbox);
    expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText("\u00b7 1 job")).toBeInTheDocument();
  });

  it("counts what it would hide in the label", async () => {
    renderDialog([
      jobItem({ id: "j1", title: "Staff Engineer" }),
      jobItem({ id: "j2", title: "Retired Listing", status: "skipped" }),
    ]);

    expect(
      await screen.findByRole("checkbox", { name: "Hide skipped (1)" }),
    ).toBeInTheDocument();
  });

  it("counts the jobs on screen, not the ones it is hiding", async () => {
    renderDialog([
      jobItem({ id: "j1", title: "Staff Engineer" }),
      jobItem({ id: "j2", title: "Retired Listing", status: "skipped" }),
      jobItem({ id: "j3", title: "Also Retired", status: "skipped" }),
    ]);

    expect(await screen.findByText("\u00b7 3 jobs")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: /hide skipped \(2\)/i }),
    );

    expect(screen.getByText("\u00b7 1 job")).toBeInTheDocument();
    // Re-queried by the COUNTED name after the tick: the label keeps naming how
    // many are hidden, which is the only thing that stops the header's new
    // figure losing the total. Asserting it before the click would not.
    expect(
      screen.getByRole("checkbox", { name: /hide skipped \(2\)/i }),
    ).toBeInTheDocument();
  });

  it("says why the list is empty when every job here is skipped", async () => {
    renderDialog([
      jobItem({ id: "j1", title: "Retired Listing", status: "skipped" }),
    ]);

    fireEvent.click(
      await screen.findByRole("checkbox", { name: /hide skipped/i }),
    );

    expect(
      screen.getByText("Every job from this company is skipped."),
    ).toBeInTheDocument();
    // Not the never-had-any copy, which would be a lie - and the tickbox has to
    // stay on screen or there is no way back to the rows it just hid.
    expect(
      screen.queryByText("No jobs from this company."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /hide skipped/i }),
    ).toBeInTheDocument();
  });

  it("keeps the choice when the dialog moves to another company", async () => {
    getJobs.mockResolvedValue({
      jobs: [
        jobItem({ id: "j1", title: "Staff Engineer" }),
        jobItem({ id: "j2", title: "Retired Listing", status: "skipped" }),
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // One factory, so the second render varies only the `employer` argument —
    // which is the whole claim under test.
    const ui = (employer: string) => (
      <QueryClientProvider client={client}>
        <CompanyJobsDialog
          employer={employer}
          onClose={vi.fn()}
          onSelectJob={vi.fn()}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(ui("Acme Corp"));

    fireEvent.click(
      await screen.findByRole("checkbox", { name: /hide skipped/i }),
    );
    expect(screen.queryByText("Retired Listing")).not.toBeInTheDocument();

    rerender(ui("Globex"));

    expect(
      await screen.findByRole("checkbox", { name: /hide skipped/i }),
    ).toBeChecked();
    expect(screen.queryByText("Retired Listing")).not.toBeInTheDocument();
  });

  it("offers no tickbox while the jobs are still loading", async () => {
    getJobs.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CompanyJobsDialog
          employer="Acme Corp"
          onClose={vi.fn()}
          onSelectJob={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /hide skipped/i }),
    ).not.toBeInTheDocument();
  });

  it("offers no tickbox for a company with no jobs at all", async () => {
    renderDialog([]);

    expect(
      await screen.findByText("No jobs from this company."),
    ).toBeInTheDocument();
    // A filter above an empty list would suggest the emptiness was its doing.
    expect(
      screen.queryByRole("checkbox", { name: /hide skipped/i }),
    ).not.toBeInTheDocument();
  });

  // The `query.isSuccess` term is load-bearing ONLY here: react-query keeps the
  // previous `data` when a REFETCH fails, so `allJobs.length > 0` is still true
  // and would put the tickbox above the "Couldn't load jobs" copy with no list.
  it("offers no tickbox once a refetch has failed", async () => {
    getJobs.mockResolvedValue({
      jobs: [
        jobItem({ id: "j1", title: "Staff Engineer" }),
        jobItem({ id: "j2", title: "Retired Listing", status: "skipped" }),
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CompanyJobsDialog
          employer="Acme Corp"
          onClose={vi.fn()}
          onSelectJob={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("checkbox", { name: /hide skipped/i }),
    ).toBeInTheDocument();

    getJobs.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await client.refetchQueries();
    });

    expect(
      await screen.findByText("Couldn't load jobs for this company."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /hide skipped/i }),
    ).not.toBeInTheDocument();
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
