/**
 * Repository for llm_provider_credentials — the API key and base URL for
 * providers OTHER than the configured one, so a provider can be called without
 * being made the app's provider first.
 *
 * The key is written and cleared but never read back over the API: callers get
 * a 4-character hint, the same shape the settings registry's `*Hint` fields
 * use, and the value itself only ever leaves through an LLM call.
 */

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index";

const { llmProviderCredentials } = schema;

export interface ProviderCredential {
  apiKey: string | null;
  baseUrl: string | null;
}

export interface ProviderCredentialSummary {
  provider: string;
  apiKeyHint: string | null;
  baseUrl: string | null;
}

/**
 * First few characters only, matching what `getEnvSettingsData` produces for
 * registry secrets so both render identically as `hint********`.
 */
function secretHint(value: string | null): string | null {
  if (!value) return null;
  const length = value.length > 4 ? 4 : Math.max(value.length - 1, 1);
  return value.slice(0, length);
}

export async function getProviderCredential(
  provider: string,
): Promise<ProviderCredential | null> {
  const [row] = await db
    .select({
      apiKey: llmProviderCredentials.apiKey,
      baseUrl: llmProviderCredentials.baseUrl,
    })
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.provider, provider));
  if (!row) return null;
  return { apiKey: row.apiKey ?? null, baseUrl: row.baseUrl ?? null };
}

export async function listProviderCredentials(): Promise<
  ProviderCredentialSummary[]
> {
  const rows = await db
    .select({
      provider: llmProviderCredentials.provider,
      apiKey: llmProviderCredentials.apiKey,
      baseUrl: llmProviderCredentials.baseUrl,
    })
    .from(llmProviderCredentials);
  return rows.map((row) => ({
    provider: row.provider,
    apiKeyHint: secretHint(row.apiKey ?? null),
    baseUrl: row.baseUrl ?? null,
  }));
}

/**
 * Write one provider's credential. A field left `undefined` keeps whatever is
 * stored, and an explicit `null` clears it — so saving a base URL cannot wipe a
 * key the form never displayed in the first place.
 */
export async function upsertProviderCredential(args: {
  provider: string;
  apiKey?: string | null;
  baseUrl?: string | null;
}): Promise<void> {
  const existing = await getProviderCredential(args.provider);
  const apiKey =
    args.apiKey === undefined ? (existing?.apiKey ?? null) : args.apiKey;
  const baseUrl =
    args.baseUrl === undefined ? (existing?.baseUrl ?? null) : args.baseUrl;

  await db
    .insert(llmProviderCredentials)
    .values({ provider: args.provider, apiKey, baseUrl })
    .onConflictDoUpdate({
      target: llmProviderCredentials.provider,
      set: { apiKey, baseUrl, updatedAt: new Date().toISOString() },
    });
}

export async function deleteProviderCredential(
  provider: string,
): Promise<void> {
  await db
    .delete(llmProviderCredentials)
    .where(eq(llmProviderCredentials.provider, provider));
}
