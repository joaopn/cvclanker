/**
 * Express server entry point.
 */

import "./config/env";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { createApp } from "./app";
import { initializeExtractorRegistry } from "./extractors/registry";
import { deleteExpiredOrRevokedAuthSessions } from "./repositories/auth-sessions";
import { reconcileTransientStatuses } from "./repositories/jobs";
import { applyStoredEnvOverrides } from "./services/envSettings";

const AUTH_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function cleanupAuthSessions(trigger: "startup" | "interval") {
  try {
    await deleteExpiredOrRevokedAuthSessions();
    logger.debug("Auth session cleanup completed", { trigger });
  } catch (error) {
    logger.warn("Auth session cleanup failed", {
      trigger,
      error: sanitizeUnknown(error),
    });
  }
}

async function startServer() {
  await applyStoredEnvOverrides();
  try {
    await initializeExtractorRegistry();
  } catch (error) {
    const sanitizedError = sanitizeUnknown(error);
    logger.error("Failed to initialize extractor registry", {
      error: sanitizedError,
    });
    if (process.env.NODE_ENV === "production") {
      logger.error(
        "Extractor registry initialization failed in production. Shutting down server.",
      );
      process.exit(1);
    }

    logger.error(
      "Extractor registry initialization failed outside production. Server startup aborted.",
    );
    return;
  }

  try {
    const reconciled = await reconcileTransientStatuses();
    if (reconciled.processing > 0 || reconciled.selected > 0) {
      logger.info("Reconciled transient job statuses on startup", reconciled);
    }
  } catch (error) {
    logger.warn("Failed to reconcile transient job statuses", {
      error: sanitizeUnknown(error),
    });
  }

  const app = createApp();
  const PORT = process.env.PORT || 3001;
  const HOST_PORT = process.env.HOST_PORT;
  const accessUrl = HOST_PORT
    ? `http://localhost:${HOST_PORT}`
    : `http://localhost:${PORT}`;

  app.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 CV Clanker                                           ║
║                                                           ║
║   Open in browser: ${accessUrl}
║   (container listening on :${PORT})
║                                                           ║
║   API:     ${accessUrl}/api
║   Health:  ${accessUrl}/health
║   PDFs:    ${accessUrl}/pdfs
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

    try {
      await cleanupAuthSessions("startup");
      setInterval(() => {
        void cleanupAuthSessions("interval");
      }, AUTH_SESSION_CLEANUP_INTERVAL_MS);
    } catch (error) {
      logger.warn("Failed to initialize auth session cleanup", {
        error: sanitizeUnknown(error),
      });
    }
  });
}

void startServer();
