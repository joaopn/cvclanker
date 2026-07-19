import type { CvField } from "@shared/types";
import { Lock, LockOpen, Undo2 } from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  fields: CvField[];
  defaults: Record<string, string>;
  overrides: Record<string, string>;
  locks: ReadonlySet<string>;
  onChange: (id: string, value: string) => void;
  onReset: (id: string) => void;
  /**
   * Omit to hide the per-field lock control entirely (e.g. cover letters,
   * which have no lock model). When omitted, `locks` is expected empty.
   */
  onToggleLock?: (id: string) => void;
};

type FieldGroup = {
  key: string;
  label: string;
  fields: CvField[];
};

const COLLAPSE_AFTER = 3;

/**
 * Cluster sibling fields by stripping the leaf segment of a dot-structured
 * id. Per the plan:
 *   `experience.0.bullet.0` → `experience.0`  (drop the `.bullet.0` role+index leaf)
 *   `experience.0.title`    → `experience.0`  (drop the `.title` leaf)
 *   `basics.name`           → `basics`        (drop the `.name` leaf)
 *   `skills.0`              → `skills`        (drop the `.0` leaf)
 *   `summary`               → `summary`       (no dots — flat)
 */
function groupKey(fieldId: string): string {
  const parts = fieldId.split(".");
  if (parts.length <= 1) return fieldId;
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    if (parts.length >= 3 && !/^\d+$/.test(parts[parts.length - 2])) {
      return parts.slice(0, -2).join(".");
    }
    return parts.slice(0, -1).join(".");
  }
  return parts.slice(0, -1).join(".");
}

function buildGroups(fields: CvField[]): FieldGroup[] {
  const groups = new Map<string, CvField[]>();
  for (const field of fields) {
    const key = groupKey(field.id);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(field);
    } else {
      groups.set(key, [field]);
    }
  }
  return Array.from(groups.entries()).map(([key, fields]) => ({
    key,
    label: deriveGroupLabel(key, fields),
    fields,
  }));
}

function deriveGroupLabel(key: string, fields: CvField[]): string {
  const titleField = fields.find(
    (f) => f.role === "title" || f.role === "name" || f.role === "company",
  );
  if (titleField?.value) {
    const trimmed = titleField.value.trim();
    if (trimmed.length > 0 && trimmed.length < 80) return `${key} — ${trimmed}`;
  }
  return key;
}

function isFieldEdited(
  field: CvField,
  overrides: Record<string, string>,
  defaults: Record<string, string>,
): boolean {
  if (!(field.id in overrides)) return false;
  const baseline = defaults[field.id] ?? field.value;
  return overrides[field.id] !== baseline;
}

export const CvFieldsEditor: React.FC<Props> = ({
  fields,
  defaults,
  overrides,
  locks,
  onChange,
  onReset,
  onToggleLock,
}) => {
  const groups = useMemo(() => buildGroups(fields), [fields]);

  return (
    <div className="flex-1 overflow-y-auto pr-1">
      {groups.map((group, idx) => (
        <FieldGroupSection
          key={group.key}
          group={group}
          defaultOpen={idx < COLLAPSE_AFTER}
          overrides={overrides}
          locks={locks}
          defaults={defaults}
          onChange={onChange}
          onReset={onReset}
          onToggleLock={onToggleLock}
        />
      ))}
    </div>
  );
};

type SectionProps = {
  group: FieldGroup;
  defaultOpen: boolean;
  overrides: Record<string, string>;
  locks: ReadonlySet<string>;
  defaults: Record<string, string>;
  onChange: (id: string, value: string) => void;
  onReset: (id: string) => void;
  onToggleLock?: (id: string) => void;
};

const FieldGroupSection: React.FC<SectionProps> = ({
  group,
  defaultOpen,
  overrides,
  locks,
  defaults,
  onChange,
  onReset,
  onToggleLock,
}) => {
  const editedCount = group.fields.reduce((acc, field) => {
    if (!(field.id in overrides)) return acc;
    const baseline = defaults[field.id] ?? field.value;
    return overrides[field.id] === baseline ? acc : acc + 1;
  }, 0);
  const lockedCount = group.fields.filter((f) => locks.has(f.id)).length;

  return (
    <details
      open={defaultOpen}
      className="mb-3 rounded-md border border-border/60 bg-background"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        <span>{group.label}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {group.fields.length} fields
          {editedCount > 0 ? ` · ${editedCount} edited` : ""}
          {lockedCount > 0 ? ` · ${lockedCount} locked` : ""}
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border/60 p-3">
        {group.fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            value={overrides[field.id] ?? defaults[field.id] ?? field.value}
            isEdited={isFieldEdited(field, overrides, defaults)}
            isLocked={locks.has(field.id)}
            onChange={(v) => onChange(field.id, v)}
            onReset={() => onReset(field.id)}
            onToggleLock={
              onToggleLock ? () => onToggleLock(field.id) : undefined
            }
          />
        ))}
      </div>
    </details>
  );
};

type FieldRowProps = {
  field: CvField;
  value: string;
  isEdited: boolean;
  isLocked: boolean;
  onChange: (next: string) => void;
  onReset: () => void;
  onToggleLock?: () => void;
};

const FieldRow: React.FC<FieldRowProps> = ({
  field,
  value,
  isEdited,
  isLocked,
  onChange,
  onReset,
  onToggleLock,
}) => {
  const rows = Math.max(1, Math.min(8, value.split("\n").length));
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/40 bg-muted/10 p-2">
      <div className="flex items-center gap-2">
        <code className="truncate text-[10px] text-muted-foreground">
          {field.id}
        </code>
        <Badge variant="outline" className="text-[10px]">
          {field.role}
        </Badge>
        {isEdited ? (
          <Badge variant="secondary" className="text-[10px]">
            edited
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {isEdited ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10px]"
              onClick={onReset}
              title="Reset to default"
            >
              <Undo2 className="h-3 w-3" />
              Reset
            </Button>
          ) : null}
          {onToggleLock ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onToggleLock}
              title={
                isLocked
                  ? "Unlock — re-tailoring and chat may modify"
                  : "Lock — block re-tailoring and chat edits"
              }
            >
              {isLocked ? (
                <Lock className="h-3 w-3 text-status-warn-text" />
              ) : (
                <LockOpen className="h-3 w-3 text-muted-foreground" />
              )}
            </Button>
          ) : null}
        </div>
      </div>
      <Textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="resize-y font-mono text-xs leading-relaxed"
      />
    </div>
  );
};
