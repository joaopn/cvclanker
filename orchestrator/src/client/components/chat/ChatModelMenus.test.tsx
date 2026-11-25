import * as api from "@client/api";
import { createAppSettings } from "@shared/testing/factories";
import type { ChatModelsResponse } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatModelMenus } from "./ChatModelMenus";

vi.mock("@client/api", () => ({
  getChatModels: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Radix menus cannot open in jsdom; this shim opens a menu or a submenu on a
// click of its trigger and checks the radio item matching its group's value.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const react = await import("react");
  type OpenState = { open: boolean; setOpen: (open: boolean) => void };
  const MenuContext = react.createContext<OpenState>({
    open: false,
    setOpen: () => {},
  });
  const SubContext = react.createContext<OpenState>({
    open: false,
    setOpen: () => {},
  });
  const RadioContext = react.createContext<string | undefined>(undefined);
  type ShellProps = {
    children?: React.ReactNode;
    value?: string;
    onSelect?: () => void;
    onOpenChange?: (open: boolean) => void;
  };
  const Open = ({
    context,
    children,
    onOpenChange,
  }: {
    context: React.Context<OpenState>;
    children?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    const [open, setOpenState] = react.useState(false);
    const setOpen = (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    };
    return (
      <context.Provider value={{ open, setOpen }}>{children}</context.Provider>
    );
  };
  return {
    DropdownMenu: ({ children, onOpenChange }: ShellProps) => (
      <Open context={MenuContext} onOpenChange={onOpenChange}>
        {children}
      </Open>
    ),
    DropdownMenuTrigger: ({ children }: ShellProps) => {
      const menu = react.useContext(MenuContext);
      return react.cloneElement(
        children as React.ReactElement<{ onClick?: () => void }>,
        { onClick: () => menu.setOpen(!menu.open) },
      );
    },
    DropdownMenuContent: ({ children }: ShellProps) =>
      react.useContext(MenuContext).open ? (
        <div role="menu">{children}</div>
      ) : null,
    DropdownMenuSub: ({ children }: ShellProps) => (
      <Open context={SubContext}>{children}</Open>
    ),
    DropdownMenuSubTrigger: ({ children }: ShellProps) => {
      const sub = react.useContext(SubContext);
      return (
        <button
          type="button"
          role="menuitem"
          onClick={() => sub.setOpen(!sub.open)}
        >
          {children}
        </button>
      );
    },
    DropdownMenuSubContent: ({ children }: ShellProps) =>
      react.useContext(SubContext).open ? (
        <div role="menu">{children}</div>
      ) : null,
    DropdownMenuRadioGroup: ({ children, value }: ShellProps) => (
      <RadioContext.Provider value={value}>{children}</RadioContext.Provider>
    ),
    DropdownMenuRadioItem: ({ children, value, onSelect }: ShellProps) => {
      const menu = react.useContext(MenuContext);
      const checked = react.useContext(RadioContext) === value;
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={checked ? "true" : "false"}
          onClick={() => {
            onSelect?.();
            menu.setOpen(false);
          }}
        >
          {children}
        </button>
      );
    },
  };
});

const models = (
  current: Partial<ChatModelsResponse["current"]> = {},
): ChatModelsResponse => ({
  providers: [
    {
      provider: "claude_code",
      models: [
        { model: "", tasks: ["default", "scoring"] },
        { model: "claude-sample-large", tasks: ["tailoring"] },
      ],
    },
    {
      provider: "openrouter",
      models: [{ model: "vendor/sample-small", tasks: ["prefilter"] }],
    },
  ],
  current: {
    provider: "claude_code",
    model: "claude-sample-large",
    effort: null,
    ...current,
  },
  supportsEffort: ["claude_code"],
});

function renderMenus(disabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ChatModelMenus disabled={disabled} />
    </QueryClientProvider>,
  );
}

const modelTrigger = () => screen.getByRole("button", { name: "Chat model" });
const effortTrigger = () =>
  screen.queryByRole("button", { name: "Chat effort" });

async function openProvider(label: string) {
  await waitFor(() => expect(modelTrigger()).toBeEnabled());
  fireEvent.click(modelTrigger());
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

const option = (text: string) => {
  const item = screen.getByText(text).closest('[role="menuitemradio"]');
  if (!(item instanceof HTMLElement)) throw new Error(`no option ${text}`);
  return item;
};

describe("ChatModelMenus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getChatModels).mockResolvedValue(models());
    vi.mocked(api.getSettings).mockResolvedValue(createAppSettings());
    vi.mocked(api.updateSettings).mockResolvedValue(createAppSettings());
  });

  it("shows the current provider and model on the trigger", async () => {
    renderMenus();
    await waitFor(() =>
      expect(modelTrigger()).toHaveTextContent(
        "Claude Code · claude-sample-large",
      ),
    );
  });

  it("lists each provider and, under it, its models with their tasks", async () => {
    renderMenus();
    await openProvider("Claude Code");
    expect(
      screen.getByRole("menuitem", { name: "OpenRouter" }),
    ).toBeInTheDocument();
    expect(option("CLI default")).toHaveTextContent("Default, Scoring");
    expect(option("CLI default")).toHaveAttribute("aria-checked", "false");
    expect(option("claude-sample-large")).toHaveTextContent("Tailoring");
    expect(option("claude-sample-large")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByText("vendor/sample-small")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "OpenRouter" }));
    expect(option("vendor/sample-small")).toHaveTextContent("Pre-filter");
  });

  it("saves the picked provider and model and refreshes the choice", async () => {
    renderMenus();
    await openProvider("OpenRouter");
    await waitFor(() => expect(api.getChatModels).toHaveBeenCalledTimes(2));
    fireEvent.click(option("vendor/sample-small"));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        chatProvider: "openrouter",
        chatModel: "vendor/sample-small",
      }),
    );
    await waitFor(() => expect(api.getChatModels).toHaveBeenCalledTimes(3));
  });

  it("refetches the models when the model menu opens", async () => {
    renderMenus();
    await waitFor(() => expect(modelTrigger()).toBeEnabled());
    expect(api.getChatModels).toHaveBeenCalledTimes(1);
    fireEvent.click(modelTrigger());
    await waitFor(() => expect(api.getChatModels).toHaveBeenCalledTimes(2));
  });

  it("saves the provider with a null model for the CLI default model", async () => {
    renderMenus();
    await openProvider("Claude Code");
    fireEvent.click(option("CLI default"));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        chatProvider: "claude_code",
        chatModel: null,
      }),
    );
  });

  it("shows the effort menu only for a provider that takes an effort", async () => {
    vi.mocked(api.getChatModels).mockResolvedValue(
      models({ provider: "openrouter", model: "vendor/sample-small" }),
    );
    renderMenus();
    await waitFor(() =>
      expect(modelTrigger()).toHaveTextContent(
        "OpenRouter · vendor/sample-small",
      ),
    );
    expect(effortTrigger()).not.toBeInTheDocument();
  });

  it("shows the effort menu for Claude Code", async () => {
    vi.mocked(api.getChatModels).mockResolvedValue(models({ effort: "high" }));
    renderMenus();
    await waitFor(() =>
      expect(effortTrigger()).toHaveTextContent("Effort: high"),
    );
  });

  it("saves the picked effort", async () => {
    renderMenus();
    await waitFor(() => expect(effortTrigger()).toBeEnabled());
    fireEvent.click(effortTrigger() as HTMLElement);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "xhigh" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ chatEffort: "xhigh" }),
    );
  });

  it("saves a null effort for Default", async () => {
    vi.mocked(api.getChatModels).mockResolvedValue(models({ effort: "low" }));
    renderMenus();
    await waitFor(() =>
      expect(effortTrigger()).toHaveTextContent("Effort: low"),
    );
    fireEvent.click(effortTrigger() as HTMLElement);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ chatEffort: null }),
    );
  });

  it("disables both menus while disabled", async () => {
    renderMenus(true);
    await waitFor(() =>
      expect(modelTrigger()).toHaveTextContent("claude-sample-large"),
    );
    expect(modelTrigger()).toBeDisabled();
    expect(effortTrigger()).toBeDisabled();
  });
});
