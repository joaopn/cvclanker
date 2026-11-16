import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_VALIDATION_STATE } from "../content";
import type { LlmStepModel, OnboardingFormData } from "../types";
import { LlmConnectionStep } from "./LlmConnectionStep";

const codexPanelMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("@client/components/CodexAuthPanel", () => ({
  CodexAuthPanel: () => {
    useEffect(() => {
      codexPanelMounts.count += 1;
    }, []);
    return <div>Codex sign-in panel</div>;
  },
}));

function makeModel(overrides: Partial<LlmStepModel> = {}): LlmStepModel {
  return {
    addProvider: "openai",
    addableProviders: ["openai", "gemini", "ollama", "claude_code", "codex"],
    addMakesAppProvider: true,
    addDisabledReason: null,
    canTest: true,
    testDisabledReason: null,
    claudeCodeTokenHint: null,
    codexSignedIn: false,
    configuredProviders: [],
    isTesting: false,
    isValidating: false,
    testResult: null,
    validation: EMPTY_VALIDATION_STATE,
    onSelectProvider: vi.fn(),
    onTest: vi.fn(() => Promise.resolve()),
    onAdd: vi.fn(() => Promise.resolve()),
    onRemove: vi.fn(() => Promise.resolve()),
    onCodexStatusChange: vi.fn(),
    ...overrides,
  };
}

const Harness: React.FC<{ model: LlmStepModel; isBusy?: boolean }> = ({
  model,
  isBusy = false,
}) => {
  const { control } = useForm<OnboardingFormData>({
    defaultValues: {
      llmProvider: "",
      llmBaseUrl: "",
      llmApiKey: "",
      claudeCodeOauthToken: "",
      personalBrief: "",
      searchTerms: [],
      searchTermDraft: "",
      basicAuthUser: "",
      basicAuthPassword: "",
      candidateName: "",
    },
  });
  return <LlmConnectionStep {...model} control={control} isBusy={isBusy} />;
};

describe("LlmConnectionStep", () => {
  it("shows the two boxes, with an empty state before anything is added", () => {
    render(<Harness model={makeModel()} />);

    expect(
      screen.getByRole("heading", { name: "Add provider" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Configured providers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No provider yet — add one above."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Other providers/i)).not.toBeInTheDocument();
  });

  it("runs Test and Add from their buttons", () => {
    const model = makeModel();
    render(<Harness model={model} />);

    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(model.onTest).toHaveBeenCalledTimes(1);
    expect(model.onAdd).toHaveBeenCalledTimes(1);
  });

  it("disables Test and Add as the model says, and says why Add is disabled", () => {
    render(
      <Harness
        model={makeModel({
          canTest: false,
          addDisabledReason: "Paste the OpenAI API key to add it.",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(
      screen.getByText("Paste the OpenAI API key to add it."),
    ).toBeInTheDocument();
  });

  // The step sits inside the wizard's <form>. jsdom has no default action for
  // key events, so a host form's onSubmit never fires here and asserting it
  // was not called proves nothing; fireEvent returns false exactly when the
  // event was cancelled, which is what stops the implicit submit.
  it.each([
    ["openai", "llmApiKey"],
    ["ollama", "llmBaseUrl"],
    ["claude_code", "claudeCodeOauthToken"],
  ] as const)("cancels Enter in the %s %s field and runs Test instead", (provider, name) => {
    const model = makeModel({ addProvider: provider });
    const { container } = render(<Harness model={model} />);
    const input = container.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    );
    if (!input) throw new Error(`no ${name} input`);

    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(model.onTest).toHaveBeenCalledTimes(1);
    expect(model.onAdd).not.toHaveBeenCalled();
  });

  it("cancels Enter without testing when Test is unavailable", () => {
    const model = makeModel({ canTest: false });
    const { container } = render(<Harness model={model} />);
    const input = container.querySelector<HTMLInputElement>(
      'input[name="llmApiKey"]',
    );
    if (!input) throw new Error("no key input");

    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(model.onTest).not.toHaveBeenCalled();
  });

  it("shows the Codex sign-in panel, and no key field, for Codex", () => {
    const { container } = render(
      <Harness model={makeModel({ addProvider: "codex" })} />,
    );

    expect(screen.getByText("Codex sign-in panel")).toBeInTheDocument();
    expect(container.querySelector("input[name]")).toBeNull();
    expect(
      screen.queryByText("No API key is required for this provider."),
    ).not.toBeInTheDocument();
  });

  it("lists configured providers, tags the app's one with its check, and removes by provider", () => {
    const model = makeModel({
      configuredProviders: [
        {
          provider: "openai",
          usedByApp: true,
          details: ["API key sk-o********"],
        },
        { provider: "codex", usedByApp: false, details: ["Signed in"] },
      ],
      validation: {
        valid: false,
        message: "Invalid API key",
        checked: true,
        hydrated: true,
      },
    });
    render(<Harness model={model} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("OpenAI");
    expect(rows[0]).toHaveTextContent("Used by the app");
    expect(rows[0]).toHaveTextContent("API key sk-o********");
    expect(rows[0]).toHaveTextContent("Invalid API key");
    expect(rows[1]).toHaveTextContent("Codex");
    expect(rows[1]).not.toHaveTextContent("Used by the app");
    expect(rows[1]).not.toHaveTextContent("Invalid API key");

    fireEvent.click(screen.getByRole("button", { name: "Remove Codex" }));
    expect(model.onRemove).toHaveBeenCalledWith("codex");
  });

  it("says why Test is off when no typed key would explain it", () => {
    render(
      <Harness
        model={makeModel({
          addProvider: "ollama",
          canTest: false,
          testDisabledReason: "Test is unavailable for Ollama.",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(
      screen.getByText("Test is unavailable for Ollama."),
    ).toBeInTheDocument();
  });

  it("remounts the Codex panel when the sign-in changes elsewhere, so it refreshes its own status", () => {
    codexPanelMounts.count = 0;
    const model = makeModel({ addProvider: "codex", codexSignedIn: true });
    const { rerender } = render(<Harness model={model} />);
    expect(codexPanelMounts.count).toBe(1);

    rerender(<Harness model={{ ...model, codexSignedIn: false }} />);

    expect(codexPanelMounts.count).toBe(2);
  });

  it("names the tested provider in the test result", () => {
    render(
      <Harness
        model={makeModel({
          testResult: { provider: "gemini", valid: true, message: null },
        })}
      />,
    );

    expect(screen.getByText("Gemini: connection works.")).toBeInTheDocument();
  });

  it("says so once every provider is added", () => {
    render(
      <Harness
        model={makeModel({ addProvider: null, addableProviders: [] })}
      />,
    );

    expect(
      screen.getByText("Every provider has been added."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add" }),
    ).not.toBeInTheDocument();
  });
});
