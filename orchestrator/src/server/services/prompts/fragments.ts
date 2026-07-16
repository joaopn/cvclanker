import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "../../../../package.json"),
      resolve(here, "../../../package.json"),
      resolve(process.cwd(), "package.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw) as { name?: string; version?: string };
        if (parsed.name === "cvclanker-orchestrator" && parsed.version) {
          return parsed.version;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // ignore
  }
  return "unknown";
}

export const APP_VERSION = readPackageVersion();

/**
 * Default values merged into every loadPrompt() call before the caller's
 * vars. The caller can override any of these by passing the same key.
 *
 * `outputLanguage` and `writingStyle` are listed for documentation but
 * default to empty — call sites resolve them from the writing-style
 * settings + profile and pass them in explicitly.
 */
export function getDefaultPromptVars(): Record<string, string> {
  return {
    appVersion: APP_VERSION,
    outputLanguage: "",
    writingStyle: "",
  };
}
