import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
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
import { isChatHiddenPath, useChat } from "./ChatContext";

export const ChatButton: React.FC = () => {
  const location = useLocation();
  const { isOpen, toggle, openThread, newChat } = useChat();
  const [menuOpen, setMenuOpen] = useState(false);

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
        className="gap-1.5 rounded-r-none"
      >
        <MessageSquare className="h-4 w-4" />
        Chat
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Saved chats"
            className="rounded-l-none border-l-0 px-2"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
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
