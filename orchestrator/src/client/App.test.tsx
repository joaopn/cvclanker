import { TOP_BAR_STORAGE_VISIBLE_KEY } from "@client/hooks/useTopBarVisibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("@client/api", () => ({
  getActiveUserProfile: vi.fn().mockResolvedValue({ name: "Default" }),
}));

vi.mock("./components/chat/ChatPanel", () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));
vi.mock("./components/OnboardingGate", () => ({ OnboardingGate: () => null }));
vi.mock("./components/SchedulingPausedBanner", () => ({
  SchedulingPausedBanner: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("./pages/CoverLetterPage", () => ({ CoverLetterPage: () => null }));
vi.mock("./pages/CvPage", () => ({ CvPage: () => null }));
vi.mock("./pages/OnboardingPage", () => ({ OnboardingPage: () => null }));
vi.mock("./pages/OrchestratorPage", async () => {
  const { PageHeader } = await import("./components/layout");
  return {
    OrchestratorPage: () => <PageHeader title="Jobs" subtitle="Manage" />,
  };
});
vi.mock("./pages/ProfileEditorPage", () => ({ ProfileEditorPage: () => null }));
vi.mock("./pages/ProfilesPage", () => ({ ProfilesPage: () => null }));
vi.mock("./pages/SchedulePage", () => ({ SchedulePage: () => null }));
vi.mock("./pages/SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("./pages/SignInPage", () => ({ SignInPage: () => null }));
vi.mock("./pages/SourcesPage", () => ({ SourcesPage: () => null }));
vi.mock("./pages/StatsPage", () => ({ StatsPage: () => null }));
vi.mock("./pages/SwipePage", () => ({ SwipePage: () => null }));

const renderAt = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const chatButtons = () =>
  screen.queryAllByRole("button", { name: "Chat", hidden: true });

describe("App chat panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    ["shown", "true"],
    ["hidden", "false"],
  ])("renders one Chat button outside the page header with the top bar %s", (_label, visible) => {
    window.localStorage.setItem(TOP_BAR_STORAGE_VISIBLE_KEY, visible);
    renderAt("/jobs/ready");
    const header = screen.getByRole("banner");
    expect(chatButtons()).toHaveLength(1);
    expect(header).not.toContainElement(chatButtons()[0]);
  });

  it("mounts the chat panel beside the routed pages", () => {
    renderAt("/jobs/ready");
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
  });

  it.each([
    "/sign-in",
    "/onboarding",
  ])("leaves the chat panel and its button out on %s", (path) => {
    renderAt(path);
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
    expect(chatButtons()).toHaveLength(0);
  });
});
