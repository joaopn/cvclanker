import { describe, expect, it } from "vitest";
import {
  buildDownloadFilename,
  candidateNamePrefix,
} from "./download-filename";

describe("candidateNamePrefix", () => {
  it.each([
    ["Jane Q. Doe", "Doe_JQ"],
    ["  jane   quinn  doe ", "doe_JQ"],
    ["Madonna", "Madonna"],
    ["García Márquez, Gabriel José", "Garcia_Marquez_GJ"],
    ["Garcia  Marquez,  G", "Garcia_Marquez_G"],
    ["Doe, Jane", "Doe_J"],
    ["Doe, Jane, Quinn", "Doe_JQ"],
    ["Doe,", "Doe"],
    ["King Jr., Martin Luther", "King_Jr_ML"],
    ["João Müller", "Muller_J"],
    ["Søren Weiß", "Weiss_S"],
    ["Æsa Smith", "Smith_A"],
    ["Mary O'Brien", "O_Brien_M"],
    ["Jean-Paul Sartre", "Sartre_JP"],
    ["J.P. Morgan", "Morgan_JP"],
    ["Jean\u2011Paul Sartre", "Sartre_JP"],
    ["Mary Smith-Jones", "Smith_Jones_M"],
    ["Jane Doe 3", "3_JD"],
    ["Jane Doe.", "Doe_J"],
    ["Jane Doe -", "Doe_J"],
    ["Jane Doe 🙂", "Doe_J"],
    ["Иван Smith", "Smith"],
  ])("%j -> %j", (name, expected) => {
    expect(candidateNamePrefix(name)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    ",",
    ", Jane",
    "Иван Петров",
    "Jane Петров",
    "Петров, Jane",
    "...",
  ])("%j is treated as not set", (name) => {
    expect(candidateNamePrefix(name)).toBeNull();
  });
});

describe("buildDownloadFilename", () => {
  it("names a CV and a cover letter with the candidate's name", () => {
    expect(
      buildDownloadFilename({
        candidateName: "Jane Q. Doe",
        kind: "resume",
        employer: "Scientis Search Ltd",
        ext: "pdf",
      }),
    ).toBe("Doe_JQ_resume_Scientis_Search_Ltd.pdf");
    expect(
      buildDownloadFilename({
        candidateName: "Jane Q. Doe",
        kind: "cover",
        employer: "WU Wien",
        ext: "pdf",
      }),
    ).toBe("Doe_JQ_cover_WU_Wien.pdf");
  });

  it("keeps the Word extension", () => {
    expect(
      buildDownloadFilename({
        candidateName: "Jane Q. Doe",
        kind: "resume",
        employer: "Acme",
        ext: "docx",
      }),
    ).toBe("Doe_JQ_resume_Acme.docx");
  });

  it("drops the name part when no name is set", () => {
    expect(
      buildDownloadFilename({
        candidateName: null,
        kind: "resume",
        employer: "Scientis Search Ltd",
        ext: "pdf",
      }),
    ).toBe("resume_Scientis_Search_Ltd.pdf");
    expect(
      buildDownloadFilename({
        candidateName: "  ",
        kind: "cover",
        employer: "WU Wien",
        ext: "pdf",
      }),
    ).toBe("cover_WU_Wien.pdf");
  });

  it("folds accents in the company and keeps today's rule for the rest", () => {
    expect(
      buildDownloadFilename({
        candidateName: null,
        kind: "resume",
        employer: "Zürich Versicherung, Inc.",
        ext: "pdf",
      }),
    ).toBe("resume_Zurich_Versicherung__Inc_.pdf");
  });

  it("names a missing company Unknown", () => {
    for (const employer of [null, undefined, "", "!!!"]) {
      expect(
        buildDownloadFilename({
          candidateName: null,
          kind: "cover",
          employer,
          ext: "pdf",
        }),
      ).toBe("cover_Unknown.pdf");
    }
  });
});
