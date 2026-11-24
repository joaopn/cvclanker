/**
 * Express app factory (useful for tests).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unauthorized } from "@infra/errors";
import {
  apiErrorHandler,
  fail,
  notFoundApiHandler,
  requestContextMiddleware,
} from "@infra/http";
import { logger } from "@infra/logger";
import { verifyToken } from "@server/auth/jwt";
import { getWebLoginConfig } from "@server/auth/web-login";
import cors from "cors";
import express from "express";
import { apiRouter } from "./api/index";
import { pdfFilesRouter } from "./api/routes/pdf-files";
import { mcpBodyErrorHandler, mcpEndpoint } from "./mcp/endpoint";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createAuthGuard() {
  async function isAuthorized(req: express.Request): Promise<boolean> {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) return false;
    const token = authHeader.slice("Bearer ".length).trim();
    try {
      await verifyToken(token);
      return true;
    } catch {
      return false;
    }
  }

  function isPublicReadOnlyRoute(method: string, path: string): boolean {
    const normalizedMethod = method.toUpperCase();
    const normalizedPath = path.split("?")[0] || path;

    if (
      normalizedMethod === "POST" &&
      (normalizedPath === "/api/auth/login" ||
        normalizedPath === "/api/auth/logout")
    )
      return true;

    return false;
  }

  function requiresAuth(method: string, path: string): boolean {
    if (isPublicReadOnlyRoute(method, path)) return false;
    if (method.toUpperCase() === "OPTIONS") return false;

    if (path.startsWith("/api/")) return true;

    return !["GET", "HEAD"].includes(method.toUpperCase());
  }

  const middleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    void (async () => {
      const { enabled } = getWebLoginConfig();
      if (!enabled || !requiresAuth(req.method, req.path)) {
        next();
        return;
      }
      if (await isAuthorized(req)) {
        next();
        return;
      }
      fail(res, unauthorized("Authentication required"));
    })().catch(next);
  };

  return {
    middleware,
    isAuthorized,
    authEnabled: getWebLoginConfig().enabled,
  };
}

export function createApp() {
  const app = express();
  const authGuard = createAuthGuard();
  const corsMiddleware = cors();

  app.use(corsMiddleware);
  app.use(requestContextMiddleware());
  // Body limit must exceed the largest user-configurable text cap. The
  // registry caps top out near 1M chars (≤ ~4 MB UTF-8) plus JSON
  // overhead — 16 MB leaves comfortable headroom while still bounding
  // memory.
  app.use(express.json({ limit: "16mb" }));

  // Logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      logger.info("HTTP request completed", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
      });
    });
    next();
  });

  // The agent endpoint checks its own token, so the web login never sees it.
  app.all("/mcp", mcpEndpoint);
  app.use("/mcp", mcpBodyErrorHandler);

  // Optional authentication for protected routes
  app.use(authGuard.middleware);

  // API routes
  app.use("/api", apiRouter);
  app.use(notFoundApiHandler());

  // Serve generated job PDFs from the job_pdfs BLOB table (same URL shape
  // as the old express.static(data/pdfs) mount).
  app.use("/pdfs", pdfFilesRouter);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Serve client app in production
  if (process.env.NODE_ENV === "production") {
    const clientDir = join(__dirname, "../../dist/client");
    app.use(express.static(clientDir));

    // SPA fallback
    const indexPath = join(clientDir, "index.html");
    let cachedIndexHtml: string | null = null;
    app.get("*", async (req, res) => {
      if (!req.accepts("html")) {
        res.status(404).end();
        return;
      }
      if (!cachedIndexHtml) {
        cachedIndexHtml = await readFile(indexPath, "utf-8");
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(cachedIndexHtml);
    });
  }

  app.use(apiErrorHandler);

  return app;
}
