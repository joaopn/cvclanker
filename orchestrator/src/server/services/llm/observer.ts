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

  /**
   * Trims the window down to MAX_RECORDS, oldest first — but only ever drops
   * calls that have already finished.
   *
   * Evicting one that is still in flight loses its completion: `finalize`
   * looks the record up by id and silently returns when it is gone, so no
   * terminal `update` is ever emitted and the UI — which learns about
   * completions from those events alone — keeps the row spinning until a page
   * refresh replaces the list from a fresh snapshot. Two-step classification
   * is what surfaced it: every job books a pre-filter record AND a main one,
   * so the window churns twice as fast and a slower call is far likelier to be
   * pushed out mid-flight.
   *
   * Skipping in-flight records cannot grow the window without bound — the
   * number of calls running at once is capped by the LLM concurrency setting.
   */
  private evict() {
    let index = 0;
    while (this.order.length > MAX_RECORDS && index < this.order.length) {
      const id = this.order[index];
      if (id && this.records.get(id)?.status === "running") {
        index += 1;
        continue;
      }
      this.order.splice(index, 1);
      if (id) this.records.delete(id);
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
