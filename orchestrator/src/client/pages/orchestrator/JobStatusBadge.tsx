import type { JobStatus } from "@shared/types.js";
import { cn } from "@/lib/utils";
import { type BadgeTone, defaultStatusToken, statusTokens } from "./constants";

interface TokenBadgeProps {
  tone: BadgeTone;
  label: string;
  className?: string;
}

export const TokenBadge = ({ tone, label, className }: TokenBadgeProps) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide",
      tone.badge,
      className,
    )}
  >
    <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
    {label}
  </span>
);

interface JobStatusBadgeProps {
  status: JobStatus;
  label?: string;
  className?: string;
}

export const JobStatusBadge = ({
  status,
  label,
  className,
}: JobStatusBadgeProps) => {
  // Kept here rather than in TokenBadge: callers pass a server-supplied
  // status, so an unrecognised one has to degrade to the neutral token.
  const statusToken = statusTokens[status] ?? defaultStatusToken;
  return (
    <TokenBadge
      tone={statusToken}
      label={label ?? statusToken.label}
      className={className}
    />
  );
};
