export type ActivityLogKind =
  | "success"
  | "error"
  | "warning"
  | "info"
  | "message";

export interface ActivityLogEntry {
  id: string;
  kind: ActivityLogKind;
  title: string;
  description?: string;
  timestamp: number;
}

const STORAGE_KEY = "cvclanker.activityLog.v1";
const READ_AT_STORAGE_KEY = "cvclanker.activityLog.readAt.v1";
const RING_CAP = 100;

type Subscriber = () => void;

interface ActivityLogState {
  entries: ActivityLogEntry[];
  lastReadAt: number;
}

let state: ActivityLogState = loadFromStorage();
const subscribers = new Set<Subscriber>();

function loadFromStorage(): ActivityLogState {
  if (typeof window === "undefined") {
    return { entries: [], lastReadAt: 0 };
  }
  let entries: ActivityLogEntry[] = [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed.filter(isEntry).slice(-RING_CAP);
      }
    }
  } catch {
    // Corrupted storage — start fresh.
  }
  let lastReadAt = 0;
  try {
    const raw = window.localStorage.getItem(READ_AT_STORAGE_KEY);
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) lastReadAt = parsed;
    }
  } catch {
    // Ignore.
  }
  return { entries, lastReadAt };
}

function isEntry(value: unknown): value is ActivityLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ActivityLogEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.timestamp === "number" &&
    (entry.kind === "success" ||
      entry.kind === "error" ||
      entry.kind === "warning" ||
      entry.kind === "info" ||
      entry.kind === "message")
  );
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
    window.localStorage.setItem(
      READ_AT_STORAGE_KEY,
      String(state.lastReadAt),
    );
  } catch {
    // Quota exceeded or storage disabled — best-effort.
  }
}

function notify(): void {
  for (const sub of subscribers) sub();
}

function nextId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function subscribeActivityLog(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

export function getActivityLogSnapshot(): ActivityLogState {
  return state;
}

export function appendActivityLogEntry(
  input: Omit<ActivityLogEntry, "id" | "timestamp"> & {
    timestamp?: number;
    id?: string;
  },
): void {
  const entry: ActivityLogEntry = {
    id: input.id ?? nextId(),
    kind: input.kind,
    title: input.title,
    description: input.description,
    timestamp: input.timestamp ?? Date.now(),
  };
  const nextEntries = [...state.entries, entry].slice(-RING_CAP);
  state = { ...state, entries: nextEntries };
  persist();
  notify();
}

export function clearActivityLog(): void {
  state = { entries: [], lastReadAt: Date.now() };
  persist();
  notify();
}

export function markActivityLogRead(): void {
  state = { ...state, lastReadAt: Date.now() };
  persist();
  notify();
}

export function getUnreadCount(): number {
  if (state.entries.length === 0) return 0;
  return state.entries.filter((entry) => entry.timestamp > state.lastReadAt)
    .length;
}
