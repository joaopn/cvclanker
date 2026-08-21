import { describe, expect, it, vi } from "vitest";
import {
  mapWwrItem,
  parseRssItems,
  runWeWorkRemotely,
  stripHtml,
} from "../src/run";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const DAY_MS = 86_400_000;

function rssItem(args: {
  title?: string;
  region?: string;
  category?: string;
  type?: string;
  pubDate?: string;
  link?: string;
  description?: string;
}): string {
  // Shape mirrors the live feed (probed 2026-08-21): entity-encoded titles,
  // CDATA descriptions, a <region> eligibility tag.
  const {
    title = "Acme: Senior Full-Stack Engineer",
    region = "Anywhere in the World",
    category = "Full-Stack Programming",
    type = "Full-Time",
    pubDate = new Date(NOW - DAY_MS).toUTCString(),
    link = "https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer",
    description = "<![CDATA[<p>Build &amp; ship things.</p>]]>",
  } = args;
  return `<item>
    <title>${title.replace(/&/g, "&amp;")}</title>
    <region>${region}</region>
    <category>${category}</category>
    <type>${type}</type>
    <pubDate>${pubDate}</pubDate>
    <link>${link}</link>
    <guid>${link}</guid>
    <description>${description}</description>
  </item>`;
}

function feed(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function feedResponse(items: string[]): Response {
  return new Response(feed(items), {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
}

describe("parseRssItems + mapWwrItem", () => {
  it("parses the feed grammar and splits Company: Title", () => {
    const [item] = parseRssItems(feed([rssItem({})]));
    expect(item).toMatchObject({
      title: "Acme: Senior Full-Stack Engineer",
      region: "Anywhere in the World",
      category: "Full-Stack Programming",
      jobType: "Full-Time",
    });

    const mapped = mapWwrItem(item);
    expect(mapped).toMatchObject({
      source: "weworkremotely",
      title: "Senior Full-Stack Engineer",
      employer: "Acme",
      jobUrl:
        "https://weworkremotely.com/remote-jobs/acme-senior-full-stack-engineer",
      location: "Anywhere in the World",
      jobFunction: "Full-Stack Programming",
      jobType: "Full-Time",
      isRemote: true,
    });
    expect(mapped?.jobDescription).toBe("Build & ship things.");
    expect(mapped?.datePosted).toBe(new Date(NOW - DAY_MS).toISOString());
  });

  it("carries a restricted region into the evidence", () => {
    const [item] = parseRssItems(feed([rssItem({ region: "USA Only" })]));
    const mapped = mapWwrItem(item);
    expect(mapped?.location).toBe("USA Only");
    expect(mapped?.jobDescription).toBe("Build & ship things.");
    expect(mapped?.locationEvidence).toMatchObject({
      location: "USA Only",
      isRemote: true,
      source: "weworkremotely",
    });
  });

  it("keeps an un-splittable title whole with an unknown employer", () => {
    const [item] = parseRssItems(feed([rssItem({ title: "Standalone role" })]));
    expect(mapWwrItem(item)).toMatchObject({
      title: "Standalone role",
      employer: "Unknown Employer",
    });
  });

  it("keeps entity-encoded markup in a CDATA description as text", () => {
    // Pre-fix, tagContent entity-decoded CDATA content, turning "Vec&lt;T&gt;"
    // into a real tag that stripHtml then deleted ("knows Vec well").
    const [item] = parseRssItems(
      feed([
        rssItem({
          description: "<![CDATA[<p>knows Vec&lt;T&gt; well</p>]]>",
        }),
      ]),
    );
    expect(item.description).toBe("<p>knows Vec&lt;T&gt; well</p>");
    expect(mapWwrItem(item)?.jobDescription).toBe("knows Vec<T> well");
  });

  it("returns null for an item without a link", () => {
    const [item] = parseRssItems(
      feed(["<item><title>Acme: Role</title></item>"]),
    );
    expect(mapWwrItem(item)).toBeNull();
  });
});

describe("stripHtml", () => {
  it("flattens tags and decodes entities", () => {
    expect(stripHtml("<p>a &amp; b</p><p>c&nbsp;d</p>")).toBe("a & b\nc d");
  });

  it("keeps entity-encoded literal markup as text, single-decoded", () => {
    // CDATA descriptions carry entity-encoded code samples; they must come
    // out as text, never be double-decoded into a tag and stripped.
    expect(stripHtml("<p>knows Vec&amp;lt;T&amp;gt; well</p>")).toBe(
      "knows Vec&lt;T&gt; well",
    );
  });
});

describe("runWeWorkRemotely", () => {
  it("walks each configured feed once, dedupes across feeds, filters terms", async () => {
    const shared = rssItem({});
    const other = rssItem({
      title: "Beta: DevOps Engineer",
      link: "https://weworkremotely.com/remote-jobs/beta-devops-engineer",
      category: "DevOps and Sysadmin",
    });
    const miss = rssItem({
      title: "Gamma: Account Executive",
      link: "https://weworkremotely.com/remote-jobs/gamma-account-executive",
      category: "Sales",
      description: "<![CDATA[Sell things]]>",
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([shared, miss]))
      .mockResolvedValueOnce(feedResponse([shared, other]));

    const result = await runWeWorkRemotely({
      searchTerms: ["engineer"],
      categories: ["feed-a", "feed-b"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Senior Full-Stack Engineer",
      "DevOps Engineer",
    ]);
    expect(result.droppedCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://weworkremotely.com/categories/feed-a.rss",
    );
  });

  it("skips items outside the window without ending the feed", async () => {
    const fresh = rssItem({});
    const stale = rssItem({
      title: "Old Co: Ancient Engineer",
      link: "https://weworkremotely.com/remote-jobs/old-co-ancient-engineer",
      pubDate: new Date(NOW - 40 * DAY_MS).toUTCString(),
    });
    const alsoFresh = rssItem({
      title: "New Co: Recent Engineer",
      link: "https://weworkremotely.com/remote-jobs/new-co-recent-engineer",
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([fresh, stale, alsoFresh]));

    const result = await runWeWorkRemotely({
      searchTerms: ["engineer"],
      categories: ["feed-a"],
      maxAgeDays: 7,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs.map((job) => job.employer)).toEqual(["Acme", "New Co"]);
  });

  it("tolerates one failing feed and keeps the others' jobs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("gone", { status: 500 }))
      .mockResolvedValueOnce(feedResponse([rssItem({})]));

    const result = await runWeWorkRemotely({
      searchTerms: ["engineer"],
      categories: ["broken", "healthy"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
  });

  it("fails only when every feed failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("gone", { status: 500 }));

    const result = await runWeWorkRemotely({
      categories: ["a", "b"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("counts unmappable items", async () => {
    const broken =
      "<item><title>Acme: Role</title><region>Anywhere in the World</region></item>";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse([rssItem({}), broken]));

    const result = await runWeWorkRemotely({
      categories: ["feed-a"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it("stops at the job cap", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      rssItem({
        title: `Co${index}: Engineer ${index}`,
        link: `https://weworkremotely.com/remote-jobs/co-${index}`,
      }),
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(feedResponse(items));

    const result = await runWeWorkRemotely({
      categories: ["feed-a", "feed-b"],
      maxJobs: 10,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(10);
    // Cap already met — the second feed is never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("contributes nothing when the profile unticked remote", async () => {
    const fetchImpl = vi.fn();
    const result = await runWeWorkRemotely({
      workplaceTypes: ["onsite"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns partial results on cancellation, not a failure", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(feedResponse([rssItem({})]));
    });
    const result = await runWeWorkRemotely({
      categories: ["a", "b"],
      shouldCancel: () => calls >= 1,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
