// @vitest-environment node
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LATEX_COMPILE_TIMEOUT_MS } from "@shared/settings-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLatexCompileTimeoutMs } from "./run-tectonic";

describe("resolveLatexCompileTimeoutMs", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.LATEX_COMPILE_TIMEOUT_MS;
    delete process.env.LATEX_COMPILE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LATEX_COMPILE_TIMEOUT_MS;
    } else {
      process.env.LATEX_COMPILE_TIMEOUT_MS = original;
    }
  });

  it("defaults to ten minutes when nothing is configured", () => {
    expect(resolveLatexCompileTimeoutMs()).toBe(
      DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
    );
    expect(DEFAULT_LATEX_COMPILE_TIMEOUT_MS).toBe(600_000);
  });

  it("reads the env value the setting syncs at boot and on save", () => {
    process.env.LATEX_COMPILE_TIMEOUT_MS = "900000";
    expect(resolveLatexCompileTimeoutMs()).toBe(900_000);
  });

  it("tolerates surrounding whitespace in the env value", () => {
    process.env.LATEX_COMPILE_TIMEOUT_MS = "  120000  ";
    expect(resolveLatexCompileTimeoutMs()).toBe(120_000);
  });

  it("falls back to the default on an unusable env value", () => {
    for (const raw of ["", "   ", "not-a-number", "0", "-1"]) {
      process.env.LATEX_COMPILE_TIMEOUT_MS = raw;
      expect(resolveLatexCompileTimeoutMs()).toBe(
        DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
      );
    }
  });

  it("lets an explicit per-call timeout win over both", () => {
    process.env.LATEX_COMPILE_TIMEOUT_MS = "900000";
    expect(resolveLatexCompileTimeoutMs(30_000)).toBe(30_000);
  });

  it("ignores a non-positive or non-finite explicit timeout", () => {
    expect(resolveLatexCompileTimeoutMs(0)).toBe(
      DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
    );
    expect(resolveLatexCompileTimeoutMs(Number.NaN)).toBe(
      DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
    );
  });
});

// The resolver above is only half the wiring: runTectonic has to actually arm
// the spawn deadline with it. Without this, reverting that one line to the old
// hardcoded 60_000 leaves the whole slice green — every other test that reaches
// this module mocks runTectonic itself.
describe("runTectonic deadline", () => {
  // Comfortably above process-spawn latency on a loaded box, and short enough
  // that the test costs about a second. The assertion is on the number the
  // error quotes, not on elapsed time, so this is not a timing race.
  const STUB_TIMEOUT_MS = 1_000;
  // A revert to the old hardcoded default would park here instead of rejecting;
  // failing at 15s beats hanging for 60.
  const TEST_TIMEOUT_MS = 15_000;

  let binDir: string;
  let savedBin: string | undefined;
  let savedTimeout: string | undefined;

  beforeEach(async () => {
    savedBin = process.env.TECTONIC_BIN;
    savedTimeout = process.env.LATEX_COMPILE_TIMEOUT_MS;
    binDir = await fs.mkdtemp(path.join(tmpdir(), "tectonic-stub-"));
    const stub = path.join(binDir, "tectonic-stub");
    // `exec` is load-bearing: without it the shell FORKS sleep, runTectonic's
    // SIGKILL reaches only the shell, and the orphan holds the stdio pipes
    // open — so `close` never fires and the handles outlive the test file.
    await fs.writeFile(stub, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    process.env.TECTONIC_BIN = stub;
  });

  afterEach(async () => {
    if (savedBin === undefined) delete process.env.TECTONIC_BIN;
    else process.env.TECTONIC_BIN = savedBin;
    if (savedTimeout === undefined) delete process.env.LATEX_COMPILE_TIMEOUT_MS;
    else process.env.LATEX_COMPILE_TIMEOUT_MS = savedTimeout;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it(
    "arms the spawn deadline from the configured timeout, not a hardcoded one",
    async () => {
      process.env.LATEX_COMPILE_TIMEOUT_MS = String(STUB_TIMEOUT_MS);
      // TECTONIC_BIN is captured at module load, so the module has to be
      // re-evaluated after the env is set.
      vi.resetModules();
      // Both bindings must come from the re-evaluated module: resetModules
      // gives it a fresh RunTectonicError class, so the statically imported
      // one would fail instanceof against an error this instance threw.
      const { runTectonic, RunTectonicError } = await import("./run-tectonic");

      const error = await runTectonic({
        renderedTex: "\\documentclass{article}",
      })
        .then(() => null)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunTectonicError);
      expect((error as InstanceType<typeof RunTectonicError>).code).toBe(
        "TIMEOUT",
      );
      // The message is built from the resolved deadline, so the number in it
      // IS the value runTectonic armed. Anchored, because a bare substring
      // match on the digits would also accept 10000 or 100000.
      expect((error as Error).message).toContain(`after ${STUB_TIMEOUT_MS} ms`);
    },
    TEST_TIMEOUT_MS,
  );
});
