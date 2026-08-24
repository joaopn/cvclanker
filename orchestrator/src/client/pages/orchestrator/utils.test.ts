import { createAppSettings } from "@shared/testing/factories.js";
import { defaultProfileConfig, type Profile } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  collectProfileSearchTitles,
  getEnabledSources,
  getJobCountsFromStats,
} from "./utils";

const profile = (id: string, searchTerms: string[]): Profile => ({
  id,
  name: id,
  config: { ...defaultProfileConfig(), searchTerms },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("collectProfileSearchTitles", () => {
  it("unions every profile's terms, deduped case-insensitively (first spelling wins), sorted", () => {
    expect(
      collectProfileSearchTitles([
        profile("a", ["Python Developer", "  ", "SRE"]),
        profile("b", ["python developer", "Backend Engineer"]),
      ]),
    ).toEqual(["Backend Engineer", "Python Developer", "SRE"]);
  });

  it("returns an empty list with no profiles", () => {
    expect(collectProfileSearchTitles([])).toEqual([]);
  });
});

describe("orchestrator utils", () => {
  it("enables startupjobs without credentials", () => {
    expect(getEnabledSources(createAppSettings())).toContain("startupjobs");
  });

  it("enables workingnomads without credentials", () => {
    expect(getEnabledSources(createAppSettings())).toContain("workingnomads");
  });

  it("maps by-status stats to tab counts including the `discovered` alias", () => {
    expect(
      getJobCountsFromStats({
        discovered: 1,
        selected: 1,
        processing: 1,
        ready: 1,
        applied: 1,
        in_progress: 1,
        backlog: 1,
        stale: 1,
        skipped: 1,
        closed: 1,
      }),
    ).toEqual({
      inbox: 1,
      tailoring: 2, // processing + ready
      live: 1, // applied
      interviewing: 1, // in_progress
      backlog: 1,
      stale: 1,
      closed: 2, // skipped + closed
      all: 10, // a stray legacy `selected` row counts only here
      discovered: 1, // legacy alias for inbox
    });
  });
});
