/**
 * The Stats surface: four tabs of aggregates over the jobs table.
 *
 * Each tab fetches only its own endpoint, so opening the page costs one
 * request and switching tabs costs one more.
 */

import * as api from "@client/api";
import { PageHeader } from "@client/components/layout";
import { ViewToggle } from "@client/components/ViewToggle";
import { queryKeys } from "@client/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ApplicationsTab } from "./stats/ApplicationsTab";
import { CompaniesTab } from "./stats/CompaniesTab";
import { DiscoveryTab } from "./stats/DiscoveryTab";
import { OverviewTab } from "./stats/OverviewTab";

/** null = all time. */
const RANGES: Array<{ label: string; days: number | null }> = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: null },
];

const PanelState: React.FC<{
  isLoading: boolean;
  error: unknown;
  children: React.ReactNode;
}> = ({ isLoading, error, children }) => {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <p className="py-10 text-destructive text-sm">
        {error instanceof Error
          ? error.message
          : "Could not load these statistics."}
      </p>
    );
  }
  return <>{children}</>;
};

type StatsTab = "overview" | "discovery" | "applications" | "companies";

export const StatsPage: React.FC = () => {
  const [days, setDays] = useState<number | null>(90);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [tab, setTab] = useState<StatsTab>("overview");

  const filters = { days, profileId };

  const profilesQuery = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: () => api.getProfiles(),
  });

  const overview = useQuery({
    queryKey: queryKeys.stats.panel("overview", filters),
    queryFn: () => api.getStatsOverview(filters),
    // Only the visible tab fetches; the others stay cached once opened.
    enabled: tab === "overview",
  });
  const discovery = useQuery({
    queryKey: queryKeys.stats.panel("discovery", filters),
    queryFn: () => api.getStatsDiscovery(filters),
    // Only the visible tab fetches; the others stay cached once opened.
    enabled: tab === "discovery",
  });
  const applications = useQuery({
    queryKey: queryKeys.stats.panel("applications", filters),
    queryFn: () => api.getStatsApplications(filters),
    // Only the visible tab fetches; the others stay cached once opened.
    enabled: tab === "applications",
  });
  const companies = useQuery({
    queryKey: queryKeys.stats.panel("companies", filters),
    queryFn: () => api.getStatsCompanies(filters),
    // Only the visible tab fetches; the others stay cached once opened.
    enabled: tab === "companies",
  });

  const profiles = profilesQuery.data?.profiles ?? [];

  return (
    <>
      <PageHeader
        brand={
          <span className="whitespace-nowrap font-semibold text-lg tracking-tight">
            CV Clanker
          </span>
        }
        title="CV Clanker"
        subtitle="Stats"
        titleSlot={<ViewToggle />}
        fullWidth
      />
      <main className="w-full space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="inline-flex overflow-hidden rounded-md border border-border">
            <legend className="sr-only">Date range</legend>
            {RANGES.map((range) => (
              <button
                key={range.label}
                type="button"
                aria-pressed={days === range.days}
                onClick={() => setDays(range.days)}
                className={cn(
                  "px-3 py-1.5 text-sm transition-colors",
                  days === range.days
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {range.label}
              </button>
            ))}
          </fieldset>

          {profiles.length > 0 ? (
            <fieldset className="flex flex-wrap items-center gap-1">
              <legend className="sr-only">Search Profile</legend>
              <Button
                type="button"
                aria-pressed={profileId === null}
                size="sm"
                variant={profileId === null ? "secondary" : "ghost"}
                onClick={() => setProfileId(null)}
              >
                All profiles
              </Button>
              {profiles.map((profile) => (
                <Button
                  key={profile.id}
                  type="button"
                  aria-pressed={profileId === profile.id}
                  size="sm"
                  variant={profileId === profile.id ? "secondary" : "ghost"}
                  onClick={() => setProfileId(profile.id)}
                >
                  {profile.name}
                </Button>
              ))}
            </fieldset>
          ) : null}
        </div>

        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next as StatsTab)}
          className="space-y-4"
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="discovery">Discovery</TabsTrigger>
            <TabsTrigger value="applications">Applications</TabsTrigger>
            <TabsTrigger value="companies">Companies</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <PanelState isLoading={overview.isLoading} error={overview.error}>
              {overview.data ? <OverviewTab data={overview.data} /> : null}
            </PanelState>
          </TabsContent>

          <TabsContent value="discovery">
            <PanelState isLoading={discovery.isLoading} error={discovery.error}>
              {discovery.data ? <DiscoveryTab data={discovery.data} /> : null}
            </PanelState>
          </TabsContent>

          <TabsContent value="applications">
            <PanelState
              isLoading={applications.isLoading}
              error={applications.error}
            >
              {applications.data ? (
                <ApplicationsTab data={applications.data} />
              ) : null}
            </PanelState>
          </TabsContent>

          <TabsContent value="companies">
            <PanelState isLoading={companies.isLoading} error={companies.error}>
              {companies.data ? <CompaniesTab data={companies.data} /> : null}
            </PanelState>
          </TabsContent>
        </Tabs>
      </main>
    </>
  );
};
