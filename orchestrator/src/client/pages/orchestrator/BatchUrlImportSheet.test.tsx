import type { UrlImportBatchSnapshot } from "@shared/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const subscribeMock = vi.fn();
const refreshMock = vi.fn();
const startMock = vi.fn();
const cancelMock = vi.fn();

vi.mock("@client/lib/url-import-batch", () => ({
  getUrlImportBatch: (...a: unknown[]) => getMock(...a),
  subscribeToUrlImportBatch: (...a: unknown[]) => subscribeMock(...a),
  refreshUrlImportBatch: (...a: unknown[]) => refreshMock(...a),
  startUrlImportBatch: (...a: unknown[]) => startMock(...a),
  cancelUrlImportBatch: (...a: unknown[]) => cancelMock(...a),
}));

vi.mock("@client/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from "@client/lib/toast";
import { BatchUrlImportSheet } from "./BatchUrlImportSheet";

let sync: () => void;

const snapshot = (
  overrides: Partial<UrlImportBatchSnapshot> = {},
): UrlImportBatchSnapshot => ({
  batchId: "import-1",
  status: "running",
  urls: ["https://example.com/a", "https://example.com/b"],
  results: [],
  requested: 2,
  completed: 0,
  succeeded: 0,
  duplicates: 0,
  failed: 0,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  refreshMock.mockResolvedValue(undefined);
  getMock.mockReturnValue(null);
  subscribeMock.mockImplementation((listener: () => void) => {
    sync = listener;
    return vi.fn();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BatchUrlImportSheet", () => {
  // The finished record is retained so a device arriving afterwards can read
  // which URLs failed. Without an observed-terminal guard, that record makes
  // the sheet fire its completion path and close itself the moment it opens.
  it("does not close itself when opened on an import that already finished", async () => {
    const onOpenChange = vi.fn();
    const onCompleted = vi.fn();
    getMock.mockReturnValue(
      snapshot({
        status: "completed",
        completed: 2,
        succeeded: 2,
        finishedAt: "2026-08-27T00:01:00.000Z",
        results: [
          {
            ok: true,
            status: "created",
            url: "https://example.com/a",
            jobId: "j1",
            title: "Eng",
            employer: "Acme",
          },
          {
            ok: true,
            status: "created",
            url: "https://example.com/b",
            jobId: "j2",
            title: "Eng",
            employer: "Acme",
          },
        ],
      }),
    );

    render(
      <BatchUrlImportSheet
        open
        onOpenChange={onOpenChange}
        onCompleted={onCompleted}
      />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    // …and it still shows what happened, which is the point of retaining it.
    expect(screen.getByText("https://example.com/a")).toBeTruthy();
  });

  // This component is mounted for the life of the page, so mount-time discovery
  // alone would leave a tab open since this morning unaware of an import
  // started on another device — and it would then meet a 409 it could not
  // explain, with no results table and no Stop button.
  it("re-discovers when the tab comes back to the foreground", async () => {
    render(
      <BatchUrlImportSheet open onOpenChange={vi.fn()} onCompleted={vi.fn()} />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(3));
  });

  it("reports completion once for an import it watched running", async () => {
    const onOpenChange = vi.fn();
    const onCompleted = vi.fn();
    getMock.mockReturnValue(snapshot());

    render(
      <BatchUrlImportSheet
        open
        onOpenChange={onOpenChange}
        onCompleted={onCompleted}
      />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(onCompleted).not.toHaveBeenCalled();

    getMock.mockReturnValue(
      snapshot({
        status: "completed",
        completed: 2,
        succeeded: 2,
        finishedAt: "2026-08-27T00:01:00.000Z",
      }),
    );
    sync();

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // A tab attaching at 1/3 has one result. Rows built from results alone would
  // show one URL and retry against a truncated list.
  it("renders a row per REQUESTED url, not per settled result", async () => {
    getMock.mockReturnValue(
      snapshot({
        urls: ["https://a.test/1", "https://a.test/2", "https://a.test/3"],
        requested: 3,
        completed: 1,
        succeeded: 1,
        results: [
          {
            ok: true,
            status: "created",
            url: "https://a.test/1",
            jobId: "j1",
            title: "Eng",
            employer: "Acme",
          },
        ],
      }),
    );

    render(
      <BatchUrlImportSheet open onOpenChange={vi.fn()} onCompleted={vi.fn()} />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    expect(screen.getByText("https://a.test/1")).toBeTruthy();
    expect(screen.getByText("https://a.test/2")).toBeTruthy();
    expect(screen.getByText("https://a.test/3")).toBeTruthy();
  });

  // Detaching removed the only abort there was — closing the sheet used to
  // kill the request. This button is its replacement, so wire it, don't just
  // render it.
  it("stops a running import from the Stop button", async () => {
    cancelMock.mockResolvedValue(undefined);
    getMock.mockReturnValue(snapshot());
    render(
      <BatchUrlImportSheet open onOpenChange={vi.fn()} onCompleted={vi.fn()} />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(cancelMock).toHaveBeenCalled();
  });

  // The record vanishing without a terminal means the server lost it; silence
  // would just make a 50-URL run disappear from the table.
  it("says so when the import it was watching disappears", async () => {
    getMock.mockReturnValue(snapshot());
    render(
      <BatchUrlImportSheet open onOpenChange={vi.fn()} onCompleted={vi.fn()} />,
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    getMock.mockReturnValue(null);
    sync();
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  });
});
