/**
 * Bottom action bar for the Swipe deck — tap-target equivalents of the
 * swipe gestures, plus the gesture-less Backlog action.
 */

import { Archive, Check, RotateCcw, X } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";

interface SwipeActionBarProps {
  disabled: boolean;
  canUndo: boolean;
  onSkip: () => void;
  onBacklog: () => void;
  onTailor: () => void;
  onUndo: () => void;
}

export const SwipeActionBar: React.FC<SwipeActionBarProps> = ({
  disabled,
  canUndo,
  onSkip,
  onBacklog,
  onTailor,
  onUndo,
}) => {
  return (
    <div className="relative flex items-center justify-center gap-6 px-4">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={!canUndo}
        onClick={onUndo}
        aria-label="Undo last swipe"
        className="absolute left-4 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full text-muted-foreground"
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        onClick={onSkip}
        aria-label="Skip"
        className="h-14 w-14 rounded-full border-status-bad/40 text-status-bad-text hover:bg-status-bad/10 hover:text-status-bad-text"
      >
        <X className="h-6 w-6" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        onClick={onBacklog}
        aria-label="Move to backlog"
        className="h-12 w-12 rounded-full text-muted-foreground"
      >
        <Archive className="h-5 w-5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        onClick={onTailor}
        aria-label="Tailor"
        className="h-14 w-14 rounded-full border-status-good/40 text-status-good-text hover:bg-status-good/10 hover:text-status-good-text"
      >
        <Check className="h-6 w-6" />
      </Button>
    </div>
  );
};
