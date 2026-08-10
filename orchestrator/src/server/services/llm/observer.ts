import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { LlmCallRecord } from "@shared/types";
import type { LlmTokenUsage } from "./types";
import { computeTotalTokens } from "./utils/usage";

const MAX_RECORDS = 50;

interface RegisterArgs {
  label: string;
  subject?: string | null;
  model: string;
  jobId?: string | null;
}

interface ObserverHandle {
  succeed: (usage?: LlmTokenUsage | null) => void;
  fail: (errorMessage: string) => void;
}

class LlmCallObserver extends EventEmitter {
  private readonly records = new Map<string, LlmCallRecord>();
  private readonly order: string[] = [];

  snapshot(): LlmCallRecord[] {
    return this.order
      .map((id) => this.records.get(id))
      .filter((record): record is LlmCallRecord => Boolean(record));
  }

  register(args: RegisterArgs): ObserverHandle {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const record: LlmCallRecord = {
      id,
      label: args.label,
      subject: args.subject ?? null,
      model: args.model,
      status: "running",
      startedAt,
      completedAt: null,
      durationMs: null,
      totalTokens: null,
      jobId: args.jobId ?? null,
      errorMessage: null,
    };

    this.records.set(id, record);
    this.order.push(id);
    this.evict();
    this.safeEmit(record);

    const finalize = (
      status: "succeeded" | "failed",
      errorMessage: string | null,
      usage?: LlmTokenUsage | null,
    ) => {
      const current = this.records.get(id);
      if (!current) return;
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - Date.parse(current.startedAt);
      const updated: LlmCallRecord = {
        ...current,
        status,
        completedAt,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        totalTokens: computeTotalTokens(usage),
        errorMessage,
      };
      this.records.set(id, updated);
      this.safeEmit(updated);
    };

    return {
      succeed: (usage) => finalize("succeeded", null, usage),
      fail: (errorMessage) => finalize("failed", errorMessage),
    };
  }

  private evict() {
    while (this.order.length > MAX_RECORDS) {
      const oldest = this.order.shift();
      if (oldest) this.records.delete(oldest);
    }
  }

  private safeEmit(record: LlmCallRecord) {
    try {
      this.emit("update", record);
    } catch {
      // observer must never crash the calling code
    }
  }
}

export const llmCallObserver = new LlmCallObserver();
