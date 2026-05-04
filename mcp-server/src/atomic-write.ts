// Atomic file writes — write to a sibling .tmp, fsync, rename. Renaming
// on POSIX is atomic on the same filesystem, so a crash mid-write leaves
// the original file intact instead of producing a half-truncated JSON
// blob. Used by the auctioneer registry + bidder state writers.
//
// Why not SQLite: every writer in this codebase owns its own file, so
// there's no inter-writer contention to resolve. The actual failure
// mode in production was "container restart truncated the JSON" — that
// fix is atomic-rename, not a database migration. SQLite is a v2 move
// if read fan-out grows.

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";

/** Synchronously and atomically write `data` to `path`. */
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer
): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, buf, 0, buf.length, 0);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Atomically replace `path` with the JSON encoding of `obj`. */
export function atomicWriteJsonSync(path: string, obj: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(obj, null, 2));
}
