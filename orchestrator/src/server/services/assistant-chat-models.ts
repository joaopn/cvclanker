import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
} from "@shared/settings-registry";
import type {
  ChatModelChoice,
  ChatModelsResponse,
  ChatModelTask,
  ChatProviderOption,
} from "@shared/types";
import {
  normalizeProviderId,
  resolveProviderCall,
} from "./llm/provider-credentials";
import { resolveLlmModel } from "./modelSelection";
import { getEffectiveSettings } from "./settings";

const SUPPORTS_EFFORT = ["claude_code"];

export interface ResolvedChatModels {
  response: ChatModelsResponse;
  /** True when `current` is the user's saved choice, false for the fallback. */
  stored: boolean;
}

function parseEffort(
  value: string | null | undefined,
): ClaudeCodeEffortLevel | null {
  return value &&
    (CLAUDE_CODE_EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as ClaudeCodeEffortLevel)
    : null;
}

export async function resolveChatModels(): Promise<ResolvedChatModels> {
  const settings = await getEffectiveSettings();
  const main = (await resolveProviderCall(null)).provider;
  const providers: ChatProviderOption[] = [];

  const add = (
    provider: ChatProviderOption["provider"],
    model: string,
    task: ChatModelTask,
  ) => {
    let entry = providers.find((option) => option.provider === provider);
    if (!entry) {
      entry = { provider, models: [] };
      providers.push(entry);
    }
    const existing = entry.models.find((option) => option.model === model);
    if (existing) existing.tasks.push(task);
    else entry.models.push({ model, tasks: [task] });
  };

  const [defaultModel, scoringModel, tailoringModel] = await Promise.all([
    resolveLlmModel("default"),
    resolveLlmModel("scoring"),
    resolveLlmModel("tailoring"),
  ]);
  add(main, defaultModel, "default");
  add(main, scoringModel, "scoring");
  add(main, tailoringModel, "tailoring");

  const prefilterModel = settings.scorerPrefilterModel.value?.trim();
  if (prefilterModel) {
    const prefilter = await resolveProviderCall(
      settings.scorerPrefilterProvider.value,
    );
    if (!prefilter.missingReason) {
      add(prefilter.provider, prefilterModel, "prefilter");
    }
  }

  const storedProvider = normalizeProviderId(settings.chatProvider.value);
  const storedModel = settings.chatModel.value ?? "";
  let provider: string = main;
  let model = tailoringModel;
  let stored = false;
  if (
    storedProvider &&
    providers.some(
      (option) =>
        option.provider === storedProvider &&
        option.models.some((model) => model.model === storedModel),
    )
  ) {
    provider = storedProvider;
    model = storedModel;
    stored = true;
  }
  const current: ChatModelChoice = {
    provider,
    model,
    effort: SUPPORTS_EFFORT.includes(provider)
      ? parseEffort(settings.chatEffort.value)
      : null,
  };

  return {
    response: { providers, current, supportsEffort: [...SUPPORTS_EFFORT] },
    stored,
  };
}

export async function listChatModels(): Promise<ChatModelsResponse> {
  return (await resolveChatModels()).response;
}
