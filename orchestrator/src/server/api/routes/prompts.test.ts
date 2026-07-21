import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./test-utils";

const SCORE_PROMPT = `name: job-score
description: scoring
system: ""
user: score {{jobTitle}}
`;
const FRAGMENT = `name: style
description: style fragment
template: tone words
`;
const VALID_EDIT = `name: job-score
description: my scoring
system: ""
user: my scoring text
`;

describe.sequential("Prompts API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let promptsDir: string;

  beforeEach(async () => {
    promptsDir = await mkdtemp(join(tmpdir(), "cvclanker-prompts-fixture-"));
    await mkdir(join(promptsDir, "fragments"), { recursive: true });
    await writeFile(join(promptsDir, "job-score.yaml"), SCORE_PROMPT, "utf8");
    await writeFile(
      join(promptsDir, "fragments", "style.yaml"),
      FRAGMENT,
      "utf8",
    );
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: { PROMPTS_DIR: promptsDir },
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
    await rm(promptsDir, { recursive: true, force: true });
  });

  it("lists seeded prompts with edited=false", async () => {
    const res = await fetch(`${baseUrl}/api/prompts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.data.prompts.map(
      (p: { name: string; edited: boolean }) => p.name,
    );
    expect(names).toContain("job-score");
    expect(names).toContain("fragments/style");
    const score = body.data.prompts.find(
      (p: { name: string }) => p.name === "job-score",
    );
    expect(score.edited).toBe(false);
  });

  it("returns one prompt's content and 404s on unknown names", async () => {
    const res = await fetch(`${baseUrl}/api/prompts/job-score`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content).toBe(SCORE_PROMPT);
    expect(body.data.defaultContent).toBe(SCORE_PROMPT);
    expect(body.data.edited).toBe(false);

    const missing = await fetch(`${baseUrl}/api/prompts/nope`);
    expect(missing.status).toBe(404);
  });

  it("saves a valid edit and round-trips it with edited=true", async () => {
    const put = await fetch(`${baseUrl}/api/prompts/job-score`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: VALID_EDIT }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.data.edited).toBe(true);

    const res = await fetch(`${baseUrl}/api/prompts/job-score`);
    const body = await res.json();
    expect(body.data.content).toBe(VALID_EDIT);
    expect(body.data.defaultContent).toBe(SCORE_PROMPT);
  });

  it("422s on invalid YAML and on a missing fragment reference", async () => {
    const badYaml = await fetch(`${baseUrl}/api/prompts/job-score`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "not: valid: yaml:\n  - [oops" }),
    });
    expect(badYaml.status).toBe(422);

    const badPartial = await fetch(`${baseUrl}/api/prompts/job-score`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: 'name: job-score\nsystem: "{{> nope}}"\nuser: ""\n',
      }),
    });
    expect(badPartial.status).toBe(422);
  });

  it("400s on an over-cap body and 404s a PUT to an unknown prompt", async () => {
    const oversize = await fetch(`${baseUrl}/api/prompts/job-score`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `x`.repeat(200_001) }),
    });
    expect(oversize.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/api/prompts/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: VALID_EDIT }),
    });
    expect(unknown.status).toBe(404);
  });

  it("resets an edited prompt back to its default", async () => {
    await fetch(`${baseUrl}/api/prompts/job-score`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: VALID_EDIT }),
    });

    const reset = await fetch(`${baseUrl}/api/prompts/job-score/reset`, {
      method: "POST",
    });
    expect(reset.status).toBe(200);
    const body = await reset.json();
    expect(body.data.content).toBe(SCORE_PROMPT);
    expect(body.data.edited).toBe(false);
  });

  it("reloads a prompt with required variables without rendering it", async () => {
    // job-score's user template references {{jobTitle}}. A render-based reload
    // 500s on the missing variable (B1); structural revalidation must not
    // render, so a named reload succeeds.
    const named = await fetch(`${baseUrl}/api/prompts/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "job-score" }),
    });
    expect(named.status).toBe(200);
    expect((await named.json()).data.reloaded).toBe("job-score");

    // Unknown name is a clean 404, not a 500.
    const missing = await fetch(`${baseUrl}/api/prompts/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(missing.status).toBe(404);

    // No name clears the whole cache.
    const all = await fetch(`${baseUrl}/api/prompts/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(all.status).toBe(200);
    expect((await all.json()).data.reloaded).toBe("all");
  });

  it("serves and edits fragments via the /fragments/:name routes", async () => {
    const res = await fetch(`${baseUrl}/api/prompts/fragments/style`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("fragments/style");
    expect(body.data.content).toBe(FRAGMENT);

    const edited = `name: style\ndescription: style fragment\ntemplate: other words\n`;
    const put = await fetch(`${baseUrl}/api/prompts/fragments/style`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: edited }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).data.edited).toBe(true);
  });
});
