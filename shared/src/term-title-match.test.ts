import { describe, expect, it } from "vitest";
import { titleNamesTerm, titleWords } from "./term-title-match";

const names = (title: string, term: string) =>
  titleNamesTerm(new Set(titleWords(title)), titleWords(term));

describe("titleNamesTerm", () => {
  it("matches every word of the term, in any order and any case", () => {
    expect(names("Senior Data Engineer (Remote)", "data engineer")).toBe(true);
    expect(names("Engineer, Data Platform", "Data Engineer")).toBe(true);
  });

  it("does not match when one of the term's words is missing", () => {
    expect(names("Data Analyst", "data engineer")).toBe(false);
  });

  it("matches whole words, not substrings", () => {
    expect(names("Dataset Engineer", "data engineer")).toBe(false);
  });

  it("ignores accents on either side", () => {
    expect(names("Desenvolvedor Júnior", "desenvolvedor junior")).toBe(true);
  });

  it("keeps C++ and C# apart", () => {
    expect(names("C# Developer", "C++ developer")).toBe(false);
    expect(names("C++ Developer", "C++ developer")).toBe(true);
  });

  it("never matches a term with no words", () => {
    expect(names("Anything", "  ")).toBe(false);
    expect(names("Anything", "--")).toBe(false);
  });
});
