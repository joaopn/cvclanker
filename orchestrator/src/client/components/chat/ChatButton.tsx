import * as api from "@client/api";
import { invalidateSettingsData } from "@client/hooks/queries/invalidate";
import { useSettings } from "@client/hooks/useSettings";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, MessageSquare, Plus } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { isChatHiddenPath, useChat } from "./ChatContext";

// Saving errors are handled on the mutation itself, so the toast still shows
// when the button unmounts mid-save (the top bar toggling, a page change).
function useChatModeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatCanChangeJobs: boolean) =>
      api.updateSettings({ chatCanChangeJobs }),
    onSuccess: async () => {
      await invalidateSettingsData(queryClient);
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Failed to save the setting",
      ),
  });
}

// The row is the menu item, so the arrow keys reach it; flipping it keeps the
// menu open. The switch inside only shows the state.
const ChatModeItem: React.FC<{
  mutation: ReturnType<typeof useChatModeMutation>;
  locked: boolean;
}> = ({ mutation, locked }) => {
  const { chatCanChangeJobs, isLoading } = useSettings();
  const checked = mutation.isPending
    ? (mutation.variables ?? chatCanChangeJobs)
    : chatCanChangeJobs;
  const disabled = locked || isLoading || mutation.isPending;

  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onSelect={(event) => {
        event.preventDefault();
        mutation.mutate(!checked);
      }}
      className="gap-2"
    >
      <Switch
        checked={checked}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none"
      />
      <span>Can change jobs</span>
    </DropdownMenuItem>
  );
};

export const ChatButton: React.FC<{ compact?: boolean }> = ({
  compact = false,
}) => {
  const location = useLocation();
  const { isOpen, toggle, openThread, newChat, isAnswering } = useChat();
  const [menuOpen, setMenuOpen] = useState(false);
  const modeMutation = useChatModeMutation();

  const threadsQuery = useQuery({
    queryKey: queryKeys.chat.threads(),
    queryFn: () => api.listChatThreads(),
    enabled: menuOpen,
    staleTime: 0,
  });

  if (isChatHiddenPath(location.pathname)) return null;

  const threads = [...(threadsQuery.data?.threads ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <div className="flex items-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={toggle}
        aria-pressed={isOpen}
        className={cn("gap-1.5 rounded-r-none", compact && "h-6 px-2 text-xs")}
      >
        <MessageSquare className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        Chat
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Saved chats"
            className={cn(
              "rounded-l-none border-l-0 px-2",
              compact && "h-6 px-1.5",
            )}
          >
            <ChevronDown className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <ChatModeItem mutation={modeMutation} locked={isAnswering} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={newChat}>
            <Plus className="h-4 w-4" />
            New chat
          </DropdownMenuItem>
          {threadsQuery.isLoading && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading chats…
            </div>
          )}
          {threads.length > 0 && <DropdownMenuSeparator />}
          {threads.map((thread) => (
            <DropdownMenuItem
              key={thread.id}
              onSelect={() => openThread(thread.id)}
              className="flex items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {thread.title ?? "New chat"}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(thread.updatedAt).toLocaleDateString()}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
