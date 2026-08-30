/**
 * API routes for the orchestrator.
 */

import { Router } from "express";
import { authRouter } from "./routes/auth";
import { coverLetterRouter } from "./routes/coverletter";
import { cvRouter } from "./routes/cv";
import { databaseRouter } from "./routes/database";
import { extractorHealthRouter } from "./routes/extractor-health";
import { ghostwriterRouter } from "./routes/ghostwriter";
import { jobsRouter } from "./routes/jobs";
import { llmCallsRouter } from "./routes/llm-calls";
import { manualJobsRouter } from "./routes/manual-jobs";
import { onboardingRouter } from "./routes/onboarding";
import { pipelineRouter } from "./routes/pipeline";
import { profilesRouter } from "./routes/profiles";
import { promptsRouter } from "./routes/prompts";
import { providerInstancesRouter } from "./routes/provider-instances";
import { schedulesRouter } from "./routes/schedules";
import { scoringBenchRouter } from "./routes/scoring-bench";
import { settingsRouter } from "./routes/settings";
import { sourceConfigsRouter } from "./routes/source-configs";
import { userProfilesRouter } from "./routes/user-profiles";

export const apiRouter = Router();

apiRouter.use("/jobs", jobsRouter);
apiRouter.use("/jobs/:id/chat", ghostwriterRouter);
apiRouter.use("/settings", settingsRouter);
apiRouter.use("/pipeline", pipelineRouter);
apiRouter.use("/schedules", schedulesRouter);
apiRouter.use("/manual-jobs", manualJobsRouter);
apiRouter.use("/llm/calls", llmCallsRouter);
apiRouter.use("/cv", cvRouter);
apiRouter.use("/coverletter", coverLetterRouter);
apiRouter.use("/database", databaseRouter);
apiRouter.use("/onboarding", onboardingRouter);
apiRouter.use("/prompts", promptsRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/source-configs", sourceConfigsRouter);
apiRouter.use("/provider-instances", providerInstancesRouter);
apiRouter.use("/profiles", profilesRouter);
apiRouter.use("/user-profiles", userProfilesRouter);
apiRouter.use("/scoring-bench", scoringBenchRouter);
apiRouter.use("/", extractorHealthRouter);
