// @vitest-environment node
import { hasCvDocuments } from "@server/repositories/cv-documents";
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
  // Faithful stub of the real normalizeEnvInput (envSettings.ts) — the
  // generic delegate persists through it.
  normalizeEnvInput: (value: string | null | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  },
  applyEnvValue: vi.fn(),
}));

const getSettingMock = vi.mocked(settingsRepo.getSetting);
const setSettingMock = vi.mocked(settingsRepo.setSetting);
const hasCvDocumentsMock = vi.mocked(hasCvDocuments);

const CONFLICT_SHAPE = { name: "AppError", status: 409, code: "CONFLICT" };

describe("cvSourceFormat write-once guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue(null);
    hasCvDocumentsMock.mockResolvedValue(false);
  });

  it("allows first-write latex even when documents exist", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await applySettingsUpdates({ cvSourceFormat: "latex" });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", "latex");
  });

  it("allows the first write of docx when no CV documents exist", async () => {
    await applySettingsUpdates({ cvSourceFormat: "docx" });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", "docx");
  });

  it("rejects the first write of docx when CV documents exist", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await expect(
      applySettingsUpdates({ cvSourceFormat: "docx" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("allows the first write of html when no CV documents exist", async () => {
    await applySettingsUpdates({ cvSourceFormat: "html" });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", "html");
  });

  it("rejects the first write of html when CV documents exist, naming it", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await expect(
      applySettingsUpdates({ cvSourceFormat: "html" }),
    ).rejects.toMatchObject({
      ...CONFLICT_SHAPE,
      message:
        "Cannot set the CV format to HTML while CV documents already exist in this profile.",
    });
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("rejects html over a stored format, and another format over html", async () => {
    getSettingMock.mockResolvedValue("docx");
    await expect(
      applySettingsUpdates({ cvSourceFormat: "html" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    getSettingMock.mockResolvedValue("html");
    await expect(
      applySettingsUpdates({ cvSourceFormat: "latex" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("allows a null write while unset even when documents exist", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await applySettingsUpdates({ cvSourceFormat: null });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", null);
  });

  it("lets an absent value through while unset, as before HTML", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await expect(
      applySettingsUpdates({ cvSourceFormat: undefined }),
    ).resolves.toEqual({});
  });

  it("allows an idempotent re-write of the stored value", async () => {
    getSettingMock.mockResolvedValue("latex");
    await applySettingsUpdates({ cvSourceFormat: "latex" });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", "latex");
  });

  it("rejects a differing write once a value is stored", async () => {
    getSettingMock.mockResolvedValue("latex");
    await expect(
      applySettingsUpdates({ cvSourceFormat: "docx" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("rejects flipping a stored docx back to latex", async () => {
    getSettingMock.mockResolvedValue("docx");
    await expect(
      applySettingsUpdates({ cvSourceFormat: "latex" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("rejects a null clear once a value is stored", async () => {
    getSettingMock.mockResolvedValue("docx");
    await expect(
      applySettingsUpdates({ cvSourceFormat: null }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("allows a null write while unset (no-op)", async () => {
    await applySettingsUpdates({ cvSourceFormat: null });
    expect(setSettingMock).toHaveBeenCalledWith("cvSourceFormat", null);
  });

  it("aborts the whole batch when the guard rejects", async () => {
    hasCvDocumentsMock.mockResolvedValue(true);
    await expect(
      applySettingsUpdates({ cvSourceFormat: "docx", userProfileName: "x" }),
    ).rejects.toMatchObject(CONFLICT_SHAPE);
    expect(setSettingMock).not.toHaveBeenCalled();
  });
});
