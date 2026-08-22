import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { Profile } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface ProfileCardProps {
  profile: Profile;
  defaultProfileId: string | null;
}

function summarize(profile: Profile): string {
  const config = profile.config;
  const termCount = config.searchTerms.length;
  const cityCount = config.searchCities
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean).length;
  const sourceCount =
    config.enabledSourceIds.length + config.providerInstanceIds.length;
  return [
    `${termCount} term${termCount === 1 ? "" : "s"}`,
    // A remote profile sends no geography; the stored values are inert.
    ...(config.remoteProfile
      ? ["remote"]
      : [
          config.searchCountry.trim() || "any country",
          `${cityCount} cit${cityCount === 1 ? "y" : "ies"}`,
        ]),
    `budget ${config.runBudget}`,
    `top ${config.topN}`,
    `${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
  ].join(" · ");
}

export function ProfileCard({ profile, defaultProfileId }: ProfileCardProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(profile.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDefault = profile.id === defaultProfileId;

  useEffect(() => {
    setName(profile.name);
  }, [profile.name]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });

  const renameMutation = useMutation({
    mutationFn: () => api.updateProfile(profile.id, { name: name.trim() }),
    onSuccess: () => {
      toast.success("Profile renamed");
      invalidate();
    },
    onError: (error) => {
      setName(profile.name);
      toast.error(error instanceof Error ? error.message : "Rename failed");
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: () => api.setDefaultProfile(profile.id),
    onSuccess: () => {
      toast.success(`"${profile.name}" is now the default`);
      invalidate();
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to set default",
      );
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: () => api.duplicateProfile(profile.id),
    onSuccess: () => {
      toast.success(`Duplicated "${profile.name}"`);
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Duplicate failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProfile(profile.id),
    onSuccess: () => {
      toast.success(`Deleted "${profile.name}"`);
      setConfirmDelete(false);
      invalidate();
    },
    onError: (error) => {
      // Surfaces the server's 409 "last profile" message verbatim.
      toast.error(error instanceof Error ? error.message : "Delete failed");
    },
  });

  const commitRename = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.name) {
      setName(profile.name);
      return;
    }
    renameMutation.mutate();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <CardTitle className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              aria-label={`Profile name for ${profile.name}`}
              className="h-8 max-w-xs"
            />
            {isDefault ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Check className="h-3 w-3" /> Default
              </span>
            ) : null}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{summarize(profile)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => navigate(`/profiles/${profile.id}`)}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            Edit
          </Button>
          {!isDefault ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={setDefaultMutation.isPending}
              onClick={() => setDefaultMutation.mutate()}
            >
              {setDefaultMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Set as default
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={duplicateMutation.isPending}
            onClick={() => duplicateMutation.mutate()}
          >
            {duplicateMutation.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Copy className="mr-1 h-3.5 w-3.5" />
            )}
            Duplicate
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>
      </CardHeader>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete profile</DialogTitle>
            <DialogDescription>
              Delete &quot;{profile.name}&quot;? This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
