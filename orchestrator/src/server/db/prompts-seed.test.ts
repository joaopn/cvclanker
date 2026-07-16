// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROMPT_V1 = `name: job-score
description: v1
system: ""
user: score it
`;
const PROMPT_V2 = `name: job-score
description: v2
system: ""
user: score it better
`;
const FRAGMENT = `name: style
template: tone
`;
const USER_EDIT = `name: job-score
description: mine
system: ""
user: my custom scoring
`;

describe.sequential("prompts seed", () => {
  let tempDir: string;
  let promptsDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  async function closeDb() {
    const { closeDb: close } = await import("./index");
    close();
  }

  async function getRow(name: string) {
    const { getPromptRow } = await import("../repositories/prompts");
    return getPromptRow(name);
  }

  async function writePromptFile(relPath: string, content: string) {
    await writeFile(join(promptsDir, relPath), content, "utf8");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-prompts-seed-"));
    promptsDir = join(tempDir, "prompts");
    await mkdir(join(promptsDir, "fragments"), { recursive: true });
    process.env.DATA_DIR = tempDir;
    process.env.PROMPTS_DIR = promptsDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await closeDb();
    delete process.env.PROMPTS_DIR;
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("seeds top-level and fragment prompts on first boot", async () => {
    await writePromptFile("job-score.yaml", PROMPT_V1);
    await writePromptFile(join("fragments", "style.yaml"), FRAGMENT);
    await boot();

    const prompt = await getRow("job-score");
    expect(prompt?.content).toBe(PROMPT_V1);
    expect(prompt?.defaultContent).toBe(PROMPT_V1);

    const fragment = await getRow("fragments/style");
    expect(fragment?.content).toBe(FRAGMENT);
  });

  it("refreshes an UNEDITED row's content and default when the file changes", async () => {
    await writePromptFile("job-score.yaml", PROMPT_V1);
    await boot();
    await closeDb();

    await writePromptFile("job-score.yaml", PROMPT_V2);
    await boot();

    const row = await getRow("job-score");
    expect(row?.content).toBe(PROMPT_V2);
    expect(row?.defaultContent).toBe(PROMPT_V2);
  });

  it("preserves an EDITED row's content and refreshes only the default", async () => {
    await writePromptFile("job-score.yaml", PROMPT_V1);
    await boot();

    const { updatePromptContent } = await import("../repositories/prompts");
    await updatePromptContent("job-score", USER_EDIT);
    await closeDb();

    await writePromptFile("job-score.yaml", PROMPT_V2);
    await boot();

    const row = await getRow("job-score");
    expect(row?.content).toBe(USER_EDIT);
    expect(row?.defaultContent).toBe(PROMPT_V2);
  });

  it("leaves rows in place when their file disappears", async () => {
    await writePromptFile("job-score.yaml", PROMPT_V1);
    await boot();
    await closeDb();

    await rm(join(promptsDir, "job-score.yaml"));
    await boot();

    expect((await getRow("job-score"))?.content).toBe(PROMPT_V1);
  });

  it("boots cleanly when the prompts dir does not exist", async () => {
    await rm(promptsDir, { recursive: true, force: true });
    await boot();

    const { getAllPromptRows } = await import("../repositories/prompts");
    expect(await getAllPromptRows()).toEqual([]);
  });
});
