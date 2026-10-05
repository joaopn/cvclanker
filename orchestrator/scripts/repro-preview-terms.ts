/**
 * B82 reproducer: the source preview ("Test actor") for a per-term template
 * searched only the profile's first term, so a first term with no matching
 * posting showed "No items returned" for an actor that works. Exits 1 while
 * the preview stops at the empty first term, 0 once it moves on to a term that
 * has postings and reports what it searched; 2 if the harness itself breaks.
 *
 * Drives the real preview route against a freshly migrated temp database,
 * with Apify's API stubbed: the first term's run returns nothing, the
 * second's returns three postings.
 *
 *   npm --workspace orchestrator run repro:preview-terms
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATE = join(import.meta.dirname, "../src/server/db/migrate.ts");
const SCRAPED = 3;

const dataDir = mkdtempSync(join(tmpdir(), "b82-repro-"));
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

const realFetch = globalThis.fetch;
const searched: string[] = [];
let lastKeywords = "";
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
  if (url.pathname.endsWith("/runs")) {
    const input = JSON.parse(String(init?.body ?? "{}")) as {
      keywords?: string;
    };
    lastKeywords = input.keywords ?? "";
    searched.push(lastKeywords);
    return json(run("SUCCEEDED"));
  }
  if (url.pathname.includes("/datasets/")) {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // The first term has no matching posting; the second has three.
    if (offset > 0 || lastKeywords !== "Data Scientist") return json([]);
    return json(
      Array.from({ length: SCRAPED }, (_, n) => ({
        id: `40000000${n}`,
        url: `https://at.linkedin.com/jobs/view/40000000${n}`,
        title: `Data Scientist ${n}`,
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
  name: "B82",
  config: {
    searchTerms: [
      "HPC Infrastructure Architect",
      "Data Scientist",
      "AI Engineer",
    ],
    searchCountry: "austria",
    searchCities: "Vienna|Graz",
  },
});
// Migration seeds a default profile with no terms; the preview reads the
// default one.
await profilesService.setDefaultProfile(profile.id);
const instance = await providersRepo.createProviderInstance({
  providerId: "apify",
  actorRef: "valig/linkedin-jobs-scraper",
  label: "LinkedIn (valig)",
  templateId: "valig-linkedin",
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
  data?: {
    outcome: string;
    samples: unknown[];
    searched?: {
      terms: { term: string; mapped: number; unmapped: number }[];
      place: string;
    };
  };
};
server.close();

const samples = body.data?.samples.length ?? -1;
console.log(
  `preview: outcome=${body.data?.outcome} samples=${samples}; actor searched ${JSON.stringify(searched)}; reported ${JSON.stringify(body.data?.searched)}`,
);
if (searched.length === 0) {
  console.error("✗ setup failed: the actor was never started");
  process.exit(2);
}
const expectedTerms = [
  { term: "HPC Infrastructure Architect", mapped: 0, unmapped: 0 },
  { term: "Data Scientist", mapped: SCRAPED, unmapped: 0 },
];
if (
  samples !== SCRAPED ||
  JSON.stringify(searched) !==
    JSON.stringify(expectedTerms.map(({ term }) => term)) ||
  JSON.stringify(body.data?.searched?.terms) !==
    JSON.stringify(expectedTerms) ||
  body.data?.searched?.place !== "Vienna, Austria"
) {
  console.error(
    "✗ B82: the preview did not move past the empty first term to one with postings, or did not say what it searched",
  );
  process.exit(1);
}
console.log(
  "✓ the preview tries terms until one has postings and says what it searched",
);
process.exit(0);
