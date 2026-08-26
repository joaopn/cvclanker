import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LATEX_COMPILE_TIMEOUT_MS } from "@shared/settings-registry";
import AdmZip from "adm-zip";

const TECTONIC_BIN = process.env.TECTONIC_BIN ?? "tectonic";

/**
 * The deadline one tectonic spawn gets, in ms.
 *
 * Read from process.env rather than the settings table because runTectonic is
 * called from routes, the pipeline and the gated upload loop alike: the
 * `latexCompileTimeoutMs` setting carries envKey LATEX_COMPILE_TIMEOUT_MS, so
 * the registry already syncs the stored value into process.env at boot and on
 * save — no round trip, no staleness, and no timeout threaded through ten call
 * sites. An explicit per-call `timeoutMs` still wins.
 */
export function resolveLatexCompileTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const raw = process.env.LATEX_COMPILE_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_LATEX_COMPILE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LATEX_COMPILE_TIMEOUT_MS;
  }
  return parsed;
}

export interface RunTectonicArgs {
  renderedTex: string;
  /** Original archive bytes — extracted into the temp dir so referenced assets resolve. */
  archive?: Uint8Array;
  /** Entrypoint name (path inside the archive). Defaults to "main.tex". */
  entrypoint?: string;
  /** Timeout in ms. Default: the `latexCompileTimeoutMs` setting. */
  timeoutMs?: number;
}

export interface RunTectonicResult {
  pdf: Uint8Array;
  log: string;
}

export class RunTectonicError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(message: string, code: string, stderr: string) {
    super(message);
    this.name = "RunTectonicError";
    this.code = code;
    this.stderr = stderr;
  }
}

export async function runTectonic(
  args: RunTectonicArgs,
): Promise<RunTectonicResult> {
  const entrypointName = args.entrypoint ?? "main.tex";
  const timeoutMs = resolveLatexCompileTimeoutMs(args.timeoutMs);

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "cv-tectonic-"));
  try {
    if (args.archive && looksLikeZip(args.archive)) {
      const zip = new AdmZip(Buffer.from(args.archive));
      zip.extractAllTo(tempDir, /* overwrite */ true);
    }

    // Tectonic resolves `.cls` / `.sty` by looking next to the .tex it's
    // compiling. When the caller provided an explicit `entrypoint`, that
    // path is already relative to the zip root (e.g.
    // `awesome-cv-template/main.tex`), so resolve it directly against
    // `tempDir`. When no entrypoint is given we fall back to the
    // `pickWorkDir` heuristic — used by the 5d render-preview path which
    // doesn't carry an entrypoint through.
    const entrypointPath = args.entrypoint
      ? path.join(tempDir, entrypointName)
      : path.join(await pickWorkDir(tempDir), entrypointName);
    await fs.mkdir(path.dirname(entrypointPath), { recursive: true });
    await fs.writeFile(entrypointPath, args.renderedTex, "utf8");
    const workDir = path.dirname(entrypointPath);

    const stderr = await spawnTectonic(entrypointPath, workDir, timeoutMs);

    const pdfPath = path.join(
      path.dirname(entrypointPath),
      `${path.basename(entrypointName, ".tex")}.pdf`,
    );
    const pdf = await fs.readFile(pdfPath);
    return { pdf: new Uint8Array(pdf), log: stderr };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Pick the directory inside the extracted tree where the rendered tex should
 * be written and tectonic should run. Heuristic:
 *
 *   1. If a `.cls` or `.sty` file exists, return the directory containing
 *      it (deepest match wins on tie).
 *   2. Else if the tempDir contains exactly one subdirectory and no
 *      sibling files, descend into it (handles the common
 *      `archive-name/...` wrapper).
 *   3. Else fall back to the tempDir root.
 */
async function pickWorkDir(tempDir: string): Promise<string> {
  const classPath = await findFirst(tempDir, (name) =>
    name.endsWith(".cls") || name.endsWith(".sty"),
  );
  if (classPath) return path.dirname(classPath);

  const entries = await fs.readdir(tempDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(tempDir, entries[0].name);
  }
  return tempDir;
}

async function findFirst(
  root: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (predicate(entry.name)) return full;
    }
  }
  return null;
}

function looksLikeZip(buf: Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function spawnTectonic(
  entrypointPath: string,
  outdir: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `-Z continue-on-errors` matches Overleaf's `pdflatex --interaction=nonstopmode`
    // semantics: tectonic keeps going on potentially-recoverable errors
    // (e.g. macro-argument paragraph breaks, missing braces) and emits a
    // PDF even if the source has minor LaTeX issues. The pdftotext
    // content-equivalence diff downstream is the real safety net — if
    // the bug visibly distorts the output, the templated render diverges
    // and the upload is rejected anyway.
    const child = spawn(
      TECTONIC_BIN,
      [
        "--keep-logs",
        "--outdir",
        path.dirname(entrypointPath),
        "--chatter",
        "minimal",
        "-Z",
        "continue-on-errors",
        entrypointPath,
      ],
      { cwd: outdir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", () => {
      // tectonic writes progress to stderr; stdout is normally empty.
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new RunTectonicError(
          `tectonic timed out after ${timeoutMs} ms.`,
          "TIMEOUT",
          stderr,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new RunTectonicError(
          `Failed to spawn tectonic: ${err.message}`,
          "SPAWN_FAILED",
          stderr,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stderr);
        return;
      }
      reject(
        new RunTectonicError(
          `tectonic exited with code ${code}.`,
          "NON_ZERO_EXIT",
          stderr,
        ),
      );
    });
  });
}
