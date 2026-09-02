import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import {
  getLlmProviderConfig,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  type LlmProviderId,
} from "@client/pages/settings/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ProviderCredentialsSectionProps = {
  layoutMode?: "accordion" | "panel";
  /** Replaces the Settings-specific blurb; the wizard needs its own framing. */
  description?: React.ReactNode;
  /**
   * Drop the configured provider from the list. The onboarding step already has
   * a key field for it, and two inputs for one provider read as a conflict.
   */
  excludeConfigured?: boolean;
  /** The configured provider, whose credential still lives in Models. */
  configuredProvider?: string | null;
};

/**
 * Providers that authenticate through a key or a URL. `claude_code` and `codex`
 * are absent on purpose: they carry their own login, and offering them a key
 * field would imply one is needed.
 */
const CREDENTIAL_PROVIDERS = LLM_PROVIDERS.filter(
  (provider) => provider !== "claude_code" && provider !== "codex",
);

const CREDENTIALS_QUERY_KEY = ["llm-provider-credentials"] as const;

type DraftState = { apiKey: string; baseUrl: string };

export const ProviderCredentialsSection: React.FC<
  ProviderCredentialsSectionProps
> = ({
  layoutMode,
  configuredProvider,
  description,
  excludeConfigured = false,
}) => {
  const queryClient = useQueryClient();
  const { data: credentials, isLoading } = useQuery({
    queryKey: CREDENTIALS_QUERY_KEY,
    queryFn: api.getLlmProviderCredentials,
  });
  const [drafts, setDrafts] = useState<Partial<Record<string, DraftState>>>({});

  const saveMutation = useMutation({
    mutationFn: (args: {
      provider: string;
      input: { apiKey?: string | null; baseUrl?: string | null };
    }) => api.saveLlmProviderCredential(args.provider, args.input),
    onSuccess: (next, args) => {
      queryClient.setQueryData(CREDENTIALS_QUERY_KEY, next);
      // Only the key box is cleared: it was never showing the stored value, so
      // leaving what was typed would look like it had not saved.
      setDrafts((prev) => ({
        ...prev,
        [args.provider]: {
          apiKey: "",
          baseUrl: prev[args.provider]?.baseUrl ?? "",
        },
      }));
      toast.success("Credential saved.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const clearMutation = useMutation({
    mutationFn: api.deleteLlmProviderCredential,
    onSuccess: (next, provider) => {
      queryClient.setQueryData(CREDENTIALS_QUERY_KEY, next);
      setDrafts((prev) => ({
        ...prev,
        [provider]: { apiKey: "", baseUrl: "" },
      }));
      toast.success("Credential cleared.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isBusy = saveMutation.isPending || clearMutation.isPending;

  const visibleProviders = excludeConfigured
    ? CREDENTIAL_PROVIDERS.filter((provider) => provider !== configuredProvider)
    : CREDENTIAL_PROVIDERS;

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      value="provider-credentials"
      title="Provider Credentials"
    >
      {description ?? (
        <p className="text-sm text-muted-foreground">
          Keys for providers other than the one the app runs on, so a model can
          be benchmarked without switching provider first. The configured
          provider's own key stays in Models. Keys are never shown again after
          saving — a credential recorded here is used in place of the configured
          one for that provider, and is never lent to any other.
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          {visibleProviders.map((provider: LlmProviderId) => {
            const config = getLlmProviderConfig(provider);
            const saved = credentials?.find(
              (entry) => entry.provider === provider,
            );
            const draft = drafts[provider] ?? {
              apiKey: "",
              baseUrl: saved?.baseUrl ?? "",
            };
            const isConfigured = provider === configuredProvider;
            const saveThisProvider = () =>
              saveMutation.mutate({
                provider,
                input: {
                  // An untouched key box is an omission, not a clear.
                  ...(draft.apiKey.trim()
                    ? { apiKey: draft.apiKey.trim() }
                    : {}),
                  ...(config.showBaseUrl
                    ? { baseUrl: draft.baseUrl.trim() || null }
                    : {}),
                },
              });
            // The onboarding wizard hosts this inside its <form>, where Enter
            // would otherwise implicitly submit and run the wizard's own save
            // instead of this card's — writing settings the user never touched.
            // preventDefault is unconditional (that is what suppresses the
            // submit); only the write is gated.
            const hasSomethingToSend =
              draft.apiKey.trim() !== "" ||
              (config.showBaseUrl && draft.baseUrl.trim() !== "");
            const saveOnEnter = (event: React.KeyboardEvent) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              // An empty payload is accepted by the route and inserts a row of
              // nulls — a "Credential saved." toast for nothing, and a Clear
              // button beside a provider that has no credential. The Save
              // button keeps that path (emptying a base URL is a real clear);
              // Enter must not reach it by accident from an untouched card.
              if (!isBusy && hasSomethingToSend) saveThisProvider();
            };

            return (
              <div key={provider} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    {LLM_PROVIDER_LABELS[provider]}
                    {isConfigured ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        currently configured
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {saved?.apiKeyHint
                      ? `${saved.apiKeyHint}********`
                      : "No key saved"}
                  </span>
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  {config.showApiKey ? (
                    <div className="min-w-48 flex-1 space-y-1">
                      <Label
                        htmlFor={`credential-key-${provider}`}
                        className="text-xs"
                      >
                        API key
                      </Label>
                      <Input
                        id={`credential-key-${provider}`}
                        type="password"
                        autoComplete="off"
                        onKeyDown={saveOnEnter}
                        placeholder={
                          saved?.apiKeyHint ? "Replace saved key" : "Not set"
                        }
                        value={draft.apiKey}
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [provider]: {
                              ...draft,
                              apiKey: event.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  ) : null}

                  {config.showBaseUrl ? (
                    <div className="min-w-48 flex-1 space-y-1">
                      <Label
                        htmlFor={`credential-url-${provider}`}
                        className="text-xs"
                      >
                        Base URL
                      </Label>
                      <Input
                        id={`credential-url-${provider}`}
                        onKeyDown={saveOnEnter}
                        placeholder={config.baseUrlPlaceholder}
                        value={draft.baseUrl}
                        onChange={(event) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [provider]: {
                              ...draft,
                              baseUrl: event.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isBusy}
                      onClick={saveThisProvider}
                    >
                      Save
                    </Button>
                    {saved ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => clearMutation.mutate(provider)}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSectionFrame>
  );
};
