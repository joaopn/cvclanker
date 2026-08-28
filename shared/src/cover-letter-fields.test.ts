import { describe, expect, it } from "vitest";
import { coverLetterJobBaseline } from "./cover-letter-fields";
import { createCoverLetterDocument } from "./testing/factories";

const doc = createCoverLetterDocument({
  fields: [
    { id: "recipient", role: "name", value: "Acme Corp" },
    { id: "letter.body", role: "body", value: "Dear Acme,\n\nI am writing…" },
  ],
  defaultFieldValues: {
    recipient: "Acme Corp",
    "letter.body": "Dear Acme,\n\nI am writing…",
  },
});

describe("coverLetterJobBaseline", () => {
  it("blanks the body field and leaves every other default in place", () => {
    expect(coverLetterJobBaseline(doc)).toEqual({
      recipient: "Acme Corp",
      "letter.body": "",
    });
  });

  it("never mutates the document's own defaults", () => {
    coverLetterJobBaseline(doc);
    expect(doc.defaultFieldValues["letter.body"]).toBe(
      "Dear Acme,\n\nI am writing…",
    );
  });

  it("passes the defaults through untouched when no field claims the body role", () => {
    const bodyless = createCoverLetterDocument({
      fields: [{ id: "recipient", role: "name", value: "Acme Corp" }],
      defaultFieldValues: { recipient: "Acme Corp" },
    });
    expect(coverLetterJobBaseline(bodyless)).toEqual({
      recipient: "Acme Corp",
    });
  });
});
