import { Loader2 } from "lucide-react";
import type React from "react";

interface ProcessingStateProps {
  /**
   * The stage switcher. This spinner is the ONLY detail view a clean
   * `processing` row has, and the bulk skip and delete guards both refuse that
   * status — so without a control here a tailor that never finishes leaves its
   * row stuck with nothing in the app able to move it.
   */
  stageSwitcher?: React.ReactNode;
}

export const ProcessingState: React.FC<ProcessingStateProps> = ({
  stageSwitcher,
}) => {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 text-center px-4">
      <Loader2 className="h-8 w-8 animate-spin text-status-warn-text" />
      <div className="text-sm font-medium text-foreground/80">
        Processing job...
      </div>
      <p className="text-xs text-muted-foreground max-w-[220px]">
        This job is currently being analyzed by the pipeline. Please wait.
      </p>
      {stageSwitcher ? <div className="pt-1">{stageSwitcher}</div> : null}
    </div>
  );
};
