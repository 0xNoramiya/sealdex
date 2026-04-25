import { readFile } from "node:fs/promises";
import path from "node:path";

// Serve the repo's AGENTS.md from the frontend so cross-runtime tooling
// can fetch it from the live deploy without depending on the GitHub
// remote being up-to-date or the repo being public.
//
// Source-of-truth file lives at the repo root; we read it on each request
// (force-dynamic) so a docs change ships with the next deploy without a
// duplicated copy under public/.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const file = path.resolve(process.cwd(), "..", "AGENTS.md");
    const content = await readFile(file, "utf-8");
    return new Response(content, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("AGENTS.md not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
