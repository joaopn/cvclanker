import * as api from "@client/api";
import type { SourceConfigsExtractorEntry } from "@client/api";
import { PageHeader, PageMain } from "@client/components/layout";
import { ActivityLogButton } from "@client/components/ActivityLogButton";
import { LlmStatusButton } from "@client/components/LlmStatusButton";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import {
  EXTRACTOR_SOURCE_METADATA,
  type ExtractorSourceId,
  isExtractorSourceId,
} from "@shared/extractors";
import type {
  SourceConfigField,
  SourceConfigGlobalField,
  SourceConfigGlobalMapping,
} from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Network, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AllProfilesPinControl } from "./sources/AllProfilesPinControl";
import { ApifyTab } from "./sources/ApifyTab";

const GLOBAL_FIELD_LABELS: Record<SourceConfigGlobalField, string> = {
  searchTerms: "Search terms",
  city: "City",
  workplaceTypes: "Workplace types",
  country: "Country",
  maxJobsPerTerm: "Max jobs per term (budget)",
  maxAgeDays: "Max job age (days)",
};

function platformLabel(platform: string): string {
  if (isExtractorSourceId(platform)) {
    return EXTRACTOR_SOURCE_METADATA[platform as ExtractorSourceId].label;
  }
  return platform;
}

export function SourcesPage() {
  const query = useQuery({
    queryKey: queryKeys.sourceConfigs.list(),
    queryFn: api.getSourceConfigs,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: api.getSettings,
  });

  return (
    <>
      <PageHeader
        icon={Network}
        title="Sources"
        subtitle="Built-in extractors and Apify marketplace actors. Configure once; the Run modal's globals feed both."
        actions={
          <>
            <LlmStatusButton />
            <ActivityLogButton />
          </>
        }
      />
      <PageMain>
        <Tabs defaultValue="builtin" className="space-y-4">
          <TabsList>
            <TabsTrigger value="builtin">Built-in</TabsTrigger>
            <TabsTrigger value="apify">Apify (paid API)</TabsTrigger>
          </TabsList>
          <TabsContent value="builtin" className="space-y-4">
            {query.isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sources…
              </div>
            ) : null}
            {query.isError ? (
              <p className="text-sm text-destructive">
                Failed to load sources:{" "}
                {query.error instanceof Error
                  ? query.error.message
                  : "unknown"}
              </p>
            ) : null}
            {query.data
              ? query.data.extractors.map((entry) => (
                  <ExtractorCard key={entry.extractorId} entry={entry} />
                ))
              : null}
          </TabsContent>
          <TabsContent value="apify" className="space-y-4">
            <ApifyTab settings={settingsQuery.data} />
          </TabsContent>
        </Tabs>
      </PageMain>
    </>
  );
}

interface ExtractorCardProps {
  entry: SourceConfigsExtractorEntry;
}

function ExtractorCard({ entry }: ExtractorCardProps) {
  const queryClient = useQueryClient();
  const { row, schema, displayName, providesSources, effectiveSettings } = entry;
  const [enabled, setEnabled] = useState(row.enabled);
  const [config, setConfig] = useState<Record<string, string>>(row.config);
  const [mappings, setMappings] = useState<
    Partial<Record<SourceConfigGlobalField, boolean>>
  >(row.mappings);

  useEffect(() => {
    setEnabled(row.enabled);
    setConfig(row.config);
    setMappings(row.mappings);
  }, [row]);

  const mutation = useMutation({
    mutationFn: () =>
      api.upsertSourceConfig(entry.extractorId, {
        enabled,
        config,
        mappings,
      }),
    onSuccess: () => {
      toast.success(`Saved ${displayName}`);
      queryClient.invalidateQueries({
        queryKey: queryKeys.sourceConfigs.all,
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Save failed");
    },
  });

  const dirty =
    enabled !== row.enabled ||
    JSON.stringify(config) !== JSON.stringify(row.config) ||
    JSON.stringify(mappings) !== JSON.stringify(row.mappings);

  const subline =
    providesSources.length > 1
      ? providesSources.map(platformLabel).join(" · ")
      : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Checkbox
              checked={enabled}
              onCheckedChange={(value) => setEnabled(value === true)}
              aria-label={`Enable ${displayName}`}
            />
            <span>{displayName}</span>
          </CardTitle>
          {subline ? <CardDescription>{subline}</CardDescription> : null}
          <AllProfilesPinControl
            kind="extractor"
            sourceId={entry.extractorId}
            displayName={displayName}
            enabledHere={row.enabled}
          />
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1 h-3.5 w-3.5" />
          )}
          Save
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        {schema && schema.fields.length > 0 ? (
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Source-specific defaults
            </h3>
            {schema.fields.map((field) => (
              <SourceFieldInput
                key={field.key}
                field={field}
                value={config[field.key] ?? field.default ?? ""}
                onChange={(next) =>
                  setConfig((current) => ({ ...current, [field.key]: next }))
                }
              />
            ))}
          </section>
        ) : null}

        {schema && schema.globalMappings.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Global field mappings
            </h3>
            <p className="text-xs text-muted-foreground">
              When enabled, the Run modal&apos;s value overrides this
              extractor&apos;s default.
            </p>
            {schema.globalMappings.map((mapping) => (
              <GlobalMappingRow
                key={mapping.globalField}
                mapping={mapping}
                checked={
                  mappings[mapping.globalField] ?? mapping.enabledByDefault
                }
                onChange={(value) =>
                  setMappings((current) => ({
                    ...current,
                    [mapping.globalField]: value,
                  }))
                }
              />
            ))}
          </section>
        ) : null}

        {!schema ? (
          <p className="text-sm text-muted-foreground">
            No configuration schema declared for this extractor.
          </p>
        ) : null}

        <details className="group">
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
            Show raw
          </summary>
          <div className="mt-3 space-y-3 text-xs">
            <RawBlock
              label="Effective settings (what manifest.run() sees)"
              value={effectiveSettings}
            />
            <RawBlock
              label="Saved row"
              value={{ config: row.config, mappings: row.mappings }}
            />
            <RawBlock label="Schema" value={schema ?? null} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

interface RawBlockProps {
  label: string;
  value: unknown;
}

function RawBlock({ label, value }: RawBlockProps) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

interface SourceFieldInputProps {
  field: SourceConfigField;
  value: string;
  onChange: (value: string) => void;
}

function SourceFieldInput({ field, value, onChange }: SourceFieldInputProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`source-field-${field.key}`} className="text-sm">
        {field.label}
      </Label>
      {field.type === "textarea" ? (
        <Textarea
          id={`source-field-${field.key}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
        />
      ) : (
        <Input
          id={`source-field-${field.key}`}
          type={
            field.type === "number"
              ? "number"
              : field.type === "secret"
                ? "password"
                : "text"
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}

interface GlobalMappingRowProps {
  mapping: SourceConfigGlobalMapping;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function GlobalMappingRow({
  mapping,
  checked,
  onChange,
}: GlobalMappingRowProps) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-border/60 p-2 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span className="space-y-0.5">
        <span className="block font-medium">
          {GLOBAL_FIELD_LABELS[mapping.globalField]} →{" "}
          <code className="text-xs">{mapping.sourceField}</code>
        </span>
        {mapping.description ? (
          <span className="block text-xs text-muted-foreground">
            {mapping.description}
          </span>
        ) : null}
      </span>
    </label>
  );
}
