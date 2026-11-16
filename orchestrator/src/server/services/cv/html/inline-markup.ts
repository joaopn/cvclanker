import {
  ErrorCodes,
  type ParserError,
  type Token,
  type TokenHandler,
  Tokenizer,
} from "parse5";
import { isJavascriptUrl } from "./html-tree";

// The markup a field value may hold: text and a few inline tags, balanced,
// with attributes from a fixed allowlist. At splice time the allowlist alone
// applies; at tailor and render time every tag, class name and attribute
// value must also be one the CV's own field defaults use, so a value written
// from a job description cannot hide or restyle text through the page's
// stylesheet, or point a link somewhere new.
//
// Values are read with parse5's own tokenizer, so entities, attributes and
// what counts as a tag are exactly what the browser reads.

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "code",
  "em",
  "i",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "class",
  "dir",
  "href",
  "id",
  "itemprop",
  "itemscope",
  "itemtype",
  "lang",
  "rel",
  "role",
  "target",
  "title",
]);

const PREFIXED_ATTRIBUTE = /^(?:aria|data)-[a-z0-9._-]+$/;

const MARKER_CHARS = /[⟦⟧]/;

// A field is a span of one CV paragraph; a few hundred characters is typical.
// The cap keeps tokenizing a value on the main thread (the tailor-time check,
// stripToText) to milliseconds: parse5's tokenizer compares each attribute
// with the tag's earlier ones, so a multi-megabyte value could stall it.
export const MAX_VALUE_CHARS = 10_000;

/** What the CV's field defaults use: the limit for tailored values. */
export interface MarkupUsage {
  tags: Set<string>;
  classes: Set<string>;
  /** `name=value` for every attribute other than class and href. */
  attributes: Set<string>;
  hrefs: Set<string>;
}

/** The allowlist alone, for splicing an upload's own markup. */
export const FULL_ALLOWLIST = "allowlist";

export type MarkupRefusal =
  | "VALUE_TOO_LONG"
  | "NULL_CHARACTER"
  | "MARKER"
  | "NOT_TEXT"
  | "TAG_NOT_ALLOWED"
  | "TAG_NOT_USED"
  | "SELF_CLOSING_TAG"
  | "UNMATCHED_END_TAG"
  | "UNCLOSED_TAG"
  | "TRUNCATED_TAG"
  | "MALFORMED_ATTRIBUTE"
  | "DUPLICATE_ATTRIBUTE"
  | "ATTRIBUTE_NOT_ALLOWED"
  | "ATTRIBUTE_NOT_USED"
  | "JAVASCRIPT_URL"
  | "NESTED_LINK";

export type MarkupCheck =
  | { ok: true }
  | { ok: false; reason: MarkupRefusal; message: string };

export interface CheckMarkupOptions {
  usage: MarkupUsage | typeof FULL_ALLOWLIST;
  /** The value's place in the page is already inside an `<a>`. */
  insideLink: boolean;
}

/** Whether `markup` may be a field value; the first problem found if not. */
export function checkMarkup(
  markup: string,
  opts: CheckMarkupOptions,
): MarkupCheck {
  if (markup.length > MAX_VALUE_CHARS) {
    return refuse(
      "VALUE_TOO_LONG",
      `is longer than ${MAX_VALUE_CHARS} characters`,
    );
  }
  let refusal: MarkupCheck | undefined;
  const fail = (reason: MarkupRefusal, message: string) => {
    refusal ??= refuse(reason, message);
  };
  const open: string[] = [];
  const handler: TokenHandler = {
    onCharacter: (token) => checkText(token.chars, fail),
    onWhitespaceCharacter: () => {},
    onNullCharacter: () => {},
    onComment: () =>
      fail(
        "NOT_TEXT",
        "contains a comment, CDATA section or processing instruction",
      ),
    onDoctype: () => fail("NOT_TEXT", "contains a doctype"),
    onStartTag: (token) => {
      checkStartTag(token, open, opts, fail);
      open.push(token.tagName);
    },
    onEndTag: (token) => {
      if (token.attrs.length > 0 || token.selfClosing) {
        fail(
          "MALFORMED_ATTRIBUTE",
          `has an end tag </${token.tagName}> with attributes or a "/"`,
        );
      }
      if (open[open.length - 1] === token.tagName) {
        open.pop();
      } else {
        fail(
          "UNMATCHED_END_TAG",
          `has </${token.tagName}> where it does not close the last open tag`,
        );
      }
    },
    onEof: () => {
      if (open.length > 0) {
        fail("UNCLOSED_TAG", `leaves <${open[open.length - 1]}> unclosed`);
      }
    },
    onParseError: (error: ParserError) => {
      if (error.code === ErrorCodes.duplicateAttribute) {
        fail("DUPLICATE_ATTRIBUTE", "repeats an attribute in one tag");
      } else if (error.code === ErrorCodes.unexpectedNullCharacter) {
        // In text and in attribute values alike.
        fail("NULL_CHARACTER", "contains a NULL character");
      } else if (error.code === ErrorCodes.eofInTag) {
        fail("TRUNCATED_TAG", "ends inside a tag");
      }
    },
  };
  new Tokenizer({ sourceCodeLocationInfo: false }, handler).write(markup, true);
  return refusal ?? { ok: true };
}

/** The tags, class names and attribute values the given defaults use. */
export function markupUsage(defaults: Iterable<string>): MarkupUsage {
  const usage: MarkupUsage = {
    tags: new Set(),
    classes: new Set(),
    attributes: new Set(),
    hrefs: new Set(),
  };
  const handler: TokenHandler = {
    ...IGNORE_TOKENS,
    onStartTag: (token) => {
      usage.tags.add(token.tagName);
      for (const attr of token.attrs) {
        if (attr.name === "href") {
          usage.hrefs.add(attr.value);
        } else if (attr.name === "class") {
          const names = classNames(attr.value);
          if (names.length === 0) usage.attributes.add("class=");
          for (const name of names) usage.classes.add(name);
        } else {
          usage.attributes.add(`${attr.name}=${attr.value}`);
        }
      }
    },
  };
  for (const value of defaults) {
    new Tokenizer({ sourceCodeLocationInfo: false }, handler).write(
      value,
      true,
    );
  }
  return usage;
}

/**
 * A value's text, tags dropped and entities decoded — what ATS matching and
 * the generators that read the CV as text see. Reads at most MAX_VALUE_CHARS
 * of it.
 */
export function stripToText(markup: string): string {
  const parts: string[] = [];
  const handler: TokenHandler = {
    ...IGNORE_TOKENS,
    onCharacter: (token) => parts.push(token.chars),
    onWhitespaceCharacter: (token) => parts.push(token.chars),
  };
  new Tokenizer({ sourceCodeLocationInfo: false }, handler).write(
    markup.slice(0, MAX_VALUE_CHARS),
    true,
  );
  return parts.join("");
}

const IGNORE_TOKENS: TokenHandler = {
  onCharacter: () => {},
  onWhitespaceCharacter: () => {},
  onNullCharacter: () => {},
  onComment: () => {},
  onDoctype: () => {},
  onStartTag: () => {},
  onEndTag: () => {},
  onEof: () => {},
};

function checkStartTag(
  token: Token.TagToken,
  open: string[],
  opts: CheckMarkupOptions,
  fail: (reason: MarkupRefusal, message: string) => void,
): void {
  const tag = token.tagName;
  if (!ALLOWED_TAGS.has(tag)) {
    fail("TAG_NOT_ALLOWED", `uses <${tag}>, which a field value cannot hold`);
  }
  const usage = opts.usage === FULL_ALLOWLIST ? undefined : opts.usage;
  if (usage && !usage.tags.has(tag)) {
    fail("TAG_NOT_USED", `uses <${tag}>, which this CV's fields do not use`);
  }
  if (token.selfClosing) {
    fail("SELF_CLOSING_TAG", `writes <${tag}/>, which HTML reads as <${tag}>`);
  }
  if (tag === "a" && (opts.insideLink || open.includes("a"))) {
    fail("NESTED_LINK", "puts a link inside a link");
  }
  for (const attr of token.attrs) {
    const name = attr.name;
    if (
      !(ALLOWED_ATTRIBUTES.has(name) || PREFIXED_ATTRIBUTE.test(name)) ||
      (name === "href" && tag !== "a")
    ) {
      fail(
        "ATTRIBUTE_NOT_ALLOWED",
        `uses the attribute ${name} on <${tag}>, which a field value cannot hold`,
      );
    }
    checkText(attr.value, fail);
    if (name === "href" && isJavascriptUrl(attr.value)) {
      fail("JAVASCRIPT_URL", "links to a javascript: URL");
    }
    if (!usage) continue;
    if (name === "href") {
      if (!usage.hrefs.has(attr.value)) {
        fail("ATTRIBUTE_NOT_USED", "links to an address this CV does not use");
      }
    } else if (name === "class") {
      const names = classNames(attr.value);
      const unused =
        names.length === 0
          ? !usage.attributes.has("class=")
          : names.some((className) => !usage.classes.has(className));
      if (unused) {
        fail(
          "ATTRIBUTE_NOT_USED",
          `uses a class this CV's fields do not use (${attr.value})`,
        );
      }
    } else if (!usage.attributes.has(`${name}=${attr.value}`)) {
      fail(
        "ATTRIBUTE_NOT_USED",
        `uses ${name}="${attr.value}", which this CV's fields do not use`,
      );
    }
  }
}

function checkText(
  text: string,
  fail: (reason: MarkupRefusal, message: string) => void,
): void {
  if (MARKER_CHARS.test(text)) fail("MARKER", "contains ⟦ or ⟧");
}

function classNames(value: string): string[] {
  return value.split(/[\t\n\f\r ]+/).filter((name) => name.length > 0);
}

function refuse(reason: MarkupRefusal, message: string): MarkupCheck {
  return { ok: false, reason, message };
}
