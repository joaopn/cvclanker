import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export const CHAT_OPEN_STORAGE_KEY = "cvclanker:chat:open";
export const CHAT_THREAD_STORAGE_KEY = "cvclanker:chat:threadId";

const CHAT_HIDDEN_PATHS = ["/sign-in", "/onboarding"];

export function isChatHiddenPath(pathname: string): boolean {
  return CHAT_HIDDEN_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

interface ChatContextValue {
  isOpen: boolean;
  threadId: string | null;
  toggle: () => void;
  close: () => void;
  openThread: (threadId: string) => void;
  newChat: () => void;
  setThreadId: (threadId: string | null) => void;
}

const noop = () => {};

const ChatContext = createContext<ChatContextValue>({
  isOpen: false,
  threadId: null,
  toggle: noop,
  close: noop,
  openThread: noop,
  newChat: noop,
  setThreadId: noop,
});

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the chat state lasts until the next reload.
  }
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [isOpen, setIsOpen] = useState(
    () => readStored(CHAT_OPEN_STORAGE_KEY) === "true",
  );
  const [threadId, setThreadId] = useState<string | null>(() =>
    readStored(CHAT_THREAD_STORAGE_KEY),
  );

  useEffect(() => {
    writeStored(CHAT_OPEN_STORAGE_KEY, String(isOpen));
  }, [isOpen]);

  useEffect(() => {
    writeStored(CHAT_THREAD_STORAGE_KEY, threadId);
  }, [threadId]);

  const toggle = useCallback(() => setIsOpen((open) => !open), []);
  const close = useCallback(() => setIsOpen(false), []);
  const openThread = useCallback((id: string) => {
    setThreadId(id);
    setIsOpen(true);
  }, []);
  const newChat = useCallback(() => {
    setThreadId(null);
    setIsOpen(true);
  }, []);

  const value = useMemo(
    () => ({
      isOpen,
      threadId,
      toggle,
      close,
      openThread,
      newChat,
      setThreadId,
    }),
    [isOpen, threadId, toggle, close, openThread, newChat],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export function useChat(): ChatContextValue {
  return useContext(ChatContext);
}
