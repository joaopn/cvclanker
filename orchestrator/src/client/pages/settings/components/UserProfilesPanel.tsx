import * as api from "@client/api";
import { ProfileSwitchOverlay } from "@client/components/ProfileSwitchOverlay";
import { useProfileSwitch } from "@client/hooks/useProfileSwitch";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type {
  ActiveUserProfile,
  StoredUserProfile,
  UserProfileStats,
} from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Database,
  Download,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type UserProfilesPanelProps = {
  layoutMode?: "accordion" | "panel";
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatStatsLine(
  stats: UserProfileStats | null,
  sizeBytes: number,
): string {
  if (!stats) return formatBytes(sizeBytes);
  const parts: string[] = [];
  if (stats.jobsTotal !== null) {
    parts.push(`${stats.jobsTotal} job${stats.jobsTotal === 1 ? "" : "s"}`);
  }
  if (stats.liveJobs !== null) {
    parts.push(`${stats.liveJobs} live`);
  }
  if (stats.cvDocuments !== null) {
    parts.push(`${stats.cvDocuments} CV${stats.cvDocuments === 1 ? "" : "s"}`);
  }
  if (stats.searchProfileNames.length > 0) {
    parts.push(`search profiles: ${stats.searchProfileNames.join(", ")}`);
  }
  parts.push(formatBytes(sizeBytes));
  if (stats.lastUpdatedAt) {
    const updated = new Date(stats.lastUpdatedAt);
    if (!Number.isNaN(updated.getTime())) {
      parts.push(`updated ${updated.toLocaleDateString()}`);
    }
  }
  return parts.join(" · ");
}

/** Inline name editor shared by the active and stored cards — local draft,
 * commit on blur or Enter, reset on unchanged/empty. */
function ProfileNameInput(props: {
  name: string;
  disabled?: boolean;
  onRename: (name: string) => void;
}) {
  const { name, disabled, onRename } = props;
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setDraft(name);
      return;
    }
    onRename(trimmed);
  };

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      disabled={disabled}
      aria-label={`Profile name for ${name}`}
      className="h-8 max-w-xs"
    />
  );
}

export const UserProfilesPanel: React.FC<UserProfilesPanelProps> = ({
  layoutMode,
}) => {
  const queryClient = useQueryClient();
  const { switchState, activateProfile, startNewProfile, isPending } =
    useProfileSwitch();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(
    null,
  );
  const [pendingActivate, setPendingActivate] =
    useState<StoredUserProfile | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<StoredUserProfile | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const listQuery = useQuery({
    queryKey: queryKeys.userProfiles.list(),
    queryFn: api.getUserProfiles,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.userProfiles.all });

  const renameActiveMutation = useMutation({
    mutationFn: (name: string) => api.renameActiveUserProfile(name),
    onSuccess: () => {
      toast.success("Profile renamed");
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Rename failed");
      invalidate();
    },
  });

  const renameStoredMutation = useMutation({
    mutationFn: (args: { id: string; name: string }) =>
      api.renameStoredUserProfile(args.id, args.name),
    onSuccess: () => {
      toast.success("Profile renamed");
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Rename failed");
      invalidate();
    },
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => api.importUserProfile(file),
    onSuccess: (imported) => {
      toast.success(`Imported "${imported.name}"`);
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Import failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteUserProfile(id),
    onSuccess: () => {
      toast.success("Profile deleted");
      setPendingDelete(null);
      invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    },
  });

  const busy = switchState !== null || isPending;

  const handleExport = async (id?: string) => {
    setIsExporting(true);
    try {
      await api.exportUserProfile({ includeSecrets, id });
      toast.success("Profile exported.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Reset the input so re-picking the same file fires onChange again.
    event.target.value = "";
    if (file) setPendingImportFile(file);
  };

  const active: ActiveUserProfile | undefined = listQuery.data?.active;
  const stored: StoredUserProfile[] = listQuery.data?.stored ?? [];

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title={
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4" />
          <span className="text-base font-semibold tracking-wider">
            User Profiles
          </span>
        </div>
      }
      value="user-profiles"
    >
      <div className="space-y-4 pt-2">
        <p className="text-xs text-muted-foreground">
          A user profile is a whole database — jobs, CVs, cover letters,
          search profiles, settings, and generated PDFs. Switch between them,
          import a database file as a new profile, or export one as a single
          portable file.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={includeSecrets}
              onCheckedChange={(checked) =>
                setIncludeSecrets(checked === true)
              }
              disabled={busy || isExporting}
              className="mt-0.5"
            />
            <span>
              Include API keys &amp; secrets in exports
              <span className="block text-[11px] text-destructive">
                The file will contain credentials in plaintext — store it
                securely.
              </span>
              <span className="block text-[11px]">
                Tick this to migrate to another install: without it the export
                has no API keys, and the other end may land on the onboarding
                wizard to enter them again.
              </span>
            </span>
          </label>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || importMutation.isPending}
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Import profile
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,application/x-sqlite3,application/octet-stream"
              className="hidden"
              onChange={handleFilePicked}
            />
          </div>
        </div>

        {listQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading profiles…
          </div>
        ) : null}

        {active ? (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <CardTitle className="flex items-center gap-2">
                  <ProfileNameInput
                    name={active.name}
                    disabled={busy || renameActiveMutation.isPending}
                    onRename={(name) => renameActiveMutation.mutate(name)}
                  />
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    <Check className="h-3 w-3" /> Active
                  </span>
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {formatStatsLine(active.stats, active.sizeBytes)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || isExporting}
                  onClick={() => handleExport()}
                >
                  <Download className="mr-1 h-3.5 w-3.5" />
                  Export
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmNew(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  New profile
                </Button>
              </div>
            </CardHeader>
          </Card>
        ) : null}

        {stored.length > 0 ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">Stored profiles</div>
            {stored.map((profile) => (
              <Card key={profile.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <CardTitle className="flex items-center gap-2">
                      {profile.invalid ? (
                        <>
                          <span className="text-sm font-medium">
                            {profile.name}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                            <AlertTriangle className="h-3 w-3" /> Invalid
                          </span>
                        </>
                      ) : (
                        <ProfileNameInput
                          name={profile.name}
                          disabled={busy || renameStoredMutation.isPending}
                          onRename={(name) =>
                            renameStoredMutation.mutate({
                              id: profile.id,
                              name,
                            })
                          }
                        />
                      )}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {profile.invalid
                        ? (profile.invalidReason ??
                          "Not a readable CV Clanker database.")
                        : formatStatsLine(profile.stats, profile.sizeBytes)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!profile.invalid ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setPendingActivate(profile)}
                        >
                          <ArrowLeftRight className="mr-1 h-3.5 w-3.5" />
                          Activate
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy || isExporting}
                          onClick={() => handleExport(profile.id)}
                        >
                          <Download className="mr-1 h-3.5 w-3.5" />
                          Export
                        </Button>
                      </>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => setPendingDelete(profile)}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : null}

        {!listQuery.isLoading && stored.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No stored profiles yet. Import a database file or create a new
            profile to stash the current one.
          </p>
        ) : null}
      </div>

      <AlertDialog
        open={pendingImportFile !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImportFile(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import as a new profile?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {pendingImportFile?.name}
              </span>{" "}
              will be stored as a new profile. Nothing about the current
              profile changes — you can activate the import afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingImportFile) {
                  importMutation.mutate(pendingImportFile);
                }
                setPendingImportFile(null);
              }}
            >
              Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingActivate !== null}
        onOpenChange={(open) => {
          if (!open) setPendingActivate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to &quot;{pendingActivate?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The current profile is stashed and the app restarts into the
              selected one. Sessions do not carry across profiles — expect a
              re-login when authentication is enabled. Switching is blocked
              while a pipeline run is in flight.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingActivate) {
                  activateProfile(pendingActivate.id);
                }
                setPendingActivate(null);
              }}
            >
              Switch profile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmNew}
        onOpenChange={(open) => {
          setConfirmNew(open);
          if (!open) setNewProfileName("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a fresh profile?</AlertDialogTitle>
            <AlertDialogDescription>
              The current profile is stashed as a stored profile and the app
              restarts into a brand-new empty install. Nothing is lost — you
              can switch back at any time. Expect a re-login when
              authentication is enabled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
            placeholder="Default"
            aria-label="Name for the new profile"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                startNewProfile(newProfileName.trim() || undefined);
                setConfirmNew(false);
                setNewProfileName("");
              }}
            >
              Start fresh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &quot;{pendingDelete?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The stored profile file is deleted permanently. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) {
                  deleteMutation.mutate(pendingDelete.id);
                }
              }}
            >
              Delete profile
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProfileSwitchOverlay state={switchState} />
    </SettingsSectionFrame>
  );
};
