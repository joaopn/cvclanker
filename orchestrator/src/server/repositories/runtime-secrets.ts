/**
 * Repository for runtime_secrets — server-internal state: the JWT signing
 * secret, the agent (MCP) token's digest, and that token's access switches.
 * Deliberately not settings-registry rows: registry values echo through
 * GET /api/settings, and the two secrets must have no read surface (the
 * switches are shown by GET /api/mcp-access).
 */

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index";

const { runtimeSecrets } = schema;

/** The connection, or a transaction opened on it. */
type RuntimeSecretsExecutor = Pick<typeof db, "select" | "insert" | "delete">;

export interface RuntimeSecretRecord {
  value: string;
  createdAt: string;
}

export async function getRuntimeSecret(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: runtimeSecrets.value })
    .from(runtimeSecrets)
    .where(eq(runtimeSecrets.key, key));
  return row?.value ?? null;
}

export function getRuntimeSecretRecord(
  key: string,
  executor: RuntimeSecretsExecutor = db,
): RuntimeSecretRecord | null {
  const row = executor
    .select({
      value: runtimeSecrets.value,
      createdAt: runtimeSecrets.createdAt,
    })
    .from(runtimeSecrets)
    .where(eq(runtimeSecrets.key, key))
    .get();
  return row ?? null;
}

/**
 * Insert-if-absent: concurrent callers converge on the first writer's value
 * (the caller re-reads after this to pick up the winner).
 */
export async function insertRuntimeSecretIfAbsent(
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(runtimeSecrets)
    .values({ key, value })
    .onConflictDoNothing();
}

/** Sets the value and restamps `created_at`, whether or not the key existed. */
export function upsertRuntimeSecret(
  key: string,
  value: string,
  executor: RuntimeSecretsExecutor = db,
): void {
  const createdAt = new Date().toISOString();
  executor
    .insert(runtimeSecrets)
    .values({ key, value, createdAt })
    .onConflictDoUpdate({
      target: runtimeSecrets.key,
      set: { value, createdAt },
    })
    .run();
}

export function deleteRuntimeSecrets(
  keys: readonly string[],
  executor: RuntimeSecretsExecutor = db,
): void {
  executor
    .delete(runtimeSecrets)
    .where(inArray(runtimeSecrets.key, [...keys]))
    .run();
}
