/**
 * CLI entry for the keyword-score repair. Exists so the module holding the
 * logic has no module-scope side effect and is therefore safe to import from a
 * test — and so the entry point never depends on a guard that could silently
 * decline to run, leaving the user thinking the repair happened.
 */

import { main } from "./clear-keyword-scores";

try {
  main();
} catch (error) {
  console.error("Failed to clear keyword scores:", error);
  process.exitCode = 1;
}
