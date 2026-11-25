import * as api from "@client/api";
import { useUpdateSettingsMutation } from "@client/hooks/queries/useSettingsMutation";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import {
  LLM_PROVIDER_LABELS,
  type LlmProviderId,
} from "@client/pages/settings/utils";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
} from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema";
import type { ChatModelTask } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TASK_LABELS: Record<ChatModelTask, string> = {
  default: "Default",
  scoring: "Scoring",
  tailoring: "Tailoring",
  prefilter: "Pre-filter",
};

const DEFAULT_EFFORT = "default";

const providerLabel = (provider: string) =>
  LLM_PROVIDER_LABELS[provider as LlmProviderId] ?? provider;

const modelLabel = (model: string) => model || "CLI default";

const choiceKey = (provider: string, model: string) =>
  JSON.stringify([provider, model]);

export const ChatModelMenus: React.FC<{ disabled: boolean }> = ({
  disabled,
}) => {
  const modelsQuery = useQuery({
    queryKey: queryKeys.chat.models(),
    queryFn: () => api.getChatModels(),
  });
  const mutation = useUpdateSettingsMutation();
  const data = modelsQuery.data;
  const locked = disabled || mutation.isPending || !data;

  const save = (payload: UpdateSettingsInput) =>
    mutation.mutate(payload, {
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Failed to save the setting",
        ),
    });

  const pending = mutation.isPending ? mutation.variables : undefined;
  let choice = data?.current ?? null;
  if (data && pending?.chatProvider) {
    choice = {
      ...data.current,
      provider: pending.chatProvider,
      model: pending.chatModel ?? "",
    };
  }
  const effort: ClaudeCodeEffortLevel | null =
    pending && "chatEffort" in pending
      ? (pending.chatEffort ?? null)
      : (data?.current.effort ?? null);
  const showEffort =
    !!data && !!choice && data.supportsEffort.includes(choice.provider);
  const label = choice
    ? `${providerLabel(choice.provider)} · ${modelLabel(choice.model)}`
    : "Model";

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void modelsQuery.refetch();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={locked}
            aria-label="Chat model"
            title={label}
            className="h-7 min-w-0 max-w-full gap-1 px-2"
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="z-[70]">
          {data?.providers.map((option) => (
            <DropdownMenuSub key={option.provider}>
              <DropdownMenuSubTrigger>
                {providerLabel(option.provider)}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="z-[70] max-w-80">
                <DropdownMenuRadioGroup
                  value={choice ? choiceKey(choice.provider, choice.model) : ""}
                >
                  {option.models.map((model) => (
                    <DropdownMenuRadioItem
                      key={model.model}
                      value={choiceKey(option.provider, model.model)}
                      onSelect={() =>
                        save({
                          chatProvider: option.provider,
                          chatModel: model.model || null,
                        })
                      }
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">
                          {modelLabel(model.model)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {model.tasks
                            .map((task) => TASK_LABELS[task])
                            .join(", ")}
                        </span>
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {showEffort && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              aria-label="Chat effort"
              className="h-7 shrink-0 gap-1 px-2"
            >
              Effort: {effort ?? "Default"}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="z-[70]">
            <DropdownMenuRadioGroup value={effort ?? DEFAULT_EFFORT}>
              <DropdownMenuRadioItem
                value={DEFAULT_EFFORT}
                onSelect={() => save({ chatEffort: null })}
              >
                Default
              </DropdownMenuRadioItem>
              {CLAUDE_CODE_EFFORT_LEVELS.map((level) => (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  onSelect={() => save({ chatEffort: level })}
                >
                  {level}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
};
