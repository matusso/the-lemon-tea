/**
 * Decoding of the F1 live timing archive formats (livetiming.formula1.com/static/...).
 *
 *  - `*.json`: one JSON document (may start with a UTF-8 BOM)
 *  - `*.jsonStream`: CRLF-separated records, each a 12-character stream offset "HH:MM:SS.mmm"
 *    followed by a JSON patch
 *  - `*.z.jsonStream`: as above, but each payload is a quoted base64 string of raw-deflated JSON
 *
 * Format handling follows FastF1's `_api.fetch_page`/`parse` (MIT, see NOTICE).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** One stream record: offset from the start of the stream in ms, and its payload. */
export interface StreamRecord<T = Json> {
  offsetMs: number;
  data: T;
}

const OFFSET_LENGTH = 12; // "00:00:00.000"

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** "HH:MM:SS.mmm" (stream offset) → ms. Returns null when the value is not an offset. */
export function parseOffset(s: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] ?? "0").padEnd(3, "0"));
}

/**
 * Lap/sector time strings ("1:18.792", "26.123") → seconds. An empty string means the source
 * explicitly reports "no value" and maps to null; malformed input maps to undefined.
 */
export function parseLapTime(s: unknown): number | null | undefined {
  if (s === "") return null;
  if (typeof s !== "string") return undefined;
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return undefined;
  const parts = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number);
  return parts.reduce((a, p) => a * 60 + p, 0);
}

export async function inflateRawBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return stripBom(await new Response(stream).text());
}

async function parsePayload(text: string, zipped: boolean): Promise<Json> {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t) as Json;
  const unquoted = t.startsWith('"') ? t.slice(1, t.endsWith('"') ? -1 : undefined) : t;
  if (zipped) return JSON.parse(await inflateRawBase64(unquoted)) as Json;
  return unquoted;
}

export interface ParsedStream<T = Json> {
  records: StreamRecord<T>[];
  /** Records that could not be decoded (counted, never guessed). */
  decodeErrors: number;
}

export async function parseJsonStream<T = Json>(raw: string, zipped = false): Promise<ParsedStream<T>> {
  const lines = stripBom(raw).split("\r\n");
  const records: StreamRecord<T>[] = [];
  let decodeErrors = 0;
  for (const line of lines) {
    if (line.length <= OFFSET_LENGTH) continue;
    const offsetMs = parseOffset(line.slice(0, OFFSET_LENGTH));
    if (offsetMs === null) {
      decodeErrors++;
      continue;
    }
    try {
      records.push({ offsetMs, data: (await parsePayload(line.slice(OFFSET_LENGTH), zipped)) as T });
    } catch {
      decodeErrors++;
    }
  }
  return { records, decodeErrors };
}

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Live timing sends partial updates. Arrays are sometimes sent as index-keyed objects
 * ({"0": {...}}), so both forms merge by index. `_deleted` lists keys to remove.
 */
export function deepMerge(target: JsonObject, patch: JsonObject): JsonObject {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "_deleted" && Array.isArray(v)) {
      for (const d of v) delete target[String(d)];
      continue;
    }
    const cur = target[k];
    if (isObject(v)) {
      const base: JsonObject = isObject(cur) ? cur : Array.isArray(cur) ? Object.fromEntries(cur.map((x, i) => [String(i), x])) : {};
      target[k] = deepMerge(base, v);
    } else if (Array.isArray(v) && isObject(cur)) {
      target[k] = deepMerge(cur, Object.fromEntries(v.map((x, i) => [String(i), x])));
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** Index-keyed object or array → array ordered by numeric key. */
export function indexed<T = Json>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (!isObject(v)) return [];
  return Object.entries(v)
    .filter(([k]) => /^\d+$/.test(k))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, x]) => x as T);
}
