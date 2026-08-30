import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import {
  isEmployerBlocked,
  MAX_BLOCKED_COMPANY_KEYWORD_LENGTH,
} from "@shared/blocked-companies.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface BlacklistCompanyMenuProps {
  employer: string;
}

/**
 * "Blacklist" on a company's job list: add the company to the blocked list of
 * whichever Search Profiles the user ticks.
 *
 * Forward-looking only — the blocked list is read by the discovery step, so
 * jobs already found stay exactly where they are. A profile that already blocks
 * the company is shown ticked and disabled; un-blacklisting is the Search
 * Profile editor's job, so that this menu only ever adds.
 */
export const BlacklistCompanyMenu: React.FC<BlacklistCompanyMenuProps> = ({
  employer,
}) => {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const profilesQuery = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: () => api.getProfiles(),
    enabled: open,
    // This key is shared with the page's own profile hook, so the menu paints
    // that cache first and refetches behind it; a tick can therefore be made
    // against a list that has since changed. Harmless — the server rechecks,
    // and the result says which profiles it actually wrote.
    staleTime: 0,
  });

  const rows = useMemo(
    () =>
      (profilesQuery.data?.profiles ?? []).map((profile) => ({
        profile,
        alreadyBlocked: isEmployerBlocked(
          employer,
          profile.config.blockedCompanyKeywords,
        ),
      })),
    [profilesQuery.data, employer],
  );

  useEffect(() => {
    if (!open) setTicked(new Set());
  }, [open]);

  // Never send a profile that already blocks the company: the list can change
  // under an open menu (another tab, or a second press), and the tick would
  // then be a no-op the server has to reject rather than a request.
  const selectedIds = rows
    .filter((row) => !row.alreadyBlocked && ticked.has(row.profile.id))
    .map((row) => row.profile.id);

  const mutation = useMutation({
    mutationFn: () =>
      api.blockCompanyOnProfiles({ employer, profileIds: selectedIds }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });
      setOpen(false);
      const names = result.blocked.map((entry) => entry.name);
      if (names.length === 0) {
        // Nothing was written. Which of the two reasons it was matters: the
        // list moving on since this menu painted leaves the company blocked
        // either way, while a profile deleted mid-request leaves it blocked
        // nowhere — saying "already blacklisted" there would be a lie.
        if (result.alreadyBlocked.length > 0) {
          toast.info(`${employer} was already blacklisted.`);
        } else {
          toast.warning(
            selectedIds.length === 1
              ? "Nothing was blacklisted — that search profile is gone."
              : "Nothing was blacklisted — those search profiles are gone.",
          );
        }
        return;
      }
      toast.success(
        names.length === 1
          ? `Blacklisted ${employer} on ${names[0]}.`
          : `Blacklisted ${employer} on ${names.length} search profiles.`,
        {
          description:
            "Future runs skip this company. Jobs already found are unchanged.",
        },
      );
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not blacklist company.",
      );
    },
  });

  // The company name comes from a scraped posting, not a form, so it can be
  // longer than a keyword may be. Refuse it here rather than let the request
  // come back as a raw schema error in a toast.
  const tooLong = employer.trim().length > MAX_BLOCKED_COMPANY_KEYWORD_LENGTH;

  const toggle = (id: string) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="gap-2">
          <Ban className="h-4 w-4" />
          Blacklist
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="break-words text-sm font-medium">
              Blacklist {employer}
            </p>
            <p className="text-xs text-muted-foreground">
              Future runs of the ticked search profiles skip this company. Jobs
              already found are unchanged.
            </p>
          </div>

          {tooLong ? (
            <p className="py-2 text-sm text-muted-foreground">
              This company name is longer than{" "}
              {MAX_BLOCKED_COMPANY_KEYWORD_LENGTH} characters, so it cannot be
              stored as a blocked company.
            </p>
          ) : profilesQuery.isLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading search profiles…
            </div>
          ) : profilesQuery.isError ? (
            <p className="py-2 text-sm text-destructive">
              Could not load search profiles.
            </p>
          ) : rows.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No search profiles yet.
            </p>
          ) : (
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {rows.map(({ profile, alreadyBlocked }) => {
                const controlId = `blacklist-profile-${profile.id}`;
                return (
                  <label
                    key={profile.id}
                    htmlFor={controlId}
                    className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-sm ${
                      alreadyBlocked
                        ? "opacity-60"
                        : "cursor-pointer hover:bg-muted"
                    }`}
                  >
                    <Checkbox
                      id={controlId}
                      className="mt-0.5"
                      checked={alreadyBlocked || ticked.has(profile.id)}
                      disabled={alreadyBlocked || mutation.isPending}
                      onCheckedChange={() => toggle(profile.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{profile.name}</span>
                      {alreadyBlocked && (
                        <span className="block truncate text-xs text-muted-foreground">
                          Already blocked
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {!tooLong && (
            <p className="text-[11px] text-muted-foreground">
              Matched on the exact company name, so a differently spelled
              posting from the same company still comes through. Remove it under
              a search profile's Blocked companies.
            </p>
          )}

          <Button
            type="button"
            size="sm"
            disabled={tooLong || selectedIds.length === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            {selectedIds.length === 0
              ? "Blacklist"
              : `Blacklist on ${selectedIds.length} ${
                  selectedIds.length === 1 ? "profile" : "profiles"
                }`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
