import type { LlmCallRecord } from "@shared/types";
import { Activity, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface LlmCallQueueSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active: LlmCallRecord[];
  recent: LlmCallRecord[];
  connected: boolean;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export const LlmCallQueueSheet: React.FC<LlmCallQueueSheetProps> = ({
  open,
  onOpenChange,
  active,
  recent,
  connected,
}) => {
  const now = useNow(500, open && active.length > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              LLM call queue
              {!connected && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  reconnecting…
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription>
              Live view of in-flight LLM requests and the last few completions.
            </SheetDescription>
          </SheetHeader>

          <Separator className="my-4" />

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <Section
              title="Running"
              count={active.length}
              empty="No active calls"
            >
              {active.map((call) => (
                <CallRow key={call.id} call={call} now={now} />
              ))}
            </Section>

            <Section
              title="Recent"
              count={recent.length}
              empty="No completed calls yet"
            >
              {recent.map((call) => (
                <CallRow key={call.id} call={call} now={now} />
              ))}
            </Section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

const Section: React.FC<{
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}> = ({ title, count, empty, children }) => (
  <div className="space-y-2">
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{title}</span>
      <Badge variant="outline">{count}</Badge>
    </div>
    {count === 0 ? (
      <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
        {empty}
      </div>
    ) : (
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {children}
      </ul>
    )}
  </div>
);

const CallRow: React.FC<{ call: LlmCallRecord; now: number }> = ({
  call,
  now,
}) => {
  const elapsed =
    call.status === "running"
      ? now - Date.parse(call.startedAt)
      : (call.durationMs ?? 0);

  return (
    <li className="flex items-start gap-3 px-3 py-2 text-xs">
      <div className="mt-0.5 shrink-0">
        {call.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : call.status === "failed" ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-status-good-text" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {call.label}
          </span>
        </div>
        {call.subject && (
          <div className="truncate text-foreground/80">{call.subject}</div>
        )}
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {call.model}
          {call.totalTokens !== null &&
            ` (${call.totalTokens.toLocaleString()} tokens)`}
        </div>
        {call.status === "failed" && call.errorMessage && (
          <div className="truncate text-destructive">{call.errorMessage}</div>
        )}
      </div>
      <div className="shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
        {formatDuration(elapsed)}
      </div>
    </li>
  );
};
