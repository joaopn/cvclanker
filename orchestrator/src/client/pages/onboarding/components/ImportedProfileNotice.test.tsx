import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "cvclanker.importedProfileNotice";

// The module memoises its read for the life of the page, so each test takes a
// fresh module the way a real page load would.
async function loadFresh() {
  vi.resetModules();
  const lib = await import("@client/lib/importedProfileNotice");
  const { ImportedProfileNotice } = await import("./ImportedProfileNotice");
  return { ...lib, ImportedProfileNotice };
}

describe("ImportedProfileNotice", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders nothing when no import is pending", async () => {
    const { ImportedProfileNotice } = await loadFresh();
    const { container } = render(<ImportedProfileNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the imported profile and explains the missing credential", async () => {
    const { rememberImportedProfile, ImportedProfileNotice } =
      await loadFresh();
    rememberImportedProfile("Main hunt");

    render(<ImportedProfileNotice />);
    expect(screen.getByText(/Imported "Main hunt"/)).toBeInTheDocument();
    expect(screen.getByText(/usually an API key/i)).toBeInTheDocument();
  });

  // StrictMode runs a mount initializer twice and keeps the SECOND pass's
  // state. A read that consumed on every call returned null there, so the
  // notice never rendered in dev — invisible to a test that renders once.
  it("survives a repeated read within one page load", async () => {
    const { rememberImportedProfile, consumeImportedProfileNotice } =
      await loadFresh();
    rememberImportedProfile("Main hunt");

    expect(consumeImportedProfileNotice()).toBe("Main hunt");
    expect(consumeImportedProfileNotice()).toBe("Main hunt");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("stays quiet on the next page load", async () => {
    const first = await loadFresh();
    first.rememberImportedProfile("Main hunt");
    expect(first.consumeImportedProfileNotice()).toBe("Main hunt");

    const second = await loadFresh();
    const { container } = render(<second.ImportedProfileNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  // An import whose switch never happened must not explain itself later.
  it("ignores a stale notice", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ name: "Main hunt", at: Date.now() - 11 * 60_000 }),
    );
    const { ImportedProfileNotice } = await loadFresh();

    const { container } = render(<ImportedProfileNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores a malformed notice", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    const { ImportedProfileNotice } = await loadFresh();

    const { container } = render(<ImportedProfileNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  // localStorage throws in a private window; a cosmetic notice must not take
  // the wizard down with it.
  it("survives storage that throws", async () => {
    const { rememberImportedProfile, ImportedProfileNotice } =
      await loadFresh();
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });

    expect(() => rememberImportedProfile("Main hunt")).not.toThrow();
    const { container } = render(<ImportedProfileNotice />);
    expect(container).toBeEmptyDOMElement();

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
