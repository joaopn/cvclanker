/**
 * Status badge component.
 */

import type { JobStatus } from "@shared/types.js";
import { Loader2 } from "lucide-react";
import type React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: JobStatus;
}

const statusLabels: Record<JobStatus, string> = {
  discovered: "Discovered",
  selected: "Selected",
  processing: "Processing",
  ready: "Ready",
  applied: "Applied",
  in_progress: "In Progress",
  backlog: "Backlog",
  stale: "Stale",
  skipped: "Skipped",
  closed: "Closed",
};

const statusStyles: Record<
  JobStatus,
  {
    variant: "default" | "secondary" | "destructive" | "outline";
    className?: string;
  }
> = {
  discovered: { variant: "secondary" },
  selected: { variant: "secondary" },
  processing: { variant: "secondary" },
  ready: { variant: "default" },
  applied: {
    variant: "outline",
    className: "text-status-good-text border-status-good/30",
  },
  in_progress: {
    variant: "outline",
    className: "text-accent-cyan-text border-accent-cyan/30",
  },
  backlog: { variant: "outline", className: "text-muted-foreground" },
  stale: { variant: "outline", className: "text-muted-foreground" },
  skipped: { variant: "destructive" },
  closed: { variant: "outline", className: "text-muted-foreground" },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const { variant, className } = statusStyles[status];

  return (
    <Badge variant={variant} className={cn("gap-1", className)}>
      {status === "processing" && <Loader2 className="h-3 w-3 animate-spin" />}
      {statusLabels[status]}
    </Badge>
  );
};
