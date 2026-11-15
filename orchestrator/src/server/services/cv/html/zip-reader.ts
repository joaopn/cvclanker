import { crc32, inflateRawSync } from "node:zlib";

// A minimal zip reader whose decompression is bounded in CPU as well as
// memory. fflate's unzipSync never returns more than an entry's declared size
// but still inflates the whole stream behind a header that understates it, so
// a small crafted upload could hold the event loop for minutes. Here every
// deflate entry is inflated by zlib with maxOutputLength set to its declared
// size, which stops at that size, and every entry is checked against its
// declared size and CRC-32, so a lying header is refused rather than
// truncated. Each entry's local header must start at least 30 bytes plus its
// compressed size before the central directory, and all entries' compressed
// sizes together must not exceed the central directory's offset, so entries
// sharing one stream cannot make the total inflate input exceed the file.
//
// Deliberately narrow: stored and deflate entries only; ZIP64, encryption and
// multi-disk archives are refused. An HTML CV bundle is a page, its CSS, fonts
// and images — none of that needs more.

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export type ZipReadErrorCode = "BAD_ZIP" | "ZIP_BOMB";

export class ZipReadError extends Error {
  readonly code: ZipReadErrorCode;
  constructor(message: string, code: ZipReadErrorCode) {
    super(message);
    this.name = "ZipReadError";
    this.code = code;
  }
}

export interface ZipEntry {
  /** The name as stored, decoded (UTF-8 when flagged or valid, else latin1). */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
}

/**
 * An entry name fit for a message: a zip entry name can be 64 KB long, so it
 * is cut to 80 characters (whole code points), marked when cut.
 */
export function displayName(name: string): string {
  const chars = Array.from(name);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : name;
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/** Lists the archive's entries from its central directory; inflates nothing. */
export function listZipEntries(
  bytes: Uint8Array,
  opts: { maxEntries: number },
): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buf);
  if (
    eocd >= 20 &&
    buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE
  ) {
    throw bad("ZIP64 archives are not supported.");
  }
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw bad("Multi-part zip archives are not supported.");
  }
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw bad("ZIP64 archives are not supported.");
  }
  if (entryCount > opts.maxEntries) {
    throw new ZipReadError(
      `The zip has ${entryCount} entries (limit ${opts.maxEntries}).`,
      "ZIP_BOMB",
    );
  }
  if (centralOffset + centralSize > eocd) {
    throw bad("The zip's central directory lies outside the file.");
  }

  const entries: ZipEntry[] = [];
  let compressedTotal = 0;
  let at = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    requireRange(buf, at, CENTRAL_HEADER_LENGTH);
    if (buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw bad("The zip's central directory is corrupt.");
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localHeaderOffset = buf.readUInt32LE(at + 42);
    requireRange(buf, at + CENTRAL_HEADER_LENGTH, nameLength);
    const rawName = buf.subarray(
      at + CENTRAL_HEADER_LENGTH,
      at + CENTRAL_HEADER_LENGTH + nameLength,
    );
    const name = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
    if (flags & FLAG_ENCRYPTED) {
      throw bad(
        `"${displayName(name)}" is encrypted; upload an unencrypted zip.`,
      );
    }
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw bad("ZIP64 archives are not supported.");
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw bad(
        `"${displayName(name)}" uses an unsupported compression method.`,
      );
    }
    compressedTotal += compressedSize;
    if (
      localHeaderOffset + LOCAL_HEADER_LENGTH + compressedSize >
        centralOffset ||
      compressedTotal > centralOffset
    ) {
      throw bad("The zip's entries overlap or run past their data area.");
    }
    entries.push({
      name,
      method,
      compressedSize,
      size,
      crc32: crc,
      localHeaderOffset,
    });
    at += CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Returns an entry's bytes. Never produces more than its declared size, and
 * refuses an entry whose data does not match its declared size and CRC-32.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Buffer {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  requireRange(buf, at, LOCAL_HEADER_LENGTH);
  if (buf.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw bad(`"${displayName(entry.name)}" has a corrupt local header.`);
  }
  const start =
    at +
    LOCAL_HEADER_LENGTH +
    buf.readUInt16LE(at + 26) +
    buf.readUInt16LE(at + 28);
  requireRange(buf, start, entry.compressedSize);
  const data = buf.subarray(start, start + entry.compressedSize);

  let out: Buffer;
  if (entry.method === METHOD_STORED) {
    out = data;
  } else if (entry.compressedSize === 0 && entry.size === 0) {
    // No deflate stream at all (some writers emit this for an empty file);
    // zlib refuses zero bytes of input.
    out = data;
  } else {
    try {
      // maxOutputLength must be at least 1; an empty entry inflates to 0.
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw bad(
        `"${displayName(entry.name)}" does not decompress to its declared size; the zip is corrupt.`,
      );
    }
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc32) {
    throw bad(
      `"${displayName(entry.name)}" does not match its declared size and checksum; the zip is corrupt.`,
    );
  }
  return out;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let at = buf.length - EOCD_MIN_LENGTH; at >= lowest; at--) {
    if (
      buf.readUInt32LE(at) === EOCD_SIGNATURE &&
      at + EOCD_MIN_LENGTH + buf.readUInt16LE(at + 20) === buf.length
    ) {
      return at;
    }
  }
  throw bad("Not a readable zip file (no end-of-archive record).");
}

function decodeName(raw: Buffer, flaggedUtf8: boolean): string {
  if (flaggedUtf8) return raw.toString("utf8");
  try {
    // macOS Archive Utility writes UTF-8 names without setting the flag.
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

function requireRange(buf: Buffer, at: number, length: number): void {
  if (at < 0 || length < 0 || at + length > buf.length) {
    throw bad("The zip is truncated or corrupt.");
  }
}

function bad(message: string): ZipReadError {
  return new ZipReadError(message, "BAD_ZIP");
}
