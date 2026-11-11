import { TOP_BAR_STORAGE_VISIBLE_KEY } from "@client/hooks/useTopBarVisibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageHeader } from "./layout";

// The nav drawer fetches the active user-profile name.
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
}));

const renderHeader = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PageHeader
          title="Jobs"
          subtitle="Manage"
          actions={<button type="button">Run pipeline</button>}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const hideButton = () =>
  screen.getByRole("button", { name: "Hide top bar", hidden: true });
const runButton = () =>
  screen.getByRole("button", { name: "Run pipeline", hidden: true });
const showHandle = () => screen.queryByRole("button", { name: "Show top bar" });

const TOGGLE_KEY = { key: "H", shiftKey: true };

describe("PageHeader top bar visibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the bar by default with no show handle", () => {
    renderHeader();
    expect(hideButton()).toBeVisible();
    expect(runButton()).toBeVisible();
    expect(showHandle()).not.toBeInTheDocument();
  });

  it("hides the bar without unmounting its actions and remembers it", () => {
    renderHeader();
    fireEvent.click(hideButton());

    expect(runButton()).toBeInTheDocument();
    expect(runButton()).not.toBeVisible();
    expect(showHandle()).toBeVisible();
    expect(window.localStorage.getItem(TOP_BAR_STORAGE_VISIBLE_KEY)).toBe(
      "false",
    );
  });

  it("brings the bar back from the show handle", () => {
    renderHeader();
    fireEvent.click(hideButton());
    const handle = showHandle();
    if (!handle) throw new Error("show handle missing");
    fireEvent.click(handle);

    expect(runButton()).toBeVisible();
    expect(showHandle()).not.toBeInTheDocument();
    expect(window.localStorage.getItem(TOP_BAR_STORAGE_VISIBLE_KEY)).toBe(
      "true",
    );
  });

  it("starts hidden when this browser last hid it", () => {
    window.localStorage.setItem(TOP_BAR_STORAGE_VISIBLE_KEY, "false");
    renderHeader();

    expect(runButton()).not.toBeVisible();
    expect(showHandle()).toBeVisible();
  });

  it("toggles on the shortcut", () => {
    renderHeader();
    const defaultAllowed = fireEvent.keyDown(window, TOGGLE_KEY);
    expect(defaultAllowed).toBe(false);
    expect(runButton()).not.toBeVisible();

    fireEvent.keyDown(window, TOGGLE_KEY);
    expect(runButton()).toBeVisible();
  });

  it("hands focus between the hide button and the show handle", () => {
    renderHeader();
    hideButton().focus();
    fireEvent.click(hideButton());
    const handle = showHandle();
    expect(handle).not.toBeNull();
    expect(document.activeElement).toBe(handle);

    handle?.focus();
    if (handle) fireEvent.click(handle);
    expect(document.activeElement).toBe(hideButton());
  });

  it("moves focus to the handle when the shortcut hides the bar around it", () => {
    renderHeader();
    runButton().focus();
    fireEvent.keyDown(runButton(), TOGGLE_KEY);
    expect(document.activeElement).toBe(showHandle());
  });

  it("leaves focus alone when the shortcut is pressed outside the bar", () => {
    renderHeader();
    fireEvent.keyDown(window, TOGGLE_KEY);
    expect(showHandle()).toBeVisible();
    expect(document.activeElement).toBe(document.body);
  });

  it("ignores a held-down shortcut after the first press", () => {
    renderHeader();
    fireEvent.keyDown(window, TOGGLE_KEY);
    const repeatDefaultAllowed = fireEvent.keyDown(window, {
      ...TOGGLE_KEY,
      repeat: true,
    });
    expect(repeatDefaultAllowed).toBe(false);
    expect(runButton()).not.toBeVisible();
  });

  it.each([
    ["an open menu", { role: "menu" }],
    ["a listbox", { role: "listbox" }],
    ["a closed combobox", { role: "combobox", "aria-expanded": "false" }],
    ["a dialog", { role: "dialog" }],
    ["an alert dialog", { role: "alertdialog" }],
    ["popup content", { "data-radix-popper-content-wrapper": "" }],
  ])("ignores the shortcut inside %s", (_label, attributes) => {
    renderHeader();
    const popup = document.createElement("div");
    for (const [name, value] of Object.entries(attributes)) {
      popup.setAttribute(name, value);
    }
    const item = document.createElement("button");
    popup.appendChild(item);
    document.body.appendChild(popup);
    try {
      fireEvent.keyDown(item, TOGGLE_KEY);
      expect(runButton()).toBeVisible();
    } finally {
      popup.remove();
    }
  });

  it("still works when this browser blocks storage", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    renderHeader();
    expect(runButton()).toBeVisible();

    fireEvent.click(hideButton());
    expect(runButton()).not.toBeVisible();
    expect(getItem).toHaveBeenCalled();
    expect(setItem).toHaveBeenCalled();
  });

  it("ignores the shortcut typed into a text field", () => {
    renderHeader();
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, TOGGLE_KEY);
      expect(runButton()).toBeVisible();
    } finally {
      input.remove();
    }
  });
});
