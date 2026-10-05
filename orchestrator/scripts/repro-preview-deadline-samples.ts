/**
 * B81 reproducer: an Apify source preview ("Test actor") that reaches its
 * deadline aborts the actor run and should still show what the run scraped as
 * samples. Exits 1 while the preview returns none, 0 once it returns them.
 *
 * Drives the real preview route against a freshly migrated temp database, with
 * Apify's API stubbed: the run stays RUNNING until it is aborted, and the
 * clock jumps past the preview's 300s deadline once the run has started.
 *
 *   npm --workspace orchestrator run repro:preview-samples
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATE = join(import.meta.dirname, "../src/server/db/migrate.ts");
const SCRAPED = 3;

const dataDir = mkdtempSync(join(tmpdir(), "b81-repro-"));
// `process.exit` skips `finally`; an exit hook covers every path.
process.on("exit", () => {
  rmSync(dataDir, { recursive: true, force: true });
});
// Exit 1 means the bug reproduced; a harness that broke on its own is 2.
const harnessBroke = (error: unknown) => {
  console.error("✗ harness failed:", error);
  process.exit(2);
};
process.on("uncaughtException", harnessBroke);
process.on("unhandledRejection", harnessBroke);

execFileSync("npx", ["tsx", MIGRATE], {
  env: { ...process.env, DATA_DIR: dataDir },
  stdio: "ignore",
});
process.env.DATA_DIR = dataDir;

// The route reads the clock to enforce its deadline; jump it forward once the
// actor run has started, as if the run had been going for over five minutes.
let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockOffsetMs;

const realFetch = globalThis.fetch;
let aborted = false;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const run = (status: string) => ({
  data: {
    id: "run-1",
    status,
    defaultDatasetId: "ds-1",
    options: { timeoutSecs: 1200 },
  },
});
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.apify.com") return realFetch(input, init);
  if (url.pathname.endsWith("/abort")) {
    aborted = true;
    return json(run("ABORTING"));
  }
  if (url.pathname.endsWith("/runs")) {
    clockOffsetMs = 301_000;
    return json(run("RUNNING"));
  }
  if (url.pathname.includes("/actor-runs/")) {
    return json(run(aborted ? "ABORTED" : "RUNNING"));
  }
  if (url.pathname.includes("/datasets/")) {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (offset > 0) return json([]);
    return json(
      Array.from({ length: SCRAPED }, (_, n) => ({
        jobUrl: `https://www.linkedin.com/jobs/view/40000000${n}`,
        jobTitle: `Data Scientist ${n}`,
        companyName: "ACME",
      })),
    );
  }
  throw new Error(`unexpected Apify call: ${url}`);
};

const express = (await import("express")).default;
const { providerInstancesRouter } = await import(
  "../src/server/api/routes/provider-instances"
);
const settingsRepo = await import("../src/server/repositories/settings");
const profilesRepo = await import("../src/server/repositories/profiles");
const profilesService = await import("../src/server/services/profiles");
const providersRepo = await import(
  "../src/server/repositories/provider-instances"
);

await settingsRepo.setSetting("apifyApiToken", "tok");
const profile = await profilesRepo.createProfile({
  name: "B81",
  config: { searchTerms: ["Data Scientist"], searchCountry: "austria" },
});
// Migration seeds a default profile with no terms; the preview reads the
// default one.
await profilesService.setDefaultProfile(profile.id);
const instance = await providersRepo.createProviderInstance({
  providerId: "apify",
  actorRef: "cheap_scraper/linkedin-job-scraper",
  label: "LinkedIn (cheap_scraper)",
  templateId: "cheap-scraper-linkedin",
  inputTemplateJson: "{}",
});

const app = express();
app.use(express.json());
app.use("/api/provider-instances", providerInstancesRouter);
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;

const response = await realFetch(
  `http://127.0.0.1:${port}/api/provider-instances/${instance.id}/test`,
  { method: "POST" },
);
const body = (await response.json()) as {
  data?: { outcome: string; samples: unknown[]; totalMapped: number };
};
server.close();

const samples = body.data?.samples.length ?? -1;
console.log(
  `preview after the deadline: outcome=${body.data?.outcome} samples=${samples} (run scraped ${SCRAPED}, aborted=${aborted})`,
);
if (!aborted) {
  console.error("✗ setup failed: the run was never aborted at the deadline");
  process.exit(2);
}
if (samples !== SCRAPED) {
  console.error(
    `✗ B81: the deadline-aborted run scraped ${SCRAPED} rows but the preview shows ${samples}`,
  );
  process.exit(1);
}
console.log("✓ the preview keeps what the deadline-aborted run scraped");
process.exit(0);
