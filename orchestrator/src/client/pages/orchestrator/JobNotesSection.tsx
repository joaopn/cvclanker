import {
  useCreateJobNoteMutation,
  useDeleteJobNoteMutation,
  useJobNotesQuery,
  useUpdateJobNoteMutation,
} from "@client/hooks/queries/useJobMutations";
import { toast } from "@client/lib/toast";
import type { JobNote } from "@shared/types";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ReaderDialog } from "./ReaderDialog";

interface JobNotesSectionProps {
  jobId: string;
  readerSubtitle: string;
}

const TITLE_MAX = 120;
const CONTENT_MAX = 20000;

function formatNoteTimestamp(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const EMPTY_NOTES_TEXT =
  "No notes yet. Use this as a notepad for interviews, follow-ups, and contacts.";

export const JobNotesSection: React.FC<JobNotesSectionProps> = ({
  jobId,
  readerSubtitle,
}) => {
  const { data: notes = [], isLoading, error } = useJobNotesQuery(jobId);
  const createNote = useCreateJobNoteMutation();
  const updateNote = useUpdateJobNoteMutation();
  const deleteNote = useDeleteJobNoteMutation();

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");

  const resetDraft = () => {
    setDraftTitle("");
    setDraftContent("");
  };

  const startAdding = () => {
    setEditingId(null);
    resetDraft();
    setIsAdding(true);
  };

  const startEditing = (note: JobNote) => {
    setIsAdding(false);
    setEditingId(note.id);
    setDraftTitle(note.title);
    setDraftContent(note.content);
  };

  const cancelEditing = () => {
    setIsAdding(false);
    setEditingId(null);
    resetDraft();
  };

  const isSaving = createNote.isPending || updateNote.isPending;
  const canSave = draftTitle.trim().length > 0 && draftContent.trim().length > 0;

  const handleCreate = async () => {
    if (!canSave) return;
    try {
      await createNote.mutateAsync({
        jobId,
        input: { title: draftTitle.trim(), content: draftContent.trim() },
      });
      toast.success("Note added");
      cancelEditing();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add note");
    }
  };

  const handleUpdate = async (noteId: string) => {
    if (!canSave) return;
    try {
      await updateNote.mutateAsync({
        jobId,
        noteId,
        input: { title: draftTitle.trim(), content: draftContent.trim() },
      });
      toast.success("Note updated");
      cancelEditing();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update note");
    }
  };

  const handleDelete = async (noteId: string) => {
    if (!window.confirm("Delete this note?")) return;
    try {
      await deleteNote.mutateAsync({ jobId, noteId });
      toast.message("Note deleted");
      if (editingId === noteId) cancelEditing();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete note");
    }
  };

  const renderEditor = (onSave: () => void) => (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      <Input
        value={draftTitle}
        maxLength={TITLE_MAX}
        onChange={(event) => setDraftTitle(event.target.value)}
        placeholder="Note title (e.g. Recruiter screen)"
        className="h-8 text-sm"
      />
      <Textarea
        value={draftContent}
        maxLength={CONTENT_MAX}
        onChange={(event) => setDraftContent(event.target.value)}
        placeholder="Notes from the interview process, follow-ups, contacts…"
        className="min-h-[120px] text-sm leading-relaxed focus-visible:ring-1"
      />
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-3 text-xs"
          onClick={cancelEditing}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={onSave}
          disabled={!canSave || isSaving}
        >
          {isSaving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : null}
          Save
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </div>
        <div className="flex items-center gap-1">
          {!isAdding && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={startAdding}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add note
            </Button>
          )}
          <ReaderDialog title="Notes" subtitle={readerSubtitle}>
            {error ? (
              <p className="text-destructive">Failed to load notes.</p>
            ) : isLoading ? (
              <p className="text-muted-foreground">Loading notes…</p>
            ) : notes.length === 0 ? (
              <p className="text-muted-foreground">{EMPTY_NOTES_TEXT}</p>
            ) : (
              <div className="space-y-6">
                {notes.map((note) => (
                  <article key={note.id}>
                    <h3 className="text-base font-semibold text-foreground">
                      {note.title}
                    </h3>
                    <div className="mt-1 whitespace-pre-wrap">
                      {note.content}
                    </div>
                    <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      {note.updatedAt !== note.createdAt ? "Edited " : "Added "}
                      {formatNoteTimestamp(note.updatedAt)}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </ReaderDialog>
        </div>
      </div>

      {isAdding && renderEditor(handleCreate)}

      {error ? (
        <p className="text-xs text-destructive">Failed to load notes.</p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading notes…
        </div>
      ) : notes.length === 0 && !isAdding ? (
        <p className="text-xs text-muted-foreground/70">{EMPTY_NOTES_TEXT}</p>
      ) : (
        <div className="space-y-2">
          {notes.map((note) =>
            editingId === note.id ? (
              <div key={note.id}>{renderEditor(() => handleUpdate(note.id))}</div>
            ) : (
              <div
                key={note.id}
                className="rounded-lg border border-border/60 bg-muted/10 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-foreground/90">
                    {note.title}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Edit note"
                      onClick={() => startEditing(note)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Delete note"
                      onClick={() => void handleDelete(note.id)}
                    >
                      {deleteNote.isPending &&
                      deleteNote.variables?.noteId === note.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {note.content}
                </div>
                <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                  {note.updatedAt !== note.createdAt ? "Edited " : "Added "}
                  {formatNoteTimestamp(note.updatedAt)}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
};
