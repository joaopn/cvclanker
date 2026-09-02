const STORAGE_KEY = "cvclanker.importedProfileNotice";
/** An import that never completed its switch must not explain itself an hour
 * later, on an unrelated visit to the wizard. */
const MAX_AGE_MS = 10 * 60_000;

/**
 * A database import restarts the server and reloads the page, so the component
 * that started it cannot report what happened. The name is parked here first
 * and read once after the reload.
 *
 * Every access is guarded: localStorage throws in a private window, and a
 * failure here must never take the onboarding wizard down with it.
 */
export function rememberImportedProfile(name: string): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ name, at: Date.now() }),
    );
  } catch {
    // A missing notice is cosmetic; the import itself already succeeded.
  }
}

// Memoised for the life of the page, which is what makes the read safe from
// render: StrictMode runs a mount initializer TWICE, so a directly destructive
// read consumes the value on the first pass and returns null on the second —
// the pass whose state survives. That silently swallowed the notice in dev.
let cached: string | null | undefined;

/** Read the pending notice, clearing it so a later page load stays quiet. */
export function consumeImportedProfileNotice(): string | null {
  if (cached === undefined) cached = readAndClear();
  return cached;
}

function readAndClear(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    window.localStorage.removeItem(STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { name, at } = parsed as { name?: unknown; at?: unknown };
    if (typeof name !== "string" || name.length === 0) return null;
    if (typeof at !== "number" || Date.now() - at > MAX_AGE_MS) return null;
    return name;
  } catch {
    return null;
  }
}
