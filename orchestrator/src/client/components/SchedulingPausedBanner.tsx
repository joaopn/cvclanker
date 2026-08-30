/**
 * Automatic runs have stopped, and nothing else would say so.
 *
 * App-level on purpose — the one thing that crosses the manual/scheduled
 * separation. A user who never opens the Runs tab would otherwise leave
 * scheduling dead for weeks with no sign of it, which is exactly the silence
 * the pause exists to break.
 */

import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import type React from "react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";

export const SchedulingPausedBanner: React.FC = () => {
  const location = useLocation();
  const queryClient = useQueryClient();

  // Sign-in and onboarding are reachable UNAUTHENTICATED, and a 401 from
  // `fetchApi` clears the session and redirects — so polling there would fire
  // that pair every minute at someone sitting on the login form.
  const onAuthPage =
    location.pathname.startsWith("/sign-in") ||
    location.pathname.startsWith("/onboarding");

  const query = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.getSchedules(),
    enabled: !onAuthPage,
    // A pause can begin at any time from a background run, so this polls
    // rather than waiting for a navigation.
    refetchInterval: 60_000,
  });

  const resume = useMutation({
    mutationFn: () => api.resumeScheduling(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      toast.success("Scheduling resumed");
    },
    onError: (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : "Could not resume scheduling",
      ),
  });

  const reason = query.data?.pausedReason ?? null;
  // The Runs tab shows the same thing with more room, so it would be two
  // banners saying one thing.
  if (!reason || onAuthPage || location.pathname.startsWith("/runs")) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 text-destructive">
        Automatic runs are paused. {reason}
      </span>
      <Link to="/runs" className="underline underline-offset-2">
        View
      </Link>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        Resume scheduling
      </Button>
    </div>
  );
};
