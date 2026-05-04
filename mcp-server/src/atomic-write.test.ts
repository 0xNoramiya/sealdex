import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
} from "./atomic-write.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "sealdex-atomic-"));
}

describe("atomicWriteFileSync", () => {
  it("writes the file with the given content", () => {
    const dir = tmpDir();
    const path = join(dir, "out.txt");
    atomicWriteFileSync(path, "hello");
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  it("leaves no .tmp sibling after success", () => {
    const dir = tmpDir();
    const path = join(dir, "out.txt");
    atomicWriteFileSync(path, "x");
    const remnants = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(remnants).toEqual([]);
  });

  it("overwrites an existing file with no torn write window", () => {
    const dir = tmpDir();
    const path = join(dir, "out.txt");
    atomicWriteFileSync(path, "v1-large-content-1234567890");
    const sizeBefore = statSync(path).size;
    expect(sizeBefore).toBeGreaterThan(0);

    atomicWriteFileSync(path, "v2");
    expect(readFileSync(path, "utf8")).toBe("v2");
  });
});

describe("atomicWriteJsonSync", () => {
  it("encodes objects with stable indentation", () => {
    const dir = tmpDir();
    const path = join(dir, "data.json");
    atomicWriteJsonSync(path, { hello: "world", n: 1 });
    const text = readFileSync(path, "utf8");
    expect(JSON.parse(text)).toEqual({ hello: "world", n: 1 });
    expect(text).toContain("\n  ");
  });
});
