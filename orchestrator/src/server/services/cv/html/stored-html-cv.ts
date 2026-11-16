import { logger } from "@infra/logger";
import type { CvFieldOverrides } from "@shared/types";
import {
  type HtmlBundle,
  HtmlBundleError,
  openStoredHtmlBundle,
} from "./bundle";
import { type HtmlRenderErrorCode, renderHtmlPage } from "./html-worker";
import { renderHtmlToPdf } from "./render-html-pdf";

// Reading and rendering an HTML CV as stored: its archive (the cleaned
// bundle, in the uploaded shape) and its template envelope.

/** The stored archive or template cannot be read: damage on the server's side. */
export class StoredHtmlCvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredHtmlCvError";
  }
}

/** A render of the template with the given values failed (renderHtmlPage). */
export class HtmlCvRenderError extends Error {
  readonly code: HtmlRenderErrorCode;
  readonly fieldId: string | undefined;
  constructor(message: string, code: HtmlRenderErrorCode, fieldId?: string) {
    super(message);
    this.name = "HtmlCvRenderError";
    this.code = code;
    this.fieldId = fieldId;
  }
}

export interface StoredHtmlTemplate {
  templatedHtml: string;
  /** The fields whose marker sits inside a link. */
  insideLinks: string[];
}

/** Opens a stored archive as packed; throws StoredHtmlCvError when it cannot. */
export function openStoredHtmlCvBundle(archive: Uint8Array): HtmlBundle {
  try {
    return openStoredHtmlBundle(archive);
  } catch (error) {
    if (!(error instanceof HtmlBundleError)) throw error;
    logger.error("Stored HTML CV archive cannot be opened", {
      code: error.code,
      message: error.message,
    });
    throw new StoredHtmlCvError(
      `The stored CV archive cannot be opened (${error.code}); upload the CV again.`,
    );
  }
}

/** Reads the template envelope; throws StoredHtmlCvError when it is not one. */
export function readStoredHtmlTemplate(
  templatedTex: string | null | undefined,
): StoredHtmlTemplate {
  const damaged = () => {
    logger.error("Stored HTML CV template cannot be read", {
      length: templatedTex?.length ?? 0,
    });
    return new StoredHtmlCvError(
      "The stored CV template cannot be read; upload the CV again.",
    );
  };
  if (!templatedTex) throw damaged();
  let envelope: unknown;
  try {
    envelope = JSON.parse(templatedTex);
  } catch {
    throw damaged();
  }
  const { html, insideLinks } = (envelope ?? {}) as Record<string, unknown>;
  if (
    typeof html !== "string" ||
    !Array.isArray(insideLinks) ||
    !insideLinks.every((id) => typeof id === "string")
  ) {
    throw damaged();
  }
  return { templatedHtml: html, insideLinks };
}

/**
 * The CV page with the given values in place (the defaults where no override
 * is given), and its PDF. Throws HtmlCvRenderError when the values cannot be
 * rendered, or the renderer's RenderHtmlPdfError.
 */
export async function renderHtmlCv(args: {
  bundle: HtmlBundle;
  templatedHtml: string;
  defaults: CvFieldOverrides;
  overrides: CvFieldOverrides;
}): Promise<{ html: string; pdf: Uint8Array }> {
  const rendered = await renderHtmlPage(
    args.templatedHtml,
    new Map(Object.entries(args.defaults)),
    new Map(Object.entries(args.overrides)),
  );
  if (!rendered.ok) {
    throw new HtmlCvRenderError(
      rendered.message,
      rendered.code,
      rendered.fieldId,
    );
  }
  const files = new Map(args.bundle.files);
  files.set(args.bundle.entry, new TextEncoder().encode(rendered.html));
  const pdf = await renderHtmlToPdf({ files, entry: args.bundle.entry });
  return { html: rendered.html, pdf };
}
