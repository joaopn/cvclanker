/**
 * Create or edit one run schedule.
 *
 * The source picker is grouped Free scrapers / Apify actors (paid) off
 * `run-options`' own `kind`, so an Apify schedule is a deliberate act rather
 * than something a user backs into.
 */

import type { RunOptionSource, RunSchedule } from "@shared/types";
import type React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export interface ScheduleDraft {
  name: string;
  enabled: boolean;
  cadenceKind: RunSchedule["cadenceKind"];
  intervalHours: number;
  timeOfDay: string;
  daysOfWeek: number[] | null;
  profileIds: string[];
  sourceMode: RunSchedule["sourceMode"];
  sources: string[];
  providerInstanceIds: string[];
  autoResolveDuplicates: boolean;
  enableAutoTailoring: boolean | null;
}

export const emptyDraft = (): ScheduleDraft => ({
  name: "",
  enabled: true,
  cadenceKind: "daily_at",
  intervalHours: 6,
  timeOfDay: "06:00",
  daysOfWeek: null,
  profileIds: [],
  sourceMode: "free_only",
  sources: [],
  providerInstanceIds: [],
  autoResolveDuplicates: false,
  enableAutoTailoring: null,
});

export const draftFrom = (schedule: RunSchedule): ScheduleDraft => ({
  name: schedule.name,
  enabled: schedule.enabled,
  cadenceKind: schedule.cadenceKind,
  intervalHours: schedule.intervalHours ?? 6,
  timeOfDay: schedule.timeOfDay ?? "06:00",
  daysOfWeek: schedule.daysOfWeek,
  profileIds: schedule.profileIds,
  sourceMode: schedule.sourceMode,
  sources: schedule.sources ?? [],
  providerInstanceIds: schedule.providerInstanceIds ?? [],
  autoResolveDuplicates: schedule.autoResolveDuplicates,
  enableAutoTailoring: schedule.enableAutoTailoring,
});

interface Props {
  open: boolean;
  draft: ScheduleDraft;
  timeZone: string;
  profiles: Array<{ id: string; name: string }>;
  runOptionSources: RunOptionSource[];
  saving: boolean;
  onChange: (draft: ScheduleDraft) => void;
  onSave: () => void;
  onClose: () => void;
}

export const ScheduleEditorDialog: React.FC<Props> = ({
  open,
  draft,
  timeZone,
  profiles,
  runOptionSources,
  saving,
  onChange,
  onSave,
  onClose,
}) => {
  const set = <K extends keyof ScheduleDraft>(
    key: K,
    value: ScheduleDraft[K],
  ) => onChange({ ...draft, [key]: value });

  // Same mapping the Run menu uses: an extractor task contributes its PLATFORM
  // ids to `sources`, while a provider instance contributes the instance id
  // (the part of its key after the colon) to `providerInstanceIds`.
  const freeSources = runOptionSources.filter(
    (source) => source.kind === "extractor" && source.platforms.length > 0,
  );
  const paidSources = runOptionSources.filter(
    (source) => source.kind === "provider_instance",
  );
  const instanceIdOf = (key: string) => key.slice(key.indexOf(":") + 1);
  const platformsSelected = (platforms: readonly string[]) =>
    platforms.length > 0 && platforms.every((id) => draft.sources.includes(id));
  // "Whatever each profile selects" is the mode most likely to spend: a
  // profile's own pins routinely include Apify actors, and warning only on the
  // explicit picker would stay quiet exactly where the cost is unexamined.
  const usesPaid =
    draft.sourceMode === "profile" ||
    (draft.sourceMode === "custom" && draft.providerInstanceIds.length > 0);

  const toggleDay = (day: number) => {
    const current = draft.daysOfWeek ?? WEEKDAYS.map((d) => d.value);
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort();
    // Every day ticked is the same as no mask at all, and storing it as null
    // keeps "every day" one concept rather than two.
    set("daysOfWeek", next.length === WEEKDAYS.length ? null : next);
  };

  const dayChecked = (day: number) =>
    draft.daysOfWeek === null || draft.daysOfWeek.includes(day);

  const noDaysPicked =
    draft.daysOfWeek !== null && draft.daysOfWeek.length === 0;
  const canSave =
    draft.name.trim().length > 0 &&
    draft.profileIds.length > 0 &&
    !noDaysPicked &&
    (draft.sourceMode !== "custom" ||
      draft.sources.length > 0 ||
      draft.providerInstanceIds.length > 0);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {draft.name ? "Edit schedule" : "New schedule"}
          </DialogTitle>
          <DialogDescription>Times are read in {timeZone}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              value={draft.name}
              placeholder="Nightly free scrape"
              onChange={(event) => set("name", event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Cadence</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={draft.cadenceKind}
                onValueChange={(value) =>
                  set("cadenceKind", value as RunSchedule["cadenceKind"])
                }
              >
                <SelectTrigger className="w-[190px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily_at">Daily at</SelectItem>
                  <SelectItem value="every_n_hours">Every N hours</SelectItem>
                </SelectContent>
              </Select>

              {draft.cadenceKind === "daily_at" ? (
                <Input
                  type="time"
                  className="w-[130px]"
                  value={draft.timeOfDay}
                  onChange={(event) => set("timeOfDay", event.target.value)}
                />
              ) : (
                <Input
                  type="number"
                  min={1}
                  max={8760}
                  className="w-[110px]"
                  value={draft.intervalHours}
                  onChange={(event) =>
                    set("intervalHours", Number(event.target.value))
                  }
                />
              )}
              <span className="text-sm text-muted-foreground">{timeZone}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Days</Label>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((day) => (
                <div key={day.value} className="flex items-center gap-1.5">
                  <Checkbox
                    id={`day-${day.value}`}
                    checked={dayChecked(day.value)}
                    onCheckedChange={() => toggleDay(day.value)}
                  />
                  <Label
                    htmlFor={`day-${day.value}`}
                    className="text-sm font-normal"
                  >
                    {day.label}
                  </Label>
                </div>
              ))}
            </div>
            {noDaysPicked && (
              <p className="text-sm text-destructive">
                Pick at least one day, or the schedule can never run.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Search profiles, in run order</Label>
            <div className="flex flex-col gap-2">
              {profiles.map((profile) => (
                <div key={profile.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`profile-${profile.id}`}
                    checked={draft.profileIds.includes(profile.id)}
                    onCheckedChange={(checked) =>
                      set(
                        "profileIds",
                        checked
                          ? [...draft.profileIds, profile.id]
                          : draft.profileIds.filter((id) => id !== profile.id),
                      )
                    }
                  />
                  <Label
                    htmlFor={`profile-${profile.id}`}
                    className="text-sm font-normal"
                  >
                    {profile.name}
                  </Label>
                </div>
              ))}
              {profiles.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No search profiles yet — create one first.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Sources</Label>
            <Select
              value={draft.sourceMode}
              onValueChange={(value) =>
                set("sourceMode", value as RunSchedule["sourceMode"])
              }
            >
              <SelectTrigger className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="profile">
                  Whatever each profile selects
                </SelectItem>
                <SelectItem value="free_only">Free scrapers only</SelectItem>
                <SelectItem value="custom">Pick sources</SelectItem>
              </SelectContent>
            </Select>
            {draft.sourceMode === "free_only" && (
              <p className="text-sm text-muted-foreground">
                Resolved when the schedule runs, so a board added later is
                picked up without editing this.
              </p>
            )}
            {draft.sourceMode === "custom" && (
              <div className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Free scrapers
                  </p>
                  {freeSources.map((source) => (
                    <div key={source.key} className="flex items-center gap-2">
                      <Checkbox
                        id={`src-${source.key}`}
                        checked={platformsSelected(source.platforms)}
                        onCheckedChange={(checked) =>
                          set(
                            "sources",
                            checked
                              ? [
                                  ...new Set([
                                    ...draft.sources,
                                    ...source.platforms,
                                  ]),
                                ]
                              : draft.sources.filter(
                                  (id) =>
                                    !(source.platforms as string[]).includes(
                                      id,
                                    ),
                                ),
                          )
                        }
                      />
                      <Label
                        htmlFor={`src-${source.key}`}
                        className="text-sm font-normal"
                      >
                        {source.label}
                      </Label>
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Apify actors (paid)
                  </p>
                  {paidSources.map((source) => {
                    const instanceId = instanceIdOf(source.key);
                    return (
                      <div key={source.key} className="flex items-center gap-2">
                        <Checkbox
                          id={`inst-${instanceId}`}
                          checked={draft.providerInstanceIds.includes(
                            instanceId,
                          )}
                          onCheckedChange={(checked) =>
                            set(
                              "providerInstanceIds",
                              checked
                                ? [...draft.providerInstanceIds, instanceId]
                                : draft.providerInstanceIds.filter(
                                    (id) => id !== instanceId,
                                  ),
                            )
                          }
                        />
                        <Label
                          htmlFor={`inst-${instanceId}`}
                          className="text-sm font-normal"
                        >
                          {source.label}
                        </Label>
                      </div>
                    );
                  })}
                  {paidSources.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No Apify actors configured.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="auto-resolve-duplicates"
                checked={draft.autoResolveDuplicates}
                onCheckedChange={(checked) =>
                  set("autoResolveDuplicates", checked === true)
                }
              />
              <Label
                htmlFor="auto-resolve-duplicates"
                className="text-sm font-normal"
              >
                Close duplicate copies automatically after each run
              </Label>
            </div>
            {draft.autoResolveDuplicates && (
              <p className="pl-6 text-xs text-muted-foreground">
                Only groups whose copies agree on the job title. Anything
                needing a judgement call still waits for you in Review
                duplicates, and there is no undo — closed copies are reopened by
                hand from the Closed tab.
              </p>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="auto-tailor"
                checked={draft.enableAutoTailoring === true}
                onCheckedChange={(checked) =>
                  set("enableAutoTailoring", checked === true ? true : null)
                }
              />
              <Label htmlFor="auto-tailor" className="text-sm font-normal">
                Tailor top matches automatically
              </Label>
            </div>
          </div>

          {usesPaid && (
            <p className="rounded-md border border-status-warn/30 bg-status-warn/10 p-3 text-sm text-status-warn-text">
              {draft.sourceMode === "profile"
                ? "If any of these profiles pins an Apify actor, this schedule runs it on every fire. Apify actors bill per result."
                : "This schedule runs paid Apify actors on every fire. They bill per result."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave || saving} onClick={onSave}>
            {saving ? "Saving…" : "Save schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
