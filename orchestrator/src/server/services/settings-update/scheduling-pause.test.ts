// @vitest-environment node
import * as settingsRepo from "@server/repositories/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySettingsUpdates } from "./apply-updates";

vi.mock("@server/db/index", () => ({ db: {}, schema: {}, closeDb: vi.fn() }));

vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@server/repositories/cv-documents", () => ({
  hasCvDocuments: vi.fn(),
}));

vi.mock("@server/services/envSettings", () => ({
  normalizeEnvInput: (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  },
  applyEnvValue: vi.fn(),
}));

const setSettingMock = vi.mocked(settingsRepo.setSetting);

/**
 * The scheduler's pause latch stops all automatic runs until a human
 * acknowledges a failure. It has exactly ONE clear path — the resume route —
 * and the generic settings PATCH must not be a second one: that endpoint knows
 * nothing about scheduling, and a bulk write lifting a safety latch is the
 * failure mode this codebase has already paid for once.
 */
describe("schedulingPausedReason is not writable through the settings PATCH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to CLEAR the latch", async () => {
    await expect(
      applySettingsUpdates({ schedulingPausedReason: null }),
    ).rejects.toThrow(/Schedule tab/);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("refuses to SET the latch", async () => {
    await expect(
      applySettingsUpdates({ schedulingPausedReason: "injected" }),
    ).rejects.toThrow(/cannot be written directly/);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("aborts the WHOLE batch, writing nothing else either", async () => {
    // Handlers throw in the collect phase, before any persist runs, so a
    // request that smuggles the latch in beside a legitimate key writes
    // neither — rather than half-applying and leaving the caller to guess.
    await expect(
      applySettingsUpdates({
        schedulerTimeZone: "Europe/Vienna",
        schedulingPausedReason: null,
      }),
    ).rejects.toThrow();
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("still lets the timezone through, which IS a user preference", async () => {
    await applySettingsUpdates({ schedulerTimeZone: "Europe/Vienna" });
    expect(setSettingMock).toHaveBeenCalledWith(
      "schedulerTimeZone",
      "Europe/Vienna",
    );
  });
});
