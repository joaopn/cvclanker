import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

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
vi.mock("./pages/OrchestratorPage", () => ({ OrchestratorPage: () => null }));
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
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

describe("App chat panel", () => {
  it("mounts the chat panel beside the routed pages", () => {
    renderAt("/jobs/ready");
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
  });

  it.each([
    "/sign-in",
    "/onboarding",
  ])("leaves the chat panel out on %s", (path) => {
    renderAt(path);
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
  });
});
