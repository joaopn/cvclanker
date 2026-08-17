import * as api from "@client/api";
import { PageHeader, PageMain } from "@client/components/layout";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { changesScrapeCoverage } from "@shared/scrape-window.js";
import { defaultProfileConfig } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildConfig,
  type EditorForm,
  enabledExtractorIdsOf,
  enabledInstanceIdsOf,
  formFromConfig,
  hasEffectiveSourceSelection,
  ProfileConfigFields,
} from "./profiles/ProfileConfigFields";

export function ProfileEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = id === undefined;

  const profilesQuery = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: api.getProfiles,
  });
  const sourcesQuery = useQuery({
    queryKey: queryKeys.sourceConfigs.list(),
    queryFn: api.getSourceConfigs,
  });
  const instancesQuery = useQuery({
    queryKey: queryKeys.providerInstances.list(),
    queryFn: api.getProviderInstances,
  });

  const existing = id
    ? profilesQuery.data?.profiles.find((profile) => profile.id === id)
    : null;

  const [form, setForm] = useState<EditorForm | null>(() =>
    isNew ? formFromConfig("", defaultProfileConfig()) : null,
  );
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (isNew || hydratedRef.current) return;
    if (existing) {
      hydratedRef.current = true;
      setForm(formFromConfig(existing.name, existing.config));
    }
  }, [isNew, existing]);

  const update = (patch: Partial<EditorForm>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("Form not ready");
      const config = buildConfig(
        form,
        existing?.config ?? defaultProfileConfig(),
      );
      const name = form.name.trim();
      // Changing what a run covers drops this profile's scrape watermarks
      // server-side. That is correct — a narrowed window is only safe while the
      // previous run looked for the same things — but it silently costs the
      // next run its narrowing, so say so instead of leaving it to be
      // rediscovered from a funnel that suddenly re-buys a full window.
      const resetsScrapeWindow =
        !isNew &&
        existing !== null &&
        existing !== undefined &&
        config.scrapeSinceLastRun &&
        changesScrapeCoverage(existing.config, config);
      const saved = id
        ? await api.updateProfile(id, { name, config })
        : await api.createProfile({ name, config });
      return { saved, resetsScrapeWindow };
    },
    onSuccess: ({ resetsScrapeWindow }) => {
      const message = id ? "Profile saved" : "Profile created";
      // Call the bare 1-arg form when there is nothing to add: the toast
      // wrapper forwards its second argument, and a trailing `undefined`
      // breaks every `toHaveBeenCalledWith(message)` assertion.
      if (resetsScrapeWindow) {
        toast.success(message, {
          description:
            'Search coverage changed, so "only scrape since the last run" starts over — the next run scrapes the full max-age window on every source.',
        });
      } else {
        toast.success(message);
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });
      navigate("/profiles");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Save failed");
    },
  });

  // Only genuinely-missing profiles are "not found". A warm-cache Edit has
  // `existing` on the first frame but `form` not yet hydrated — that must show
  // the loading branch, not a not-found flash.
  const notFound = !isNew && !profilesQuery.isLoading && existing === undefined;

  const extractors = sourcesQuery.data?.extractors ?? [];
  const instances =
    instancesQuery.data?.providers.flatMap((provider) => provider.instances) ??
    [];

  const enabledExtractorIds = enabledExtractorIdsOf(extractors);
  const enabledInstanceIds = enabledInstanceIdsOf(instances);

  // A new profile starts with every source the User Profile has enabled,
  // Apify actors included. Seeded once, when the source lists land.
  const seededNewProfileRef = useRef(false);
  useEffect(() => {
    if (!isNew || seededNewProfileRef.current) return;
    if (sourcesQuery.isLoading || instancesQuery.isLoading) return;
    seededNewProfileRef.current = true;
    setForm((prev) =>
      prev
        ? {
            ...prev,
            enabledSourceIds: enabledExtractorIds,
            providerInstanceIds: enabledInstanceIds,
          }
        : prev,
    );
  }, [
    isNew,
    sourcesQuery.isLoading,
    instancesQuery.isLoading,
    enabledExtractorIds,
    enabledInstanceIds,
  ]);

  const canSave =
    form !== null &&
    form.name.trim().length > 0 &&
    hasEffectiveSourceSelection(form, extractors, instances) &&
    !saveMutation.isPending;

  return (
    <>
      <PageHeader
        icon={Target}
        title={isNew ? "New profile" : (existing?.name ?? "Edit profile")}
        subtitle="Search terms, location, run budget, and the sources this profile scrapes."
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate("/profiles")}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1 h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        }
      />
      <PageMain>
        {notFound ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">Profile not found.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate("/profiles")}
            >
              Back to profiles
            </Button>
          </div>
        ) : !form ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading profile…
          </div>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="profile-name">Name</Label>
                <Input
                  id="profile-name"
                  value={form.name}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder="e.g. Berlin backend"
                />
              </CardContent>
            </Card>

            <ProfileConfigFields
              form={form}
              onChange={update}
              extractors={extractors}
              instances={instances}
            />
          </div>
        )}
      </PageMain>
    </>
  );
}
