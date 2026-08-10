import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractorRegistry } from "@server/extractors/registry";
import {
  type ExtractorSourceId,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
} from "@shared/extractors";
import type { ExtractorManifest } from "@shared/types";
import { vi } from "vitest";

vi.mock("@server/pipeline/index", () => {
  const progress = {
    step: "idle",
    message: "Ready",
    crawlingSource: null,
    crawlingSourcesCompleted: 0,
    crawlingSourcesTotal: 0,
    crawlingTermsProcessed: 0,
    crawlingTermsTotal: 0,
    crawlingListPagesProcessed: 0,
    crawlingListPagesTotal: 0,
    crawlingJobCardsFound: 0,
    crawlingJobPagesEnqueued: 0,
    crawlingJobPagesSkipped: 0,
    crawlingJobPagesProcessed: 0,
    jobsDiscovered: 0,
    jobsScored: 0,
    jobsProcessed: 0,
    totalToProcess: 0,
  };

  return {
    runPipeline: vi.fn().mockResolvedValue({
      success: true,
      jobsDiscovered: 0,
      jobsProcessed: 0,
    }),
    processJob: vi.fn().mockResolvedValue({ success: true }),
    summarizeJob: vi.fn().mockResolvedValue({ success: true }),
    generateFinalPdf: vi.fn().mockResolvedValue({ success: true }),
    getPipelineStatus: vi.fn(() => ({ isRunning: false })),
    requestPipelineCancel: vi.fn(() => ({
      accepted: false,
      pipelineRunId: null,
      alreadyRequested: false,
    })),
    isPipelineCancelRequested: vi.fn(() => false),
    // `runProfileSequence` must RESOLVE: the route chains `.catch()` on it, so
    // a bare `vi.fn()` returning undefined would 500 every multi-profile test.
    // The claim defaults to grantable and the active flag to false so the new
    // 409 never fires on a pre-existing single-run test.
    runProfileSequence: vi.fn().mockResolvedValue(undefined),
    tryBeginProfileSequence: vi.fn(() => true),
    endProfileSequence: vi.fn(),
    isProfileSequenceActive: vi.fn(() => false),
    requestProfileSequenceCancel: vi.fn(),
    isProfileSequenceCancelRequested: vi.fn(() => false),
    subscribeToProgress: vi.fn((listener: (data: unknown) => void) => {
      listener(progress);
      return () => {};
    }),
    progressHelpers: {
      complete: vi.fn(),
    },
  };
});

vi.mock("@server/services/manualJob", () => ({
  inferManualJobDetails: vi.fn(),
  fetchAndExtractJobContent: vi.fn(),
}));

vi.mock("@server/services/scorer", () => ({
  scoreJobSuitability: vi.fn(),
}));

vi.mock("@server/services/brief", () => ({
  getActivePersonalBrief: vi.fn().mockResolvedValue(""),
}));

const originalEnv = { ...process.env };
const isolatedEnvKeys = [
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "BASIC_AUTH_USER",
  "BASIC_AUTH_PASSWORD",
  "JWT_SECRET",
  "JWT_EXPIRY_SECONDS",
] as const;

const nativeFetch = globalThis.fetch;

function createTestExtractorRegistry(): ExtractorRegistry {
  const manifests = new Map<string, ExtractorManifest>();
  const manifestBySource = new Map<ExtractorSourceId, ExtractorManifest>();

  for (const source of PIPELINE_EXTRACTOR_SOURCE_IDS) {
    const manifest: ExtractorManifest = {
      id: `test-${source}`,
      displayName: `Test ${source}`,
      providesSources: [source],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [],
      }),
    };
    manifests.set(manifest.id, manifest);
    manifestBySource.set(source, manifest);
  }

  return {
    manifests,
    manifestBySource,
    availableSources: [...PIPELINE_EXTRACTOR_SOURCE_IDS],
  };
}

function restoreNativeFetch(): void {
  globalThis.fetch = nativeFetch;
}

export async function startServer(options?: {
  env?: Record<string, string | undefined>;
}): Promise<{
  server: Server;
  baseUrl: string;
  closeDb: () => void;
  tempDir: string;
}> {
  vi.unstubAllGlobals();
  restoreNativeFetch();
  vi.resetModules();
  const tempDir = await mkdtemp(join(tmpdir(), "cvclanker-api-test-"));
  const envOverrides = options?.env ?? {};
  const nextEnv = { ...originalEnv };
  for (const key of isolatedEnvKeys) {
    delete nextEnv[key];
  }
  process.env = {
    ...nextEnv,
    DATA_DIR: tempDir,
    NODE_ENV: "test",
    MODEL: "test-model",
    JOBSPY_SEARCH_TERMS: "alpha|beta",
    ...envOverrides,
  };

  await import("@server/db/migrate");
  const { applyStoredEnvOverrides } = await import(
    "@server/services/envSettings"
  );
  const registryModule = await import("@server/extractors/registry");
  const defaultRegistry = createTestExtractorRegistry();
  if (vi.isMockFunction(registryModule.getExtractorRegistry)) {
    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue(
      defaultRegistry,
    );
  } else {
    vi.spyOn(registryModule, "getExtractorRegistry").mockResolvedValue(
      defaultRegistry,
    );
  }
  const { createApp } = await import("../../app");
  const { closeDb, db, schema } = await import("@server/db/index");
  const { getPipelineStatus } = await import("@server/pipeline/index");
  vi.mocked(getPipelineStatus).mockReturnValue({ isRunning: false });

  // The stub registry invents manifest ids (`test-<platform>`), but migrate
  // seeds `source_configs` from the REAL extractor list — so none of the stub's
  // extractors has a row. In production every registered extractor does (it is
  // the invariant discovery already relies on: a manifest with no enabled row
  // is dropped). Mirror it here, or every run in a route test resolves to zero
  // enabled sources.
  for (const manifest of defaultRegistry.manifests.values()) {
    await db
      .insert(schema.sourceConfigs)
      .values({
        extractorId: manifest.id,
        enabled: true,
        configJson: {},
        mappingsJson: {},
      })
      .onConflictDoNothing();
  }

  await applyStoredEnvOverrides();

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve server address");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    closeDb,
    tempDir,
  };
}

export async function stopServer(args: {
  server: Server;
  closeDb: () => void;
  tempDir?: string;
}) {
  // Defensive: if startServer throws, callers may still run cleanup.
  if (args.server) {
    await new Promise<void>((resolve) => args.server.close(() => resolve()));
  }
  if (args.closeDb) {
    args.closeDb();
  }
  if (args.tempDir) {
    await rm(args.tempDir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  restoreNativeFetch();
  vi.clearAllMocks();
}
