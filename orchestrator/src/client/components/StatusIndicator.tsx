import type { JobStatus } from "@shared/types/jobs";
import type React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  defaultStatusToken,
  statusTokens,
} from "../pages/orchestrator/constants";

const STATUS_INDICATOR_BASE_CLASS =
  "inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80";
const STATUS_INDICATOR_DOT_CLASS = "h-1.5 w-1.5 rounded-full opacity-80";

const badgeVariantClasses = {
  amber: {
    badge: "border-status-warn/30 bg-status-warn/10 text-status-warn-text",
    dot: "bg-status-warn",
  },
  emerald: {
    badge: "border-status-good/30 bg-status-good/10 text-status-good-text",
    dot: "bg-status-good",
  },
  sky: {
    badge: "border-status-info/30 bg-status-info/10 text-status-info-text",
    dot: "bg-status-info",
  },
};

type StatusIndicatorProps = {
  dotColor?: string;
  label: React.ReactNode;
  className?: string;
  dotClassName?: string;
  variant?: keyof typeof badgeVariantClasses;
  appearance?: "inline" | "badge";
  animateDot?: boolean;
  tooltip?: React.ReactNode;
  tooltipClassName?: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  tooltipDelayDuration?: number;
};

const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  dotColor,
  label,
  className,
  dotClassName,
  variant = "amber",
  appearance = "inline",
  animateDot = appearance === "badge",
  tooltip,
  tooltipClassName,
  tooltipSide = "top",
  tooltipDelayDuration = 0,
}) => {
  const badgeTokens = badgeVariantClasses[variant];
  const resolvedDotColor = dotColor ?? badgeTokens.dot;

  const content = (
    <span
      className={cn(
        appearance === "badge"
          ? "inline-flex items-center gap-2 rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide"
          : STATUS_INDICATOR_BASE_CLASS,
        appearance === "badge" ? badgeTokens.badge : undefined,
        className,
      )}
    >
      <span
        className={cn(
          appearance === "badge"
            ? "h-1.5 w-1.5 rounded-full"
            : STATUS_INDICATOR_DOT_CLASS,
          animateDot ? "animate-pulse" : undefined,
          resolvedDotColor,
          dotClassName,
        )}
      />
      {label}
    </span>
  );

  if (!tooltip) return content;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={tooltipDelayDuration}>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side={tooltipSide} className={tooltipClassName}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const getJobStatusIndicator = (status: JobStatus) => {
  const tokens = statusTokens[status] ?? defaultStatusToken;
  return { label: tokens.label, dotColor: tokens.dot };
};

const getTracerStatusIndicator = (enabled: boolean) => ({
  label: enabled ? "Tracer On" : "Tracer Off",
  dotColor: enabled ? "bg-accent-purple" : "bg-muted-foreground",
});

const StatusBadgeIndicator: React.FC<
  Omit<StatusIndicatorProps, "appearance"> & { appearance?: "badge" }
> = (props) => <StatusIndicator {...props} appearance="badge" />;

export {
  StatusIndicator,
  getJobStatusIndicator,
  getTracerStatusIndicator,
  StatusBadgeIndicator,
};
