import { describe, expect, it } from "vitest";
import {
  descriptionFingerprint,
  externalIdKey,
  extractBoard,
  extractExternalId,
  hasConflictingExternalIds,
  isLocationCompatible,
  locationTokens,
  MIN_FINGERPRINT_CHARS,
  normalizeDescriptionText,
  normalizeTitleKey,
} from "./duplicate-identity";

describe("extractBoard", () => {
  it("collapses LinkedIn's country subdomains onto one board", () => {
    // The whole reason a board+id rule exists: these are one posting under
    // hosts a URL comparison can never unify.
    for (const host of ["www", "uk", "at", "ie", "ca", "nl"]) {
      expect(
        extractBoard(`https://${host}.linkedin.com/jobs/view/123456`),
      ).toBe("linkedin");
    }
    expect(extractBoard("https://linkedin.com/jobs/view/123456")).toBe(
      "linkedin",
    );
  });

  it("lowercases the host itself", () => {
    // Rows imported before URL canonicalization shipped keep the source's
    // casing, so the caller cannot assume storage did this.
    expect(extractBoard("https://WWW.LinkedIn.com/jobs/view/123456")).toBe(
      "linkedin",
    );
  });

  it("does not match a lookalike host", () => {
    expect(extractBoard("https://notlinkedin.com/jobs/view/123456")).toBeNull();
    expect(
      extractBoard("https://linkedin.com.evil.example/jobs/view/123456"),
    ).toBeNull();
  });

  it("returns null for other boards and unparseable input", () => {
    expect(
      extractBoard("https://jobs.smartrecruiters.com/Acme/744000"),
    ).toBeNull();
    expect(extractBoard("not a url")).toBeNull();
    expect(extractBoard("")).toBeNull();
    expect(extractBoard(null)).toBeNull();
  });
});

describe("extractExternalId", () => {
  it("reads the id from a bare path and from a slug path", () => {
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/4383993915",
      }),
    ).toBe("4383993915");
    expect(
      extractExternalId({
        jobUrl:
          "https://at.linkedin.com/jobs/view/senior-data-architect-at-nagarro-4383993915",
      }),
    ).toBe("4383993915");
  });

  it("is ANCHORED — a 6+ digit number inside the slug is not the job id", () => {
    // THE discriminating case: without the `$`, this captures 191492 out of
    // the slug and merges three unrelated Harnham requisitions. The cases
    // below it are rejected by the length bound alone and would pass with the
    // anchor deleted, so this one is what protects the anchor.
    expect(
      extractExternalId({
        jobUrl:
          "https://uk.linkedin.com/jobs/view/lead-ai-engineer-191492-at-harnham-4455252869",
      }),
    ).toBe("4455252869");
  });

  it("tolerates a trailing slash", () => {
    // 57 real rows carry one, and every id they lose is a posting we already
    // hold under the same id without the slash.
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/4402898413/",
      }),
    ).toBe("4402898413");
  });

  it("ignores LinkedIn URLs that are not job views", () => {
    // A profile and a post also end in digits; sharing a keyspace with job ids
    // is a wrong join waiting to happen.
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/in/someone-123456",
      }),
    ).toBeNull();
    expect(
      extractExternalId({
        jobUrl:
          "https://www.linkedin.com/posts/jane-doe_hiring-activity-7212345678901234567",
      }),
    ).toBeNull();
  });

  it("refuses to digit-strip another board's id shape", () => {
    // Two Workday ids differing only in punctuation would otherwise collide
    // inside the linkedin namespace.
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/apply",
        sourceJobId: "workday___rbc-wd3-rbc/1234/job/Toronto/R-0000123",
      }),
    ).toBeNull();
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/apply",
        sourceJobId: "successfactors___eu_hcm/careers?jobId=1234567",
      }),
    ).toBeNull();
  });

  it("rejects short numbers that cannot be job ids", () => {
    // Slug numbers from "£170,000", "100% remoto" and "9fin" — rejected by the
    // length bound rather than the anchor.
    expect(
      extractExternalId({
        jobUrl:
          "https://uk.linkedin.com/jobs/view/engineer-170-000-at-hunter-bond-4400000001",
      }),
    ).toBe("4400000001");
    expect(
      extractExternalId({
        jobUrl: "https://uk.linkedin.com/jobs/view/dev-100-remoto-at-acme",
      }),
    ).toBeNull();
    expect(
      extractExternalId({ jobUrl: "https://uk.linkedin.com/jobs/view/9fin" }),
    ).toBeNull();
  });

  it("falls back to source_job_id, prefixed or bare", () => {
    // ~19 rows in a real database carry a NULL source_job_id and some carry an
    // `li-` prefix, which is why the path is primary and this is the fallback.
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/apply",
        sourceJobId: "li-4383255214",
      }),
    ).toBe("4383255214");
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/apply",
        sourceJobId: "4383255214",
      }),
    ).toBe("4383255214");
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/apply",
        sourceJobId: null,
      }),
    ).toBeNull();
  });

  it("prefers the path over a disagreeing source_job_id", () => {
    expect(
      extractExternalId({
        jobUrl: "https://www.linkedin.com/jobs/view/4383993915",
        sourceJobId: "li-9999999999",
      }),
    ).toBe("4383993915");
  });

  it("yields no id for a board we do not key on", () => {
    expect(
      extractExternalId({
        jobUrl: "https://jobs.smartrecruiters.com/Acme/744000114351267",
        sourceJobId: "744000114351267",
      }),
    ).toBeNull();
  });
});

describe("externalIdKey", () => {
  it("keys one posting identically across country subdomains and scrapers", () => {
    const viaLinkedIn = externalIdKey({
      jobUrl: "https://www.linkedin.com/jobs/view/4383993915",
      sourceJobId: "li-4383993915",
    });
    const viaApify = externalIdKey({
      jobUrl:
        "https://at.linkedin.com/jobs/view/senior-data-architect-at-nagarro-4383993915",
      sourceJobId: "4383993915",
    });

    expect(viaLinkedIn).toBe("linkedin:4383993915");
    expect(viaApify).toBe(viaLinkedIn);
  });

  it("is null when there is no identity to key on", () => {
    expect(
      externalIdKey({ jobUrl: "https://jobs.example.com/1", sourceJobId: "1" }),
    ).toBeNull();
  });
});

describe("normalizeDescriptionText", () => {
  it("makes markup and plain-text renderings of one ad compare equal", () => {
    // The real cross-board case: hiringcafe stores HTML, the Apify LinkedIn
    // templates strip it before insert.
    const html =
      '<p><strong>Aufgaben</strong></p> <ul type="disc"><li>Build&#xa0;things</li></ul>';
    const plain = "Aufgaben\n\nBuild things";

    expect(normalizeDescriptionText(html)).toBe(
      normalizeDescriptionText(plain),
    );
  });

  it("decodes numeric entities, which stripHtml leaves as literal text", () => {
    expect(normalizeDescriptionText("a&#xa0;b")).toBe(
      normalizeDescriptionText("a b"),
    );
    expect(normalizeDescriptionText("a&#160;b")).toBe(
      normalizeDescriptionText("a b"),
    );
    expect(normalizeDescriptionText("Ben &amp; Jerry")).toBe("ben jerry");
  });

  it("PRESERVES digits so requisition numbers still separate postings", () => {
    // Amazon prints its requisition id in the body, and it is the only thing
    // telling 16 measured same-title/same-location pairs apart. Normalizing
    // digits away would join genuinely different openings.
    const a = normalizeDescriptionText("Role. Job ID: A10379684. Apply now.");
    const b = normalizeDescriptionText("Role. Job ID: A10381950. Apply now.");
    expect(a).not.toBe(b);
  });

  it("ignores markup-only differences", () => {
    expect(normalizeDescriptionText("<p> </p><p>x</p>")).toBe(
      normalizeDescriptionText("<p><strong> </strong></p> <p>x</p>"),
    );
  });
});

describe("descriptionFingerprint", () => {
  it("refuses a description too short to identify anything", () => {
    expect(descriptionFingerprint("Short ad.")).toBeNull();
    expect(descriptionFingerprint("")).toBeNull();
    expect(descriptionFingerprint(null)).toBeNull();
  });

  it("returns the normalized text once it is long enough", () => {
    const long = `We are hiring an engineer. ${"word ".repeat(40)}`;
    expect(descriptionFingerprint(long)).toBe(normalizeDescriptionText(long));
  });
});

describe("normalizeTitleKey", () => {
  it("erases formatting noise but not wording", () => {
    expect(normalizeTitleKey("Senior Data Architect (m/w/d)")).toBe(
      "senior data architect m w d",
    );
    // Deliberately NOT collapsed — these are different titles.
    expect(normalizeTitleKey("Sr. Data Engineer")).not.toBe(
      normalizeTitleKey("Senior Data Engineer"),
    );
  });
});

describe("isLocationCompatible", () => {
  it("accepts administrative-suffix variants of one place", () => {
    expect(
      isLocationCompatible(
        "London, England, UK",
        "London, England, United Kingdom",
      ),
    ).toBe(true);
    expect(
      isLocationCompatible(
        "London, England, United Kingdom",
        "London, London, United Kingdom",
      ),
    ).toBe(true);
  });

  it("ignores workplace-type suffixes", () => {
    expect(
      isLocationCompatible(
        "Vienna, Vienna, Austria | Hybrid",
        "Vienna, Vienna, Austria | On-site",
      ),
    ).toBe(true);
  });

  it("accepts a reordered multi-place list", () => {
    expect(
      isLocationCompatible(
        "Barcelona or Berlin or Vienna",
        "Berlin or Vienna or Barcelona",
      ),
    ).toBe(true);
  });

  it("REJECTS containment between multi-place lists", () => {
    // The two ads offer different location sets — a real difference in the
    // posting, not a rendering difference. Subset alone would accept these.
    expect(
      isLocationCompatible(
        "Dublin or London",
        "Dublin or London or San Francisco",
      ),
    ).toBe(false);
    expect(
      isLocationCompatible(
        "New York City or London or San Francisco",
        "London, England, UK",
      ),
    ).toBe(false);
    expect(
      isLocationCompatible(
        "Europe or Poland or London",
        "Mumbai or London or Asia or Africa",
      ),
    ).toBe(false);
  });

  it("rejects different places", () => {
    expect(isLocationCompatible("Toronto, Ontario, Canada", "Amsterdam")).toBe(
      false,
    );
    expect(
      isLocationCompatible("Edinburgh, Scotland, UK", "London, England, UK"),
    ).toBe(false);
  });

  it("never matches on missing evidence", () => {
    expect(isLocationCompatible(null, "London")).toBe(false);
    expect(isLocationCompatible("", "")).toBe(false);
    expect(isLocationCompatible("Remote", "London")).toBe(false);
  });

  it("does not resolve a city across languages", () => {
    // Known accepted miss: no city gazetteer exists, so this stays a false
    // negative rather than becoming a guess.
    expect(isLocationCompatible("Wien, W, AT", "Vienna, Vienna, Austria")).toBe(
      false,
    );
  });
});

describe("locationTokens", () => {
  it("drops the stopwords the gate depends on", () => {
    expect([...locationTokens("Greater London Area, UK")].sort()).toEqual([
      "london",
    ]);
  });
});

describe("hasConflictingExternalIds", () => {
  it("reports a conflict when one board gives two rows different ids", () => {
    // Live case: three Microsoft "Clinical Specialist" rows in London with
    // byte-identical 4,334-character bodies and three distinct ids. Identical
    // text must not outvote the board's own statement that these are two
    // postings.
    expect(
      hasConflictingExternalIds(
        { jobUrl: "https://uk.linkedin.com/jobs/view/4455739231" },
        { jobUrl: "https://uk.linkedin.com/jobs/view/4455982701" },
      ),
    ).toBe(true);
  });

  it("reports no conflict when the ids agree across subdomains", () => {
    expect(
      hasConflictingExternalIds(
        { jobUrl: "https://www.linkedin.com/jobs/view/4383993915" },
        {
          jobUrl:
            "https://at.linkedin.com/jobs/view/senior-data-architect-4383993915",
        },
      ),
    ).toBe(false);
  });

  it("treats a missing id as absent evidence, not contrary evidence", () => {
    expect(
      hasConflictingExternalIds(
        { jobUrl: "https://uk.linkedin.com/jobs/view/4455739231" },
        { jobUrl: "https://jobs.smartrecruiters.com/Acme/744000114351267" },
      ),
    ).toBe(false);
  });
});

describe("MIN_FINGERPRINT_CHARS", () => {
  it("is the boundary between too-short and usable", () => {
    const justUnder = "a".repeat(MIN_FINGERPRINT_CHARS - 1);
    const exactly = "a".repeat(MIN_FINGERPRINT_CHARS);

    expect(descriptionFingerprint(justUnder)).toBeNull();
    expect(descriptionFingerprint(exactly)).toBe(exactly);
  });
});
