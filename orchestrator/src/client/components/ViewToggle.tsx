/**
 * Segmented control across the four top-level surfaces: the mobile "Swipe"
 * deck, the full "Manage" orchestrator, "Schedule" (the run schedules and
 * their run table) and "Stats". Rendered in the PageHeader title slot on each.
 */

import type React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";

const SEGMENTS: Array<{ label: string; to: string; match: string }> = [
  { label: "Swipe", to: "/swipe", match: "/swipe" },
  { label: "Manage", to: "/jobs/ready", match: "/jobs" },
  { label: "Schedule", to: "/schedule", match: "/schedule" },
  { label: "Stats", to: "/stats", match: "/stats" },
];

export const ViewToggle: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 p-0.5 text-sm font-medium">
      {SEGMENTS.map(({ label, to, match }) => {
        const isActive = location.pathname.startsWith(match);
        return (
          <button
            key={to}
            type="button"
            onClick={() => {
              if (!isActive) navigate(to);
            }}
            className={cn(
              "rounded-full px-3 py-1 transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};
