import * as api from "@client/api";
import { ProfileSwitchOverlay } from "@client/components/ProfileSwitchOverlay";
import { useProfileSwitch } from "@client/hooks/useProfileSwitch";
import { rememberImportedProfile } from "@client/lib/importedProfileNotice";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { StoredUserProfile } from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
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

type ImportDatabaseButtonProps = {
  disabled?: boolean;
};

/**
 * The wizard's escape hatch for an existing installation: upload a database
 * file, then switch the app onto it instead of setting everything up again.
 *
 * Both halves already exist — `POST /user-profiles/import` validates and stores
 * the file without touching the live DB, and activation stashes the current
 * database before swapping the imported one in. Chaining them is what makes the
 * import a migration rather than a filing action. Hosting `useProfileSwitch`
 * here (PageHeader has its own instance, unexposed) follows UserProfilesPanel.
 */
export const ImportDatabaseButton: React.FC<ImportDatabaseButtonProps> = ({
  disabled,
}) => {
  const queryClient = useQueryClient();
  const { switchState, activateProfile, isPending } = useProfileSwitch();
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [imported, setImported] = useState<StoredUserProfile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importMutation = useMutation({
    mutationFn: (file: File) => api.importUserProfile(file),
    onSuccess: (profile) => {
      setImported(profile);
      // The nav drawer's switcher is the only route back to this database if
      // the switch below fails: the onboarding gate keeps Settings unreachable,
      // and its listing is cached.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.userProfiles.all,
      });
      rememberImportedProfile(profile.name);
      toast.success(`Imported "${profile.name}"`);
      activateProfile(profile.id);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Import failed");
    },
  });

  const busy = switchState !== null || isPending || importMutation.isPending;
  // The import landed but the switch did not — `useProfileSwitch` toasts an
  // activation failure and leaves `switchState` null, so the file would
  // otherwise sit in the store with no way back to it from this page.
  const showSwitchRetry = imported !== null && !busy;

  const handleFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Reset the input so re-picking the same file fires onChange again.
    event.target.value = "";
    if (file) setPendingFile(file);
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Upload className="mr-2 h-4 w-4" />
        )}
        Import database
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".db,application/x-sqlite3,application/octet-stream"
        className="hidden"
        onChange={handleFilePicked}
      />
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          Already using CV Clanker elsewhere? Import that database to carry your
          jobs, CVs and settings across instead of setting up again.
        </p>
        <p>
          Export it with{" "}
          <span className="font-medium text-foreground">
            &quot;Include API keys &amp; secrets&quot;
          </span>{" "}
          ticked. That box is off by default, and without it the file carries no
          API keys — so you may have to enter them here anyway.
        </p>
      </div>

      {showSwitchRetry ? (
        <div className="space-y-2 rounded-md border border-border/60 p-2">
          <p className="text-xs text-muted-foreground">
            &quot;{imported.name}&quot; was imported but the app did not switch
            to it. Try again, or reach it from the Profile line in the menu in
            the top-left.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => activateProfile(imported.id)}
          >
            Switch to &quot;{imported.name}&quot;
          </Button>
        </div>
      ) : null}

      <AlertDialog
        open={pendingFile !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFile(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Import &quot;{pendingFile?.name}&quot; and switch to it?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The file is imported as a new user profile and the app restarts
              into it. Your current database is stashed as its own profile —
              nothing is deleted, and you can switch back from the Profile line
              in the menu in the top-left. Sessions do not carry across
              profiles, so expect a re-login where authentication is enabled.
              <span className="mt-2 block text-foreground">
                Exported without &quot;Include API keys &amp; secrets&quot;?
                Then the file carries no API keys, no tokens and no basic-auth
                password. Unless your server supplies those itself, or your LLM
                provider needs no key or token, this wizard will still be here
                after the restart and authentication will be off.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingFile) importMutation.mutate(pendingFile);
                setPendingFile(null);
              }}
            >
              Import and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProfileSwitchOverlay state={switchState} />
    </div>
  );
};
