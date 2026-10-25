// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderCv, RenderCvError } from "./render";

const SOURCE = `\\documentclass{article}
\\name{Ada Lovelace}
\\position{Engineer at ACME}
\\experience{Engineer at ACME}{2020 -- 2022}
\\experience{Engineer at Globex}{2022 -- 2024}
`;

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
