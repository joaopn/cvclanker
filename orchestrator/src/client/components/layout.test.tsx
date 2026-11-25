import { TOP_BAR_STORAGE_VISIBLE_KEY } from "@client/hooks/useTopBarVisibility";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { createPortal } from "react-dom";
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

const renderHeader = (
  actions: React.ReactNode = <button type="button">Run pipeline</button>,
  options?: { container: HTMLElement },
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PageHeader title="Header title" subtitle="Manage" actions={actions} />
      </MemoryRouter>
    </QueryClientProvider>,
    options,
  );
};

// The bar is the header's first child; clicking it directly hits empty space.
const bar = () => {
  const row = screen.getByRole("banner", { hidden: true }).firstElementChild;
  if (!row) throw new Error("bar row missing");
  return row;
};
const navButton = () =>
  screen.getByRole("button", { name: "Open navigation menu", hidden: true });
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
    expect(runButton()).toBeVisible();
    expect(showHandle()).not.toBeInTheDocument();
  });

  it("hides the bar without unmounting its actions and remembers it", () => {
    renderHeader();
    fireEvent.click(bar());

    expect(runButton()).toBeInTheDocument();
    expect(runButton()).not.toBeVisible();
    expect(showHandle()).toBeVisible();
    expect(window.localStorage.getItem(TOP_BAR_STORAGE_VISIBLE_KEY)).toBe(
      "false",
    );
  });

  it("hides the bar when its plain text is clicked", () => {
    renderHeader();
    fireEvent.click(screen.getByText("Header title"));
    expect(runButton()).not.toBeVisible();
  });

  it.each([
    ["a button", "button", {}],
    ["a link", "a", { href: "#x" }],
    ["a text field", "input", {}],
    ["a dropdown", "select", {}],
    ["a text area", "textarea", {}],
    ["a label", "label", {}],
    ["a role=button element", "div", { role: "button" }],
    ["a role=link element", "div", { role: "link" }],
    ["a focusable element", "div", { tabindex: "0" }],
  ])("keeps the bar when %s inside it is clicked", (_label, tag, attributes) => {
    renderHeader(<div data-testid="control" />);
    const host = screen.getByTestId("control");
    const control = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      control.setAttribute(name, value);
    }
    // Click a child, so the control has to be found by walking up from it.
    const inner = document.createElement("span");
    control.appendChild(inner);
    host.appendChild(control);
    fireEvent.click(inner);
    expect(host).toBeVisible();
  });

  it("hides the bar when a tabindex=-1 element is clicked", () => {
    renderHeader(
      <div tabIndex={-1} data-testid="unfocusable">
        x
      </div>,
    );
    fireEvent.click(screen.getByTestId("unfocusable"));
    expect(showHandle()).toBeVisible();
  });

  it("ignores focusable ancestors outside the bar", () => {
    const focusableWrapper = document.createElement("div");
    focusableWrapper.tabIndex = 0;
    document.body.appendChild(focusableWrapper);
    try {
      renderHeader(undefined, { container: focusableWrapper });
      fireEvent.click(bar());
      expect(showHandle()).toBeVisible();
    } finally {
      focusableWrapper.remove();
    }
  });

  it("keeps the bar when a disabled button is clicked", () => {
    renderHeader(
      <div data-testid="wrapper">
        <button type="button" disabled>
          Undo
        </button>
      </div>,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    vi.spyOn(undo, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 40, height: 40 }),
    );
    // The shared Button's `disabled:pointer-events-none` makes the browser
    // target the element underneath it; jsdom applies no CSS, so click that.
    fireEvent.click(screen.getByTestId("wrapper"), {
      clientX: 10,
      clientY: 10,
    });
    expect(undo).toBeVisible();

    fireEvent.click(screen.getByTestId("wrapper"), {
      clientX: 100,
      clientY: 100,
    });
    expect(undo).not.toBeVisible();
  });

  const popperContent = (state: string) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const content = document.createElement("div");
    content.setAttribute("data-state", state);
    wrapper.appendChild(content);
    return wrapper;
  };
  const customMenu = () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    return menu;
  };

  it.each([
    ["an open Radix popup", () => popperContent("open")],
    ["a custom menu", customMenu],
  ])("only dismisses %s when empty space is clicked", (_label, makePopup) => {
    renderHeader();
    const popup = makePopup();
    document.body.appendChild(popup);
    fireEvent.pointerDown(bar());
    popup.remove();
    fireEvent.click(bar());
    expect(runButton()).toBeVisible();

    fireEvent.pointerDown(bar());
    fireEvent.click(bar());
    expect(runButton()).not.toBeVisible();
  });

  it.each([
    ["a popup", () => popperContent("closed")],
    [
      "a menu",
      () => {
        const wrapper = popperContent("closed");
        wrapper.firstElementChild?.setAttribute("role", "menu");
        return wrapper;
      },
    ],
  ])("hides the bar while %s is only animating closed", (_label, makePopup) => {
    renderHeader();
    const popup = makePopup();
    document.body.appendChild(popup);
    try {
      fireEvent.pointerDown(bar());
      fireEvent.click(bar());
      expect(runButton()).not.toBeVisible();
    } finally {
      popup.remove();
    }
  });

  it("keeps the bar for clicks inside content portaled out of it", () => {
    renderHeader(
      createPortal(<div data-testid="portaled">drawer</div>, document.body),
    );
    fireEvent.click(screen.getByTestId("portaled"));
    expect(showHandle()).not.toBeInTheDocument();
  });

  it("keeps the bar when the click ends a text selection", () => {
    renderHeader();
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as Selection);
    fireEvent.click(screen.getByText("Header title"));
    expect(runButton()).toBeVisible();
  });

  it("brings the bar back from the show handle", () => {
    renderHeader();
    fireEvent.click(bar());
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

  it("moves focus from the show handle to the nav button", () => {
    window.localStorage.setItem(TOP_BAR_STORAGE_VISIBLE_KEY, "false");
    renderHeader();
    const handle = showHandle();
    if (!handle) throw new Error("show handle missing");
    handle.focus();
    fireEvent.click(handle);
    expect(document.activeElement).toBe(navButton());
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

    fireEvent.click(bar());
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
