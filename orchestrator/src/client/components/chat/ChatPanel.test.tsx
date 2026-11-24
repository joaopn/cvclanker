import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { createAppSettings } from "@shared/testing/factories";
import type { ChatMessage, ChatStreamEvent, ChatThread } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatButton } from "./ChatButton";
import { ChatProvider } from "./ChatContext";
import { ChatPanel } from "./ChatPanel";

vi.mock("@client/api", async (importOriginal) => ({
  ApiClientError: (await importOriginal<typeof import("@client/api")>())
    .ApiClientError,
  listChatThreads: vi.fn(),
  createChatThread: vi.fn(),
  getChatMessages: vi.fn(),
  cancelChatTurn: vi.fn(),
  streamChatMessage: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Radix menus cannot open in jsdom; this shim honours the controlled `open`
// prop, so the saved chats exist only while the menu is open.
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
    onSelect?: () => void;
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
    DropdownMenuItem: ({ children, onSelect }: ShellProps) => {
      const menu = react.useContext(MenuContext);
      return (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onSelect?.();
            menu.setOpen(false);
          }}
        >
          {children}
        </button>
      );
    },
    DropdownMenuSeparator: () => <hr />,
  };
});

const thread = (overrides: Partial<ChatThread>): ChatThread => ({
  id: "thread-1",
  title: "A chat",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: "message-1",
  threadId: "thread-1",
  role: "assistant",
  content: "",
  status: "complete",
  createdAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

function renderChat() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/jobs/ready"]}>
        <ChatProvider>
          <ChatButton />
          <ChatPanel />
        </ChatProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const panel = () => screen.queryByRole("complementary", { name: "Chat" });

// Starts a turn and hands back the stream's event callback; the stream stays
// open until `finish` is called.
async function startTurn(question: string) {
  let emit: ((event: ChatStreamEvent) => void) | undefined;
  let finish: () => void = () => {};
  vi.mocked(api.streamChatMessage).mockImplementation(
    (_threadId, _content, onEvent) => {
      emit = onEvent;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  fireEvent.change(screen.getByPlaceholderText("Ask about your jobs..."), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(emit).toBeDefined());
  return {
    emit: (event: ChatStreamEvent) =>
      act(() => {
        emit?.(event);
      }),
    finish: async () => {
      await act(async () => {
        finish();
      });
    },
  };
}

describe("chat button and panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(api.listChatThreads).mockReset().mockResolvedValue({
      threads: [],
    });
    vi.mocked(api.createChatThread)
      .mockReset()
      .mockResolvedValue({
        thread: thread({ id: "new-thread", title: null }),
      });
    vi.mocked(api.getChatMessages).mockReset().mockResolvedValue({
      messages: [],
    });
    vi.mocked(api.cancelChatTurn).mockReset().mockResolvedValue({
      cancelled: true,
    });
    vi.mocked(api.streamChatMessage).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.getSettings)
      .mockReset()
      .mockResolvedValue(createAppSettings());
    vi.mocked(api.updateSettings)
      .mockReset()
      .mockResolvedValue(createAppSettings());
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--chat-panel-width");
  });

  it("toggles the panel from the button and closes it from the panel", () => {
    renderChat();
    expect(panel()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(panel()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(panel()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(panel()).not.toBeInTheDocument();
  });

  it("lists saved chats newest first when the chevron opens and loads the picked one", async () => {
    vi.mocked(api.listChatThreads).mockResolvedValue({
      threads: [
        thread({
          id: "older",
          title: "Older question",
          updatedAt: "2026-11-01T10:00:00.000Z",
        }),
        thread({
          id: "newer",
          title: "Newer question",
          updatedAt: "2026-11-20T10:00:00.000Z",
        }),
      ],
    });
    vi.mocked(api.getChatMessages).mockResolvedValue({
      messages: [
        message({
          id: "q",
          threadId: "newer",
          role: "user",
          content: "Newer question",
        }),
        message({
          id: "a",
          threadId: "newer",
          content: "Three jobs match.",
        }),
      ],
    });
    renderChat();
    expect(api.listChatThreads).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Saved chats" }));
    await waitFor(() =>
      expect(screen.getAllByRole("menuitem")).toHaveLength(3),
    );
    const labels = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(labels[0]).toContain("New chat");
    expect(labels[1]).toContain("Newer question");
    expect(labels[2]).toContain("Older question");

    fireEvent.click(screen.getAllByRole("menuitem")[1]);
    expect(panel()).toBeInTheDocument();
    expect(await screen.findByText("Three jobs match.")).toBeInTheDocument();
    expect(api.getChatMessages).toHaveBeenCalledWith("newer");
  });

  it("shows a status line per tool event and replaces the live lines with the answer", async () => {
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const turn = await startTurn("Which jobs are at Acme?");
    expect(api.streamChatMessage).toHaveBeenCalledWith(
      "new-thread",
      "Which jobs are at Acme?",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    turn.emit({
      type: "tool",
      name: "search_jobs",
      arguments: { query: "Acme" },
      write: false,
      ok: true,
    });
    expect(screen.getByText("Searching jobs: Acme…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();

    turn.emit({
      type: "tool",
      name: "mark_applied",
      arguments: { id: "job-1" },
      write: true,
      ok: true,
      job: { title: "Data Engineer", employer: "Acme" },
    });
    expect(
      screen.getByText("Marking applied: Data Engineer @ Acme"),
    ).toBeInTheDocument();

    turn.emit({
      type: "tool",
      name: "get_job",
      arguments: { id: "gone" },
      write: false,
      ok: false,
      job: null,
    });
    expect(screen.getByText("Reading a job… (failed)")).toBeInTheDocument();

    turn.emit({
      type: "completed",
      message: message({
        id: "answer",
        threadId: "new-thread",
        content: "There are **two** jobs at Acme.",
      }),
    });
    expect(screen.queryByText("Searching jobs: Acme…")).not.toBeInTheDocument();
    expect(screen.getByText("two").tagName).toBe("STRONG");
    await turn.finish();
  });

  it("refreshes jobs after a successful write tool and not after a read", async () => {
    const client = renderChat();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const jobsChanged = vi.fn();
    window.addEventListener("cvclanker:jobs-changed", jobsChanged);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Chat" }));
      const turn = await startTurn("Mark the Acme job applied");
      const jobsInvalidations = () =>
        invalidate.mock.calls.filter(
          ([filters]) =>
            JSON.stringify(filters?.queryKey) === JSON.stringify(["jobs"]),
        ).length;

      turn.emit({
        type: "tool",
        name: "get_job",
        arguments: { id: "job-1" },
        write: false,
        ok: true,
      });
      expect(jobsInvalidations()).toBe(0);
      expect(jobsChanged).not.toHaveBeenCalled();

      turn.emit({
        type: "tool",
        name: "mark_applied",
        arguments: { id: "job-1" },
        write: true,
        ok: true,
      });
      expect(jobsInvalidations()).toBe(1);
      expect(jobsChanged).toHaveBeenCalledTimes(1);
      await turn.finish();
    } finally {
      window.removeEventListener("cvclanker:jobs-changed", jobsChanged);
    }
  });

  it("shows the saved Can change jobs setting, saves a change and locks while answering", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(
      createAppSettings({
        chatCanChangeJobs: { value: true, default: false, override: true },
      }),
    );
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const toggle = screen.getByRole("switch", { name: "Can change jobs" });
    await waitFor(() => expect(toggle).toBeChecked());
    await waitFor(() => expect(toggle).toBeEnabled());

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        chatCanChangeJobs: false,
      }),
    );
    await waitFor(() => expect(toggle).toBeEnabled());

    const turn = await startTurn("How many jobs have I applied to?");
    expect(toggle).toBeDisabled();
    await turn.finish();
  });

  it("falls back to a new chat when the remembered chat is not found", async () => {
    window.localStorage.setItem("cvclanker:chat:open", "true");
    window.localStorage.setItem("cvclanker:chat:threadId", "stale");
    vi.mocked(api.getChatMessages).mockRejectedValue(
      new api.ApiClientError("Chat not found", {
        status: 404,
        code: "NOT_FOUND",
      }),
    );
    renderChat();
    await waitFor(() =>
      expect(api.getChatMessages).toHaveBeenCalledWith("stale"),
    );
    expect(
      await screen.findByText(/Ask about your jobs: which Ready jobs/),
    ).toBeInTheDocument();

    const turn = await startTurn("Hi");
    expect(api.createChatThread).toHaveBeenCalledTimes(1);
    expect(api.streamChatMessage).toHaveBeenCalledWith(
      "new-thread",
      "Hi",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(toast.error).not.toHaveBeenCalled();
    await turn.finish();
  });

  it("shows Stop only on the chat that is answering", async () => {
    vi.mocked(api.listChatThreads).mockResolvedValue({
      threads: [thread({ id: "other", title: "Other chat" })],
    });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const turn = await startTurn("Which jobs are at Acme?");
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Saved chats" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Other chat/ }),
    );
    await waitFor(() =>
      expect(api.getChatMessages).toHaveBeenCalledWith("other"),
    );

    expect(
      screen.queryByRole("button", { name: "Stop generating" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ask about your jobs..."), {
      target: { value: "Another question" },
    });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await turn.finish();
  });

  it("drops the loading state when New chat is picked during a load", async () => {
    vi.mocked(api.listChatThreads).mockResolvedValue({
      threads: [thread({ id: "slow", title: "Slow chat" })],
    });
    vi.mocked(api.getChatMessages).mockReturnValue(new Promise(() => {}));
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Saved chats" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Slow chat/ }));
    expect(await screen.findByText("Loading chat…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Saved chats" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /New chat/ }));

    expect(
      await screen.findByText(/Ask about your jobs: which Ready jobs/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading chat…")).not.toBeInTheDocument();
  });

  it("keeps a key pressed in the panel away from window shortcuts", () => {
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const onKeyDown = vi.fn();
    window.addEventListener("keydown", onKeyDown);
    try {
      fireEvent.keyDown(screen.getByRole("button", { name: "Close chat" }), {
        key: "j",
      });
      expect(onKeyDown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onKeyDown);
    }
  });
});
