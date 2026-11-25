import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const baseProps = {
  isStreaming: false,
  onStop: vi.fn(async () => {}),
  onSend: vi.fn(async () => {}),
};

describe("Composer", () => {
  it("renders no Clear button without onReset", () => {
    render(<Composer {...baseProps} />);
    expect(
      screen.queryByRole("button", { name: "Clear conversation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Clear button for ghostwriter, which passes onReset", () => {
    render(<Composer {...baseProps} canReset onReset={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Clear conversation" }),
    ).toBeEnabled();
  });

  it("renders leading content in the bottom row, before the hint", () => {
    render(<Composer {...baseProps} leading={<span>Sample menus</span>} />);
    const leading = screen.getByText("Sample menus");
    const hint = screen.getByText("Enter to send, Shift+Enter for a new line");
    expect(leading.parentElement).toBe(hint.parentElement);
    expect(leading.nextElementSibling).toBe(hint);
  });

  function typeAndPress(init: KeyboardEventInit) {
    const onSend = vi.fn(async () => {});
    render(<Composer {...baseProps} onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Which jobs at Acme?" } });
    fireEvent.keyDown(box, { key: "Enter", ...init });
    return onSend;
  }

  it("sends on Enter", () => {
    expect(typeAndPress({})).toHaveBeenCalledWith("Which jobs at Acme?");
  });

  it("does not send on Shift+Enter", () => {
    expect(typeAndPress({ shiftKey: true })).not.toHaveBeenCalled();
  });

  it("does not send on Enter while an IME is composing", () => {
    expect(typeAndPress({ isComposing: true })).not.toHaveBeenCalled();
  });

  it("does not send on the Enter that confirms an IME composition", () => {
    expect(typeAndPress({ keyCode: 229 })).not.toHaveBeenCalled();
  });
});
