import { CodexAuthPanel } from "@client/components/CodexAuthPanel";
import { ProviderCredentialsSection } from "@client/pages/settings/components/ProviderCredentialsSection";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import {
  getLlmProviderConfig,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  type LlmProviderId,
} from "@client/pages/settings/utils";
import { Loader2 } from "lucide-react";
import type React from "react";
import { type Control, Controller } from "react-hook-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OnboardingFormData, ValidationState } from "../types";
import { InlineValidation } from "./InlineValidation";

function renderKeyHelper(
  helperText: string,
  helperHref: string | null,
  keepSavedKey: boolean,
) {
  return (
    <>
      {helperHref ? (
        <a
          href={helperHref}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
        >
          {helperText}
        </a>
      ) : (
        helperText
      )}
      {keepSavedKey ? ". Leave blank to keep the saved key." : null}
    </>
  );
}

export const LlmConnectionStep: React.FC<{
  control: Control<OnboardingFormData>;
  isBusy: boolean;
  isValidatingLlm: boolean;
  llmKeyHint: string | null;
  claudeCodeTokenHint: string | null;
  selectedProvider: LlmProviderId;
  validation: ValidationState;
}> = ({
  control,
  isBusy,
  isValidatingLlm,
  llmKeyHint,
  claudeCodeTokenHint,
  selectedProvider,
  validation,
}) => {
  const providerConfig = getLlmProviderConfig(selectedProvider);
  const { showApiKey, showBaseUrl } = providerConfig;
  const isCodexProvider = providerConfig.normalizedProvider === "codex";
  const isClaudeCodeProvider =
    providerConfig.normalizedProvider === "claude_code";

  return (
    <div className="space-y-6">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="llmProvider" className="text-sm font-medium">
            Provider
          </label>
          <Controller
            name="llmProvider"
            control={control}
            render={({ field }) => (
              <Select
                value={selectedProvider}
                onValueChange={(value) => field.onChange(value)}
                disabled={isBusy}
              >
                <SelectTrigger id="llmProvider" className="h-10">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {LLM_PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-sm text-muted-foreground">
            {providerConfig.providerHint}
          </p>
          {isCodexProvider ? <CodexAuthPanel isBusy={isBusy} /> : null}
        </div>

        {showBaseUrl ? (
          <Controller
            name="llmBaseUrl"
            control={control}
            render={({ field }) => (
              <SettingsInput
                label="Base URL"
                inputProps={{
                  name: "llmBaseUrl",
                  value: field.value,
                  onChange: field.onChange,
                }}
                placeholder={providerConfig.baseUrlPlaceholder}
                helper={providerConfig.baseUrlHelper}
                disabled={isBusy}
              />
            )}
          />
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {showApiKey ? (
          <Controller
            name="llmApiKey"
            control={control}
            render={({ field }) => (
              <SettingsInput
                label="API key"
                inputProps={{
                  name: "llmApiKey",
                  value: field.value,
                  onChange: field.onChange,
                }}
                type="password"
                placeholder="Paste a new key"
                helper={renderKeyHelper(
                  providerConfig.keyHelperText,
                  providerConfig.keyHelperHref,
                  Boolean(llmKeyHint),
                )}
                disabled={isBusy}
              />
            )}
          />
        ) : isClaudeCodeProvider ? (
          <Controller
            name="claudeCodeOauthToken"
            control={control}
            render={({ field }) => (
              <SettingsInput
                label="Claude Code OAuth token"
                inputProps={{
                  name: "claudeCodeOauthToken",
                  value: field.value,
                  onChange: field.onChange,
                }}
                type="password"
                placeholder="Paste a new token"
                helper={renderKeyHelper(
                  "Mint one with `claude setup-token`. Leave blank to use CLAUDE_CODE_OAUTH_TOKEN from the environment",
                  null,
                  Boolean(claudeCodeTokenHint),
                )}
                disabled={isBusy}
              />
            )}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
            No API key is required for this provider.
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 p-4">
        <div className="text-sm font-medium">Other providers (optional)</div>
        <ProviderCredentialsSection
          layoutMode="panel"
          configuredProvider={selectedProvider}
          excludeConfigured
          description={
            <p className="text-sm text-muted-foreground">
              Save a key for any other provider you use — each one saves on its
              own, and you can add more later in Settings. These travel with a
              database export that includes secrets, so a migration carries
              every provider rather than just the one above. A key saved here
              takes precedence for its provider, so if you later switch the app
              to one of them, manage its key in Settings rather than above.
            </p>
          }
        />
      </div>

      {isValidatingLlm ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking the connection… (this spawns the provider's CLI or calls its
          API and can take a few seconds)
        </div>
      ) : (
        <InlineValidation
          state={validation}
          successMessage={`${providerConfig.label} connection verified.`}
        />
      )}
    </div>
  );
};
