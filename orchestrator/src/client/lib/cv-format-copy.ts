import type { CvSourceFormat } from "@shared/types";

export type CvFormatCopy = {
  acceptedExtensions: string[];
  dropHint: string;
  uploadSubtitle: string;
  uploadDescription: string;
  uploadingLabel: string;
  sourceStderrLabel: string;
  fieldsDescription: string;
  compileLogTitle: string;
  compileLogDescription: string;
};

const LATEX: CvFormatCopy = {
  acceptedExtensions: [".tex", ".zip"],
  dropHint: ".tex or .zip (max 10 MB)",
  uploadSubtitle:
    "Upload your LaTeX CV; the server flattens, extracts, and renders it for per-job tailoring.",
  uploadDescription:
    "Drop a .tex file or a .zip archive containing main.tex plus any included files, fonts, and images. The server flattens it, compiles it, then asks the LLM to produce a templated version. The upload is only accepted if (a) your CV's source compiles, (b) the templated version compiles, and (c) the substituted PDF's text matches the original. Up to 3 LLM retries — beyond that the upload is rejected with the per-attempt log.",
  uploadingLabel: "Uploading, compiling, and extracting…",
  sourceStderrLabel: "Tectonic stderr (your CV's source)",
  fieldsDescription:
    'Spans of the source LaTeX that per-job tailoring can override. Everything else in the templated tex is preserved byte-for-byte. Spot-check the role tags here — if the LLM mislabeled one (e.g. tagged your email as `bullet`), click "Re-extract" above.',
  compileLogTitle: "Compile log",
  compileLogDescription:
    "Tectonic stderr from the most recent successful template compile. Empty when this CV was uploaded in the older format (re-extract to populate).",
};

const DOCX: CvFormatCopy = {
  acceptedExtensions: [".docx"],
  dropHint: ".docx (max 10 MB)",
  uploadSubtitle:
    "Upload your Word CV; the server extracts the tailorable spans and renders a tailored .docx per job.",
  uploadDescription:
    "Drop a .docx file. The server reads the document, asks the LLM to pick out the spans that per-job tailoring can rewrite, then marks them in place. The upload is only accepted if (a) the marked-up document still holds exactly the same text as the one you uploaded, and (b) it converts to PDF cleanly. Up to 3 LLM retries — beyond that the upload is rejected with the per-attempt log.",
  uploadingLabel: "Uploading, converting, and extracting…",
  sourceStderrLabel: "Conversion output (your CV's source)",
  fieldsDescription:
    'Spans of your Word document that per-job tailoring can override. Every other run, table, and style is preserved exactly as you wrote it. Spot-check the role tags here — if the LLM mislabeled one (e.g. tagged your email as `bullet`), click "Re-extract" above.',
  compileLogTitle: "Conversion log",
  compileLogDescription:
    "Output from the most recent successful PDF conversion of your CV. Empty when this CV was uploaded in the older format (re-extract to populate).",
};

const HTML: CvFormatCopy = {
  acceptedExtensions: [".html", ".htm", ".zip"],
  dropHint: ".html, .htm or .zip (max 10 MB)",
  uploadSubtitle:
    "Upload your HTML CV; the server extracts the tailorable text and renders a tailored PDF and page (or zip) per job.",
  uploadDescription:
    "Drop a single .html page, or a .zip with the page and every file it uses (stylesheets, fonts, images) linked by relative paths. The page must be self-contained: nothing loaded from the internet (no fonts, images or stylesheets loaded from the web) and no scripts. The server checks and tidies the page (links that change nothing in the PDF, such as icons and preloads, are dropped, and so are OS junk files in a zip), asks the LLM to pick out the text that per-job tailoring can rewrite, then marks it in place. The upload is only accepted if (a) the marked-up page still holds exactly the same text as the page you uploaded, and (b) it renders to PDF cleanly. Up to 3 LLM attempts — beyond that the upload is rejected with the per-attempt log.",
  uploadingLabel: "Uploading, checking, and extracting…",
  sourceStderrLabel: "Render output (your CV's source)",
  fieldsDescription:
    'Spans of your page\'s text that per-job tailoring can override. Tailoring leaves every other element, style and file untouched. Spot-check the role tags here — if the LLM mislabeled one (e.g. tagged your email as `bullet`), click "Re-extract" above.',
  compileLogTitle: "Render log",
  compileLogDescription:
    "Output from the most recent successful PDF render of your CV, if it reported anything.",
};

export function getCvFormatCopy(format: CvSourceFormat): CvFormatCopy {
  switch (format) {
    case "latex":
      return LATEX;
    case "docx":
      return DOCX;
    case "html":
      return HTML;
    default:
      // A stored format this build does not know: the LaTeX copy, as for an
      // unset format.
      format satisfies never;
      return LATEX;
  }
}
