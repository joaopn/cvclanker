import { describe, expect, it } from "vitest";
import { canonicalizeJobUrl } from "./job-url";

describe("canonicalizeJobUrl", () => {
  it("collapses LinkedIn URLs that differ only by tracking params", () => {
    const a =
      "https://www.linkedin.com/jobs/view/senior-engineer-at-example-2000005810/?refId=Ex1%2B%2BampleRefIdAAAAw%3D%3D&trackingId=ExampleTrackingIdAAAAw%3D%3D";
    const b =
      "https://www.linkedin.com/jobs/view/senior-engineer-at-example-2000005810/?refId=Ex%2FampleRefIdBB%2FBBBBw%3D%3D&trackingId=ExampleT%2BrackingIdBBBBw%3D%3D";
    expect(canonicalizeJobUrl(a)).toBe(canonicalizeJobUrl(b));
    expect(canonicalizeJobUrl(a)).toBe(
      "https://www.linkedin.com/jobs/view/senior-engineer-at-example-2000005810/",
    );
  });

  it("strips utm_* and ad-click params", () => {
    expect(
      canonicalizeJobUrl(
        "https://jobs.example.com/p/123?utm_source=x&utm_medium=email&gclid=abc&fbclid=def",
      ),
    ).toBe("https://jobs.example.com/p/123");
  });

  it("preserves params that carry job identity", () => {
    expect(
      canonicalizeJobUrl("https://www.indeed.com/viewjob?jk=abc123&from=serp&tk=xyz"),
    ).toBe("https://www.indeed.com/viewjob?jk=abc123");
    expect(
      canonicalizeJobUrl(
        "https://www.linkedin.com/jobs/collections/?currentJobId=999&trackingId=zzz",
      ),
    ).toBe("https://www.linkedin.com/jobs/collections/?currentJobId=999");
  });

  it("drops the fragment", () => {
    expect(canonicalizeJobUrl("https://x.com/job/1#apply")).toBe(
      "https://x.com/job/1",
    );
  });

  it("returns the trimmed input when it is not a parseable URL", () => {
    expect(canonicalizeJobUrl("  not a url  ")).toBe("not a url");
    expect(canonicalizeJobUrl("")).toBe("");
  });
});
