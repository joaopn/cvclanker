import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import {
  defaultProfileConfig,
  MAX_SEARCH_TERMS,
  type Profile,
} from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  updateProfile: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { updateProfile } from "@client/api";
import { toast } from "@client/lib/toast";
import { TermMatrix } from "./TermMatrix";

function profile(
  id: string,
  name: string,
  searchTerms: string[],
  scrapeSinceLastRun = false,
): Profile {
  return {
    id,
    name,
    config: { ...defaultProfileConfig(), searchTerms, scrapeSinceLastRun },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

const alpha = profile("p1", "Alpha", ["backend", "ML engineer"]);
const beta = profile("p2", "Beta", ["ml engineer"]);

function cell(term: string, profileName: string) {
  return screen.getByRole("checkbox", { name: `${term} on ${profileName}` });
}

function saveButton() {
  return screen.getByRole("button", { name: "Save" });
}

describe("TermMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateProfile).mockImplementation(async (id) => ({
      ...(id === "p1" ? alpha : beta),
    }));
  });

  it("renders terms as rows and profiles as columns with the saved state", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    expect(cell("backend", "Alpha")).toHaveAttribute("data-state", "checked");
    expect(cell("backend", "Beta")).toHaveAttribute("data-state", "unchecked");
    expect(cell("ML engineer", "Alpha")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(cell("ML engineer", "Beta")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(saveButton()).toBeDisabled();
  });

  it("writes nothing until Save, then saves only the changed profile", async () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(cell("backend", "Beta"));
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.getByText("1 profile changed")).toBeInTheDocument();

    fireEvent.click(saveButton());
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith("p2", {
      config: { searchTerms: ["ml engineer", "backend"] },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Saved changes on 1 profile"),
    );
  });

  it("toggling a cell back to its saved state leaves nothing to save", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(cell("backend", "Beta"));
    fireEvent.click(cell("backend", "Beta"));
    expect(saveButton()).toBeDisabled();
  });

  it("a term click turns its row on everywhere, and off when already all on", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "backend" }));
    expect(cell("backend", "Beta")).toHaveAttribute("data-state", "checked");
    fireEvent.click(screen.getByRole("button", { name: "backend" }));
    expect(cell("backend", "Alpha")).toHaveAttribute("data-state", "unchecked");
    expect(cell("backend", "Beta")).toHaveAttribute("data-state", "unchecked");
  });

  it("a profile click turns its column on, and off when already all on", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(cell("backend", "Beta")).toHaveAttribute("data-state", "checked");
    expect(cell("ML engineer", "Beta")).toHaveAttribute(
      "data-state",
      "checked",
    );
    fireEvent.click(screen.getByRole("button", { name: /^Beta/ }));
    expect(cell("backend", "Beta")).toHaveAttribute("data-state", "unchecked");
    expect(cell("ML engineer", "Beta")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    // Alpha is untouched.
    expect(cell("backend", "Alpha")).toHaveAttribute("data-state", "checked");
  });

  it("adds a new row that can be ticked onto profiles", async () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.change(screen.getByLabelText("New search term"), {
      target: { value: "  Rust developer " },
    });
    fireEvent.click(screen.getByRole("button", { name: /add row/i }));
    expect(cell("Rust developer", "Alpha")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    fireEvent.click(cell("Rust developer", "Alpha"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith("p1", {
        config: {
          searchTerms: ["backend", "ML engineer", "Rust developer"],
        },
      }),
    );
  });

  it("discard restores the saved state", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(cell("backend", "Alpha"));
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(cell("backend", "Alpha")).toHaveAttribute("data-state", "checked");
    expect(saveButton()).toBeDisabled();
  });

  it("keeps a failed profile's edits and reports it, while the other saves", async () => {
    vi.mocked(updateProfile).mockImplementation(async (id) => {
      if (id === "p1") throw new Error("too many terms");
      return beta;
    });
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "backend" }));
    fireEvent.click(cell("ML engineer", "Alpha"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '"Alpha" was not saved: too many terms',
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Saved changes on 1 profile");
    // Beta's edit was written; the props still carry the pre-save Beta, so
    // only Alpha is asserted: its unsaved edit is still on screen.
    expect(cell("ML engineer", "Alpha")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("keeps an added row after a partial failure", async () => {
    vi.mocked(updateProfile).mockImplementation(async (id) => {
      if (id === "p1") throw new Error("boom");
      return beta;
    });
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
    );
    fireEvent.change(screen.getByLabelText("New search term"), {
      target: { value: "Rust" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add row/i }));
    fireEvent.click(screen.getByRole("button", { name: "Rust" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The props still carry the pre-save profiles, so the row survives only
    // because a failed save keeps the added rows.
    expect(cell("Rust", "Alpha")).toHaveAttribute("data-state", "checked");
  });

  it("refuses to empty the default profile", () => {
    renderWithQueryClient(
      <TermMatrix profiles={[alpha, beta]} defaultProfileId="p1" />,
    );
    // Alpha already has every row, so its header click turns them all off.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(cell("backend", "Alpha")).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByRole("alert")).toHaveTextContent(
      '"Alpha" is the default profile and needs at least one term.',
    );
    expect(saveButton()).toBeDisabled();
    // A non-default profile may be emptied.
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    fireEvent.click(cell("ML engineer", "Beta"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it("refuses a save that would exceed the per-profile term limit", () => {
    const many = profile(
      "p9",
      "Many",
      Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `term ${i}`),
    );
    const other = profile("p8", "Other", ["extra"]);
    renderWithQueryClient(
      <TermMatrix profiles={[many, other]} defaultProfileId={null} />,
    );
    fireEvent.click(cell("extra", "Many"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      `"Many" would have ${MAX_SEARCH_TERMS + 1} terms`,
    );
    expect(saveButton()).toBeDisabled();
  });

  it("warns when a save restarts scrape-since-last-run", async () => {
    const gamma = profile("p3", "Gamma", ["backend"], true);
    vi.mocked(updateProfile).mockResolvedValue(gamma);
    renderWithQueryClient(
      <TermMatrix profiles={[gamma]} defaultProfileId={null} />,
    );
    fireEvent.click(cell("backend", "Gamma"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Saved changes on 1 profile",
        expect.objectContaining({
          description: expect.stringContaining("Gamma"),
        }),
      ),
    );
  });

  describe("jobs per search term", () => {
    const budgets = (
      base: Profile,
      termJobBudgets: Record<string, number>,
    ): Profile => ({ ...base, config: { ...base.config, termJobBudgets } });

    function jobs(term: string) {
      return screen.getByRole("spinbutton", {
        name: `Jobs per search for ${term}`,
      });
    }

    it("shows the override every ticked profile shares", () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[
            budgets(alpha, { "ml engineer": 40, backend: 60 }),
            budgets(beta, { "ml engineer": 40 }),
          ]}
          defaultProfileId={null}
        />,
      );
      expect(jobs("ML engineer")).toHaveValue(40);
      expect(jobs("backend")).toHaveValue(60);
    });

    it("says mixed, with no number, where the ticked profiles disagree", () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[budgets(alpha, { "ml engineer": 40 }), beta]}
          defaultProfileId={null}
        />,
      );
      expect(jobs("ML engineer")).toHaveValue(null);
      expect(jobs("ML engineer")).toHaveAttribute("placeholder", "mixed");
      expect(jobs("backend")).toHaveAttribute("placeholder", "default");
    });

    it("reads default, not mixed, once a mixed cell is emptied", () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[budgets(alpha, { "ml engineer": 40 }), beta]}
          defaultProfileId={null}
        />,
      );
      // Typed into, then emptied: an unchanged value fires no change event.
      fireEvent.change(jobs("ML engineer"), { target: { value: "5" } });
      fireEvent.change(jobs("ML engineer"), { target: { value: "" } });
      expect(jobs("ML engineer")).toHaveAttribute("placeholder", "default");
    });

    it("blocks Save on text the browser could not read as a number", () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[budgets(alpha, { backend: 60 }), beta]}
          defaultProfileId={null}
        />,
      );
      const input = jobs("backend");
      // A number input reports half-typed text like "1e" as an empty value;
      // only `badInput` tells that apart from a cell the user cleared.
      Object.defineProperty(input, "validity", {
        value: { badInput: true },
      });
      fireEvent.change(input, { target: { value: "" } });
      expect(saveButton()).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        'Jobs for "backend" must be a whole number',
      );
    });

    it("catches half-typed text entered into a cell the user had emptied", () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[budgets(alpha, { backend: 60 }), beta]}
          defaultProfileId={null}
        />,
      );
      const input = jobs("backend");
      fireEvent.change(input, { target: { value: "" } });
      expect(saveButton()).toBeEnabled();
      // Typing "-" into the empty cell leaves its value "" (no onChange), so
      // only the input event can say the text is unreadable.
      Object.defineProperty(input, "validity", {
        value: { badInput: true },
      });
      fireEvent.input(input);
      expect(saveButton()).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        'Jobs for "backend" must be a whole number',
      );
    });

    it("ignores a Jobs cell on a row no profile has ticked", () => {
      renderWithQueryClient(
        <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
      );
      fireEvent.click(cell("backend", "Alpha"));
      fireEvent.change(jobs("backend"), { target: { value: "5" } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(saveButton()).toBeEnabled();
    });

    it("discards Jobs edits", () => {
      renderWithQueryClient(
        <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
      );
      fireEvent.change(jobs("backend"), { target: { value: "5" } });
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      expect(jobs("backend")).toHaveValue(null);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("sets a budget on every profile the term is ticked on, and only those", async () => {
      renderWithQueryClient(
        <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
      );
      fireEvent.change(jobs("backend"), { target: { value: "250" } });
      expect(screen.getByText("1 profile changed")).toBeInTheDocument();

      fireEvent.click(saveButton());
      await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
      // The map is sent whole and the unchanged terms are not.
      expect(updateProfile).toHaveBeenCalledWith("p1", {
        config: { termJobBudgets: { backend: 250 } },
      });
    });

    it("applies a row's budget to a profile the term is being ticked into", async () => {
      renderWithQueryClient(
        <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
      );
      fireEvent.click(cell("backend", "Beta"));
      fireEvent.change(jobs("backend"), { target: { value: "70" } });

      fireEvent.click(saveButton());
      await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
      expect(updateProfile).toHaveBeenCalledWith("p2", {
        config: {
          searchTerms: ["ml engineer", "backend"],
          termJobBudgets: { backend: 70 },
        },
      });
    });

    it("clears the overrides when the cell is emptied", async () => {
      renderWithQueryClient(
        <TermMatrix
          profiles={[
            budgets(alpha, { "ml engineer": 40, backend: 60 }),
            budgets(beta, { "ml engineer": 40 }),
          ]}
          defaultProfileId={null}
        />,
      );
      fireEvent.change(jobs("ML engineer"), { target: { value: "" } });

      fireEvent.click(saveButton());
      await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(2));
      expect(updateProfile).toHaveBeenCalledWith("p1", {
        config: { termJobBudgets: { backend: 60 } },
      });
      expect(updateProfile).toHaveBeenCalledWith("p2", {
        config: { termJobBudgets: {} },
      });
    });

    it("blocks Save on a budget below the actor's minimum", () => {
      renderWithQueryClient(
        <TermMatrix profiles={[alpha, beta]} defaultProfileId={null} />,
      );
      fireEvent.change(jobs("backend"), { target: { value: "5" } });
      expect(saveButton()).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        'Jobs for "backend" must be a whole number from 10 to 5000',
      );
    });
  });
});
