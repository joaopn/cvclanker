import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { SwipeCard, SwipeCardContent, type SwipeCardHandle } from "./SwipeCard";

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

  it("flags an Easy Apply posting on the live-status line", () => {
    card({
      liveClosed: false,
      liveApplicants: "20 applicants",
      liveEasyApply: true,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(screen.getByText("Easy Apply")).toBeInTheDocument();
    expect(screen.getByText("20 applicants")).toBeInTheDocument();
  });

  it("shows no chip for an offsite posting", () => {
    // `false` is a real verdict ("apply on the employer's site") and describes
    // most postings, so it deliberately renders nothing.
    card({
      liveClosed: false,
      liveApplicants: "20 applicants",
      liveEasyApply: false,
      liveStatusCheckedAt: new Date().toISOString(),
    });
    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
  });

  it("shows no chip on a row nobody has checked", () => {
    card({ liveClosed: null, liveEasyApply: null, liveStatusCheckedAt: null });
    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
  });

  it("shows no Easy Apply chip on a closed posting", () => {
    card({
      liveClosed: true,
      liveApplicants: null,
      liveEasyApply: null,
      liveStatusCheckedAt: new Date().toISOString(),
    });
    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
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

describe("SwipeCard frozen while a tailor is parked", () => {
  const mount = (frozen: boolean) => {
    const onCommit = vi.fn();
    const ref = createRef<SwipeCardHandle>();
    render(
      <SwipeCard
        ref={ref}
        job={createJob({ id: "a", title: "Python Developer" })}
        onCommit={onCommit}
        frozen={frozen}
      />,
    );
    return { onCommit, ref };
  };

  it("refuses an imperative fly-out, so nothing is dispatched", async () => {
    // The card cannot come back from a second fly-out: x/y are motion values
    // reset only by remount, and a refused second swipe leaves this card at the
    // top with an unchanged key. Refusing the gesture is what avoids that.
    const { onCommit, ref } = mount(true);

    act(() => ref.current?.flyOut("move_to_ready"));
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("still flies out when not frozen", async () => {
    const { onCommit, ref } = mount(false);

    act(() => ref.current?.flyOut("move_to_ready"));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith("move_to_ready"));
  });
});
