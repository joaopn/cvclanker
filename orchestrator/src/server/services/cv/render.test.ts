// @vitest-environment node
import type { CvField } from "@shared/types";
import { describe, expect, it } from "vitest";
import { findUnreachableField, renderCv, RenderCvError } from "./render";

const SOURCE = `\\documentclass{article}
\\name{Ada Lovelace}
\\position{Engineer at ACME}
\\experience{Engineer at ACME}{2020 -- 2022}
\\experience{Engineer at Globex}{2022 -- 2024}
`;

const FIELDS: CvField[] = [
  { id: "basics.name", role: "name", value: "Ada Lovelace" },
  { id: "basics.position", role: "title", value: "Engineer at ACME" },
  { id: "experience.0.title", role: "title", value: "Engineer at ACME" },
  { id: "experience.0.dates", role: "date", value: "2020 -- 2022" },
  { id: "experience.1.title", role: "title", value: "Engineer at Globex" },
  { id: "experience.1.dates", role: "date", value: "2022 -- 2024" },
];

describe("renderCv", () => {
  it("returns the source byte-for-byte", () => {
    expect(renderCv(SOURCE)).toBe(SOURCE);
  });

  it("throws when the source contains a forbidden pattern", () => {
    expect(() => renderCv(`${SOURCE}\\write18{rm -rf /}\n`)).toThrow(
      RenderCvError,
    );
  });
});

describe("findUnreachableField", () => {
  it("returns null when every field is in document order", () => {
    expect(findUnreachableField(SOURCE, FIELDS)).toBeNull();
  });

  it("returns the index of the first out-of-order field", () => {
    const reordered = [...FIELDS];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    // After the swap, basics.position ("Engineer at ACME") is checked
    // first and found, advancing the cursor past "Ada Lovelace". The
    // subsequent "Ada Lovelace" lookup fails.
    expect(findUnreachableField(SOURCE, reordered)).toBe(1);
  });

  it("returns the index of a field whose value is absent from the source", () => {
    const fields: CvField[] = [
      ...FIELDS,
      { id: "extra", role: "other", value: "DOES_NOT_EXIST" },
    ];
    expect(findUnreachableField(SOURCE, fields)).toBe(FIELDS.length);
  });
});
