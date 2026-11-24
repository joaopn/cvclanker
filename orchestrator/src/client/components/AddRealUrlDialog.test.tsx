import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateJob } = vi.hoisted(() => ({
  updateJob: vi.fn(),
}));

vi.mock("@client/api", () => ({ updateJob }));
vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { AddRealUrlDialog } from "./AddRealUrlDialog";

const INVALID_MESSAGE = "Enter a full http:// or https:// address.";

const openAndType = (value: string) => {
  const onJobUpdated = vi.fn();
  render(<AddRealUrlDialog jobId="job-7" onJobUpdated={onJobUpdated} />);
  fireEvent.click(screen.getByRole("button", { name: "Add real URL" }));
  fireEvent.change(screen.getByLabelText("Application address"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  return { onJobUpdated };
};

beforeEach(() => {
  updateJob.mockReset();
  updateJob.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
});

describe("AddRealUrlDialog", () => {
  it("saves the trimmed address as the application link and refreshes", async () => {
    const { onJobUpdated } = openAndType(
      "  https://careers.example.com/apply/42  ",
    );

    await waitFor(() => expect(onJobUpdated).toHaveBeenCalledTimes(1));
    expect(updateJob).toHaveBeenCalledTimes(1);
    expect(updateJob).toHaveBeenCalledWith("job-7", {
      applicationLink: "https://careers.example.com/apply/42",
    });
    expect(Object.keys(updateJob.mock.calls[0][1])).toEqual([
      "applicationLink",
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it.each([
    ["text that is not an address", "not a url"],
    ["an ftp address", "ftp://files.example.com/apply"],
    ["an empty value", "   "],
  ])("rejects %s without saving", (_label, value) => {
    const { onJobUpdated } = openAndType(value);

    expect(screen.getByText(INVALID_MESSAGE)).toBeInTheDocument();
    expect(updateJob).not.toHaveBeenCalled();
    expect(onJobUpdated).not.toHaveBeenCalled();
  });

  it("keeps key presses inside the box away from the page's shortcuts", () => {
    const pageShortcut = vi.fn();
    window.addEventListener("keydown", pageShortcut);
    try {
      render(<AddRealUrlDialog jobId="job-7" onJobUpdated={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Add real URL" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), {
        key: "s",
      });
      expect(pageShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", pageShortcut);
    }
  });

  it("closes on Escape", async () => {
    render(<AddRealUrlDialog jobId="job-7" onJobUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add real URL" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
