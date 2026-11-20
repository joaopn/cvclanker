import type {
  BatchUrlImportItemResult,
  UrlImportBatchSnapshot,
} from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api/client", () => ({
  getUrlImportBatch: vi.fn(),
  saveManualUrlImport: vi.fn(),
  getUrlImportDraft: vi.fn(),
  startUrlImportBatch: vi.fn(),
  cancelUrlImportBatch: vi.fn(),
}));

vi.mock("@client/lib/batch-stream", () => ({
  createLazyEventStream: () => ({
    ensureOpen: vi.fn(),
    closeIfIdle: vi.fn(),
    reset: vi.fn(),
  }),
}));

import * as api from "@client/api/client";
import {
  getUrlImportBatch,
  resetUrlImportBatchClientForTests,
  saveManualUrlImport,
} from "./url-import-batch";

const saved: BatchUrlImportItemResult = {
  ok: true,
  status: "created",
  url: "https://example.com/b",
  jobId: "j2",
  title: "Data Engineer",
  employer: "Acme",
};

const finished = (failed: number): UrlImportBatchSnapshot => ({
  batchId: "import-1",
  status: "completed",
  urls: ["https://example.com/b"],
  results: [],
  requested: 1,
  completed: 1,
  succeeded: 1 - failed,
  duplicates: 0,
  failed,
  startedAt: "2026-11-20T00:00:00.000Z",
  finishedAt: "2026-11-20T00:01:00.000Z",
});

afterEach(() => {
  resetUrlImportBatchClientForTests();
  vi.clearAllMocks();
});

describe("saveManualUrlImport", () => {
  // The stream is closed once an import has finished, which is when a row is
  // usually finished by hand — so the server's update reaches no tab, and only
  // this re-read turns the row saved.
  it("re-reads the import after saving, so the row shows saved", async () => {
    vi.mocked(api.saveManualUrlImport).mockResolvedValueOnce(saved);
    vi.mocked(api.getUrlImportBatch).mockResolvedValueOnce(finished(0));

    const result = await saveManualUrlImport({
      batchId: "import-1",
      url: "https://example.com/b",
      job: { title: "Data Engineer", employer: "Acme", jobDescription: "x" },
    });

    expect(result).toEqual(saved);
    expect(api.getUrlImportBatch).toHaveBeenCalledTimes(1);
    expect(getUrlImportBatch()?.failed).toBe(0);
  });

  it("still reports the save when the re-read fails", async () => {
    vi.mocked(api.saveManualUrlImport).mockResolvedValueOnce(saved);
    vi.mocked(api.getUrlImportBatch).mockRejectedValueOnce(new Error("down"));

    await expect(
      saveManualUrlImport({
        batchId: "import-1",
        url: "https://example.com/b",
        job: { title: "Data Engineer", employer: "Acme", jobDescription: "x" },
      }),
    ).resolves.toEqual(saved);
  });
});
