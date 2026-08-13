import * as api from "@client/api";
import { ClaudeCodeCliPanel } from "@client/components/ClaudeCodeCliPanel";
import { CodexAuthPanel } from "@client/components/CodexAuthPanel";
import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { ModelValues } from "@client/pages/settings/types";
import {
  formatSecretHint,
  getLlmProviderConfig,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  type LlmProviderId,
  supportsLlmModelSuggestions,
} from "@client/pages/settings/utils";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
  getDefaultModelForProvider,
} from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Controller, useFormContext } from "react-hook-form";
import { SearchableDropdown } from "@/components/ui/searchable-dropdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

// Radix forbids an empty item value, so both "unset" states ride a sentinel
// that maps back to null — null is what clears the override.
const PREFILTER_SAME_PROVIDER = "same-as-above";
const PREFILTER_DEFAULT_EFFORT = "cli-default";

type ModelSettingsSectionProps = {
  values: ModelValues;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

// Radix SelectItem forbids an empty-string value, so "use the CLI default"
// (stored as null) rides this sentinel in the effort dropdown.
const CLI_DEFAULT_EFFORT = "cli-default";

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

export const ModelSettingsSection: React.FC<ModelSettingsSectionProps> = ({
  values,
  isLoading,
  isSaving,
  layoutMode,
}) => {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const {
    effective,
    default: defaultModel,
    llmProvider,
    llmBaseUrl,
    llmApiKeyHint,
    claudeCodeOauthTokenHint,
  } = values;

  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors, dirtyFields },
  } = useFormContext<UpdateSettingsInput>();

  const selectedProvider = watch("llmProvider") || llmProvider || "openrouter";
  const previousProviderRef = useRef(selectedProvider);
  const providerConfig = getLlmProviderConfig(selectedProvider);
  const { showApiKey, showBaseUrl } = providerConfig;
  const isCodexProvider = providerConfig.normalizedProvider === "codex";
  const isClaudeCodeProvider =
    providerConfig.normalizedProvider === "claude_code";

  const llmBaseUrlValue = watch("llmBaseUrl");
  const llmApiKeyValue = watch("llmApiKey") ?? "";
  const modelValue = watch("model") ?? "";
  const modelScorerValue = watch("modelScorer") ?? "";
  const modelTailoringValue = watch("modelTailoring") ?? "";
  const providerDefaultModel = getDefaultModelForProvider(
    selectedProvider,
    selectedProvider === llmProvider ? defaultModel : undefined,
  );
  const deferredProvider = useDeferredValue(selectedProvider);
  const deferredBaseUrl = useDeferredValue(llmBaseUrlValue ?? "");
  const deferredApiKey = useDeferredValue(llmApiKeyValue);
  const supportsModelSuggestions =
    supportsLlmModelSuggestions(selectedProvider);
  const hasAvailableApiKey = showApiKey
    ? Boolean(deferredApiKey.trim() || llmApiKeyHint)
    : true;

  useEffect(() => {
    if (showBaseUrl) return;
    if (llmBaseUrlValue) {
      setValue("llmBaseUrl", "", { shouldDirty: true });
    }
  }, [setValue, showBaseUrl, llmBaseUrlValue]);

  useEffect(() => {
    if (previousProviderRef.current === selectedProvider) {
      return;
    }

    previousProviderRef.current = selectedProvider;
    if (!dirtyFields.llmProvider) {
      return;
    }

    setValue("model", "", { shouldDirty: true });
    setValue("modelScorer", "", { shouldDirty: true });
    setValue("modelTailoring", "", { shouldDirty: true });
  }, [dirtyFields.llmProvider, selectedProvider, setValue]);

  useEffect(() => {
    if (!supportsModelSuggestions) {
      setAvailableModels([]);
      setModelsError(null);
      setIsLoadingModels(false);
      return;
    }

    if (!hasAvailableApiKey) {
      setAvailableModels([]);
      setModelsError(null);
      setIsLoadingModels(false);
      return;
    }

    let cancelled = false;
    setIsLoadingModels(true);
    setModelsError(null);

    void api
      .getLlmModels({
        provider: deferredProvider,
        baseUrl: showBaseUrl ? deferredBaseUrl.trim() || undefined : undefined,
        apiKey: showApiKey ? deferredApiKey.trim() || undefined : undefined,
      })
      .then((models) => {
        if (cancelled) return;
        setAvailableModels(models);
        setModelsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setAvailableModels([]);
        setModelsError(
          error instanceof Error ? error.message : "Failed to load models.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingModels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    deferredApiKey,
    deferredBaseUrl,
    deferredProvider,
    hasAvailableApiKey,
    showApiKey,
    showBaseUrl,
    supportsModelSuggestions,
  ]);

  const keyHint = formatSecretHint(llmApiKeyHint);
  const claudeCodeTokenHint = formatSecretHint(claudeCodeOauthTokenHint);

  const keyText = showApiKey ? keyHint || "Not set" : "Not required";
  const resolvedBaseUrl = llmBaseUrlValue?.trim() || llmBaseUrl || "-";
  const selectedDefaultModel = modelValue.trim();
  const previewDefaultModel =
    selectedDefaultModel || effective || providerDefaultModel || "-";
  const selectedScoringModel = modelScorerValue.trim();
  const selectedTailoringModel = modelTailoringValue.trim();
  const scoringModel = selectedScoringModel || previewDefaultModel;
  const tailoringModel = selectedTailoringModel || previewDefaultModel;
  const modelHelper = supportsModelSuggestions
    ? !hasAvailableApiKey
      ? `Add or save a ${providerConfig.label} API key to load available models.`
      : isLoadingModels
        ? "Loading available models..."
        : modelsError
          ? modelsError
          : availableModels.length > 0
            ? "Choose from the available text-generation models."
            : "No text-generation models were returned."
    : `Type the exact model name manually, or leave blank to use the ${providerConfig.label} default model.`;
  const defaultModelOptions = buildModelOptions({
    models: availableModels,
    emptyLabel: `Use ${providerConfig.label} default`,
    emptyValue: "",
    fallbackValue: modelValue.trim(),
  });
  const scoringModelOptions = buildModelOptions({
    models: availableModels,
    emptyLabel: "Inherit default model",
    emptyValue: "",
    fallbackValue: modelScorerValue.trim(),
  });
  const tailoringModelOptions = buildModelOptions({
    models: availableModels,
    emptyLabel: "Inherit default model",
    emptyValue: "",
    fallbackValue: modelTailoringValue.trim(),
  });

  return (
    <SettingsSectionFrame mode={layoutMode} title="Model" value="model">
      <div className="space-y-4">
        <div className="space-y-4">
          <div className="text-sm font-medium">LLM Provider</div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="llmProvider" className="text-sm font-medium">
                Provider
              </label>
              <Controller
                name="llmProvider"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? ""}
                    onValueChange={(value) => field.onChange(value)}
                    disabled={isLoading || isSaving}
                  >
                    <SelectTrigger id="llmProvider">
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
              {errors.llmProvider?.message && (
                <p className="text-xs text-destructive">
                  {errors.llmProvider.message as string}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Used for scoring, tailoring, and extraction.
              </p>
              <p className="text-xs text-muted-foreground">
                {providerConfig.providerHint}
              </p>
              {isCodexProvider ? (
                <CodexAuthPanel isBusy={isLoading || isSaving} />
              ) : null}
              {isClaudeCodeProvider ? (
                <ClaudeCodeCliPanel isBusy={isLoading || isSaving} />
              ) : null}
            </div>
            {showBaseUrl && (
              <SettingsInput
                label="LLM base URL"
                inputProps={register("llmBaseUrl")}
                placeholder={providerConfig.baseUrlPlaceholder}
                disabled={isLoading || isSaving}
                error={errors.llmBaseUrl?.message as string | undefined}
                helper={providerConfig.baseUrlHelper}
                current={resolvedBaseUrl}
              />
            )}
            {showApiKey && (
              <SettingsInput
                label="LLM API key"
                inputProps={register("llmApiKey")}
                type="password"
                placeholder="Enter new key"
                disabled={isLoading || isSaving}
                error={errors.llmApiKey?.message as string | undefined}
                helper={renderKeyHelper(
                  providerConfig.keyHelperText,
                  providerConfig.keyHelperHref,
                  Boolean(keyHint),
                )}
                current={keyHint}
              />
            )}
            {isClaudeCodeProvider && (
              <SettingsInput
                label="Claude Code OAuth token"
                inputProps={register("claudeCodeOauthToken")}
                type="password"
                placeholder="Enter new token"
                disabled={isLoading || isSaving}
                error={
                  errors.claudeCodeOauthToken?.message as string | undefined
                }
                helper={renderKeyHelper(
                  "Mint one with `claude setup-token`. Leave blank to use CLAUDE_CODE_OAUTH_TOKEN from the environment",
                  null,
                  Boolean(claudeCodeTokenHint),
                )}
                current={claudeCodeTokenHint}
              />
            )}
            {isClaudeCodeProvider && (
              <div className="space-y-2">
                <label
                  htmlFor="claudeCodeEffort"
                  className="text-sm font-medium"
                >
                  Reasoning effort
                </label>
                <Controller
                  name="claudeCodeEffort"
                  control={control}
                  render={({ field }) => (
                    <Select
                      value={field.value ?? CLI_DEFAULT_EFFORT}
                      onValueChange={(value) =>
                        field.onChange(
                          value === CLI_DEFAULT_EFFORT ? null : value,
                        )
                      }
                      disabled={isLoading || isSaving}
                    >
                      <SelectTrigger id="claudeCodeEffort">
                        <SelectValue placeholder="CLI default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={CLI_DEFAULT_EFFORT}>
                          CLI default
                        </SelectItem>
                        {CLAUDE_CODE_EFFORT_LEVELS.map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Higher effort thinks longer per call: better judgment, slower
                  and more usage. Applies to every task (scoring, tailoring,
                  chat). CLI default defers to the CLI — or to a
                  CLAUDE_CODE_EFFORT environment baseline when the server sets
                  one.
                </p>
              </div>
            )}
          </div>
        </div>

        <Separator />

        {supportsModelSuggestions ? (
          <div className="space-y-2">
            <label htmlFor="model" className="text-sm font-medium">
              Default model
            </label>
            <Controller
              name="model"
              control={control}
              render={({ field }) => (
                <SearchableDropdown
                  inputId="model"
                  value={field.value ?? ""}
                  options={defaultModelOptions}
                  onValueChange={field.onChange}
                  placeholder={providerDefaultModel || "Select a model"}
                  searchPlaceholder="Search models..."
                  emptyText="No models found."
                  ariaLabel="Default model"
                  disabled={isLoading || isSaving || isLoadingModels}
                  triggerClassName="h-9 w-full justify-between rounded-md border border-input bg-transparent px-3 text-sm font-normal shadow-sm"
                  contentClassName="w-[var(--radix-popover-trigger-width)] border-border bg-popover p-0"
                  listClassName="max-h-64"
                />
              )}
            />
            {errors.model?.message && (
              <p className="text-xs text-destructive">
                {errors.model.message as string}
              </p>
            )}
            <div className="text-xs text-muted-foreground">{modelHelper}</div>
            <div className="text-xs text-muted-foreground">
              Current: <span className="font-mono">{previewDefaultModel}</span>
            </div>
          </div>
        ) : (
          <SettingsInput
            label="Default model"
            inputProps={register("model")}
            placeholder={providerDefaultModel}
            disabled={isLoading || isSaving}
            error={errors.model?.message as string | undefined}
            helper={modelHelper}
            current={previewDefaultModel}
          />
        )}

        <Separator />

        <div className="space-y-4">
          <div className="text-sm font-medium">Task-Specific Overrides</div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {supportsModelSuggestions ? (
              <>
                <div className="space-y-2">
                  <label htmlFor="modelScorer" className="text-sm font-medium">
                    Scoring Model
                  </label>
                  <Controller
                    name="modelScorer"
                    control={control}
                    render={({ field }) => (
                      <SearchableDropdown
                        inputId="modelScorer"
                        value={field.value ?? ""}
                        options={scoringModelOptions}
                        onValueChange={field.onChange}
                        placeholder={
                          previewDefaultModel || "Inherit default model"
                        }
                        searchPlaceholder="Search models..."
                        emptyText="No models found."
                        ariaLabel="Scoring Model"
                        disabled={isLoading || isSaving || isLoadingModels}
                        triggerClassName="h-9 w-full justify-between rounded-md border border-input bg-transparent px-3 text-sm font-normal shadow-sm"
                        contentClassName="w-[var(--radix-popover-trigger-width)] border-border bg-popover p-0"
                        listClassName="max-h-64"
                      />
                    )}
                  />
                  {errors.modelScorer?.message && (
                    <p className="text-xs text-destructive">
                      {errors.modelScorer.message as string}
                    </p>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Current: <span className="font-mono">{scoringModel}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="modelTailoring"
                    className="text-sm font-medium"
                  >
                    Tailoring Model
                  </label>
                  <Controller
                    name="modelTailoring"
                    control={control}
                    render={({ field }) => (
                      <SearchableDropdown
                        inputId="modelTailoring"
                        value={field.value ?? ""}
                        options={tailoringModelOptions}
                        onValueChange={field.onChange}
                        placeholder={
                          previewDefaultModel || "Inherit default model"
                        }
                        searchPlaceholder="Search models..."
                        emptyText="No models found."
                        ariaLabel="Tailoring Model"
                        disabled={isLoading || isSaving || isLoadingModels}
                        triggerClassName="h-9 w-full justify-between rounded-md border border-input bg-transparent px-3 text-sm font-normal shadow-sm"
                        contentClassName="w-[var(--radix-popover-trigger-width)] border-border bg-popover p-0"
                        listClassName="max-h-64"
                      />
                    )}
                  />
                  {errors.modelTailoring?.message && (
                    <p className="text-xs text-destructive">
                      {errors.modelTailoring.message as string}
                    </p>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Current: <span className="font-mono">{tailoringModel}</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <SettingsInput
                  label="Scoring Model"
                  inputProps={register("modelScorer")}
                  placeholder={previewDefaultModel || "inherit"}
                  disabled={isLoading || isSaving}
                  error={errors.modelScorer?.message as string | undefined}
                  current={scoringModel}
                />

                <SettingsInput
                  label="Tailoring Model"
                  inputProps={register("modelTailoring")}
                  placeholder={previewDefaultModel || "inherit"}
                  disabled={isLoading || isSaving}
                  error={errors.modelTailoring?.message as string | undefined}
                  current={tailoringModel}
                />
              </>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">Two-stage scoring</div>
            <p className="text-xs text-muted-foreground">
              Screen each newly discovered job with a cheap model first, and
              send only the ones it does not call a bad fit to the scoring model
              above. The prompt is unchanged, so the scoring model is still free
              to call them bad. Leave the model empty to turn this off.
            </p>
          </div>

          <SettingsInput
            label="Pre-filter model"
            inputProps={register("scorerPrefilterModel")}
            placeholder="empty = off"
            disabled={isLoading || isSaving}
            error={errors.scorerPrefilterModel?.message as string | undefined}
            current={values.prefilterModel || "off"}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                htmlFor="scorerPrefilterProvider"
                className="text-sm font-medium"
              >
                Pre-filter provider
              </label>
              <Controller
                name="scorerPrefilterProvider"
                control={control}
                render={({ field }) => (
                  <Select
                    // Radix forbids an empty item value, so "same as the app's"
                    // rides a sentinel that maps back to null.
                    value={field.value ?? PREFILTER_SAME_PROVIDER}
                    onValueChange={(value) =>
                      field.onChange(
                        value === PREFILTER_SAME_PROVIDER
                          ? null
                          : (value as LlmProviderId),
                      )
                    }
                    disabled={isLoading || isSaving}
                  >
                    <SelectTrigger
                      id="scorerPrefilterProvider"
                      aria-label="Pre-filter provider"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PREFILTER_SAME_PROVIDER}>
                        Same as above
                      </SelectItem>
                      {LLM_PROVIDERS.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {LLM_PROVIDER_LABELS[entry]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                A different provider needs its key under Provider Credentials —
                the one above is never lent to it. Without a usable key the
                screen is skipped and every job goes to the scoring model.
              </p>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="scorerPrefilterEffort"
                className="text-sm font-medium"
              >
                Pre-filter effort
              </label>
              <Controller
                name="scorerPrefilterEffort"
                control={control}
                render={({ field }) => (
                  <Select
                    value={field.value ?? PREFILTER_DEFAULT_EFFORT}
                    onValueChange={(value) =>
                      field.onChange(
                        value === PREFILTER_DEFAULT_EFFORT
                          ? null
                          : (value as ClaudeCodeEffortLevel),
                      )
                    }
                    disabled={isLoading || isSaving}
                  >
                    <SelectTrigger
                      id="scorerPrefilterEffort"
                      aria-label="Pre-filter effort"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PREFILTER_DEFAULT_EFFORT}>
                        CLI default
                      </SelectItem>
                      {CLAUDE_CODE_EFFORT_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                Claude Code only; ignored by every other provider.
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Only the pipeline's scoring step uses the screen — Recalculate
            match, a rescrape and a pasted URL always go to the scoring model,
            so they stay a second opinion on anything it removed. A job it calls
            a bad fit says so in its reason. If Auto-skip is also set to bad
            fits, the cheap model can send a job straight to Skipped on its own.
          </p>
        </div>

        <Separator />

        <div className="space-y-3 text-sm">
          <div className="text-xs text-muted-foreground">Resolved config</div>
          <div className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[160px_1fr]">
            <div className="text-muted-foreground">Provider</div>
            <div className="font-mono">{selectedProvider || "-"}</div>

            <div className="text-muted-foreground">Base URL</div>
            <div className="font-mono">{resolvedBaseUrl}</div>

            <div className="text-muted-foreground">API key</div>
            <div className="font-mono">{keyText}</div>

            <div className="text-muted-foreground">Default model</div>
            <div className="font-mono">{previewDefaultModel}</div>

            <div className="text-muted-foreground">Scoring model</div>
            <div className="font-mono">
              {selectedScoringModel ? scoringModel : "inherits"}
            </div>

            <div className="text-muted-foreground">Tailoring model</div>
            <div className="font-mono">
              {selectedTailoringModel ? tailoringModel : "inherits"}
            </div>

            <div className="text-muted-foreground">Pre-filter</div>
            <div className="font-mono">
              {values.prefilterModel
                ? [
                    values.prefilterProvider ?? selectedProvider,
                    values.prefilterModel,
                    values.prefilterEffort,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "off"}
            </div>
          </div>
        </div>
      </div>
    </SettingsSectionFrame>
  );
};

function buildModelOptions(input: {
  models: string[];
  emptyLabel: string;
  emptyValue: string;
  fallbackValue?: string;
}) {
  const options = [
    {
      value: input.emptyValue,
      label: input.emptyLabel,
      searchText: input.emptyLabel,
    },
    ...input.models.map((model) => ({
      value: model,
      label: model,
      searchText: model,
    })),
  ];

  const fallbackValue = input.fallbackValue?.trim();
  if (
    fallbackValue &&
    !options.some((option) => option.value === fallbackValue)
  ) {
    options.unshift({
      value: fallbackValue,
      label: fallbackValue,
      searchText: `${fallbackValue} custom`,
    });
  }

  return options;
}
