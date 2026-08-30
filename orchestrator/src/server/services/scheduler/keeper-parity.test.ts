// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The review wizard and the automatic resolver must decide keepers with the
 * SAME code, not with two copies that agree today.
 *
 * A resolver that picked a different keeper would close the row the user was
 * about to keep, and there is no server-side undo — the wizard's undo is a
 * client snapshot. So this pins that neither side has quietly grown its own
 * copy back.
 */
describe("duplicate keeper parity", () => {
  const read = (relative: string) =>
    readFileSync(join(process.cwd(), "src", relative), "utf8");

  it("has exactly one definition of the keeper heuristic", () => {
    const shared = readFileSync(
      join(process.cwd(), "..", "shared", "src", "duplicate-resolution.ts"),
      "utf8",
    );
    expect(shared).toContain("export function chooseKeeper");
    expect(shared).toContain("export function losersOf");

    const modal = read("client/pages/orchestrator/DuplicateReviewModal.tsx");
    // The modal may USE them, but must not define them.
    expect(modal).toContain('from "@shared/duplicate-resolution"');
    expect(modal).not.toMatch(/function chooseKeeper\b/);
    expect(modal).not.toMatch(/function losersOf\b/);
    expect(modal).not.toContain("STATUS_KEEPER_RANK");
  });

  it("has the resolver reading the shared heuristic too", () => {
    const resolver = read("server/services/scheduler/resolve-duplicates.ts");
    expect(resolver).toContain('from "@shared/duplicate-resolution"');
    expect(resolver).not.toMatch(/function chooseKeeper\b/);
  });
});
