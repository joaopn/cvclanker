import * as api from "@client/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCredentialsSection } from "./ProviderCredentialsSection";

vi.mock("@client/api", () => ({
  getLlmProviderCredentials: vi.fn(),
  saveLlmProviderCredential: vi.fn(),
  deleteLlmProviderCredential: vi.fn(),
}));
vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function renderSection(configuredProvider = "claude_code") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderCredentialsSection
        layoutMode="panel"
        configuredProvider={configuredProvider}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getLlmProviderCredentials).mockResolvedValue([]);
  vi.mocked(api.saveLlmProviderCredential).mockResolvedValue([]);
  vi.mocked(api.deleteLlmProviderCredential).mockResolvedValue([]);
});

describe("ProviderCredentialsSection", () => {
  it("offers no key field for the providers that carry their own login", async () => {
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    });
    // claude_code and codex authenticate through their own flows; a key box
    // would claim one is needed.
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("shows a hint for a saved key and never the key itself", async () => {
    vi.mocked(api.getLlmProviderCredentials).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "AIza", baseUrl: null },
    ]);
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("AIza********")).toBeInTheDocument();
    });
    const keyInput = screen.getByLabelText<HTMLInputElement>("API key", {
      selector: "#credential-key-gemini",
    });
    expect(keyInput.value).toBe("");
    expect(keyInput.type).toBe("password");
  });

  it("omits an untouched key rather than sending a blank one", async () => {
    vi.mocked(api.getLlmProviderCredentials).mockResolvedValue([
      { provider: "openai_compatible", apiKeyHint: "sk-x", baseUrl: null },
    ]);
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("OpenAI-compatible")).toBeInTheDocument();
    });

    const baseUrlInput = screen.getByLabelText("Base URL", {
      selector: "#credential-url-openai_compatible",
    });
    fireEvent.change(baseUrlInput, {
      target: { value: "https://proxy.example.test" },
    });

    // Scoped to this provider's own row — every row has a Save button, and
    // picking one by position breaks the moment the provider list changes.
    const row = baseUrlInput.closest("div.rounded-lg");
    if (!row) throw new Error("provider row not found");
    fireEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(api.saveLlmProviderCredential).toHaveBeenCalledTimes(1);
    });
    const [provider, input] = vi.mocked(api.saveLlmProviderCredential).mock
      .calls[0];
    expect(provider).toBe("openai_compatible");
    // No apiKey key at all: saving a base URL must not clear a stored key that
    // the form deliberately never displayed.
    expect("apiKey" in input).toBe(false);
    expect(input.baseUrl).toBe("https://proxy.example.test");
  });
});
