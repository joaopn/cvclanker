import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { Profile } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

export type UseSelectedProfileResult = {
  profiles: Profile[];
  selectedProfileId: string | null;
  selectedProfileIds: string[];
  toggleProfile: (id: string) => void;
  isLoading: boolean;
};

/**
 * Owns which Profiles the header dropdown shows and drives runs with. Ticking
 * several makes the next run sequential.
 *
 * Only the FIRST selected profile is persisted server-side
 * (`setDefaultProfile`), which keeps single-selection behaviour identical to
 * before and leaves API callers with a default to resolve. The rest of the set
 * is session state: it is a choice made immediately before pressing Run, and
 * persisting it would need its own settings key. A reload falls back to the
 * single default.
 *
 * `selectedProfileId` mirrors the server resolver: an explicit local pick, else
 * the persisted default, else the first listed profile, else null. The server
 * already resolves `defaultProfileId` to the most-recently-updated profile when
 * no pointer is set, so that third arm is only reachable with an empty list —
 * the alphabetical list order does not decide anything here. There is no
 * hydrate effect, so a local pick wins over an external default change until
 * remount — intended.
 */
export function useSelectedProfile(): UseSelectedProfileResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: api.getProfiles,
  });
  const [override, setOverride] = useState<string[] | null>(null);

  const mutation = useMutation({
    mutationFn: (id: string) => api.setDefaultProfile(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to select profile",
      );
    },
  });

  const profiles = query.data?.profiles ?? [];
  const fallbackId =
    query.data?.defaultProfileId ?? query.data?.profiles[0]?.id ?? null;
  // Memoised: this is the untouched-dropdown path, and a fresh array each
  // render would bust every consumer's memo that lists it as a dependency.
  const fallbackIds = useMemo(
    () => (fallbackId ? [fallbackId] : []),
    [fallbackId],
  );
  const selectedProfileIds = override ?? fallbackIds;
  const selectedProfileId = selectedProfileIds[0] ?? null;

  const toggleProfile = (id: string) => {
    const next = selectedProfileIds.includes(id)
      ? selectedProfileIds.filter((entry) => entry !== id)
      : // Keep the dropdown's own order so the run order matches what the user
        // sees, rather than the click order.
        profiles
          .map((profile) => profile.id)
          .filter(
            (profileId) =>
              selectedProfileIds.includes(profileId) || profileId === id,
          );

    // A run always needs at least one profile, mirroring the old
    // exactly-one selection: refuse to untick the last one.
    if (next.length === 0) return;

    setOverride(next);

    // Persist the default ONLY when the selection is unambiguous. Adding a
    // second profile to a one-off run must not silently repoint the default
    // that every profile-less run resolves — and it would, since `next` is in
    // dropdown order, so ticking a newer profile changes the head. Compared
    // against the STORED default rather than the current head: narrowing
    // ["a","b"] back to ["a"] leaves the head unchanged but is still the user
    // settling on a new single profile.
    if (next.length === 1 && next[0] !== query.data?.defaultProfileId) {
      mutation.mutate(next[0] as string);
    }
  };

  return {
    profiles,
    selectedProfileId,
    selectedProfileIds,
    toggleProfile,
    isLoading: query.isLoading,
  };
}
