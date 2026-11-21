import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderDialog, readerSubtitle } from "./ReaderDialog";

const renderReader = () =>
  render(
    <ReaderDialog title="Notes" subtitle="Engineer · Acme">
      <p>Reader body</p>
    </ReaderDialog>,
  );

describe("ReaderDialog", () => {
  it("is closed until its button is clicked", () => {
    renderReader();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Reader body")).not.toBeInTheDocument();
  });

  it("opens a 1200px box with the title, subtitle and content", () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Notes");
    expect(dialog).toHaveTextContent("Engineer · Acme");
    expect(dialog).toHaveTextContent("Reader body");
    expect(dialog).toHaveClass("w-[1200px]", "max-w-[calc(100vw-2rem)]");
    expect(dialog).not.toHaveClass("max-w-lg");
    expect(dialog).not.toHaveClass("w-full");
    expect(dialog).not.toHaveClass("grid");
  });

  it("puts focus on the scrolling body, so the keyboard scrolls the text", () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));

    expect(document.activeElement).toBe(
      screen.getByText("Reader body").parentElement,
    );
  });

  it("keeps key presses inside the box away from the page's shortcuts", () => {
    const pageShortcut = vi.fn();
    window.addEventListener("keydown", pageShortcut);
    try {
      renderReader();
      fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));
      fireEvent.keyDown(screen.getByText("Reader body"), { key: "s" });
      expect(pageShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", pageShortcut);
    }
  });

  it("closes on Escape and returns focus to its button", async () => {
    renderReader();
    const button = screen.getByRole("button", { name: "Open in reader" });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("closes on a click outside the box", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Radix registers its outside-press listener on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("closes on its close button", async () => {
    renderReader();
    fireEvent.click(screen.getByRole("button", { name: "Open in reader" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});

describe("readerSubtitle", () => {
  it("joins the job title and employer", () => {
    expect(readerSubtitle({ title: "Engineer", employer: "Acme" })).toBe(
      "Engineer · Acme",
    );
  });
});
