import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SwipeCardContent } from "./SwipeCard";

const card = (overrides: Partial<Job> = {}) =>
  render(
    <SwipeCardContent
      job={createJob({
        id: "a",
        title: "Python Developer",
        employer: "Acme",
        jobUrl: "https://www.linkedin.com/jobs/view/4000000001",
        ...overrides,
      })}
    />,
  );

describe("SwipeCardContent live status", () => {
  it("shows the board's applicant caption and when it was read", () => {
    card({
      liveClosed: false,
      liveApplicants: "45 applicants",
      liveStatusCheckedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    expect(screen.getByText("45 applicants")).toBeInTheDocument();
    expect(screen.getByText("checked 1d ago")).toBeInTheDocument();
  });

  it("says the posting is open when it was checked and carried no caption", () => {
    card({
      liveClosed: false,
      liveApplicants: null,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(screen.getByText("Accepting applications")).toBeInTheDocument();
    expect(screen.getByText("checked today")).toBeInTheDocument();
  });

  it("shows the closed badge and no count — a closed posting's caption is reset by the board", () => {
    card({
      liveClosed: true,
      liveApplicants: null,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(
      screen.getByText("No longer accepting applications"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/applicants/)).not.toBeInTheDocument();
  });

  it("shows nothing about applicants on a row nobody has checked", () => {
    card({ liveClosed: null, liveApplicants: null, liveStatusCheckedAt: null });

    expect(screen.getByText("Python Developer")).toBeInTheDocument();
    expect(screen.queryByText(/applicants/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Accepting applications"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/^checked /)).not.toBeInTheDocument();
  });
});
