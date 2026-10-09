// Extract a single file from a (potentially huge) ZIP via byte ranges.
// Workers fetches ranges over HTTP from downloads.poaparchive.com;
// Bun can read ranges from a local archive.zip instead. Same code path.

export type RangeFetcher = (start: number, end: number) => Promise<ArrayBuffer>;

export const WEBP_MAGIC = 0x52494646; // 'RIFF' at byte 0, 'WEBP' at byte 8

export function isWebp(data: Uint8Array): boolean {
  return (
    data.length > 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  );
}

/** Default inflater using the platform DecompressionStream ('deflate-raw'). */
export async function inflateRawWeb(data: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(data).body!.pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export type Inflater = (data: ArrayBuffer) => Promise<Uint8Array>;

/**
 * Remote ZIP byte-range reader with retry: the archive origin occasionally
 * ignores Range and answers 200 with the entire 15 GB body — detect that,
 * cancel the stream, and retry instead of buffering the world.
 */
export function makeRemoteRangeFetcher(url: string, useCfCache = false): RangeFetcher {
  return async (start: number, end: number): Promise<ArrayBuffer> => {
    const want = end - start + 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const init: RequestInit & { cf?: unknown } = {
          headers: { range: `bytes=${start}-${end}`, 'accept-encoding': 'identity' },
          signal: AbortSignal.timeout(15_000),
        };
        if (useCfCache) init.cf = { cacheTtl: 86_400, cacheEverything: true };
        const res = await fetch(url, init as RequestInit);
        if (res.status !== 206) {
          res.body?.cancel().catch(() => {});
          throw new Error(`zip range fetch: status ${res.status}`);
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== want) throw new Error('zip range fetch: short read');
        return buf;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('zip range fetch failed');
  };
}

export interface ZipEntryLoc {
  headerOffset: number; // local file header offset (from artwork_zip.off minus header)
  dataOff: number; // precomputed start of compressed data
  size: number; // compressed size
  method: number;
}

/**
 * Extract one entry. `dataOff` comes from the precomputed artwork_zip table
 * (built with local-extra=0 assumption); if the stream fails the magic check,
 * re-read the actual local header once and retry — guards against any zip
 * writer that emits local extra fields.
 */
export async function extractZipEntry(
  fetchRange: RangeFetcher,
  entry: ZipEntryLoc,
  inflate: Inflater = inflateRawWeb,
): Promise<Uint8Array> {
  const attempt = async (dataOff: number): Promise<Uint8Array> => {
    const raw = await fetchRange(dataOff, dataOff + entry.size - 1);
    if (entry.method === 0) return new Uint8Array(raw);
    return inflate(raw);
  };

  let out = await attempt(entry.dataOff);
  if (isWebp(out)) return out;

  // Fallback: parse the real local header for its actual name/extra lengths.
  const headBuf = await fetchRange(entry.headerOffset, entry.headerOffset + 299);
  const head = new Uint8Array(headBuf);
  const dv = new DataView(head.buffer);
  if (dv.getUint32(0, true) === 0x04034b50) {
    const nameLen = dv.getUint16(26, true);
    const extraLen = dv.getUint16(28, true);
    const trueOff = entry.headerOffset + 30 + nameLen + extraLen;
    if (trueOff !== entry.dataOff) {
      out = await attempt(trueOff);
      if (isWebp(out)) return out;
    }
  }
  throw new Error('zip entry failed webp validation');
}
