import { badRequest, conflict } from "@infra/errors";
import { hasCvDocuments } from "@server/repositories/cv-documents";
import type { SettingKey } from "@server/repositories/settings";
import * as settingsRepo from "@server/repositories/settings";
import { applyEnvValue, normalizeEnvInput } from "@server/services/envSettings";
import { settingsRegistry } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema";

export type DeferredSideEffect = never;

export type SettingsUpdateAction = {
  settingKey: SettingKey;
  persist: () => Promise<void>;
  sideEffect?: () => void | Promise<void>;
};

export type SettingsUpdateResult = {
  actions: SettingsUpdateAction[];
  deferredSideEffects: Set<DeferredSideEffect>;
};

export type SettingsUpdateContext = {
  input: UpdateSettingsInput;
};

export type SettingUpdateHandler<K extends keyof UpdateSettingsInput> = (args: {
  key: K;
  value: UpdateSettingsInput[K];
  context: SettingsUpdateContext;
}) => Promise<SettingsUpdateResult> | SettingsUpdateResult;

export type SettingsUpdatePlan = Record<string, never>;

const LEGACY_SETTINGS_TO_CLEAR_ON_UPDATE: Partial<
  Record<SettingKey, SettingKey[]>
> = {};

function result(
  args: {
    actions?: SettingsUpdateAction[];
    deferred?: DeferredSideEffect[];
  } = {},
): SettingsUpdateResult {
  return {
    actions: args.actions ?? [],
    deferredSideEffects: new Set(args.deferred ?? []),
  };
}

function persistAction(
  settingKey: SettingKey,
  value: string | null,
  sideEffect?: () => void | Promise<void>,
): SettingsUpdateAction {
  return {
    settingKey,
    persist: () => settingsRepo.setSetting(settingKey, value),
    sideEffect,
  };
}

export const settingsUpdateRegistry: Partial<{
  [K in keyof UpdateSettingsInput]: SettingUpdateHandler<K>;
}> = {};

for (const [key, def] of Object.entries(settingsRegistry)) {
  if (def.kind === "virtual") continue;

  const targetKey = key as SettingKey;
  const hasEnvKey = "envKey" in def && !!def.envKey;

  settingsUpdateRegistry[key as keyof UpdateSettingsInput] = ({ value }) => {
    let serialized: string | null;

    if ("serialize" in def) {
      serialized = def.serialize(value as never);
    } else {
      serialized = normalizeEnvInput(value as string);
    }

    const sideEffect = hasEnvKey
      ? () => {
          // biome-ignore lint/suspicious/noExplicitAny: def is constrained by kind
          applyEnvValue((def as any).envKey, serialized);
        }
      : undefined;

    const legacyKeysToClear =
      LEGACY_SETTINGS_TO_CLEAR_ON_UPDATE[targetKey]?.filter(
        (legacyKey) => legacyKey !== targetKey,
      ) ?? [];

    return result({
      actions: [
        persistAction(targetKey, serialized, sideEffect),
        ...legacyKeysToClear.map((legacyKey) => persistAction(legacyKey, null)),
      ],
    });
  };
}

// Write-once guard for cvSourceFormat: the CV substrate format is an
// IMMUTABLE per-User-Profile decision (word-cv design). This guard is the
// real server-side mechanism behind "server-managed" — the generic settings
// PATCH can write every registry key. Rejected writes throw during the
// collect phase, before ANY action of the batch persists.
//
// Once a value is stored, EVERY differing write is rejected — including a

// The scheduler's pause latch is SERVER-MANAGED and deliberately has exactly
// ONE clear path: `POST /api/schedules/resume`. The generic PATCH registers a
// handler for every non-virtual registry key, which made the latch both
// settable and clearable through `PATCH /api/settings` — so a safety mechanism
// whose whole job is "stop automatic runs until a human acknowledges this"
// could be lifted by a bulk settings write that knows nothing about
// scheduling. That is not a privilege escalation (both paths need the same
// auth), but it is the failure mode this codebase has already paid for once:
// a settings write that cleared state nobody meant it to touch.
//
// Refused outright rather than guarded conditionally. The tick and the resume
// route both write it through `settingsRepo.setSetting` directly, which does
// not go through this registry at all, so nothing legitimate is blocked.
settingsUpdateRegistry.schedulingPausedReason = async () => {
  throw badRequest(
    "Scheduling is paused and resumed through the Schedule tab; this setting cannot be written directly.",
  );
};

// null clear: clearing a stored "docx" is itself an effective-format flip
// (back to the "latex" default), and permitting clears would make the
// write-once rule two-step launderable (clear, then first-write the other
// value). While unset (effective "latex"), the first write may not change
// the effective format over existing CV documents: they were all accepted as
// LaTeX, and re-dispatching them as docx would misinterpret every row.
const genericCvSourceFormatHandler = settingsUpdateRegistry.cvSourceFormat;
settingsUpdateRegistry.cvSourceFormat = async ({ key, value, context }) => {
  const stored = await settingsRepo.getSetting("cvSourceFormat");

  if (stored !== null) {
    if (value !== stored) {
      throw conflict(
        "CV format is fixed per user profile once set; create a new user profile to use a different format.",
      );
    }
  } else if (value === "docx" && (await hasCvDocuments())) {
    throw conflict(
      "Cannot set the CV format to Word while CV documents already exist in this profile.",
    );
  }

  if (!genericCvSourceFormatHandler) {
    throw new Error("cvSourceFormat handler missing from settings registry");
  }
  return genericCvSourceFormatHandler({ key, value, context });
};
