import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { isRemoteProfileOnlyExtractor } from "@shared/extractors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface AllProfilesPinControlProps {
  kind: "extractor" | "provider_instance";
  sourceId: string;
  /** What the toasts and the confirm call the source. */
  displayName: string;
  /** The SAVED User-Profile enablement, not the card's unsaved tickbox. */
  enabledHere: boolean;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Pin this source into, or unpin it from, every Search Profile in one press,
 * instead of opening each profile's editor in turn.
 */
export function AllProfilesPinControl({
  kind,
  sourceId,
  displayName,
  enabledHere,
}: AllProfilesPinControlProps) {
  const queryClient = useQueryClient();
  // Which press is waiting on the confirm. Disable always asks; Enable asks
  // only for an Apify actor, where one press can start paid scrapes on every
  // profile (and every schedule that follows a profile's own pins).
  const [confirming, setConfirming] = useState<"enable" | "disable">("disable");
  // Separate from `confirming` so the dialog's text does not flip while it
  // animates closed.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const askToConfirm = (action: "enable" | "disable") => {
    setConfirming(action);
    setConfirmOpen(true);
  };
  const profilesQuery = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: api.getProfiles,
  });

  const field =
    kind === "extractor" ? "enabledSourceIds" : "providerInstanceIds";
  const allProfiles = profilesQuery.data?.profiles ?? [];
  const pins = (profile: (typeof allProfiles)[number]) =>
    profile.config[field].includes(sourceId);
  // A remote-only board is never added to a non-remote profile (the server
  // skips those, as the profile editor does), so Enable counts only remote
  // profiles. Disable counts every profile: auto-filled new profiles pin
  // remote-only boards too, and those stale pins must stay clearable here.
  const remoteOnly =
    kind === "extractor" && isRemoteProfileOnlyExtractor(sourceId);
  const eligible = allProfiles.filter(
    (profile) => !remoteOnly || profile.config.remoteProfile,
  );
  const total = eligible.length;
  const pinnedCount = eligible.filter(pins).length;
  const removableCount = allProfiles.filter(pins).length;

  const mutation = useMutation({
    mutationFn: (pinned: boolean) =>
      api.setSourcePinOnAllProfiles({ kind, sourceId, pinned }),
    onSuccess: (result, pinned) => {
      const changed = result.changed.length;
      if (changed === 0 && result.skipped.length === 0) {
        toast.info(
          pinned
            ? `${displayName} was already enabled in every profile`
            : `${displayName} was not enabled in any profile`,
        );
      } else if (changed > 0) {
        toast.success(
          pinned
            ? `Enabled ${displayName} in ${plural(changed, "profile")}`
            : `Disabled ${displayName} in ${plural(changed, "profile")}`,
        );
      }
      if (result.skipped.length > 0) {
        toast.info(
          `Not added to ${result.skipped.map((profile) => profile.name).join(", ")}: ${displayName} only runs on a remote profile.`,
        );
      }
      if (result.empty.length > 0) {
        toast.warning(
          `${result.empty.map((profile) => profile.name).join(", ")} now ${result.empty.length === 1 ? "has" : "have"} no sources, so ${result.empty.length === 1 ? "its" : "their"} runs will fail until one is enabled.`,
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });
      // The Run menu and the schedule editor list each profile's pinned
      // sources from here.
      queryClient.invalidateQueries({ queryKey: ["run-options"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Update failed");
    },
  });

  const busy =
    mutation.isPending || profilesQuery.isLoading || profilesQuery.isError;
  const confirmEnable = kind === "provider_instance";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        {profilesQuery.isLoading
          ? "Search Profiles…"
          : profilesQuery.isError
            ? "Could not load Search Profiles"
            : `Enabled in ${pinnedCount} of ${plural(total, remoteOnly ? "remote Search Profile" : "Search Profile")}${removableCount > pinnedCount ? ` (also on ${plural(removableCount - pinnedCount, "non-remote profile")}, where it never runs)` : ""}`}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy || pinnedCount === total}
        onClick={() =>
          confirmEnable ? askToConfirm("enable") : mutation.mutate(true)
        }
      >
        {mutation.isPending && mutation.variables === true ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : null}
        Enable in all profiles
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy || removableCount === 0}
        onClick={() => askToConfirm("disable")}
      >
        {mutation.isPending && mutation.variables === false ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : null}
        Disable in all profiles
      </Button>
      {!enabledHere ? (
        <span className="basis-full">
          This source is switched off above, so profiles that enable it still
          skip it until it is ticked and saved here.
        </span>
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "enable" ? "Enable" : "Disable"} {displayName} in
              every profile?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "enable"
                ? `It is added to the sources of ${plural(total - pinnedCount, "Search Profile")}. Apify actors are paid, so runs of those profiles${enabledHere ? "" : ", once it is switched on here,"} start paying for it, including schedules that run each profile's own sources (remote profiles skip Apify actors).`
                : `It is removed from the sources of ${plural(removableCount, "Search Profile")}. Enabling it in all profiles again adds it to every ${remoteOnly ? "remote " : ""}profile, including any that did not have it before.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate(confirming === "enable")}
            >
              {confirming === "enable" ? "Enable" : "Disable"} in all profiles
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
