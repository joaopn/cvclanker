import { render, screen } from "@testing-library/react";
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
});
