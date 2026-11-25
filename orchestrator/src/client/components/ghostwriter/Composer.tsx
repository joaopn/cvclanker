import { Eraser, Send, Square } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ComposerProps = {
  disabled?: boolean;
  isStreaming: boolean;
  canReset?: boolean;
  onStop: () => Promise<void>;
  onSend: (content: string) => Promise<void>;
  onReset?: () => void;
  placeholder?: string;
  leading?: React.ReactNode;
};

export const Composer: React.FC<ComposerProps> = ({
  disabled,
  isStreaming,
  canReset,
  onStop,
  onSend,
  onReset,
  placeholder = "Ask anything about this job...",
  leading,
}) => {
  const [value, setValue] = useState("");

  const submit = async () => {
    const content = value.trim();
    if (!content || disabled) return;
    setValue("");
    await onSend(content);
  };

  return (
    <div className="space-y-2">
      <Textarea
        placeholder={placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-h-[84px]"
      />
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pr-2">
          {leading}
          <div className="text-[10px] text-muted-foreground">
            Enter to send, Shift+Enter for a new line
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onReset && (
            <Button
              size="sm"
              variant="outline"
              onClick={onReset}
              disabled={disabled || !canReset}
              aria-label="Clear conversation"
              title="Clear conversation"
              className="h-9 gap-1.5 text-xs text-destructive hover:text-destructive"
            >
              <Eraser className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}

          {isStreaming && (
            <Button
              size="icon"
              variant="outline"
              onClick={() => void onStop()}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}

          <Button
            size="icon"
            onClick={() => void submit()}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            title="Send message"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
};
