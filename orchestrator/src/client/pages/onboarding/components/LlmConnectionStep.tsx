import { CodexAuthPanel } from "@client/components/CodexAuthPanel";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import {
  getLlmProviderConfig,
  LLM_PROVIDER_LABELS,
  type LlmProviderId,
} from "@client/pages/settings/utils";
import { CheckCircle2, Loader2 } from "lucide-react";
import type React from "react";
import { type Control, Controller } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ConfiguredLlmProvider,
  LlmStepModel,
  OnboardingFormData,
  ValidationState,
} from "../types";

const CHECKING_COPY =
  "(this spawns the provider's CLI or calls its API and can take a few seconds)";

function renderKeyHelper(helperText: string, helperHref: string | null) {
  return helperHref ? (
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
  );
}

const AppProviderStatus: React.FC<{
  isValidating: boolean;
  validation: ValidationState;
}> = ({ isValidating, validation }) => {
  if (isValidating) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking the connection… {CHECKING_COPY}
      </div>
    );
  }
  if (!validation.hydrated) return null;
  if (validation.valid) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-status-good-text">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connection verified
      </div>
    );
  }
  return (
    <div className="text-xs text-destructive">
      {validation.message || "The connection check failed."}
    </div>
  );
};

const ConfiguredProviderRow: React.FC<{
  row: ConfiguredLlmProvider;
  isBusy: boolean;
  isValidating: boolean;
  validation: ValidationState;
  onRemove: (provider: LlmProviderId) => Promise<void>;
}> = ({ row, isBusy, isValidating, validation, onRemove }) => {
  const label = LLM_PROVIDER_LABELS[row.provider];
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {label}
          {row.usedByApp ? (
            <Badge variant="secondary">Used by the app</Badge>
          ) : null}
        </div>
        {row.details.length > 0 ? (
          <div className="break-all text-xs text-muted-foreground">
            {row.details.join(" · ")}
          </div>
        ) : null}
        {row.usedByApp ? (
          <AppProviderStatus
            isValidating={isValidating}
            validation={validation}
          />
        ) : null}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isBusy}
        aria-label={`Remove ${label}`}
        onClick={() => void onRemove(row.provider)}
      >
        Remove
      </Button>
    </li>
  );
};

export const LlmConnectionStep: React.FC<
  LlmStepModel & {
    control: Control<OnboardingFormData>;
    isBusy: boolean;
  }
> = ({
  control,
  isBusy,
  addProvider,
  addableProviders,
  addMakesAppProvider,
  addDisabledReason,
  canTest,
  testDisabledReason,
  claudeCodeTokenHint,
  codexSignedIn,
  configuredProviders,
  isTesting,
  isValidating,
  testResult,
  validation,
  onSelectProvider,
  onTest,
  onAdd,
  onRemove,
  onCodexStatusChange,
}) => {
  const providerConfig = addProvider ? getLlmProviderConfig(addProvider) : null;
  const isCodexProvider = addProvider === "codex";
  const isClaudeCodeProvider = addProvider === "claude_code";

  // The step sits inside the wizard's <form>, where Enter would implicitly
  // submit and run the footer's action instead. preventDefault is
  // unconditional; Enter then runs Test.
  const testOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!isBusy && canTest) void onTest();
  };

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="llm-add-provider"
        className="space-y-5 rounded-lg border border-border/60 p-4"
      >
        <h3 id="llm-add-provider" className="text-sm font-medium">
          Add provider
        </h3>

        {addProvider === null || providerConfig === null ? (
          <p className="text-sm text-muted-foreground">
            Every provider has been added.
          </p>
        ) : (
          <>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="llmProvider" className="text-sm font-medium">
                  Provider
                </label>
                <Select
                  value={addProvider}
                  onValueChange={(value) =>
                    onSelectProvider(value as LlmProviderId)
                  }
                  disabled={isBusy}
                >
                  <SelectTrigger id="llmProvider" className="h-10">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {addableProviders.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {LLM_PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {providerConfig.providerHint}
                </p>
                {isCodexProvider ? (
                  <CodexAuthPanel
                    // The panel keeps its own status; remount it when the
                    // sign-in changes elsewhere (Remove on the Codex row).
                    key={String(codexSignedIn)}
                    isBusy={isBusy}
                    onStatusChange={onCodexStatusChange}
                  />
                ) : null}
              </div>

              {providerConfig.showBaseUrl ? (
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
                        onKeyDown: testOnEnter,
                      }}
                      placeholder={providerConfig.baseUrlPlaceholder}
                      helper={providerConfig.baseUrlHelper}
                      disabled={isBusy}
                    />
                  )}
                />
              ) : null}
            </div>

            {providerConfig.showApiKey ? (
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
                      onKeyDown: testOnEnter,
                      autoComplete: "off",
                    }}
                    type="password"
                    placeholder="Paste a key"
                    helper={renderKeyHelper(
                      providerConfig.keyHelperText,
                      providerConfig.keyHelperHref,
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
                      onKeyDown: testOnEnter,
                      autoComplete: "off",
                    }}
                    type="password"
                    placeholder="Paste a token"
                    helper={
                      claudeCodeTokenHint
                        ? "Mint one with `claude setup-token`. Leave blank to keep the saved token. Test saves the token first: the CLI reads it from the server."
                        : "Mint one with `claude setup-token`. Test saves the token first: the CLI reads it from the server."
                    }
                    disabled={isBusy}
                  />
                )}
              />
            ) : isCodexProvider ? null : (
              <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-4 text-sm text-muted-foreground">
                No API key is required for this provider.
              </div>
            )}

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isBusy || !canTest}
                  onClick={() => void onTest()}
                >
                  Test
                </Button>
                <Button
                  type="button"
                  disabled={isBusy || addDisabledReason !== null}
                  onClick={() => void onAdd()}
                >
                  Add
                </Button>
              </div>
              {testDisabledReason ? (
                <p className="text-xs text-muted-foreground">
                  {testDisabledReason}
                </p>
              ) : null}
              {addDisabledReason ? (
                <p className="text-xs text-muted-foreground">
                  {addDisabledReason}
                </p>
              ) : addMakesAppProvider ? (
                <p className="text-xs text-muted-foreground">
                  Add saves without testing. The first provider you add is the
                  one the app runs on.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Add saves without testing.
                </p>
              )}
            </div>

            {isTesting ? (
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Testing the connection… {CHECKING_COPY}
              </div>
            ) : testResult ? (
              testResult.valid ? (
                <div className="flex items-start gap-3 rounded-lg border border-status-good/20 bg-status-good/10 px-4 py-3 text-sm text-status-good-text">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    {LLM_PROVIDER_LABELS[testResult.provider]}: connection
                    works.
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {LLM_PROVIDER_LABELS[testResult.provider]}:{" "}
                  {testResult.message || "the connection test failed."}
                </div>
              )
            ) : null}
          </>
        )}
      </section>

      <section
        aria-labelledby="llm-configured-providers"
        className="space-y-3 rounded-lg border border-border/60 p-4"
      >
        <h3 id="llm-configured-providers" className="text-sm font-medium">
          Configured providers
        </h3>
        {configuredProviders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No provider yet — add one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {configuredProviders.map((row) => (
              <ConfiguredProviderRow
                key={row.provider}
                row={row}
                isBusy={isBusy}
                isValidating={isValidating}
                validation={validation}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
