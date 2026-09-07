import { composeTailoringFailure } from "@shared/tailoring-failure";
import { createJob } from "@shared/testing/factories";
import type { JobListItem } from "@shared/types.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyInFlightDialog } from "./CompanyInFlightDialog";
import type { TailorGuardPrompt } from "./useTailorCompanyGuard";

const job = (
  id: string,
  employer: string,
  overrides: Partial<JobListItem> = {},
): JobListItem => createJob({ id, employer, status: "applied", ...overrides });

const prompt = (
  overrides: Partial<TailorGuardPrompt> = {},
): TailorGuardPrompt => ({
  groups: [
    {
      employer: "Acme",
      candidates: [{ id: "sel-1", employer: "Acme" }],
      inFlight: [job("in-1", "Acme", { title: "Staff Engineer" })],
    },
  ],
  allIds: ["sel-1", "sel-2"],
  safeIds: ["sel-2"],
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CompanyInFlightDialog", () => {
  it("renders nothing until there is a prompt", () => {
    render(<CompanyInFlightDialog prompt={null} onResolve={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists the in-flight jobs under their employer", () => {
    render(<CompanyInFlightDialog prompt={prompt()} onResolve={vi.fn()} />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Staff Engineer")).toBeInTheDocument();
    expect(screen.getByText(/1 already in flight/)).toBeInTheDocument();
  });

  it("shows the failure line, which is all that separates a failed tailor from a live one", () => {
    // Both render a "Processing" status badge, and a failed tailor sent no
    // application at all — so without this line the box overstates the clash.
    render(
      <CompanyInFlightDialog
        prompt={prompt({
          groups: [
            {
              employer: "Acme",
              candidates: [{ id: "sel-1", employer: "Acme" }],
              inFlight: [
                job("in-1", "Acme", {
                  status: "processing",
                  tailoringFailureReason: composeTailoringFailure(
                    "Tailoring failed: tectonic exited 1.",
                    "! Undefined control sequence.",
                  ),
                }),
              ],
            },
          ],
        })}
        onResolve={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Tailor failed: Tailoring failed: tectonic exited 1\./),
    ).toBeInTheDocument();
    // The SUMMARY, not the whole composed reason: the detail block belongs in
    // the disclosure on the job itself, and a 2000-char compiler log would
    // swamp this list.
    expect(
      screen.queryByText(/Undefined control sequence/),
    ).not.toBeInTheDocument();
  });

  it("resolves every id from Tailor anyway", () => {
    const onResolve = vi.fn();
    render(<CompanyInFlightDialog prompt={prompt()} onResolve={onResolve} />);
    fireEvent.click(
      screen.getByRole("button", { name: /tailor anyway \(2\)/i }),
    );
    expect(onResolve).toHaveBeenCalledWith(["sel-1", "sel-2"]);
  });

  it("resolves only the safe ids from Tailor the other N", () => {
    const onResolve = vi.fn();
    render(<CompanyInFlightDialog prompt={prompt()} onResolve={onResolve} />);
    fireEvent.click(
      screen.getByRole("button", { name: /tailor the other 1/i }),
    );
    expect(onResolve).toHaveBeenCalledWith(["sel-2"]);
  });

  it("resolves null from Cancel", () => {
    const onResolve = vi.fn();
    render(<CompanyInFlightDialog prompt={prompt()} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it("resolves null on Escape — dismissal must not tailor", () => {
    const onResolve = vi.fn();
    render(<CompanyInFlightDialog prompt={prompt()} onResolve={onResolve} />);
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(onResolve).toHaveBeenCalledWith(null);
  });

  it("hides Tailor the other N when it would dispatch nothing", () => {
    render(
      <CompanyInFlightDialog
        prompt={prompt({ allIds: ["sel-1"], safeIds: [] })}
        onResolve={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /tailor the other/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /tailor anyway \(1\)/i }),
    ).toBeInTheDocument();
  });

  it("counts the blocked jobs, not the groups", () => {
    render(
      <CompanyInFlightDialog
        prompt={prompt({ allIds: ["a", "b", "c"], safeIds: ["c"] })}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/2 jobs you selected are/)).toBeInTheDocument();
  });

  it("names the single company in the title, and counts them when there are several", () => {
    const { unmount } = render(
      <CompanyInFlightDialog prompt={prompt()} onResolve={vi.fn()} />,
    );
    expect(
      screen.getByText("You already have work in flight at Acme"),
    ).toBeInTheDocument();
    unmount();

    render(
      <CompanyInFlightDialog
        prompt={prompt({
          groups: [
            {
              employer: "Acme",
              candidates: [{ id: "sel-1", employer: "Acme" }],
              inFlight: [job("in-1", "Acme")],
            },
            {
              employer: "Globex",
              candidates: [{ id: "sel-2", employer: "Globex" }],
              inFlight: [job("in-2", "Globex")],
            },
          ],
        })}
        onResolve={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "You already have work in flight at 2 of these companies",
      ),
    ).toBeInTheDocument();
  });
});
