import { describe, expect, it } from "vitest";
import {
  getMatchingWritingStylePresetId,
  resolveWritingStyleDraft,
} from "./constants";

describe("settings constants", () => {
  it("uses effective values instead of registry defaults for blank drafts", () => {
    expect(
      resolveWritingStyleDraft({
        values: {
          tone: "",
          formality: "",
          constraints: " ",
          doNotUse: null,
        },
        defaults: {
          tone: { effective: "friendly", default: "professional" },
          formality: { effective: "low", default: "medium" },
          constraints: {
            effective: "Keep the response warm, approachable, and confident.",
            default: "",
          },
          doNotUse: { effective: "synergy", default: "" },
          coverLetterInstructions: { effective: "", default: "" },
          languageMode: { effective: "manual", default: "manual" },
          manualLanguage: { effective: "english", default: "english" },
        },
      }),
    ).toEqual({
      tone: "friendly",
      formality: "low",
      constraints: "Keep the response warm, approachable, and confident.",
      doNotUse: "synergy",
    });
  });

  it("detects matching presets from a resolved draft", () => {
    expect(
      getMatchingWritingStylePresetId({
        tone: "friendly",
        formality: "low",
        constraints: "Keep the response warm, approachable, and confident.",
        doNotUse: "",
      }),
    ).toBe("friendly");

    expect(
      getMatchingWritingStylePresetId({
        tone: "friendly",
        formality: "low",
        constraints: "Custom note",
        doNotUse: "",
      }),
    ).toBeNull();
  });
});
