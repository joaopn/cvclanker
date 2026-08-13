/**
 * What the API says about a provider's saved credential. The key itself has no
 * read surface: `apiKeyHint` is its first few characters, enough to tell a
 * saved key from an absent one and from a different one.
 */
export interface LlmProviderCredentialSummary {
  provider: string;
  apiKeyHint: string | null;
  baseUrl: string | null;
}
