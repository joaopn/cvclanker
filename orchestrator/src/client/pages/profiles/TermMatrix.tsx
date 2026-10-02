import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { changesScrapeCoverage } from "@shared/scrape-window.js";
import {
  isValidTermJobBudget,
  MAX_TERM_JOB_BUDGET,
  MIN_TERM_JOB_BUDGET,
} from "@shared/term-budgets.js";
import {
  MAX_SEARCH_TERM_LENGTH,
  MAX_SEARCH_TERMS,
  type Profile,
} from "@shared/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  type BudgetEdit,
  collectTermRows,
  nextSearchTerms,
  nextTermJobBudgets,
  rowBudgetState,
  sameBudgets,
  sameKeys,
  type TermRow,
  termKey,
  termKeysOf,
} from "./termMatrix";

interface TermMatrixProps {
  profiles: Profile[];
  defaultProfileId: string | null;
}

interface PendingChange {
  searchTerms: string[];
  termsChanged: boolean;
  termJobBudgets: Record<string, number>;
  budgetsChanged: boolean;
}

interface SaveOutcome {
  saved: Array<{ profile: Profile; searchTerms: string[] }>;
  failed: Array<{ profile: Profile; message: string }>;
}

/**
 * Bulk editor for search terms: terms as rows, Search Profiles as columns,
 * plus a Jobs column that sets a term's job budget on every profile the term
 * is ticked on. Nothing is written until Save; only profiles whose terms or
 * budgets changed are.
 */
export function TermMatrix({ profiles, defaultProfileId }: TermMatrixProps) {
  const queryClient = useQueryClient();
  // Only profiles the user touched have an entry; everything else reads its
  // saved terms, so a refetch after Save needs no re-seeding.
  const [edits, setEdits] = useState<Map<string, Set<string>>>(new Map());
  const [addedRows, setAddedRows] = useState<TermRow[]>([]);
  const [newTerm, setNewTerm] = useState("");
  // The Jobs cell per row, only for rows the user typed in; a row without an
  // entry leaves every profile's override as it is. `bad` is the browser's
  // own verdict: a number input reports half-typed text ("1e", "-") as an
  // empty value, which would otherwise read as "clear".
  const [budgetDrafts, setBudgetDrafts] = useState<
    Map<string, { value: string; bad: boolean }>
  >(new Map());

  const rows = useMemo(
    () => collectTermRows(profiles, addedRows),
    [profiles, addedRows],
  );

  const selectionOf = (profile: Profile): Set<string> =>
    edits.get(profile.id) ?? termKeysOf(profile);
  // The profiles a row is ticked on, as edited.
  const tickedOn = (key: string) =>
    profiles.filter((profile) => selectionOf(profile).has(key));

  // A blank cell clears the overrides (each profile falls back to its
  // default); anything else must be a valid budget or Save is blocked. A row
  // ticked on no profile changes nothing, so its cell is not checked.
  const budgetEdits = new Map<string, BudgetEdit>();
  const invalidBudgetRows: TermRow[] = [];
  for (const row of rows) {
    const draft = budgetDrafts.get(row.key);
    if (draft === undefined || tickedOn(row.key).length === 0) continue;
    if (draft.bad) {
      invalidBudgetRows.push(row);
      continue;
    }
    const trimmed = draft.value.trim();
    if (trimmed === "") {
      budgetEdits.set(row.key, null);
      continue;
    }
    const value = Number(trimmed);
    if (isValidTermJobBudget(value)) budgetEdits.set(row.key, value);
    else invalidBudgetRows.push(row);
  }

  const pendingChanges = new Map<string, PendingChange>();
  for (const profile of profiles) {
    const selected = selectionOf(profile);
    const termsChanged = !sameKeys(selected, termKeysOf(profile));
    const termJobBudgets = nextTermJobBudgets(profile, selected, budgetEdits);
    const budgetsChanged = !sameBudgets(
      termJobBudgets,
      profile.config.termJobBudgets,
    );
    if (!termsChanged && !budgetsChanged) continue;
    pendingChanges.set(profile.id, {
      searchTerms: nextSearchTerms(profile, selected, rows),
      termsChanged,
      termJobBudgets,
      budgetsChanged,
    });
  }
  const dirtyProfiles = profiles.filter((profile) =>
    pendingChanges.has(profile.id),
  );

  // Saves the server would refuse, or that would break the app, are blocked
  // up front rather than half-applied across profiles.
  const blockers: string[] = [];
  for (const row of invalidBudgetRows) {
    blockers.push(
      `Jobs for "${row.label}" must be a whole number from ${MIN_TERM_JOB_BUDGET} to ${MAX_TERM_JOB_BUDGET}, or blank for each profile's default.`,
    );
  }
  for (const profile of dirtyProfiles) {
    const change = pendingChanges.get(profile.id);
    if (!change?.termsChanged) continue;
    const terms = change.searchTerms;
    // Onboarding counts as done only while the default profile has a term, so
    // emptying it would send every page back to the setup wizard.
    if (profile.id === defaultProfileId && terms.length === 0) {
      blockers.push(
        `"${profile.name}" is the default profile and needs at least one term.`,
      );
    }
    if (terms.length > MAX_SEARCH_TERMS) {
      blockers.push(
        `"${profile.name}" would have ${terms.length} terms; the limit is ${MAX_SEARCH_TERMS}.`,
      );
    }
  }

  const setSelections = (changes: Array<[Profile, Set<string>]>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      for (const [profile, selected] of changes) next.set(profile.id, selected);
      return next;
    });
  };

  const toggleCell = (profile: Profile, key: string, on: boolean) => {
    const selected = new Set(selectionOf(profile));
    if (on) selected.add(key);
    else selected.delete(key);
    setSelections([[profile, selected]]);
  };

  // A header click turns the whole line on, unless it is already fully on,
  // in which case it turns it off.
  const toggleRow = (key: string) => {
    const allOn = profiles.every((profile) => selectionOf(profile).has(key));
    setSelections(
      profiles.map((profile) => {
        const selected = new Set(selectionOf(profile));
        if (allOn) selected.delete(key);
        else selected.add(key);
        return [profile, selected];
      }),
    );
  };

  const toggleColumn = (profile: Profile) => {
    const current = selectionOf(profile);
    const allOn = rows.every((row) => current.has(row.key));
    setSelections([
      [profile, allOn ? new Set() : new Set(rows.map((row) => row.key))],
    ]);
  };

  const addTerm = (event: FormEvent) => {
    event.preventDefault();
    const label = newTerm.trim();
    const key = termKey(label);
    if (!key) return;
    if (!rows.some((row) => row.key === key)) {
      setAddedRows((prev) => [...prev, { key, label }]);
    }
    setNewTerm("");
  };

  const setBudgetDraft = (key: string, value: string, bad: boolean) => {
    setBudgetDrafts((prev) => new Map(prev).set(key, { value, bad }));
  };

  const discard = () => {
    setEdits(new Map());
    setAddedRows([]);
    setBudgetDrafts(new Map());
  };

  const saveMutation = useMutation({
    mutationFn: async (): Promise<SaveOutcome> => {
      const outcome: SaveOutcome = { saved: [], failed: [] };
      for (const profile of dirtyProfiles) {
        const change = pendingChanges.get(profile.id);
        if (!change) continue;
        const { searchTerms } = change;
        try {
          // The override map is sent whole: the server replaces it rather
          // than merging into it.
          await api.updateProfile(profile.id, {
            config: {
              ...(change.termsChanged ? { searchTerms } : {}),
              ...(change.budgetsChanged
                ? { termJobBudgets: change.termJobBudgets }
                : {}),
            },
          });
          outcome.saved.push({ profile, searchTerms });
        } catch (error) {
          outcome.failed.push({
            profile,
            message: error instanceof Error ? error.message : "Save failed",
          });
        }
      }
      return outcome;
    },
    onSuccess: async ({ saved, failed }) => {
      // Refetch before dropping the edits, or the grid shows the pre-save
      // terms until the new list lands. Only what was written is dropped: a
      // failed profile keeps its edits so the user can see them and retry.
      await queryClient.invalidateQueries({ queryKey: queryKeys.profiles.all });
      setEdits((prev) => {
        const next = new Map(prev);
        for (const { profile } of saved) next.delete(profile.id);
        return next;
      });
      if (failed.length === 0) {
        setAddedRows([]);
        setBudgetDrafts(new Map());
      }

      if (saved.length > 0) {
        const message = `Saved changes on ${saved.length} profile${saved.length === 1 ? "" : "s"}`;
        // Changing terms drops the profile's scrape watermarks server-side;
        // say so where it costs something, as the profile editor does.
        const resets = saved.filter(
          ({ profile, searchTerms }) =>
            profile.config.scrapeSinceLastRun &&
            pendingChanges.get(profile.id)?.termsChanged === true &&
            changesScrapeCoverage(profile.config, { searchTerms }),
        );
        if (resets.length > 0) {
          toast.success(message, {
            description: `Search coverage changed, so "only scrape since the last run" starts over on ${resets.map(({ profile }) => profile.name).join(", ")} — the next run scrapes the full max-age window.`,
          });
        } else {
          toast.success(message);
        }
      }
      for (const { profile, message } of failed) {
        toast.error(`"${profile.name}" was not saved: ${message}`);
      }
    },
  });

  if (profiles.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No profiles yet. Create one to get started.
      </p>
    );
  }

  const saving = saveMutation.isPending;
  // What an untouched Jobs cell shows, across the profiles the row is ticked
  // on (as edited, so ticking a term into a profile counts it). A cell the
  // user emptied reads "default", which is what Save will then do.
  const budgetShown = (key: string): string => {
    const draft = budgetDrafts.get(key);
    if (draft) return draft.value;
    const state = rowBudgetState(tickedOn(key), key);
    return state.kind === "same" ? String(state.value) : "";
  };
  const budgetPlaceholder = (key: string): string =>
    !budgetDrafts.has(key) &&
    rowBudgetState(tickedOn(key), key).kind === "mixed"
      ? "mixed"
      : "default";
  const dirtyIds = new Set(dirtyProfiles.map((profile) => profile.id));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Tick a box to search that term on that profile. Click a term or a
        profile name to switch its whole line on (or off, when it is already all
        on). Nothing changes until you save.
      </p>

      <div className="overflow-auto rounded-md border">
        <table className="text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium"
              >
                Term
              </th>
              <th
                scope="col"
                className="px-2 py-2 text-center font-medium"
                title="LinkedIn jobs per search, on every profile the term is ticked on"
              >
                Jobs
              </th>
              {profiles.map((profile) => (
                <th
                  key={profile.id}
                  scope="col"
                  className="px-2 py-2 text-center font-medium"
                >
                  <button
                    type="button"
                    className="rounded px-1 hover:bg-accent disabled:opacity-50"
                    onClick={() => toggleColumn(profile)}
                    disabled={saving || rows.length === 0}
                    title={`Toggle every term on ${profile.name}`}
                  >
                    {profile.name}
                    {dirtyIds.has(profile.id) ? (
                      <>
                        <span aria-hidden="true" className="text-primary">
                          {" "}
                          *
                        </span>
                        <span className="sr-only"> (unsaved)</span>
                      </>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={profiles.length + 2}
                  className="px-3 py-4 text-muted-foreground"
                >
                  No search terms on any profile yet. Add one below.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-b-0">
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-background px-3 py-1.5 text-left font-normal"
                >
                  <button
                    type="button"
                    className="rounded px-1 text-left hover:bg-accent disabled:opacity-50"
                    onClick={() => toggleRow(row.key)}
                    disabled={saving}
                    title={`Toggle "${row.label}" on every profile`}
                  >
                    {row.label}
                  </button>
                </th>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={MIN_TERM_JOB_BUDGET}
                    max={MAX_TERM_JOB_BUDGET}
                    className="h-8 w-20"
                    aria-label={`Jobs per search for ${row.label}`}
                    value={budgetShown(row.key)}
                    placeholder={budgetPlaceholder(row.key)}
                    disabled={saving}
                    onChange={(event) =>
                      setBudgetDraft(
                        row.key,
                        event.target.value,
                        event.target.validity.badInput,
                      )
                    }
                    // A number input reports both "" and half-typed text as
                    // an empty value, and React fires onChange only when that
                    // value moves, so going from one to the other raises no
                    // onChange. onInput fires on every keystroke.
                    onInput={(event) =>
                      setBudgetDraft(
                        row.key,
                        event.currentTarget.value,
                        event.currentTarget.validity.badInput,
                      )
                    }
                  />
                </td>
                {profiles.map((profile) => (
                  <td key={profile.id} className="px-2 py-1.5 text-center">
                    <Checkbox
                      aria-label={`${row.label} on ${profile.name}`}
                      checked={selectionOf(profile).has(row.key)}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        toggleCell(profile, row.key, checked === true)
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="flex max-w-md gap-2" onSubmit={addTerm}>
        <Input
          value={newTerm}
          onChange={(event) => setNewTerm(event.target.value)}
          placeholder="Add a search term"
          aria-label="New search term"
          maxLength={MAX_SEARCH_TERM_LENGTH}
          disabled={saving}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={saving || !newTerm.trim()}
        >
          <Plus className="mr-1 h-4 w-4" />
          Add row
        </Button>
      </form>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saving || dirtyProfiles.length === 0 || blockers.length > 0}
        >
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={discard}
          disabled={
            saving ||
            (edits.size === 0 &&
              addedRows.length === 0 &&
              budgetDrafts.size === 0)
          }
        >
          Discard changes
        </Button>
        <span className="text-sm text-muted-foreground">
          {dirtyProfiles.length === 0
            ? "No unsaved changes"
            : `${dirtyProfiles.length} profile${dirtyProfiles.length === 1 ? "" : "s"} changed`}
        </span>
      </div>
      {blockers.length > 0 ? (
        <ul className="space-y-1 text-sm text-destructive" role="alert">
          {blockers.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        A row unticked on every profile disappears once saved. New terms are
        added at the end of each profile's list.
      </p>
      <p className="text-xs text-muted-foreground">
        Jobs is how many results each LinkedIn actor (curious_coder and
        cheap_scraper) may take for a term, on every profile the term is ticked
        on. They search each term on its own and stop there; cheap_scraper will
        not stop below 150, so it may take up to 150 even when the number is
        lower. Blank means each profile's own default; "mixed" means the
        profiles disagree, and typing a number sets them all.
      </p>
    </div>
  );
}
