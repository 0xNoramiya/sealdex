// Server-only fs helpers for the bidder JSONL stream. Split from
// spawn-stream.ts so webpack doesn't try to bundle `node:fs` into
// the client when the dashboard imports the pure helpers.

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  parseStreamLines,
  tailLastN,
  type StreamEvent,
} from "./spawn-stream";

/**
 * Locate the bidder's stream file inside a per-spawn state dir.
 * Bidder uses its own slug() (lowercase + dashes from cfg.name) for
 * the file basename, which can differ from the spawn record's
 * uniqueSlugFor() result if there were name collisions across users.
 * To dodge that mismatch entirely we glob the dir — there's only ever
 * one bidder per per-spawn state dir.
 */
export function findStreamFile(perSpawnStateDir: string): string | null {
  if (!existsSync(perSpawnStateDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(perSpawnStateDir);
  } catch {
    return null;
  }
  const matches = entries.filter(
    (e) => e.startsWith("bidder-") && e.endsWith("-stream.jsonl")
  );
  if (matches.length === 0) return null;
  // Pick the most recently modified — guards against a stale file
  // left behind from a previous run with a renamed agent.
  let best = matches[0]!;
  let bestMtime = 0;
  for (const m of matches) {
    try {
      const st = statSync(path.join(perSpawnStateDir, m));
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = m;
      }
    } catch {
      // ignore
    }
  }
  return path.join(perSpawnStateDir, best);
}

/** Hard cap on bytes read from a stream file per request — protects
 *  against pathological 100MB+ files and keeps the route responsive. */
export const STREAM_TAIL_BYTES_CAP = 256 * 1024;

export interface ReadStreamTailResult {
  events: StreamEvent[];
  truncated: boolean;
  sizeBytes: number;
}

/**
 * Read up to the last `bytesCap` bytes of the file and parse them
 * as JSONL events. The first (potentially partial) line in the
 * window is dropped to avoid mid-line splits.
 *
 * Why bytes-not-lines: jumping by N lines requires a backwards
 * scan; reading a fixed tail window is one fs call and the
 * line-count comes for free after parse.
 */
export function readStreamTail(
  filePath: string,
  opts: { bytesCap?: number; maxEvents?: number } = {}
): ReadStreamTailResult {
  const bytesCap = opts.bytesCap ?? STREAM_TAIL_BYTES_CAP;
  const maxEvents = opts.maxEvents ?? 200;
  if (!existsSync(filePath)) {
    return { events: [], truncated: false, sizeBytes: 0 };
  }
  const stat = statSync(filePath);
  const size = stat.size;
  let buf: Buffer;
  let truncated = false;
  if (size <= bytesCap) {
    buf = readFileSync(filePath);
  } else {
    truncated = true;
    const fd = openSync(filePath, "r");
    try {
      const start = size - bytesCap;
      const tmp = Buffer.alloc(bytesCap);
      readSync(fd, tmp, 0, bytesCap, start);
      buf = tmp;
    } finally {
      closeSync(fd);
    }
  }
  let text = buf.toString("utf8");
  if (truncated) {
    // Drop the first (likely partial) line.
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) {
      text = text.slice(firstNewline + 1);
    }
  }
  const events = parseStreamLines(text);
  const tailed = tailLastN(events, maxEvents);
  return { events: tailed, truncated, sizeBytes: size };
}
