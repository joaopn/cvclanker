import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type {
  ProviderActorTemplateSummary,
  ProviderInstanceRow,
} from "@shared/types";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const testProviderInstance = vi.hoisted(() => vi.fn());
vi.mock("@client/api", () => ({ testProviderInstance }));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProviderInstanceCard } from "./ProviderInstanceCard";

const instance = {
  id: "inst-1",
  providerId: "apify",
  actorRef: "curious_coder/linkedin-jobs-scraper",
  label: "LinkedIn",
  templateId: "linkedin-jobs-scraper",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  maxJobs: 1000,
  maxAgeDays: undefined,
  updatedAt: "2026-09-30T00:00:00.000Z",
} as unknown as ProviderInstanceRow;

const template = (
  overrides: Partial<ProviderActorTemplateSummary>,
): ProviderActorTemplateSummary => ({
  id: "linkedin-jobs-scraper",
  providerId: "apify",
  actorRef: "curious_coder/linkedin-jobs-scraper",
  displayName: "LinkedIn",
  description: "",
  defaultInputTemplate: "{}",
  defaultMappings: {},
  ...overrides,
});

describe("ProviderInstanceCard max jobs", () => {
  it("points a per-term actor at the Search Profile instead of offering the field", () => {
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: true })}
      />,
    );
    expect(screen.queryByLabelText("Max jobs (optional)")).toBeNull();
    expect(screen.getByText("Jobs per search term")).toBeInTheDocument();
  });

  it("keeps the field for an actor that runs once", () => {
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: false })}
      />,
    );
    expect(screen.getByLabelText("Max jobs (optional)")).toHaveValue(1000);
  });
});

describe("ProviderInstanceCard test result", () => {
  it("says which terms the preview tried, and where, when none had postings", async () => {
    testProviderInstance.mockResolvedValue({
      outcome: "ok",
      samples: [],
      totalMapped: 0,
      searched: {
        terms: [
          { term: "HPC Infrastructure Architect", mapped: 0, unmapped: 0 },
          { term: "AI Platform Engineer", mapped: 0, unmapped: 0 },
          { term: "AI Engineer", mapped: 0, unmapped: 0, unfinished: true },
        ],
        untried: 2,
        place: "Vienna, Austria",
      },
    });
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: true })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(
      await screen.findByText(
        'Searched in Vienna, Austria: "HPC Infrastructure Architect" (0 found), "AI Platform Engineer" (0 found), "AI Engineer" (not finished in time). 2 more term(s) not tried within the time limit.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no posting came back for the terms tried/),
    ).toBeInTheDocument();
  });

  it("keeps the plain empty message for an actor that reports no search list", async () => {
    testProviderInstance.mockResolvedValue({
      outcome: "ok",
      samples: [],
      totalMapped: 0,
    });
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: false })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(
      await screen.findByText("No items returned by the actor."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Searched in/)).toBeNull();
  });

  it("says nothing was searched when the profile has no terms", async () => {
    testProviderInstance.mockResolvedValue({
      outcome: "ok",
      samples: [],
      totalMapped: 0,
      searched: { terms: [], untried: 0, place: "Austria" },
    });
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: true })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(
      await screen.findByText(/has no search terms, so nothing was searched/),
    ).toBeInTheDocument();
    expect(screen.queryByText("No items returned by the actor.")).toBeNull();
    expect(screen.queryByText(/mapped successfully/)).toBeNull();
  });

  it("says the mapping read nothing when a term's rows were unreadable", async () => {
    testProviderInstance.mockResolvedValue({
      outcome: "ok",
      samples: [],
      totalMapped: 0,
      searched: {
        terms: [{ term: "AI Engineer", mapped: 0, unmapped: 4 }],
        untried: 1,
        place: "Austria",
      },
    });
    renderWithQueryClient(
      <ProviderInstanceCard
        instance={instance}
        template={template({ perTermRuns: true })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));

    expect(
      await screen.findByText(/"AI Engineer" \(0 found, 4 unreadable\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The actor returned items, but the mapping could read none of them.",
      ),
    ).toBeInTheDocument();
  });
});
