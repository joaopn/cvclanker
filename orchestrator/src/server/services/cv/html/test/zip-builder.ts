import { crc32, deflateRawSync } from "node:zlib";

// Writes zips byte by byte for tests, independently of fflate and of the
// reader under test, so archives can carry what real tools write (directory
// entries, unflagged UTF-8 names) and what attackers write (lying sizes,
// encryption flags, ZIP64 markers).

export interface ZipBuilderEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored, 8 deflate. Default 8. */
  method?: number;
  /** Raw name bytes, overriding `name`'s UTF-8 encoding. */
  rawName?: Uint8Array;
  /** Set the UTF-8 name flag (bit 11). Default true. */
  utf8Flag?: boolean;
  /** Extra general-purpose flag bits (e.g. 0x1 encrypted). */
  extraFlags?: number;
  /** Declared uncompressed size, overriding the real one. */
  declaredSize?: number;
  /** Declared CRC-32, overriding the real one. */
  declaredCrc?: number;
  /** The stored body bytes, overriding the (compressed) data. */
  rawBody?: Uint8Array;
}

export function buildZip(entries: ZipBuilderEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw =
      typeof entry.data === "string"
        ? Buffer.from(entry.data, "utf8")
        : Buffer.from(entry.data ?? new Uint8Array());
    const method = entry.method ?? 8;
    const body = entry.rawBody
      ? Buffer.from(entry.rawBody)
      : method === 8
        ? deflateRawSync(raw)
        : raw;
    const name = entry.rawName
      ? Buffer.from(entry.rawName)
      : Buffer.from(entry.name, "utf8");
    const flags =
      ((entry.utf8Flag ?? true) ? 0x800 : 0) | (entry.extraFlags ?? 0);
    const crc = entry.declaredCrc ?? crc32(raw);
    const size = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
