// @vitest-environment node
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { buildZip } from "./test/zip-builder";
import {
  displayName,
  listZipEntries,
  looksLikeZip,
  readZipEntry,
  ZipReadError,
} from "./zip-reader";

const inflateOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    inflateRawSync: (data: Buffer, options?: object) => {
      inflateOptions.push(options);
      return actual.inflateRawSync(data, options);
    },
  };
});

const LIMITS = { maxEntries: 1000 };

function readAll(zip: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    listZipEntries(zip, LIMITS).map((entry) => [
      entry.name,
      readZipEntry(zip, entry).toString("utf8"),
    ]),
  );
}

function zipError(run: () => unknown): ZipReadError {
  try {
    run();
  } catch (error) {
    if (error instanceof ZipReadError) return error;
    throw error;
  }
  throw new Error("expected a ZipReadError");
}

describe("displayName", () => {
  it("keeps names of up to 80 code points as they are", () => {
    expect(displayName("css/a.css")).toBe("css/a.css");
    expect(displayName("😀".repeat(80))).toBe("😀".repeat(80));
  });

  it("cuts longer names to 80 whole code points and marks the cut", () => {
    expect(displayName("😀".repeat(81))).toBe(`${"😀".repeat(80)}…`);
  });
});

describe("zip-reader", () => {
  it("reads stored and deflated entries", () => {
    const zip = buildZip([
      { name: "index.html", data: "<!doctype html><p>Hi</p>", method: 8 },
      { name: "style.css", data: "p { color: red; }", method: 0 },
    ]);
    expect(looksLikeZip(zip)).toBe(true);
    expect(readAll(zip)).toEqual({
      "index.html": "<!doctype html><p>Hi</p>",
      "style.css": "p { color: red; }",
    });
  });

  it("reads zips written by fflate", () => {
    const zip = zipSync({
      "cv/index.html": new TextEncoder().encode("<html>x</html>"),
    });
    expect(readAll(zip)).toEqual({ "cv/index.html": "<html>x</html>" });
  });

  it("decodes UTF-8 names whether or not the UTF-8 flag is set", () => {
    const zip = buildZip([
      { name: "flagged-ü.css", data: "a", utf8Flag: true },
      { name: "unflagged-ü.css", data: "b", utf8Flag: false },
      // Not valid UTF-8: falls back to latin1.
      {
        name: "x",
        rawName: Uint8Array.from([0x6c, 0xe9, 0x2e, 0x63]),
        utf8Flag: false,
        data: "c",
      },
    ]);
    expect(listZipEntries(zip, LIMITS).map((entry) => entry.name)).toEqual([
      "flagged-ü.css",
      "unflagged-ü.css",
      "lé.c",
    ]);
  });

  it("refuses an entry whose header understates its size, quickly", () => {
    const big = "x".repeat(50_000_000);
    const zip = buildZip([
      { name: "index.html", data: big, declaredSize: 1000 },
    ]);
    const [entry] = listZipEntries(zip, LIMITS);
    inflateOptions.length = 0;
    const error = zipError(() => readZipEntry(zip, entry));
    expect(error.code).toBe("BAD_ZIP");
    // zlib stops at maxOutputLength rather than inflating the whole stream.
    expect(inflateOptions).toEqual([{ maxOutputLength: 1000 }]);
  });

  it("refuses an entry whose data does not match its CRC", () => {
    const zip = buildZip([{ name: "a.css", data: "abc", declaredCrc: 1 }]);
    const [entry] = listZipEntries(zip, LIMITS);
    expect(zipError(() => readZipEntry(zip, entry)).code).toBe("BAD_ZIP");
  });

  it("refuses an entry whose header overstates its size", () => {
    const zip = buildZip([{ name: "a.css", data: "abc", declaredSize: 10 }]);
    const [entry] = listZipEntries(zip, LIMITS);
    expect(zipError(() => readZipEntry(zip, entry)).code).toBe("BAD_ZIP");
  });

  it("refuses encrypted entries and unsupported methods", () => {
    expect(
      zipError(() =>
        listZipEntries(
          buildZip([{ name: "a.css", data: "a", extraFlags: 0x1 }]),
          LIMITS,
        ),
      ).message,
    ).toContain("encrypted");
    expect(
      zipError(() =>
        listZipEntries(
          buildZip([{ name: "a.css", data: "a", method: 12 }]),
          LIMITS,
        ),
      ).message,
    ).toContain("unsupported compression method");
  });

  it("refuses ZIP64 archives", () => {
    const zip = buildZip([
      { name: "a.css", data: "a", declaredSize: 0xffffffff },
    ]);
    expect(zipError(() => listZipEntries(zip, LIMITS)).message).toContain(
      "ZIP64",
    );
  });

  it("refuses truncated and non-zip input", () => {
    const zip = buildZip([{ name: "a.css", data: "abc" }]);
    expect(
      zipError(() => listZipEntries(zip.subarray(0, zip.length - 5), LIMITS))
        .code,
    ).toBe("BAD_ZIP");
    expect(
      zipError(() => listZipEntries(new TextEncoder().encode("hello"), LIMITS))
        .code,
    ).toBe("BAD_ZIP");
  });

  it("refuses entries that share one data stream past the data area", () => {
    // One stored entry, its central record repeated: every copy points at the
    // same data, so reading them all would read the file's data N times.
    const zip = buildZip([{ name: "a", data: "x".repeat(10_000), method: 0 }]);
    const eocd = zip.length - 22;
    const centralOffset = zip.readUInt32LE(eocd + 16);
    const record = zip.subarray(centralOffset, eocd);
    const copies = 3;
    const end = Buffer.from(zip.subarray(eocd));
    end.writeUInt16LE(copies, 8);
    end.writeUInt16LE(copies, 10);
    end.writeUInt32LE(record.length * copies, 12);
    const shared = Buffer.concat([
      zip.subarray(0, centralOffset),
      ...Array.from({ length: copies }, () => record),
      end,
    ]);
    expect(zipError(() => listZipEntries(shared, LIMITS)).message).toContain(
      "overlap",
    );
  });

  it("refuses an entry whose local header starts in the central directory", () => {
    const zip = buildZip([{ name: "a", data: "abc", method: 0 }]);
    const eocd = zip.length - 22;
    const centralOffset = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(centralOffset, centralOffset + 42);
    expect(zipError(() => listZipEntries(zip, LIMITS)).message).toContain(
      "overlap",
    );
  });

  it("reads empty entries, stored and deflated", () => {
    const zip = buildZip([
      { name: "stored", data: "", method: 0 },
      { name: "deflated", data: "", method: 8 },
      // Some writers emit a deflate entry with no compressed bytes at all.
      { name: "bare", data: "", method: 8, rawBody: new Uint8Array() },
    ]);
    expect(readAll(zip)).toEqual({ stored: "", deflated: "", bare: "" });
  });

  describe("refuses malformed archives", () => {
    const base = () => buildZip([{ name: "a.css", data: "abc" }]);
    const eocdOf = (zip: Buffer) => zip.length - 22;
    const cases: [string, (zip: Buffer) => Buffer, string][] = [
      [
        "a ZIP64 entry count",
        (zip) => {
          zip.writeUInt16LE(0xffff, eocdOf(zip) + 8);
          zip.writeUInt16LE(0xffff, eocdOf(zip) + 10);
          return zip;
        },
        "ZIP64",
      ],
      [
        "a ZIP64 central offset",
        (zip) => {
          zip.writeUInt32LE(0xffffffff, eocdOf(zip) + 16);
          return zip;
        },
        "ZIP64",
      ],
      [
        "a ZIP64 locator",
        (zip) => {
          const locator = Buffer.alloc(20);
          locator.writeUInt32LE(0x07064b50, 0);
          const eocd = zip.subarray(eocdOf(zip));
          return Buffer.concat([zip.subarray(0, eocdOf(zip)), locator, eocd]);
        },
        "ZIP64",
      ],
      [
        "a multi-part archive",
        (zip) => {
          zip.writeUInt16LE(1, eocdOf(zip) + 4);
          return zip;
        },
        "Multi-part",
      ],
      [
        "a central directory outside the file",
        (zip) => {
          zip.writeUInt32LE(zip.length, eocdOf(zip) + 16);
          return zip;
        },
        "outside the file",
      ],
      [
        "a corrupt central record",
        (zip) => {
          zip.writeUInt32LE(0, zip.readUInt32LE(eocdOf(zip) + 16));
          return zip;
        },
        "central directory is corrupt",
      ],
    ];
    for (const [label, corrupt, message] of cases) {
      it(label, () => {
        expect(
          zipError(() => listZipEntries(corrupt(base()), LIMITS)).message,
        ).toContain(message);
      });
    }

    it("a corrupt local header", () => {
      const zip = base();
      const [entry] = listZipEntries(zip, LIMITS);
      zip.writeUInt32LE(0, 0);
      expect(zipError(() => readZipEntry(zip, entry)).message).toContain(
        "local header",
      );
    });

    it("a local header whose extra field runs past the file", () => {
      const zip = base();
      const [entry] = listZipEntries(zip, LIMITS);
      zip.writeUInt16LE(0xffff, 28);
      expect(zipError(() => readZipEntry(zip, entry)).message).toContain(
        "truncated",
      );
    });
  });

  it("refuses more entries than the limit", () => {
    const zip = buildZip([
      { name: "a", data: "a" },
      { name: "b", data: "b" },
      { name: "c", data: "c" },
    ]);
    expect(zipError(() => listZipEntries(zip, { maxEntries: 2 })).code).toBe(
      "ZIP_BOMB",
    );
  });
});
