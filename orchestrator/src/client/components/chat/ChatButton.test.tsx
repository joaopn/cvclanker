import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { createAppSettings } from "@shared/testing/factories";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatButton } from "./ChatButton";
import { ChatProvider, useChat } from "./ChatContext";

vi.mock("@client/api", () => ({
  listChatThreads: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Radix menus cannot open in jsdom; this shim honours the controlled `open`
// prop and, like Radix, keeps the menu open when an item's onSelect calls
// preventDefault.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const react = await import("react");
  const MenuContext = react.createContext({
    open: false,
    setOpen: (_open: boolean) => {},
  });
  type ShellProps = {
    children?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    onSelect?: (event: { preventDefault: () => void }) => void;
    disabled?: boolean;
    role?: string;
    "aria-checked"?: boolean;
  };
  return {
    DropdownMenu: ({ children, open, onOpenChange }: ShellProps) => (
      <MenuContext.Provider
        value={{
          open: open === true,
          setOpen: (next: boolean) => onOpenChange?.(next),
        }}
      >
        {children}
      </MenuContext.Provider>
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
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
      ...itemProps
    }: ShellProps) => {
      const menu = react.useContext(MenuContext);
      return (
        <div
          role="menuitem"
          {...itemProps}
          tabIndex={-1}
          aria-disabled={disabled}
          onClick={() => {
            if (disabled) return;
            let prevented = false;
            onSelect?.({
              preventDefault: () => {
                prevented = true;
              },
            });
            if (!prevented) menu.setOpen(false);
          }}
          onKeyDown={() => {}}
        >
          {children}
        </div>
      );
    },
    DropdownMenuSeparator: () => <hr />,
  };
});

const AnsweringToggle: React.FC = () => {
  const { setAnswering } = useChat();
  return (
    <button type="button" onClick={() => setAnswering(true)}>
      Start answering
    </button>
  );
};

function renderButton() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/jobs/ready"]}>
        <ChatProvider>
          <ChatButton />
          <AnsweringToggle />
        </ChatProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Saved chats" }));
  return screen.getByRole("menu");
};

const modeItem = () =>
  screen.getByRole("menuitemcheckbox", { name: "Can change jobs" });

const waitForUnlocked = () =>
  waitFor(() =>
    expect(modeItem()).not.toHaveAttribute("aria-disabled", "true"),
  );

describe("chat button menu", () => {
  beforeEach(() => {
    vi.mocked(api.listChatThreads).mockReset().mockResolvedValue({
      threads: [],
    });
    vi.mocked(api.getSettings)
      .mockReset()
      .mockResolvedValue(createAppSettings());
    vi.mocked(api.updateSettings)
      .mockReset()
      .mockResolvedValue(createAppSettings());
  });

  it("puts the Can change jobs switch first, above New chat", () => {
    renderButton();
    const menu = openMenu();
    expect(menu.firstElementChild).toBe(modeItem());
    expect(within(menu).getAllByRole("menuitem")[0]).toHaveTextContent(
      "New chat",
    );
  });

  it("saves the flipped setting and keeps the menu open", async () => {
    renderButton();
    openMenu();
    await waitForUnlocked();
    expect(modeItem()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(modeItem());
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        chatCanChangeJobs: true,
      }),
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("shows the saved setting when it is on and saves turning it off", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      createAppSettings({
        chatCanChangeJobs: { value: true, default: false, override: true },
      }),
    );
    renderButton();
    openMenu();
    await waitForUnlocked();
    expect(modeItem()).toHaveAttribute("aria-checked", "true");

    fireEvent.click(modeItem());
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        chatCanChangeJobs: false,
      }),
    );
  });

  it("locks the switch while an answer runs", async () => {
    renderButton();
    openMenu();
    await waitForUnlocked();

    fireEvent.click(screen.getByRole("button", { name: "Start answering" }));
    expect(modeItem()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(modeItem());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("reports a failed save even after the button unmounts", async () => {
    vi.mocked(api.updateSettings).mockRejectedValue(new Error("Disk full"));
    const { unmount } = renderButton();
    openMenu();
    await waitForUnlocked();

    fireEvent.click(modeItem());
    unmount();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Disk full"));
  });
});
