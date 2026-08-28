import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { OrchestratorHeader } from "./OrchestratorHeader";

// PageHeader's nav drawer fetches the active user-profile name.
vi.mock("@client/api", () => ({
  getActiveUserProfile: vi.fn().mockResolvedValue({ name: "Default" }),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const renderHeader = (
  overrides: Partial<React.ComponentProps<typeof OrchestratorHeader>> = {},
) => {
  const props: React.ComponentProps<typeof OrchestratorHeader> = {
    navOpen: false,
    onNavOpenChange: vi.fn(),
    isPipelineRunning: false,
    isCancelling: false,
    pipelineSources: ["linkedin"],
    runControl: <button type="button">Run pipeline</button>,
    onOpenBatchUrlImport: vi.fn(),
    onOpenLlmQueue: vi.fn(),
    llmActiveCount: 0,
    onCancelPipeline: vi.fn(),
    canUndo: false,
    undoLabel: null,
    onUndo: vi.fn(),
    ...overrides,
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    props,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OrchestratorHeader {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
};

describe("OrchestratorHeader", () => {
  it("renders the supplied run control in the navbar", () => {
    renderHeader();
    expect(screen.getByRole("button", { name: /run pipeline/i })).toBeTruthy();
  });

  it("does not render manual import button", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: /manual import/i }),
    ).not.toBeInTheDocument();
  });

  it("renders cancel button while running and triggers cancel", () => {
    const { props } = renderHeader({ isPipelineRunning: true });
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    expect(props.onCancelPipeline).toHaveBeenCalled();
  });
});
