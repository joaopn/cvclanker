import { badRequest, toAppError } from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { setupSse, writeSseData } from "@infra/sse";
import * as chatService from "@server/services/assistant-chat";
import { listChatModels } from "@server/services/assistant-chat-models";
import type { ChatStreamEvent } from "@shared/types";
import { Router } from "express";
import { z } from "zod";

export const assistantChatRouter = Router();

const sendMessageSchema = z
  .object({
    content: z.string().trim().min(1),
  })
  .strict();

assistantChatRouter.get(
  "/models",
  asyncRoute(async (_req, res) => {
    ok(res, await listChatModels());
  }),
);

assistantChatRouter.get(
  "/threads",
  asyncRoute(async (_req, res) => {
    ok(res, { threads: await chatService.listChatThreads() });
  }),
);

assistantChatRouter.post(
  "/threads",
  asyncRoute(async (_req, res) => {
    ok(res, { thread: await chatService.createChatThread() });
  }),
);

assistantChatRouter.get(
  "/threads/:id/messages",
  asyncRoute(async (req, res) => {
    ok(res, {
      messages: await chatService.listChatMessages(req.params.id),
    });
  }),
);

assistantChatRouter.post(
  "/threads/:id/messages",
  asyncRoute(async (req, res) => {
    const parsed = sendMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return fail(
        res,
        badRequest(parsed.error.message, parsed.error.flatten()),
      );
    }

    let streaming = false;
    const send = (event: ChatStreamEvent) => {
      if (!streaming) {
        setupSse(res, {
          cacheControl: "no-cache, no-transform",
          flushHeaders: true,
        });
        streaming = true;
        res.on("close", () => {
          if (!res.writableFinished) chatService.cancelChatTurn(req.params.id);
        });
        if (res.destroyed) chatService.cancelChatTurn(req.params.id);
      }
      writeSseData(res, event);
    };

    try {
      await chatService.sendChatMessage({
        threadId: req.params.id,
        content: parsed.data.content,
        stream: send,
      });
    } catch (error) {
      const appError = toAppError(error);
      if (!streaming) return fail(res, appError);
      writeSseData(res, {
        type: "error",
        code: appError.code,
        message: appError.message,
        requestId: String(res.getHeader("x-request-id") ?? "unknown"),
      } satisfies ChatStreamEvent);
    }
    res.end();
  }),
);

assistantChatRouter.post(
  "/threads/:id/cancel",
  asyncRoute(async (req, res) => {
    ok(res, chatService.cancelChatTurn(req.params.id));
  }),
);
