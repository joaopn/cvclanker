import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type {
  ProviderActorTemplateSummary,
  ProviderInstanceRow,
} from "@shared/types";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({}));
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
