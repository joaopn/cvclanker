import { useActivityLog } from "@client/hooks/useActivityLog";
import type {
  ActivityLogEntry,
  ActivityLogKind,
} from "@/client/lib/activityLog";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  MessageSquare,
  Trash2,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Self-contained activity log button + sheet. Subscribes to the persistent
 * activity store (every toast.* mirrors into it via @client/lib/toast),
 * shows a badge with the unread count, and opens a sheet listing recent
 * entries. Drops into any `PageHeader` actions slot.
 */
export const ActivityLogButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const { entries, unreadCount, clear, markAllRead } = useActivityLog();

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) markAllRead();
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleOpenChange(true)}
        className="relative gap-2"
        aria-label="Activity log"
      >
        <Bell className="h-4 w-4" />
        <span className="hidden sm:inline">Activity</span>
        {unreadCount > 0 && (
          <Badge
            variant="default"
            className="h-5 min-w-[1.25rem] justify-center px-1 text-[10px]"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </Badge>
        )}
      </Button>
      <ActivityLogSheet
        open={open}
        onOpenChange={handleOpenChange}
        entries={entries}
        onClear={clear}
      />
    </>
  );
};

interface ActivityLogSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ActivityLogEntry[];
  onClear: () => void;
}

const ActivityLogSheet: React.FC<ActivityLogSheetProps> = ({
  open,
  onOpenChange,
  entries,
  onClear,
}) => {
  const reversed = [...entries].reverse();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              Activity log
              {entries.length > 0 && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {entries.length}
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription>
              Recent toasts and errors. Stored locally, capped at 100 entries.
            </SheetDescription>
          </SheetHeader>

          <Separator className="my-4" />

          {entries.length > 0 && (
            <div className="mb-3 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={onClear}
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </Button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {reversed.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted-foreground">
                No activity yet. Toasts will appear here as they happen.
              </div>
            ) : (
              reversed.map((entry) => <EntryRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

const KIND_META: Record<
  ActivityLogKind,
  { Icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  success: { Icon: CheckCircle2, tone: "text-status-good-text" },
  error: { Icon: XCircle, tone: "text-destructive" },
  warning: { Icon: AlertTriangle, tone: "text-status-warn-text" },
  info: { Icon: Info, tone: "text-status-info-text" },
  message: { Icon: MessageSquare, tone: "text-muted-foreground" },
};

const formatRelative = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

const formatAbsolute = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString();
};

const EntryRow: React.FC<{ entry: ActivityLogEntry }> = ({ entry }) => {
  const meta = KIND_META[entry.kind];
  const Icon = meta.Icon;
  return (
    <div className="flex gap-3 rounded-md border border-border/40 bg-muted/10 p-3">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-medium leading-tight">{entry.title}</div>
          <div
            className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground tabular-nums"
            title={formatAbsolute(entry.timestamp)}
          >
            {formatRelative(entry.timestamp)}
          </div>
        </div>
        {entry.description && (
          <div className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {entry.description}
          </div>
        )}
      </div>
    </div>
  );
};
